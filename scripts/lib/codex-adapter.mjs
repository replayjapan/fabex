import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadEffectiveConfig } from './config.mjs';
import { readState, updateState } from './state.mjs';

const execFileAsync = promisify(execFile);
const COMPANION_NAMES = new Set(['codex', 'openai-codex']);
const THREAD_KINDS = new Set(['primary', 'write']);
const MISSING_TASK_THREAD_MESSAGE = 'No previous Codex task thread was found for this repository.';
const COMPANION_JOB_TIMEOUT_MS = 300000;
const missingThreadReplacement = Symbol('missing-thread-replacement');
export const THREAD_REFRESH_TURN_THRESHOLD = 40;

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function searchCache(root, depth = 0) {
  if (depth > 5 || !(await exists(root))) return null;
  const metadataFile = join(root, '.claude-plugin', 'plugin.json');
  if (await exists(metadataFile)) {
    try {
      const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
      if (COMPANION_NAMES.has(String(metadata.name).toLowerCase())) return root;
    } catch {}
  }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await searchCache(join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

export async function discoverCompanionRuntime(env = process.env) {
  if (env.FABEX_CODEX_PLUGIN_ROOT && await exists(env.FABEX_CODEX_PLUGIN_ROOT)) return env.FABEX_CODEX_PLUGIN_ROOT;
  for (const root of [join(homedir(), '.claude', 'plugins', 'cache'), join(homedir(), '.claude', 'plugins', 'marketplaces')]) {
    const found = await searchCache(root);
    if (found) return found;
  }
  return null;
}

function assertThreadKind(kind) {
  if (!THREAD_KINDS.has(kind)) throw new Error('thread kind must be primary or write');
  return kind;
}

function threadField(kind) {
  return kind === 'primary' ? 'primaryThreadId' : 'writeThreadId';
}

export function buildCheckpointSeed(checkpoint) {
  return [
    'Fabex continuity re-sync. Treat this bounded persisted checkpoint as prior shared context.',
    `Owner goals (verbatim): ${JSON.stringify(checkpoint.ownerGoals)}`,
    `Accepted decisions: ${JSON.stringify(checkpoint.acceptedDecisions)}`,
    `Current status: ${checkpoint.currentStatus ?? 'No persisted status.'}`,
    'The repository may have changed; earlier file observations are non-authoritative. Re-read relevant files before repo-dependent conclusions.'
  ].join('\n');
}

export function planThreadCall(state, kind, resumeStore = null) {
  assertThreadKind(kind);
  const threads = state.partner.threads;
  const recordedThreadId = threads[threadField(kind)];
  if (kind === 'primary' && threads.metadata.resyncStatus === 'required') {
    return { kind, action: 'resync', companionFlag: '--fresh', expectedThreadId: null, checkpoint: structuredClone(threads.checkpoint), seed: buildCheckpointSeed(threads.checkpoint) };
  }
  if (recordedThreadId) {
    if (resumeStore?.checked === true && resumeStore.threadId !== recordedThreadId) {
      const reason = resumeStore.threadId === null ? 'confirmed-no-resume-candidate' : 'predicted-resume-thread-mismatch';
      return {
        kind,
        action: 'recover',
        companionFlag: '--fresh',
        expectedThreadId: recordedThreadId,
        predictedThreadId: resumeStore.threadId,
        checkpoint: structuredClone(threads.checkpoint),
        seed: buildCheckpointSeed(threads.checkpoint),
        reason
      };
    }
    return { kind, action: 'resume', companionFlag: '--resume-last', expectedThreadId: recordedThreadId, checkpoint: kind === 'primary' ? structuredClone(threads.checkpoint) : null, seed: null };
  }
  return {
    kind,
    action: 'fresh',
    companionFlag: '--fresh',
    expectedThreadId: null,
    checkpoint: kind === 'primary' ? structuredClone(threads.checkpoint) : null,
    seed: null,
    reason: kind === 'primary' ? 'no-primary-thread' : 'read-only-to-write-boundary'
  };
}

export class ThreadMismatchError extends Error {
  constructor(expected, returned) {
    super(`Codex thread mismatch: recorded ${expected}, companion returned ${returned}; pause and ask the owner before continuing`);
    this.name = 'ThreadMismatchError';
    this.code = 'thread-mismatch';
  }
}

export function verifyResumedThread(expectedThreadId, returnedThreadId) {
  if (typeof returnedThreadId !== 'string' || returnedThreadId.length === 0) throw new ThreadMismatchError(expectedThreadId, returnedThreadId ?? 'none');
  if (expectedThreadId !== returnedThreadId) throw new ThreadMismatchError(expectedThreadId, returnedThreadId);
  return returnedThreadId;
}

function boundedAppend(items, additions, { count, bytes }) {
  const accepted = additions.filter((item) => typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= bytes);
  return [...items, ...accepted].slice(-count);
}

async function mutate(root, purpose, fn, env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner state unavailable: ${current.health}`);
  const updated = await updateState(root, (state) => {
    fn(state);
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose }, env);
  if (!updated.ok) throw updated.error ?? new Error(`partner state update failed safely: ${updated.health}`);
  return updated.state;
}

export async function repositoryFingerprint(root) {
  const run = async (...args) => (await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    const [branch, head, porcelain] = await Promise.all([
      run('branch', '--show-current'),
      run('rev-parse', 'HEAD'),
      run('status', '--porcelain=v1', '--untracked-files=normal')
    ]);
    return { branch: branch || '(detached)', head, dirty: porcelain.length > 0 };
  } catch {
    return { branch: null, head: null, dirty: null };
  }
}

export function threadRefreshAdvice(threads, currentFingerprint) {
  const previous = threads.metadata.repoFingerprint;
  const long = threads.metadata.turnCount >= THREAD_REFRESH_TURN_THRESHOLD;
  const moved = Boolean(
    previous.head && currentFingerprint?.head &&
    (previous.branch !== currentFingerprint.branch || previous.head !== currentFingerprint.head)
  );
  return { recommended: long || moved, reasons: [long ? 'long-thread' : null, moved ? 'repo-fingerprint-moved' : null].filter(Boolean) };
}

export async function captureOwnerMessage(root, message, env = process.env) {
  if (typeof message !== 'string' || message.length === 0) return (await readState(root, env)).state;
  return mutate(root, 'checkpoint-owner-message', (state) => {
    state.partner.threads.checkpoint.ownerGoals = boundedAppend(
      state.partner.threads.checkpoint.ownerGoals,
      [message],
      { count: 8, bytes: 32768 }
    );
  }, env);
}

export async function recordAcceptedDecision(root, decision, env = process.env) {
  if (typeof decision !== 'string' || decision.length === 0 || Buffer.byteLength(decision, 'utf8') > 2048) throw new Error('accepted decision must be a non-empty string of at most 2048 UTF-8 bytes');
  return mutate(root, 'checkpoint-accepted-decision', (state) => {
    state.partner.threads.checkpoint.acceptedDecisions = boundedAppend(
      state.partner.threads.checkpoint.acceptedDecisions,
      [decision],
      { count: 16, bytes: 2048 }
    );
  }, env);
}

export async function markPrimaryResyncRequired(root, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok || !current.state.partner.threads.primaryThreadId || current.state.partner.threads.metadata.resyncStatus === 'required') return current.state;
  return mutate(root, 'session-thread-resync-required', (state) => {
    state.partner.threads.metadata.resyncStatus = 'required';
  }, env);
}

async function failPartnerOperation(root, operationId, env) {
  try {
    await mutate(root, 'partner-failed', (state) => {
      const operation = state.operations.find((item) => item.id === operationId && item.status === 'running');
      if (operation) operation.status = 'failed';
      state.partner.status = 'pending';
    }, env);
  } catch {}
}

function parseCompanionJson(stdout, command) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Codex companion ${command} returned invalid JSON`);
  }
}

function companionJobOutcome(payload) {
  const storedJob = payload?.storedJob ?? null;
  const job = payload?.job ?? null;
  return {
    status: storedJob?.status ?? job?.status ?? null,
    errorMessage: storedJob?.errorMessage ?? job?.errorMessage ?? null,
    threadId: storedJob?.threadId ?? job?.threadId ?? storedJob?.result?.threadId ?? null,
    rawOutput: storedJob?.result?.rawOutput ?? storedJob?.result?.codex?.stdout ?? storedJob?.rendered ?? ''
  };
}

function isConfirmedMissingTaskThread(outcome) {
  return outcome.status === 'failed' && outcome.errorMessage?.trim() === MISSING_TASK_THREAD_MESSAGE;
}

async function runCompanionJson(script, args, root, env, command, timeout = COMPANION_JOB_TIMEOUT_MS) {
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout
  });
  return parseCompanionJson(stdout, command);
}

async function inspectResumeCandidate(root, env) {
  const companionRoot = await discoverCompanionRuntime(env);
  if (!companionRoot) throw new Error('official Codex companion runtime is unavailable for resume prediction');
  const script = join(companionRoot, 'scripts', 'codex-companion.mjs');
  const payload = await runCompanionJson(script, ['task-resume-candidate', '--json', '--cwd', root], root, env, 'resume prediction');
  if (payload?.available === false && payload?.candidate === null) return { checked: true, threadId: null };
  if (payload?.available === true && typeof payload?.candidate?.threadId === 'string' && payload.candidate.threadId.length > 0) {
    return { checked: true, threadId: payload.candidate.threadId };
  }
  throw new Error('Codex companion resume prediction returned an ambiguous candidate');
}

async function launchBackgroundCompanionTask(script, root, prompt, { config, write = false }, env) {
  const args = ['task', '--json', '--background', '--cwd', root, '--fresh'];
  if (write) args.push('--write');
  if (config?.models?.codex?.model) args.push('--model', config.models.codex.model);
  if (config?.models?.codex?.reasoningEffort) args.push('--effort', config.models.codex.reasoningEffort);
  args.push(prompt);
  const launched = await runCompanionJson(script, args, root, env, 'task launch');
  if (typeof launched?.jobId !== 'string' || !/^task-[a-z0-9]+-[a-z0-9]+$/.test(launched.jobId)) {
    throw new Error('Codex companion background task returned an invalid job id');
  }
  return launched.jobId;
}

async function awaitCompanionJob(script, root, jobId, env) {
  const status = await runCompanionJson(
    script,
    ['status', '--json', '--wait', '--timeout-ms', String(COMPANION_JOB_TIMEOUT_MS), '--cwd', root, jobId],
    root,
    env,
    'status wait',
    COMPANION_JOB_TIMEOUT_MS + 5000
  );
  if (status?.waitTimedOut || ['queued', 'running'].includes(status?.job?.status)) {
    throw new Error(`Codex companion job ${jobId} did not finish before the timeout`);
  }
  const result = await runCompanionJson(script, ['result', '--json', '--cwd', root, jobId], root, env, 'result');
  return { payload: result, outcome: companionJobOutcome(result) };
}

function requireCompletedCompanionJob(jobId, outcome) {
  if (outcome.status !== 'completed') {
    const detail = typeof outcome.errorMessage === 'string' && outcome.errorMessage.length > 0 ? `: ${outcome.errorMessage}` : '';
    throw new Error(`Codex companion job ${jobId} did not complete successfully${detail}`);
  }
  if (typeof outcome.threadId !== 'string' || outcome.threadId.length === 0) {
    throw new Error(`Codex companion job ${jobId} completed without a thread id`);
  }
  return outcome;
}

export async function resyncPrimaryThread(root, config, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok || current.state.partner.threads.metadata.resyncStatus !== 'required') return { performed: false, state: current.state };
  const companionRoot = await discoverCompanionRuntime(env);
  if (!companionRoot) throw new Error('official Codex companion runtime is unavailable for session re-sync');
  const begun = await beginPartnerOperation(root, {
    threadKind: 'primary',
    name: 'session-resync',
    envelope: { cwd: root, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'checkpoint-resync' }
  }, env);
  const prompt = [
    begun.plan.seed,
    'Owner-mandated parity watchdog: before acting, flag any scope mismatch or any rule/change that would make Codex less than a full equal partner. Claude must relay the flag to the owner unedited.',
    'Acknowledge this re-sync with a bounded current-status summary only; do not modify files.'
  ].join('\n\n');
  const script = join(companionRoot, 'scripts', 'codex-companion.mjs');
  try {
    const jobId = await launchBackgroundCompanionTask(script, root, prompt, { config }, env);
    const { outcome } = await awaitCompanionJob(script, root, jobId, env);
    requireCompletedCompanionJob(jobId, outcome);
    const state = await completePartnerOperation(root, begun.operationId, {
      threadId: outcome.threadId,
      currentStatus: typeof outcome.rawOutput === 'string' ? outcome.rawOutput : null
    }, env);
    return { performed: true, jobId, threadId: outcome.threadId, rawOutput: outcome.rawOutput ?? '', state };
  } catch (error) {
    await failPartnerOperation(root, begun.operationId, env);
    throw error;
  }
}

export async function beginPartnerOperation(root, { envelope, name = 'joint-opening', threadKind = 'primary' }, env = process.env) {
  assertThreadKind(threadKind);
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner operation denied: ${current.health}`);
  if (current.state.operations.some((operation) => operation.status === 'running')) throw new Error('companion call already running for this workstream');
  const initialPlan = planThreadCall(current.state, threadKind);
  const plan = initialPlan.action === 'resume'
    ? planThreadCall(current.state, threadKind, await inspectResumeCandidate(root, env))
    : initialPlan;
  const id = randomUUID();
  const updated = await updateState(root, (state) => {
    if (state.operations.some((operation) => operation.status === 'running')) throw new Error('companion call already running for this workstream');
    if (plan.expectedThreadId && state.partner.threads[threadField(threadKind)] !== plan.expectedThreadId) {
      throw new Error('recorded thread changed during resume prediction');
    }
    state.partner.status = 'running';
    state.partner.envelope = { ...envelope };
    state.operations.push({
      id,
      kind: 'partner',
      name: `${name}:${threadKind}:${plan.action}`,
      status: 'running',
      externalId: plan.action === 'recover' ? plan.expectedThreadId : null
    });
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose: 'partner-intent' }, env);
  if (!updated.ok) throw updated.error ?? new Error(`partner state update failed safely: ${updated.health}`);
  return { operationId: id, envelope, plan };
}

async function finishPartnerOperation(root, operationId, { threadId, decisionId = randomUUID(), currentStatus = null, acceptedDecisions = [], fingerprint = null, recovery = null }, env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner state unavailable: ${current.health}`);
  const operation = current.state.operations.find((item) => item.id === operationId && item.kind === 'partner');
  if (!operation || operation.status !== 'running') throw new Error('partner operation is not recorded as running');
  const [, threadKind = 'primary', action = 'resume'] = operation.name.split(':').slice(-3);
  assertThreadKind(threadKind);
  const field = threadField(threadKind);
  const expected = current.state.partner.threads[field];
  const replacingMissingThread = recovery?.authority === missingThreadReplacement;
  const replacingPredictedThread = action === 'recover';
  if (replacingPredictedThread) {
    if (!expected || operation.externalId !== expected) throw new Error('pre-launch thread replacement no longer matches the recorded operation');
  } else if (replacingMissingThread) {
    if (action !== 'resume' || recovery.staleThreadId !== expected) throw new Error('missing-thread replacement no longer matches the recorded resume operation');
  } else if (action === 'resume') verifyResumedThread(expected, threadId);
  if (action === 'fresh' && expected) throw new Error('automatic fresh thread refused because a recorded thread already exists');
  if (action === 'resync' && current.state.partner.threads.metadata.resyncStatus !== 'required') throw new Error('thread re-sync was not required');
  const observed = fingerprint ?? await repositoryFingerprint(current.paths.canonicalRoot);
  const updated = await updateState(root, (state) => {
    const target = state.operations.find((item) => item.id === operationId && item.kind === 'partner' && item.status === 'running');
    if (!target) throw new Error('partner operation changed concurrently');
    if (replacingPredictedThread && state.partner.threads[field] !== operation.externalId) throw new Error('recorded thread changed before pre-launch replacement completed');
    if (replacingMissingThread && state.partner.threads[field] !== recovery.staleThreadId) throw new Error('recorded thread changed before missing-thread replacement completed');
    target.status = 'completed';
    target.externalId = threadId;
    state.partner.status = 'completed';
    state.partner.threads[field] = threadId;
    state.partner.threads.metadata.turnCount += 1;
    state.partner.threads.metadata.lastUsedAt = new Date().toISOString();
    state.partner.threads.metadata.repoFingerprint = observed;
    if (threadKind === 'primary' && action === 'resync') state.partner.threads.metadata.resyncStatus = 're-synced';
    if (typeof currentStatus === 'string' && Buffer.byteLength(currentStatus, 'utf8') <= 8192) state.partner.threads.checkpoint.currentStatus = currentStatus;
    state.partner.threads.checkpoint.acceptedDecisions = boundedAppend(
      state.partner.threads.checkpoint.acceptedDecisions,
      acceptedDecisions,
      { count: 16, bytes: 2048 }
    );
    state.task.joint.status = 'completed';
    state.task.joint.decisionId = decisionId;
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose: 'partner-completed' }, env);
  if (!updated.ok) throw updated.error ?? new Error(`partner state update failed safely: ${updated.health}`);
  return updated.state;
}

export async function completePartnerOperation(root, operationId, details, env = process.env) {
  return finishPartnerOperation(root, operationId, details, env);
}

async function recoverConfirmedMissingThread(root, operationId, staleThreadId, script, config, env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner state unavailable: ${current.health}`);
  const operation = current.state.operations.find((item) => item.id === operationId && item.kind === 'partner' && item.status === 'running');
  if (!operation) throw new Error('partner operation is not recorded as running');
  const [, threadKind = 'primary', action = 'resume'] = operation.name.split(':').slice(-3);
  assertThreadKind(threadKind);
  const field = threadField(threadKind);
  if (action !== 'resume' || current.state.partner.threads[field] !== staleThreadId) {
    throw new Error('confirmed missing-thread recovery no longer matches the recorded resume operation');
  }
  const prompt = [
    'Visible Fabex continuity recovery: the companion background store confirmed that the recorded thread cannot be resumed. Create one replacement thread from this persisted checkpoint; do not infer unrecorded context.',
    buildCheckpointSeed(current.state.partner.threads.checkpoint),
    'Owner-mandated parity watchdog: before acting, flag any scope mismatch or any rule/change that would make Codex less than a full equal partner. Claude must relay the flag to the owner unedited.',
    'Continue the recorded operation from the checkpoint and return a bounded current-status summary.'
  ].join('\n\n');
  const replacementJobId = await launchBackgroundCompanionTask(script, root, prompt, {
    config,
    write: threadKind === 'write'
  }, env);
  const { outcome } = await awaitCompanionJob(script, root, replacementJobId, env);
  requireCompletedCompanionJob(replacementJobId, outcome);
  const state = await finishPartnerOperation(root, operationId, {
    threadId: outcome.threadId,
    currentStatus: typeof outcome.rawOutput === 'string' ? outcome.rawOutput : null,
    recovery: { authority: missingThreadReplacement, staleThreadId }
  }, env);
  return {
    verified: true,
    recovered: true,
    recoveryReason: 'confirmed-missing-companion-thread',
    operationId,
    jobId: replacementJobId,
    threadId: outcome.threadId,
    replacedThreadId: staleThreadId,
    rawOutput: outcome.rawOutput,
    state
  };
}

export async function completePartnerJob(root, operationId, jobId, env = process.env) {
  if (!/^task-[a-z0-9]+-[a-z0-9]+$/.test(jobId)) throw new Error('companion job id is invalid');
  const companionRoot = await discoverCompanionRuntime(env);
  if (!companionRoot) throw new Error('official Codex companion runtime is unavailable');
  const script = join(companionRoot, 'scripts', 'codex-companion.mjs');
  const payload = await runCompanionJson(script, ['result', '--json', '--cwd', root, jobId], root, env, 'result');
  const outcome = companionJobOutcome(payload);
  if (isConfirmedMissingTaskThread(outcome)) {
    const current = await readState(root, env);
    if (!current.ok) throw new Error(`partner state unavailable: ${current.health}`);
    const operation = current.state.operations.find((item) => item.id === operationId && item.kind === 'partner' && item.status === 'running');
    if (!operation) throw new Error('partner operation is not recorded as running');
    const [, threadKind = 'primary', action = 'resume'] = operation.name.split(':').slice(-3);
    assertThreadKind(threadKind);
    if (action !== 'resume') throw new Error('confirmed missing-thread recovery is limited to recorded resume operations');
    const staleThreadId = current.state.partner.threads[threadField(threadKind)];
    if (!staleThreadId) throw new Error('confirmed missing-thread recovery requires a recorded thread id');
    const effective = await loadEffectiveConfig(root, env);
    return recoverConfirmedMissingThread(root, operationId, staleThreadId, script, effective.config, env);
  }
  requireCompletedCompanionJob(jobId, outcome);
  const beforeCompletion = await readState(root, env);
  if (!beforeCompletion.ok) throw new Error(`partner state unavailable: ${beforeCompletion.health}`);
  const operation = beforeCompletion.state.operations.find((item) => item.id === operationId && item.kind === 'partner' && item.status === 'running');
  if (!operation) throw new Error('partner operation is not recorded as running');
  const [, , action = 'resume'] = operation.name.split(':').slice(-3);
  const recovered = action === 'recover';
  const replacedThreadId = recovered ? operation.externalId : null;
  const threadId = outcome.threadId;
  const rawOutput = outcome.rawOutput;
  const boundedOutcome = typeof rawOutput === 'string' && Buffer.byteLength(rawOutput, 'utf8') <= 8192 ? rawOutput : null;
  const state = await completePartnerOperation(root, operationId, {
    threadId,
    currentStatus: boundedOutcome
  }, env);
  return {
    verified: true,
    recovered,
    recoveryReason: recovered ? 'prelaunch-resume-candidate-replacement' : null,
    replacedThreadId,
    operationId,
    jobId,
    threadId,
    rawOutput,
    state
  };
}
