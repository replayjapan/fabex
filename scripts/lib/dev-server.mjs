import { constants } from 'node:fs';
import { mkdir, open, unlink, realpath } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { projectPaths } from './paths.mjs';
import { validateDevServer } from './validation.mjs';

const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_LOG_BYTES = 64 * 1024;
const pidValid = pid => Number.isInteger(pid) && pid > 1;
const sameProcess = (a, b) => Boolean(a && b && a.pid === b.pid && a.pgid === b.pgid && a.signature === b.signature);
const redact = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@').replace(/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');

// No shell and no network-permission changes. The host environment is inherited.
async function command(file, args) {
  return execute(file, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } });
}
async function identity(pid) {
  if (!pidValid(pid)) throw new Error('invalid process id');
  let output;
  try { output = (await command('/bin/ps', ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'comm='])).stdout.trim(); }
  catch (error) { if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return null; throw new Error('process identity inspection failed; refusing signals'); }
  return parseProcessIdentity(pid, output);
}
export function parseProcessIdentity(pid, output) {
  if (!output) return null;
  const match = /^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(output);
  if (!match || Number(match[1]) !== pid) throw new Error('unrecognized process identity; refusing signals');
  return { pid, pgid: Number(match[2]), signature: `${match[3].replace(/\s+/g, ' ')}|${match[4]}` };
}
async function listeners(port) {
  let output;
  try { output = (await command('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])).stdout; }
  catch (error) { if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return []; throw new Error('port inspection failed; refusing to assume the port is free'); }
  return parsePortListeners(output);
}
export function parsePortListeners(output) {
  const result = [];
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) result.push({ pid: Number(line.slice(1)), command: 'unknown' });
    else if (line.startsWith('c') && result.length) result.at(-1).command = line.slice(1, 129);
  }
  if (output.trim() && !result.length) throw new Error('unrecognized port inspection output');
  return result;
}
async function ready(url, timeout = 1500) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const req = request(url, { method: 'GET' }, response => {
      const statusCode = response.statusCode;
      response.destroy();
      finish({ ready: statusCode >= 200 && statusCode < 400, statusCode });
    });
    const timer = setTimeout(() => { finish({ ready: false, error: 'timeout' }); req.destroy(); }, timeout);
    req.on('error', error => finish({ ready: false, error: String(error.code ?? 'connection-failed').slice(0, 64) }));
    req.end();
  });
}
export async function launchDevProcess(config, fd, spawnProcess = spawn) {
  const child = spawnProcess(config.start[0], config.start.slice(1), { cwd: config.cwd, detached: true, shell: false, stdio: ['ignore', fd, fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('dev server executable could not start'))); });
  child.unref();
  return child.pid;
}
async function members(pgid) {
  const output = (await command('/bin/ps', ['-axo', 'pid=,pgid=,stat='])).stdout;
  return output.trim().split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)).filter(match => match && Number(match[2]) === pgid && !match[3].startsWith('Z')).map(match => Number(match[1]));
}
const native = { identity, listeners, members, ready, launch: launchDevProcess, signal: (pid, signal) => process.kill(pid, signal), sleep, now: Date.now };

async function readBounded(file, limit, tail = false) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (!tail && info.size > limit)) throw new Error('invalid dev server data file');
    const buffer = Buffer.alloc(Math.min(info.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, tail ? Math.max(0, info.size - limit) : 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
async function resolvedLocation(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await resolvedLocation(parent), path.slice(parent.length));
  }
}
async function recordAt(files, root) {
  const text = await readBounded(files.record, 24 * 1024);
  if (text === null) return null;
  const record = JSON.parse(text);
  if (!record || !pidValid(record.pid) || record.pgid !== record.pid || typeof record.signature !== 'string' || record.signature.length > 1024 || !record.signature || record.logFile !== files.log || typeof record.cwd !== 'string' || (record.cwd !== root && !record.cwd.startsWith(root + '/')) || !Array.isArray(record.command) || !record.command.length || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || !Number.isFinite(Date.parse(record.startedAt))) throw new Error('invalid dev server ownership record; refusing signals');
  return record;
}
async function saveRecord(files, record) {
  const handle = await open(files.record, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); } finally { await handle.close(); }
}

export function parseDevArgs(args) {
  if (args.length === 1 && ['start', 'stop', 'restart', 'status', 'logs'].includes(args[0])) return { action: args[0], lines: 80 };
  if (args.length === 3 && args[0] === 'logs' && args[1] === '--lines' && /^[1-9]\d{0,2}$/.test(args[2]) && Number(args[2]) <= 400) return { action: 'logs', lines: Number(args[2]) };
  throw new Error('dev requires start|stop|restart|status|logs [--lines 1..400]');
}

// Dependencies are injected only by unit tests; never accepted from CLI/config.
export async function devControl(root, config, args, { env = process.env, dependencies = {}, authorize = async () => { throw new Error('work-mode authorization required'); } } = {}) {
  const { action, lines } = parseDevArgs(args);
  if (config) config = validateDevServer(config);
  const io = { ...native, ...dependencies };
  const paths = await projectPaths(root, env);
  const location = await resolvedLocation(resolve(paths.projectDir));
  if (location === paths.canonicalRoot || location.startsWith(paths.canonicalRoot + '/')) throw new Error('dev server private data/log directory must be outside the workstream');
  const files = { record: join(paths.projectDir, 'dev-server.json'), log: join(paths.projectDir, 'dev-server.log'), lock: join(paths.projectDir, 'dev-server.lock') };
  // Reading status/logs never creates directories, migrates state, or clears stale records.
  const read = () => recordAt(files, paths.canonicalRoot);
  async function observed(record, port) {
    const live = record ? await io.identity(record.pid) : null;
    const owned = sameProcess(record, live);
    const found = port ? await io.listeners(port) : [];
    const ports = [];
    for (const item of found) {
      const member = owned ? await io.identity(item.pid) : null;
      ports.push({ ...item, ours: Boolean(owned && member?.pgid === record.pgid) });
    }
    return { record: record ? (owned ? 'owned' : 'stale') : 'absent', pid: record?.pid ?? null, alive: Boolean(live), owned, port: port ?? null, listeners: ports };
  }
  if (action === 'logs') {
    const text = await readBounded(files.log, MAX_LOG_BYTES, true);
    const parts = (text ?? '').split('\n');
    if (parts.at(-1) === '') parts.pop();
    const bounded = Buffer.from(redact(parts.slice(-lines).join('\n'))).subarray(-MAX_LOG_BYTES + 3).toString('utf8');
    return { status: text === null ? 'absent' : 'available', lines, maxBytes: MAX_LOG_BYTES, text: bounded };
  }
  if (action === 'status') {
    const record = await read();
    const status = await observed(record, record?.port ?? config?.port);
    return { enabled: Boolean(config), ...status, readiness: config && (!record || record.port === config.port) ? await io.ready(config.readyUrl) : null };
  }
  await authorize();
  if (!config) throw new Error('devServer lane disabled; configure it in the project layer and inspect config warnings');
  config = validateDevServer(config);
  config.cwd = await realpath(config.cwd);
  if (config.cwd !== paths.canonicalRoot && !config.cwd.startsWith(paths.canonicalRoot + '/')) throw new Error('devServer.cwd escaped the workstream');
  await mkdir(paths.projectDir, { recursive: true, mode: 0o700 });
  // Independent lifecycle lock: no schema changes or canonical-runner lock coupling.
  let lock;
  try { lock = await open(files.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('another dev lifecycle command holds the lock; retry after it finishes (a crashed command requires verified manual lock cleanup)'); throw error; }
  try {
    await authorize();
    async function stop() {
      const record = await read();
      if (!record) return { status: 'absent', signalled: false };
      if (!sameProcess(record, await io.identity(record.pid))) {
        await unlink(files.record);
        return { status: 'stale', signalled: false, message: 'stale ownership record cleared; no process signalled' };
      }
      await authorize();
      // Recheck immediately before each signal. Never signal a port-selected PID.
      if (!sameProcess(record, await io.identity(record.pid))) throw new Error('process identity changed before stop; no signal sent');
      await io.signal(-record.pgid, 'SIGTERM');
      const deadline = io.now() + config.stopGraceMs;
      // Give children the grace period even when the package-manager leader exits first.
      while (io.now() < deadline && (await io.members(record.pgid)).length) await io.sleep(100);
      if (sameProcess(record, await io.identity(record.pid))) {
        await authorize();
        if (!sameProcess(record, await io.identity(record.pid))) throw new Error('process identity changed before escalation; no KILL sent');
        await io.signal(-record.pgid, 'SIGKILL');
        await io.sleep(100);
      }
      const remaining = await io.listeners(record.port);
      if (remaining.length || (await io.members(record.pgid)).length || await io.identity(record.pid)) throw new Error('stop incomplete or port still occupied; ownership record retained; no other process will be killed');
      await unlink(files.record);
      return { status: 'stopped', signalled: true, portReleased: true };
    }
    const stopped = ['stop', 'restart'].includes(action) ? await stop() : null;
    if (action === 'stop') return stopped;
    const previous = await read();
    const status = await observed(previous, config.port);
    if (status.listeners.some(item => !item.ours)) throw new Error(`port ${config.port} conflict: ${status.listeners.filter(item => !item.ours).map(item => `${item.pid} (${item.command})`).join(', ')}; nothing started or killed`);
    if (status.owned) {
      if (previous.port !== config.port || previous.cwd !== config.cwd || JSON.stringify(previous.command) !== JSON.stringify(config.start)) throw new Error('owned server configuration changed; stop it explicitly before starting the new configuration');
      return { status: 'already-running', pid: previous.pid, readiness: await io.ready(config.readyUrl) };
    }
    if (previous) throw new Error('stale ownership record; run dev stop to clear it without signalling before starting');
    await authorize();
    const log = await open(files.log, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    let pid;
    try {
      const info = await log.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('invalid dev server log file');
      pid = await io.launch(config, log.fd);
    } finally { await log.close(); }
    let live = await io.identity(pid);
    // Package-manager shims may exec Node just after spawn. Capture a stable identity.
    for (let attempt = 0; live && attempt < 20; attempt++) {
      await io.sleep(100);
      const next = await io.identity(pid);
      if (sameProcess(live, next)) break;
      live = next;
      if (attempt === 19) throw new Error('server process identity did not stabilize; inspect status before further action');
    }
    if (!live || live.pgid !== pid) throw new Error('server exited or ownership could not be established; inspect dev logs and port status; no unverified process will be killed');
    await saveRecord(files, { ...live, command: config.start, cwd: config.cwd, port: config.port, logFile: files.log, startedAt: new Date(io.now()).toISOString() });
    const deadline = io.now() + config.readyTimeoutMs;
    let readiness;
    do {
      readiness = await io.ready(config.readyUrl, Math.max(1, Math.min(1500, deadline - io.now())));
      const owned = await observed(await read(), config.port);
      if (readiness.ready && owned.owned && owned.listeners.length && owned.listeners.every(item => item.ours)) return { status: 'started', pid, readiness, detached: true, ...(stopped ? { previous: stopped } : {}) };
      if (!owned.owned) throw new Error('dev server exited during startup; inspect dev logs (record retained)');
      if (io.now() < deadline) await io.sleep(200);
    } while (io.now() < deadline);
    throw new Error('readiness timeout; owned server may still be running, use dev status/logs/stop');
  } finally { await lock.close(); await unlink(files.lock); }
}
