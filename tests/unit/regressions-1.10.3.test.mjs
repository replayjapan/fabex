import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { registerSession, issueWorkspaceGrant, applyWorkspaceGrant, recordWorkspaceSelection, recordWorkspaceQuestion, workspaceStatus, parseSettingsArgs } from '../../scripts/lib/workspace.mjs';
import { settingsView } from '../../scripts/lib/settings-view.mjs';
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1103-'))), root = join(dir, 'project'); await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'private'), HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), AI_USAGE_TRACKER: '', PATH: '/usr/bin:/bin' };
  await initializeState(root, env); await registerSession(root, { session_id: 'a' }, env);
  t.after(() => rm(dir, { recursive: true, force: true })); return { root, env };
}
const grant = (f, args = '', session = 'a', command = 'settings') => issueWorkspaceGrant(f.root, { command_name: `fabex:${command}`, command_args: args, session_id: session, expansion_type: 'slash_command', command_source: 'plugin' }, f.env);
const apply = async (f, args, session = 'a', command) => applyWorkspaceGrant(f.root, (await grant(f, args, session, command)).id, f.env);
async function choose(f, id, label) {
  const g = (await readState(f.root, f.env)).state.workspace.grants[id];
  const input = { tool_name: 'AskUserQuestion', session_id: g.sessionId, tool_use_id: `choice-${Math.random()}`, tool_input: { questions: g.questions }, tool_response: { answers: { ...Object.fromEntries(g.questions.map((q, index) => [q.question, Array.isArray(label) ? label[index] : label])) } } };
  await recordWorkspaceQuestion(f.root, { ...input, hook_event_name: 'PreToolUse' }, f.env);
  return recordWorkspaceSelection(f.root, { ...input, hook_event_name: 'PostToolUse' }, f.env);
}
async function picks(f, g, labels) { for (const label of labels) assert.ok(await choose(f, g.id, label), label); }
test('1.10.3 menu reaches model and effort controls, preserves scope and supports typed model safely', async t => {
  const f = await fixture(t), g = await grant(f);
  await picks(f, g, ['Models', 'Codex model']);
  assert.equal(await choose(f, g.id, ['model scope=project', 'Default for this project']), null);
  await picks(f, g, [['example-model', 'Default for this project']]);
  const result = await applyWorkspaceGrant(f.root, g.id, f.env);
  assert.equal(result.values['partners.codex.model'], 'example-model');
  assert.equal(result.sources['partners.codex.model'], 'project');
  await assert.rejects(applyWorkspaceGrant(f.root, g.id, f.env), /grant/);
  const effort = await grant(f);
  await picks(f, effort, ['Models', 'Codex reasoning effort', ['xhigh', 'Only this conversation']]);
  await applyWorkspaceGrant(f.root, effort.id, f.env);
  assert.equal((await workspaceStatus(f.root, f.env)).values['partners.codex.effort'], 'xhigh');
  await registerSession(f.root, { session_id: 'b' }, f.env);
  const next = await workspaceStatus(f.root, f.env, 'b');
  assert.equal(next.values['partners.codex.model'], 'example-model');
  assert.notEqual(next.values['partners.codex.effort'], 'xhigh');
});
test('1.10.3 Testing groups assignments and overrides atomically without changing existing values on browse', async t => {
  const f = await fixture(t), before = await workspaceStatus(f.root, f.env);
  assert.notEqual(before.values['roles.testWriting.executor'], before.values['roles.testRunning.executor']);
  const g = await grant(f); await picks(f, g, ['Who does what', 'Testing', 'Who does it']);
  assert.deepEqual((await workspaceStatus(f.root, f.env)).values, before.values);
  await choose(f, g.id, ['Codex', 'This planned milestone']); await applyWorkspaceGrant(f.root, g.id, f.env);
  for (const role of ['testWriting', 'testRunning']) assert.equal((await workspaceStatus(f.root, f.env)).values[`roles.${role}.executor`], 'codex');
  const model = await grant(f); await picks(f, model, ['Who does what', 'Testing', 'Model', ['task-model', 'This planned milestone']]);
  await applyWorkspaceGrant(f.root, model.id, f.env);
  await registerSession(f.root, { session_id: 'b' }, f.env);
  for (const role of ['testWriting', 'testRunning']) assert.equal((await workspaceStatus(f.root, f.env, 'b')).values[`roles.${role}.model`], 'task-model');
  await apply(f, 'Next planned stage', 'b', 'milestone');
  assert.equal((await workspaceStatus(f.root, f.env, 'b')).values['roles.testWriting.model'], null);
  await apply(f, 'roles.testing.model=inherit scope=milestone');
  assert.deepEqual(parseSettingsArgs('roles.testing.effort=inherit scope=session').resets, ['roles.testWriting.effort', 'roles.testRunning.effort']);
});
test('1.10.3 cancel/back/host-managed controls never apply partial changes', async t => {
  const f = await fixture(t), before = (await workspaceStatus(f.root, f.env)).values;
  const g = await grant(f); await picks(f, g, ['Models', 'Claude model and effort', 'Back', 'Back', 'Who does what', 'Coding', 'Who does it', ['Claude', 'Back'], 'Who does it', ['Codex', 'Cancel']]);
  await assert.rejects(applyWorkspaceGrant(f.root, g.id, f.env), /grant/);
  assert.deepEqual((await workspaceStatus(f.root, f.env)).values, before);
  await assert.rejects(readFile(join(f.root, '.fabex/config.json')), { code: 'ENOENT' });
  const expired = await grant(f); await choose(f, expired.id, 'Models');
  await updateState(f.root, s => { s.workspace.grants[expired.id].expiresAt = 1; s.generation++; return s; }, {}, f.env);
  assert.equal(await choose(f, expired.id, 'Codex model'), null);
});
test('1.10.3 each role is reachable, scoped reset restores the broader choice, ordinary view excludes internals', async t => {
  const f = await fixture(t);
  for (const [task, role] of [['Coding', 'implementation'], ['Image review', 'imageReview'], ['Documentation', 'docs']]) {
    const g = await grant(f); await picks(f, g, ['Who does what', task, 'Who does it', ['Claude', 'Only this conversation']]);
    await applyWorkspaceGrant(f.root, g.id, f.env);
    assert.equal((await workspaceStatus(f.root, f.env)).values[`roles.${role}.executor`], 'claude');
    const reset = await grant(f); await picks(f, reset, ['Who does what', task, 'Who does it', ['Use default', 'Only this conversation']]);
    await applyWorkspaceGrant(f.root, reset.id, f.env);
    assert.equal((await workspaceStatus(f.root, f.env)).values[`roles.${role}.executor`], 'codex');
  }
  const view = await settingsView(await workspaceStatus(f.root, f.env), f.env);
  assert.match(view, /Models[\s\S]*Who does what[\s\S]*Weekly usage/);
  assert.doesNotMatch(view, /gitDelivery|newChatMeansNewMilestone|compactions|MCP|Advanced|progressMinutes|operational/);
});

test('1.10.3 Testing, image and documentation choices reach SDK working turns while independent review keeps the partner model', async t => {
  const { recordAuthorizedPrompt } = await import('../../scripts/lib/hook-evidence.mjs');
  const { selectTaskRole, sealReading } = await import('../../scripts/lib/workspace.mjs');
  const { submitOperation, submissionEnvelope, reconciliationEnvelope, claimNextOperation, runOperation } = await import('../../scripts/lib/sdk-controller.mjs');
  for (const [label, role] of [['Testing', 'testWriting'], ['Testing', 'testRunning'], ['Image review', 'imageReview'], ['Documentation', 'docs']]) {
    const f = await fixture(t);
    await apply(f, 'partners.codex.model=main-model partners.codex.effort=medium');
    for (const [control, value] of [['Who does it', 'Codex'], ['Model', 'task-model'], ['Reasoning effort', 'high']]) {
      const g = await grant(f); await picks(f, g, ['Who does what', label, control, [value, 'Only this conversation']]);
      await applyWorkspaceGrant(f.root, g.id, f.env);
    }
    await selectTaskRole(f.root, role, f.env);
    const text = `Perform the approved ${role} work`;
    await recordAuthorizedPrompt(f.root, text, 'a', f.env);
    const phase1 = await submitOperation(f.root, submissionEnvelope(text), f.env, { spawnRunner: false });
    const calls = [];
    const createCodex = async () => {
      const thread = options => ({ runStreamed: async () => {
        calls.push(options);
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'fixture-thread' };
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'Fixture conclusion' } };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        })() };
      } });
      return { startThread: thread, resumeThread: (_id, options) => thread(options) };
    };
    await sealReading(f.root, phase1.operationId, 'Independent fixture assessment', f.env);
    await runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex }, f.env);
    await submitOperation(f.root, reconciliationEnvelope(phase1.operationId, text, 'Review the result'), f.env, { spawnRunner: false });
    await runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex }, f.env);
    assert.deepEqual(calls.map(c => [c.model, c.modelReasoningEffort]), [['main-model', 'medium'], ['task-model', 'high']], role);
  }
});


test('1.10.3 explicit normal-model choice displays the Codex default, not a shadowed legacy override', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.fabex'));
  await writeFile(join(f.root, '.fabex/config.json'), JSON.stringify({ schemaVersion: 1, models: { codex: { model: 'legacy-model' } } }));
  await mkdir(f.env.CODEX_HOME, { recursive: true });
  await writeFile(join(f.env.CODEX_HOME, 'config.toml'), 'model = "native-default"\n');
  await apply(f, 'partners.codex.model=null');
  const status = await workspaceStatus(f.root, f.env);
  assert.equal(status.models.codex.id, 'native-default');
  const view = await settingsView(status, f.env);
  assert.match(view, /Codex model: native-default/); assert.doesNotMatch(view, /legacy-model/);
  const g = await grant(f);
  assert.deepEqual(g.flow.context.models, ['native-default']);
});

test('1.10.3 combined answers need both valid choices and stale earlier answers cannot apply', async t => {
  const f = await fixture(t), g = await grant(f);
  assert.ok(g.questions[0].options.some(o => o.label === 'Cancel'));
  const first = { tool_name: 'AskUserQuestion', session_id: 'a', tool_use_id: 'first-menu', tool_input: { questions: g.questions }, tool_response: { answers: { [g.questions[0].question]: 'Models' } } };
  await recordWorkspaceQuestion(f.root, { ...first, hook_event_name: 'PreToolUse' }, f.env);
  await recordWorkspaceSelection(f.root, { ...first, hook_event_name: 'PostToolUse' }, f.env);
  await choose(f, g.id, 'Codex model');
  const current = (await readState(f.root, f.env)).state.workspace.grants[g.id];
  assert.equal(current.questions.length, 2);
  for (const q of current.questions) assert.ok(q.options.length >= 2 && q.options.length <= 4);
  assert.equal(await recordWorkspaceSelection(f.root, { ...first, hook_event_name: 'PostToolUse' }, f.env), null);
  assert.equal(await choose(f, g.id, ['some-model']), null);
  assert.equal(await choose(f, g.id, ['some-model', 'scope=project']), null);
  await assert.rejects(applyWorkspaceGrant(f.root, g.id, f.env), /Choose/);
  const selection = await choose(f, g.id, ['some-model', 'This planned milestone']);
  assert.match(selection.summary, /some-model.*milestone/);
  const result = await applyWorkspaceGrant(f.root, g.id, f.env);
  assert.equal(result.summary, selection.summary);
  assert.equal(result.values['partners.codex.model'], 'some-model');
});

test('1.10.3 retired preference stays readable but new assignments fail without changing configuration', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.fabex'));
  const file = join(f.root, '.fabex/config.json');
  const saved = JSON.stringify({ schemaVersion: 1, settings: { 'milestones.newChatMeansNewMilestone': true } });
  await writeFile(file, saved);
  assert.equal((await workspaceStatus(f.root, f.env)).values['milestones.newChatMeansNewMilestone'], true);
  for (const value of ['true', 'false']) await assert.rejects(apply(f, `milestones.newChatMeansNewMilestone=${value} scope=project`), /Retired: milestones follow your plan, not new chats\./);
  assert.equal(await readFile(file, 'utf8'), saved);
  await apply(f, 'milestones.newChatMeansNewMilestone=inherit scope=project');
  assert.equal((await workspaceStatus(f.root, f.env)).values['milestones.newChatMeansNewMilestone'], false);
});

test('1.10.3 human view omits private paths, typed internals and unknown observations; JSON retains the reference', async t => {
  const f = await fixture(t), status = await workspaceStatus(f.root, f.env);
  status.observations = { codex: { requested: 'requested-model', observed: null, at: 'fixture time' } };
  let view = await settingsView(status, f.env);
  assert.match(view, /^Project: project\nMilestone: none chosen yet/);
  assert.doesNotMatch(view, new RegExp(f.root));
  assert.doesNotMatch(view, /roles\.|partners\.|scope=|inherit|Typed alternatives|model check|Model differs|from normal default|same as partner/);
  assert.match(view, /same as main model/); assert.match(view, /same as main effort/);
  assert.ok(status.typedCommands.tasks.Testing.some(command => command.includes('roles.testing.executor')));
  status.observations.codex.observed = 'requested-model';
  view = await settingsView(status, f.env); assert.doesNotMatch(view, /Model differs/);
  status.observations.codex.observed = 'different-model';
  view = await settingsView(status, f.env); assert.match(view, /Model differs: Codex requested requested-model but reported different-model/);
});
