import { buildRecoverySeed, CHECKPOINT_ARRAY_LIMITS, CHECKPOINT_MUTABLE_FIELDS } from './checkpoint.mjs';
import { isValidMode, PARTICIPANTS } from './mode.mjs';

export const STATE_SCHEMA_VERSION = 8;
export const ROUTES = new Set(['normal', 'discussion', 'ask-once', 'recovery-read-only']);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_STATUSES = new Set([null, 'active', 'completed', 'partner-unavailable', 'recovery-required']);
const JOINT_STATUSES = new Set([null, 'pending', 'awaiting-phase2', 'completed', 'unavailable']);
const PARTNER_STATUSES = new Set(['not-started', 'queued', 'working', 'awaiting-phase2', 'completed', 'failed', 'cancelled', 'unavailable']);
const OPERATION_STATUSES = new Set(['queued', 'working', 'completed', 'failed', 'cancelled']);
const PHASES = new Set(['queued', 'working', 'command', 'tests', 'completed', 'failed', 'cancelled']);
const COLLABORATION_PHASES = new Set(['single', 'independent', 'reconcile']);
const DIGEST_RE = /^[a-f0-9]{64}$/;

export class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const nullableString = (value) => value === null || typeof value === 'string';
const boundedString = (value, bytes) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= bytes;
const boundedNullableString = (value, bytes) => value === null || boundedString(value, bytes);
const boundedStrings = (value, count, bytes) => Array.isArray(value) && value.length <= count && value.every((item) => boundedString(item, bytes));
const nullableIsoString = (value) => value === null || (boundedString(value, 64) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);

function validFingerprint(value) {
  return hasExactKeys(value, ['branch', 'head', 'dirty'])
    && nullableString(value.branch) && nullableString(value.head) && [null, true, false].includes(value.dirty);
}

function validateCheckpoint(checkpoint, projectRoot, errors) {
  const keys = ['objective', 'currentTask', 'constraints', 'acceptedDecisions', 'relevantFiles', 'implementationStatus', 'testStatus', 'unresolvedProblems', 'nextAction', 'repoFingerprint', 'repoFingerprintCapturedAt', 'updatedAt', 'fieldUpdatedAt'];
  if (!hasExactKeys(checkpoint, keys)) { errors.push('partner checkpoint shape is invalid'); return; }
  for (const key of ['objective', 'currentTask', 'implementationStatus', 'testStatus', 'nextAction']) {
    if (!boundedNullableString(checkpoint[key], 8192)) errors.push(`checkpoint ${key} is invalid`);
  }
  for (const [field, limit] of Object.entries(CHECKPOINT_ARRAY_LIMITS)) if (!boundedStrings(checkpoint[field], limit.count, limit.bytes)) errors.push(`checkpoint ${field} is invalid`);
  if (!validFingerprint(checkpoint.repoFingerprint)) errors.push('checkpoint repoFingerprint is invalid');
  if (!nullableIsoString(checkpoint.repoFingerprintCapturedAt)) errors.push('checkpoint repoFingerprintCapturedAt is invalid');
  if (!nullableIsoString(checkpoint.updatedAt)) errors.push('checkpoint updatedAt is invalid');
  if (!hasExactKeys(checkpoint.fieldUpdatedAt, CHECKPOINT_MUTABLE_FIELDS) || CHECKPOINT_MUTABLE_FIELDS.some((field) => !nullableIsoString(checkpoint.fieldUpdatedAt?.[field]))) errors.push('checkpoint fieldUpdatedAt is invalid');
  try { buildRecoverySeed(checkpoint, projectRoot); } catch (error) { errors.push(error.message); }
}

function validRecordedTurn(value) {
  return value === null || (hasExactKeys(value, ['at', 'version']) && value.at !== null && nullableIsoString(value.at) && boundedString(value.version, 64));
}

function validDigestEvidence(value) {
  return value === null || (hasExactKeys(value, ['digest', 'bytes', 'capturedAt', 'sessionId'])
    && DIGEST_RE.test(value.digest ?? '') && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && nullableIsoString(value.capturedAt) && value.capturedAt !== null && boundedString(value.sessionId, 256));
}

function validModeGrant(value) {
  return value === null || (hasExactKeys(value, ['id', 'sessionId', 'route', 'participants', 'createdAt', 'expiresAt'])
    && UUID_RE.test(value.id ?? '') && boundedString(value.sessionId, 256)
    && ['normal', 'discussion', 'ask-once'].includes(value.route) && PARTICIPANTS.has(value.participants)
    && isValidMode(value.route, value.participants) && nullableIsoString(value.createdAt) && value.createdAt !== null
    && nullableIsoString(value.expiresAt) && value.expiresAt !== null);
}

function validDelivery(value) {
  return value === null || (hasExactKeys(value, ['agentId', 'status', 'startedAt', 'finishedAt', 'resultDigest'])
    && boundedString(value.agentId, 256) && ['working', 'completed', 'failed'].includes(value.status)
    && nullableIsoString(value.startedAt) && value.startedAt !== null && nullableIsoString(value.finishedAt)
    && (value.resultDigest === null || DIGEST_RE.test(value.resultDigest)));
}

function validCompaction(value) {
  return value === null || (hasExactKeys(value, ['at', 'trigger', 'sessionId'])
    && nullableIsoString(value.at) && value.at !== null && ['manual', 'auto'].includes(value.trigger)
    && boundedString(value.sessionId, 256));
}

function validWakeWatcher(value) {
  return value === null || (hasExactKeys(value, ['pid', 'operationId', 'startedAt'])
    && Number.isSafeInteger(value.pid) && value.pid > 0 && UUID_RE.test(value.operationId ?? '')
    && nullableIsoString(value.startedAt) && value.startedAt !== null);
}

function validateOperation(operation, errors) {
  if (!hasExactKeys(operation, ['id', 'kind', 'name', 'status', 'externalId', 'request', 'result', 'lifecycle'])) { errors.push('operation record is invalid'); return; }
  if (!UUID_RE.test(operation.id ?? '') || operation.kind !== 'partner' || operation.name !== 'sdk-turn' || !OPERATION_STATUSES.has(operation.status) || !nullableString(operation.externalId)) errors.push('operation identity is invalid');
  if (!hasExactKeys(operation.request, ['message', 'route', 'participants', 'sandbox', 'phase', 'parentOperationId', 'ownerMessageDigest', 'claudeReplyVerified'])) errors.push('operation request shape is invalid');
  else {
    if (!boundedNullableString(operation.request.message, 192 * 1024)) errors.push('operation message is invalid');
    if (!ROUTES.has(operation.request.route) || operation.request.route === 'recovery-read-only') errors.push('operation route is invalid');
    if (!PARTICIPANTS.has(operation.request.participants) || operation.request.participants === 'claude') errors.push('operation participants are invalid');
    const expectedSandbox = operation.request.route === 'normal' ? 'workspace-write' : 'read-only';
    if (operation.request.sandbox !== expectedSandbox) errors.push('operation sandbox is invalid');
    if (!COLLABORATION_PHASES.has(operation.request.phase)) errors.push('operation collaboration phase is invalid');
    if (operation.request.parentOperationId !== null && !UUID_RE.test(operation.request.parentOperationId ?? '')) errors.push('operation parent id is invalid');
    if ((operation.request.phase === 'reconcile') !== (operation.request.parentOperationId !== null)) errors.push('operation parent/phase linkage is invalid');
    if (operation.request.ownerMessageDigest !== null && !DIGEST_RE.test(operation.request.ownerMessageDigest)) errors.push('operation owner message digest is invalid');
    if (![true, false, 'unavailable'].includes(operation.request.claudeReplyVerified)) errors.push('operation Claude reply verification is invalid');
  }
  if (!hasExactKeys(operation.result, ['finalResponse', 'error']) || !boundedNullableString(operation.result.finalResponse, 32 * 1024) || !boundedNullableString(operation.result.error, 8192)) errors.push('operation result is invalid');
  if (!hasExactKeys(operation.lifecycle, ['phase', 'detail', 'queuedAt', 'startedAt', 'finishedAt', 'cancelRequested'])) errors.push('operation lifecycle shape is invalid');
  else if (!PHASES.has(operation.lifecycle.phase) || !boundedString(operation.lifecycle.detail, 1024) || !boundedString(operation.lifecycle.queuedAt, 64) || !boundedNullableString(operation.lifecycle.startedAt, 64) || !boundedNullableString(operation.lifecycle.finishedAt, 64) || typeof operation.lifecycle.cancelRequested !== 'boolean') errors.push('operation lifecycle is invalid');
}

export function validateState(state, identity) {
  const errors = [];
  if (!hasExactKeys(state, ['schemaVersion', 'generation', 'project', 'route', 'participants', 'returnTo', 'task', 'partner', 'controller', 'operations', 'executorException', 'modeGrant', 'contextEvidence', 'operationalDelivery'])) errors.push('state has unexpected or missing top-level fields');
  if (state?.schemaVersion !== STATE_SCHEMA_VERSION) errors.push('state schemaVersion is incompatible');
  if (!Number.isSafeInteger(state?.generation) || state.generation < 0) errors.push('generation must be a non-negative integer');
  if (!hasExactKeys(state?.project, ['id', 'canonicalRoot'])) errors.push('project shape is invalid');
  if (identity && state?.project?.id !== identity.projectId) errors.push('project id does not match the canonical root');
  if (identity && state?.project?.canonicalRoot !== identity.canonicalRoot) errors.push('canonical root does not match state ownership');
  if (!ROUTES.has(state?.route) || !PARTICIPANTS.has(state?.participants) || (ROUTES.has(state?.route) && PARTICIPANTS.has(state?.participants) && !isValidMode(state.route, state.participants))) errors.push('route or participants are invalid');
  if (state?.returnTo !== null && (!hasExactKeys(state.returnTo, ['route', 'participants']) || !['normal', 'discussion'].includes(state.returnTo.route) || !PARTICIPANTS.has(state.returnTo.participants) || !isValidMode(state.returnTo.route, state.returnTo.participants))) errors.push('returnTo is invalid');
  if (state?.route !== 'ask-once' && state?.returnTo !== null) errors.push('returnTo is only valid in ask-once mode');
  if (!hasExactKeys(state?.task, ['id', 'status', 'label', 'joint']) || !nullableString(state?.task?.id) || !TASK_STATUSES.has(state?.task?.status) || !nullableString(state?.task?.label)) errors.push('task fields are invalid');
  if (!hasExactKeys(state?.task?.joint, ['required', 'status', 'decisionId']) || typeof state?.task?.joint?.required !== 'boolean' || !JOINT_STATUSES.has(state?.task?.joint?.status) || !nullableString(state?.task?.joint?.decisionId)) errors.push('joint task fields are invalid');
  if (state?.executorException !== null && (!hasExactKeys(state.executorException, ['executor', 'scope', 'reason', 'authorizedAt']) || !boundedString(state.executorException.executor, 128) || !boundedString(state.executorException.scope, 256) || !boundedString(state.executorException.reason, 4096) || !nullableIsoString(state.executorException.authorizedAt))) errors.push('executorException is invalid');
  if (!validModeGrant(state?.modeGrant)) errors.push('modeGrant is invalid');
  if (!hasExactKeys(state?.contextEvidence, ['ownerPrompt', 'ownerVisibleReply']) || !validDigestEvidence(state?.contextEvidence?.ownerPrompt) || !validDigestEvidence(state?.contextEvidence?.ownerVisibleReply)) errors.push('contextEvidence is invalid');
  if (!validDelivery(state?.operationalDelivery)) errors.push('operationalDelivery is invalid');
  if (!hasExactKeys(state?.partner, ['transport', 'status', 'thread', 'envelope']) || state?.partner?.transport !== 'codex-sdk' || !PARTNER_STATUSES.has(state?.partner?.status)) errors.push('partner fields are invalid');
  if (!hasExactKeys(state?.partner?.thread, ['threadId', 'checkpoint', 'metadata']) || !boundedNullableString(state?.partner?.thread?.threadId, 256)) errors.push('canonical partner thread shape is invalid');
  validateCheckpoint(state?.partner?.thread?.checkpoint, state?.project?.canonicalRoot ?? 'project', errors);
  if (!hasExactKeys(state?.partner?.thread?.metadata, ['turnCount', 'lastUsedAt', 'repoFingerprint', 'repoFingerprintCapturedAt', 'lastRecordedTurn', 'lastCompaction']) || !Number.isSafeInteger(state?.partner?.thread?.metadata?.turnCount) || state.partner.thread.metadata.turnCount < 0 || !boundedNullableString(state.partner.thread.metadata.lastUsedAt, 64) || !validFingerprint(state.partner.thread.metadata.repoFingerprint) || !nullableIsoString(state.partner.thread.metadata.repoFingerprintCapturedAt) || !validRecordedTurn(state.partner.thread.metadata.lastRecordedTurn) || !validCompaction(state.partner.thread.metadata.lastCompaction)) errors.push('partner thread metadata is invalid');
  if (!hasExactKeys(state?.partner?.envelope, ['cwd', 'sandbox', 'instructionProfile']) || !boundedNullableString(state?.partner?.envelope?.cwd, 4096) || !boundedNullableString(state?.partner?.envelope?.sandbox, 64) || !boundedNullableString(state?.partner?.envelope?.instructionProfile, 128)) errors.push('partner envelope is invalid');
  const validRunnerPid = state?.controller?.runnerPid === null || (Number.isSafeInteger(state?.controller?.runnerPid) && state.controller.runnerPid > 0);
  const validActiveId = state?.controller?.activeOperationId === null || UUID_RE.test(state?.controller?.activeOperationId ?? '');
  if (!hasExactKeys(state?.controller, ['runnerPid', 'activeOperationId', 'wakeWatcher']) || !validRunnerPid || !validActiveId || !validWakeWatcher(state?.controller?.wakeWatcher)) errors.push('controller state is invalid');
  if (!Array.isArray(state?.operations)) errors.push('operations must be an array');
  for (const operation of state?.operations ?? []) validateOperation(operation, errors);
  const active = (state?.operations ?? []).filter((operation) => operation.status === 'working');
  if (active.length > 1 || (state?.controller?.activeOperationId ?? null) !== (active[0]?.id ?? null)) errors.push('controller active operation does not match queue state');
  for (const operation of state?.operations ?? []) {
    if (operation.request?.phase !== 'reconcile') continue;
    const parent = state.operations.find((candidate) => candidate.id === operation.request.parentOperationId);
    if (!parent || parent.request?.phase !== 'independent' || parent.request?.ownerMessageDigest !== operation.request.ownerMessageDigest) errors.push('reconcile operation does not match an independent parent');
  }
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > 1024 * 1024) errors.push('state exceeds the hard 1 MiB storage limit');
  if (errors.length) throw new ValidationError('invalid state', errors);
  return state;
}

export function assertUuid(value, label = 'id') {
  if (!UUID_RE.test(value ?? '')) throw new ValidationError(`${label} must be a UUID`);
  return value;
}
