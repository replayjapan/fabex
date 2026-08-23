import { basename } from 'node:path';

export const MAX_RECOVERY_SEED_BYTES = 48 * 1024;

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
    repoFingerprint: { branch: null, head: null, dirty: null }
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
