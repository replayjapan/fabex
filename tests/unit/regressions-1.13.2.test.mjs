import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { registerSession, sealReading, selectTaskRole } from '../../scripts/lib/workspace.mjs';
import { observeActivity } from '../../scripts/lib/activity.mjs';
import { recordOwnerPromptEvidence } from '../../scripts/lib/hook-evidence.mjs';
import { captureOwnerDelivery, ownerDeliveries, deliveryObligations } from '../../scripts/lib/owner-delivery.mjs';
import { dispatchOwnerDeliveries, submitOperation, reconciliationEnvelope, claimNextOperation, runOperation, continueOperation } from '../../scripts/lib/sdk-controller.mjs';
import { dispositionRepairEligibility } from '../../scripts/lib/work-disposition.mjs';
import { repeatStopDecision, guardStopProgress } from '../../scripts/lib/stop-progress.mjs';
import { relayBlock } from '../../scripts/lib/review.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';

const remaining = { status: 'remaining', remainingWork: ['Review the approved document.'], reason: 'The document still needs review.' };
const done = { status: 'done', remainingWork: [], reason: 'The requested document is complete.' };
const review = (phase, value) => ({ scopeMismatch: null, parityConcern: null, answer: 'Reviewed.', ownerSummary: 'Reviewed.', evidence: ['Synthetic completion receipt inspected.'], assumptions: [], uncertainties: [], ...(phase === 'reconcile' ? { disagreements: [], workDisposition: value } : {}), recommendation: null, changedFiles: [], tests: [] });

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1132-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'state'), MODES_HOME: join(dir, 'modes'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), AI_USAGE_TRACKER_DATA: join(dir, 'usage') };
  await initializeState(root, env);
  await registerSession(root, { session_id: 'session' }, env);
  await observeActivity(root, { session_id: 'session', permission_mode: 'default' }, env);
  await selectTaskRole(root, 'docs', env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
async function execute(f, phase, value = remaining, inspect = () => {}, evidence) {
  const thread = () => ({ runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'synthetic-thread' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ...review(phase, value), ...(evidence ? { evidence } : {}) }) } };
    yield { type: 'turn.completed' };
  })() }) });
  return runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex: async () => ({ startThread: options => { inspect(options); return thread(); }, resumeThread: (id, options) => { inspect(options); return thread(); } }) }, f.env);
}
async function cycle(f, prompt, claude = remaining, codex = remaining) {
  const input = { session_id: 'session', prompt };
  await recordOwnerPromptEvidence(f.root, input, f.env);
  const entry = await captureOwnerDelivery(f.root, input, (await readState(f.root, f.env)).state, f.env);
  await dispatchOwnerDeliveries(f.root, 'session', f.env, { spawnRunner: false });
  await sealReading(f.root, entry.id, 'Independent synthetic assessment.', f.env);
  await execute(f, 'independent');
  const result = await submitOperation(f.root, reconciliationEnvelope(entry.id, prompt, 'Agreed synthetic assessment.', claude), f.env, { spawnRunner: false });
  await execute(f, 'reconcile', codex);
  return result.operationId;
}
async function guard(f, toolName = 'Write', toolInput = { file_path: join(f.root, 'guide.md'), content: 'Product guide.' }, executor = { sessionId: 'session' }) {
  return classifyToolUse({ ...(await readState(f.root, f.env)), toolName, toolInput, executor, config: {}, env: f.env });
}
const stopInput = state => ({ session_id: 'session', last_assistant_message: state.operations.filter(op => op.result.relay?.status === 'pending').map(op => relayBlock(op)).join('\n') });


const ownerDecision = { status: 'owner-decision', remainingWork: ['Await the owner’s prerequisite receipt.'], reason: 'Owner must complete the prerequisite.' };
async function staleRequirement(f) {
  await cycle(f, 'Wait for my prerequisite receipt.', ownerDecision, ownerDecision);
  // Simulate a prerequisite checkpoint from an earlier owner cycle, without a
  // timing-dependent sleep in the test.
  await updateState(f.root, state => {
    state.partner.thread.checkpoint.fieldUpdatedAt.ownerActionRequired = '2000-01-01T00:00:00.000Z';
    state.generation++;
    return state;
  }, {}, f.env);
  return cycle(f, 'The prerequisite is satisfied; finish the approved document.', remaining, done);
}
async function hook(f, input) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/hook-stop.mjs')], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', value => { out += value; });
    child.stderr.on('data', value => { err += value; });
    child.on('error', reject);
    child.on('close', code => { try { assert.equal(code, 0, err); accept(JSON.parse(out)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ ...input, cwd: f.root, hook_event_name: 'Stop' }));
  });
}

test('earlier owner prerequisite plus conflicting outcomes permits only read-only requirement review', async t => {
  const f = await fixture(t), id = await staleRequirement(f);
  let current = await readState(f.root, f.env);
  const entries = await ownerDeliveries(f.root, f.env);
  const source = current.state.operations.find(op => op.id === id);
  assert.equal(dispositionRepairEligibility(current.state, source, deliveryObligations(entries, current.state, 'session')).ok, true);
  const first = stopDecision(stopInput(current.state), current, entries);
  assert.equal(first.decision, 'block'); assert.match(first.reason, /read-only review/);
  assert.equal((await hook(f, stopInput(current.state))).decision, 'block');
  const yielded = await hook(f, { ...stopInput(current.state), stop_hook_active: true });
  assert.equal(yielded.decision, undefined);
  assert.match(yielded.systemMessage, /same check is still unresolved/);
  assert.equal((await readState(f.root, f.env)).state.partner.thread.checkpoint.ownerActionRequired, ownerDecision.reason);
  const next = await continueOperation(f.root, id, f.env, { spawnRunner: false, workDisposition: done });
  current = await readState(f.root, f.env);
  const repair = current.state.operations.find(op => op.id === next.operationId);
  assert.equal(repair.request.sandbox, 'read-only');
  assert.equal(repair.request.requirementReview.requirement, ownerDecision.reason);
  assert.equal(current.state.partner.thread.checkpoint.ownerActionRequired, ownerDecision.reason);
  assert.equal(current.state.partner.thread.checkpoint.continuation.armed, false);
  assert.equal((await guard(f)).decision, 'deny', 'review submission must not unlock writes');
  await execute(f, 'reconcile', done, options => {
    assert.equal(options.sandboxMode, 'read-only'); assert.equal(options.approvalPolicy, 'never');
  });
  current = await readState(f.root, f.env);
  assert.equal(current.state.partner.thread.checkpoint.ownerActionRequired, null);
  assert.deepEqual(current.state.partner.thread.checkpoint.openWork, []);
  assert.equal(current.state.partner.thread.checkpoint.continuation.armed, false);
  assert.equal(stopDecision(stopInput(current.state), current, await ownerDeliveries(f.root, f.env)).decision, undefined);
});

test('requirement review can keep the owner decision and cannot clear it without evidence', async t => {
  for (const evidence of [undefined, []]) {
    const f = await fixture(t), id = await staleRequirement(f);
    await continueOperation(f.root, id, f.env, { spawnRunner: false, workDisposition: done });
    await execute(f, 'reconcile', evidence ? done : ownerDecision, () => {}, evidence);
    const state = (await readState(f.root, f.env)).state;
    assert.equal(state.partner.thread.checkpoint.ownerActionRequired, ownerDecision.reason);
    assert.equal(state.partner.thread.checkpoint.continuation.armed, false);
    assert.match(state.operations.at(-1).result.warning, /Work disposition requires reconciliation/);
  }
});

test('a changed requirement during read-only review is preserved', async t => {
  const f = await fixture(t), id = await staleRequirement(f);
  await continueOperation(f.root, id, f.env, { spawnRunner: false, workDisposition: done });
  await updateState(f.root, state => {
    state.partner.thread.checkpoint.ownerActionRequired = 'Owner must choose the final destination.';
    state.partner.thread.checkpoint.fieldUpdatedAt.ownerActionRequired = new Date().toISOString();
    state.generation++; return state;
  }, {}, f.env);
  await execute(f, 'reconcile', done);
  const state = (await readState(f.root, f.env)).state;
  assert.equal(state.partner.thread.checkpoint.ownerActionRequired, 'Owner must choose the final destination.');
  assert.equal(state.partner.thread.checkpoint.continuation.armed, false);
  assert.match(state.operations.at(-1).result.warning, /requirement changed/);
});

test('a same-cycle owner decision refuses repair and Stop yields the actual requirement', async t => {
  const f = await fixture(t), id = await cycle(f, 'Complete the document.', remaining, done);
  await updateState(f.root, state => {
    const cp = state.partner.thread.checkpoint;
    cp.ownerActionRequired = ownerDecision.reason;
    cp.fieldUpdatedAt.ownerActionRequired = new Date().toISOString();
    state.generation++; return state;
  }, {}, f.env);
  const current = await readState(f.root, f.env);
  for (const workDisposition of [remaining, done, ownerDecision]) {
    await assert.rejects(continueOperation(f.root, id, f.env, { spawnRunner: false, workDisposition }), /Owner decision required/);
  }
  const input = stopInput(current.state);
  const parentId = current.state.operations.find(op => op.id === id).request.parentOperationId;
  input.last_assistant_message += `\nPartner delivery failed for ${parentId}; the owner requirement remains unresolved.`;
  const decision = stopDecision(input, current, await ownerDeliveries(f.root, f.env));
  assert.equal(decision.decision, undefined);
  assert.equal(decision.yielded, true);
  assert.ok(decision.systemMessage.includes(ownerDecision.reason));
});

test('repair eligibility and controller agree on cancellation, newer instructions and genuine blockers', async t => {
  for (const change of [
    (s, o) => { o.lifecycle.cancelRequested = true; },
    (s, o) => { s.operations.find(p => p.id === o.request.parentOperationId).request.interrupted = true; },
    s => { s.contextEvidence.ownerPrompt.digest = 'f'.repeat(64); },
    s => { s.partner.thread.checkpoint.blocker = 'Required receipt is unavailable.'; },
    s => { s.workspace.activeSessionId = null; },
    (s, o) => { o.result.warning += '\nUnknown integrity failure'; }
  ]) {
    const f = await fixture(t), id = await staleRequirement(f);
    await updateState(f.root, s => { change(s, s.operations.find(o => o.id === id)); s.generation++; return s; }, {}, f.env);
    const current = (await readState(f.root, f.env)).state;
    const eligibility = dispositionRepairEligibility(current, current.operations.find(o => o.id === id), deliveryObligations(await ownerDeliveries(f.root, f.env), current, 'session'));
    assert.equal(eligibility.ok, false);
    await assert.rejects(continueOperation(f.root, id, f.env, { spawnRunner: false, workDisposition: done }), error => error.message === eligibility.reason);
  }
  const f = await fixture(t), id = await staleRequirement(f);
  await cycle(f, 'Cancel the document work.', done, done);
  await assert.rejects(continueOperation(f.root, id, f.env, { spawnRunner: false, workDisposition: done }), /newer owner message/);
});

test('repeat fingerprint ignores bookkeeping and unrelated operations but observes the relevant outcome', async t => {
  const f = await fixture(t), id = await staleRequirement(f);
  const current = await readState(f.root, f.env);
  const input = stopInput(current.state), decision = stopDecision(input, current, await ownerDeliveries(f.root, f.env));
  const first = repeatStopDecision(input, decision, current.state);
  assert.equal(first.decision.decision, 'block');
  const changed = structuredClone(current.state);
  changed.generation += 20;
  changed.partner.thread.checkpoint.updatedAt = new Date().toISOString();
  changed.operations.find(op => op.id === id).usage = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0 };
  changed.operations.push({ id: 'unrelated', status: 'completed', request: {} });
  const repeated = repeatStopDecision({ ...input, stop_hook_active: true }, decision, changed, first.fingerprint);
  assert.equal(repeated.decision.yielded, true);
  assert.equal(repeated.fingerprint, first.fingerprint);
  changed.operations.find(op => op.id === id).status = 'working';
  assert.equal(repeatStopDecision({ ...input, stop_hook_active: true }, decision, changed, first.fingerprint).decision.decision, 'block');
  // A fresh owner turn permits a first reminder again, even with the same reason.
  assert.equal(repeatStopDecision(input, decision, current.state, first.fingerprint).decision.decision, 'block');
});

test('persistent repeat guard is session-specific and does not change canonical task state', async t => {
  const f = await fixture(t);
  await staleRequirement(f);
  const current = await readState(f.root, f.env), input = stopInput(current.state);
  const decision = stopDecision(input, current, await ownerDeliveries(f.root, f.env));
  assert.equal((await guardStopProgress(f.root, input, decision, current.state, f.env)).decision, 'block');
  assert.equal((await guardStopProgress(f.root, { ...input, stop_hook_active: true }, decision, current.state, f.env)).yielded, true);
  assert.equal((await guardStopProgress(f.root, { ...input, session_id: 'another', stop_hook_active: true }, decision, current.state, f.env)).decision, 'block');
  assert.deepEqual((await readState(f.root, f.env)).state, current.state);
});

test('yielding a repeated missing-relay block never acknowledges delivery in the real hook entry point', async t => {
  const f = await fixture(t);
  await cycle(f, 'Complete the approved document.', done, done);
  const before = (await readState(f.root, f.env)).state;
  const input = { session_id: 'session', last_assistant_message: 'Waiting for a reply.' };
  const first = await hook(f, input);
  assert.equal(first.decision, 'block'); assert.match(first.reason, /Relay the missing/);
  const second = await hook(f, { ...input, stop_hook_active: true });
  assert.equal(second.decision, undefined); assert.match(second.systemMessage, /undelivered replies remain recorded/);
  assert.equal(Object.hasOwn(second, 'yielded'), false, 'internal metadata is not sent to the host');
  const after = (await readState(f.root, f.env)).state;
  assert.deepEqual(after.operations.map(op => op.result.relay), before.operations.map(op => op.result.relay));
  assert.deepEqual(after.contextEvidence.ownerVisibleReply, before.contextEvidence.ownerVisibleReply);
  const delivered = await hook(f, { ...stopInput(after), stop_hook_active: true });
  assert.equal(delivered.decision, undefined);
  assert.equal((await readState(f.root, f.env)).state.operations.at(-1).result.relay.status, 'delivered');
});

test('failed-delivery and armed-work blocks get one reminder and yield without dropping obligations', async t => {
  const f = await fixture(t);
  await cycle(f, 'Review the approved document.', remaining, remaining);
  const current = await readState(f.root, f.env), input = stopInput(current.state);
  const entries = await ownerDeliveries(f.root, f.env);
  const first = stopDecision(input, current, entries);
  assert.match(first.reason, /Continue authorized feasible work/);
  const saved = structuredClone(current.state);
  const fingerprint = repeatStopDecision(input, first, current.state).fingerprint;
  assert.equal(repeatStopDecision({ ...input, stop_hook_active: true }, first, current.state, fingerprint).decision.yielded, true);
  assert.deepEqual(current.state, saved);
  const failed = structuredClone(current);
  failed.state.operations.at(-1).result.warning = 'Unknown review integrity failure';
  const failure = stopDecision(input, failed, entries);
  assert.match(failure.reason, /Partner delivery failed/);
  const receipt = repeatStopDecision(input, failure, failed.state).fingerprint;
  assert.equal(repeatStopDecision({ ...input, stop_hook_active: true }, failure, failed.state, receipt).decision.yielded, true);
  assert.equal(deliveryObligations(entries, failed.state, 'session').length, 1);
});

test('ineligible repair reports failed delivery and missing relays before yielding', async t => {
  const f = await fixture(t), id = await cycle(f, 'Finish the approved document.', remaining, done);
  await updateState(f.root, state => {
    const cp = state.partner.thread.checkpoint;
    cp.ownerActionRequired = ownerDecision.reason;
    cp.fieldUpdatedAt.ownerActionRequired = new Date().toISOString();
    state.generation++; return state;
  }, {}, f.env);
  const before = (await readState(f.root, f.env)).state;
  const parentId = before.operations.find(op => op.id === id).request.parentOperationId;
  const input = { session_id: 'session', last_assistant_message: 'Waiting for the owner.' };
  const failure = await hook(f, input);
  assert.equal(failure.decision, 'block');
  assert.match(failure.reason, /Partner delivery failed/);
  const report = `Partner delivery failed for ${parentId}; the owner requirement remains unresolved.`;
  const relay = await hook(f, { ...input, stop_hook_active: true, last_assistant_message: report });
  assert.equal(relay.decision, 'block');
  assert.match(relay.reason, /Relay the missing Codex summaries/);
  const paused = await hook(f, { ...stopInput(before), stop_hook_active: true,
    last_assistant_message: `${report}\n${stopInput(before).last_assistant_message}` });
  assert.equal(paused.decision, undefined);
  assert.ok(paused.systemMessage.includes(ownerDecision.reason));
  const after = (await readState(f.root, f.env)).state;
  assert.deepEqual(after.operations.map(op => op.result.relay), before.operations.map(op => op.result.relay));
  assert.equal(after.partner.thread.checkpoint.ownerActionRequired, ownerDecision.reason);
  assert.equal((await ownerDeliveries(f.root, f.env)).find(entry => entry.id === parentId).failureReportedAt ?? null, null);
});

test('repeated Stop never yields during queued or working partner turns, including diagnostic-store failure', async t => {
  const f = await fixture(t), id = await cycle(f, 'Review the approved document.');
  const next = await continueOperation(f.root, id, f.env, { spawnRunner: false });
  for (const status of ['queued', 'working']) {
    if (status === 'working') await claimNextOperation(f.root, f.env);
    const current = await readState(f.root, f.env);
    assert.equal(current.state.operations.find(op => op.id === next.operationId).status, status);
    const input = { ...stopInput(current.state), stop_hook_active: true };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await hook(f, input);
      assert.equal(result.decision, 'block');
      assert.ok(result.reason.includes(next.operationId));
      assert.match(result.reason, /wait --operation-id/);
    }
    assert.equal((await guardStopProgress(f.root, { stop_hook_active: true }, {}, current.state, f.env)).decision, 'block', 'missing session metadata cannot release live work');
    await writeFile(join(current.paths.projectDir, 'stop-progress.json'), 'invalid diagnostic data', { mode: 0o600 });
    const failure = await hook(f, input);
    assert.equal(failure.decision, 'block', 'diagnostic persistence failure cannot release live work');
    assert.ok(failure.reason.includes(next.operationId));
  }
});

test('a new continuation in the same owner cycle counts as progress even when the reminder names its predecessor', async t => {
  const f = await fixture(t), id = await cycle(f, 'Review the approved document.');
  const before = await readState(f.root, f.env), input = { ...stopInput(before.state), stop_hook_active: true };
  const reminder = stopDecision(input, before, await ownerDeliveries(f.root, f.env));
  assert.match(reminder.reason, /Continue authorized feasible work/);
  const oldFingerprint = repeatStopDecision(input, reminder, before.state).fingerprint;
  await continueOperation(f.root, id, f.env, { spawnRunner: false });
  const queued = (await readState(f.root, f.env)).state;
  const progressed = repeatStopDecision(input, reminder, queued, oldFingerprint);
  assert.notEqual(progressed.fingerprint, oldFingerprint);
  assert.equal(progressed.decision.decision, 'block');
  await execute(f, 'reconcile');
  const completed = (await readState(f.root, f.env)).state;
  const reviewed = repeatStopDecision(input, reminder, completed, progressed.fingerprint);
  assert.notEqual(reviewed.fingerprint, progressed.fingerprint);
  assert.equal(reviewed.decision.decision, 'block');
  completed.generation++;
  completed.operations.at(-1).usage = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0 };
  assert.equal(repeatStopDecision(input, reminder, completed, reviewed.fingerprint).decision.yielded, true, 'only the subsequent unchanged condition yields');
});
