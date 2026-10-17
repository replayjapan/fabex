import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { registerSession, issueWorkspaceGrant, applyWorkspaceGrant, conversationStatus } from '../../scripts/lib/workspace.mjs';
import { startSettingsMenu, advanceSettingsMenu } from '../../scripts/lib/settings-menu.mjs';
import { resolveSettings } from '../../scripts/lib/workspace-settings.mjs';
import { observeActivity, activitySnapshot } from '../../scripts/lib/activity.mjs';
import { modeGrantDecision } from '../../scripts/hook-mode-grant.mjs';
import { dispatchOwnerDeliveries, claimNextOperation } from '../../scripts/lib/sdk-controller.mjs';
import { captureOwnerDelivery } from '../../scripts/lib/owner-delivery.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-session-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'state'), MODES_HOME: join(dir, 'modes'), CLAUDE_CONFIG_DIR: join(dir, 'claude') };
  await initializeState(root, env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
const start = (f, id, source = 'startup') => registerSession(f.root, { session_id: id, hook_event_name: 'SessionStart', source }, f.env);
async function grant(f, command, args, id = 'a') {
  const g = await issueWorkspaceGrant(f.root, { session_id: id, command_name: `fabex:${command}`, command_args: args, expansion_type: 'slash_command', command_source: 'plugin' }, f.env);
  return applyWorkspaceGrant(f.root, g.id, f.env);
}
async function thread(f, id) {
  const result = await updateState(f.root, s => { s.partner.thread.threadId = id; s.partner.thread.checkpoint.currentTask = 'Old authorized task'; s.partner.thread.checkpoint.continuation.armed = true; s.generation++; return s; }, { purpose: 'test-thread' }, f.env);
  assert.equal(result.ok, true, result.error?.message);
}

test('new chats start fresh; resume/compaction and repeated startup keep their conversation; saved sessions reopen without milestones', async t => {
  const f = await fixture(t);
  await start(f, 'a'); await thread(f, 'old-thread');
  const before = (await readState(f.root, f.env)).state;
  const saved = before.workspace.activeConversationId;
  for (const source of ['startup', 'resume', 'compact']) assert.equal((await start(f, 'a', source)).partner.thread.threadId, 'old-thread');
  const fresh = await start(f, 'b');
  assert.equal(fresh.partner.thread.threadId, null);
  assert.equal(fresh.partner.thread.checkpoint.currentTask, null);
  assert.deepEqual(Object.keys(fresh.workspace.milestones), Object.keys(before.workspace.milestones));
  assert.equal(fresh.workspace.conversations[saved].thread.threadId, 'old-thread');
  await grant(f, 'session', `reopen ${saved}`, 'b');
  const restored = (await readState(f.root, f.env)).state;
  assert.equal(restored.partner.thread.threadId, 'old-thread');
  assert.equal(restored.partner.thread.checkpoint.continuation.armed, false);
  await grant(f, 'session', 'fresh', 'b');
  assert.equal((await readState(f.root, f.env)).state.partner.thread.threadId, null);
  assert.ok((await conversationStatus(f.root, f.env, 'b')).conversations.some(c => c.threadId === 'old-thread'));
});

test('project option continues across new chats; legacy resume does not invent a fresh conversation', async t => {
  const f = await fixture(t);
  await thread(f, 'pre-upgrade');
  assert.equal((await start(f, 'a', 'resume')).partner.thread.threadId, 'pre-upgrade');
  await grant(f, 'settings', 'sessions.freshOnNewChat=false scope=project');
  assert.equal((await start(f, 'b')).partner.thread.threadId, 'pre-upgrade');
  await grant(f, 'settings', 'sessions.freshOnNewChat=inherit scope=project', 'b');
  assert.equal((await start(f, 'c')).partner.thread.threadId, null);
});

const context = { project: 'Demo', milestone: null, models: [], defaultModel: null, claude: 'host', values: resolveSettings({}, { workspace: {} }).values };
test('named settings use one choice/scope dialog; bare settings adds only a picker; restore-default remains atomic', () => {
  for (const name of ['coding', 'testing', 'images', 'docs', 'participants', 'sessions', 'tracking', 'models']) {
    const g = startSettingsMenu(name, context);
    assert.notEqual(g.flow.stage, 'picker');
    assert.ok(g.questions.some(q => q.header === 'Apply to'));
    assert.ok(g.questions.length <= 4);
  }
  const g = startSettingsMenu('coding', context);
  const answer = Object.fromEntries(g.questions.map(q => [q.question, q.header === 'Writer' ? 'Claude' : q.header === 'Apply to' ? 'Whole project' : q.header === 'Navigation' ? 'Apply' : 'Keep current']));
  assert.equal(advanceSettingsMenu(g, answer).selection, 'roles.implementation.executor="claude" scope=project');
  const bare = startSettingsMenu('', context);
  advanceSettingsMenu(bare, { [bare.questions[0].question]: 'Documentation' });
  assert.equal(bare.flow.task, 'docs');
  const reset = Object.fromEntries(bare.questions.map(q => [q.question, q.header === 'Defaults' ? 'Default' : q.header === 'Navigation' ? 'Apply' : 'Keep current']));
  assert.equal(advanceSettingsMenu(bare, reset).selection, 'roles.docs.executor=inherit scope=session');
});

test('only Modes owns activity commands; host evidence and participants independently control standalone delivery', async t => {
  const f = await fixture(t); await start(f, 'a');
  assert.equal((await activitySnapshot(f.root, 'a', f.env)).activity, 'discussion');
  await observeActivity(f.root, { session_id: 'a', permission_mode: 'default' }, f.env);
  assert.equal((await activitySnapshot(f.root, 'a', f.env)).activity, 'work');
  await grant(f, 'settings', 'participants=codex scope=session');
  const input = { session_id: 'a', prompt: 'Explain this code', message_id: 'one' };
  const entry = await captureOwnerDelivery(f.root, input, (await readState(f.root, f.env)).state, f.env);
  assert.equal(entry.participants, 'codex'); assert.equal(entry.route, 'normal');
  await observeActivity(f.root, { session_id: 'a', permission_mode: 'plan' }, f.env);
  assert.equal((await activitySnapshot(f.root, 'a', f.env)).activity, 'discussion');
  const retired = await modeGrantDecision({ session_id: 'a', command_name: 'fabex:work', expansion_type: 'slash_command', command_source: 'plugin' }, f.root, f.env);
  assert.equal(retired.decision, 'block'); assert.match(retired.reason, /modes:work/);
  await assert.rejects(issueWorkspaceGrant(f.root, { session_id: 'a', command_name: 'fabex:session', command_args: 'fresh', command_source: 'agent' }, f.env), /owner-typed/);
});


test('a new chat waits for the active queue before binding its fresh conversation', async t => {
  const f = await fixture(t);
  await start(f, 'a'); await thread(f, 'thread-a');
  await grant(f, 'settings', 'participants=codex scope=project');
  async function capture(id) {
    await observeActivity(f.root, { session_id: id, permission_mode: 'default' }, f.env);
    const entry = await captureOwnerDelivery(f.root, { session_id: id, message_id: id, prompt: `Question from ${id}` }, (await readState(f.root, f.env)).state, f.env);
    const result = await dispatchOwnerDeliveries(f.root, id, f.env, { spawnRunner: false });
    assert.equal(result[0].status, 'submitted');
    return entry.id;
  }
  const a = await capture('a');
  const registered = await start(f, 'b');
  assert.equal(registered.workspace.activeSessionId, 'a');
  assert.equal(registered.partner.thread.threadId, 'thread-a');
  assert.equal(registered.workspace.sessions.b.freshPending, true);
  const b = await capture('b');
  assert.equal((await claimNextOperation(f.root, f.env)).id, a);
  assert.equal((await readState(f.root, f.env)).state.partner.thread.threadId, 'thread-a');
  const done = await updateState(f.root, s => {
    const op = s.operations.find(o => o.id === a);
    op.status = 'completed'; op.lifecycle.phase = 'completed'; op.lifecycle.finishedAt = new Date().toISOString();
    s.controller.activeOperationId = null; s.generation++; return s;
  }, { purpose: 'test-complete' }, f.env);
  assert.equal(done.ok, true, done.error?.message);
  assert.equal((await claimNextOperation(f.root, f.env)).id, b);
  const bound = (await readState(f.root, f.env)).state;
  assert.equal(bound.workspace.activeSessionId, 'b');
  assert.equal(bound.partner.thread.threadId, null);
  assert.equal(bound.workspace.conversations[bound.workspace.sessions.a.conversationId].thread.threadId, 'thread-a');
});
