import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockingReviewWarning } from '../../scripts/lib/review-warnings.mjs';
import { validDisposition, dispositionProblem, persistWorkDisposition, continuationFailure, reviewSessionMatches } from '../../scripts/lib/work-disposition.mjs';
import { emptyCheckpoint } from '../../scripts/lib/checkpoint.mjs';
import { startSettingsMenu, advanceSettingsMenu, validateSettingsMenu } from '../../scripts/lib/settings-menu.mjs';
import { resolveSettings } from '../../scripts/lib/workspace-settings.mjs';
import { initializeState, readState } from '../../scripts/lib/state.mjs';
import { registerSession, sealReading } from '../../scripts/lib/workspace.mjs';
import { observeActivity } from '../../scripts/lib/activity.mjs';
import { recordOwnerPromptEvidence } from '../../scripts/lib/hook-evidence.mjs';
import { captureOwnerDelivery, deliveryObligations, ownerDeliveries } from '../../scripts/lib/owner-delivery.mjs';
import { dispatchOwnerDeliveries, submitOperation, reconciliationEnvelope, normalizeSubmissionEnvelope, claimNextOperation, runOperation, continueOperation } from '../../scripts/lib/sdk-controller.mjs';
import { relayBlock } from '../../scripts/lib/review.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';

const advisory = 'Host-managed MCP permissions require live verification; only the declared read-only research tools are authorized.';
const remaining = { status: 'remaining', remainingWork: ['Validate the approved change.'], reason: 'Validation remains.' };
const done = { status: 'done', remainingWork: [], reason: 'The authorized task is complete.' };
const disposition = status => ({ status, remainingWork: ['Validate the approved change.'], reason: status === 'blocked' ? 'The test service is unavailable.' : 'Choose the requested deployment destination.' });
const review = (phase, workDisposition = remaining) => ({ scopeMismatch: null, parityConcern: null, answer: 'Reviewed.', ownerSummary: 'Reviewed.', evidence: [], assumptions: [], uncertainties: [], ...(phase === 'reconcile' ? { disagreements: [], workDisposition } : {}), recommendation: null, changedFiles: [], tests: [] });

test('advisories remain visible without blocking; mixed and unknown failures still block', () => {
  for (const warning of [advisory, advisory + '\nController applied 1 validated test-file edit(s). Test execution remains assigned separately.']) {
    const operation = { result: { warning } };
    assert.equal(blockingReviewWarning(operation), null);
    assert.equal(operation.result.warning, warning);
  }
  for (const failure of ['Structured review unavailable', 'Fresh conversation has not acknowledged the reviewed handoff; implementation remains blocked.', 'Unknown failure']) {
    assert.equal(blockingReviewWarning({ result: { warning: `${advisory}\n${failure}` } }), failure);
  }
  assert.ok(blockingReviewWarning({ result: { warning: advisory.slice(0, -1) } }));
});

test('dispositions distinguish explicit completion, missing bookkeeping and genuine blockers', () => {
  for (const value of [remaining, done, disposition('blocked'), disposition('owner-decision')]) assert.equal(validDisposition(value), true);
  for (const value of [null, {}, { ...remaining, remainingWork: [] }, { ...done, remainingWork: ['Hidden unfinished task'] }, { ...done, reason: '' }]) assert.equal(validDisposition(value), false);
  assert.match(dispositionProblem(null, done), /Claude/);
  assert.match(dispositionProblem(done, null), /Codex/);
  assert.match(dispositionProblem(remaining, done), /different outcomes/);
});

function stateFor(claude = remaining, codex = remaining) {
  const parent = { id: 'parent', status: 'completed', request: { phase: 'independent', interrupted: false } };
  const operation = { id: 'review', status: 'completed', lifecycle: {}, request: { phase: 'reconcile', route: 'normal', parentOperationId: 'parent', ownerMessageDigest: 'a'.repeat(64), workDisposition: claude }, result: { structured: { workDisposition: codex }, warning: advisory, relay: { sessionId: 'session' } } };
  const state = { route: 'normal', ownerSelectedMode: { route: 'normal' }, modeGrant: null, workspace: { activeSessionId: 'session' }, contextEvidence: { ownerPrompt: { digest: 'a'.repeat(64) } }, operations: [parent, operation], partner: { thread: { checkpoint: emptyCheckpoint() } } };
  return { state, operation, cp: state.partner.thread.checkpoint };
}

test('matching dispositions persist and arm work atomically; completion and blockers do not arm', () => {
  for (const value of [remaining, done, disposition('blocked'), disposition('owner-decision')]) {
    const { state, operation, cp } = stateFor(value, value);
    assert.equal(persistWorkDisposition(state, operation, '2026-01-01T00:00:00.000Z'), null);
    assert.deepEqual(cp.openWork, value.remainingWork);
    assert.equal(cp.continuation.armed, value.status === 'remaining');
    assert.equal(cp.blocker, value.status === 'blocked' ? value.reason : null);
    assert.equal(cp.ownerActionRequired, value.status === 'owner-decision' ? value.reason : null);
  }
});

test('missing or disputed outcomes preserve unfinished work and cannot silently complete', () => {
  for (const pair of [[null, done], [done, null], [remaining, done]]) {
    const { state, operation, cp } = stateFor(...pair);
    cp.openWork = ['Previously authorized work.']; cp.continuation.armed = true;
    assert.match(persistWorkDisposition(state, operation, '2026-01-01T00:00:00.000Z'), /requires reconciliation/);
    assert.deepEqual(cp.openWork, ['Previously authorized work.']); assert.equal(cp.continuation.armed, false);
  }
});

test('new messages, cancellation, changed sessions and discussion prevent stale rearming', () => {
  const changes = [
    s => { s.contextEvidence.ownerPrompt.digest = 'b'.repeat(64); },
    s => { s.operations.splice(1, 0, { id: 'later-owner', request: { phase: 'independent' } }); },
    s => { s.operations.at(-1).lifecycle.cancelRequested = true; },
    s => { s.workspace.activeSessionId = 'other'; },
    s => { s.route = 'discussion'; },
    s => { s.operations.at(-1).result.warning = 'Review integrity failure'; }
  ];
  for (const change of changes) {
    const { state, operation, cp } = stateFor(); cp.openWork = ['Preserve the prior task.']; change(state);
    persistWorkDisposition(state, operation, '2026-01-01T00:00:00.000Z');
    assert.equal(cp.continuation.armed, false); assert.deepEqual(cp.openWork, ['Preserve the prior task.']);
  }
});

test('continuation explains empty records, blockers, owner decisions and exact wait targets', () => {
  const { state, cp } = stateFor();
  assert.match(continuationFailure(state), /not been revalidated/);
  cp.continuation.armed = true; assert.match(continuationFailure(state), /list is empty/);
  cp.blocker = 'Service unavailable'; assert.match(continuationFailure(state), /Service unavailable/);
  cp.blocker = null; cp.ownerActionRequired = 'Select a destination'; assert.match(continuationFailure(state), /Select a destination/);
  state.operations.push({ id: 'active-operation', status: 'working', request: {} });
  assert.match(continuationFailure(state), /wait --operation-id active-operation --timeout 60/);
});

const context = { project: 'Example project', milestone: null, models: [], defaultModel: null, claude: 'host', values: resolveSettings({}, { workspace: {} }).values };
const answer = (g, ...labels) => Object.fromEntries(g.questions.map((q, i) => [q.question, labels[i]]));
test('common settings are visible, show current assignments and save from two answers', () => {
  const g = startSettingsMenu('', context);
  assert.deepEqual(g.questions[0].options.map(o => o.label), ['Documentation', 'Image review', 'Coding', 'More']);
  assert.match(g.questions[0].question, /Documentation: both/);
  advanceSettingsMenu(g, answer(g, 'Image review'));
  assert.deepEqual(g.questions.map(q => q.header), ['Reviewer', 'Where']);
  assert.ok(!g.questions[1].options.some(o => o.label === 'This milestone'));
  assert.equal(advanceSettingsMenu(g, answer(g, 'Both', 'Whole project')).selection, 'roles.imageReview.executor="both" scope=project');
  validateSettingsMenu(g);
});

test('partial answers and cancel cannot save; Default removes the scoped override', () => {
  const g = startSettingsMenu('docs', context);
  assert.equal(advanceSettingsMenu(g, answer(g, 'Claude')), null);
  assert.equal(g.selection, null); assert.deepEqual(g.flow.draft, {});
  assert.equal(advanceSettingsMenu(g, answer(g, 'Cancel', 'Whole project')).cancelled, true);
  assert.equal(g.selection, null);
  const reset = startSettingsMenu('docs', context);
  assert.equal(advanceSettingsMenu(reset, answer(reset, 'Default', 'Whole project')).selection, 'roles.docs.executor=inherit scope=project');
});

test('Who answers explains its separate responsibility and advanced options remain reachable', () => {
  const g = startSettingsMenu('', context);
  advanceSettingsMenu(g, answer(g, 'More')); advanceSettingsMenu(g, answer(g, 'Who answers'));
  assert.deepEqual(g.questions.map(q => q.header), ['Who answers', 'Where']);
  assert.match(g.questions[0].question, /does not change/);
  const advanced = startSettingsMenu('', context);
  for (const pick of ['More', 'Advanced', 'Task models', 'Documentation']) advanceSettingsMenu(advanced, answer(advanced, pick));
  assert.equal(advanced.flow.stage, 'taskModels'); assert.equal(advanced.flow.task, 'docs');
  validateSettingsMenu(advanced);
});

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-113-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'state'), MODES_HOME: join(dir, 'modes'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') };
  await initializeState(root, env); await registerSession(root, { session_id: 'session' }, env);
  await observeActivity(root, { session_id: 'session', permission_mode: 'default' }, env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
async function execute(f, phase, value = remaining) {
  const thread = () => ({ runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'synthetic-thread' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(review(phase, value)) } };
    yield { type: 'turn.completed' };
  })() }) });
  return runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex: async () => ({ startThread: thread, resumeThread: thread, fabexHelperServers: { warning: advisory } }) }, f.env);
}
async function cycle(f, text, claude = remaining, codex = remaining) {
  const input = { session_id: 'session', prompt: text };
  await recordOwnerPromptEvidence(f.root, input, f.env);
  const entry = await captureOwnerDelivery(f.root, input, (await readState(f.root, f.env)).state, f.env);
  await dispatchOwnerDeliveries(f.root, 'session', f.env, { spawnRunner: false });
  await sealReading(f.root, entry.id, 'Independent synthetic assessment.', f.env);
  await execute(f, 'independent');
  const second = await submitOperation(f.root, reconciliationEnvelope(entry.id, text, 'Reconciled synthetic assessment.', claude), f.env, { spawnRunner: false });
  await execute(f, 'reconcile', codex);
  return second.operationId;
}

test('controller persists both dispositions and continues without manual checkpoint commands', async t => {
  const f = await fixture(t), id = await cycle(f, 'Implement the approved change.');
  const state = (await readState(f.root, f.env)).state;
  assert.deepEqual(state.partner.thread.checkpoint.openWork, remaining.remainingWork);
  assert.equal(state.partner.thread.checkpoint.continuation.armed, true);
  assert.deepEqual(deliveryObligations(await ownerDeliveries(f.root, f.env), state, 'session'), []);
  const next = await continueOperation(f.root, id, f.env, { spawnRunner: false });
  assert.equal((await continueOperation(f.root, id, f.env, { spawnRunner: false })).operationId, next.operationId);
  await execute(f, 'reconcile');
});

test('new owner instructions pause work; reconciled cancellation clears it and older results cannot resume', async t => {
  const f = await fixture(t), first = await cycle(f, 'Implement the approved change.');
  await recordOwnerPromptEvidence(f.root, { session_id: 'session', prompt: 'Cancel the remaining task.' }, f.env);
  assert.equal((await readState(f.root, f.env)).state.partner.thread.checkpoint.continuation.armed, false);
  assert.deepEqual((await readState(f.root, f.env)).state.partner.thread.checkpoint.openWork, remaining.remainingWork);
  await assert.rejects(continueOperation(f.root, first, f.env, { spawnRunner: false }), /newer owner message/);
  await cycle(f, 'Cancel the remaining task.', { ...done, reason: 'Owner cancelled the task.' }, { ...done, reason: 'Owner cancelled the task.' });
  assert.deepEqual((await readState(f.root, f.env)).state.partner.thread.checkpoint.openWork, []);
});

test('missing disposition blocks Stop with an existing-operation recovery command', async t => {
  const f = await fixture(t), id = await cycle(f, 'Implement the approved change.', remaining, null);
  const current = await readState(f.root, f.env);
  assert.equal(current.state.partner.thread.checkpoint.continuation.armed, false);
  const decision = stopDecision({ session_id: 'session' }, current, await ownerDeliveries(f.root, f.env));
  assert.equal(decision.decision, 'block'); assert.ok(decision.reason.includes(`continue --operation-id ${id} --disposition`));
  await continueOperation(f.root, id, f.env, { spawnRunner: false, workDisposition: remaining });
  await execute(f, 'reconcile');
  assert.equal((await readState(f.root, f.env)).state.partner.thread.checkpoint.continuation.armed, true);
});


test('question-only null is explicit; omitted fields remain missing bookkeeping', () => {
  const body = { phase: 'reconcile', phase1OperationId: '00000000-0000-4000-8000-000000000000', ownerMessage: 'Explain the result.', fableResponse: 'Explanation only.' };
  assert.equal(normalizeSubmissionEnvelope(JSON.stringify({ ...body, workDisposition: null }), 'both').workDisposition, null);
  assert.equal(normalizeSubmissionEnvelope(JSON.stringify(body), 'both').workDisposition, undefined);
  assert.equal(dispositionProblem(null, null), null);
  for (const pair of [[undefined, undefined], [undefined, null], [null, undefined], [null, remaining]]) assert.match(dispositionProblem(...pair), /requires reconciliation/);
  const { state, operation, cp } = stateFor();
  delete operation.request.workDisposition;
  operation.result.structured.workDisposition = null;
  cp.openWork = ['Preserve authorized work.'];
  assert.match(persistWorkDisposition(state, operation, '2026-01-01T00:00:00.000Z'), /Claude/);
  assert.deepEqual(cp.openWork, ['Preserve authorized work.']);
  assert.equal(cp.continuation.armed, false);
});

test('discussion and ask-only reconciliations never require a task disposition or alter the checkpoint', () => {
  for (const route of ['discussion', 'ask-once']) {
    const { state, operation, cp } = stateFor();
    state.route = route; operation.request.route = route;
    delete operation.request.workDisposition; delete operation.result.structured.workDisposition;
    cp.openWork = ['Retain the existing task.'];
    cp.blocker = 'An existing prerequisite is unavailable.';
    const before = structuredClone(cp);
    assert.equal(persistWorkDisposition(state, operation, '2026-01-01T00:00:00.000Z'), null);
    assert.deepEqual(cp, before);
  }
});

test('question-only review preserves genuine blockers and owner decisions', () => {
  for (const field of ['blocker', 'ownerActionRequired']) {
    const { state, operation, cp } = stateFor(null, null);
    cp.openWork = ['Existing task.']; cp[field] = 'An existing prerequisite remains.';
    const before = structuredClone(cp);
    assert.equal(persistWorkDisposition(state, operation, '2026-01-01T00:00:00.000Z'), null);
    assert.equal(cp.continuation.armed, false);
    assert.equal(cp[field], before[field]); assert.deepEqual(cp.openWork, before.openWork);
    assert.deepEqual(cp.fieldUpdatedAt, before.fieldUpdatedAt);
  }
});

test('question-only work-mode cycle can finish without a task disposition or invented work', async t => {
  const f = await fixture(t);
  const id = await cycle(f, 'Explain the current design without changing it.', null, null);
  const current = await readState(f.root, f.env);
  const op = current.state.operations.find(op => op.id === id);
  assert.equal(blockingReviewWarning(op), null);
  assert.deepEqual(current.state.partner.thread.checkpoint.openWork, []);
  assert.equal(current.state.partner.thread.checkpoint.continuation.armed, false);
  const reply = current.state.operations.filter(op => op.result.relay?.status === 'pending').map(op => relayBlock(op)).join('\n');
  assert.equal(stopDecision({ session_id: 'session', last_assistant_message: reply }, current, await ownerDeliveries(f.root, f.env)).decision, undefined);
});

test('a progress question preserves authorized work and resumes it after both reviews', async t => {
  const f = await fixture(t);
  await cycle(f, 'Implement the approved change.');
  const before = (await readState(f.root, f.env)).state.partner.thread.checkpoint;
  const id = await cycle(f, 'What is the current progress?', null, null);
  const current = (await readState(f.root, f.env)).state;
  assert.deepEqual(current.partner.thread.checkpoint.openWork, before.openWork);
  assert.deepEqual(current.partner.thread.checkpoint.fieldUpdatedAt, before.fieldUpdatedAt);
  assert.equal(current.partner.thread.checkpoint.continuation.armed, true);
  const next = await continueOperation(f.root, id, f.env, { spawnRunner: false });
  const queued = (await readState(f.root, f.env)).state.operations.find(op => op.id === next.operationId);
  assert.deepEqual(queued.request.workDisposition.remainingWork, before.openWork);
  assert.equal(queued.request.workDisposition.status, 'remaining');
  await execute(f, 'reconcile');
});


test('legacy mode-grant session evidence rearms only an empty workspace registry', () => {
  function legacy() {
    const fixture = stateFor();
    fixture.state.workspace.activeSessionId = null;
    fixture.state.workspace.sessions = {};
    fixture.state.contextEvidence.ownerPrompt.sessionId = 'session';
    const parent = fixture.state.operations[0];
    parent.request.ownerMessageDigest = fixture.operation.request.ownerMessageDigest;
    parent.result = { relay: { sessionId: 'session' } };
    return fixture;
  }
  const { state, operation, cp } = legacy();
  assert.equal(reviewSessionMatches(state, operation), true);
  assert.equal(persistWorkDisposition(state, operation, '2026-01-01T00:00:00.000Z'), null);
  assert.equal(cp.continuation.armed, true);
  assert.deepEqual(cp.openWork, remaining.remainingWork);
  assert.equal(state.workspace.activeSessionId, null, 'compatibility does not create or select another conversation');
  assert.deepEqual(state.workspace.sessions, {});

  for (const change of [
    s => { s.workspace.activeSessionId = 'other-session'; },
    s => { s.workspace.sessions['other-session'] = {}; },
    s => { s.workspace.sessions.session = {}; },
    s => { s.contextEvidence.ownerPrompt = null; },
    s => { s.contextEvidence.ownerPrompt.sessionId = 'other-session'; },
    s => { s.contextEvidence.ownerPrompt.digest = 'b'.repeat(64); },
    s => { s.operations[0].result.relay.sessionId = 'other-session'; },
    s => { s.operations[0].request.ownerMessageDigest = 'b'.repeat(64); },
    s => { s.operations[0].request.interrupted = true; },
    s => { s.operations[0].status = 'failed'; },
    s => { s.operations.at(-1).result.relay.sessionId = ''; }
  ]) {
    const denied = legacy();
    denied.cp.openWork = ['Retain the existing work.'];
    denied.cp.continuation.armed = true;
    change(denied.state);
    assert.equal(reviewSessionMatches(denied.state, denied.operation), false);
    persistWorkDisposition(denied.state, denied.operation, '2026-01-01T00:00:00.000Z');
    assert.equal(denied.cp.continuation.armed, false);
    assert.deepEqual(denied.cp.openWork, ['Retain the existing work.']);
  }
});
