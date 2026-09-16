import { createHash } from 'node:crypto';
import { changePrivate, readPrivate, sidecar } from './private-store.mjs';
import { sampleMemory, memoryDecision } from './memory.mjs';
import { basename } from 'node:path';

const EMPTY = { jobs: [], samples: [] };
export const HEAVY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Admission classification, not a shell authorization parser. Inspect executable
// positions, never prose/search arguments or controller heredoc payloads.
function segments(command) {
  const result = []; let words = [], word = '', quote = null, parallel = false;
  const flush = () => { if (word) words.push(word); word = ''; };
  const emit = () => { flush(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && ['"', '\\'].includes(command[i + 1])) word += command[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\' && i + 1 < command.length) word += command[++i];
    else if (ch === '<' && command[i + 1] === '<') { emit(); break; } // body is data, not commands
    else if (ch === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) word += ch; // redirection, not a parallel job
    else if (';&|\n'.includes(ch)) {
      if (ch === '&' && command[i + 1] !== '&') parallel = true;
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      emit();
    } else if (/\s/.test(ch)) flush();
    else word += ch;
  }
  emit(); return { commands: result, parallel };
}
function classifyHeavy(command, depth = 0) {
  if (typeof command !== 'string' || command.length > 65536 || depth > 2) return {};
  const parsed = segments(command);
  for (const original of parsed.commands) {
    const words = [...original];
    if (basename(words[0] ?? '') === 'env') words.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift();
    let executable = basename(words.shift() ?? '');
    if (['sh', 'bash', 'zsh'].includes(executable) && /^-[a-z]*c[a-z]*$/.test(words[0] ?? '')) {
      const nested = classifyHeavy(words[1], depth + 1);
      if (nested.label) return { ...nested, parallel: nested.parallel || parsed.parallel };
    }
    if (['pnpm', 'npm', 'yarn', 'bun', 'npx'].includes(executable)) {
      while (words[0]?.startsWith('-')) {
        const option = words.shift();
        if (['--dir', '-C', '--prefix', '--cwd', '--filter', '-F', '--workspace', '-w'].includes(option)) words.shift();
      }
      if (['run', 'exec', 'dlx', 'x'].includes(words[0])) words.shift();
      if (/^(?:test(?::[\w-]+)?|lint|typecheck|build|check|install|ci|add|migrate(?::[\w-]+)?)$/.test(words[0] ?? '')) return { label: 'package check/install/migration', parallel: parsed.parallel };
      executable = basename(words.shift() ?? '');
    }
    if (['vitest', 'jest', 'playwright'].includes(executable) || executable === 'node' && words.includes('--test') || ['prisma', 'payload', 'drizzle-kit'].includes(executable) && words.some(word => /^(?:migrate(?::[\w-]+)?|push|generate)$/.test(word))) return { label: 'test or migration', parallel: parsed.parallel };
    if (executable === 'node' && basename(words[0] ?? '') === 'control.mjs' && words[1] === 'dev' && ['start', 'restart'].includes(words[2])) return { label: 'dev startup', parallel: parsed.parallel };
  }
  return {};
}
export function heavyShape(command) { return classifyHeavy(command).label ?? null; }
export function jobView(job, now = Date.now()) {
  return { ...job, expired: now - Date.parse(job.startedAt) >= HEAVY_MAX_AGE_MS,
    ...(now - Date.parse(job.startedAt) >= HEAVY_MAX_AGE_MS ? { warning: 'Lease expired; completion must be verified, not assumed.' } : {}) };
}
export async function heavyStatus(root, env = process.env, now = Date.now()) {
  const data = await readPrivate(await sidecar(root, 'heavy-jobs.json', env), EMPTY);
  if (!Array.isArray(data.jobs) || data.jobs.length > 64 || !Array.isArray(data.samples) || data.samples.length > 32) throw new Error('invalid heavy job record');
  return { jobs: data.jobs.map(job => jobView(job, now)), latestSample: data.samples.at(-1) ?? null };
}
export async function beginHeavy(root, { id, command, executor, observed = false }, env = process.env, { sample = sampleMemory, now = Date.now } = {}) {
  const label = heavyShape(command);
  if (!label) return { allowed: true, tracked: false };
  if (!observed && classifyHeavy(command).parallel) return { allowed: false, reason: 'Heavy commands must run sequentially, not in a parallel shell batch. Run each command separately; do not ask the owner to continue.' };
  if (typeof id !== 'string' || !id || id.length > 300) throw new Error('heavy work requires a stable tool/command id');
  return changePrivate(root, 'heavy-jobs.json', EMPTY, async data => {
    const digest = createHash('sha256').update(command).digest('hex');
    const existing = data.jobs.find(job => job.id === id);
    if (existing) {
      if (existing.digest !== digest) throw new Error('heavy job id reused for a different command');
      return { allowed: true, tracked: true };
    }
    if (data.jobs.length && !observed) return { allowed: false, reason: `Heavy work active: ${data.jobs.map(job => `${job.label} (${job.id})`).join(', ')}. Run control.mjs heavy wait, repeat on exit 3, then retry without asking the owner.` };
    if (data.jobs.length >= 64) throw new Error('heavy registry full; inspect unfinished jobs');
    let reading = data.samples.at(-1);
    if (!reading || now() - Date.parse(reading.at) > 10000 || Date.parse(reading.at) > now()) reading = await sample();
    const gate = memoryDecision(reading);
    data.samples = [...data.samples, { ...reading, event: 'before', id }].slice(-32);
    if (!gate.allowed && !observed) return gate;
    const overlap = data.jobs.length > 0;
    data.jobs.push({ id, digest, label, executor: String(executor).slice(0, 128), startedAt: new Date(now()).toISOString(), hostTaskId: null });
    return { allowed: true, tracked: true, warning: overlap ? 'SDK command overlap observed; SDK admission is instructed, not mechanically intercepted.' : gate.reason ?? gate.warning };
  }, env);
}
export async function finishHeavy(root, id, env = process.env, { sample = sampleMemory } = {}) {
  return changePrivate(root, 'heavy-jobs.json', EMPTY, async data => {
    if (!data.jobs.some(job => job.id === id || job.hostTaskId === id)) return false;
    data.jobs = data.jobs.filter(job => job.id !== id && job.hostTaskId !== id);
    data.samples = [...data.samples, { ...await sample(), event: 'after', id }].slice(-32);
    return true;
  }, env);
}
export async function backgroundHeavy(root, id, taskId, env = process.env) {
  return changePrivate(root, 'heavy-jobs.json', EMPTY, data => {
    const job = data.jobs.find(job => job.id === id);
    if (job) job.hostTaskId = String(taskId).slice(0, 256);
  }, env);
}
export async function waitHeavy(root, seconds = 120, env = process.env, { sample = sampleMemory, now = Date.now, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new Error('heavy wait timeout must be 1..120 seconds');
  const until = now() + seconds * 1000;
  do {
    const status = await heavyStatus(root, env);
    const memory = await sample();
    if (!status.jobs.length && memoryDecision(memory).allowed) return { ready: true, memory };
    if (now() >= until) return { ready: false, ...status, memory };
    await sleep(Math.min(1000, until - now()));
  } while (true);
}
