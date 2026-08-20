import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, initializeState, readState, resolveTransaction, updateState } from '../../scripts/lib/state.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-state-'));
  const project = join(directory, 'project');
  await mkdir(project);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { project, env: { ...process.env, FABEX_HOME: join(directory, 'data') } };
}

test('initial state is schema-versioned with the compact Fabex shape', () => {
  const state = initialState({ projectId: '0000000000000000', canonicalRoot: '/synthetic/project' });
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.route, 'normal');
  assert.equal(state.participants, 'both');
  assert.equal(state.returnTo, null);
  assert.deepEqual(Object.keys(state).sort(), ['generation', 'operations', 'participants', 'partner', 'project', 'returnTo', 'route', 'schemaVersion', 'task'].sort());
});

test('schema v1 state migrates atomically in place on load', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  const v1 = structuredClone(initialized.state);
  v1.schemaVersion = 1;
  delete v1.participants;
  delete v1.returnTo;
  await writeFile(initialized.paths.stateFile, `${JSON.stringify(v1)}\n`);
  const loaded = await readState(project, env);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.health, 'healthy');
  assert.equal(loaded.state.schemaVersion, 2);
  assert.equal(loaded.state.participants, 'both');
  assert.equal(loaded.state.returnTo, null);
  assert.equal(loaded.state.generation, v1.generation + 1);
  assert.deepEqual(JSON.parse(await readFile(initialized.paths.stateFile, 'utf8')), loaded.state);
  await assert.rejects(access(initialized.paths.transactionFile));
});

test('readState first touch atomically initializes instead of reporting missing', async (t) => {
  const { project, env } = await fixture(t);
  const result = await readState(project, env);
  assert.equal(result.ok, true);
  assert.equal(result.health, 'initialized');
  assert.equal(result.state.route, 'normal');
  await assert.doesNotReject(access(result.paths.stateFile));
  await assert.rejects(access(result.paths.transactionFile));
});

test('atomic update advances generation and cleans journals and temp files', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  const updated = await updateState(project, (state) => {
    state.route = 'discussion';
    state.generation += 1;
    return state;
  }, { expectedGeneration: 0, purpose: 'test' }, env);
  assert.equal(updated.ok, true);
  assert.equal(updated.state.generation, 1);
  assert.equal((await readState(project, env)).state.route, 'discussion');
  assert.equal((await readdir(initialized.paths.projectDir)).some((name) => name.includes('.tmp.')), false);
  assert.equal((await stat(initialized.paths.projectDir)).mode & 0o777, 0o700);
  assert.equal((await stat(initialized.paths.stateFile)).mode & 0o777, 0o600);
});

test('lock contention produces recovery-read-only without stealing the lock', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  await mkdir(initialized.paths.lockDir, { mode: 0o700 });
  await writeFile(initialized.paths.lockOwnerFile, '{"pid":1}\n', { mode: 0o600 });
  const result = await readState(project, env);
  assert.equal(result.ok, false);
  assert.equal(result.health, 'lock-contention');
  assert.equal(result.state.route, 'recovery-read-only');
  await assert.doesNotReject(access(initialized.paths.lockOwnerFile));
});

test('corrupt and incompatible state require recovery', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  await writeFile(initialized.paths.stateFile, '{');
  assert.equal((await readState(project, env)).health, 'corrupt');
  const good = initialState(initialized.paths);
  good.schemaVersion = 9;
  await writeFile(initialized.paths.stateFile, JSON.stringify(good));
  const mismatch = await readState(project, env);
  assert.equal(mismatch.health, 'schema-mismatch');
  assert.equal(mismatch.state.route, 'recovery-read-only');
});

test('running partner work becomes interrupted recovery state at SessionStart', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await updateState(project, (state) => {
    state.partner.status = 'running';
    state.operations.push({ id: '11111111-1111-4111-8111-111111111111', kind: 'partner', name: 'joint', status: 'running', externalId: null });
    state.generation += 1;
    return state;
  }, { expectedGeneration: 0 }, env);
  const recovered = await initializeState(project, env, { recoverUnresolved: true });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.route, 'recovery-read-only');
  assert.equal(recovered.state.operations[0].status, 'interrupted');
  assert.equal(recovered.state.partner.status, 'pending');
});

test('validated next-generation transaction can commit', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  const transaction = structuredClone(initialized.state);
  transaction.generation = 1;
  transaction.route = 'discussion';
  await writeFile(initialized.paths.transactionFile, JSON.stringify(transaction));
  assert.equal((await readState(project, env)).health, 'transaction-present');
  await resolveTransaction(project, 'commit', env);
  const current = await readState(project, env);
  assert.equal(current.state.generation, 1);
  assert.equal(current.state.route, 'discussion');
});

test('validated next-generation transaction can discard', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  const transaction = structuredClone(initialized.state);
  transaction.generation = 1;
  await writeFile(initialized.paths.transactionFile, JSON.stringify(transaction));
  await resolveTransaction(project, 'discard', env);
  assert.equal((await readState(project, env)).state.generation, 0);
  await assert.rejects(access(initialized.paths.transactionFile));
});

test('generation-zero journal restores a missing initial state', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  await writeFile(initialized.paths.transactionFile, await readFile(initialized.paths.stateFile));
  await unlink(initialized.paths.stateFile);
  await resolveTransaction(project, 'commit', env);
  assert.equal((await readState(project, env)).state.generation, 0);
});

test('ambiguous transaction is retained for explicit recovery', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  const transaction = structuredClone(initialized.state);
  transaction.generation = 4;
  await writeFile(initialized.paths.transactionFile, JSON.stringify(transaction));
  await assert.rejects(resolveTransaction(project, 'commit', env), (error) => error.code === 'transaction-ambiguous');
  await assert.doesNotReject(access(initialized.paths.transactionFile));
});
