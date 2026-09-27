import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath, symlink, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { registerSession, issueWorkspaceGrant, applyWorkspaceGrant, recordWorkspaceSelection, recordWorkspaceQuestion, workspaceStatus } from '../../scripts/lib/workspace.mjs';
import { resolveSettings } from '../../scripts/lib/workspace-settings.mjs';
import { discoverTracker } from '../../scripts/lib/tracker-discovery.mjs';
import { settingsView } from '../../scripts/lib/settings-view.mjs';
import { usageControl } from '../../scripts/lib/usage-integration.mjs';
import { classifyToolUse, readOnlySed, workCommandDenial } from '../../scripts/hook-route-guard.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1102-'))), root = join(dir, 'project'); await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'private'), HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), AI_USAGE_TRACKER: '', AI_USAGE_TRACKER_DATA: join(dir, 'data'), PATH: '/usr/bin:/bin' };
  const { paths } = await initializeState(root, env); await registerSession(root, { session_id: 'a' }, env);
  t.after(() => rm(dir, { recursive: true, force: true })); return { dir, root, env, paths };
}
const grant = (f, args, session = 'a', command = 'settings') => issueWorkspaceGrant(f.root, { command_name: `fabex:${command}`, command_args: args, session_id: session, expansion_type: 'slash_command', command_source: 'plugin' }, f.env, { catalog: async () => ({models:[],error:'Model list unavailable in fixture.'}) });
const apply = async (f, args, session = 'a', command) => applyWorkspaceGrant(f.root, (await grant(f, args, session, command)).id, f.env);
function answer(g, scope = 'This milestone', mode = 'On') {
  return { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: g.sessionId, tool_use_id: 'fixture-choice', tool_input: { questions: g.questions }, tool_response: { answers: Object.fromEntries(g.questions.map((q, n) => [q.question, g.flow?.stage === 'tracking' ? [mode,scope,'Apply'][n] : scope])) } };
}
async function packageAt(path) {
  await mkdir(join(path, '.claude-plugin'), { recursive: true }); await mkdir(join(path, 'skills/weekly-tracker'), { recursive: true });
  await writeFile(join(path, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'ai-usage-tracker' }));
  await writeFile(join(path, 'usage_tracker.py'), '# fixture'); await writeFile(join(path, 'skills/weekly-tracker/SKILL.md'), '---\nname: weekly-tracker\n---\n');
  await writeFile(join(path, 'track'), '#!/bin/sh\nexit 99\n'); await chmod(join(path, 'track'), 0o755); return join(path, 'track');
}
test('1.10.2 discovery validates identity, deduplicates sources, refuses ambiguity and honors override', async t => {
  const f = await fixture(t), one = await packageAt(join(f.dir, 'one'));
  const skillRoot = join(f.env.HOME, '.agents/skills'); await mkdir(skillRoot, { recursive: true });
  await symlink(join(f.dir, 'one/skills/weekly-tracker'), join(skillRoot, 'weekly-tracker'));
  assert.equal((await discoverTracker({}, f.env)).path, one);
  f.env.AI_USAGE_TRACKER = one;
  await mkdir(join(f.env.CLAUDE_CONFIG_DIR, 'plugins'), { recursive: true });
  await writeFile(join(f.env.CLAUDE_CONFIG_DIR, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'ai-usage-tracker@test': [{ installPath: join(f.dir, 'one') }] } }));
  assert.equal((await discoverTracker({}, f.env)).candidates.length, 1);
  const two = await packageAt(join(f.dir, 'two')); f.env.PATH = join(f.dir, 'two');
  assert.equal((await discoverTracker({}, f.env)).status, 'ambiguous');
  assert.equal((await discoverTracker({ 'usageTracker.path': two }, f.env)).path, two);
  assert.equal((await discoverTracker({ 'usageTracker.path': join(f.dir, 'missing') }, f.env)).status, 'invalid');
  await rm(join(f.dir, 'two/.claude-plugin'), { recursive: true });
  assert.equal((await discoverTracker({}, f.env)).path, one);
});
test('1.10.2 milestone inheritance persists across chats and thread rollovers without leaking to new milestones', async t => {
  const f = await fixture(t);
  await apply(f, 'tracking=on scope=project'); await apply(f, 'tracking=off scope=milestone');
  await registerSession(f.root, { session_id: 'b' }, f.env);
  assert.equal((await workspaceStatus(f.root, f.env, 'b')).tracking.effective, 'off');
  await updateState(f.root, s => { s.partner.thread.threadId = 'successor'; s.generation++; return s; }, {}, f.env);
  assert.equal((await workspaceStatus(f.root, f.env, 'b')).tracking.source, 'milestone');
  await apply(f, 'Second', 'b', 'milestone');
  assert.equal((await workspaceStatus(f.root, f.env, 'b')).tracking.effective, 'on');
  await apply(f, 'legacy', 'b', 'milestone'); await apply(f, 'tracking=inherit scope=milestone', 'b');
  assert.equal((await workspaceStatus(f.root, f.env, 'a')).tracking.effective, 'on');
  await apply(f, 'tracking=off scope=session', 'a');
  assert.equal((await workspaceStatus(f.root, f.env, 'a')).tracking.effective, 'off');
  assert.equal((await workspaceStatus(f.root, f.env, 'b')).tracking.effective, 'on');
});
test('1.10.2 only exact owner dialog answers select a one-use scoped grant', async t => {
  const f = await fixture(t); await apply(f,'Plan stage','a','milestone'); const g = await grant(f, 'tracking=on');
  await assert.rejects(applyWorkspaceGrant(f.root, g.id, f.env), /Choose/);
  assert.equal(await recordWorkspaceSelection(f.root, answer(g), f.env), null);
  await recordWorkspaceQuestion(f.root, { ...answer(g), hook_event_name: 'PreToolUse' }, f.env);
  assert.equal(await recordWorkspaceSelection(f.root, { ...answer(g), tool_use_id: 'different-question' }, f.env), null);
  assert.equal(await recordWorkspaceSelection(f.root, { ...answer(g), session_id: 'other' }, f.env), null);
  assert.equal(await recordWorkspaceSelection(f.root, { ...answer(g), agent_id: 'subagent' }, f.env), null);
  const retry = await recordWorkspaceSelection(f.root, answer(g, 'invented'), f.env);
  assert.match(retry.questions[0].question, /Please pick one of the choices/);
  Object.assign(g, (await readState(f.root, f.env)).state.workspace.grants[g.id]);
  await recordWorkspaceQuestion(f.root, { ...answer(g), hook_event_name: 'PreToolUse' }, f.env);
  assert.equal(await recordWorkspaceSelection(f.root, { ...answer(g), tool_response: {} }, f.env), null);
  const altered = answer(g); altered.tool_input = { questions: [] };
  assert.equal(await recordWorkspaceSelection(f.root, altered, f.env), null);
  assert.equal((await recordWorkspaceSelection(f.root, answer(g), f.env)).selection, 'tracking="on" scope=milestone');
  await applyWorkspaceGrant(f.root, g.id, f.env);
  assert.equal((await workspaceStatus(f.root, f.env)).tracking.source, 'milestone');
  await assert.rejects(applyWorkspaceGrant(f.root, g.id, f.env), /grant/);
  const expired = await grant(f, '');
  await updateState(f.root, s => { s.workspace.grants[expired.id].expiresAt = 1; s.generation++; return s; }, {}, f.env);
  assert.equal(await recordWorkspaceSelection(f.root, answer(expired), f.env), null);
  const stale = await grant(f, ''); await apply(f, 'Second', 'a', 'milestone');
  assert.equal(await recordWorkspaceSelection(f.root, answer(stale), f.env), null);
});
test('1.10.2 bare settings offers tracked choices and preserves human/JSON CLI views', async t => {
  const f = await fixture(t), g = await grant(f, '');
  assert.deepEqual(g.questions[0].options.map(o => o.label), ['Models', 'Who does what', 'Weekly usage', 'Cancel']);
  const invokeHook = (name, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL(`../../scripts/${name}`, import.meta.url).pathname], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = '';
    child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    child.stdin.end(JSON.stringify({ ...input, cwd: f.root }));
  });
  let current = g;
  for (const pick of ['Unknown section', 'Weekly usage', 'Whole project']) {
    const pre = await invokeHook('hook-route-guard.mjs', { ...answer(current, pick), hook_event_name: 'PreToolUse' });
    assert.notEqual(pre.hookSpecificOutput?.permissionDecision, 'deny');
    const receipt = await invokeHook('hook-heavy.mjs', answer(current, pick));
    assert.match(receipt.hookSpecificOutput.additionalContext, pick === 'Whole project' ? /Owner selection recorded: tracking="on" scope=project/ : /Continue the owner settings dialog/);
    if (pick === 'Unknown section') assert.match(receipt.hookSpecificOutput.additionalContext, /Please pick one of the choices/);
    current = (await readState(f.root, f.env)).state.workspace.grants[g.id];
  }
  await applyWorkspaceGrant(f.root, g.id, f.env);
  const status = await workspaceStatus(f.root, f.env);
  const view = await settingsView(status, f.env);
  assert.match(view, /Milestone: none chosen yet/); assert.doesNotMatch(view, /scope=|roles\./); assert.match(view, /plugin install ai-usage-tracker@ai-usage-tracker/);
  const cli = new URL('../../scripts/control.mjs', import.meta.url).pathname;
  const human = await exec(process.execPath, [cli, 'settings', '--session', 'a'], { cwd: f.root, env: f.env });
  assert.match(human.stdout, /Weekly usage: on \(project default\)/);
  const json = await exec(process.execPath, [cli, 'settings', '--session', 'a', '--json'], { cwd: f.root, env: f.env });
  assert.equal(JSON.parse(json.stdout).tracking.effective, 'on');
  await assert.rejects(issueWorkspaceGrant(f.root, { command_name: 'settings', command_args: 'tracking=on' }, f.env), /owner-typed/);
});
test('1.10.2 discovery integrates without calling the tracker when disabled or ambiguous', async t => {
  const f = await fixture(t); let calls = 0;
  const run = async () => { calls++; return { stdout: '{}' }; };
  assert.equal(await usageControl(f.root, ['report'], f.env, run), null);
  f.env.AI_USAGE_TRACKER = await packageAt(join(f.dir, 'one'));
  await apply(f, 'tracking=on scope=milestone');
  await usageControl(f.root, ['report'], f.env, run); assert.equal(calls, 1);
  await packageAt(join(f.dir, 'two')); f.env.PATH = join(f.dir, 'two');
  assert.equal((await usageControl(f.root, ['snapshot', '--event', 'start'], f.env, run)).status, 'ambiguous'); assert.equal(calls, 1);
});
test('1.10.2 find/grep sed formatting works while indirect writes and sed execution remain denied', async t => {
  const f = await fixture(t), { state } = await readState(f.root, f.env);
  const safe = ["find . -type f | sed -n '1,20p'", "grep pattern file | sed 's/a/b/g'", "find . -type f | sed 's#^./##'"];
  const unsafe = ["find . | xargs sed -i '' 's/a/b/'", "find . | sed -n '1w output'", "grep x file | sed 's/x/y/w output'", "grep x file | sed 's/x/id/e'", "find . -exec sed -i 's/a/b/' '{}' ';'", "find . | xargs tee output"];
  for (const route of ['normal', 'discussion']) for (const command of safe) assert.notEqual((await classifyToolUse({ state: { ...state, route }, paths: f.paths, toolName: 'Bash', toolInput: { command }, config: {} })).decision, 'deny', command);
  for (const command of unsafe) assert.ok(workCommandDenial(command, f.root), command);
  assert.equal(readOnlySed(['-n', '-e', 's/a/b/e']), false);
});
