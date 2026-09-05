import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { emptyCheckpoint, emptyFieldUpdatedAt, migrateLegacyCheckpoint } from './checkpoint.mjs';
import { projectPaths } from './paths.mjs';
import { STATE_SCHEMA_VERSION, ValidationError, validateState } from './validation.mjs';

process.umask(0o077);
const MAX_STATE_BYTES = 1024 * 1024;
export const DEFAULT_READ_LOCK_WAIT_MS = 3000;

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

export class StateStoreError extends Error {
  constructor(code, message, cause, metadata = null) {
    super(message, { cause });
    this.name = 'StateStoreError';
    this.code = code;
    this.metadata = metadata;
  }
}

export function initialState(identity) {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    generation: 0,
    project: { id: identity.projectId, canonicalRoot: identity.canonicalRoot },
    route: 'normal',
    participants: 'both',
    returnTo: null,
    task: { id: null, status: null, label: null, joint: { required: false, status: null, decisionId: null } },
    executorException: null,
    modeGrant: null,
    ownerSelectedMode: { route: 'normal', participants: 'both', selectedAt: createdAt },
    contextEvidence: { ownerPrompt: null, ownerVisibleReply: null },
    operationalDelivery: null,
    partner: {
      transport: 'codex-sdk',
      status: 'not-started',
      thread: {
        threadId: null,
        checkpoint: emptyCheckpoint(),
        metadata: {
          turnCount: 0,
          lastUsedAt: null,
          repoFingerprint: { branch: null, head: null, dirty: null },
          repoFingerprintCapturedAt: null,
          lastRecordedTurn: null,
          lastCompaction: null
        }
      },
      envelope: { cwd: null, sandbox: null, instructionProfile: null }
    },
    controller: { runnerPid: null, activeOperationId: null, wakeWatcher: null },
    operations: []
  };
}

function recoveryState(identity) {
  const state = initialState(identity);
  state.route = 'recovery-read-only';
  state.ownerSelectedMode = null;
  state.task.status = 'recovery-required';
  return state;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function fsyncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJsonSynced(path, value, flags = 'w') {
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await chmod(path, 0o600);
  } finally {
    await handle.close();
  }
}

async function parseJsonFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new StateStoreError('corrupt', 'state file is not a bounded regular file');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { throw new StateStoreError('corrupt', 'state JSON is corrupt', error); }
}

async function acquireLock(paths, purpose) {
  await ensureDir(dirname(paths.projectDir));
  await ensureDir(paths.projectDir);
  try {
    await mkdir(paths.lockDir, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new StateStoreError('lock-contention', 'state lock is already held', error);
    throw new StateStoreError('unwritable', 'cannot create state lock', error);
  }
  try {
    await writeFile(paths.lockOwnerFile, `${JSON.stringify({ pid: process.pid, operationId: randomUUID(), purpose })}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(paths.lockOwnerFile, 0o600);
    await fsyncDirectory(paths.lockDir);
  } catch (error) {
    await rm(paths.lockDir, { recursive: true, force: true });
    throw new StateStoreError('unwritable', 'cannot record state lock ownership', error);
  }
}

async function releaseLock(paths) {
  try { await unlink(paths.lockOwnerFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rmdir(paths.lockDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fsyncDirectory(paths.projectDir);
}

async function loadValidated(paths) {
  const parsed = await parseJsonFile(paths.stateFile);
  const migrated = [1, 2, 3, 4, 5, 6, 7, 8].includes(parsed?.schemaVersion);
  let state = parsed;
  if (migrated) {
    state = structuredClone(parsed);
    const sourceVersion = state.schemaVersion;
    if (state.schemaVersion === 1) {
      state.participants = 'both';
      state.returnTo = null;
    }
    const legacyCheckpoint = state.partner?.threads?.checkpoint ?? state.partner?.thread?.checkpoint ?? { ownerGoals: [], acceptedDecisions: [], currentStatus: null };
    const legacyMetadata = state.partner?.threads?.metadata ?? state.partner?.thread?.metadata ?? {};
    const preservedThreadId = sourceVersion === 4 && typeof state.partner?.thread?.threadId === 'string' ? state.partner.thread.threadId : null;
    if (sourceVersion <= 4 && state.partner) {
      delete state.partner.threadId;
      delete state.partner.threads;
      delete state.partner.thread;
      state.partner.transport = 'codex-sdk';
      state.partner.status = 'not-started';
      state.partner.thread = {
        threadId: preservedThreadId,
        checkpoint: migrateLegacyCheckpoint(legacyCheckpoint),
        metadata: {
          turnCount: Number.isSafeInteger(legacyMetadata.turnCount) ? legacyMetadata.turnCount : 0,
          lastUsedAt: legacyMetadata.lastUsedAt ?? null,
          repoFingerprint: legacyMetadata.repoFingerprint ?? { branch: null, head: null, dirty: null },
          repoFingerprintCapturedAt: null,
          lastRecordedTurn: null,
          lastCompaction: null
        }
      };
      state.partner.thread.checkpoint.repoFingerprint = state.partner.thread.metadata.repoFingerprint;
      state.partner.envelope = { cwd: null, sandbox: null, instructionProfile: null };
      state.controller = { runnerPid: null, activeOperationId: null, wakeWatcher: null };
      state.operations = [];
    }
    const checkpoint = state.partner?.thread?.checkpoint;
    if (checkpoint) {
      checkpoint.updatedAt ??= null;
      checkpoint.fieldUpdatedAt = { ...emptyFieldUpdatedAt(), ...(checkpoint.fieldUpdatedAt ?? {}) };
      checkpoint.repoFingerprintCapturedAt ??= checkpoint.repoFingerprint?.head ? (state.partner?.thread?.metadata?.lastUsedAt ?? checkpoint.updatedAt ?? null) : null;
    }
    const metadata = state.partner?.thread?.metadata;
    if (metadata) {
      metadata.repoFingerprintCapturedAt ??= metadata.repoFingerprint?.head ? (metadata.lastUsedAt ?? checkpoint?.updatedAt ?? null) : null;
      metadata.lastRecordedTurn ??= null;
      metadata.lastCompaction ??= null;
    }
    if (sourceVersion <= 5) {
      let activeException = null;
      for (const decision of checkpoint?.acceptedDecisions ?? []) {
        const authorized = /^Executor exception authorized: executor=([^;]+); scope=([^;]+); reason=(.+)$/i.exec(decision);
        if (authorized) activeException = { executor: authorized[1].trim(), scope: authorized[2].trim(), reason: authorized[3].trim(), authorizedAt: checkpoint.updatedAt ?? new Date().toISOString() };
        if (/^Executor exception reconciled:/i.test(decision)) activeException = null;
      }
      state.executorException = activeException;
    }
    state.modeGrant ??= null;
    if (state.modeGrant) {
      state.modeGrant.ownerMessage ??= null;
      state.modeGrant.operationId ??= null;
      state.modeGrant.pausedAt ??= null;
    }
    state.ownerSelectedMode ??= ['normal', 'discussion', 'ask-once'].includes(state.route)
      ? { route: state.route, participants: state.participants, selectedAt: metadata?.lastUsedAt ?? checkpoint?.updatedAt ?? new Date().toISOString() }
      : null;
    if (state.ownerSelectedMode === null) {
      state.route = 'discussion';
      state.participants = 'both';
      state.returnTo = null;
    }
    state.contextEvidence ??= { ownerPrompt: null, ownerVisibleReply: null };
    state.operationalDelivery ??= null;
    state.controller ??= { runnerPid: null, activeOperationId: null, wakeWatcher: null };
    state.controller.wakeWatcher ??= null;
    state.operations = (state.operations ?? []).map((operation) => ({
      ...operation,
      request: {
        ...operation.request,
        phase: operation.request?.phase ?? 'single',
        parentOperationId: operation.request?.parentOperationId ?? null,
        ownerMessageDigest: operation.request?.ownerMessageDigest ?? null,
        claudeReplyVerified: operation.request?.claudeReplyVerified ?? 'unavailable',
        ownerMessage: operation.request?.ownerMessage ?? null,
        previousReplyStatus: operation.request?.previousReplyStatus ?? null,
        previousReply: operation.request?.previousReply ?? null,
        interrupted: operation.request?.interrupted ?? false
      }
    }));
    state.schemaVersion = STATE_SCHEMA_VERSION;
  }
  try { validateState(state, paths); } catch (error) {
    const code = error.details?.some((item) => item.includes('schemaVersion')) ? 'schema-mismatch' : 'corrupt';
    throw new StateStoreError(code, error.details?.join('; ') || error.message, error);
  }
  return { state, migrated };
}

async function safeLockMetadata(paths) {
  let owner = {};
  let lockInfo = null;
  try { owner = await parseJsonFile(paths.lockOwnerFile); } catch {}
  try { lockInfo = await stat(paths.lockDir); } catch {}
  return {
    pid: Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? owner.pid : null,
    purpose: typeof owner?.purpose === 'string' ? owner.purpose.slice(0, 128) : null,
    ageMs: lockInfo ? Math.max(0, Math.round(Date.now() - lockInfo.mtimeMs)) : null
  };
}

async function waitForReadableLock(paths, waitMs, pause) {
  const deadline = Date.now() + waitMs;
  let delay = 50;
  while (await exists(paths.lockDir)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const metadata = await safeLockMetadata(paths);
      throw new StateStoreError('lock-contention', `state lock remained held after ${waitMs}ms; lock=${JSON.stringify(metadata)}`, undefined, metadata);
    }
    await pause(Math.min(delay, remaining));
    delay = Math.min(delay * 2, 400);
  }
}

async function acquireLockWithWait(paths, purpose, waitMs, pause) {
  const deadline = Date.now() + waitMs;
  let delay = 50;
  while (true) {
    try {
      await acquireLock(paths, purpose);
      return;
    } catch (error) {
      if (error?.code !== 'lock-contention') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const metadata = await safeLockMetadata(paths);
        throw new StateStoreError('lock-contention', `state lock remained held after ${waitMs}ms; lock=${JSON.stringify(metadata)}`, error, metadata);
      }
      await pause(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 400);
    }
  }
}

async function persistMigration(paths) {
  let locked = false;
  let temp = null;
  try {
    await acquireLock(paths, 'schema-migration-to-v9');
    locked = true;
    if (await exists(paths.transactionFile)) throw new StateStoreError('transaction-present', 'an incomplete transaction requires recovery');
    const loaded = await loadValidated(paths);
    if (!loaded.migrated) return loaded.state;
    if (loaded.state.controller.activeOperationId && processAlive(loaded.state.controller.runnerPid)) {
      const metadata = { pid: loaded.state.controller.runnerPid, operationId: loaded.state.controller.activeOperationId };
      throw new StateStoreError('migration-deferred', 'schema migration deferred while a live controller runner owns an active operation', undefined, metadata);
    }
    const migrated = { ...loaded.state, generation: loaded.state.generation + 1 };
    validateState(migrated, paths);
    temp = `${paths.stateFile}.tmp.${process.pid}.${randomUUID()}`;
    await writeJsonSynced(paths.transactionFile, migrated, 'wx');
    await writeJsonSynced(temp, migrated, 'wx');
    await rename(temp, paths.stateFile);
    temp = null;
    await fsyncDirectory(paths.projectDir);
    await unlink(paths.transactionFile);
    await fsyncDirectory(paths.projectDir);
    return migrated;
  } finally {
    if (temp) await unlink(temp).catch(() => {});
    if (locked) await releaseLock(paths).catch(() => {});
  }
}

export async function initializeState(root, env = process.env, { recoverUnresolved = false } = {}) {
  const paths = await projectPaths(root, env);
  let locked = false;
  try {
    await ensureDir(dirname(paths.projectDir));
    await ensureDir(paths.projectDir);
    if (await exists(paths.lockDir)) throw new StateStoreError('lock-contention', 'state lock is held');
    if (await exists(paths.transactionFile)) throw new StateStoreError('transaction-present', 'an incomplete state transaction requires recovery');
    if (await exists(paths.stateFile)) {
      const loaded = await loadValidated(paths);
      const state = loaded.migrated ? await persistMigration(paths) : loaded.state;
      const hasRunning = state.operations.some((operation) => operation.status === 'working') || state.partner.status === 'working';
      const runnerAlive = processAlive(state.controller.runnerPid);
      if (!recoverUnresolved || !hasRunning || runnerAlive) return { ok: true, state, health: 'healthy', paths };
      return updateState(root, (draft) => {
        draft.route = 'recovery-read-only';
        draft.participants = 'both';
        draft.task.status = 'recovery-required';
        draft.operations = draft.operations.map((operation) => operation.status === 'working'
          ? { ...operation, status: 'failed', request: { ...operation.request, message: null }, result: { ...operation.result, error: 'controller stopped before the SDK turn outcome was known' }, lifecycle: { ...operation.lifecycle, phase: 'failed', detail: 'Controller stopped; recovery is required.', finishedAt: new Date().toISOString() } }
          : operation);
        draft.partner.status = 'failed';
        draft.controller = { runnerPid: null, activeOperationId: null, wakeWatcher: null };
        draft.generation += 1;
        return draft;
      }, { expectedGeneration: state.generation, purpose: 'session-recovery' }, env);
    }
    await acquireLock(paths, 'initialize');
    locked = true;
    if (await exists(paths.stateFile)) return { ok: true, state: (await loadValidated(paths)).state, health: 'healthy', paths };
    const state = initialState(paths);
    const temp = `${paths.stateFile}.tmp.${process.pid}.${randomUUID()}`;
    await writeJsonSynced(paths.transactionFile, state, 'wx');
    await writeJsonSynced(temp, state, 'wx');
    await rename(temp, paths.stateFile);
    await fsyncDirectory(paths.projectDir);
    await unlink(paths.transactionFile);
    await fsyncDirectory(paths.projectDir);
    return { ok: true, state, health: 'initialized', paths };
  } catch (error) {
    const wrapped = error instanceof StateStoreError ? error : new StateStoreError('unwritable', 'state cannot be initialized safely', error);
    return { ok: false, state: recoveryState(paths), health: wrapped.code, error: wrapped, paths };
  } finally {
    if (locked) await releaseLock(paths).catch(() => {});
  }
}

export async function readState(root, env = process.env, { checkLock = true, lockWaitMs = DEFAULT_READ_LOCK_WAIT_MS, pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)) } = {}) {
  const paths = await projectPaths(root, env);
  try {
    if (checkLock && await exists(paths.lockDir)) await waitForReadableLock(paths, Math.max(0, lockWaitMs), pause);
    if (await exists(paths.transactionFile)) throw new StateStoreError('transaction-present', 'an incomplete state transaction requires recovery');
    if (!(await exists(paths.stateFile))) return initializeState(root, env);
    const loaded = await loadValidated(paths);
    return { ok: true, state: loaded.migrated ? await persistMigration(paths) : loaded.state, health: 'healthy', paths };
  } catch (error) {
    const wrapped = error instanceof StateStoreError ? error : new StateStoreError('unwritable', 'state cannot be read safely', error);
    return { ok: false, state: recoveryState(paths), health: wrapped.code, error: wrapped, lock: wrapped.metadata ?? null, paths };
  }
}

export async function updateState(root, mutator, { expectedGeneration, purpose = 'update', lockWaitMs = 0, pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)) } = {}, env = process.env) {
  const paths = await projectPaths(root, env);
  let locked = false;
  let temp = null;
  try {
    await acquireLockWithWait(paths, purpose, Math.max(0, lockWaitMs), pause);
    locked = true;
    if (await exists(paths.transactionFile)) throw new StateStoreError('transaction-present', 'an incomplete transaction requires recovery');
    if (!(await exists(paths.stateFile))) throw new StateStoreError('missing-during-update', 'state disappeared during update');
    const current = (await loadValidated(paths)).state;
    if (expectedGeneration !== undefined && current.generation !== expectedGeneration) throw new StateStoreError('generation-conflict', 'state generation changed concurrently');
    const proposed = await mutator(structuredClone(current));
    if (!proposed || proposed.generation !== current.generation + 1) throw new StateStoreError('generation-conflict', 'next state must advance generation exactly once');
    validateState(proposed, paths);
    temp = `${paths.stateFile}.tmp.${process.pid}.${randomUUID()}`;
    await writeJsonSynced(paths.transactionFile, proposed, 'wx');
    await writeJsonSynced(temp, proposed, 'wx');
    await rename(temp, paths.stateFile);
    temp = null;
    await fsyncDirectory(paths.projectDir);
    await unlink(paths.transactionFile);
    await fsyncDirectory(paths.projectDir);
    return { ok: true, state: proposed, health: 'healthy', paths };
  } catch (error) {
    if (temp) await unlink(temp).catch(() => {});
    const wrapped = error instanceof StateStoreError || error instanceof ValidationError ? error : new StateStoreError('unwritable', 'state update failed safely', error);
    return { ok: false, state: recoveryState(paths), health: wrapped.code ?? 'corrupt', error: wrapped, paths };
  } finally {
    if (locked) await releaseLock(paths).catch(() => {});
  }
}

export async function clearDeadLock(root, env = process.env) {
  const paths = await projectPaths(root, env);
  let owner;
  try { owner = await parseJsonFile(paths.lockOwnerFile); } catch (error) { throw new StateStoreError('lock-owner-unknown', 'lock owner cannot be verified; refusing to clear', error); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new StateStoreError('lock-owner-unknown', 'lock owner PID is invalid; refusing to clear');
  try {
    process.kill(owner.pid, 0);
    throw new StateStoreError('lock-owner-live', `lock owner PID ${owner.pid} is still alive; refusing to clear`);
  } catch (error) {
    if (error instanceof StateStoreError) throw error;
    if (error.code !== 'ESRCH') throw new StateStoreError('lock-owner-unknown', 'lock owner liveness cannot be verified; refusing to clear', error);
  }
  await unlink(paths.lockOwnerFile);
  await rmdir(paths.lockDir);
  await fsyncDirectory(paths.projectDir);
  return { cleared: true, pid: owner.pid };
}

export async function inspectTransaction(root, env = process.env) {
  const paths = await projectPaths(root, env);
  if (!(await exists(paths.transactionFile))) return { present: false };
  const transaction = await parseJsonFile(paths.transactionFile);
  validateState(transaction, paths);
  return { present: true, generation: transaction.generation, route: transaction.route };
}

export async function resolveTransaction(root, action, env = process.env) {
  if (!['commit', 'discard'].includes(action)) throw new StateStoreError('transaction-action-invalid', 'transaction action must be commit or discard');
  const paths = await projectPaths(root, env);
  let locked = false;
  let temp = null;
  try {
    await acquireLock(paths, `resolve-transaction-${action}`);
    locked = true;
    if (!(await exists(paths.transactionFile))) throw new StateStoreError('transaction-missing', 'no transaction journal is present');
    const transaction = await parseJsonFile(paths.transactionFile);
    try { validateState(transaction, paths); } catch (error) { throw new StateStoreError('transaction-invalid', error.details?.join('; ') || error.message, error); }
    const statePresent = await exists(paths.stateFile);
    const current = statePresent ? (await loadValidated(paths)).state : null;
    const isInitialWrite = !statePresent && transaction.generation === 0;
    const isNextGeneration = statePresent && transaction.generation === current.generation + 1;
    const isInstalledTransaction = statePresent && transaction.generation === current.generation && isDeepStrictEqual(transaction, current);
    if (action === 'commit') {
      if (!isInitialWrite && !isNextGeneration) throw new StateStoreError('transaction-ambiguous', 'transaction commit refused: generation relationship is ambiguous');
      temp = `${paths.stateFile}.tmp.${process.pid}.${randomUUID()}`;
      await writeJsonSynced(temp, transaction, 'wx');
      await rename(temp, paths.stateFile);
      temp = null;
      await fsyncDirectory(paths.projectDir);
      await unlink(paths.transactionFile);
      await fsyncDirectory(paths.projectDir);
      return { action, generation: transaction.generation, route: transaction.route, statePresentBefore: statePresent };
    }
    if (!isInitialWrite && !isNextGeneration && !isInstalledTransaction) throw new StateStoreError('transaction-ambiguous', 'transaction discard refused: generation relationship is ambiguous');
    await unlink(paths.transactionFile);
    await fsyncDirectory(paths.projectDir);
    return { action, generation: transaction.generation, route: transaction.route, statePresentBefore: statePresent };
  } catch (error) {
    if (temp) await unlink(temp).catch(() => {});
    if (error instanceof StateStoreError) throw error;
    throw new StateStoreError('transaction-recovery-failed', 'transaction recovery failed safely', error);
  } finally {
    if (locked) await releaseLock(paths).catch(() => {});
  }
}
