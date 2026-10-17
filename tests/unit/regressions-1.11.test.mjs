import { modeGrantDecision } from '../../scripts/hook-mode-grant.mjs';
import { observeActivity } from '../../scripts/lib/activity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { registerSession, sealReading, milestoneHandoff, issueWorkspaceGrant, applyWorkspaceGrant, selectTaskRole } from '../../scripts/lib/workspace.mjs';
import { captureOwnerDelivery, ownerDeliveries, ownerDeliveryReplay, deliveryObligations, syncOwnerDeliveries, recordResearchHelper } from '../../scripts/lib/owner-delivery.mjs';
import { dispatchOwnerDeliveries, applyOwnerModeTransition, claimNextOperation, claimRunner, runOperation, submitOperation, reconciliationEnvelope as rawReconciliationEnvelope, continueOperation, updateCheckpoint, confirmedCapacityRefusal, cancelOperation, CONTROLLER_PATH } from '../../scripts/lib/sdk-controller.mjs';
import { waitForOperation } from '../../scripts/controller.mjs';
import { readPrivate, changePrivate, sidecar } from '../../scripts/lib/private-store.mjs';
import { resolveRecordedPrompt, recordOwnerPromptEvidence, recentOwnerPromptEvidence } from '../../scripts/lib/hook-evidence.mjs';
import { relayBlock } from '../../scripts/lib/review.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';
import { classifyToolUse, classifyUnhealthyToolUse, parseControllerCommand } from '../../scripts/hook-route-guard.mjs';
import { refreshAtSafePoint, refreshState, acknowledgeHandoff, refreshDue } from '../../scripts/lib/conversation-refresh.mjs';
import { usageControl, validatedUsageStorage, usageLine, usageLifecycle } from '../../scripts/lib/usage-integration.mjs';

const remainingDisposition = { status: 'remaining', remainingWork: ['Finish approved work.'], reason: 'Authorized work remains.' };
const reconciliationEnvelope = (id, message, response) => rawReconciliationEnvelope(id, message, response, remainingDisposition);
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-111-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'state'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), AI_USAGE_TRACKER_DATA: join(dir, 'tracker-data') };
  await initializeState(root, env); await registerSession(root, { session_id: 'a' }, env);
  await observeActivity(root, { session_id: 'a', permission_mode: 'default' }, env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env, dir };
}
const review = (phase, fields = {}) => ({ scopeMismatch: null, parityConcern: null, answer: 'Reviewed.', ownerSummary: 'Reviewed.', evidence: [], assumptions: [], uncertainties: [], ...(phase === 'reconcile' ? { disagreements: [], workDisposition: remainingDisposition } : {}), recommendation: null, changedFiles: [], tests: [], ...fields });
async function capture(f, prompt = 'Implement the approved task.', extra = {}) {
  return captureOwnerDelivery(f.root, { session_id: 'a', prompt, ...extra }, (await readState(f.root, f.env)).state, f.env);
}
const dispatch = f => dispatchOwnerDeliveries(f.root, 'a', f.env, { spawnRunner: false });
async function execute(f, phase, inspect = () => {}, fields = {}) {
  const createCodex = async (_config, context) => {
    const thread = options => ({ runStreamed: async input => {
      await inspect(options, input, context);
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: fields.threadId ?? 'test-thread' };
        yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(review(phase, fields.review)) } };
        yield { type: 'turn.completed' };
      })() };
    } });
    return { startThread: thread, resumeThread: (_id, options) => thread(options) };
  };
  const operation = await claimNextOperation(f.root, f.env);
  assert.ok(operation);
  return runOperation(f.root, operation, { createCodex }, f.env);
}
async function cycle(f, workDisposition = remainingDisposition) {
  const entry = await capture(f); await dispatch(f);
  await sealReading(f.root, entry.id, 'Independent assessment.', f.env);
  await execute(f, 'independent');
  const second = await submitOperation(f.root, rawReconciliationEnvelope(entry.id, entry.text, 'Agreed: implement the authorized task.', workDisposition), f.env, { spawnRunner: false });
  await execute(f, 'reconcile', () => {}, { review: { workDisposition } });
  return { entry, second };
}
async function guard(f, toolName, toolInput, executor = { sessionId: 'a' }) {
  return classifyToolUse({ ...(await readState(f.root, f.env)), toolName, toolInput, executor, config: {}, env: f.env });
}

test('durable capture distinguishes repeated messages, deduplicates event retries and retains more than eight messages', async t => {
  const f = await fixture(t);
  const first = await capture(f, 'same words', { message_id: 'event-1' });
  assert.equal((await capture(f, 'same words', { message_id: 'event-1' })).id, first.id);
  assert.notEqual((await capture(f, 'same words', { message_id: 'event-2' })).id, first.id);
  const changed = await capture(f, 'changed', { message_id: 'event-1' });
  assert.notEqual(changed.id, first.id);
  assert.equal((await capture(f, 'changed', { message_id: 'event-1' })).id, changed.id);
  for (let i = 0; i < 9; i++) await capture(f, `message ${i}`);
  assert.equal((await ownerDeliveries(f.root, f.env)).length, 12);
  assert.equal((await dispatch(f)).length, 12);
  assert.deepEqual(await dispatch(f), []);
  const state = (await readState(f.root, f.env)).state;
  assert.equal(state.operations.length, 12);
  assert.equal(state.operations[0].request.ownerMessage, 'same words');
  assert.equal(await claimNextOperation(f.root, f.env), null); // not sealed
  assert.equal(await capture(f, '<task-notification>done</task-notification>'), null);
  assert.equal(await capture(f, '[Subagent hand-back] done'), null);
});

test('reused host IDs deliver new mid-turn text and retain prompt evidence; exact retries stay deduplicated', async t => {
  const f = await fixture(t), prompts = ['First owner question.', 'Second owner question.'];
  const script = resolve('scripts/hook-session.mjs');
  for (const prompt of [...prompts, prompts[0], prompts[1]]) {
    const output = spawnSync(process.execPath, [script], { cwd:f.root, env:f.env, encoding:'utf8',
      input:JSON.stringify({cwd:f.root,session_id:'a',message_id:'reused-event',hook_event_name:'UserPromptSubmit',prompt}) });
    assert.equal(output.status,0,output.stderr);
    assert.match(JSON.parse(output.stdout).hookSpecificOutput.additionalContext,/Owner message captured/);
  }
  const entries = await ownerDeliveries(f.root,f.env);
  assert.deepEqual(entries.map(e=>e.text),prompts);
  assert.notEqual(entries[0].id,entries[1].id);
  assert.equal(ownerDeliveryReplay(entries[0],{session_id:'a',message_id:'reused-event',prompt:prompts[1]}),false);
  const state = (await readState(f.root,f.env)).state;
  assert.deepEqual(state.operations.map(op=>op.request.ownerMessage),prompts);
  assert.deepEqual(state.operations.map(op=>op.id),entries.map(e=>e.id));
  const evidence = await recentOwnerPromptEvidence(f.root,f.env);
  for (const text of prompts) assert.ok(evidence.some(e=>e.sessionId==='a' && e.text===text));
});

test('capture survives attachment failure and Stop cannot silently accept a missing submission', async t => {
  const f = await fixture(t), missing = join(f.root, 'missing.png');
  const entry = await capture(f, 'Look at the selected image', { attachments: [missing] });
  assert.equal((await dispatch(f))[0].status, 'failed');
  assert.deepEqual((await ownerDeliveries(f.root, f.env))[0].attachments, [missing]);
  const current = await readState(f.root, f.env);
  assert.equal(current.state.operations.length, 0);
  let entries = await ownerDeliveries(f.root, f.env);
  assert.equal(stopDecision({ session_id: 'a', last_assistant_message: 'Done.' }, current, entries).decision, 'block');
  assert.equal(stopDecision({ session_id: 'a', last_assistant_message: `Partner delivery failed for ${entry.id}; work remains pending.` }, current, entries).decision, undefined);
  await writeFile(missing, 'fixture image');
  assert.equal((await dispatch(f))[0].status, 'submitted');
  entries = await ownerDeliveries(f.root, f.env);
  assert.equal(stopDecision({ session_id: 'a', stop_hook_active: true }, await readState(f.root, f.env), entries).decision, 'block');
  assert.deepEqual(deliveryObligations(entries, current.state, 'other-session'), []);
});

test('independent assessment cannot write; reconciliation can build and continuation keeps the owner identity', async t => {
  const f = await fixture(t), entry = await capture(f);
  await dispatch(f); await sealReading(f.root, entry.id, 'Independent assessment.', f.env);
  await execute(f, 'independent', (options, _input, context) => {
    assert.equal(options.sandboxMode, 'read-only'); assert.equal(options.approvalPolicy, 'never');
  });
  assert.equal((await guard(f, 'Write', { file_path: join(f.root, 'handoff.md'), content: 'premature' })).decision, 'deny');
  const second = await submitOperation(f.root, reconciliationEnvelope(entry.id, entry.text, 'Agreed.'), f.env, { spawnRunner: false });
  await execute(f, 'reconcile', options => assert.equal(options.sandboxMode, 'workspace-write'));
  await updateCheckpoint(f.root, 'openWork', 'Finish the approved patch.', f.env);
  // Repair compatibility with the initial patch, which erased completed text.
  await updateState(f.root, s => { s.operations.find(op => op.id === entry.id).request.ownerMessage = null; s.generation++; return s; }, {}, f.env);
  const continued = await continueOperation(f.root, second.operationId, f.env, { spawnRunner: false });
  assert.equal((await continueOperation(f.root, second.operationId, f.env, { spawnRunner: false })).operationId, continued.operationId);
  const state = (await readState(f.root, f.env)).state;
  assert.equal(state.operations.length, 3);
  assert.equal(state.operations[2].request.parentOperationId, entry.id);
  assert.ok(state.operations[2].request.message.includes(`OWNER MESSAGE (verbatim):\n${entry.text}\n`));
  assert.equal((await ownerDeliveries(f.root, f.env)).length, 1);
});

test('a mid-turn correction makes the earlier reconciliation read-only and blocks edits', async t => {
  const f = await fixture(t), entry = await capture(f);
  await dispatch(f); await sealReading(f.root, entry.id, 'Independent.', f.env); await execute(f, 'independent');
  await submitOperation(f.root, reconciliationEnvelope(entry.id, entry.text, 'Agreed.'), f.env, { spawnRunner: false });
  await capture(f, 'Correction: review this before building.'); await dispatch(f);
  await execute(f, 'reconcile', (options, input) => { assert.equal(options.sandboxMode, 'read-only'); });
  assert.equal((await guard(f, 'Bash', { command: 'npm run build' })).decision, 'deny');
});

test('only confirmed pre-execution capacity refusals retry, bounded and without recovery or substitution', async t => {
  for (const kind of ['capacity', 'executed', 'unknown']) {
    const f = await fixture(t), entry = await capture(f); await dispatch(f); await sealReading(f.root, entry.id, 'Independent.', f.env);
    let calls = 0;
    const createCodex = async () => ({ startThread: () => ({ runStreamed: async () => {
      calls++;
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'test-thread' };
        if (kind === 'executed') yield { type: 'item.started', item: { type: 'command_execution', id: 'c', command: 'pwd' } };
        yield { type: 'turn.failed', error: { message: kind === 'unknown' ? 'connection failed near capacity' : 'The model is currently at capacity. Please try again later.' } };
      })() };
    } }) });
    await assert.rejects(runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex, pause: async () => {} }, f.env));
    assert.equal(calls, kind === 'capacity' ? 3 : 1);
    assert.equal((await readState(f.root, f.env)).state.route, kind === 'capacity' ? 'normal' : 'recovery-read-only');
    await syncOwnerDeliveries(f.root, (await readState(f.root, f.env)).state, f.env);
    assert.equal((await ownerDeliveries(f.root, f.env))[0].status, 'failed');
  }
  assert.equal(confirmedCapacityRefusal(new Error('capacity')), false);
});

test('Discussion permits verified reads and own helpers, while writes and executable lookalikes stay denied', async t => {
  const f = await fixture(t);
  await observeActivity(f.root, { session_id: 'a', permission_mode: 'plan' }, f.env);
  await updateState(f.root, s => { s.route = 'discussion'; s.generation++; return s; }, {}, f.env);
  for (const command of ['gh repo view replayjapan/modes --json name', 'gh pr diff 12', 'gh api repos/replayjapan/modes/commits -X GET', 'git log -3 --oneline', "printf 'mkdir > kill' | sed -n '1p'", 'git status >/dev/null']) assert.equal((await guard(f, 'Bash', { command })).decision, 'defer', command);
  for (const command of ['gh issue create --title x', 'gh api repos/replayjapan/modes/issues -X POST', 'gh api graphql -f query=mutation', 'git fetch', 'git -c core.pager=malicious log', 'find . -fprint output', 'printf x > app.js']) assert.equal((await guard(f, 'Bash', { command })).decision, 'deny', command);
  assert.equal((await guard(f, 'ToolSearch', { query: 'Mobbin search' })).decision, 'defer');
  for (const tool of ['mcp__mobbin__search_sections', 'mcp__plugin_mobbin_mobbin__search_sections']) assert.equal((await guard(f, tool, { query: 'navigation' })).decision, 'defer');
  assert.equal((await guard(f, 'mcp__mobbin__delete_sections', {})).decision, 'deny');
  assert.equal((await guard(f, 'Skill', { skill: 'research-guide' })).decision, 'defer');
  assert.equal((await guard(f, 'mcp__unknown__get_and_delete', {})).decision, 'deny');
  await recordResearchHelper(f.root, { hook_event_name: 'SubagentStart', agent_id: 'helper-1', session_id: 'a' }, f.env);
  assert.equal((await guard(f, 'SendMessage', { recipient: 'helper-1', type: 'message', content: 'Return findings.' })).decision, 'defer');
  assert.equal((await guard(f, 'SendMessage', { recipient: 'foreign', type: 'message' })).decision, 'deny');
  const controller = resolve('scripts/controller.mjs');
  assert.equal(parseControllerCommand(`node '${controller}' help`).kind, 'controller-help');
});

test('usage snapshots work in Discussion with private storage, and reject application or symlink targets', async t => {
  const f = await fixture(t), launcher = join(f.dir, 'track'); await writeFile(launcher, 'fixture');
  const grant = await issueWorkspaceGrant(f.root, { command_name: 'fabex:settings', command_args: `usageTracker.mode=on usageTracker.path=${launcher}`, session_id: 'a', expansion_type: 'slash_command', command_source: 'plugin' }, f.env);
  await applyWorkspaceGrant(f.root, grant.id, f.env);
  await observeActivity(f.root, { session_id: 'a', permission_mode: 'plan' }, f.env);
  await updateState(f.root, s => { s.route = 'discussion'; s.generation++; return s; }, {}, f.env);
  let calls = 0;
  const run = async (file, args, options) => { calls++; assert.equal(file, launcher); assert.equal(args[0], 'snapshot'); assert.equal(options.env.AI_USAGE_TRACKER_DATA, f.env.AI_USAGE_TRACKER_DATA); return { stdout: '{"saved":true}' }; };
  assert.equal((await usageControl(f.root, ['snapshot', '--event', 'start'], f.env, run)).saved, true);
  assert.equal((await usageControl(f.root, ['snapshot', '--event', 'start'], f.env, run)).duplicate, true); assert.equal(calls, 1);
  await assert.rejects(validatedUsageStorage(join(f.root, 'data'), f.root), /application/);
  await symlink(f.root, join(f.dir, 'escape'));
  await assert.rejects(validatedUsageStorage(join(f.dir, 'escape/data'), f.root), /application/);
});

test('new Markdown creation follows Docs assignment, and missing prompt references are not image errors', async t => {
  const f = await fixture(t);
  await selectTaskRole(f.root, 'docs', f.env);
  assert.equal((await guard(f, 'Write', { file_path: join(f.root, 'new handoff.md'), content: 'Shared handoff.' })).decision, 'defer');
  assert.equal((await guard(f, 'Write', { file_path: join(f.root, 'docs/script.js'), content: 'source' })).decision, 'deny');
  const envelope = { phase: 'independent', ownerMessageStatus: 'recorded', ownerMessageDigest: 'a'.repeat(64), ownerSessionId: 'a', previousReplyStatus: 'recorded' };
  const result = await guard(f, 'Bash', { command: `node '${resolve('scripts/controller.mjs')}' submit --message '${JSON.stringify(envelope)}'` });
  assert.equal(result.decision, 'deny'); assert.match(result.reason, /owner message resolution/); assert.doesNotMatch(result.reason, /image attachments/);
});

test('only explicit rotation preserves the predecessor and requires receipt before building', async t => {
  const f = await fixture(t), { second } = await cycle(f);
  const gauge = async () => ({ available: true, lastCall: { at: new Date().toISOString(), fraction: 0.9 } });
  assert.deepEqual(await refreshAtSafePoint(f.root, f.env, { gauge }), { due: false });
  assert.equal(refreshDue(await gauge(), new Date().toISOString()), false);
  assert.equal((await readState(f.root, f.env)).state.partner.thread.threadId, 'test-thread');
  await milestoneHandoff(f.root, second.operationId, 'Shared reviewed handoff: finish the approved patch.', false, f.env);
  await milestoneHandoff(f.root, second.operationId, '', true, f.env);
  assert.equal((await refreshState(f.root, f.env)).status, 'prepared');
  const state = (await readState(f.root, f.env)).state, pending = await refreshState(f.root, f.env);
  assert.equal(state.partner.thread.threadId, null);
  assert.equal(state.workspace.milestones.legacy.parts[0].threadId, 'test-thread');
  assert.equal(await acknowledgeHandoff(f.root, 'fresh-thread', review('independent'), f.env), false);
  assert.equal(await acknowledgeHandoff(f.root, 'test-thread', review('independent', { evidence: [`Handoff received: sha256:${pending.digest}`] }), f.env), false);
  await updateState(f.root, s => { s.partner.thread.threadId = 'fresh-thread'; s.generation++; return s; }, {}, f.env);
  assert.equal(await acknowledgeHandoff(f.root, 'fresh-thread', review('independent', { evidence: [`Handoff received: sha256:${pending.digest}`] }), f.env), true);
  assert.equal((await refreshState(f.root, f.env)).status, 'verified');
  assert.equal(refreshDue({ available: true, compactions: 99, lastCall: { fraction: 0.9, at: '2000-01-01T00:00:00Z' } }, new Date().toISOString()), false);
});

test('unfinished work can cross a refresh using a read-only receipt turn without a new owner prompt', async t => {
  const f = await fixture(t), { second } = await cycle(f);
  await updateCheckpoint(f.root, 'openWork', 'Finish the agreed implementation.', f.env);
  await milestoneHandoff(f.root, second.operationId, 'Reviewed handoff for the unfinished task.', false, f.env);
  await milestoneHandoff(f.root, second.operationId, '', true, f.env);
  const pending = await refreshState(f.root, f.env);
  await continueOperation(f.root, second.operationId, f.env, { spawnRunner: false });
  await execute(f, 'reconcile', options => assert.equal(options.sandboxMode, 'read-only'), { threadId: 'fresh-thread', review: { evidence: [`Handoff received: sha256:${pending.digest}`] } });
  assert.equal((await refreshState(f.root, f.env)).status, 'verified');
  assert.equal((await ownerDeliveries(f.root, f.env)).length, 1);
  const latest = (await readState(f.root, f.env)).state.operations.at(-1);
  await continueOperation(f.root, latest.id, f.env, { spawnRunner: false });
  await execute(f, 'reconcile', options => assert.equal(options.sandboxMode, 'workspace-write'), { threadId: 'fresh-thread' });
});

test('schema migration preserves old queued cycles while changing independent sandbox validation', async t => {
  const f = await fixture(t); await capture(f); await dispatch(f);
  const current = await readState(f.root, f.env), old = structuredClone(current.state);
  old.schemaVersion = 17; old.operations[0].request.sandbox = 'workspace-write';
  await writeFile(current.paths.stateFile, JSON.stringify(old));
  const migrated = await readState(f.root, f.env);
  assert.equal(migrated.ok, true); assert.equal(migrated.state.operations[0].id, old.operations[0].id);
  assert.equal(migrated.state.operations[0].request.sandbox, 'read-only');
  assert.equal((await ownerDeliveries(f.root, f.env))[0].text, old.operations[0].request.ownerMessage);
});

test('recorded reconciliation recovers exact captured text, including trailing spaces, with session and digest binding', async t => {
  const f = await fixture(t), entry = await capture(f, 'Please diagnose this. ');
  await dispatch(f); await sealReading(f.root, entry.id, 'Independent.', f.env); await execute(f, 'independent');
  await updateState(f.root, s => { s.operations[0].request.ownerMessage = null; s.generation++; return s; }, {}, f.env);
  const body = { phase: 'reconcile', phase1OperationId: entry.id, ownerMessageStatus: 'recorded', ownerMessageDigest: entry.digest, ownerSessionId: 'a', fableResponse: 'Agreed diagnosis.' };
  await assert.rejects(submitOperation(f.root, JSON.stringify({ ...body, ownerSessionId: 'foreign' }), f.env, { spawnRunner: false }), /originating cycle/);
  await assert.rejects(submitOperation(f.root, JSON.stringify({ ...body, ownerMessageDigest: '0'.repeat(64) }), f.env, { spawnRunner: false }), /originating cycle/);
  const second = await submitOperation(f.root, JSON.stringify(body), f.env, { spawnRunner: false });
  const state = (await readState(f.root, f.env)).state;
  assert.ok(state.operations.find(op => op.id === second.operationId).request.message.includes('OWNER MESSAGE (verbatim):\nPlease diagnose this. \n'));
  const parent = structuredClone(state); parent.operations[0].result.relay.sessionId = 'foreign';
  await assert.rejects(resolveRecordedPrompt(f.root, { ...body, parentOperationId: entry.id, ownerSessionId: 'foreign' }, parent, f.env), /unavailable/);
});

test('assigned test validation of agreed work survives a pending diagnostic without authorizing edits', async t => {
  const f = await fixture(t); await cycle(f);
  await updateCheckpoint(f.root, 'openWork', 'Run the reviewed regressions.', f.env);
  await capture(f, 'Please diagnose the current work.');
  await mkdir(join(f.root, 'nested app')); await mkdir(join(f.dir, 'outside'));
  await symlink(join(f.dir, 'outside'), join(f.root, 'escape'));
  for (const command of ['npm test', 'npm run test', 'node --test --test-concurrency=1 tests/unit/example.test.mjs']) assert.equal((await guard(f, 'Bash', { command })).decision, 'defer', command);
  for (const command of ["npm --prefix 'nested app' test", "npm --prefix='nested app' run test", 'npm --prefix . test']) assert.equal((await guard(f, 'Bash', { command })).decision, 'defer', command);
  for (const command of ['npm --prefix ../outside test', 'npm --prefix escape test', 'npm --prefix missing test', "npm --prefix 'nested app' test -- --update", "npm --prefix 'nested app' test && touch app.js"]) assert.equal((await guard(f, 'Bash', { command })).decision, 'deny', command);
  for (const command of ['npm run build', 'npm test -- --update', 'npm test && touch src.js', 'node --test --import=./mutator.mjs']) assert.equal((await guard(f, 'Bash', { command })).decision, 'deny', command);
  assert.equal((await guard(f, 'Write', { file_path: join(f.root, 'app.js'), content: 'changed' })).decision, 'deny');
  assert.equal((await guard(f, 'Bash', { command: 'npm test' }, { sessionId: 'a', agentId: 'helper' })).decision, 'deny');
  await updateState(f.root, s => { s.partner.thread.checkpoint.continuation.armed = false; s.generation++; return s; }, {}, f.env);
  assert.equal((await guard(f, 'Bash', { command: 'npm test' })).decision, 'deny');
});

test('migration-deferred waits poll and cancellation signals only the verified active controller without migrating', async t => {
  const f = await fixture(t), entry = await capture(f); await dispatch(f); await sealReading(f.root, entry.id, 'Independent.', f.env);
  await claimNextOperation(f.root, f.env);
  const current = await readState(f.root, f.env), legacy = structuredClone(current.state);
  legacy.schemaVersion = 17; legacy.controller.runnerPid = process.pid;
  await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  const bytes = await readFile(current.paths.stateFile, 'utf8');
  const hook = spawnSync(process.execPath, [resolve('scripts/hook-session.mjs')], { cwd: f.root, env: f.env, encoding: 'utf8', input: JSON.stringify({ cwd: f.root, session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'Keep this exact owner prompt. ' }) });
  assert.equal(hook.status, 0, hook.stderr);
  const failedCapture = JSON.parse(hook.stdout);
  assert.equal(failedCapture.decision, undefined, 'capture failure must not discard the host prompt');
  assert.match(failedCapture.systemMessage, /do not ask the owner to retype/);
  assert.match(failedCapture.hookSpecificOutput.additionalContext, /migration-deferred/);
  assert.equal(await readFile(current.paths.stateFile, 'utf8'), bytes);
  const identity = async () => ({ pid: process.pid, pgid: process.pid, signature: 'verified-fixture' });
  const signals = [];
  await assert.rejects(cancelOperation(f.root, entry.id, f.env, { identity, commandLine: async () => 'unrelated process', signal: (...args) => signals.push(args) }), /identity/);
  assert.equal(signals.length, 0);
  const result = await cancelOperation(f.root, entry.id, f.env, { identity, commandLine: async () => `${process.execPath} ${CONTROLLER_PATH} runner --root ${f.root}`, signal: (...args) => signals.push(args) });
  assert.equal(result.cancellationRequested, true);
  assert.deepEqual(signals, [[process.pid, 'SIGUSR1']]);
  assert.equal(await readFile(current.paths.stateFile, 'utf8'), bytes);
  let polls = 0;
  const waited = await waitForOperation(f.root, entry.id, 1, f.env, async () => {
    polls++;
    legacy.operations[0].status = 'cancelled'; legacy.operations[0].lifecycle.phase = 'cancelled';
    legacy.operations[0].lifecycle.finishedAt = new Date().toISOString(); legacy.controller.activeOperationId = null;
    await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  });
  assert.equal(polls, 1); assert.equal(waited.timedOut, false); assert.equal(waited.operation.status, 'cancelled');
  assert.equal(waited.operation.observationHealth, 'migration-deferred');
  assert.equal(JSON.parse(await readFile(current.paths.stateFile, 'utf8')).schemaVersion, 17);
  for (const command of ['git status', 'pgrep -f controller.mjs', 'find . -name README.md']) assert.equal(classifyUnhealthyToolUse({ toolName: 'Bash', toolInput: { command }, health: 'migration-deferred' }).decision, 'defer');
  for (const command of ['git push', 'find . -delete', 'pgrep -f foo; kill 123']) assert.equal(classifyUnhealthyToolUse({ toolName: 'Bash', toolInput: { command }, health: 'migration-deferred' }).decision, 'deny');
});

test('unhealthy shell reads exclude dev controls, network access and decoded image paths', () => {
  const classify = (command, health = 'migration-deferred') => classifyUnhealthyToolUse({ toolName: 'Bash', toolInput: { command }, health }).decision;
  for (const command of ['git status', 'git log -3 --oneline', 'pgrep -f controller.mjs', 'find . -name README.md', "cat README.md | sed -n '1p'"]) assert.equal(classify(command), 'defer', command);
  const control = resolve('scripts/control.mjs');
  for (const health of ['migration-deferred', 'lock-contention', 'corrupt']) {
    assert.equal(classify(`node '${control}' status`, health), 'defer');
    for (const command of [
      `node '${control}' dev status`, `node '${control}' dev logs | head`,
      "curl -q --noproxy '*' --max-time 5 http://localhost:3000/", 'lsof -i :3000',
      'gh repo view owner/repo', 'npm view example', 'git fetch',
      'cat photo.png', "cat photo.pn'g' | head", 'find . -exec curl example.test \\;',
      'git status && curl http://localhost:3000/'
    ]) assert.equal(classify(command, health), 'deny', `${health}: ${command}`);
  }
});

test('diagnose never calls activation verified when registry and source differ', async t => {
  const f = await fixture(t);
  await mkdir(join(f.env.CLAUDE_CONFIG_DIR, 'plugins'), { recursive: true });
  await writeFile(join(f.env.CLAUDE_CONFIG_DIR, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'fabex@fabex': [{ version: '1.10.10', installPath: join(f.dir, 'old-install') }] } }));
  await updateState(f.root, s => { s.partner.thread.metadata.lastRecordedTurn = { at: new Date().toISOString(), version: '1.11.0' }; s.generation++; return s; }, {}, f.env);
  const output = spawnSync(process.execPath, [resolve('scripts/control.mjs'), 'diagnose'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const diagnostic = JSON.parse(output.stdout);
  assert.equal(diagnostic.activation.matchesSource, false); assert.equal(diagnostic.activation.reloadRequired, true);
  assert.match(diagnostic.activation.verdict, /^not verified:/);
});

test('abandoning an assessed delivery retains a visible failure instead of an impossible assessment obligation', async t => {
  const f = await fixture(t), entry = await capture(f); await dispatch(f); await sealReading(f.root, entry.id, 'Independent.', f.env); await execute(f, 'independent');
  const pending = stopDecision({ session_id: 'a' }, await readState(f.root, f.env), await ownerDeliveries(f.root, f.env));
  assert.ok(pending.reason.includes(`result --operation-id ${entry.id}`));
  assert.match(pending.reason, /awaits reconciliation/);
  const output = spawnSync(process.execPath, [resolve('scripts/control.mjs'), 'recover', 'abandon', '--operation-id', entry.id], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const current = await readState(f.root, f.env); await syncOwnerDeliveries(f.root, current.state, f.env);
  const entries = await ownerDeliveries(f.root, f.env);
  assert.equal(deliveryObligations(entries, current.state, 'a')[0].status, 'failed');
  assert.equal(stopDecision({ session_id: 'a', last_assistant_message: `Delivery ${entry.id} was interrupted and abandoned; the task is unfinished.` }, current, entries).decision, undefined);
});

test('mid-build messages, corrections, stop text and attachments queue without cancelling the running reconciliation', async t => {
  const f = await fixture(t), entry = await capture(f);
  await dispatch(f); await sealReading(f.root, entry.id, 'Independent.', f.env);
  await execute(f, 'independent');
  const second = await submitOperation(f.root, reconciliationEnvelope(entry.id, entry.text, 'Agreed: finish the patch.'), f.env, { spawnRunner: false });
  // Establish the fixture's live runner identity so hook wakeups cannot reclaim
  // it. No real SDK process or cancellation signal is used by this test.
  await claimRunner(f.root, process.pid, f.env);
  const image = join(f.root, 'reference.png'); await writeFile(image, 'owner-selected image fixture');
  const prompts = ['The sample dataset is available.', 'Which output format is supported?', 'Correction: use this reference instead.', 'Stop building.'];
  await execute(f, 'reconcile', async () => {
    for (const prompt of prompts) {
      const hook = spawnSync(process.execPath, [resolve('scripts/hook-session.mjs')], {
        cwd: f.root, env: f.env, encoding: 'utf8',
        input: JSON.stringify({ cwd: f.root, hook_event_name: 'UserPromptSubmit', session_id: 'a', permission_mode: 'default', prompt, ...(prompt.startsWith('Correction:') ? { attachments: [image] } : {}) })
      });
      assert.equal(hook.status, 0, hook.stderr);
      assert.match(hook.stdout, /already-authorized active turn continues/);
      const current = (await readState(f.root, f.env)).state;
      const active = current.operations.find(op => op.id === second.operationId);
      assert.equal(active.status, 'working');
      assert.equal(active.lifecycle.cancelRequested, false);
      const queued = current.operations.find(op => op.request.ownerMessage === prompt && op.status === 'queued');
      assert.ok(queued);
      if (prompt.startsWith('Correction:')) assert.deepEqual(queued.request.attachments, [image]);
    }
  });
  const state = (await readState(f.root, f.env)).state;
  assert.equal(state.operations.find(op => op.id === second.operationId).status, 'completed');
  const recorded = await recentOwnerPromptEvidence(f.root, f.env);
  for (const prompt of prompts) assert.ok(recorded.some(e => e.text === prompt));
  assert.equal(await claimNextOperation(f.root, f.env), null, 'queued messages require independent review before more work');
  const next = state.operations.find(op => op.request.ownerMessage === prompts[0]);
  await sealReading(f.root, next.id, 'Review the queued message.', f.env);
  const claimed = await claimNextOperation(f.root, f.env);
  assert.equal(claimed.id, next.id);
  assert.equal(claimed.request.phase, 'independent');
  assert.equal(claimed.request.sandbox, 'read-only');
});

test('host permission observations and Modes transitions do not cancel an active partner turn', async t => {
  const f = await fixture(t), entry = await capture(f);
  await dispatch(f); await sealReading(f.root, entry.id, 'Independent.', f.env);
  await execute(f, 'independent');
  const second = await submitOperation(f.root, reconciliationEnvelope(entry.id, entry.text, 'Agreed.'), f.env, { spawnRunner: false });
  const stillRunning = async () => {
    const state = (await readState(f.root, f.env)).state;
    const active = state.operations.find(op => op.id === second.operationId);
    assert.equal(active.status, 'working');
    assert.equal(active.lifecycle.cancelRequested, false);
  };
  await execute(f, 'reconcile', async () => {
    await observeActivity(f.root, { session_id: 'a', permission_mode: 'plan' }, f.env);
    await stillRunning();
    assert.equal((await guard(f, 'Write', { file_path: join(f.root, 'app.js'), content: 'bad' })).decision, 'deny');
    await observeActivity(f.root, { session_id: 'a', permission_mode: 'default' }, f.env);
    await modeGrantDecision({ session_id: 'a', permission_mode: 'default', command_name: 'modes:discussion', command_args: '', command_source: 'plugin', expansion_type: 'slash_command' }, f.root, f.env);
    await stillRunning();
    const grant = (await readState(f.root, f.env)).state.modeGrant;
    const pending = await applyOwnerModeTransition(f.root, { grantId: grant.id, route: 'discussion', participants: 'both' }, f.env, { spawnRunner: false });
    assert.equal(pending.status, 'pending');
    await stillRunning();
    await observeActivity(f.root, { session_id: 'a', permission_mode: 'default' }, f.env);
    await stillRunning();
    assert.equal((await guard(f, 'Write', { file_path: join(f.root, 'app.js'), content: 'bad' })).decision, 'deny');
  });
  assert.equal((await readState(f.root, f.env)).state.operations.find(op => op.id === second.operationId).status, 'completed');
});

test('capture journal failure reports visibly without blocking the original host message', async t => {
  const f = await fixture(t), current = await readState(f.root, f.env);
  await writeFile(join(current.paths.projectDir, 'owner-delivery.json'), '{"invalid":true}');
  const output = spawnSync(process.execPath, [resolve('scripts/hook-session.mjs')], { cwd: f.root, env: f.env, encoding: 'utf8', input: JSON.stringify({ cwd: f.root, session_id: 'a', message_id: 'host-1', hook_event_name: 'UserPromptSubmit', prompt: 'Keep my words and selected image.', attachments: ['photo.png'] }) });
  assert.equal(output.status, 0, output.stderr);
  const failure = JSON.parse(output.stdout);
  assert.equal(failure.decision, undefined);
  assert.match(failure.systemMessage, /Keep the original host message and attachments/);
  assert.match(failure.hookSpecificOutput.additionalContext, /before affected implementation/);
  assert.equal((await readState(f.root, f.env)).state.operations.length, 0, 'must not claim failed capture was submitted');
});

test('captured but unsubmitted delivery has a usable abandon escape and retains original content', async t => {
  const f = await fixture(t), entry = await capture(f, 'Retain this interrupted request.');
  const pending = stopDecision({ session_id: 'a' }, await readState(f.root, f.env), await ownerDeliveries(f.root, f.env));
  assert.ok(pending.reason.includes(`recover abandon --operation-id ${entry.id}`));
  const output = spawnSync(process.execPath, [resolve('scripts/control.mjs'), 'recover', 'abandon', '--operation-id', entry.id], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const entries = await ownerDeliveries(f.root, f.env);
  assert.equal(entries[0].text, entry.text); assert.equal(entries[0].status, 'failed');
  assert.deepEqual(await dispatch(f), [], 'abandoned delivery does not silently resubmit');
  assert.equal(stopDecision({ session_id: 'a', last_assistant_message: `Delivery ${entry.id} was interrupted; work remains unfinished.` }, await readState(f.root, f.env), entries).decision, undefined);
});

test('cancelled writing turn reports observed partial edits without rolling them back', async t => {
  const f = await fixture(t), entry = await capture(f); await dispatch(f); await sealReading(f.root, entry.id, 'Independent.', f.env); await execute(f, 'independent');
  const second = await submitOperation(f.root, reconciliationEnvelope(entry.id, entry.text, 'Agreed implementation.'), f.env, { spawnRunner: false });
  const active = await claimNextOperation(f.root, f.env);
  const createCodex = async () => ({ resumeThread: () => ({ runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'test-thread' };
    await writeFile(join(f.root, 'partial.js'), 'partial authorized edit');
    throw Object.assign(new Error('owner correction interrupted work'), { name: 'AbortError' });
  })() }) }) });
  assert.equal((await runOperation(f.root, active, { createCodex }, f.env)).status, 'cancelled');
  const operation = (await readState(f.root, f.env)).state.operations.find(op => op.id === second.operationId);
  assert.match(operation.result.warning, /partial\.js/);
  assert.match(operation.result.warning, /no files were rolled back/);
  assert.match(operation.result.warning, /inspect the diff before resuming/);
  assert.equal(await readFile(join(f.root, 'partial.js'), 'utf8'), 'partial authorized edit');
});


test('1.11.1 stale threshold notices never request another rotation', async t => {
  const f = await fixture(t);
  await changePrivate(f.root, 'conversation-refresh.json', { schemaVersion: 1, pending: null }, data => {
    data.pending = { status: 'needs-review', predecessor: 'old-thread', reason: 'stale threshold' };
  }, f.env);
  assert.equal(await refreshState(f.root, f.env), null);
  assert.deepEqual(await refreshAtSafePoint(f.root, f.env), { due: false });
  assert.equal((await readPrivate(await sidecar(f.root, 'conversation-refresh.json', f.env), null)).pending.predecessor, 'old-thread');
});

test('1.11.1 Fabex slash controls bypass capture without erasing agreed continuation', async t => {
  const f = await fixture(t);
  await updateCheckpoint(f.root, 'openWork', 'Complete the authorized task.', f.env);
  const before = (await readState(f.root, f.env)).state.partner.thread.checkpoint.continuation;
  for (const prompt of ['/fabex:milestone restore-part=0', '/fabex:settings', '/fabex:work continue', '/fabex:diagnose']) {
    assert.equal(await capture(f, prompt), null);
    assert.equal(await recordOwnerPromptEvidence(f.root, { prompt, session_id: 'a' }, f.env), null);
  }
  assert.deepEqual((await readState(f.root, f.env)).state.partner.thread.checkpoint.continuation, before);
  const g = await issueWorkspaceGrant(f.root, { command_name: 'fabex:settings', command_args: 'tracking=off scope=project', session_id: 'a', expansion_type: 'slash_command', command_source: 'plugin' }, f.env);
  assert.equal((await applyWorkspaceGrant(f.root, g.id, f.env)).applied, true);
  assert.ok(await capture(f, 'Please explain /fabex:settings'));
});

test('1.11.1 restoration retains work but requires scope revalidation before continuation', async t => {
  const f = await fixture(t), { second } = await cycle(f);
  await updateCheckpoint(f.root, 'openWork', 'Finish approved work.', f.env);
  await milestoneHandoff(f.root, second.operationId, 'Continue approved work.', false, f.env);
  await milestoneHandoff(f.root, second.operationId, '', true, f.env);
  await updateState(f.root, s => { s.partner.thread.threadId = 'brief-thread'; s.generation++; return s; }, {}, f.env);
  const g = await issueWorkspaceGrant(f.root, { command_name: 'fabex:milestone', command_args: 'restore-part=0', session_id: 'a', expansion_type: 'slash_command', command_source: 'plugin' }, f.env);
  await applyWorkspaceGrant(f.root, g.id, f.env);
  const state = (await readState(f.root, f.env)).state;
  assert.equal(state.partner.thread.threadId, 'test-thread');
  assert.equal(state.partner.thread.checkpoint.continuation.armed, false);
  assert.deepEqual(state.partner.thread.checkpoint.openWork, ['Finish approved work.', 'Finish approved work.']);
  assert.equal(state.workspace.milestones.legacy.parts.at(-1).threadId, 'brief-thread');
  assert.equal(await refreshState(f.root, f.env), null);
  await assert.rejects(continueOperation(f.root, second.operationId, f.env, { spawnRunner: false }), /not been revalidated/);
  assert.deepEqual((await readState(f.root, f.env)).state, state);
  await assert.rejects(continueOperation(f.root, randomUUID(), f.env, { spawnRunner: false }), /this session’s completed reconciliation/);
  assert.deepEqual((await readState(f.root, f.env)).state, state);
  const reply = state.operations.filter(op => op.result.relay?.status === 'pending').map(op => relayBlock(op)).join('\n');
  assert.equal(stopDecision({ session_id: 'a', last_assistant_message: reply }, { ok: true, state }).decision, undefined);
  // A new owner cycle revalidates scope; restoration alone never arms old work.
  const resumed = await cycle(f);
  await updateCheckpoint(f.root, 'openWork', 'Finish revalidated work.', f.env);
  assert.ok((await continueOperation(f.root, resumed.second.operationId, f.env, { spawnRunner: false })).operationId);
});

test('1.11.1 reconciliation by parent ID preserves exact text and rejects another session', async t => {
  const f = await fixture(t), entry = await capture(f, 'Continue exactly.  ');
  await dispatch(f); await sealReading(f.root, entry.id, 'Independent.', f.env); await execute(f, 'independent');
  const body = { phase: 'reconcile', phase1OperationId: entry.id, fableResponse: 'Agreed.' };
  const command = `node '${resolve('scripts/controller.mjs')}' submit --message '${JSON.stringify(body)}'`;
  assert.equal((await guard(f, 'Bash', { command }, { sessionId: 'other' })).decision, 'deny');
  await assert.rejects(submitOperation(f.root, JSON.stringify({ ...body, ownerSessionId: 'other' }), f.env, { spawnRunner: false }), /originating cycle/);
  const second = await submitOperation(f.root, JSON.stringify(body), f.env, { spawnRunner: false });
  const op = (await readState(f.root, f.env)).state.operations.find(op => op.id === second.operationId);
  assert.ok(op.request.message.includes(`OWNER MESSAGE (verbatim):\n${entry.text}\n`));
});

test('1.11.1 Stop identifies each missing summary with an exact retrieval command', async t => {
  const f = await fixture(t), { second } = await cycle(f);
  const decision = stopDecision({ session_id: 'a', last_assistant_message: 'Done.' }, await readState(f.root, f.env));
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reason.includes(`controller.mjs relay --operation-id ${second.operationId}`));
});

test('1.11.1 sibling tracker storage is valid but repository and redirected targets stay denied', async t => {
  const f = await fixture(t), launcher = join(f.dir, 'track'), app = join(f.root, 'app');
  await mkdir(app); await writeFile(launcher, 'fixture'); await mkdir(join(f.root, '.fabex'));
  await writeFile(join(f.root, '.fabex/config.json'), JSON.stringify({ schemaVersion: 1, project: { repositoryRoot: 'app' }, settings: { 'usageTracker.mode': 'on', 'usageTracker.path': launcher } }));
  const env = { ...f.env, AI_USAGE_TRACKER_DATA: join(f.root, 'tracker/data') };
  let calls = 0;
  const run = async () => { calls++; return { stdout: JSON.stringify({ captured_at: new Date().toISOString(), totals: {} }) }; };
  assert.ok((await usageControl(f.root, ['snapshot', '--event', 'start'], env, run)).captured_at);
  assert.equal(calls, 1);
  assert.equal((await usageControl(f.root, ['snapshot', '--event', 'checkpoint', '--checkpoint', 'unsafe'], { ...env, AI_USAGE_TRACKER_DATA: join(app, 'data') }, run)).available, false);
  await symlink(app, join(f.root, 'redirect'));
  assert.equal((await usageControl(f.root, ['snapshot', '--event', 'checkpoint', '--checkpoint', 'redirect'], { ...env, AI_USAGE_TRACKER_DATA: join(f.root, 'redirect/data') }, run)).available, false);
  assert.equal(calls, 1);
});

test('1.11.1 usage failures remain visible and delivery retries do not recollect', async t => {
  const f = await fixture(t); await mkdir(join(f.root, '.fabex'));
  await writeFile(join(f.root, '.fabex/config.json'), JSON.stringify({ schemaVersion: 1, settings: { 'usageTracker.mode': 'on' } }));
  let calls = 0;
  const collect = async () => { calls++; return { available: false, reason: 'collector unavailable' }; };
  const first = await usageLifecycle(f.root, 'checkpoint', 'delivery-one', 'a', f.env, collect);
  assert.match(first, /^Usage unavailable:/);
  assert.equal(await usageLifecycle(f.root, 'checkpoint', 'delivery-one', 'a', f.env, collect), first); assert.equal(calls, 1);
  await usageLifecycle(f.root, 'checkpoint', 'delivery-two', 'a', f.env, collect); assert.equal(calls, 2);
  const line = usageLine({ totals: { codex: { input: 1, cache_read: 2, cache_write: 3, output: 4 } }, missing_allowance_providers: ['claude'], allowances: [{ freshness: 'stale' }] });
  assert.match(line, /10 tokens/); assert.match(line, /cumulative/); assert.match(line, /Allowance unavailable: claude/); assert.match(line, /stale/);
  assert.doesNotMatch(usageLine({ totals: {} }), /0 tokens/);
  assert.equal(usageLine(null), null);
});

test('1.11.1 directory marketplace agreement does not claim observed hook activation', async t => {
  const f = await fixture(t), version = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
  await mkdir(join(f.env.CLAUDE_CONFIG_DIR, 'plugins'), { recursive: true });
  await writeFile(join(f.env.CLAUDE_CONFIG_DIR, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'fabex@fabex': [{ version, installPath: join(f.dir, 'cache') }] } }));
  await updateState(f.root, s => { s.partner.thread.metadata.lastRecordedTurn = { version, at: new Date().toISOString() }; s.generation++; return s; }, {}, f.env);
  const output = spawnSync(process.execPath, [resolve('scripts/control.mjs'), 'diagnose'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const activation = JSON.parse(output.stdout).activation;
  assert.equal(activation.sourceLocation, 'directory-marketplace'); assert.equal(activation.installationAgrees, true);
  assert.equal(activation.reloadRequired, false); assert.equal(activation.liveHooksVerified, false);
});

test('1.11.1 invalid seal and submit delimiters produce actionable refusals', async t => {
  const f = await fixture(t);
  for (const action of ['submit', 'seal --operation-id 12345678-1234-4234-8234-123456789012']) {
    const command = `node '${resolve('scripts/controller.mjs')}' ${action} <<'END'\n{}\nEND`;
    const result = await guard(f, 'Bash', { command });
    assert.equal(result.decision, 'deny'); assert.match(result.reason, /8–64/);
  }
});


test('1.11.1 an unavailable tracker result never becomes a successful usage marker', async t => {
  const f = await fixture(t), launcher = join(f.dir, 'track'); await writeFile(launcher, 'fixture');
  await mkdir(join(f.root, '.fabex'));
  await writeFile(join(f.root, '.fabex/config.json'), JSON.stringify({ schemaVersion: 1, settings: { 'usageTracker.mode': 'on', 'usageTracker.path': launcher } }));
  const result = await usageControl(f.root, ['snapshot', '--event', 'start'], f.env, async () => ({ stdout: '{"available":false,"reason":"missing logs"}' }));
  assert.equal(result.available, false);
  assert.deepEqual((await readState(f.root, f.env)).state.workspace.usageMarkers, {});
  let calls = 0;
  const collect = async () => { calls++; return { totals: { 'codex/model-a': { input: 1, cache_read: 0, cache_write: 0, output: 2 } } }; };
  for (const event of ['start', 'checkpoint', 'end']) {
    const id = event === 'start' ? '' : 'delivery';
    const first = await usageLifecycle(f.root, event, id, 'a', f.env, collect);
    assert.match(first, /3 tokens/);
    assert.equal(await usageLifecycle(f.root, event, id, 'a', f.env, collect), first);
  }
  assert.equal(calls, 3);
});


test('1.11.1 npm prefix containment is limited to the pending-cycle test exception', async t => {
  const f = await fixture(t);
  await cycle(f);
  await updateCheckpoint(f.root, 'openWork', 'Run the approved tests.', f.env);
  await mkdir(join(f.root, 'nested app')); await mkdir(join(f.dir, 'outside'));
  await symlink(join(f.dir, 'outside'), join(f.root, 'escape'));
  // Ordinary work defers to host permissions and executor effect review.
  for (const command of ['npm --prefix ../outside test', 'npm --prefix ../outside dev', 'npm --prefix=../outside run test'])
    assert.equal((await guard(f, 'Bash', { command })).decision, 'defer', command);
  await capture(f, 'Please diagnose the current work.');
  // Pending review permits only the assigned runner's contained test commands.
  for (const command of [
    'npm --prefix ../outside test', 'npm --prefix=../outside run test',
    'npm test --prefix ../outside', 'npm --prefix escape test',
    'npm --prefix missing test', 'npm --prefix test',
    'npm --prefix ../outside dev', 'cd ../outside && npm --prefix . test'
  ]) assert.equal((await guard(f, 'Bash', { command })).decision, 'deny', command);
  for (const command of ['npm --prefix . test', "npm --prefix='nested app' test"])
    assert.equal((await guard(f, 'Bash', { command })).decision, 'defer', command);
});


test('1.11.1 Stop displays usage success or failure without forcing a second reply', async t => {
  for (const result of [
    { totals: { codex: { input: 1, cache_read: 0, cache_write: 0, output: 2 } } },
    { available: false, reason: 'collector unavailable' }
  ]) {
    const f = await fixture(t), { second } = await cycle(f, { status: 'done', remainingWork: [], reason: 'The approved task and checks are complete.' });
    await mkdir(join(f.root, '.fabex'));
    await writeFile(join(f.root, '.fabex/config.json'), JSON.stringify({ schemaVersion: 1, settings: { 'usageTracker.mode': 'on' } }));
    // Seed the real lifecycle cache; Stop must consume it without running an add-on.
    for (const event of ['checkpoint', 'end']) await usageLifecycle(f.root, event, second.operationId, 'a', f.env, async () => result);
    const state = (await readState(f.root, f.env)).state;
    assert.deepEqual(state.partner.thread.checkpoint.openWork, []);
    assert.equal(state.partner.thread.checkpoint.continuation.armed, false);
    assert.equal(state.operations.find(op => op.id === second.operationId).result.structured.workDisposition.status, 'done');
    const reply = state.operations.filter(op => op.result.relay?.status === 'pending').map(op => relayBlock(op)).join('\n');
    const input = { cwd: f.root, session_id: 'a', hook_event_name: 'Stop', last_assistant_message: reply };
    const invoke = body => {
      const output = spawnSync(process.execPath, [resolve('scripts/hook-stop.mjs')], { cwd: f.root, env: f.env, encoding: 'utf8', input: JSON.stringify(body) });
      assert.equal(output.status, 0, output.stderr);
      return JSON.parse(output.stdout);
    };
    // Usage reporting cannot waive missing partner relays either.
    const missing = invoke({ ...input, last_assistant_message: 'Done.' });
    assert.equal(missing.decision, 'block'); assert.equal(missing.systemMessage, usageLine(result));
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = invoke(input);
      assert.equal(output.decision, undefined);
      assert.equal(output.systemMessage, usageLine(result));
      assert.equal(output.reason, undefined);
    }
  }
});
