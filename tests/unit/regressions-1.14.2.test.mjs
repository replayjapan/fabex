import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { observeActivity } from '../../scripts/lib/activity.mjs';
import { registerSession, applyWorkspaceGrant, sealReading, cycleBusy, milestoneRecoveryOperations } from '../../scripts/lib/workspace.mjs';
import { recordOwnerPromptEvidence } from '../../scripts/lib/hook-evidence.mjs';
import { captureOwnerDelivery, ownerDeliveries } from '../../scripts/lib/owner-delivery.mjs';
import { dispatchOwnerDeliveries, normalizeSubmissionEnvelope, reconciliationEnvelope, submitOperation, claimNextOperation, runOperation, pruneOperations } from '../../scripts/lib/sdk-controller.mjs';
import { classifyToolUse, indexOnlyGitCommand } from '../../scripts/hook-route-guard.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';
import { applyStopReminder } from '../../scripts/lib/delivery-feedback.mjs';

const plugin = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const remaining = { status: 'remaining', remainingWork: ['Finish the approved product change.'], reason: 'Work is still pending.' };
const result = (answer, phase = 'reconcile') => ({ scopeMismatch: null, parityConcern: null, answer, evidence: [], assumptions: [], uncertainties: [], recommendation: null, changedFiles: [], tests: [], ...(phase === 'reconcile' ? { disagreements: [], workDisposition: remaining } : {}) });
async function change(f, fn) {
  const updated = await updateState(f.root, s => { fn(s); s.generation++; return s; }, {}, f.env);
  assert.equal(updated.ok, true, updated.error?.message);
  return updated.state;
}
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-review-recovery-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'data'), MODES_HOME: join(dir, 'modes'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), AI_USAGE_TRACKER_DATA: join(dir, 'usage') };
  await initializeState(root, env);
  await registerSession(root, { session_id: 'old-chat' }, env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
async function savedReviews(f) {
  const entries = [];
  for (let i = 0; i < 5; i++) {
    const input = { session_id: 'old-chat', prompt: `Synthetic approved request ${i}.` };
    await recordOwnerPromptEvidence(f.root, input, f.env);
    entries.push(await captureOwnerDelivery(f.root, input, (await readState(f.root, f.env)).state, f.env));
    await dispatchOwnerDeliveries(f.root, 'old-chat', f.env, { spawnRunner: false });
    if (i < 4) await sealReading(f.root, entries[i].id, `Independent assessment ${i}.`, f.env);
  }
  await change(f, s => {
    s.route = 'discussion'; s.ownerSelectedMode = { route: 'discussion', participants: 'both', selectedAt: new Date().toISOString() };
    s.partner.thread.threadId = 'synthetic-canonical-thread';
    s.partner.thread.checkpoint.openWork = Array.from({ length: 5 }, (_, i) => `Preserved product task ${i}.`);
    s.workspace.milestones[s.workspace.activeMilestoneId].name = 'Review-stage';
    for (let i = 0; i < 4; i++) {
      const op = s.operations.find(op => op.id === entries[i].id);
      op.status = 'completed'; op.externalId = 'synthetic-canonical-thread';
      op.result.finalResponse = `Saved answer ${i}.`; op.result.structured = result(op.result.finalResponse, 'independent');
      op.result.relay.status = 'delivered';
      op.lifecycle.phase = 'completed'; op.lifecycle.finishedAt = new Date().toISOString();
    }
  });
  return entries;
}
async function ownerSelect(f, sessionId = 'new-chat') {
  await registerSession(f.root, { session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' }, f.env);
  const id = randomUUID();
  await change(f, s => { s.workspace.grants[id] = { id, command: 'milestone', args: 'Review-stage', sessionId, expiresAt: Date.now() + 300000 }; });
  return applyWorkspaceGrant(f.root, id, f.env);
}
async function execute(f) {
  const op = await claimNextOperation(f.root, f.env);
  assert.ok(op);
  const thread = { runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'synthetic-canonical-thread' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result('Synthetic review result.', op.request.phase)) } };
    yield { type: 'turn.completed' };
  })() }) };
  await runOperation(f.root, op, { createCodex: async () => ({ startThread: () => { throw new Error('Must retain the canonical thread'); }, resumeThread: id => { assert.equal(id, 'synthetic-canonical-thread'); return thread; } }) }, f.env);
  assert.equal((await readState(f.root, f.env)).state.operations.find(o => o.id === op.id).status, 'completed');
  return op.id;
}

test('reconcile errors identify fields; no independent reply-status field is required', async t => {
  const f = await fixture(t), id = randomUUID();
  const valid = { phase: 'reconcile', phase1OperationId: id, fableResponse: 'Claude assessment.', workDisposition: remaining };
  assert.equal(normalizeSubmissionEnvelope(JSON.stringify(valid), 'both').phase, 'reconcile');
  const cases = [
    [{ ...valid, previousReplyStatus: 'provided' }, /unexpected \[previousReplyStatus\]/],
    [{ phase: 'reconcile', phase1OperationId: id }, /missing \[fableResponse\]/],
    [{ ...valid, fableResponse: '' }, /fableResponse/],
    [{ ...valid, phase1OperationId: 'wrong' }, /phase1OperationId/],
    ...[
      [{ ...remaining, status: 'accepted' }, /workDisposition.status/],
      [{ ...remaining, reason: '' }, /workDisposition.reason/],
      [{ ...remaining, remainingWork: Array(17).fill('Task.') }, /at most 16/],
      [{ ...remaining, remainingWork: ['x'.repeat(1025)] }, /remainingWork\[0\]/],
      [{ ...remaining, status: 'done' }, /must be empty/],
      [{ ...remaining, remainingWork: [] }, /must contain work/],
      [{ ...remaining, reason: '<result>payload</result>' }, /plain task text/]
    ].map(([workDisposition, pattern]) => [{ ...valid, workDisposition }, pattern])
  ];
  for (const [body, pattern] of cases) {
    const text = JSON.stringify(body);
    assert.throws(() => normalizeSubmissionEnvelope(text, 'both'), pattern);
    const decision = await classifyToolUse({ ...(await readState(f.root, f.env)), toolName: 'Bash', toolInput: { command: `node '${plugin}/scripts/controller.mjs' submit <<'ENVELOPE'\n${text}\nENVELOPE` }, executor: { sessionId: 'old-chat' }, env: f.env });
    assert.equal(decision.decision, 'deny'); assert.match(JSON.stringify(decision), pattern);
    assert.doesNotMatch(JSON.stringify(decision), /explicit valid Claude reply status/);
  }
});

for (const queuedSealed of [false, true]) test(`fresh milestone selection preserves four saved reviews, a ${queuedSealed ? 'sealed' : 'unsealed'} queued request, thread and open work`, async t => {
  const f = await fixture(t), entries = await savedReviews(f);
  if (queuedSealed) await sealReading(f.root, entries[4].id, 'Preserved independent assessment from the previous chat.', f.env);
  // Exercise recovery from the immutable journal still bound to the old chat,
  // rather than relying on a prompt already copied into each operation.
  await change(f, s => { for (const op of s.operations) op.request.ownerMessage = null; });
  const before = (await readState(f.root, f.env)).state, checkpoint = structuredClone(before.partner.thread.checkpoint);
  assert.equal(cycleBusy(before), true);
  assert.equal(await claimNextOperation(f.root, f.env), null, 'The queued request waits for the earlier reviews, even when sealed');
  await ownerSelect(f);
  const after = (await readState(f.root, f.env)).state;
  assert.equal(after.partner.thread.threadId, before.partner.thread.threadId);
  assert.deepEqual(after.partner.thread.checkpoint, checkpoint);
  assert.deepEqual(after.workspace.seals, before.workspace.seals, 'Transfer must not replace any independent assessment or its digest');
  const reminder = stopDecision({ session_id: 'new-chat' }, { ok: true, state: after }).reminder;
  assert.deepEqual(reminder.items.filter(item => item.key.startsWith('reconcile:')).map(item => item.key), entries.slice(0, 4).map(entry => `reconcile:${entry.id}`));
  assert.equal(reminder.items.some(item => item.key === `seal:${entries[4].id}`), !queuedSealed);
  const journal = await ownerDeliveries(f.root, f.env);
  for (const entry of entries) assert.equal(journal.find(item => item.id === entry.id).sessionId, 'old-chat');
  for (let i = 0; i < 5; i++) {
    const op = after.operations.find(o => o.id === entries[i].id);
    assert.equal(op.result.relay.sessionId, 'new-chat'); assert.equal(op.request.ownerMessage, entries[i].text);
    if (i < 4) assert.equal(op.result.finalResponse, `Saved answer ${i}.`);
  }
  // The queued original request can be read before sealing, without exposing a partner answer.
  const status = spawnSync(process.execPath, [join(plugin, 'scripts/controller.mjs'), 'status', '--operation-id', entries[4].id], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).ownerMessage, entries[4].text);
  const sealCommand = `node '${plugin}/scripts/controller.mjs' seal --operation-id ${entries[4].id} <<'ASSESSMENT'\nIndependent assessment.\nASSESSMENT`;
  for (const [sessionId, expected] of [['new-chat', 'defer'], ['old-chat', 'deny']]) {
    const decision = await classifyToolUse({ ...(await readState(f.root, f.env)), toolName: 'Bash', toolInput: { command: sealCommand }, executor: { sessionId }, env: f.env, config: {} });
    assert.equal(decision.decision, expected);
  }
  if (!queuedSealed) await sealReading(f.root, entries[4].id, 'New chat independent assessment of the preserved request.', f.env);
  for (let i = 0; i < 4; i++) {
    const body = { phase: 'reconcile', phase1OperationId: entries[i].id, ownerSessionId: 'new-chat', fableResponse: `Reconcile original request ${i}.`, workDisposition: remaining };
    const text = JSON.stringify(body);
    await assert.rejects(submitOperation(f.root, JSON.stringify({ ...body, ownerSessionId: 'old-chat' }), f.env, { spawnRunner: false }), /recorded reconciliation message does not match/);
    const submitted = await submitOperation(f.root, text, f.env, { spawnRunner: false });
    const submittedOp = (await readState(f.root, f.env)).state.operations.find(op => op.id === submitted.operationId);
    assert.equal(submittedOp.request.ownerMessageDigest, before.operations.find(op => op.id === entries[i].id).request.ownerMessageDigest);
    await assert.rejects(submitOperation(f.root, text, f.env, { spawnRunner: false }), /already queued or working/);
    assert.equal(await execute(f), submitted.operationId);
    await assert.rejects(submitOperation(f.root, text, f.env, { spawnRunner: false }), /Identical reconciliation/);
  }
  assert.equal(await execute(f), entries[4].id);
  const final = (await readState(f.root, f.env)).state;
  assert.deepEqual(final.partner.thread.checkpoint.openWork, checkpoint.openWork);
  for (let i = 0; i < 4; i++) assert.equal(final.operations.find(o => o.id === entries[i].id).result.finalResponse, `Saved answer ${i}.`);
  // A changed assessment is a correction round, not a duplicate.
  await submitOperation(f.root, reconciliationEnvelope(entries[0].id, entries[0].text, 'A corrected assessment.', remaining), f.env, { spawnRunner: false });
});

test('takeover does not authorize a working turn, wrong conversation or unrelated settings', async t => {
  const f = await fixture(t); await savedReviews(f); await registerSession(f.root, { session_id: 'new-chat' }, f.env);
  const s = (await readState(f.root, f.env)).state;
  const grant = { command: 'milestone', args: 'Review-stage', sessionId: 'new-chat' };
  assert.ok(milestoneRecoveryOperations(s, grant));
  assert.equal(milestoneRecoveryOperations(s, { ...grant, command: 'settings' }), null);
  s.operations.at(-1).status = 'working'; assert.equal(milestoneRecoveryOperations(s, grant), null);
  s.operations.at(-1).status = 'queued'; s.operations[0].externalId = 'other-thread'; assert.equal(milestoneRecoveryOperations(s, grant), null);
});

test('Stop reminds once per review and once for sealing, even when the set grows', async t => {
  const f = await fixture(t); await savedReviews(f); const state = (await readState(f.root, f.env)).state;
  const input = { session_id: 'old-chat', last_assistant_message: '' };
  const first = await applyStopReminder(f.root, input.session_id, stopDecision(input, { ok: true, state }), f.env);
  assert.equal(first.decision, 'block'); assert.match(first.reason, /fableResponse/); assert.match(first.reason, /seal --operation-id/);
  const next = await applyStopReminder(f.root, input.session_id, stopDecision(input, { ok: true, state }), f.env);
  assert.notEqual(next.decision, 'block');
  const extra = structuredClone(state.operations[0]); extra.id = randomUUID(); state.operations.push(extra);
  const added = await applyStopReminder(f.root, input.session_id, stopDecision(input, { ok: true, state }), f.env);
  assert.equal(added.decision, 'block'); assert.ok(added.reason.includes(extra.id)); assert.ok(!added.reason.includes(state.operations[0].id));
});

test('explicit abandonment retains a delivered independent answer and its original request', async t => {
  const f = await fixture(t), entries = await savedReviews(f);
  const before = (await readState(f.root, f.env)).state.operations[0];
  const command = spawnSync(process.execPath, [join(plugin, 'scripts/control.mjs'), 'recover', 'abandon', '--operation-id', entries[0].id], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  const after = (await readState(f.root, f.env)).state.operations.find(o => o.id === entries[0].id);
  assert.ok(after); assert.equal(after.request.interrupted, true); assert.equal(after.result.finalResponse, before.result.finalResponse);
  assert.equal(after.request.ownerMessage, before.request.ownerMessage);
  assert.ok(pruneOperations([after], 0).some(op => op.id === after.id));
  for (const status of ['failed', 'cancelled']) {
    for (const interrupted of [false, true]) {
      const withoutAnswer = structuredClone(after);
      withoutAnswer.status = status;
      withoutAnswer.request.interrupted = interrupted;
      withoutAnswer.result.finalResponse = null;
      assert.deepEqual(pruneOperations([withoutAnswer], 0), [], `${status}, interrupted=${interrupted}, without a saved answer`);
    }
    const ordinaryFailure = structuredClone(after);
    ordinaryFailure.status = status;
    ordinaryFailure.request.interrupted = false;
    assert.deepEqual(pruneOperations([ordinaryFailure], 0), [], `${status} does not gain permanent retention`);
    const interruptedAnswer = structuredClone(after);
    interruptedAnswer.status = status;
    assert.deepEqual(pruneOperations([interruptedAnswer], 0), [interruptedAnswer], `${status} retains an interrupted saved answer`);
  }
});

test('delivery index actions exclude worktree changes, command composition and unassigned executors', async t => {
  const f = await fixture(t);
  const activity = await observeActivity(f.root, { session_id: 'old-chat', permission_mode: 'default' }, f.env);
  assert.equal(activity.activity, 'work');
  await change(f, s => { s.route = 'normal'; s.ownerSelectedMode = { route: 'normal', participants: 'both', selectedAt: new Date().toISOString() }; });
  for (const command of ['git restore --staged -- helper.js', 'git restore --staged helper.js', 'git reset -q HEAD -- helper.js', 'git add -- tests/product.test.js']) {
    assert.equal(indexOnlyGitCommand(command), true);
    const current = await readState(f.root, f.env);
    const decision = await classifyToolUse({ ...current, toolName: 'Bash', toolInput: { command }, executor: { sessionId: 'old-chat' }, config: {}, env: f.env });
    assert.equal(decision.decision, 'defer', JSON.stringify(decision));
  }
  for (const command of ['git restore --staged --worktree helper.js', 'git restore -SW helper.js', 'git reset --hard HEAD -- helper.js', 'git reset --soft HEAD', 'git restore helper.js', 'git restore --staged helper.js > app.js', 'git restore --staged helper.js; touch app.js']) assert.equal(indexOnlyGitCommand(command), false, command);
  await change(f, s => { s.workspace.sessions['old-chat'].settings['roles.gitDelivery.executor'] = 'codex'; });
  const staging = await classifyToolUse({ ...(await readState(f.root, f.env)), toolName: 'Bash', toolInput: { command: 'git add -- tests/product.test.js' }, executor: { sessionId: 'old-chat' }, config: {}, env: f.env });
  assert.equal(staging.decision, 'defer', 'git add keeps its existing permission regardless of the delivery assignment');
  const decision = await classifyToolUse({ ...(await readState(f.root, f.env)), toolName: 'Bash', toolInput: { command: 'git restore --staged -- helper.js' }, executor: { sessionId: 'old-chat' }, config: {}, env: f.env });
  assert.equal(decision.decision, 'deny'); assert.match(JSON.stringify(decision), /exact command once/);
});
