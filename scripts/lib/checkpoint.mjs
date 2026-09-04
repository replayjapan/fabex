import { basename } from 'node:path';

export const MAX_RECOVERY_SEED_BYTES = 48 * 1024;
export const CHECKPOINT_ARRAY_LIMITS = Object.freeze({
  constraints: { count: 24, bytes: 4096 },
  acceptedDecisions: { count: 24, bytes: 4096 },
  relevantFiles: { count: 64, bytes: 1024 },
  unresolvedProblems: { count: 24, bytes: 4096 }
});
export const CHECKPOINT_TEXT_FIELDS = Object.freeze(['objective', 'currentTask', 'implementationStatus', 'testStatus', 'nextAction']);
export const CHECKPOINT_MUTABLE_FIELDS = Object.freeze([...CHECKPOINT_TEXT_FIELDS, ...Object.keys(CHECKPOINT_ARRAY_LIMITS)]);

export function emptyFieldUpdatedAt() {
  return Object.fromEntries(CHECKPOINT_MUTABLE_FIELDS.map((field) => [field, null]));
}

export function emptyCheckpoint() {
  return {
    objective: null,
    currentTask: null,
    constraints: [],
    acceptedDecisions: [],
    relevantFiles: [],
    implementationStatus: null,
    testStatus: null,
    unresolvedProblems: [],
    nextAction: null,
    repoFingerprint: { branch: null, head: null, dirty: null },
    repoFingerprintCapturedAt: null,
    updatedAt: null,
    fieldUpdatedAt: emptyFieldUpdatedAt()
  };
}

function truncateUtf8(value, bytes) {
  if (typeof value !== 'string') return null;
  if (Buffer.byteLength(value, 'utf8') <= bytes) return value;
  let result = value;
  while (result && Buffer.byteLength(result, 'utf8') > bytes - 3) result = result.slice(0, Math.floor(result.length * 0.9));
  while (result && Buffer.byteLength(result, 'utf8') > bytes - 3) result = result.slice(0, -1);
  return `${result}...`;
}

export function migrateLegacyCheckpoint(value = {}) {
  const checkpoint = emptyCheckpoint();
  const goals = Array.isArray(value.ownerGoals) ? value.ownerGoals.filter((item) => typeof item === 'string') : [];
  checkpoint.objective = goals.length ? truncateUtf8(goals.slice(-2).join('\n\n'), 8192) : null;
  checkpoint.acceptedDecisions = (Array.isArray(value.acceptedDecisions) ? value.acceptedDecisions : [])
    .filter((item) => typeof item === 'string').slice(-8).map((item) => truncateUtf8(item, 2048));
  checkpoint.implementationStatus = truncateUtf8(value.currentStatus, 8192);
  return checkpoint;
}

export function threadTitle(projectRoot) {
  return `Fabex partner — ${basename(projectRoot) || 'project'} — continuous session`;
}

export function buildRecoverySeed(checkpoint, projectRoot = 'project') {
  const seed = [
    threadTitle(projectRoot),
    'Fabex continuity checkpoint. Treat this bounded persisted checkpoint as prior shared context.',
    JSON.stringify(checkpoint),
    'The repository may have changed; re-read relevant files before repo-dependent conclusions.'
  ].join('\n');
  const bytes = Buffer.byteLength(seed, 'utf8');
  if (bytes > MAX_RECOVERY_SEED_BYTES) throw new Error(`recovery seed exceeds the hard ${MAX_RECOVERY_SEED_BYTES}-byte budget`);
  return seed;
}

export function recoverySeedBytes(checkpoint, projectRoot = 'project') {
  return Buffer.byteLength(buildRecoverySeed(checkpoint, projectRoot), 'utf8');
}

export function rejectPayloadLikeText(value) {
  if (typeof value !== 'string') return;
  const forbidden = /<task-notification>|<system-reminder>|<result>|hookSpecificOutput|tool_use_id/i;
  let objectLike = false;
  try {
    const parsed = JSON.parse(value);
    objectLike = parsed !== null && !Array.isArray(parsed) && typeof parsed === 'object';
  } catch {}
  if (forbidden.test(value) || objectLike) throw new Error('checkpoint values must be owner-visible prose, not tool or notification payloads');
}

export function checkpointWarnings(checkpoint, metadata = {}, { repositoryRootConfigured = true } = {}) {
  const warnings = [];
  if (!checkpoint.objective?.trim()) warnings.push('objective is empty');
  if (checkpoint.currentTask?.trim() && !checkpoint.nextAction?.trim()) warnings.push('nextAction is empty while currentTask is set');
  const testAt = checkpoint.fieldUpdatedAt?.testStatus;
  const implementationAt = checkpoint.fieldUpdatedAt?.implementationStatus;
  if (testAt && implementationAt && testAt < implementationAt) warnings.push('testStatus predates implementationStatus');
  if (checkpoint.updatedAt && metadata.lastUsedAt && checkpoint.updatedAt < metadata.lastUsedAt) warnings.push('checkpoint older than the last thread turn');
  const fingerprint = checkpoint.repoFingerprint;
  if (!repositoryRootConfigured && (!fingerprint || fingerprint.head === null)) warnings.push('repositoryRoot is not configured; fingerprint unavailable');
  else if (!fingerprint || fingerprint.head === null) warnings.push('repoFingerprint unavailable');
  return warnings.slice(0, 16).map((warning) => warning.slice(0, 256));
}
