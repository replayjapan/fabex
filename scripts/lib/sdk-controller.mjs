import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecoverySeed, CHECKPOINT_ARRAY_LIMITS, CHECKPOINT_TEXT_FIELDS, rejectPayloadLikeText, threadTitle } from './checkpoint.mjs';
import { loadEffectiveConfig, sourceVersion } from './config.mjs';
import { modeGrantMatches, recentOwnerPromptEvidence, textDigest } from './hook-evidence.mjs';
import { readState, updateState } from './state.mjs';
import { ValidationError } from './validation.mjs';
import { attachmentShape, selectedModeAttachments, validateAttachments } from './attachments.mjs';
import { parseReview, reviewSchema } from './review.mjs';
import { codexModelSource, speakerLabels } from './speakers.mjs';

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
  const terminal = operations.filter((operation) => TERMINAL_STATUSES.has(operation.status));
  const protectedIds = new Set(operations.filter((op) => (op.status === 'completed' && op.result.relay?.status === 'pending') || !TERMINAL_STATUSES.has(op.status) || (op.status === 'completed' && op.request.phase === 'independent' && !op.request.interrupted && !operations.some((child) => child.request.parentOperationId === op.id))).map((op) => op.id));
  while (terminal.length > terminalLimit || Buffer.byteLength(JSON.stringify([...terminal, ...pending])) > 700 * 1024) {
    const removable = terminal.find((op) => !protectedIds.has(op.id) && !op.request.parentOperationId && !operations.some((child) => child.request.parentOperationId === op.id && protectedIds.has(child.id)));
    if (!removable) break;
    for (let i = terminal.length - 1; i >= 0; i -= 1) if (terminal[i].id === removable.id || terminal[i].request.parentOperationId === removable.id) terminal.splice(i, 1);
  }
  return [...terminal, ...pending];
}

function nextClaimableOperation(operations) {
  for (const independent of operations.filter((operation) => operation.request?.phase === 'independent' && operation.status === 'completed' && !operation.request.interrupted)) {
    const reconciliation = operations.find((candidate) => candidate.request?.parentOperationId === independent.id);
    if (!reconciliation) return null;
    if (reconciliation.status === 'queued') return reconciliation;
    if (reconciliation.status === 'working') return null;
  }
  return operations.find((operation) => operation.status === 'queued') ?? null;
}

export function awaitingPhase2Operation(state) {
  return state.operations.find((operation) => operation.request?.phase === 'independent'
    && operation.status === 'completed'
    && !operation.request.interrupted
    && !state.operations.some((candidate) => candidate.request.parentOperationId === operation.id)) ?? null;
}

export function hasBlockingPartnerWork(state) {
  return state.operations.some((operation) => ['queued', 'working'].includes(operation.status)) || Boolean(awaitingPhase2Operation(state));
}

async function mutate(root, purpose, fn, env) {
  const deadline = Date.now() + 3000;
  let delay = 50;
  while (true) {
    const current = await readState(root, env, { lockWaitMs: Math.max(0, deadline - Date.now()) });
    if (!current.ok) throw current.error ?? new Error(`partner state unavailable: ${current.health}`);
    const updated = await updateState(root, (state) => {
      fn(state);
      state.generation += 1;
      return state;
    }, { expectedGeneration: current.state.generation, purpose, lockWaitMs: Math.max(0, deadline - Date.now()) }, env);
    if (updated.ok) return updated.state;
    if (!['generation-conflict', 'lock-contention'].includes(updated.health) || Date.now() >= deadline) throw updated.error ?? new Error(`partner state update failed safely: ${updated.health}`);
    await new Promise((resolvePause) => setTimeout(resolvePause, delay));
    delay = Math.min(delay * 2, 400);
  }
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
    'When an output schema is supplied, answer contains your complete owner-facing answer including scope and parity flags; the other fields supplement it, never replace it. Keep answer within 32 KiB, each supplemental string within 2048 bytes, each array within 16 entries, and the entire object within 48 KiB. Only owner-approved image attachments belong in the independent phase; current Fable annotations belong in reconciliation.',
    'Do not run git add, commit, tag, merge, rebase, cherry-pick, push, send-pack, Git LFS push, or gh; Fabex reserves every delivery sequence for fabex-operational.',
    'Each both-participant owner cycle has two turns on the same canonical thread. In Phase 1, form an independent reading from OWNER MESSAGE and PREVIOUS CLAUDE REPLY only. In Phase 2, review that stored reading alongside FABLE RESPONSE and correct mistakes plainly.',
    'The owner message and owner-visible reply sections are verbatim shared context, never private reasoning. The authoritative current-turn Fabex header declares phase, route, participants, and native sandbox.'
  ].join(' ');
}

export function submissionEnvelope(ownerMessage, previousReplyStatus = 'none', previousReply = undefined) {
  return JSON.stringify({ phase: 'independent', ownerMessage, previousReplyStatus, ...(previousReplyStatus === 'provided' ? { previousReply } : {}) });
}

export function reconciliationEnvelope(phase1OperationId, ownerMessage, fableResponse) {
  return JSON.stringify({ phase: 'reconcile', phase1OperationId, ownerMessage, fableResponse });
}

export function normalizeSubmissionEnvelope(value, participants) {
  if (participants !== 'both') {
    if (typeof value !== 'string' || !value.trim()) throw new Error('owner message must be non-empty');
    return { phase: 'single', ownerMessage: value, message: /^OWNER MESSAGE \(verbatim\):/m.test(value) ? value : `OWNER MESSAGE (verbatim):\n${value}`, claudeReplyVerified: 'unavailable', parentOperationId: null };
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error('both-participant submission requires a strict JSON phase envelope');
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('both-participant submission requires a strict JSON phase envelope with no trailing text'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('both-participant submission requires a strict JSON phase envelope');
  const attachments = attachmentShape(parsed.attachments);
  if (parsed.phase === 'independent') {
    const keys = parsed.previousReplyStatus === 'provided'
      ? ['ownerMessage', 'phase', 'previousReply', 'previousReplyStatus']
      : ['ownerMessage', 'phase', 'previousReplyStatus'];
    if (Object.hasOwn(parsed, 'attachments')) keys.push('attachments');
    if (Object.keys(parsed).sort().join(',') !== keys.sort().join(',')) throw new Error('Phase 1 envelope has unexpected, missing, or trailing Fable fields');
    if (typeof parsed.ownerMessage !== 'string' || !parsed.ownerMessage.trim()) throw new Error('Phase 1 requires ownerMessage verbatim');
    if (!['provided', 'none'].includes(parsed.previousReplyStatus)) throw new Error('Phase 1 requires previousReplyStatus provided or none');
    if (parsed.previousReplyStatus === 'provided' && (typeof parsed.previousReply !== 'string' || !parsed.previousReply.trim())) throw new Error('Phase 1 requires previousReply when status is provided');
    return {
      phase: 'independent', attachments, ownerMessage: parsed.ownerMessage, previousReplyStatus: parsed.previousReplyStatus,
      previousReply: parsed.previousReply,
      message: `OWNER MESSAGE (verbatim):\n${parsed.ownerMessage}\n\nPREVIOUS CLAUDE REPLY STATUS: ${parsed.previousReplyStatus}${parsed.previousReplyStatus === 'provided' ? `\n\nPREVIOUS CLAUDE REPLY (owner-visible, verbatim):\n${parsed.previousReply}` : ''}`,
      claudeReplyVerified: 'unavailable', parentOperationId: null
    };
  }
  if (parsed.phase === 'reconcile') {
    const keys = ['fableResponse', 'ownerMessage', 'phase', 'phase1OperationId'];
    if (Object.hasOwn(parsed, 'attachments')) keys.push('attachments');
    if (Object.keys(parsed).sort().join(',') !== keys.sort().join(',')) throw new Error('Phase 2 envelope has unexpected or missing fields');
    if (typeof parsed.ownerMessage !== 'string' || !parsed.ownerMessage.trim() || typeof parsed.fableResponse !== 'string' || !parsed.fableResponse.trim()) throw new Error('Phase 2 requires ownerMessage and fableResponse verbatim');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.phase1OperationId ?? '')) throw new Error('Phase 2 requires a valid phase1OperationId');
    return { phase: 'reconcile', attachments, ownerMessage: parsed.ownerMessage, fableResponse: parsed.fableResponse, message: null, claudeReplyVerified: 'unavailable', parentOperationId: parsed.phase1OperationId };
  }
  throw new Error('both-participant submission phase must be independent or reconcile');
}

export function turnPrompt(operation, seed = null) {
  const header = `FABEX TURN: phase=${operation.request.phase ?? 'single'}; route=${operation.request.route}; sandbox=${operation.request.sandbox}; participants=${operation.request.participants}`;
  const body = operation.request.phase === 'independent' && operation.request.ownerMessage !== null
    ? `OWNER MESSAGE (verbatim):\n${operation.request.ownerMessage}\n\nPREVIOUS CLAUDE REPLY STATUS: ${operation.request.previousReplyStatus}${operation.request.previousReplyStatus === 'provided' ? `\n\nPREVIOUS CLAUDE REPLY (owner-visible, verbatim):\n${operation.request.previousReply}` : ''}`
    : /^OWNER MESSAGE \(verbatim\):/m.test(operation.request.message)
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

export function boundedUsage(value) {
  const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
  if (!value || fields.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0)) return null;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function boundedFinalResponse(value) {
  if (typeof value !== 'string') return null;
  if (Buffer.byteLength(value, 'utf8') <= 32 * 1024) return value;
  let result = value;
  while (result && Buffer.byteLength(result, 'utf8') > 32 * 1024 - 3) result = result.slice(0, Math.floor(result.length * 0.9));
  while (result && Buffer.byteLength(result, 'utf8') > 32 * 1024 - 3) result = result.slice(0, -1);
  return `${result}...`;
}

function operationRecord({ id, message, route, participants, phase, parentOperationId, ownerMessageDigest, claudeReplyVerified, ownerMessage = null, previousReplyStatus = null, previousReply = null, interrupted = false, attachments = [], sessionId = '', now }) {
  return {
    id,
    kind: 'partner',
    name: 'sdk-turn',
    status: 'queued',
    externalId: null,
    usage: null,
    request: { message, route, participants, sandbox: sandboxForRoute(route), phase, parentOperationId, ownerMessageDigest, claudeReplyVerified, ownerMessage, previousReplyStatus, previousReply, interrupted, attachments },
    result: { finalResponse: null, error: null, structured: null, warning: null, relay: { label: 'Codex:', sessionId, status: 'pending' } },
    lifecycle: { phase: 'queued', detail: 'Queued behind earlier owner messages.', queuedAt: now, startedAt: null, finishedAt: null, cancelRequested: false }
  };
}

function interruptUnreconciledCycles(state, now) {
  for (const operation of state.operations) {
    if (operation.request.phase !== 'independent' || operation.status !== 'completed' || operation.request.interrupted) continue;
    if (state.operations.some((candidate) => candidate.request.parentOperationId === operation.id)) continue;
    operation.request.interrupted = true;
    operation.lifecycle.detail = 'Independent reading retained; owner mode transition interrupted reconciliation.';
    operation.lifecycle.finishedAt ??= now;
  }
}

function cancelQueuedForModeTransition(state, now) {
  for (const operation of state.operations) {
    if (operation.status !== 'queued') continue;
    operation.status = 'cancelled';
    operation.request.attachments = [];
    operation.request.message = null;
    operation.request.ownerMessage = null;
    operation.request.previousReply = null;
    operation.lifecycle.cancelRequested = true;
    operation.lifecycle.phase = 'cancelled';
    operation.lifecycle.detail = 'Superseded by an owner-authorized mode transition.';
    operation.lifecycle.finishedAt = now;
  }
}

function applyModeSelection(state, grant, now) {
  const previous = state.ownerSelectedMode ?? (state.route !== 'recovery-read-only' ? { route: state.route, participants: state.participants } : null);
  if (grant.route === 'ask-once') {
    const fallback = previous && ['normal', 'discussion'].includes(previous.route)
      ? { route: previous.route, participants: previous.participants }
      : { route: 'discussion', participants: 'both' };
    state.returnTo = fallback;
  } else state.returnTo = null;
  state.route = grant.route;
  state.participants = grant.participants;
  state.ownerSelectedMode = { route: grant.route, participants: grant.participants, selectedAt: now };
}

function enqueueGrantMessage(state, grant, now, attachments) {
  if (!grant.ownerMessage || !grant.ownerMessage.trim() || grant.participants === 'claude') return null;
  const phase = grant.participants === 'both' ? 'independent' : 'single';
  const id = grant.operationId ?? randomUUID();
  if (state.operations.some((operation) => operation.id === id)) throw new Error('reserved mode-message operation id already exists');
  state.operations = pruneOperations(state.operations);
  state.operations.push(operationRecord({
    id,
    message: phase === 'single' ? `OWNER MESSAGE (verbatim):\n${grant.ownerMessage}` : null,
    route: grant.route,
    participants: grant.participants,
    phase,
    parentOperationId: null,
    ownerMessageDigest: textDigest(grant.ownerMessage),
    claudeReplyVerified: 'unavailable',
    ownerMessage: phase === 'independent' ? grant.ownerMessage : null,
    previousReplyStatus: phase === 'independent' ? 'unavailable' : null,
    sessionId: grant.sessionId,
    attachments,
    now
  }));
  state.partner.status = 'queued';
  state.task.status = 'active';
  state.task.joint.required = grant.participants === 'both';
  state.task.joint.status = grant.participants === 'both' ? 'pending' : null;
  return id;
}

function modeAttachments(grant, root, config) {
  if (grant.participants === 'claude') return [];
  try { return validateAttachments(selectedModeAttachments(grant.ownerMessage), root, config); }
  catch (error) { throw new ValidationError(`Mode attachment validation failed; grant and owner text retained: ${error.message}`); }
}

function completeModeTransitionInState(state, now = new Date().toISOString(), config = null) {
  const grant = state.modeGrant;
  if (!grant) return null;
  const attachments = modeAttachments(grant, state.project.canonicalRoot, config);
  const from = state.ownerSelectedMode ?? (state.route !== 'recovery-read-only' ? { route: state.route, participants: state.participants, selectedAt: now } : null);
  interruptUnreconciledCycles(state, now);
  cancelQueuedForModeTransition(state, now);
  applyModeSelection(state, grant, now);
  const operationId = enqueueGrantMessage(state, grant, now, attachments);
  const ownerMessage = grant.participants === 'claude' ? grant.ownerMessage : null;
  state.modeGrant = null;
  if (!operationId) {
    const hasWorking = state.operations.some((operation) => operation.status === 'working');
    const hasQueued = state.operations.some((operation) => operation.status === 'queued');
    state.partner.status = hasWorking ? 'working' : hasQueued ? 'queued' : state.partner.thread.threadId ? 'completed' : 'not-started';
    state.task.status = hasWorking || hasQueued ? 'active' : null;
    if (!hasWorking && !hasQueued) state.task.joint.status = null;
  }
  return { operationId, ownerMessage, from };
}

function spawnControllerRunner(root, env, spawnImpl = spawn) {
  const child = spawnImpl(process.execPath, [CONTROLLER_PATH, 'runner', '--root', root], { detached: true, stdio: 'ignore', env });
  child.unref?.();
}

export async function applyOwnerModeTransition(root, { grantId, route, participants }, env = process.env, { spawnRunner = true, spawnImpl = spawn } = {}) {
  let outcome = null;
  let runnerToCancel = null;
  const config = (await loadEffectiveConfig(root, env)).config;
  const state = await mutate(root, `owner-mode-${route}-${participants}`, (draft) => {
    const grant = draft.modeGrant;
    if (!modeGrantMatches(grant, { id: grantId, route, participants })) throw new ValidationError('mode grant was consumed, expired, or changed');
    modeAttachments(grant, draft.project.canonicalRoot, config);
    const from = draft.ownerSelectedMode ?? (draft.route !== 'recovery-read-only' ? { route: draft.route, participants: draft.participants, selectedAt: new Date().toISOString() } : null);
    const active = draft.operations.find((operation) => operation.status === 'working');
    const sameModeWithoutMessage = !grant.ownerMessage && draft.ownerSelectedMode !== null
      && draft.route === route && draft.participants === participants;
    if (sameModeWithoutMessage) {
      draft.modeGrant = null;
      outcome = { status: 'applied', from, to: { route, participants }, operationId: null, ownerMessage: null };
      return;
    }
    if (active) {
      const now = new Date().toISOString();
      grant.pausedAt ??= now;
      active.lifecycle.cancelRequested = true;
      interruptUnreconciledCycles(draft, now);
      cancelQueuedForModeTransition(draft, now);
      runnerToCancel = draft.controller.runnerPid;
      outcome = { status: 'pending', from, to: { route, participants }, operationId: grant.operationId, activeOperationId: active.id, ownerMessage: null };
      return;
    }
    const completed = completeModeTransitionInState(draft, new Date().toISOString(), config);
    outcome = { status: 'applied', from, to: { route, participants }, operationId: completed.operationId, ownerMessage: completed.ownerMessage };
  }, env);
  if (runnerToCancel && isProcessAlive(runnerToCancel)) process.kill(runnerToCancel, 'SIGUSR1');
  if (outcome.status === 'applied' && outcome.operationId && spawnRunner && !isProcessAlive(state.controller.runnerPid)) spawnControllerRunner(root, env, spawnImpl);
  return outcome;
}

export async function submitOperation(root, message, env = process.env, { spawnRunner = true, spawnImpl = spawn } = {}) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner operation denied: ${current.health}`);
  if (current.state.route === 'recovery-read-only') throw new Error('partner operation denied in recovery-read-only');
  if (!current.state.ownerSelectedMode) throw new Error('partner operation denied: prior owner-selected mode is unknown; type a Fabex mode command');
  if (current.state.participants === 'claude') throw new Error('Claude-only mode denies Codex SDK turns; explicitly switch participants first');
  const envelope = normalizeSubmissionEnvelope(message, current.state.participants);
  const config = (await loadEffectiveConfig(current.paths.canonicalRoot, env)).config;
  const attachments = validateAttachments(envelope.attachments ?? [], current.paths.canonicalRoot, config);
  const ownerMessageDigest = textDigest(envelope.ownerMessage);
  const promptEvidence = current.state.contextEvidence.ownerPrompt;
  const promptEvidenceRing = envelope.phase === 'independent' ? await recentOwnerPromptEvidence(root, env) : [];
  const promptCandidates = promptEvidenceRing.length ? promptEvidenceRing : promptEvidence ? [promptEvidence] : [];
  let sessionId = promptCandidates.find((evidence) => evidence.digest === ownerMessageDigest)?.sessionId ?? promptEvidence?.sessionId ?? '';
  if (envelope.phase === 'independent' && promptCandidates.length && !promptCandidates.some((evidence) => evidence.digest === ownerMessageDigest)) throw new Error('Phase 1 ownerMessage does not match a recent owner-typed prompt');
  if (envelope.phase === 'independent') {
    const replyEvidence = current.state.contextEvidence.ownerVisibleReply;
    if (envelope.previousReplyStatus === 'provided' && replyEvidence) {
      if (replyEvidence.digest !== textDigest(envelope.previousReply)) throw new Error('Phase 1 previousReply does not match the last owner-visible Claude reply');
      envelope.claudeReplyVerified = true;
    } else if (envelope.previousReplyStatus === 'none' && replyEvidence) throw new Error('Phase 1 declares no previous reply but a prior owner-visible reply was recorded');
  }
  if (envelope.phase === 'reconcile') {
    const parent = current.state.operations.find((operation) => operation.id === envelope.parentOperationId);
    if (!parent || parent.request.phase !== 'independent' || parent.status !== 'completed' || !parent.result.finalResponse) throw new Error('Phase 2 requires a completed Phase 1 with a stored independent reading');
    if (parent.request.ownerMessageDigest !== ownerMessageDigest) throw new Error('Phase 2 ownerMessage does not match its Phase 1 owner message');
    if (current.state.operations.some((operation) => operation.request.parentOperationId === parent.id)) throw new Error('Phase 1 already has a Phase 2 operation');
    sessionId = parent.result.relay?.sessionId ?? sessionId;
    envelope.message = `OWNER MESSAGE (verbatim):\n${envelope.ownerMessage}\n\nCODEX PHASE 1 INDEPENDENT READING (stored verbatim):\n${parent.result.finalResponse}\n\nFABLE RESPONSE (owner-visible, verbatim):\n${envelope.fableResponse}`;
  }
  const retainedOwnerMessage = envelope.phase === 'independent' ? envelope.ownerMessage : null;
  const retainedPreviousStatus = envelope.phase === 'independent' ? envelope.previousReplyStatus : null;
  const retainedPreviousReply = envelope.phase === 'independent' && envelope.previousReplyStatus === 'provided' ? envelope.previousReply : null;
  if (Buffer.byteLength(envelope.message ?? '', 'utf8') + Buffer.byteLength(retainedOwnerMessage ?? '', 'utf8') + Buffer.byteLength(retainedPreviousReply ?? '', 'utf8') > MAX_OWNER_MESSAGE_BYTES) throw new Error('owner message envelope must be at most 192 KiB');
  const id = randomUUID();
  const now = new Date().toISOString();
  const updated = await updateState(root, (state) => {
    state.operations = pruneOperations(state.operations);
    state.operations.push(operationRecord({
      id,
      message: envelope.phase === 'independent' ? null : envelope.message,
      route: state.route,
      participants: state.participants,
      phase: envelope.phase,
      parentOperationId: envelope.parentOperationId,
      ownerMessageDigest,
      claudeReplyVerified: envelope.claudeReplyVerified,
      ownerMessage: retainedOwnerMessage,
      previousReplyStatus: retainedPreviousStatus,
      previousReply: retainedPreviousReply,
      attachments,
      sessionId,
      now
    }));
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
  return { operationId: id, phase: envelope.phase, status: 'queued', claudeReplyVerified: envelope.claudeReplyVerified };
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
  const deadline = Date.now() + 3000;
  while (true) {
    const current = await readState(root, env, { lockWaitMs: Math.max(0, deadline - Date.now()) });
    if (!current.ok) throw current.error ?? new Error(`runner denied: ${current.health}`);
    const owner = current.state.controller.runnerPid;
    if (owner && owner !== pid && isProcessAlive(owner)) return false;
    const staleActiveId = owner && owner !== pid ? current.state.controller.activeOperationId : null;
    const updated = await updateState(root, (state) => {
      if (state.controller.runnerPid && state.controller.runnerPid !== pid && isProcessAlive(state.controller.runnerPid)) throw new Error('another runner owns the queue');
      if (staleActiveId) markDeadRunnerFailure(state, staleActiveId);
      state.controller.runnerPid = pid;
      state.generation += 1;
      return state;
    }, { expectedGeneration: current.state.generation, purpose: 'sdk-runner-claim', lockWaitMs: Math.max(0, deadline - Date.now()) }, env);
    if (updated.ok) return true;
    if (!['generation-conflict', 'lock-contention'].includes(updated.health) || Date.now() >= deadline) throw updated.error ?? new Error(`runner claim failed: ${updated.health}`);
  }
}

export async function claimNextOperation(root, env = process.env) {
  const deadline = Date.now() + 3000;
  while (true) {
    const current = await readState(root, env, { lockWaitMs: Math.max(0, deadline - Date.now()) });
    if (!current.ok) throw current.error ?? new Error(`queue unavailable: ${current.health}`);
    if (current.state.route === 'recovery-read-only') return null;
    const queued = nextClaimableOperation(current.state.operations);
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
    }, { expectedGeneration: current.state.generation, purpose: 'sdk-operation-claim', lockWaitMs: Math.max(0, deadline - Date.now()) }, env);
    if (updated.ok) return updated.state.operations.find((operation) => operation.id === queued.id);
    if (!['generation-conflict', 'lock-contention'].includes(updated.health) || Date.now() >= deadline) throw updated.error ?? new Error(`queue claim failed: ${updated.health}`);
  }
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

async function finishOperation(root, operationId, status, { finalResponse = null, error = null, threadId = null, fingerprint = null, completedAt = null, version = null, requiresRecovery = false, usage = null, structured = null, warning = null, relay = null } = {}, env) {
  const config = (await loadEffectiveConfig(root, env)).config;
  return mutate(root, `sdk-operation-${status}`, (state) => {
    const operation = state.operations.find((item) => item.id === operationId);
    if (!operation || operation.status !== 'working') throw new Error('active operation record is missing');
    operation.status = status;
    operation.request.attachments = [];
    operation.usage = usage;
    operation.externalId = threadId ?? state.partner.thread.threadId;
    if (operation.request.phase !== 'independent') operation.request.message = null;
    operation.result.finalResponse = finalResponse;
    operation.result.error = error;
    operation.result.structured = structured;
    operation.result.warning = warning;
    operation.result.relay = relay;
    operation.lifecycle.phase = status;
    operation.lifecycle.detail = status === 'completed' ? 'Codex turn completed.' : status === 'cancelled' ? 'Codex turn cancelled.' : 'Codex turn failed.';
    operation.lifecycle.finishedAt = new Date().toISOString();
    state.controller.activeOperationId = null;
    const isIndependent = operation.request.phase === 'independent';
    const isJointlyComplete = operation.request.phase === 'reconcile';
    if (isIndependent) {
      operation.request.previousReply = null;
      operation.request.previousReplyStatus = null;
    }
    state.partner.status = status === 'completed' && isIndependent
      ? 'awaiting-phase2'
      : state.operations.some((item) => item.status === 'queued') ? 'queued' : status;
    if (status === 'completed') {
      state.task.status = 'active';
      state.partner.thread.metadata.turnCount += 1;
      state.partner.thread.metadata.lastUsedAt = completedAt;
      if (!isIndependent) {
        state.partner.thread.metadata.repoFingerprint = fingerprint;
        state.partner.thread.metadata.repoFingerprintCapturedAt = completedAt;
        state.partner.thread.metadata.lastRecordedTurn = { at: completedAt, version };
        state.partner.thread.checkpoint.repoFingerprint = fingerprint;
        state.partner.thread.checkpoint.repoFingerprintCapturedAt = completedAt;
        state.partner.thread.checkpoint.updatedAt = completedAt;
      }
    }
    else if (status === 'failed') {
      state.task.status = operation.request.phase === 'single' && !requiresRecovery ? 'partner-unavailable' : 'recovery-required';
      if (operation.request.phase !== 'single' || requiresRecovery) {
        state.route = 'recovery-read-only';
        state.participants = 'both';
      }
    }
    else if (status === 'cancelled' && !state.operations.some((item) => item.status === 'queued')) state.task.status = null;
    state.task.joint.required = true;
    state.task.joint.status = status === 'completed' && isIndependent ? 'awaiting-phase2'
      : status === 'completed' && isJointlyComplete ? 'completed'
        : status === 'completed' ? 'completed' : status === 'failed' ? 'unavailable' : 'pending';
    if (status === 'completed' && isJointlyComplete) {
      const parent = state.operations.find((item) => item.id === operation.request.parentOperationId);
      if (parent) {
        parent.request.ownerMessage = null;
        parent.request.previousReply = null;
        parent.request.message = null;
      }
    }
    if (status !== 'failed' && state.modeGrant?.pausedAt && state.controller.activeOperationId === null) {
      if (state.modeGrant.participants === 'claude' && state.modeGrant.ownerMessage) applyModeSelection(state, state.modeGrant, new Date().toISOString());
      else {
        try { completeModeTransitionInState(state, new Date().toISOString(), config); }
        catch (transitionError) {
          // Retain the unused paused grant and verbatim text, not a half-applied
          // transition. Attachment validation runs before any transition effects.
          if (!/attachment|attach:|ENOENT|EACCES/.test(transitionError.message)) throw transitionError;
          operation.result.warning = 'Pending owner mode transition could not validate its selected images; grant and text retained. Restore the selected file and retry the same mode command.';
        }
      }
    }
    state.operations = pruneOperations(state.operations);
  }, env);
}

function markDeadRunnerFailure(state, operationId, now = new Date().toISOString()) {
  const operation = state.operations.find((item) => item.id === operationId);
  if (!operation || operation.status !== 'working' || state.controller.activeOperationId !== operationId || isProcessAlive(state.controller.runnerPid)) return false;
  operation.status = 'failed';
  operation.request.attachments = [];
  operation.request.message = null;
  operation.result.error = 'controller stopped before the SDK turn outcome was known';
  operation.lifecycle.phase = 'failed';
  operation.lifecycle.detail = 'Controller stopped; recovery is required.';
  operation.lifecycle.finishedAt = now;
  state.controller.activeOperationId = null;
  state.controller.runnerPid = null;
  state.partner.status = 'failed';
  state.route = 'recovery-read-only';
  state.participants = 'both';
  state.task.status = 'recovery-required';
  state.task.joint.required = true;
  state.task.joint.status = 'unavailable';
  return true;
}

export async function failDeadRunnerOperation(root, operationId, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok) throw current.error ?? new Error(`partner state unavailable: ${current.health}`);
  const operation = current.state.operations.find((item) => item.id === operationId);
  if (!operation || operation.status !== 'working' || current.state.controller.activeOperationId !== operationId || isProcessAlive(current.state.controller.runnerPid)) return { changed: false, operation: operation ?? null };
  const updated = await updateState(root, (state) => {
    if (!markDeadRunnerFailure(state, operationId)) throw new Error('operation runner changed while recovery was starting');
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose: 'sdk-dead-runner-recovery' }, env);
  if (!updated.ok) throw updated.error ?? new Error(`dead-runner recovery failed safely: ${updated.health}`);
  return { changed: true, operation: updated.state.operations.find((item) => item.id === operationId) ?? null };
}

export async function runOperation(root, operation, { createCodex, signal } = {}, env = process.env) {
  let finalResponse = null;
  let usage = null;
  let verifiedId = null;
  let expectedId = null;
  try {
    const before = await readState(root, env);
    if (!before.ok) throw new Error(`partner state unavailable: ${before.health}`);
    expectedId = before.state.partner.thread.threadId;
    const config = (await loadEffectiveConfig(before.paths.canonicalRoot, env)).config;
    const repositoryDirectory = config.project.repositoryRoot ? await resolveRepositoryDirectory(before.paths.canonicalRoot, config) : null;
    const options = {
      ...(!expectedId ? { threadSource: 'fabex' } : {}),
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
    const prompt = turnPrompt(operation, operation.request.phase === 'independent' ? null : seed);
    const attachments = validateAttachments(operation.request.attachments ?? [], before.paths.canonicalRoot, config);
    const input = attachments.length ? [{ type: 'text', text: prompt }, ...attachments.map((path) => ({ type: 'local_image', path }))] : prompt;
    const initialInstructions = seed && operation.request.phase === 'independent' ? `${developerInstructions()} ${seed}` : developerInstructions();
    const codex = await createCodex({ config: { developer_instructions: initialInstructions, compact_prompt: COMPACT_PROMPT } });
    const thread = expectedId ? codex.resumeThread(expectedId, options) : codex.startThread(options);
    await mutate(root, 'sdk-execution-envelope', (state) => {
      state.partner.envelope = { cwd: before.paths.canonicalRoot, sandbox: operation.request.sandbox, instructionProfile: 'continuous-canonical-v1' };
    }, env);
    const streamed = await thread.runStreamed(input, { signal, ...(operation.request.participants === 'both' ? { outputSchema: reviewSchema(operation.request.phase) } : {}) });
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
      if (event.type === 'turn.completed') usage = boundedUsage(event.usage);
      if (response !== null) finalResponse = response;
      await recordLifecycle(root, operation.id, lifecycleUpdate(event), env);
      if (event.type === 'turn.failed') throw new Error(event.error?.message ?? 'Codex turn failed');
      if (event.type === 'error') throw new Error(event.message ?? 'Codex stream failed');
    }
    if (!verifiedId) throw new ThreadMismatchError(expectedId, null);
    const fingerprint = await repositoryFingerprint(before.paths.canonicalRoot, config);
    const completedAt = new Date().toISOString();
    const version = await sourceVersion();
    const review = operation.request.participants === 'both' ? parseReview(finalResponse, operation.request.phase) : { finalResponse, structured: null, warning: null };
    const unbounded = review.finalResponse;
    finalResponse = boundedFinalResponse(unbounded);
    if (finalResponse !== unbounded) review.warning = 'Codex answer exceeded the 32 KiB storage bound and was truncated; this is not the complete original answer.';
    const model = await codexModelSource(config, env);
    const relay = finalResponse ? { label: speakerLabels(null, model.id).codex, sessionId: operation.result.relay?.sessionId ?? '', status: 'pending' } : null;
    await finishOperation(root, operation.id, 'completed', { finalResponse, structured: review.structured, warning: review.warning, relay, threadId: verifiedId, fingerprint, completedAt, version, usage }, env);
    return { status: 'completed', threadId: verifiedId, finalResponse };
  } catch (error) {
    const cancelled = signal?.aborted || error?.name === 'AbortError';
    if (cancelled) {
      await finishOperation(root, operation.id, 'cancelled', { threadId: verifiedId ?? expectedId }, env);
      return { status: 'cancelled', threadId: verifiedId ?? expectedId };
    }
    const missing = expectedId && isMissingSessionError(error);
    const mismatch = error?.code === 'thread-mismatch';
    await finishOperation(root, operation.id, 'failed', { error: error?.message ?? String(error), threadId: expectedId, requiresRecovery: Boolean(missing || mismatch) }, env);
    throw error;
  }
}

export async function cancelOperation(root, operationId, env = process.env) {
  let deadRunner = false;
  const state = await mutate(root, 'sdk-cancel-request', (draft) => {
    const operation = draft.operations.find((item) => item.id === operationId);
    if (!operation || !['queued', 'working'].includes(operation.status)) throw new Error('operation is not queued or working');
    deadRunner = markDeadRunnerFailure(draft, operationId);
    if (deadRunner) return;
    operation.lifecycle.cancelRequested = true;
    if (operation.status === 'queued') {
      operation.status = 'cancelled';
      operation.request.attachments = [];
      operation.request.message = null;
      operation.request.ownerMessage = null;
      operation.request.previousReply = null;
      operation.lifecycle.phase = 'cancelled';
      operation.lifecycle.detail = 'Queued Codex turn cancelled.';
      operation.lifecycle.finishedAt = new Date().toISOString();
      draft.partner.status = draft.controller.activeOperationId ? 'working' : draft.operations.some((item) => item.status === 'queued') ? 'queued' : 'cancelled';
      if (!draft.controller.activeOperationId && !draft.operations.some((item) => item.status === 'queued')) draft.task.status = null;
      draft.task.joint.status = 'pending';
    }
  }, env);
  if (!deadRunner && state.controller.activeOperationId === operationId && isProcessAlive(state.controller.runnerPid)) process.kill(state.controller.runnerPid, 'SIGUSR1');
  return { operationId, status: state.operations.find((item) => item.id === operationId)?.status, deadRunner };
}

export async function operationStatus(root, operationId, env = process.env, readOptions = {}) {
  const current = await readState(root, env, readOptions);
  if (!current.ok) throw current.error ?? new Error(`state is ${current.health}`);
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
    if (nextClaimableOperation(current.state.operations)) return false;
    const updated = await updateState(root, (state) => {
      if (state.controller.runnerPid !== pid || nextClaimableOperation(state.operations)) throw new Error('runner release raced with queue submission');
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
