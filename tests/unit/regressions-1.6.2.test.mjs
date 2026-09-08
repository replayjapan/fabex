import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForOperation } from '../../scripts/controller.mjs';
import { modeGrantDecision } from '../../scripts/hook-mode-grant.mjs';
import { classifyUnhealthyToolUse } from '../../scripts/hook-route-guard.mjs';
import { CODEX_REASONING_EFFORTS, loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { codexModelSource, speakerLabels } from '../../scripts/lib/speakers.mjs';
import { boundedUsage, claimNextOperation, reconciliationEnvelope, runOperation, submissionEnvelope, submitOperation } from '../../scripts/lib/sdk-controller.mjs';
import { initializeState, readState } from '../../scripts/lib/state.mjs';

const pluginRoot = resolve(import.meta.dirname, '../..');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-162-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'data'), CLAUDE_CONFIG_DIR: join(directory, 'claude'), CODEX_HOME: join(directory, 'codex') };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env };
}

function run(script, args, project, env, input = '') {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(pluginRoot, 'scripts', script), ...args], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('1.6.2 item 1: dependency upgrade preserves matching SDK and runtime pins', async () => {
  const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(pluginRoot, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.dependencies['@openai/codex-sdk'], '0.153.4');
  assert.equal(lock.packages['node_modules/@openai/codex-sdk'].version, '0.153.4');
  assert.equal(lock.packages['node_modules/@openai/codex'].version, '0.153.4');
  assert.match(await readFile(join(pluginRoot, 'pnpm-lock.yaml'), 'utf8'), /specifier: 0\.153\.4/);
});

test('1.6.2 item 2: speaker families and model sources are explicit, never invented', async (t) => {
  const { project, env } = await fixture(t);
  const config = (await loadEffectiveConfig(project, env)).config;
  assert.deepEqual(speakerLabels('claude-fable-5-1', 'openai/gpt-6-astra'), { claude: 'Claude (Fable):', codex: 'Codex (Astra):' });
  assert.deepEqual(speakerLabels(null, null), { claude: 'Claude (model unknown):', codex: 'Codex:' });
  assert.equal((await codexModelSource(config, env)).source, 'unknown');
  await mkdir(env.CODEX_HOME); await writeFile(join(env.CODEX_HOME, 'config.toml'), 'model = "gpt-6-astra"\n[projects.test]\nmodel = "ignored"\n');
  assert.deepEqual(await codexModelSource(config, env), { id: 'gpt-6-astra', source: 'Codex config default', verified: false });
  config.models.codex.model = 'gpt-5.6-terra';
  assert.equal((await codexModelSource(config, env)).source, 'Fabex config');
  const recorded = await run('hook-session.mjs', [], project, env, JSON.stringify({ hook_event_name: 'SessionStart', cwd: project, session_id: 'session-a', model: 'claude-fable-5-1' }));
  assert.equal(recorded.code, 0, recorded.stderr); assert.match(recorded.stdout, /Claude \(Fable\):/);
  const state = (await readState(project, env)).state;
  assert.equal(state.claudeModel.id, 'claude-fable-5-1'); assert.equal('digest' in state.claudeModel, false);
  const diagnosed = await run('control.mjs', ['diagnose'], project, env);
  assert.equal(JSON.parse(diagnosed.stdout).codex.model.source, 'Codex config default');
});

test('1.6.2 item 3: expansion rewrite removes only host arguments and retains exact owner text', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const text = '日本語\n\nARGUMENTS: owner text stays intact';
  const input = { command_name: 'fabex:discussion', command_source: 'plugin', expansion_type: 'slash_command', session_id: 'session-a', command_args: text, prompt: `Trusted skill body\nARGUMENTS: ${text}` };
  const output = await modeGrantDecision(input, project, env);
  assert.equal(output.hookSpecificOutput.updatedInput, 'Trusted skill body');
  assert.equal((await readState(project, env)).state.modeGrant.ownerMessage, text);
  const fallback = await modeGrantDecision({ ...input, prompt: `/fabex:discussion ${text}` }, project, env);
  assert.match(fallback.hookSpecificOutput.updatedInput, /# Discussion/);
  assert.doesNotMatch(fallback.hookSpecificOutput.updatedInput, /日本語|ARGUMENTS: owner/);
});

test('1.6.2 item 4: wait retries deferred migration without migrating a live runner', async (t) => {
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env);
  await submitOperation(project, submissionEnvelope('owner'), env, { spawnRunner: false });
  const active = await claimNextOperation(project, env);
  const legacy = structuredClone((await readState(project, env)).state);
  legacy.schemaVersion = 9; delete legacy.claudeModel; legacy.operations.forEach((operation) => { delete operation.usage; });
  legacy.controller.runnerPid = process.pid;
  await writeFile(initialized.paths.stateFile, JSON.stringify(legacy));
  const timeout = await waitForOperation(project, active.id, 0.03, env);
  assert.equal(timeout.timedOut, true);
  assert.equal(JSON.parse(await readFile(initialized.paths.stateFile, 'utf8')).schemaVersion, 9);
  let polls = 0;
  const waited = await waitForOperation(project, active.id, 2, env, async () => {
    polls += 1;
    assert.equal(JSON.parse(await readFile(initialized.paths.stateFile, 'utf8')).schemaVersion, 9);
    legacy.controller = { runnerPid: null, activeOperationId: null, wakeWatcher: null };
    legacy.operations[0].status = 'completed'; legacy.operations[0].result.finalResponse = 'done';
    await writeFile(initialized.paths.stateFile, JSON.stringify(legacy));
  });
  assert.equal(polls, 1); assert.equal(waited.timedOut, false); assert.equal(waited.operation.status, 'completed');
  for (const toolName of ['Monitor', 'TaskOutput']) assert.equal(classifyUnhealthyToolUse({ toolName, toolInput: {}, health: 'migration-deferred' }).decision, 'defer');
  for (const [toolName, toolInput] of [['Bash', { command: 'echo x > project.txt' }], ['Write', { file_path: 'project.txt' }], ['mcp__service__create_item', {}]]) assert.equal(classifyUnhealthyToolUse({ toolName, toolInput, health: 'migration-deferred' }).decision, 'deny');
});

test('1.6.2 item 5: SDK source is creation-only and usage is bounded metadata', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  assert.equal(CODEX_REASONING_EFFORTS.has('persistent'), true);
  assert.equal(boundedUsage({ input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 }), null);
  assert.equal(boundedUsage({ input_tokens: Number.MAX_SAFE_INTEGER + 1, cached_input_tokens: 0, output_tokens: 1 }), null);
  const calls = [];
  const createCodex = async () => {
    const thread = (kind, options) => {
      calls.push({ kind, options });
      return { runStreamed: async () => ({ events: (async function* () {
        yield { type: 'thread.started', thread_id: 'same-thread' };
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } };
        yield { type: 'turn.completed', usage: { input_tokens: 123, cached_input_tokens: 100, output_tokens: 12, private_extra: 'discard' } };
      })() }) };
    };
    return { startThread: (options) => thread('start', options), resumeThread: (id, options) => { assert.equal(id, 'same-thread'); return thread('resume', options); } };
  };
  const first = await submitOperation(project, submissionEnvelope('owner'), env, { spawnRunner: false });
  await runOperation(project, await claimNextOperation(project, env), { createCodex }, env);
  await submitOperation(project, reconciliationEnvelope(first.operationId, 'owner', 'visible reply'), env, { spawnRunner: false });
  await runOperation(project, await claimNextOperation(project, env), { createCodex }, env);
  assert.equal(calls[0].options.threadSource, 'fabex'); assert.equal('threadSource' in calls[1].options, false);
  assert.equal(calls[0].options.model, undefined);
  const status = await run('control.mjs', ['status'], project, env);
  assert.deepEqual(JSON.parse(status.stdout).operations[0].usage, { input_tokens: 123, cached_input_tokens: 100, output_tokens: 12 });
});

test('1.6.2 item 6: schema 9 migrates losslessly including unknown owner mode', async (t) => {
  const changelog = await readFile(join(pluginRoot, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## 1\.6\.2 - 2026-09-06/m);
  assert.match(changelog.split('## 1.6.1')[0], /outputSchema.*local_image.*1\.7/);
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env);
  const legacy = structuredClone(initialized.state);
  legacy.schemaVersion = 9; delete legacy.claudeModel;
  legacy.partner.thread.threadId = 'keep-thread'; legacy.partner.thread.checkpoint.acceptedDecisions = ['keep decision'];
  legacy.route = 'discussion'; legacy.ownerSelectedMode = null;
  await writeFile(initialized.paths.stateFile, JSON.stringify(legacy));
  const migrated = await readState(project, env);
  assert.equal(migrated.ok, true); assert.equal(migrated.state.schemaVersion, 15);
  assert.equal(migrated.state.partner.thread.threadId, 'keep-thread'); assert.deepEqual(migrated.state.partner.thread.checkpoint.acceptedDecisions, ['keep decision']);
  assert.equal(migrated.state.ownerSelectedMode, null); assert.equal(migrated.state.claudeModel, null);
});
