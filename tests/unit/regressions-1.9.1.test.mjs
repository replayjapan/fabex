import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewSchema, validReview, parseReview, relayBlock, missingRelays } from '../../scripts/lib/review.mjs';
import { claudeModelSource, speakerLabels } from '../../scripts/lib/speakers.mjs';
import { classifyToolUse, classifyUnhealthyToolUse, parseControllerCommand } from '../../scripts/hook-route-guard.mjs';
import { initialState, initializeState, updateState, readState } from '../../scripts/lib/state.mjs';
import { waitForOperation } from '../../scripts/controller.mjs';
import { submitOperation, submissionEnvelope, reconciliationEnvelope, claimNextOperation, runOperation } from '../../scripts/lib/sdk-controller.mjs';

const plugin = resolve(import.meta.dirname, '../..');
const id = '11111111-1111-4111-8111-111111111111';
function fields(phase = 'reconcile') {
  return { answer: 'Complete phase record, retained for inspection.', ownerSummary: 'The update is ready. Live delivery remains untested.', scopeMismatch: null, parityConcern: null,
    evidence: ['internal detail'], assumptions: [], uncertainties: [], recommendation: null, changedFiles: [], tests: [], ...(phase === 'reconcile' ? { disagreements: [] } : {}) };
}
function op(phase = 'reconcile') {
  return { id: phase === 'independent' ? 'parent' : 'child', status: 'completed', request: { phase, parentOperationId: phase === 'reconcile' ? 'parent' : null },
    result: { finalResponse: fields().answer, structured: fields(phase), relay: { label: 'Codex (Astra):', status: 'pending', sessionId: 'session' }, warning: null } };
}

test('1.9.1 schema requires bounded author-owned summaries while stored legacy reviews remain valid', () => {
  for (const phase of ['independent', 'reconcile']) {
    assert.ok(reviewSchema(phase).required.includes('ownerSummary'));
    assert.equal(validReview(fields(phase), phase), true);
    for (const ownerSummary of ['', ' ', 'x'.repeat(1201), null]) assert.equal(validReview({ ...fields(phase), ownerSummary }, phase), false);
    const legacy = fields(phase); delete legacy.ownerSummary;
    assert.equal(validReview(legacy, phase), true);
    assert.equal(validReview(legacy, phase, { allowLegacy: false }), false);
    assert.equal(parseReview(JSON.stringify(legacy), phase).finalResponse, legacy.answer);
  }
});

test('1.9.1 relay uses summary paragraphs, flags and difference notice without JSON or transcript dumping', () => {
  const operation = op(); const before = structuredClone(operation);
  assert.equal(relayBlock(operation), `Codex (Astra):\n\n${operation.result.structured.ownerSummary}`);
  assert.deepEqual(operation, before);
  Object.assign(operation.result.structured, { scopeMismatch: 'One check remains.', disagreements: ['Direct delivery is not verified.'], uncertainties: ['Host behavior remains unknown.'] });
  const block = relayBlock(operation);
  assert.match(block, /Scope mismatch: One check remains/);
  assert.match(block, /independent and reconciled answers in full/);
  assert.doesNotMatch(block, /> |```|internal detail|Complete phase record/);
  const full = relayBlock(operation, { full: true });
  assert.match(full, /Phase 2/); assert.ok(full.includes(operation.result.finalResponse));
  delete operation.result.structured.ownerSummary;
  assert.match(relayBlock(operation), /Summary unavailable/);
  assert.ok(relayBlock(operation).includes(operation.result.finalResponse));
});

test('1.9.1 Stop verifies linked Phase 2 summary and label, retains legacy and independent obligations', () => {
  const parent = op('independent'), child = op();
  parent.result.structured.ownerSummary = 'Independent reading.';
  const state = { operations: [parent, child] };
  const input = { session_id: 'session', last_assistant_message: relayBlock(child) };
  assert.deepEqual(missingRelays(state, input), []);
  assert.equal(missingRelays(state, { ...input, last_assistant_message: child.result.structured.ownerSummary }).length, 1);
  assert.equal(missingRelays(state, { ...input, last_assistant_message: relayBlock(child).replace('ready', 'done') }).length, 1);
  assert.equal(missingRelays({ operations: [parent] }, input).length, 1);
  const unrelated = op('independent'); unrelated.id = 'other'; unrelated.result.structured.ownerSummary = 'Another owner cycle.';
  assert.equal(missingRelays({ operations: [...state.operations, unrelated] }, input).length, 1);
  delete parent.result.structured.ownerSummary;
  assert.equal(missingRelays(state, input).length, 1);
  assert.deepEqual(missingRelays(state, { ...input, last_assistant_message: `${relayBlock(parent)}\n${relayBlock(child)}` }), []);
  assert.deepEqual(missingRelays(state, { session_id: 'other', last_assistant_message: '' }), []);
});

test('1.9.1 Claude model source prefers session, strips context suffix, labels configured and unknown honestly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-label-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: directory };
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ model: 'claude-fable-5-1[1m]', unrelated: 'preserved' }));
  let model = await claudeModelSource(null, env);
  assert.deepEqual(model, { id: 'claude-fable-5-1', source: 'Claude settings default', verified: false });
  assert.equal(speakerLabels(model.id, null, model.source).claude, 'Claude (Fable) [configured]:');
  model = await claudeModelSource({ id: 'claude-sonnet-4-6' }, env);
  assert.equal(model.source, 'session hook evidence');
  assert.equal(speakerLabels(model.id, null, model.source).claude, 'Claude (Sonnet):');
  await writeFile(join(directory, 'settings.json'), '{malformed');
  assert.equal((await claudeModelSource(null, env)).source, 'unknown');
  assert.equal(speakerLabels(null, null).claude, 'Claude (model unknown):');
});

test('1.9.1 Git delivery defers only for work-mode main or verified operational executor', async () => {
  const state = initialState({ projectId: 'test', canonicalRoot: plugin });
  const commands = ['git add src/file.ts', 'git commit -m release', 'git tag v1.9.1', 'git push origin main', 'gh pr list'];
  for (const route of ['normal', 'discussion', 'ask-once', 'recovery-read-only']) {
    state.route = route;
    for (const executor of [{}, { agentId: 'op', agentType: 'fabex:fabex-operational' }, { agentId: 'other', agentType: 'general-purpose' }, { agentType: 'general-purpose' }]) {
      for (const command of commands) {
        const result = await classifyToolUse({ state, paths: { canonicalRoot: plugin }, toolName: 'Bash', toolInput: { command }, executor });
        assert.equal(result.decision, route === 'normal' && (!executor.agentType || executor.agentId === 'op') ? 'defer' : 'deny', `${route}: ${command}`);
        assert.equal(classifyUnhealthyToolUse({ toolName: 'Bash', toolInput: { command }, health: 'migration-deferred' }).decision, 'deny');
      }
    }
  }
});

test('1.9.1 controller wait cap and exact relay --full shape retain read-only access', async () => {
  const base = `node ${join(plugin, 'scripts/controller.mjs')}`;
  assert.equal(parseControllerCommand(`${base} relay --operation-id ${id} --full`).kind, 'controller-relay');
  assert.equal(parseControllerCommand(`${base} relay --operation-id ${id} --full junk`), null);
  assert.equal(parseControllerCommand(`${base} wait --operation-id ${id} --timeout 120`).kind, 'controller-wait');
  assert.equal(parseControllerCommand(`${base} wait --operation-id ${id} --timeout 121`), null);
  await assert.rejects(waitForOperation(plugin, id, 121), /120/);
});

test('1.9.1 controller relay --full prints full stored answer and default prints owner summary', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-relay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'); await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'state'), CLAUDE_CONFIG_DIR: join(directory, 'claude'), CODEX_HOME: join(directory, 'codex') };
  await initializeState(project, env);
  await submitOperation(project, submissionEnvelope('test'), env, { spawnRunner: false });
  const operation = await claimNextOperation(project, env);
  await runOperation(project, operation, { createCodex: async () => ({ startThread: () => ({ runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'test-thread' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(fields('independent')) } };
    yield { type: 'turn.completed' };
  })() }) }) }) }, env);
  const run = extra => spawnSync(process.execPath, [join(plugin, 'scripts/controller.mjs'), 'relay', '--operation-id', operation.id, ...extra], { cwd: project, env, encoding: 'utf8' });
  const normal = run([]), full = run(['--full']);
  assert.equal(normal.status, 0, normal.stderr); assert.equal(full.status, 0, full.stderr);
  assert.ok(normal.stdout.includes(fields().ownerSummary)); assert.ok(!normal.stdout.includes(fields().answer));
  assert.ok(full.stdout.includes(fields().answer));
  assert.equal((await readState(project, env)).ok, true);
  await submitOperation(project, reconciliationEnvelope(operation.id, 'test', 'Claude agrees.'), env, { spawnRunner: false });
  const child = await claimNextOperation(project, env);
  const childFields = { ...fields(), ownerSummary: 'Reconciled and checked. Host delivery is pending.' };
  await runOperation(project, child, { createCodex: async () => ({ resumeThread: () => ({ runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'test-thread' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(childFields) } };
    yield { type: 'turn.completed' };
  })() }) }) }) }, env);
  const completed = (await readState(project, env)).state.operations.find(item => item.id === child.id);
  const stopped = spawnSync(process.execPath, [join(plugin, 'scripts/hook-stop.mjs')], { cwd: project, env, encoding: 'utf8', input: JSON.stringify({ cwd: project, session_id: completed.result.relay.sessionId || 'test-session', last_assistant_message: relayBlock(completed) }) });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.notEqual(JSON.parse(stopped.stdout || '{}').decision, 'block', stopped.stdout);
  const afterStop = (await readState(project, env)).state.operations;
  for (const item of afterStop) assert.equal(item.result.relay.status, 'delivered');
  // Preserve legacy complete answers and a pending operation during schema 14
  // migration. A live runner must defer it without changing one byte on disk.
  await submitOperation(project, submissionEnvelope('next cycle'), env, { spawnRunner: false });
  await claimNextOperation(project, env);
  const current = await readState(project, env);
  const legacy = structuredClone(current.state);
  legacy.schemaVersion = 14;
  for (const item of legacy.operations) if (item.result.structured) delete item.result.structured.ownerSummary;
  legacy.controller.runnerPid = process.pid;
  await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  assert.equal((await readState(project, env)).health, 'migration-deferred');
  assert.deepEqual(JSON.parse(await readFile(current.paths.stateFile, 'utf8')), legacy);
  legacy.controller.runnerPid = null;
  await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  const migrated = await readState(project, env);
  assert.equal(migrated.ok, true, migrated.error?.message);
  assert.deepEqual(migrated.state, { ...legacy, schemaVersion: 15, generation: migrated.state.generation });
});
