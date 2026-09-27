import { createHash } from 'node:crypto';
import { changePrivate, readPrivate, sidecar } from './private-store.mjs';
import { sampleMemory, memoryDecision } from './memory.mjs';
import { basename } from 'node:path';
import { spawn } from 'node:child_process';
import { processIdentity, groupMembers, verifiedGone } from './process-evidence.mjs';

const EMPTY = { jobs: [], samples: [] };
export const HEAVY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Admission classification, not a shell authorization parser. Inspect executable
// positions, never prose/search arguments or controller heredoc payloads.
function segments(command) {
  const result = []; let words = [], word = '', quote = null, parallel = false, pipe = false;
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
      if (ch === '|' && command[i + 1] !== '|') pipe = true;
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      emit();
    } else if (/\s/.test(ch)) flush();
    else word += ch;
  }
  emit(); return { commands: result, parallel, pipe };
}
function classifyHeavy(command, depth = 0) {
  if (typeof command !== 'string' || command.length > 65536 || depth > 2) return {};
  const parsed = segments(command);
  const matches = [];
  for (const original of parsed.commands) {
    const words = [...original];
    if (basename(words[0] ?? '') === 'env') words.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift();
    let executable = basename(words.shift() ?? '');
    if (['sh', 'bash', 'zsh'].includes(executable) && /^-[a-z]*c[a-z]*$/.test(words[0] ?? '')) {
      const nested = classifyHeavy(words[1], depth + 1);
      if (nested.label) { matches.push({ ...nested, parallel: nested.parallel || parsed.parallel }); continue; }
    }
    if (['pnpm', 'npm', 'yarn', 'bun', 'npx'].includes(executable)) {
      while (words[0]?.startsWith('-')) {
        const option = words.shift();
        if (['--dir', '-C', '--prefix', '--cwd', '--filter', '-F', '--workspace', ...(executable === 'npm' ? ['-w'] : [])].includes(option)) words.shift();
      }
      if (['run', 'exec', 'dlx', 'x'].includes(words[0])) words.shift();
      if (/test|lint|typecheck|build|check|e2e/.test(words[0] ?? '') || /^(?:install|ci|add|migrate(?::[\w-]+)?)$/.test(words[0] ?? '')) { matches.push({ label: 'package check/install/migration', parallel: parsed.parallel }); continue; }
      executable = basename(words.shift() ?? '');
    }
    if (['concurrently', 'npm-run-all', 'run-p'].includes(executable)) { matches.push({ label: `parallel wrapper ${executable}`, parallel: true }); continue; }
    if (['vitest', 'jest', 'playwright', 'tsc', 'eslint'].includes(executable) || executable === 'next' && words[0] === 'build' || executable === 'node' && words.includes('--test') || ['prisma', 'payload', 'drizzle-kit'].includes(executable) && words.some(word => /^(?:migrate(?::[\w-]+)?|push|generate)$/.test(word))) { matches.push({ label: 'test or migration', parallel: parsed.parallel }); continue; }
    if (executable === 'node' && basename(words[0] ?? '') === 'control.mjs' && words[1] === 'dev' && ['start', 'restart'].includes(words[2])) matches.push({ label: 'dev startup', parallel: parsed.parallel });
  }
  return matches.length ? { label: matches.find(item => item.label.startsWith('parallel wrapper'))?.label ?? matches[0].label, parallel: matches.some(item => item.parallel) || parsed.pipe && matches.length > 1 } : {};
}
export function heavyShape(command) { return classifyHeavy(command).label ?? null; }
export function jobView(job, now = Date.now()) {
  return { ...job, expired: now - Date.parse(job.startedAt) >= HEAVY_MAX_AGE_MS,
    wrapperStatus: job.identity ? 'identity-recorded' : job.wrapperRequested ? 'pending-or-unavailable: no wrapper acknowledgement' : 'unavailable: no process identity',
    ...(now - Date.parse(job.startedAt) >= HEAVY_MAX_AGE_MS ? { warning: 'Lease expired; completion must be verified, not assumed.' } : {}) };
}
export async function heavyStatus(root, env = process.env, now = Date.now()) {
  const data = await readPrivate(await sidecar(root, 'heavy-jobs.json', env), EMPTY);
  if (!Array.isArray(data.jobs) || data.jobs.length > 64 || !Array.isArray(data.samples) || data.samples.length > 32) throw new Error('invalid heavy job record');
  return { jobs: data.jobs.map(job => jobView(job, now)), latestSample: data.samples.at(-1) ?? null, recovery: data.recovery ?? [], lockRecovery: data.lockRecovery ?? null };
}
export async function beginHeavy(root, { id, command, executor, observed = false, wrapperRequested = false, cwd = null }, env = process.env, { sample = sampleMemory, now = Date.now } = {}) {
  const label = heavyShape(command);
  if (!label) return { allowed: true, tracked: false };
  if (!observed && classifyHeavy(command).parallel) return { allowed: false, reason: `Heavy commands must run sequentially, not in a parallel shell batch (${label}). Run each command separately; do not ask the owner to continue.` };
  if (typeof id !== 'string' || !id || id.length > 300) throw new Error('heavy work requires a stable tool/command id');
  const prior = await heavyStatus(root, env);
  let reading = prior.latestSample;
  if (!reading || now() - Date.parse(reading.at) > 10000 || Date.parse(reading.at) > now()) reading = await sample();
  return changePrivate(root, 'heavy-jobs.json', EMPTY, async data => {
    const digest = createHash('sha256').update(command).digest('hex');
    const existing = data.jobs.find(job => job.id === id);
    if (existing) {
      if (existing.digest !== digest) throw new Error('heavy job id reused for a different command');
      return { allowed: true, tracked: true };
    }
    if (data.jobs.length && !observed) return { allowed: false, reason: `Heavy work active: ${data.jobs.map(job => `${job.label} (${job.id})`).join(', ')}. Run control.mjs heavy wait, repeat on exit 3, then retry without asking the owner.` };
    if (data.jobs.length >= 64) throw new Error('heavy registry full; inspect unfinished jobs');
    const gate = memoryDecision(reading);
    data.samples = [...data.samples, { ...reading, event: 'before', id }].slice(-32);
    if (!gate.allowed && !observed) return gate;
    const overlap = data.jobs.length > 0;
    data.jobs.push({ id, digest, label, executor: String(executor).slice(0, 128), startedAt: new Date(now()).toISOString(), hostTaskId: null, wrapperRequested, cwd });
    if (observed) data.jobs.at(-1).identity = data.sdkProcesses?.find(entry => id.startsWith(`sdk:${entry.operationId}:`))?.identity ?? null;
    return { allowed: true, tracked: true, warning: overlap ? 'SDK command overlap observed; SDK admission is instructed, not mechanically intercepted.' : gate.reason ?? gate.warning };
  }, env);
}
export async function finishHeavy(root, id, env = process.env, { sample = sampleMemory, evidence = 'tool-completed', exitCode = null } = {}) {
  if (!(await heavyStatus(root, env)).jobs.some(job => job.id === id || job.hostTaskId === id)) return false;
  const reading = await sample();
  return changePrivate(root, 'heavy-jobs.json', EMPTY, async data => {
    if (!data.jobs.some(job => job.id === id || job.hostTaskId === id)) return false;
    data.jobs = data.jobs.filter(job => job.id !== id && job.hostTaskId !== id);
    data.samples = [...data.samples, { ...reading, event: 'after', id }].slice(-32);
    data.recovery = [...(data.recovery ?? []), { id, evidence, exitCode, at: new Date().toISOString() }].slice(-32);
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

export function wrappedHeavyInput(input, id, controlPath) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return { ...input, command: `${quote(process.execPath)} ${quote(controlPath)} heavy run --id ${quote(id)} -- ${quote(input.command)}` };
}
export async function attachHeavyIdentity(root, id, identity, env = process.env) {
  return changePrivate(root, 'heavy-jobs.json', EMPTY, data => {
    const job = data.jobs.find(job => job.id === id);
    if (!job) throw new Error('heavy reservation no longer exists');
    if (job.identity) throw new Error('heavy reservation already has an identity');
    job.identity = identity;
  }, env);
}
export async function releaseHeavy(root, id, env = process.env, dependencies = {}) {
  const job = (await heavyStatus(root, env)).jobs.find(job => job.id === id);
  if (!job) throw new Error('heavy reservation not found');
  if (!await verifiedGone(job.identity, dependencies)) throw new Error('release refused: no verified dead job identity and empty process group; use owner-named recovery for unknown evidence');
  return finishHeavy(root, id, env, { ...dependencies, evidence: 'verified-process-and-group-ended' });
}
export async function recoverHeavy(root, id, env = process.env, dependencies = {}) {
  const { readState, updateState } = await import('./state.mjs');
  const { recentOwnerPromptEvidence } = await import('./hook-evidence.mjs');
  const current = await readState(root, env);
  if (!current.ok || current.state.route !== 'normal' || current.state.ownerSelectedMode?.route !== 'normal' || current.state.modeGrant?.pausedAt) throw new Error('heavy recovery requires owner-selected work mode');
  const job = (await heavyStatus(root, env)).jobs.find(job => job.id === id);
  if (!job) throw new Error('heavy reservation not found');
  const authorization = (await recentOwnerPromptEvidence(root, env)).find(entry => entry.sessionId === current.state.contextEvidence.ownerPrompt?.sessionId && entry.text?.trim() === `recover heavy ${id}` && Date.parse(entry.capturedAt) >= Date.parse(job.startedAt));
  const exception = current.state.executorException;
  const named = exception?.scope === `recover-heavy:${id}` && ['claude-main', 'fabex-operational'].includes(exception.executor) && exception.reason?.trim() && Date.parse(exception.authorizedAt) >= Date.parse(job.startedAt);
  if (!authorization && !named) throw new Error('owner-named authorization required: record the explicit owner approval as an executor exception scoped to recover-heavy:<exact-id>, or use an owner message recover heavy <exact-id>; implementation approval is not recovery authorization');
  const evidence = authorization?.digest ?? `executor-exception:${exception.authorizedAt}`;
  const audit = `Heavy recovery authorization recorded ${evidence}: ${id}; bookkeeping only, no process signalled.`;
  const updated = await updateState(root, state => {
    const decisions = state.partner.thread.checkpoint.acceptedDecisions;
    if (!decisions.includes(audit)) decisions.push(audit);
    state.generation++; return state;
  }, { expectedGeneration: current.state.generation, purpose: 'owner-named-heavy-recovery' }, env);
  if (!updated.ok) throw new Error('recovery audit could not be stored; reservation retained');
  return finishHeavy(root, id, env, { ...dependencies, evidence: `owner-named:${evidence}` });
}
export async function runHeavy(root, id, command, env = process.env, { spawnProcess = spawn, identity = processIdentity, members = groupMembers, sample = sampleMemory, cwd = process.cwd() } = {}) {
  await changePrivate(root, 'heavy-jobs.json', EMPTY, data => {
    const job = data.jobs.find(job => job.id === id);
    if (!job || !job.wrapperRequested || job.claimed || job.digest !== createHash('sha256').update(command).digest('hex') || job.cwd && job.cwd !== cwd) throw new Error('wrapper requires an unclaimed matching admitted command and cwd');
    job.claimed = true;
  }, env);
  let child;
  try { child = spawnProcess('/bin/bash', ['-c', command], { cwd, env, detached: true, stdio: 'inherit' }); }
  catch (error) { await finishHeavy(root, id, env, { sample, evidence: 'spawn-failed' }); throw error; }
  const completion = new Promise(resolve => { child.once('error', error => resolve({ error })); child.once('exit', (code, signal) => resolve({ code, signal })); });
  let captured = null;
  try {
    captured = await identity(child.pid);
    if (captured && captured.pgid === child.pid) await attachHeavyIdentity(root, id, captured, env);
  } catch { captured = null; }
  // SIGTERM/INT forwarded only to the directly spawned child, never an inferred PID.
  const forward = signal => { try { child.kill(signal); } catch {} };
  const term = () => forward('SIGTERM'), interrupt = () => forward('SIGINT');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  let result;
  try { result = await completion; }
  finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
  // Shell completion cannot establish that background children have ended.
  // ChildProcess also emits error when a later signal fails. That is not
  // spawn-failure evidence and must not release a still-running job.
  const spawnFailed = result.error && !(Number.isInteger(child.pid) && child.pid > 1);
  if (spawnFailed || captured && await verifiedGone(captured, { identity, members })) await finishHeavy(root, id, env, { sample, evidence: spawnFailed ? 'spawn-failed' : 'wrapper-exit-empty-group', exitCode: result.code });
  return { exitCode: result.code ?? 1, signal: result.signal ?? null, retained: (await heavyStatus(root, env)).jobs.some(job => job.id === id) };
}
