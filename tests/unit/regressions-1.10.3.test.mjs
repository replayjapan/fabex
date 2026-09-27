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
const grant = (f, args = '', session = 'a', command = 'settings') => issueWorkspaceGrant(f.root, { command_name: `fabex:${command}`, command_args: args, session_id: session, expansion_type: 'slash_command', command_source: 'plugin' }, f.env, { catalog: async () => ({ models: ['example-model','main-model','task-model','native-default'].map((id,i) => ({ id, efforts: id === 'main-model' ? ['high','ultra'] : ['medium','high','xhigh'], defaultEffort:'high', isDefault: i === 0 })), error: null }) });
const apply = async (f, args, session = 'a', command) => applyWorkspaceGrant(f.root, (await grant(f, args, session, command)).id, f.env);
async function choose(f, id, label) {
  const g = (await readState(f.root, f.env)).state.workspace.grants[id];
  const input = { tool_name: 'AskUserQuestion', session_id: g.sessionId, tool_use_id: `choice-${Math.random()}`, tool_input: { questions: g.questions }, tool_response: { answers: { ...Object.fromEntries(g.questions.map((q, index) => [q.question, Array.isArray(label) ? label[index] : label])) } } };
  await recordWorkspaceQuestion(f.root, { ...input, hook_event_name: 'PreToolUse' }, f.env);
  return recordWorkspaceSelection(f.root, { ...input, hook_event_name: 'PostToolUse' }, f.env);
}
async function picks(f, g, labels) { for (const label of labels) assert.ok(await choose(f, g.id, label), label); }
test('1.10.4 tabbed model choices apply atomically and reject unavailable typed names', async t => {
  const f = await fixture(t), g = await grant(f);
  await picks(f, g, ['Models']);
  const retry = await choose(f, g.id, ['unlisted-model', 'Keep current', 'Whole project', 'Apply']);
  assert.match(retry.questions[0].question, /Please pick one of the choices/);
  assert.equal(retry.selection, undefined);
  await picks(f, g, [['example-model', 'Keep current', 'Whole project', 'Apply']]);
  const result = await applyWorkspaceGrant(f.root, g.id, f.env);
  assert.equal(result.values['partners.codex.model'], 'example-model');
  assert.equal(result.sources['partners.codex.model'], 'project');
  await assert.rejects(applyWorkspaceGrant(f.root, g.id, f.env), /grant/);
  const effort = await grant(f); await choose(f, effort.id, 'Models');
  await picks(f, effort, [['Keep current','More effort levels','Keep current','Apply'], ['Keep current','More effort levels','Keep current','Apply'], ['Keep current','xhigh','Only this conversation','Apply']]);
  await applyWorkspaceGrant(f.root, effort.id, f.env);
  await registerSession(f.root, { session_id: 'b' }, f.env);
  const next = await workspaceStatus(f.root, f.env, 'b');
  assert.equal(next.values['partners.codex.model'], 'example-model');
  assert.notEqual(next.values['partners.codex.effort'], 'xhigh');
});
test('1.10.4 Testing assignments are atomic; only named milestones are offered', async t => {
  const f = await fixture(t), g = await grant(f), before = (await workspaceStatus(f.root, f.env)).values;
  await picks(f, g, ['Who does what', ['Testing','Continue']]);
  const current = (await readState(f.root, f.env)).state.workspace.grants[g.id];
  assert.equal(current.questions.length, 4);
  assert.ok(current.questions.every(q => q.header.length <= 12));
  assert.ok(!current.questions[1].options.some(o => o.label === 'This milestone'));
  assert.deepEqual((await workspaceStatus(f.root, f.env)).values, before);
  await choose(f, g.id, ['Codex','Whole project','Keep current','Apply']);
  await applyWorkspaceGrant(f.root, g.id, f.env);
  for (const r of ['testWriting','testRunning']) assert.equal((await workspaceStatus(f.root, f.env)).values[`roles.${r}.executor`], 'codex');
  await apply(f, 'Named plan stage', 'a', 'milestone');
  const named = await grant(f); await choose(f, named.id, 'Weekly usage');
  assert.ok((await readState(f.root, f.env)).state.workspace.grants[named.id].questions[1].options.some(o => o.label === 'This milestone'));
});
test('1.10.4 clickable Back and Cancel preserve browsing without saving, including expiry', async t => {
  const f = await fixture(t), before = (await workspaceStatus(f.root, f.env)).values, g = await grant(f);
  await picks(f,g,['Models',['Keep current','Keep current','Keep current','Back'],'Who does what',['Documentation','Continue'],['Both','Whole project','Keep current','Model options'],['Keep current','Keep current','Keep current','Cancel']]);
  await assert.rejects(applyWorkspaceGrant(f.root,g.id,f.env), /grant/);
  assert.deepEqual((await workspaceStatus(f.root,f.env)).values,before);
  const expired=await grant(f); await choose(f,expired.id,'Models');
  await updateState(f.root,s=>{s.workspace.grants[expired.id].expiresAt=1;s.generation++;return s;},{},f.env);
  assert.equal(await choose(f,expired.id,['example-model','Keep current','Keep current','Apply']),null);
});
test('1.10.4 all four tasks restore defaults, including Documentation Both', async t => {
  const f=await fixture(t);
  for(const [label,role] of [['Coding','implementation'],['Image review','imageReview'],['Documentation','docs']]) {
    const g=await grant(f);await picks(f,g,['Who does what',[label,'Continue'],['Claude','Only this conversation','Keep current','Apply']]);
    await applyWorkspaceGrant(f.root,g.id,f.env);
    assert.equal((await workspaceStatus(f.root,f.env)).values[`roles.${role}.executor`],'claude');
    const reset=await grant(f);await picks(f,reset,['Who does what',[label,'Continue'],['Keep current','Only this conversation','Default','Apply']]);
    await applyWorkspaceGrant(f.root,reset.id,f.env);
    assert.equal((await workspaceStatus(f.root,f.env)).values[`roles.${role}.executor`],role==='docs'?'both':'codex');
  }
  const view=await settingsView(await workspaceStatus(f.root,f.env),f.env);
  assert.doesNotMatch(view,/gitDelivery|newChatMeansNewMilestone|compactions|MCP|Advanced|progressMinutes|operational/);
});

test('1.10.3 Testing, image and documentation choices reach SDK working turns while independent review keeps the partner model', async t => {
  const { recordAuthorizedPrompt } = await import('../../scripts/lib/hook-evidence.mjs');
  const { selectTaskRole, sealReading } = await import('../../scripts/lib/workspace.mjs');
  const { submitOperation, submissionEnvelope, reconciliationEnvelope, claimNextOperation, runOperation } = await import('../../scripts/lib/sdk-controller.mjs');
  for (const [label, role] of [['Testing', 'testWriting'], ['Testing', 'testRunning'], ['Image review', 'imageReview'], ['Documentation', 'docs']]) {
    const f = await fixture(t);
    await apply(f, 'partners.codex.model=main-model partners.codex.effort=medium');
    const target = label === 'Testing' ? 'testing' : role;
    await apply(f, `roles.${target}.executor=codex roles.${target}.model=task-model roles.${target}.effort=high`);
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
  assert.ok(g.flow.context.models.some(m => m.id === 'native-default'));
  assert.ok(!g.flow.context.models.some(m => m.id === 'legacy-model'));
});

test('1.10.4 combined tabs require every recorded answer and reject stale host events', async t => {
  const f=await fixture(t),g=await grant(f);
  const first={tool_name:'AskUserQuestion',session_id:'a',tool_use_id:'first',tool_input:{questions:g.questions},tool_response:{answers:{[g.questions[0].question]:'Models'}}};
  await recordWorkspaceQuestion(f.root,{...first,hook_event_name:'PreToolUse'},f.env);
  await recordWorkspaceSelection(f.root,{...first,hook_event_name:'PostToolUse'},f.env);
  const current=(await readState(f.root,f.env)).state.workspace.grants[g.id];
  assert.equal(current.questions.length,4);
  for(const q of current.questions){ assert.ok(q.options.length>=2&&q.options.length<=4);assert.doesNotMatch(q.question,/type Back|Use Other/); }
  assert.equal(await recordWorkspaceSelection(f.root,{...first,hook_event_name:'PostToolUse'},f.env),null);
  assert.equal(await choose(f,g.id,['example-model']),null);
  await assert.rejects(applyWorkspaceGrant(f.root,g.id,f.env),/Choose/);
  const selected=await choose(f,g.id,['example-model','Keep current','Whole project','Apply']);
  const result=await applyWorkspaceGrant(f.root,g.id,f.env);
  assert.equal(result.summary,selected.summary);
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

test('1.10.4 Back preserves pending selections, Keep current does not copy them across scopes until Apply',async t=>{
  const f=await fixture(t),g=await grant(f);
  await picks(f,g,['Models',['example-model','Keep current','Whole project','Back']]);
  assert.equal((await workspaceStatus(f.root,f.env)).values['partners.codex.model'],null);
  await picks(f,g,['Models',['Keep current','Keep current','Keep current','Apply']]);
  const result=await applyWorkspaceGrant(f.root,g.id,f.env);
  assert.equal(result.values['partners.codex.model'],'example-model');
  assert.equal(result.sources['partners.codex.model'],'project');
});
test('1.10.4 unavailable saved model does not borrow a different model’s effort list',async t=>{
  const f=await fixture(t);await apply(f,'partners.codex.model=removed-model');
  const g=await grant(f);await choose(f,g.id,'Models');
  const current=(await readState(f.root,f.env)).state.workspace.grants[g.id];
  assert.deepEqual(current.questions[1].options.map(o=>o.label),['Keep current','Default']);
  assert.match(current.questions[1].question,/unavailable/);
});

test('1.10.4 Other accepts exact off-page models and the newly selected model’s reported effort', async t => {
  const f = await fixture(t), g = await grant(f);
  await choose(f, g.id, 'Models');
  const screen = (await readState(f.root, f.env)).state.workspace.grants[g.id].questions;
  for (const id of ['example-model', 'main-model', 'task-model', 'native-default']) assert.ok(screen[0].question.includes(id));
  assert.match(screen[1].question, /Available effort levels: medium, high, xhigh/);
  assert.ok(!screen[0].options.some(o => o.label === 'main-model'));
  assert.ok(!screen[1].options.some(o => o.label === 'ultra'));
  await choose(f, g.id, ['main-model', 'ultra', 'Whole project', 'Apply']);
  const result = await applyWorkspaceGrant(f.root, g.id, f.env);
  assert.equal(result.values['partners.codex.model'], 'main-model');
  assert.equal(result.values['partners.codex.effort'], 'ultra');
  const task = await grant(f);
  await picks(f, task, ['Who does what', ['Documentation', 'Continue'], ['Both', 'Only this conversation', 'Keep current', 'Model options']]);
  const taskScreen = (await readState(f.root, f.env)).state.workspace.grants[task.id].questions;
  assert.match(taskScreen[1].question, /Available effort levels: high, ultra/);
  await choose(f, task.id, ['task-model', 'xhigh', 'Keep current', 'Apply']);
  const taskResult = await applyWorkspaceGrant(f.root, task.id, f.env);
  assert.equal(taskResult.values['roles.docs.executor'], 'both');
  assert.equal(taskResult.values['roles.docs.model'], 'task-model');
  assert.equal(taskResult.values['roles.docs.effort'], 'xhigh');
});

test('1.10.4 unknown answers re-open the same screen without losing pending choices or saving', async t => {
  const f = await fixture(t), g = await grant(f), before = (await workspaceStatus(f.root, f.env)).values;
  await picks(f, g, ['Models', ['example-model', 'More effort levels', 'Whole project', 'Apply']]);
  const pending = (await readState(f.root, f.env)).state.workspace.grants[g.id].flow;
  for (const labels of [
    ['unlisted-model', 'Keep current', 'Keep current', 'Apply'],
    [' main-model', 'Keep current', 'Keep current', 'Apply'],
    ['Main-model', 'Keep current', 'Keep current', 'Apply'],
    ['main-model', 'xhigh', 'Keep current', 'Apply'],
    ['Keep current', 'invented', 'Keep current', 'Apply'],
    ['Keep current', 'Keep current', 'invented', 'Apply'],
    ['Keep current', 'Keep current', 'Keep current', 'invented']
  ]) {
    const retry = await choose(f, g.id, labels);
    assert.match(retry.questions[0].question, /Please pick one of the choices/);
    assert.equal(retry.selection, undefined);
    const stored = (await readState(f.root, f.env)).state.workspace.grants[g.id];
    assert.equal(stored.questionToolId, null);
    assert.equal(stored.flow.stage, pending.stage);
    assert.equal(stored.flow.scope, pending.scope);
    assert.deepEqual(stored.flow.draft, pending.draft);
    await assert.rejects(applyWorkspaceGrant(f.root, g.id, f.env), /Choose/);
    assert.deepEqual((await workspaceStatus(f.root, f.env)).values, before);
  }
  await choose(f, g.id, ['Keep current', 'Keep current', 'Keep current', 'Apply']);
  const result = await applyWorkspaceGrant(f.root, g.id, f.env);
  assert.equal(result.values['partners.codex.model'], 'example-model');
  assert.equal(result.sources['partners.codex.model'], 'project');
});

test('1.10.4 typed choices do not bypass missing catalog or Claude host-managed controls', async t => {
  const f = await fixture(t);
  const missing = await issueWorkspaceGrant(f.root, { command_name: 'fabex:settings', command_args: '', session_id: 'a', expansion_type: 'slash_command', command_source: 'plugin' }, f.env, { catalog: async () => ({ models: [], error: 'Catalog unavailable.' }) });
  await choose(f, missing.id, 'Models');
  const retry = await choose(f, missing.id, ['example-model', 'high', 'Whole project', 'Apply']);
  assert.match(retry.questions[0].question, /Catalog unavailable/);
  assert.match(retry.questions[0].question, /Available models: none reported/);
  assert.equal(retry.selection, undefined);
  const host = await grant(f);
  await picks(f, host, ['Who does what', ['Documentation', 'Continue'], ['Claude', 'Keep current', 'Keep current', 'Model options']]);
  const hostRetry = await choose(f, host.id, ['main-model', 'ultra', 'Keep current', 'Apply']);
  assert.match(hostRetry.questions[0].question, /host controls/);
  assert.match(hostRetry.questions[0].question, /Please pick one of the choices/);
  assert.equal(hostRetry.selection, undefined);
});
