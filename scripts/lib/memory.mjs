import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const run = async (file, args, options = {}) => (await exec(file, args, { timeout: 2000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' }, ...options })).stdout;

export function parseMemory({ pressure = '', vm = '', swap = '', level = '' }, at = Date.now()) {
  const free = /free percentage:\s*(\d+)%/i.exec(pressure);
  const code = Number(level.trim());
  const status = code === 1 ? 'normal' : code === 2 ? 'warn' : code === 4 ? 'critical' : 'unknown';
  const pages = {};
  for (const key of ['Pages free', 'Pages active', 'Pages wired down', 'Pages occupied by compressor', 'Pageins', 'Pageouts', 'Swapins', 'Swapouts']) {
    const line = vm.split('\n').find(line => line.startsWith(key + ':'));
    if (line) pages[key] = Number(line.split(':')[1].replace(/[^0-9]/g, ''));
  }
  return { at: new Date(at).toISOString(), level: status, freePercent: free ? Number(free[1]) : null,
    swapUsage: swap.trim().slice(0, 256) || null, pageSize: Number(/page size of (\d+)/.exec(vm)?.[1]) || null, pages };
}
export async function sampleMemory({ execute = run, platform = process.platform, now = Date.now, timeoutMs = 2000 } = {}) {
  if (platform !== 'darwin') return { ...parseMemory({}, now()), warning: 'macOS memory probes unavailable on this platform' };
  const values = {}, errors = [];
  const abort = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('probe deadline')); }, Math.min(2000, timeoutMs)); });
  // Query-only options: never -l, -p or -S (these generate pressure).
  try { for (const [key, file, args] of [
    ['level', '/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']],
    ['pressure', '/usr/bin/memory_pressure', ['-Q']],
    ['vm', '/usr/bin/vm_stat', []], ['swap', '/usr/sbin/sysctl', ['vm.swapusage']]
  ]) {
    try { values[key] = await Promise.race([execute(file, args, { signal: abort.signal }), expired]); }
    catch { errors.push(key); if (abort.signal.aborted) break; }
  } } finally { clearTimeout(timer); }
  if (errors.length) values.level = '';
  return { ...parseMemory(values, now()), ...(errors.length ? { warning: 'Memory probe incomplete or timed out; pressure unknown: ' + errors.join(', ') } : {}) };
}
export function memoryDecision(sample) {
  if (sample.level === 'critical') return { allowed: false, reason: `Critical memory pressure; free ${sample.freePercent ?? 'unknown'}%; ${sample.swapUsage ?? 'swap unknown'}. Wait and recheck; do not start another heavy job.` };
  return { allowed: true, warning: sample.level === 'normal' ? null : `Memory pressure ${sample.level}; run only one heavy job and inspect memory status.` };
}
export async function processMemory(runnerPid, { execute = run } = {}) {
  if (!Number.isInteger(runnerPid) || runnerPid < 2) return [];
  try {
    const output = await execute('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm=']);
    const rows = output.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
      .map(m => ({ pid: Number(m[1]), parent: Number(m[2]), rssKiB: Number(m[3]), executable: m[4].slice(-128) }));
    const ids = new Set([runnerPid]);
    for (let depth = 0; depth < 8; depth++) for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid);
    return rows.filter(row => ids.has(row.pid)).slice(0, 32);
  } catch { return [{ unavailable: true }]; }
}
