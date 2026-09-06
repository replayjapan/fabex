import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimNextOperation, submissionEnvelope, submitOperation } from '../../scripts/lib/sdk-controller.mjs';
import { initialState, initializeState, readState, resolveTransaction, updateState } from '../../scripts/lib/state.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-state-'));
  const project = join(directory, 'project');
  await mkdir(project);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { project, env: { ...process.env, FABEX_HOME: join(directory, 'data') } };
}

test('initial state is schema v14 with SDK controller and owner-selected mode', () => {
  const state = initialState({ projectId: '0000000000000000', canonicalRoot: '/synthetic/project' });
  assert.equal(state.schemaVersion, 14);
  assert.equal(state.partner.transport, 'codex-sdk');
  assert.deepEqual(Object.keys(state.partner.thread.checkpoint), ['objective', 'currentTask', 'constraints', 'acceptedDecisions', 'relevantFiles', 'implementationStatus', 'testStatus', 'unresolvedProblems', 'nextAction', 'repoFingerprint', 'repoFingerprintCapturedAt', 'updatedAt', 'fieldUpdatedAt']);
  assert.deepEqual(state.controller, { runnerPid: null, activeOperationId: null, wakeWatcher: null });
  assert.deepEqual(Object.keys(state).sort(), ['generation', 'operations', 'participants', 'partner', 'controller', 'project', 'returnTo', 'route', 'schemaVersion', 'task', 'executorException', 'modeGrant', 'ownerSelectedMode', 'contextEvidence', 'operationalDelivery', 'claudeModel', 'recordedReply', 'sessionStartDiagnostic'].sort());
  assert.equal(state.ownerSelectedMode.route, 'normal');
});

test('1.3.0 schema v4 migrates atomically and preserves the exact canonical thread id', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  const v4 = structuredClone(initialized.state);
  v4.schemaVersion = 4;
  delete v4.controller;
  v4.partner.transport = 'codex-mcp';
  v4.partner.status = 'completed';
  v4.partner.thread.threadId = 'canonical-from-1.3';
  v4.partner.thread.checkpoint = { ownerGoals: ['ship SDK'], acceptedDecisions: ['same id'], currentStatus: 'MCP active' };
  v4.partner.thread.metadata = { ...v4.partner.thread.metadata, reattachStatus: 'required', replacementStatus: 'not-needed' };
  v4.partner.envelope = { cwd: project, sandbox: 'workspace-write', approvalPolicy: 'on-request', instructionProfile: 'continuous-canonical' };
  v4.operations = [{ id: '11111111-1111-4111-8111-111111111111', kind: 'partner', name: 'fabex:reply', status: 'completed', externalId: 'canonical-from-1.3' }];
  await writeFile(initialized.paths.stateFile, `${JSON.stringify(v4)}\n`);
  const loaded = await readState(project, env);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state.schemaVersion, 14);
  assert.equal(loaded.state.partner.transport, 'codex-sdk');
  assert.equal(loaded.state.partner.thread.threadId, 'canonical-from-1.3');
  assert.equal(loaded.state.partner.thread.checkpoint.objective, 'ship SDK');
  assert.deepEqual(loaded.state.partner.thread.checkpoint.acceptedDecisions, ['same id']);
  assert.equal(loaded.state.partner.thread.checkpoint.implementationStatus, 'MCP active');
  assert.deepEqual(loaded.state.operations, []);
  assert.equal(loaded.state.generation, v4.generation + 1);
  assert.deepEqual(JSON.parse(await readFile(initialized.paths.stateFile, 'utf8')), loaded.state);
  await assert.rejects(access(initialized.paths.transactionFile));
});

test('oversized 1.3.0 checkpoint compacts into the current recovery budget during migration', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  const v4 = structuredClone(initialized.state);
  v4.schemaVersion = 4;
  delete v4.controller;
  v4.partner.transport = 'codex-mcp';
  v4.partner.thread.threadId = 'large-checkpoint-thread';
  v4.partner.thread.checkpoint = {
    ownerGoals: Array.from({ length: 8 }, (_, index) => `${index}:${'g'.repeat(32760)}`),
    acceptedDecisions: Array.from({ length: 16 }, (_, index) => `${index}:${'d'.repeat(2040)}`),
    currentStatus: 's'.repeat(8192)
  };
  v4.partner.thread.metadata = { ...v4.partner.thread.metadata, reattachStatus: 'required', replacementStatus: 'not-needed' };
  v4.partner.envelope = { cwd: project, sandbox: 'workspace-write', approvalPolicy: 'on-request', instructionProfile: 'continuous-canonical' };
  await writeFile(initialized.paths.stateFile, `${JSON.stringify(v4)}\n`);
  const loaded = await readState(project, env);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state.partner.thread.threadId, 'large-checkpoint-thread');
  assert.ok(loaded.state.partner.thread.checkpoint.objective.length <= 8192);
  assert.equal(loaded.state.partner.thread.checkpoint.acceptedDecisions.length, 8);
});

test('older companion schema migration retires incompatible companion thread ids', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  const v3 = structuredClone(initialized.state);
  v3.schemaVersion = 3;
  delete v3.controller;
  v3.partner = {
    transport: 'official-codex-plugin', status: 'completed',
    threads: { primaryThreadId: 'companion', writeThreadId: 'companion-write', checkpoint: { ownerGoals: ['goal'], acceptedDecisions: [], currentStatus: null }, metadata: { turnCount: 2, lastUsedAt: null, repoFingerprint: { branch: null, head: null, dirty: null } } },
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'old' }
  };
  v3.operations = [];
  await writeFile(initialized.paths.stateFile, `${JSON.stringify(v3)}\n`);
  const loaded = await readState(project, env);
  assert.equal(loaded.state.schemaVersion, 14);
  assert.equal(loaded.state.partner.thread.threadId, null);
  assert.equal(loaded.state.partner.thread.checkpoint.objective, 'goal');
});

test('first touch initializes and atomic updates leave restrictive clean state', async (t) => {
  const { project, env } = await fixture(t);
  const result = await readState(project, env);
  assert.equal(result.health, 'initialized');
  const updated = await updateState(project, (state) => { state.route = 'discussion'; state.generation += 1; return state; }, { expectedGeneration: 0 }, env);
  assert.equal(updated.ok, true);
  assert.equal((await readState(project, env)).state.route, 'discussion');
  assert.equal((await readdir(result.paths.projectDir)).some((name) => name.includes('.tmp.')), false);
  assert.equal((await stat(result.paths.projectDir)).mode & 0o777, 0o700);
  assert.equal((await stat(result.paths.stateFile)).mode & 0o777, 0o600);
});

test('dead controller work becomes failed recovery state at SessionStart', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await submitOperation(project, submissionEnvelope('active'), env, { spawnRunner: false });
  await claimNextOperation(project, env);
  const recovered = await initializeState(project, env, { recoverUnresolved: true });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.route, 'recovery-read-only');
  assert.equal(recovered.state.operations[0].status, 'failed');
  assert.equal(recovered.state.operations[0].request.message, null);
  assert.equal(recovered.state.controller.activeOperationId, null);
});

test('lock contention, corrupt JSON, and incompatible state fail closed', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  await mkdir(initialized.paths.lockDir, { mode: 0o700 });
  await writeFile(initialized.paths.lockOwnerFile, '{"pid":1}\n', { mode: 0o600 });
  assert.equal((await readState(project, env, { lockWaitMs: 0 })).health, 'lock-contention');
  await rm(initialized.paths.lockDir, { recursive: true });
  await writeFile(initialized.paths.stateFile, '{');
  assert.equal((await readState(project, env)).health, 'corrupt');
  const good = initialState(initialized.paths);
  good.schemaVersion = 99;
  await writeFile(initialized.paths.stateFile, JSON.stringify(good));
  assert.equal((await readState(project, env)).health, 'schema-mismatch');
});

test('validated transactions commit or discard and ambiguous journals remain', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  const next = structuredClone(initialized.state);
  next.generation = 1;
  next.route = 'discussion';
  await writeFile(initialized.paths.transactionFile, JSON.stringify(next));
  await resolveTransaction(project, 'commit', env);
  assert.equal((await readState(project, env)).state.route, 'discussion');
  const discard = structuredClone((await readState(project, env)).state);
  discard.generation += 1;
  await writeFile(initialized.paths.transactionFile, JSON.stringify(discard));
  await resolveTransaction(project, 'discard', env);
  const ambiguous = structuredClone((await readState(project, env)).state);
  ambiguous.generation += 4;
  await writeFile(initialized.paths.transactionFile, JSON.stringify(ambiguous));
  await assert.rejects(resolveTransaction(project, 'commit', env), (error) => error.code === 'transaction-ambiguous');
  await assert.doesNotReject(access(initialized.paths.transactionFile));
});

test('generation-zero journal restores a missing initial state', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  await writeFile(initialized.paths.transactionFile, await readFile(initialized.paths.stateFile));
  await unlink(initialized.paths.stateFile);
  await resolveTransaction(project, 'commit', env);
  assert.equal((await readState(project, env)).state.generation, 0);
});
