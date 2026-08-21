import { isValidMode, PARTICIPANTS } from './mode.mjs';

export const STATE_SCHEMA_VERSION = 3;
export const ROUTES = new Set(['normal', 'discussion', 'ask-once', 'recovery-read-only']);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_STATUSES = new Set([null, 'active', 'completed', 'partner-unavailable', 'recovery-required']);
const JOINT_STATUSES = new Set([null, 'pending', 'completed', 'unavailable']);
const PARTNER_STATUSES = new Set(['not-started', 'pending', 'running', 'completed', 'unavailable']);
const OPERATION_STATUSES = new Set(['running', 'completed', 'failed', 'interrupted']);
const RESYNC_STATUSES = new Set(['not-needed', 'required', 're-synced']);

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

function nullableString(value) {
  return value === null || typeof value === 'string';
}

function boundedStrings(value, count, bytes) {
  return Array.isArray(value) && value.length <= count && value.every((item) => typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= bytes);
}

export function validateState(state, identity) {
  const errors = [];
  if (!hasExactKeys(state, ['schemaVersion', 'generation', 'project', 'route', 'participants', 'returnTo', 'task', 'partner', 'operations'])) errors.push('state has unexpected or missing top-level fields');
  if (state?.schemaVersion !== STATE_SCHEMA_VERSION) errors.push('state schemaVersion is incompatible');
  if (!Number.isSafeInteger(state?.generation) || state.generation < 0) errors.push('generation must be a non-negative integer');
  if (!hasExactKeys(state?.project, ['id', 'canonicalRoot'])) errors.push('project shape is invalid');
  if (identity && state?.project?.id !== identity.projectId) errors.push('project id does not match the canonical root');
  if (identity && state?.project?.canonicalRoot !== identity.canonicalRoot) errors.push('canonical root does not match state ownership');
  if (!ROUTES.has(state?.route)) errors.push('route is invalid');
  if (!PARTICIPANTS.has(state?.participants)) errors.push('participants is invalid');
  if (ROUTES.has(state?.route) && PARTICIPANTS.has(state?.participants) && !isValidMode(state.route, state.participants)) errors.push('route and participants combination is invalid');
  if (state?.returnTo !== null) {
    if (!hasExactKeys(state?.returnTo, ['route', 'participants']) || !['normal', 'discussion'].includes(state.returnTo?.route) || !PARTICIPANTS.has(state.returnTo?.participants) || !isValidMode(state.returnTo?.route, state.returnTo?.participants)) errors.push('returnTo is invalid');
  }
  if (state?.route !== 'ask-once' && state?.returnTo !== null) errors.push('returnTo is only valid in ask-once mode');
  if (!hasExactKeys(state?.task, ['id', 'status', 'label', 'joint'])) errors.push('task shape is invalid');
  if (!nullableString(state?.task?.id) || !nullableString(state?.task?.status) || !nullableString(state?.task?.label) || !TASK_STATUSES.has(state?.task?.status)) errors.push('task fields are invalid');
  if (!hasExactKeys(state?.task?.joint, ['required', 'status', 'decisionId'])) errors.push('joint task shape is invalid');
  if (typeof state?.task?.joint?.required !== 'boolean' || !nullableString(state?.task?.joint?.status) || !nullableString(state?.task?.joint?.decisionId) || !JOINT_STATUSES.has(state?.task?.joint?.status)) errors.push('joint fields are invalid');
  if (!hasExactKeys(state?.partner, ['transport', 'status', 'threads', 'envelope'])) errors.push('partner shape is invalid');
  if (state?.partner?.transport !== 'official-codex-plugin' || !PARTNER_STATUSES.has(state?.partner?.status)) errors.push('partner fields are invalid');
  if (!hasExactKeys(state?.partner?.threads, ['primaryThreadId', 'writeThreadId', 'checkpoint', 'metadata'])) errors.push('partner thread registry shape is invalid');
  if (!nullableString(state?.partner?.threads?.primaryThreadId) || !nullableString(state?.partner?.threads?.writeThreadId)) errors.push('partner thread ids are invalid');
  if (!hasExactKeys(state?.partner?.threads?.checkpoint, ['ownerGoals', 'acceptedDecisions', 'currentStatus'])) errors.push('partner checkpoint shape is invalid');
  if (!boundedStrings(state?.partner?.threads?.checkpoint?.ownerGoals, 8, 32768)) errors.push('owner goals checkpoint is invalid');
  if (!boundedStrings(state?.partner?.threads?.checkpoint?.acceptedDecisions, 16, 2048)) errors.push('accepted decisions checkpoint is invalid');
  if (!nullableString(state?.partner?.threads?.checkpoint?.currentStatus) || Buffer.byteLength(state?.partner?.threads?.checkpoint?.currentStatus ?? '', 'utf8') > 8192) errors.push('current status checkpoint is invalid');
  if (!hasExactKeys(state?.partner?.threads?.metadata, ['turnCount', 'lastUsedAt', 'repoFingerprint', 'resyncStatus', 'refreshOfferedAt'])) errors.push('partner thread metadata shape is invalid');
  const metadata = state?.partner?.threads?.metadata;
  if (!Number.isSafeInteger(metadata?.turnCount) || metadata.turnCount < 0 || !nullableString(metadata?.lastUsedAt) || !RESYNC_STATUSES.has(metadata?.resyncStatus) || !nullableString(metadata?.refreshOfferedAt)) errors.push('partner thread metadata is invalid');
  if (!hasExactKeys(metadata?.repoFingerprint, ['branch', 'head', 'dirty']) || !nullableString(metadata?.repoFingerprint?.branch) || !nullableString(metadata?.repoFingerprint?.head) || ![null, true, false].includes(metadata?.repoFingerprint?.dirty)) errors.push('repository fingerprint is invalid');
  if (!hasExactKeys(state?.partner?.envelope, ['cwd', 'sandbox', 'approvalPolicy', 'instructionProfile'])) errors.push('partner envelope shape is invalid');
  for (const key of ['cwd', 'sandbox', 'approvalPolicy', 'instructionProfile']) if (!nullableString(state?.partner?.envelope?.[key])) errors.push(`partner envelope ${key} is invalid`);
  if (!Array.isArray(state?.operations)) errors.push('operations must be an array');
  for (const operation of state?.operations ?? []) {
    if (!hasExactKeys(operation, ['id', 'kind', 'name', 'status', 'externalId']) || !UUID_RE.test(operation.id ?? '') || operation.kind !== 'partner' || typeof operation.name !== 'string' || !OPERATION_STATUSES.has(operation.status) || !nullableString(operation.externalId)) errors.push('operation record is invalid');
  }
  if (errors.length) throw new ValidationError('invalid state', errors);
  return state;
}

export function assertUuid(value, label = 'id') {
  if (!UUID_RE.test(value ?? '')) throw new ValidationError(`${label} must be a UUID`);
  return value;
}
