import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { projectPaths } from './paths.mjs';
import { STATE_SCHEMA_VERSION, ValidationError, validateState } from './validation.mjs';

process.umask(0o077);
const MAX_STATE_BYTES = 1024 * 1024;

export class StateStoreError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'StateStoreError';
    this.code = code;
  }
}

export function initialState(identity) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    generation: 0,
    project: { id: identity.projectId, canonicalRoot: identity.canonicalRoot },
    route: 'normal',
    task: { id: null, status: null, label: null, joint: { required: false, status: null, decisionId: null } },
    partner: {
      transport: 'official-codex-plugin',
      status: 'not-started',
      threadId: null,
      envelope: { cwd: null, sandbox: null, approvalPolicy: null, instructionProfile: null }
    },
    operations: []
  };
}

function recoveryState(identity) {
  const state = initialState(identity);
  state.route = 'recovery-read-only';
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
  const state = await parseJsonFile(paths.stateFile);
  try { validateState(state, paths); } catch (error) {
    const code = error.details?.some((item) => item.includes('schemaVersion')) ? 'schema-mismatch' : 'corrupt';
    throw new StateStoreError(code, error.details?.join('; ') || error.message, error);
  }
  return state;
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
      const state = await loadValidated(paths);
      const hasRunning = state.operations.some((operation) => operation.status === 'running') || state.partner.status === 'running';
      if (!recoverUnresolved || !hasRunning) return { ok: true, state, health: 'healthy', paths };
      return updateState(root, (draft) => {
        draft.route = 'recovery-read-only';
        draft.task.status = 'recovery-required';
        draft.operations = draft.operations.map((operation) => operation.status === 'running' ? { ...operation, status: 'interrupted' } : operation);
        if (draft.partner.status === 'running') draft.partner.status = 'pending';
        draft.generation += 1;
        return draft;
      }, { expectedGeneration: state.generation, purpose: 'session-recovery' }, env);
    }
    await acquireLock(paths, 'initialize');
    locked = true;
    if (await exists(paths.stateFile)) return { ok: true, state: await loadValidated(paths), health: 'healthy', paths };
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

export async function readState(root, env = process.env, { checkLock = true } = {}) {
  const paths = await projectPaths(root, env);
  try {
    if (checkLock && await exists(paths.lockDir)) throw new StateStoreError('lock-contention', 'state lock is held');
    if (await exists(paths.transactionFile)) throw new StateStoreError('transaction-present', 'an incomplete state transaction requires recovery');
    if (!(await exists(paths.stateFile))) return initializeState(root, env);
    return { ok: true, state: await loadValidated(paths), health: 'healthy', paths };
  } catch (error) {
    const wrapped = error instanceof StateStoreError ? error : new StateStoreError('unwritable', 'state cannot be read safely', error);
    return { ok: false, state: recoveryState(paths), health: wrapped.code, error: wrapped, paths };
  }
}

export async function updateState(root, mutator, { expectedGeneration, purpose = 'update' } = {}, env = process.env) {
  const paths = await projectPaths(root, env);
  let locked = false;
  let temp = null;
  try {
    await acquireLock(paths, purpose);
    locked = true;
    if (await exists(paths.transactionFile)) throw new StateStoreError('transaction-present', 'an incomplete transaction requires recovery');
    if (!(await exists(paths.stateFile))) throw new StateStoreError('missing-during-update', 'state disappeared during update');
    const current = await loadValidated(paths);
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
    const current = statePresent ? await loadValidated(paths) : null;
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
