import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { registerSession, sealReading, selectTaskRole } from '../../scripts/lib/workspace.mjs';
import { observeActivity } from '../../scripts/lib/activity.mjs';
import { recordOwnerPromptEvidence } from '../../scripts/lib/hook-evidence.mjs';
import { captureOwnerDelivery, deliveryObligations, ownerDeliveries, syncOwnerDeliveries, updateOwnerDelivery, abandonMissingDelivery } from '../../scripts/lib/owner-delivery.mjs';
import { dispatchOwnerDeliveries, submitOperation, reconciliationEnvelope, claimNextOperation, runOperation, continueOperation } from '../../scripts/lib/sdk-controller.mjs';
import { supersedingDisposition } from '../../scripts/lib/work-disposition.mjs';
import { relayBlock } from '../../scripts/lib/review.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';

const remaining = { status: 'remaining', remainingWork: ['Review the approved document.'], reason: 'The document still needs review.' };
const done = { status: 'done', remainingWork: [], reason: 'The requested document is complete.' };
const review = (phase, value) => ({ scopeMismatch: null, parityConcern: null, answer: 'Reviewed.', ownerSummary: 'Reviewed.', evidence: [], assumptions: [], uncertainties: [], ...(phase === 'reconcile' ? { disagreements: [], workDisposition: value } : {}), recommendation: null, changedFiles: [], tests: [] });

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1131-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'state'), MODES_HOME: join(dir, 'modes'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), AI_USAGE_TRACKER_DATA: join(dir, 'usage') };
  await initializeState(root, env);
  await registerSession(root, { session_id: 'session' }, env);
  await observeActivity(root, { session_id: 'session', permission_mode: 'default' }, env);
  await selectTaskRole(root, 'docs', env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
async function execute(f, phase, value = remaining) {
  const thread = () => ({ runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'synthetic-thread' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(review(phase, value)) } };
    yield { type: 'turn.completed' };
  })() }) });
  return runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex: async () => ({ startThread: thread, resumeThread: thread }) }, f.env);
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

test('older disposition conflict, newer review, continue and documentation write recover without losing the audit trail', async t => {
  const f = await fixture(t);
  const old = await cycle(f, 'Prepare the approved document.', remaining, done);
  const before = (await readState(f.root, f.env)).state;
  const conflict = before.operations.find(op => op.id === old);
  const denial = await guard(f);
  assert.equal(denial.decision, 'defer', 'conflicting bookkeeping does not lock assigned documentation');
  const latest = await cycle(f, 'Continue with the agreed document review.');
  let current = await readState(f.root, f.env);
  let entries = await ownerDeliveries(f.root, f.env);
  assert.deepEqual(deliveryObligations(entries, current.state, 'session'), []);
  const receipt = entries.find(entry => entry.id === conflict.request.parentOperationId);
  assert.equal(receipt.dispositionResolution.reviewId, latest);
  assert.equal(receipt.dispositionResolution.conflictId, old);
  assert.equal(current.state.operations.find(op => op.id === old).result.warning, conflict.result.warning);
  assert.deepEqual(current.state.partner.thread.checkpoint.openWork, remaining.remainingWork);
  assert.equal(current.state.partner.thread.checkpoint.continuation.armed, true);
  const stopping = stopDecision(stopInput(current.state), current, entries);
  assert.match(stopping.reason, /Continue authorized feasible work/);
  assert.ok(stopping.reason.includes(latest));
  await continueOperation(f.root, latest, f.env, { spawnRunner: false });
  assert.equal((await guard(f)).decision, 'deny', 'a queued partner review still gates writes');
  await execute(f, 'reconcile');
  assert.equal((await guard(f)).decision, 'defer');
  // A question does not resurrect a conflict that was already resolved.
  await cycle(f, 'What is the current progress?', null, null);
  current = await readState(f.root, f.env); entries = await ownerDeliveries(f.root, f.env);
  assert.deepEqual(deliveryObligations(entries, current.state, 'session'), []);
  assert.deepEqual(current.state.partner.thread.checkpoint.openWork, remaining.remainingWork);
  assert.equal((await guard(f)).decision, 'defer');
  const failed = structuredClone(current.state);
  failed.operations.find(op => op.id === old).result.warning += '\nUnknown review integrity failure';
  assert.equal(deliveryObligations(entries, failed, 'session').length, 1, 'a receipt cannot hide a different failure');
});

test('a newer explicit done outcome permits Stop; null questions do not resolve earlier conflicts', async t => {
  const f = await fixture(t);
  await cycle(f, 'Prepare the approved document.', remaining, done);
  await cycle(f, 'Explain the current progress only.', null, null);
  let current = await readState(f.root, f.env);
  assert.equal(deliveryObligations(await ownerDeliveries(f.root, f.env), current.state, 'session').length, 1);
  assert.equal((await guard(f)).decision, 'defer', 'unresolved bookkeeping is retained without a tool lock');
  await cycle(f, 'Cancel the remaining document work.', { ...done, reason: 'Owner cancelled the work.' }, { ...done, reason: 'Owner cancelled the work.' });
  current = await readState(f.root, f.env);
  assert.deepEqual(current.state.partner.thread.checkpoint.openWork, []);
  assert.equal(current.state.partner.thread.checkpoint.continuation.armed, false);
  assert.equal(stopDecision(stopInput(current.state), current, await ownerDeliveries(f.root, f.env)).decision, undefined);
});

test('supersession rejects stale, cross-session, cross-thread, cancelled and integrity-failed evidence', async t => {
  const f = await fixture(t), old = await cycle(f, 'Prepare the approved document.', remaining, done);
  const latest = await cycle(f, 'Continue the document review.');
  const base = (await readState(f.root, f.env)).state;
  assert.equal(supersedingDisposition(base, base.operations.find(op => op.id === old)).id, latest);
  for (const change of [
    (s, o, n) => { n.result.warning = 'Unknown review integrity failure'; },
    (s, o) => { o.result.warning += '\nStructured review unavailable'; },
    (s, o, n) => { n.result.relay.sessionId = 'other'; },
    (s, o, n) => { n.externalId = 'other-thread'; },
    (s, o, n) => { n.lifecycle.cancelRequested = true; },
    s => { s.contextEvidence.ownerPrompt.digest = 'f'.repeat(64); },
    s => { s.route = 'discussion'; },
    (s, o, n) => { delete n.request.workDisposition; },
    (s, o, n) => { n.request.workDisposition = null; n.result.structured.workDisposition = null; },
    (s, o) => { o.request.workDisposition = { ...remaining, status: 'owner-decision' }; },
    (s, o) => { o.request.workDisposition = { ...remaining, status: 'blocked' }; }
  ]) {
    const s = structuredClone(base), o = s.operations.find(op => op.id === old), n = s.operations.find(op => op.id === latest);
    change(s, o, n);
    assert.equal(supersedingDisposition(s, o), null);
  }
});

test('newer blocked and owner-decision outcomes resolve bookkeeping without resuming work', async t => {
  for (const status of ['blocked', 'owner-decision']) {
    const f = await fixture(t);
    await cycle(f, 'Prepare the approved document.', remaining, done);
    const value = { ...remaining, status, reason: status === 'blocked' ? 'Required service is unavailable.' : 'Owner must choose the destination.' };
    const latest = await cycle(f, 'Review the remaining prerequisites.', value, value);
    const current = (await readState(f.root, f.env)).state;
    assert.deepEqual(deliveryObligations(await ownerDeliveries(f.root, f.env), current, 'session'), []);
    assert.equal(current.partner.thread.checkpoint.continuation.armed, false);
    assert.equal(current.partner.thread.checkpoint[status === 'blocked' ? 'blocker' : 'ownerActionRequired'], value.reason);
    await assert.rejects(continueOperation(f.root, latest, f.env, { spawnRunner: false }), /Work is blocked|Owner decision required/);
  }
});

test('failure journal keeps its reason so reported, pruned failures do not become pending again', async t => {
  const f = await fixture(t), old = await cycle(f, 'Prepare the approved document.', remaining, done);
  let current = (await readState(f.root, f.env)).state;
  const parent = current.operations.find(op => op.id === old).request.parentOperationId;
  let entry = (await ownerDeliveries(f.root, f.env)).find(e => e.id === parent);
  assert.equal(entry.status, 'failed'); assert.match(entry.error, /different outcomes/);
  await updateOwnerDelivery(f.root, parent, { failureReportedAt: '2026-01-01T00:00:00.000Z' }, f.env);
  await updateState(f.root, s => { s.operations = s.operations.filter(op => op.id !== old && op.id !== parent); s.generation++; return s; }, {}, f.env);
  current = (await readState(f.root, f.env)).state;
  await syncOwnerDeliveries(f.root, current, f.env);
  assert.deepEqual(deliveryObligations(await ownerDeliveries(f.root, f.env), current, 'session'), []);
  // Compatibility with older journals that lost the error while pruning.
  await updateOwnerDelivery(f.root, parent, { status: 'assessed', error: null }, f.env);
  assert.deepEqual(deliveryObligations(await ownerDeliveries(f.root, f.env), current, 'session'), []);
});

test('unreported missing operations require explicit recovery, keep the task, and reject another session', async t => {
  const f = await fixture(t);
  await cycle(f, 'Prepare the approved document.');
  const current = (await readState(f.root, f.env)).state;
  const entry = await captureOwnerDelivery(f.root, { session_id: 'session', prompt: 'Inspect the pending work.' }, current, f.env);
  await updateOwnerDelivery(f.root, entry.id, { status: 'assessed' }, f.env);
  const obligations = deliveryObligations(await ownerDeliveries(f.root, f.env), current, 'session');
  assert.equal(obligations.length, 1);
  assert.ok(obligations[0].nextAction.includes(`recover abandon --operation-id ${entry.id}`));
  assert.equal(await abandonMissingDelivery(f.root, { ...current, workspace: { ...current.workspace, activeSessionId: 'other' } }, entry.id, f.env), false);
  assert.equal(await abandonMissingDelivery(f.root, current, entry.id, f.env), true);
  const interrupted = (await ownerDeliveries(f.root, f.env)).find(e => e.id === entry.id);
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.failureReportedAt, null);
  assert.match(interrupted.error, /task remains unfinished/);
  assert.equal(deliveryObligations(await ownerDeliveries(f.root, f.env), current, 'session').length, 1, 'interruption must still be reported');
  assert.deepEqual((await readState(f.root, f.env)).state.partner.thread.checkpoint.openWork, remaining.remainingWork);
});

test('supported usage controls stay available during review; ordinary tracker command resumes after recovery', async t => {
  const f = await fixture(t);
  await cycle(f, 'Prepare the approved document.', remaining, done);
  const control = resolve('scripts/control.mjs');
  for (const args of ['usage report', 'usage snapshot --event progress']) {
    const input = { command: `node '${control}' ${args}` };
    assert.equal((await guard(f, 'Bash', input)).decision, 'defer');
    assert.equal((await guard(f, 'Bash', input, { sessionId: 'other' })).decision, 'deny');
  }
  const tracker = { command: '/opt/synthetic-usage/track status' };
  const denied = await guard(f, 'Bash', tracker);
  assert.equal(denied.decision, 'defer', 'ordinary usage reads do not wait for disposition recovery');
  await cycle(f, 'Continue the document review.');
  assert.equal((await guard(f, 'Bash', tracker)).decision, 'defer');
});
