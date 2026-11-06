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
import { relayBlock, missingRelays, reviewSchema, validReview, parseReview } from '../../scripts/lib/review.mjs';
import { stopNoticesOnce, applyStopReminder } from '../../scripts/lib/delivery-feedback.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';
import { classifyToolUse, parseControllerCommand } from '../../scripts/hook-route-guard.mjs';

const remaining = { status: 'remaining', remainingWork: ['Review the approved document.'], reason: 'The document still needs review.' };
const done = { status: 'done', remainingWork: [], reason: 'The requested document is complete.' };
const review = (phase, value) => ({ scopeMismatch: null, parityConcern: null, answer: 'Reviewed.', ownerSummary: 'Reviewed.', evidence: ['Synthetic completion receipt inspected.'], assumptions: [], uncertainties: [], ...(phase === 'reconcile' ? { disagreements: [], workDisposition: value } : {}), recommendation: null, changedFiles: [], tests: [] });

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-114-'))), root = join(dir, 'project');
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


test('complete long answers and flags validate without ownerSummary or content caps', () => {
  const value = review('reconcile', done);
  delete value.ownerSummary;
  value.answer = 'Detailed owner-facing explanation.\n'.repeat(2500);
  value.uncertainties = ['A detailed qualification. '.repeat(200)];
  assert.equal(reviewSchema('reconcile').required.includes('ownerSummary'), false);
  assert.equal(validReview(value, 'reconcile', { allowLegacy: false }), true);
  assert.equal(parseReview(JSON.stringify(value), 'reconcile').finalResponse, value.answer);
  const op = { request: { phase: 'reconcile' }, result: { finalResponse: value.answer, structured: { ...value, ownerSummary: 'Legacy summary.' }, relay: { label: 'Codex (Astra):' }, warning: null } };
  const output = relayBlock(op);
  assert.ok(output.includes(value.answer)); assert.ok(output.includes(value.uncertainties[0]));
  assert.ok(!output.includes('Legacy summary.'));
  assert.equal(relayBlock(op, { full: true }), output);
});

test('every unread phase remains pending until its complete answer and flags are visible', async t => {
  const f = await fixture(t);
  await cycle(f, 'Review the document.', done, done);
  await updateState(f.root, state => {
    state.operations.forEach((op, i) => {
      op.result.finalResponse = `Complete distinct answer ${i}.`;
      op.result.structured.answer = op.result.finalResponse;
      op.result.structured.uncertainties = [`Qualification ${i}.`];
    });
    state.generation++; return state;
  }, {}, f.env);
  const current = await readState(f.root, f.env), [parent, child] = current.state.operations;
  assert.deepEqual(missingRelays(current.state, { session_id: 'session', last_assistant_message: relayBlock(child) }).map(op => op.id), [parent.id]);
  assert.equal(missingRelays(current.state, { session_id: 'session', last_assistant_message: `${parent.result.relay.label}\n${parent.result.finalResponse}` }).length, 2, 'flags also reach the owner');
  const first = await hook(f, { session_id: 'session', last_assistant_message: relayBlock(child) });
  assert.equal(first.decision, 'block');
  let after = (await readState(f.root, f.env)).state;
  assert.equal(after.operations[0].result.relay.status, 'pending');
  assert.equal(after.operations[1].result.relay.status, 'delivered');
  await hook(f, { session_id: 'session', last_assistant_message: relayBlock(parent) });
  after = (await readState(f.root, f.env)).state;
  assert.ok(after.operations.every(op => op.result.relay.status === 'delivered'));
});

test('five unread answers and two interrupted records never trap Stop or external preparation', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await cycle(f, `Review synthetic document ${i}.`, done, done);
  await updateState(f.root, state => {
    state.operations.forEach((op, i) => {
      op.result.finalResponse = `Unabridged answer ${i}. ` + 'Detail. '.repeat(500);
      op.result.structured.answer = op.result.finalResponse;
    });
    state.operations[0].result.relay.status = 'delivered';
    state.generation++; return state;
  }, {}, f.env);
  // Missing retained operations model interrupted delivery without any private incident data.
  for (let i = 0; i < 2; i++) await captureOwnerDelivery(f.root, { session_id: 'session', prompt: `Synthetic interrupted request ${i}.` }, (await readState(f.root, f.env)).state, f.env);
  const before = await readState(f.root, f.env);
  for (let i = 0; i < 3; i++) {
    const result = await hook(f, { session_id: 'session', last_assistant_message: 'Other authorized work can proceed.', stop_hook_active: i > 0 });
    assert.equal(result.decision, i === 0 ? 'block' : undefined);
    if (i > 0) assert.equal(result.systemMessage, undefined, 'unchanged reminders are not repeated');
  }
  const after = await readState(f.root, f.env);
  assert.deepEqual(after.state.operations.map(op => op.result.relay), before.state.operations.map(op => op.result.relay));
  assert.equal((await guard(f, 'Bash', { command: `cp guide.md '${join(f.root, '..', 'private-copy.md')}'` })).decision, 'defer');
});

test('disposition conflict becomes a notice and cannot erase an owner requirement', async t => {
  const f = await fixture(t), id = await staleRequirement(f);
  const before = (await readState(f.root, f.env)).state;
  const result = await hook(f, { session_id: 'session', ...stopInput(before) });
  assert.equal(result.decision, undefined);
  assert.match(result.systemMessage, /work records need reconciliation/);
  const after = (await readState(f.root, f.env)).state;
  assert.equal(after.partner.thread.checkpoint.ownerActionRequired, ownerDecision.reason);
  assert.equal(after.partner.thread.checkpoint.continuation.armed, false);
  assert.ok(after.operations.every(op => op.result.relay.status === 'delivered'), 'the supplied complete visible answers are acknowledged');
  assert.deepEqual(after.operations.map(op => op.result.finalResponse), before.operations.map(op => op.result.finalResponse));
  assert.deepEqual(after.operations.map(op => op.result.structured?.workDisposition), before.operations.map(op => op.result.structured?.workDisposition), 'delivery does not resolve the disagreement');
  assert.equal(dispositionRepairEligibility(after, after.operations.find(op => op.id === id), []).ok, true);
});

test('pending read-only reviews allow assigned documentation, reads and private copies', async t => {
  const f = await fixture(t);
  const input = { session_id: 'session', prompt: 'Review the authorized documentation.' };
  await recordOwnerPromptEvidence(f.root, input, f.env);
  const entry = await captureOwnerDelivery(f.root, input, (await readState(f.root, f.env)).state, f.env);
  await dispatchOwnerDeliveries(f.root, 'session', f.env, { spawnRunner: false });
  await sealReading(f.root, entry.id, 'Independent assessment.', f.env);
  assert.equal((await guard(f)).decision, 'defer');
  for (const command of ['rg example .', 'git status', `cp guide.md '${join(f.root, '..', 'snapshot.md')}'`, `node -e 'require("fs").writeFileSync("${join(f.root, '..', 'scratch.txt')}", "sample")'`]) {
    assert.equal((await guard(f, 'Bash', { command })).decision, 'defer', command);
  }
  const current = await readState(f.root, f.env);
  assert.equal(stopDecision({ session_id: 'session', stop_hook_active: true }, current).decision, 'block', 'active work is still awaited');
});

test('writable partner turn blocks overlapping project edits but not external preparation', async t => {
  const f = await fixture(t), id = await cycle(f, 'Write the approved documentation.', remaining, remaining);
  await continueOperation(f.root, id, f.env, { spawnRunner: false });
  assert.equal((await guard(f)).decision, 'deny');
  assert.equal((await guard(f, 'Read', { file_path: join(f.root, 'guide.md') })).decision, 'defer');
  assert.equal((await guard(f, 'Write', { file_path: join(f.root, '..', 'scratch.txt'), content: 'Private preparation.' })).decision, 'defer');
  assert.equal((await guard(f, 'Bash', { command: `cp guide.md '${join(f.root, '..', 'snapshot.md')}'` })).decision, 'defer');
  assert.equal((await guard(f, 'Bash', { command: 'git pull' })).decision, 'deny');
});

test('delivery notices are once per condition and never acknowledge an answer', async t => {
  const f = await fixture(t), notices = [{ key: 'unread:synthetic', message: 'Unread answer retained.' }];
  const before = await readState(f.root, f.env);
  assert.equal(await stopNoticesOnce(f.root, 'session', notices, f.env), notices[0].message);
  assert.equal(await stopNoticesOnce(f.root, 'session', notices, f.env), null);
  assert.deepEqual((await readState(f.root, f.env)).state, before.state);
});

test('controller retains a long SDK answer without truncation', async t => {
  const f = await fixture(t);
  const input = { session_id: 'session', prompt: 'Explain the synthetic design.' };
  await recordOwnerPromptEvidence(f.root, input, f.env);
  const entry = await captureOwnerDelivery(f.root, input, (await readState(f.root, f.env)).state, f.env);
  await dispatchOwnerDeliveries(f.root, 'session', f.env, { spawnRunner: false });
  await sealReading(f.root, entry.id, 'Independent design assessment.', f.env);
  const value = review('independent'); delete value.ownerSummary;
  value.answer = 'Full explanation.\n'.repeat(4000);
  const thread = { runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'synthetic-thread' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } };
    yield { type: 'turn.completed' };
  })() }) };
  await runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex: async () => ({ startThread: () => thread, resumeThread: () => thread }) }, f.env);
  const result = (await readState(f.root, f.env)).state.operations.at(-1).result;
  assert.equal(result.finalResponse, value.answer);
  assert.equal(result.structured.answer, value.answer);
  assert.ok(!result.warning?.includes('truncated'));
});

test('short quoted heredocs parse without weakening envelope and session validation', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(parseControllerCommand(`node '${resolve('scripts/controller.mjs')}' seal --operation-id ${id} <<'END'\nIndependent assessment.\nEND`).kind, 'controller-seal');
  assert.equal(parseControllerCommand(`node '${resolve('scripts/controller.mjs')}' seal --operation-id ${id} <<'END'\nIndependent assessment.\nOTHER`), null);
});

test('application authorship, Discussion and deployment restrictions remain action-specific', async t => {
  const f = await fixture(t);
  assert.equal((await guard(f, 'Write', { file_path: join(f.root, 'app.js'), content: 'export default 1;' })).decision, 'deny');
  assert.equal((await guard(f, 'Bash', { command: 'vercel --prod' })).decision, 'deny');
  await observeActivity(f.root, { session_id: 'session', permission_mode: 'plan' }, f.env);
  assert.equal((await guard(f, 'Write', { file_path: join(f.root, 'app.js'), content: 'export default 1;' })).decision, 'deny');
  assert.equal((await guard(f, 'Bash', { command: 'rg example .' })).decision, 'defer');
});

test('an older unreconciled record does not prevent a newer owner message from being assessed', async t => {
  const f = await fixture(t);
  for (const prompt of ['Review the first document.', 'Stop that task; answer this new question.']) {
    const input = { session_id: 'session', prompt };
    await recordOwnerPromptEvidence(f.root, input, f.env);
    const entry = await captureOwnerDelivery(f.root, input, (await readState(f.root, f.env)).state, f.env);
    await dispatchOwnerDeliveries(f.root, 'session', f.env, { spawnRunner: false });
    await sealReading(f.root, entry.id, 'Independent assessment of this owner instruction.', f.env);
    const claimed = await claimNextOperation(f.root, f.env);
    assert.equal(claimed.id, entry.id);
    const value = review('independent');
    const thread = { runStreamed: async () => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'synthetic-thread' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } };
      yield { type: 'turn.completed' };
    })() }) };
    await runOperation(f.root, claimed, { createCodex: async () => ({ startThread: () => thread, resumeThread: () => thread }) }, f.env);
  }
  const state = (await readState(f.root, f.env)).state;
  assert.equal(state.operations.length, 2);
  assert.ok(state.operations.every(op => op.status === 'completed' && op.result.relay.status === 'pending'));
  assert.equal(state.partner.thread.checkpoint.continuation.armed, false, 'new instructions do not silently rearm the old task');
  const latest = state.operations.at(-1);
  const next = await submitOperation(f.root, reconciliationEnvelope(latest.id, latest.request.ownerMessage, 'Answer the new question only.', null), f.env, { spawnRunner: false });
  const claimed = await claimNextOperation(f.root, f.env);
  assert.equal(claimed.id, next.operationId, 'the older record cannot block the newly reviewed message’s Phase 2');
});


test('Phase 2 gap receives one recovery prompt even after unrelated bookkeeping and repeated Stop calls', async t => {
  const f = await fixture(t), prompt = 'Assess the document without changing it.';
  const entry = await captureOwnerDelivery(f.root, { session_id: 'session', prompt }, (await readState(f.root, f.env)).state, f.env);
  await dispatchOwnerDeliveries(f.root, 'session', f.env, { spawnRunner: false });
  await sealReading(f.root, entry.id, 'Independent assessment.', f.env);
  await execute(f, 'independent');
  const before = (await readState(f.root, f.env)).state;
  const input = stopInput(before);
  const first = await hook(f, input);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /existing Phase 2 review/);
  assert.doesNotMatch(first.systemMessage ?? '', /controller\.mjs|Resume|Deliver|Preserve/);
  await updateState(f.root, state => { state.generation++; return state; }, {}, f.env);
  for (const stop_hook_active of [true, false, true]) {
    const next = await hook(f, { ...input, stop_hook_active });
    assert.equal(next.decision, undefined, 'the same missing Phase 2 never blocks again');
  }
  const after = (await readState(f.root, f.env)).state;
  assert.equal(after.operations[0].status, 'completed');
  assert.equal(after.operations[0].request.interrupted, false);
  assert.equal(after.operations.length, 1, 'yielding did not fabricate reconciliation');
});

test('recovery reminder receipts survive bookkeeping changes and are isolated by session and pending set', async t => {
  const f = await fixture(t);
  const decision = { reminder: { key: 'unread:first', reason: 'Include the existing full answer.' } };
  assert.equal((await applyStopReminder(f.root, 'session', decision, f.env)).decision, 'block');
  assert.equal((await applyStopReminder(f.root, 'session', decision, f.env)).decision, undefined);
  assert.equal((await applyStopReminder(f.root, 'other', decision, f.env)).decision, 'block');
  assert.equal((await applyStopReminder(f.root, 'session', { reminder: { ...decision.reminder, key: 'unread:first,second' } }, f.env)).decision, 'block');
  const before = (await readState(f.root, f.env)).state;
  await updateState(f.root, state => { state.generation++; return state; }, {}, f.env);
  assert.equal((await applyStopReminder(f.root, 'session', decision, f.env)).decision, undefined);
  assert.deepEqual((await readState(f.root, f.env)).state.operations, before.operations);
});

test('unread reminder storage failure yields without acknowledging delivery', async t => {
  const f = await fixture(t);
  await cycle(f, 'Finish the document.', done, done);
  const current = await readState(f.root, f.env);
  await writeFile(join(current.paths.projectDir, 'delivery-feedback.json'), '{invalid');
  const output = await hook(f, { session_id: 'session', last_assistant_message: 'Other work.', stop_hook_active: true });
  assert.equal(output.decision, undefined);
  assert.ok((await readState(f.root, f.env)).state.operations.every(op => op.result.relay.status === 'pending'));
});


test('a queued cycle behind a Phase 2 gap gets one recovery prompt instead of an endless wait', async t => {
  const f = await fixture(t), entries = [];
  for (const prompt of ['First document review.', 'Second document review.']) {
    const input = { session_id: 'session', prompt };
    await recordOwnerPromptEvidence(f.root, input, f.env);
    const entry = await captureOwnerDelivery(f.root, input, (await readState(f.root, f.env)).state, f.env);
    entries.push(entry);
    await dispatchOwnerDeliveries(f.root, 'session', f.env, { spawnRunner: false });
    await sealReading(f.root, entry.id, 'Independent assessment.', f.env);
  }
  await execute(f, 'independent');
  assert.equal(await claimNextOperation(f.root, f.env), null, 'normal queued cycles retain the Phase 2 barrier');
  let current = await readState(f.root, f.env);
  const input = stopInput(current.state);
  assert.equal((await hook(f, input)).decision, 'block');
  assert.equal((await hook(f, { ...input, stop_hook_active: true })).decision, undefined);
  current = await readState(f.root, f.env);
  assert.equal(current.state.operations.find(op => op.id === entries[1].id).status, 'queued');
  const next = await submitOperation(f.root, reconciliationEnvelope(entries[0].id, entries[0].text, 'Agreed review.', done), f.env, { spawnRunner: false });
  for (const stop_hook_active of [false, true]) {
    const waiting = await hook(f, { ...input, stop_hook_active });
    assert.equal(waiting.decision, 'block', 'a runnable Phase 2 is still awaited');
    assert.ok(waiting.reason.includes(next.operationId), 'wait names the runnable operation, not the dependent queued cycle');
  }
  await execute(f, 'reconcile', done);
  assert.equal((await claimNextOperation(f.root, f.env)).id, entries[1].id);
});
