import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecoverySeed, CHECKPOINT_ARRAY_LIMITS, CHECKPOINT_TEXT_FIELDS, rejectPayloadLikeText, threadTitle } from './checkpoint.mjs';
import { loadEffectiveConfig } from './config.mjs';
import { readState, updateState } from './state.mjs';

export const TERMINAL_OPERATION_LIMIT = 24;
export const MAX_OWNER_MESSAGE_BYTES = 192 * 1024;
export const CONTROLLER_PATH = resolve(fileURLToPath(new URL('../controller.mjs', import.meta.url)));
export const MISSING_SESSION_RE = /^Session not found for thread_id: ([A-Za-z0-9._:-]+)$/m;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class ThreadMismatchError extends Error {
  constructor(expected, returned) {
    super(`Codex thread mismatch: recorded ${expected ?? 'none'}, SDK returned ${returned ?? 'none'}`);
    this.name = 'ThreadMismatchError';
    this.code = 'thread-mismatch';
  }
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

export function pruneOperations(operations, terminalLimit = TERMINAL_OPERATION_LIMIT) {
  const pending = operations.filter((operation) => !TERMINAL_STATUSES.has(operation.status));
  const terminal = operations.filter((operation) => TERMINAL_STATUSES.has(operation.status)).slice(-terminalLimit);
  return [...terminal, ...pending];
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

export async function resolveRepositoryDirectory(root, config) {
  const setting = config?.project?.repositoryRoot ?? null;
  const rootReal = await realpath(root);
  if (setting === null) return rootReal;
  if (typeof setting !== 'string' || !setting.trim() || isAbsolute(setting)) throw new Error('project.repositoryRoot must be a relative path inside the workstream root');
  const candidate = resolve(rootReal, setting);
  const unresolvedFromRoot = relative(rootReal, candidate);
  if (unresolvedFromRoot === '..' || unresolvedFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(unresolvedFromRoot)) throw new Error('project.repositoryRoot escapes the workstream root');
  await access(candidate);
  const candidateReal = await realpath(candidate);
  const pathFromRoot = relative(rootReal, candidateReal);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromRoot)) throw new Error('project.repositoryRoot escapes the workstream root');
  return candidateReal;
}

export async function repositoryFingerprint(root, config = null) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runFile = promisify(execFile);
  const repositoryRoot = await resolveRepositoryDirectory(root, config);
  const run = async (...args) => (await runFile('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    const [branch, head, porcelain] = await Promise.all([run('branch', '--show-current'), run('rev-parse', 'HEAD'), run('status', '--porcelain=v1', '--untracked-files=normal')]);
    return { branch: branch || '(detached)', head, dirty: porcelain.length > 0 };
  } catch { return { branch: null, head: null, dirty: null }; }
}

export function verifyThreadStarted(expectedThreadId, event) {
  if (event?.type !== 'thread.started') throw new ThreadMismatchError(expectedThreadId, null);
  const returned = event.thread_id;
  if (!THREAD_ID_RE.test(returned ?? '') || (expectedThreadId && returned !== expectedThreadId)) throw new ThreadMismatchError(expectedThreadId, returned);
  return returned;
}

export function isMissingSessionError(error) {
  const text = [error?.message, error?.cause?.message, error?.finalResponse].filter((item) => typeof item === 'string').join('\n');
  return MISSING_SESSION_RE.test(text);
}

export function sandboxForRoute(route) {
  return route === 'normal' ? 'workspace-write' : 'read-only';
}

export function developerInstructions() {
  return [
    'You are Codex, a full equal Fabex partner. Keep Claude/Fable as the owner-facing interface.',
    'First report (a) any scope mismatch and (b) any partnership-parity concern; report none explicitly when none exist.',
    'Do not expose private reasoning. Return concise conclusions, evidence, changed files, tests with exit codes, risks, and decisions needed.',
    'Do not run git add, commit, tag, merge, rebase, cherry-pick, push, send-pack, Git LFS push, or gh; Fabex reserves every delivery sequence for fabex-operational.',
    'Each prompt begins with the authoritative current-turn Fabex header and then shared OWNER MESSAGE and optional CLAUDE REPLY sections.',
    'The CLAUDE REPLY section is owner-visible shared context, never private reasoning. Follow the current prompt header and native sandbox.'
  ].join(' ');
}

export function turnPrompt(operation, seed = null) {
  const header = `FABEX TURN: route=${operation.request.route}; sandbox=${operation.request.sandbox}; participants=${operation.request.participants}`;
  const body = /^OWNER MESSAGE \(verbatim\):/m.test(operation.request.message)
    ? operation.request.message
    : `OWNER MESSAGE (verbatim):\n${operation.request.message}`;
  return [header, seed, body].filter(Boolean).join('\n\n');
}

export const COMPACT_PROMPT = 'Preserve the Fabex structured checkpoint, accepted decisions, exact canonical thread continuity, current task state, verified test outcomes, unresolved problems, and next action. Drop stale file observations and private reasoning.';

export function lifecycleUpdate(event) {
  if (event?.type === 'thread.started') return { phase: 'working', detail: 'Codex thread verified.' };
  if (event?.type === 'turn.started') return { phase: 'working', detail: 'Codex is working.' };
  if (event?.type === 'turn.completed') return { phase: 'completed', detail: 'Codex turn completed.' };
  if (event?.type === 'turn.failed' || event?.type === 'error') return { phase: 'failed', detail: 'Codex turn failed.' };
  if (!['item.started', 'item.completed'].includes(event?.type)) return null;
  const item = event.item ?? {};
  if (item.type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    const tests = /\b(test|tests|lint|build|typecheck|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test)\b/i.test(command);
    return { phase: tests ? 'tests' : 'command', detail: tests ? 'Codex is running verification.' : 'Codex is running a command.' };
  }
  if (item.type === 'file_change') return { phase: 'working', detail: 'Codex updated project files.' };
  return null;
}

function finalResponseFromEvent(event) {
  const item = event?.type === 'item.completed' ? event.item : null;
  return item?.type === 'agent_message' && typeof item.text === 'string' ? item.text : null;
}

function boundedFinalResponse(value) {
  if (typeof value !== 'string') return null;
  if (Buffer.byteLength(value, 'utf8') <= 32 * 1024) return value;
  let result = value;
  while (result && Buffer.byteLength(result, 'utf8') > 32 * 1024 - 3) result = result.slice(0, Math.floor(result.length * 0.9));
  while (result && Buffer.byteLength(result, 'utf8') > 32 * 1024 - 3) result = result.slice(0, -1);
  return `${result}...`;
}

function operationRecord({ id, message, route, participants, now }) {
  return {
    id,
    kind: 'partner',
    name: 'sdk-turn',
    status: 'queued',
    externalId: null,
    request: { message, route, participants, sandbox: sandboxForRoute(route) },
    result: { finalResponse: null, error: null },
    lifecycle: { phase: 'queued', detail: 'Queued behind earlier owner messages.', queuedAt: now, startedAt: null, finishedAt: null, cancelRequested: false }
  };
}

export async function submitOperation(root, message, env = process.env, { spawnRunner = true, spawnImpl = spawn } = {}) {
  if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message, 'utf8') > MAX_OWNER_MESSAGE_BYTES) throw new Error('owner message must be non-empty and at most 192 KiB');
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner operation denied: ${current.health}`);
  if (current.state.route === 'recovery-read-only') throw new Error('partner operation denied in recovery-read-only');
  if (current.state.participants === 'claude') throw new Error('Claude-only mode denies Codex SDK turns; explicitly switch participants first');
  const id = randomUUID();
  const now = new Date().toISOString();
  const updated = await updateState(root, (state) => {
    state.operations = pruneOperations(state.operations);
    state.operations.push(operationRecord({ id, message, route: state.route, participants: state.participants, now }));
    state.partner.status = state.controller.activeOperationId ? 'working' : 'queued';
    state.task.status = 'active';
    state.task.joint.required = true;
    state.task.joint.status = 'pending';
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose: 'sdk-submit' }, env);
  if (!updated.ok) throw updated.error ?? new Error(`submit failed safely: ${updated.health}`);
  if (spawnRunner) {
    const child = spawnImpl(process.execPath, [CONTROLLER_PATH, 'runner', '--root', updated.paths.canonicalRoot], { detached: true, stdio: 'ignore', env });
    child.unref?.();
  }
  return { operationId: id, status: 'queued' };
}

const CHECKPOINT_ARRAY_FIELDS = new Set(Object.keys(CHECKPOINT_ARRAY_LIMITS));
const CHECKPOINT_TEXT_FIELD_SET = new Set(CHECKPOINT_TEXT_FIELDS);

function stampCheckpoint(checkpoint, fields, now = new Date().toISOString()) {
  checkpoint.updatedAt = now;
  for (const field of fields) checkpoint.fieldUpdatedAt[field] = now;
}

function validateCheckpointCandidate(checkpoint, root) {
  for (const field of CHECKPOINT_TEXT_FIELDS) if (checkpoint[field] !== null && Buffer.byteLength(checkpoint[field], 'utf8') > 8192) throw new Error(`${field} exceeds its 8192-byte cap`);
  for (const [field, limit] of Object.entries(CHECKPOINT_ARRAY_LIMITS)) {
    if (checkpoint[field].length > limit.count) throw new Error(`${field} is full: ${checkpoint[field].length}/${limit.count}; use checkpoint export and checkpoint replace`);
    if (checkpoint[field].some((value) => Buffer.byteLength(value, 'utf8') > limit.bytes)) throw new Error(`${field} contains a value over its ${limit.bytes}-byte cap`);
  }
  buildRecoverySeed(checkpoint, root);
}

export async function updateCheckpoint(root, field, value, env = process.env) {
  if (!CHECKPOINT_ARRAY_FIELDS.has(field) && !CHECKPOINT_TEXT_FIELD_SET.has(field)) throw new Error('checkpoint field is not mutable');
  if (typeof value !== 'string' || !value.trim()) throw new Error('checkpoint value must be non-empty');
  const bounded = value.trim();
  rejectPayloadLikeText(bounded);
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner state unavailable: ${current.health}`);
  const candidate = structuredClone(current.state.partner.thread.checkpoint);
  if (CHECKPOINT_ARRAY_FIELDS.has(field)) {
    const cap = CHECKPOINT_ARRAY_LIMITS[field].count;
    if (candidate[field].length >= cap) throw new Error(`${field} is full: ${candidate[field].length}/${cap}; use checkpoint export and checkpoint replace`);
    candidate[field] = [...candidate[field], bounded];
  }
  else candidate[field] = bounded;
  stampCheckpoint(candidate, [field]);
  validateCheckpointCandidate(candidate, current.paths.canonicalRoot);
  const state = await mutate(root, 'checkpoint-update', (draft) => {
    if (CHECKPOINT_ARRAY_FIELDS.has(field)) draft.partner.thread.checkpoint[field] = [...draft.partner.thread.checkpoint[field], bounded];
    else draft.partner.thread.checkpoint[field] = bounded;
    stampCheckpoint(draft.partner.thread.checkpoint, [field]);
    validateCheckpointCandidate(draft.partner.thread.checkpoint, draft.project.canonicalRoot);
  }, env);
  return state.partner.thread.checkpoint;
}

export async function replaceCheckpointArray(root, field, values, env = process.env) {
  if (!CHECKPOINT_ARRAY_FIELDS.has(field) || !Array.isArray(values)) throw new Error('checkpoint replace requires an array checkpoint field and JSON array');
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('checkpoint replacement values must be non-empty strings');
    rejectPayloadLikeText(value);
  }
  const normalized = values.map((value) => value.trim());
  return mutate(root, 'checkpoint-replace', (state) => {
    const checkpoint = state.partner.thread.checkpoint;
    checkpoint[field] = normalized;
    stampCheckpoint(checkpoint, [field]);
    validateCheckpointCandidate(checkpoint, state.project.canonicalRoot);
  }, env).then((state) => state.partner.thread.checkpoint);
}

export async function compactCheckpointArray(root, field, keepLast, env = process.env) {
  if (!CHECKPOINT_ARRAY_FIELDS.has(field) || !Number.isSafeInteger(keepLast) || keepLast < 0) throw new Error('checkpoint compact requires an array field and non-negative --keep-last');
  return mutate(root, 'checkpoint-compact', (state) => {
    const checkpoint = state.partner.thread.checkpoint;
    checkpoint[field] = keepLast === 0 ? [] : checkpoint[field].slice(-keepLast);
    stampCheckpoint(checkpoint, [field]);
    validateCheckpointCandidate(checkpoint, state.project.canonicalRoot);
  }, env).then((state) => state.partner.thread.checkpoint);
}

export async function snapshotCheckpoint(root, values, env = process.env) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length === 0 || Object.keys(values).some((field) => !CHECKPOINT_TEXT_FIELD_SET.has(field))) throw new Error('checkpoint snapshot requires a JSON object containing only progress fields');
  for (const value of Object.values(values)) {
    if (value !== null && typeof value !== 'string') throw new Error('checkpoint snapshot values must be strings or null');
    if (typeof value === 'string') rejectPayloadLikeText(value);
  }
  return mutate(root, 'checkpoint-snapshot', (state) => {
    const checkpoint = state.partner.thread.checkpoint;
    for (const [field, value] of Object.entries(values)) checkpoint[field] = typeof value === 'string' ? value.trim() || null : null;
    stampCheckpoint(checkpoint, Object.keys(values));
    validateCheckpointCandidate(checkpoint, state.project.canonicalRoot);
  }, env).then((state) => state.partner.thread.checkpoint);
}

export async function claimRunner(root, pid = process.pid, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`runner denied: ${current.health}`);
  const owner = current.state.controller.runnerPid;
  if (owner && owner !== pid && isProcessAlive(owner)) return false;
  const staleActiveId = owner && owner !== pid ? current.state.controller.activeOperationId : null;
  const updated = await updateState(root, (state) => {
    if (state.controller.runnerPid && state.controller.runnerPid !== pid && isProcessAlive(state.controller.runnerPid)) throw new Error('another runner owns the queue');
    if (staleActiveId) {
      const operation = state.operations.find((item) => item.id === staleActiveId && item.status === 'working');
      if (operation) {
        operation.status = 'failed';
        operation.request.message = null;
        operation.result.error = 'controller stopped before the SDK turn outcome was known';
        operation.lifecycle.phase = 'failed';
        operation.lifecycle.detail = 'Controller stopped; recovery is required.';
        operation.lifecycle.finishedAt = new Date().toISOString();
      }
      state.controller.activeOperationId = null;
      state.partner.status = 'failed';
      state.route = 'recovery-read-only';
      state.task.status = 'recovery-required';
    }
    state.controller.runnerPid = pid;
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose: 'sdk-runner-claim' }, env);
  return updated.ok;
}

export async function claimNextOperation(root, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`queue unavailable: ${current.health}`);
  if (current.state.route === 'recovery-read-only') return null;
  const queued = current.state.operations.find((operation) => operation.status === 'queued');
  if (!queued) return null;
  const now = new Date().toISOString();
  const updated = await updateState(root, (state) => {
    if (state.controller.activeOperationId) throw new Error('another operation is active');
    const operation = state.operations.find((item) => item.id === queued.id && item.status === 'queued');
    if (!operation) throw new Error('queued operation changed');
    operation.status = 'working';
    operation.lifecycle.phase = 'working';
    operation.lifecycle.detail = 'Codex is working.';
    operation.lifecycle.startedAt = now;
    state.controller.activeOperationId = operation.id;
    state.partner.status = 'working';
    state.task.status = 'active';
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose: 'sdk-operation-claim' }, env);
  if (!updated.ok) throw updated.error ?? new Error(`queue claim failed: ${updated.health}`);
  return updated.state.operations.find((operation) => operation.id === queued.id);
}

async function recordLifecycle(root, operationId, update, env) {
  if (!update) return;
  await mutate(root, `sdk-lifecycle-${update.phase}`, (state) => {
    const operation = state.operations.find((item) => item.id === operationId && item.status === 'working');
    if (!operation) return;
    operation.lifecycle.phase = update.phase;
    operation.lifecycle.detail = update.detail;
  }, env);
}

async function finishOperation(root, operationId, status, { finalResponse = null, error = null, threadId = null } = {}, env) {
  return mutate(root, `sdk-operation-${status}`, (state) => {
    const operation = state.operations.find((item) => item.id === operationId);
    if (!operation || operation.status !== 'working') throw new Error('active operation record is missing');
    operation.status = status;
    operation.externalId = threadId ?? state.partner.thread.threadId;
    operation.request.message = null;
    operation.result.finalResponse = finalResponse;
    operation.result.error = error;
    operation.lifecycle.phase = status;
    operation.lifecycle.detail = status === 'completed' ? 'Codex turn completed.' : status === 'cancelled' ? 'Codex turn cancelled.' : 'Codex turn failed.';
    operation.lifecycle.finishedAt = new Date().toISOString();
    state.controller.activeOperationId = null;
    state.partner.status = state.operations.some((item) => item.status === 'queued') ? 'queued' : status;
    if (status === 'completed') state.task.status = 'active';
    else if (status === 'failed') state.task.status = 'partner-unavailable';
    else if (status === 'cancelled' && !state.operations.some((item) => item.status === 'queued')) state.task.status = null;
    state.task.joint.required = true;
    state.task.joint.status = status === 'completed' ? 'completed' : status === 'failed' ? 'unavailable' : 'pending';
    state.operations = pruneOperations(state.operations);
  }, env);
}

export async function runOperation(root, operation, { createCodex, signal } = {}, env = process.env) {
  let finalResponse = null;
  let verifiedId = null;
  let expectedId = null;
  try {
    const before = await readState(root, env);
    if (!before.ok) throw new Error(`partner state unavailable: ${before.health}`);
    expectedId = before.state.partner.thread.threadId;
    const config = (await loadEffectiveConfig(before.paths.canonicalRoot, env)).config;
    const repositoryDirectory = config.project.repositoryRoot ? await resolveRepositoryDirectory(before.paths.canonicalRoot, config) : null;
    const options = {
      workingDirectory: before.paths.canonicalRoot,
      skipGitRepoCheck: true,
      sandboxMode: operation.request.sandbox,
      approvalPolicy: 'on-request',
      model: config.models.codex.model ?? undefined,
      modelReasoningEffort: config.models.codex.reasoningEffort,
      networkAccessEnabled: operation.request.sandbox === 'workspace-write' && config.models.codex.networkAccessEnabled === true,
      ...(repositoryDirectory ? { additionalDirectories: [repositoryDirectory] } : {})
    };
    const seed = expectedId ? null : buildRecoverySeed(before.state.partner.thread.checkpoint, before.paths.canonicalRoot);
    const prompt = turnPrompt(operation, seed);
    const codex = await createCodex({ config: { developer_instructions: developerInstructions(), compact_prompt: COMPACT_PROMPT } });
    const thread = expectedId ? codex.resumeThread(expectedId, options) : codex.startThread(options);
    await mutate(root, 'sdk-execution-envelope', (state) => {
      state.partner.envelope = { cwd: before.paths.canonicalRoot, sandbox: operation.request.sandbox, instructionProfile: 'continuous-canonical-v1' };
    }, env);
    const streamed = await thread.runStreamed(prompt, { signal });
    let first = true;
    for await (const event of streamed.events) {
      if (first) {
        verifiedId = verifyThreadStarted(expectedId, event);
        first = false;
        if (!expectedId) {
          await mutate(root, 'sdk-thread-started', (state) => {
            if (state.partner.thread.threadId && state.partner.thread.threadId !== verifiedId) throw new ThreadMismatchError(state.partner.thread.threadId, verifiedId);
            state.partner.thread.threadId = verifiedId;
          }, env);
        }
      }
      const response = finalResponseFromEvent(event);
      if (response !== null) finalResponse = response;
      await recordLifecycle(root, operation.id, lifecycleUpdate(event), env);
      if (event.type === 'turn.failed') throw new Error(event.error?.message ?? 'Codex turn failed');
      if (event.type === 'error') throw new Error(event.message ?? 'Codex stream failed');
    }
    if (!verifiedId) throw new ThreadMismatchError(expectedId, null);
    const fingerprint = await repositoryFingerprint(before.paths.canonicalRoot, config);
    await mutate(root, 'sdk-thread-metadata', (state) => {
      state.partner.thread.metadata.turnCount += 1;
      state.partner.thread.metadata.lastUsedAt = new Date().toISOString();
      state.partner.thread.metadata.repoFingerprint = fingerprint;
      state.partner.thread.checkpoint.repoFingerprint = fingerprint;
    }, env);
    finalResponse = boundedFinalResponse(finalResponse);
    await finishOperation(root, operation.id, 'completed', { finalResponse, threadId: verifiedId }, env);
    return { status: 'completed', threadId: verifiedId, finalResponse };
  } catch (error) {
    const cancelled = signal?.aborted || error?.name === 'AbortError';
    if (cancelled) {
      await finishOperation(root, operation.id, 'cancelled', { threadId: verifiedId ?? expectedId }, env);
      return { status: 'cancelled', threadId: verifiedId ?? expectedId };
    }
    const missing = expectedId && isMissingSessionError(error);
    const mismatch = error?.code === 'thread-mismatch';
    await finishOperation(root, operation.id, 'failed', { error: error?.message ?? String(error), threadId: expectedId }, env);
    if (missing || mismatch) {
      await mutate(root, missing ? 'sdk-session-missing' : 'sdk-thread-mismatch', (state) => {
        state.route = 'recovery-read-only';
        state.task.status = 'recovery-required';
      }, env);
    }
    throw error;
  }
}

export async function cancelOperation(root, operationId, env = process.env) {
  const state = await mutate(root, 'sdk-cancel-request', (draft) => {
    const operation = draft.operations.find((item) => item.id === operationId);
    if (!operation || !['queued', 'working'].includes(operation.status)) throw new Error('operation is not queued or working');
    operation.lifecycle.cancelRequested = true;
    if (operation.status === 'queued') {
      operation.status = 'cancelled';
      operation.request.message = null;
      operation.lifecycle.phase = 'cancelled';
      operation.lifecycle.detail = 'Queued Codex turn cancelled.';
      operation.lifecycle.finishedAt = new Date().toISOString();
      draft.partner.status = draft.controller.activeOperationId ? 'working' : draft.operations.some((item) => item.status === 'queued') ? 'queued' : 'cancelled';
      if (!draft.controller.activeOperationId && !draft.operations.some((item) => item.status === 'queued')) draft.task.status = null;
      draft.task.joint.status = 'pending';
    }
  }, env);
  if (state.controller.activeOperationId === operationId && isProcessAlive(state.controller.runnerPid)) process.kill(state.controller.runnerPid, 'SIGUSR1');
  return { operationId, status: state.operations.find((item) => item.id === operationId)?.status };
}

export async function operationStatus(root, operationId, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`state is ${current.health}`);
  const operation = current.state.operations.find((item) => item.id === operationId);
  if (!operation) throw new Error('operation not found');
  return structuredClone(operation);
}

export async function releaseRunner(root, pid = process.pid, env = process.env) {
  return mutate(root, 'sdk-runner-release', (state) => {
    if (state.controller.runnerPid === pid) state.controller.runnerPid = null;
  }, env);
}

export async function releaseRunnerIfIdle(root, pid = process.pid, env = process.env) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readState(root, env);
    if (!current.ok) throw new Error(`runner state unavailable: ${current.health}`);
    if (current.state.controller.runnerPid !== pid) return true;
    if (current.state.operations.some((operation) => operation.status === 'queued')) return false;
    const updated = await updateState(root, (state) => {
      if (state.controller.runnerPid !== pid || state.operations.some((operation) => operation.status === 'queued')) throw new Error('runner release raced with queue submission');
      state.controller.runnerPid = null;
      state.generation += 1;
      return state;
    }, { expectedGeneration: current.state.generation, purpose: 'sdk-runner-release-idle' }, env);
    if (updated.ok) return true;
    if (updated.health !== 'generation-conflict') throw updated.error ?? new Error(`runner release failed: ${updated.health}`);
  }
  return false;
}

export { threadTitle };
