import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, appendFile, readFile, readdir, realpath, cp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { registerSession, issueWorkspaceGrant, applyWorkspaceGrant } from '../../scripts/lib/workspace.mjs';
import { indexedGauge } from '../../scripts/lib/transcript-index.mjs';
import { inspectCleanup, cleanupWorkingCopy } from '../../scripts/lib/cleanup.mjs';
import { helperServerOptions } from '../../scripts/lib/sdk-process.mjs';
import { resolveSettings, validateSettings } from '../../scripts/lib/workspace-settings.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { submitOperation, submissionEnvelope, claimRunner, claimNextOperation, operationStatus } from '../../scripts/lib/sdk-controller.mjs';
const exec = promisify(execFile), plugin = new URL('../..', import.meta.url).pathname;
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1101-'))), root = join(dir, 'project'); await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'private') };
  const { paths } = await initializeState(root, env);
  t.after(() => rm(dir, { recursive: true, force: true })); return { dir, root, env, paths };
}
async function grant(f, session, args, command = 'settings') {
  const g = await issueWorkspaceGrant(f.root, { session_id: session, command_name: `fabex:${command}`, command_args: args, expansion_type: 'slash_command', command_source: 'plugin' }, f.env);
  return applyWorkspaceGrant(f.root, g.id, f.env);
}
const title = (sessionId, customTitle) => JSON.stringify({ type: 'custom-title', sessionId, customTitle }) + '\n';
test('1.10.1 old titles, spaces, Unicode and renames preserve identity and one archive', async t => {
  const f = await fixture(t); await registerSession(f.root, { session_id: 'setup' }, f.env);
  await grant(f, 'setup', 'milestones.newChatMeansNewMilestone=true scope=project');
  const transcript = join(f.dir, 'chat.jsonl');
  await writeFile(transcript, title('a', 'Milestone 日本語 One') + ('{}\n'.repeat(100000)));
  await registerSession(f.root, { session_id: 'a', transcript_path: transcript }, f.env);
  let s = (await readState(f.root, f.env)).state, id = s.workspace.activeMilestoneId;
  assert.equal(s.workspace.milestones[id].name, 'Milestone 日本語 One');
  await updateState(f.root, v => { v.partner.thread.threadId = 'same-thread'; v.generation++; return v; }, {}, f.env);
  await appendFile(transcript, title('a', '../Renamed With Spaces'));
  await registerSession(f.root, { session_id: 'a', transcript_path: transcript }, f.env);
  s = (await readState(f.root, f.env)).state;
  assert.equal(s.workspace.activeMilestoneId, id); assert.equal(s.partner.thread.threadId, 'same-thread');
  const dirs = (await readdir(join(f.paths.projectDir, 'chats'))).filter(n => n.endsWith(id));
  assert.equal(dirs.length, 1); assert.match(dirs[0], /Renamed-With-Spaces/);
  const archive = JSON.parse(await readFile(join(f.paths.projectDir, 'chats', dirs[0], 'references.json'), 'utf8'));
  assert.equal(archive.threadId, 'same-thread');
  // Recover two folders created by an older release without losing either record.
  await cp(join(f.paths.projectDir, 'chats', dirs[0]), join(f.paths.projectDir, 'chats', `older--${id}`), { recursive: true });
  await registerSession(f.root, { session_id: 'a', transcript_path: transcript }, f.env);
  assert.equal((await readdir(join(f.paths.projectDir, 'chats'))).filter(n => n.endsWith(id)).length, 1);
  assert.equal((await readdir(join(f.paths.projectDir, 'chats', dirs[0], 'previous-exports'))).length, 1);
  await registerSession(f.root, { session_id: 'b' }, f.env);
  assert.notEqual((await readState(f.root, f.env)).state.workspace.activeMilestoneId, id);
});
test('1.10.1 explicit, legacy and shared milestone names do not follow chat renames', async t => {
  const f = await fixture(t), file = join(f.dir, 'chat.jsonl');
  await writeFile(file, title('a', 'Chat title'));
  await registerSession(f.root, { session_id: 'a', transcript_path: file }, f.env);
  assert.equal((await readState(f.root, f.env)).state.workspace.milestones.legacy.name, 'Legacy');
  await grant(f, 'a', 'Owner name', 'milestone');
  await appendFile(file, title('a', 'Renamed')); await registerSession(f.root, { session_id: 'a', transcript_path: file }, f.env);
  let s = (await readState(f.root, f.env)).state; assert.equal(s.workspace.milestones[s.workspace.activeMilestoneId].name, 'Owner name');
  await updateState(f.root, v => { v.workspace.milestones[v.workspace.activeMilestoneId].nameSource = 'chat'; v.generation++; return v; }, {}, f.env);
  await registerSession(f.root, { session_id: 'b' }, f.env);
  await appendFile(file, title('a', 'Another title')); await registerSession(f.root, { session_id: 'a', transcript_path: file }, f.env);
  s = (await readState(f.root, f.env)).state; assert.equal(s.workspace.milestones[s.workspace.activeMilestoneId].name, 'Owner name');
});
test('1.10.1 gauge counts full history incrementally, retries and handles truncation', async t => {
  const f = await fixture(t), file = join(f.dir, 'rollout.jsonl');
  const token = JSON.stringify({ timestamp: 'sample', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 25 }, model_context_window: 100 } } });
  await writeFile(file, '{"type":"compacted"}\n' + '{}\n'.repeat(200000) + token + '\n');
  let g = await indexedGauge(f.root, file, f.env); assert.equal(g.compactions, 1); assert.match(g.compactionCountCoverage, /whole file/);
  assert.equal(g.lastCall.fraction, .25);
  await appendFile(file, '{"type":"compacted"}\n{"type":');
  g = await indexedGauge(f.root, file, f.env); assert.equal(g.compactions, 2);
  await appendFile(file, '"compacted"}\n');
  assert.equal((await indexedGauge(f.root, file, f.env)).compactions, 3);
  assert.equal((await indexedGauge(f.root, file, f.env)).compactions, 3);
  await writeFile(file, token + '\n'); assert.equal((await indexedGauge(f.root, file, f.env)).compactions, 0);
  await appendFile(file, JSON.stringify({ timestamp: 'now', type: 'compacted', payload: { history: 'x'.repeat(2 * 1024 * 1024) } }) + '\n');
  await appendFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'compacted', body: 'x'.repeat(2 * 1024 * 1024) } }) + '\n');
  g = await indexedGauge(f.root, file, f.env); assert.equal(g.compactions, 1); assert.match(g.compactionCountCoverage, /whole file/);
});
test('1.10.1 settings can be piped without granting a composed mutation', async t => {
  const f = await fixture(t), { state } = await readState(f.root, f.env);
  state.route = 'discussion';
  const classify = command => classifyToolUse({ state, paths: f.paths, toolName: 'Bash', toolInput: { command }, config: {} });
  assert.notEqual((await classify(`node "${plugin}/scripts/control.mjs" settings | head -10`)).decision, 'deny');
  assert.equal((await classify(`node "${plugin}/scripts/control.mjs" settings apply --grant abc | head -10`)).decision, 'deny');
});
test('1.10.1 controller observation during migration neither migrates nor spends budget', async t => {
  const f = await fixture(t), op = await submitOperation(f.root, submissionEnvelope('fixture'), f.env, { spawnRunner: false });
  await claimRunner(f.root, process.pid, f.env); await claimNextOperation(f.root, f.env);
  const s = (await readState(f.root, f.env)).state; s.schemaVersion = 16; delete s.workspace;
  const original = JSON.stringify(s); await writeFile(f.paths.stateFile, original);
  assert.equal((await operationStatus(f.root, op.operationId, f.env)).status, 'working');
  await assert.rejects(exec(process.execPath, [join(plugin, 'scripts/controller.mjs'), 'wait', '--operation-id', op.operationId, '--timeout', '1'], { cwd: f.root, env: f.env }), error => error.code === 3 && JSON.parse(error.stdout).observationHealth === 'migration-deferred');
  assert.equal(await readFile(f.paths.stateFile, 'utf8'), original);
});
test('1.10.1 continuation fields accept clear aliases and historical literal null', async t => {
  const f = await fixture(t);
  await updateState(f.root, s => { s.partner.thread.checkpoint.blocker = 'null'; s.generation++; return s; }, {}, f.env);
  assert.equal((await readState(f.root, f.env)).state.partner.thread.checkpoint.blocker, null);
  await exec(process.execPath, [join(plugin, 'scripts/control.mjs'), 'checkpoint', 'blocker', '--clear'], { cwd: f.root, env: f.env });
  assert.equal((await readState(f.root, f.env)).state.partner.thread.checkpoint.blocker, null);
});
test('1.10.1 helper inheritance remains unchanged and off uses supported per-run overrides', async () => {
  const original = { env: { FABEX_SDK_BINARY: '/fixture/codex' }, config: { preserve: true } };
  assert.equal(await helperServerOptions(original, { helperServers: 'inherit' }, () => { throw Error('must not enumerate'); }), original);
  const result = await helperServerOptions(original, { root: '/fixture', helperServers: 'off' }, async () => ({ stdout: JSON.stringify([{ name: 'test-helper', enabled: true }, { name: 'virtual-disabled', enabled: false }]) }), async () => '[mcp_servers.test-helper]\ncommand="fixture"');
  assert.deepEqual(result.configOverrides, ['mcp_servers.test-helper.enabled=false']);
  await assert.rejects(helperServerOptions(original, { helperServers: 'off' }, async () => ({ stdout: '[]' }), async () => '[mcp_servers."helper.with.dots"]'), /Unsupported/);
  assert.deepEqual(result.config, original.config); assert.equal(resolveSettings({}, {}).values['partners.codex.helperServers'], 'inherit');
  assert.throws(() => validateSettings({ 'partners.codex.helperServers': 'anything' }), /invalid/);
  await assert.rejects(helperServerOptions({}, { helperServers: 'off' }), /unavailable/);
  await assert.rejects(helperServerOptions(original, { helperServers: 'off' }, async () => { throw Error('private-catalog'); }), error => /enumeration failed/.test(error.message) && !error.message.includes('private-catalog'));
});
test('1.10.1 named cleanup refuses unique files and active use, then audits a disposable copy', async t => {
  const f = await fixture(t), source = join(f.dir, 'sample-plugin'), copy = source + '-next2';
  await mkdir(join(source, '.claude-plugin'), { recursive: true });
  await writeFile(join(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }));
  await cp(source, copy, { recursive: true });
  const options = { source, namedSource: true, activeCheck: async () => {} };
  await writeFile(join(copy, 'unique.txt'), 'keep'); await assert.rejects(inspectCleanup(f.root, copy, options), /unique/);
  await rm(join(copy, 'unique.txt'));
  await assert.rejects(inspectCleanup(f.root, copy, { ...options, activeCheck: async () => { throw Error('active'); } }), /active/);
  await symlink(source, join(copy, 'alias')); await assert.rejects(inspectCleanup(f.root, copy, options), /symlink/); await rm(join(copy, 'alias'));
  assert.equal((await cleanupWorkingCopy(f.root, copy, options)).removed, copy);
  assert.equal(JSON.parse(await readFile(join(source, '.claude-plugin/plugin.json'), 'utf8')).name, 'sample');
});
test('1.10.1 human guide precedes preserved AI details', async () => {
  const text = await readFile(join(plugin, 'README.md'), 'utf8');
  assert.ok(text.indexOf('## FOR HUMANS') < text.indexOf('## FOR AI BROTHREN'));
  assert.match(text, /plugin marketplace add replayjapan\/fabex/);
  assert.match(text, /ai-usage-tracker/);
});
