import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeState, readState } from '../../scripts/lib/state.mjs';
import { registerSession, issueWorkspaceGrant, applyWorkspaceGrant, recordWorkspaceQuestion, recordWorkspaceSelection, workspaceStatus, selectTaskRole, sealReading } from '../../scripts/lib/workspace.mjs';
import { SETTING_DEFAULTS, validateSettings } from '../../scripts/lib/workspace-settings.mjs';
import { startSettingsMenu, menuQuestions, advanceSettingsMenu, validateSettingsMenu } from '../../scripts/lib/settings-menu.mjs';
import { settingsView } from '../../scripts/lib/settings-view.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { recordAuthorizedPrompt } from '../../scripts/lib/hook-evidence.mjs';
import { submitOperation, submissionEnvelope, claimNextOperation, runOperation } from '../../scripts/lib/sdk-controller.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1109-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'state'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') };
  await initializeState(root, env); await registerSession(root, { session_id: 'a' }, env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
const grant = (f, args = '') => issueWorkspaceGrant(f.root, { command_name: 'fabex:settings', command_args: args, session_id: 'a', expansion_type: 'slash_command', command_source: 'plugin' }, f.env, { catalog: async () => ({ models: [], error: null }) });
async function choose(f, id, labels) {
  const g = (await readState(f.root, f.env)).state.workspace.grants[id];
  const event = { tool_name: 'AskUserQuestion', session_id: 'a', tool_use_id: `pick-${g.flow.stage}`, tool_input: { questions: g.questions }, tool_response: { answers: Object.fromEntries(g.questions.map((q, i) => [q.question, labels[i]])) } };
  await recordWorkspaceQuestion(f.root, { ...event, hook_event_name: 'PreToolUse' }, f.env);
  return recordWorkspaceSelection(f.root, { ...event, hook_event_name: 'PostToolUse' }, f.env);
}
async function classify(f, toolName, toolInput, executor = { sessionId: 'a' }) {
  return classifyToolUse({ ...(await readState(f.root, f.env)), config: {}, env: f.env, toolName, toolInput, executor });
}

test('1.10.9 Image review Both applies through recorded tabs and restores Codex; other defaults stay intact', async t => {
  const f = await fixture(t), g = await grant(f);
  assert.equal(SETTING_DEFAULTS['roles.imageReview.executor'], 'codex');
  assert.equal(SETTING_DEFAULTS['roles.docs.executor'], 'both');
  for (const role of ['implementation', 'testWriting', 'testRunning', 'gitDelivery']) assert.throws(() => validateSettings({ [`roles.${role}.executor`]: 'both' }), /invalid/);
  await choose(f, g.id, ['Who does what']); await choose(f, g.id, ['Image review', 'Continue']);
  const screen = (await readState(f.root, f.env)).state.workspace.grants[g.id];
  assert.deepEqual(screen.questions[0].options.map(o => o.label), ['Keep current', 'Claude', 'Codex', 'Both']);
  assert.equal((await workspaceStatus(f.root, f.env)).values['roles.imageReview.executor'], 'codex');
  await choose(f, g.id, ['Both', 'Only this conversation', 'Keep current', 'Apply']);
  assert.equal((await applyWorkspaceGrant(f.root, g.id, f.env)).values['roles.imageReview.executor'], 'both');
  const view = await settingsView(await workspaceStatus(f.root, f.env), f.env);
  assert.match(view, /Image review: Both/); assert.match(view, /Both inspect the same selected images/);
  const reset = await grant(f, 'roles.imageReview.executor=inherit scope=session');
  assert.equal((await applyWorkspaceGrant(f.root, reset.id, f.env)).values['roles.imageReview.executor'], 'codex');
});

test('1.10.9 previously opened version 2 image dialogs remain valid and cannot invent Both', () => {
  const g = startSettingsMenu('', { values: SETTING_DEFAULTS, project: 'project', milestone: null, models: [] });
  g.flow.version = 2; g.flow.stage = 'task'; g.flow.task = 'imageReview'; g.questions = menuQuestions(g.flow);
  assert.deepEqual(g.questions[0].options.map(o => o.label), ['Keep current', 'Claude', 'Codex', 'Default']);
  validateSettingsMenu(g);
  const result = advanceSettingsMenu(g, Object.fromEntries(g.questions.map((q, i) => [q.question, ['Both', 'Keep current', 'Keep current', 'Apply'][i]])));
  assert.equal(result.selection, undefined); assert.match(result.questions[0].question, /Please pick/);
  validateSettingsMenu(g);
});

test('1.10.9 Both permits the bound Claude image read and delivers the same image to Codex without code authority', async t => {
  const f = await fixture(t), image = join(f.root, 'review.png'); await writeFile(image, 'fixture');
  assert.equal((await classify(f, 'Read', { file_path: image })).decision, 'deny');
  await applyWorkspaceGrant(f.root, (await grant(f, 'roles.imageReview.executor=both')).id, f.env);
  await selectTaskRole(f.root, 'imageReview', f.env);
  assert.equal((await classify(f, 'Read', { file_path: image })).decision, 'defer');
  for (const executor of [{ sessionId: 'other' }, { sessionId: 'a', agentId: 'unassigned-helper' }]) assert.equal((await classify(f, 'Read', { file_path: image }, executor)).decision, 'deny');
  assert.equal((await classify(f, 'Edit', { file_path: join(f.root, 'app.js') })).decision, 'deny');
  const owner = 'Review the selected image.'; await recordAuthorizedPrompt(f.root, owner, 'a', f.env);
  const op = await submitOperation(f.root, JSON.stringify({ ...JSON.parse(submissionEnvelope(owner)), attachments: [image] }), f.env, { spawnRunner: false });
  await sealReading(f.root, op.operationId, 'Claude independent image observations.', f.env);
  const createCodex = async () => ({ startThread: () => ({ runStreamed: async input => {
    assert.deepEqual(input[1], { type: 'local_image', path: image });
    assert.doesNotMatch(input[0].text, /Claude independent image observations/);
    return { events: (async function* () {
      yield { type: 'thread.started', thread_id: 'image-both-thread' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'Image reviewed.' } };
      yield { type: 'turn.completed' };
    })() };
  } }) });
  await runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex }, f.env);
  assert.deepEqual((await readState(f.root, f.env)).state.operations[0].result.attachments, [{ index: 0, status: 'delivered' }]);
});
