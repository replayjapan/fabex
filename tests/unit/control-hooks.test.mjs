import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readState, updateState } from '../../scripts/lib/state.mjs';
import { renderSessionContext } from '../../scripts/hook-session.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const control = resolve(root, 'scripts', 'control.mjs');
const session = resolve(root, 'scripts', 'hook-session.mjs');
const guard = resolve(root, 'scripts', 'hook-route-guard.mjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-control-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'data') };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env };
}

async function run(script, args, { cwd, env, input } = {}) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const code = await new Promise((done) => child.once('close', done));
  return { code, stdout, stderr };
}

test('mode controls reach all eight canonical modes and reject normal-codex', async (t) => {
  const { project, env } = await fixture(t);
  const modes = [
    [['mode', 'normal'], 'work'],
    [['mode', 'normal', '--participants', 'claude'], 'workClaude'],
    [['mode', 'discussion'], 'discussion'],
    [['mode', 'discussion', '--participants', 'claude'], 'discussionClaude'],
    [['mode', 'discussion', '--participants', 'codex'], 'discussionCodex'],
    [['mode', 'ask-once'], 'ask'],
    [['mode', 'ask-once', '--participants', 'claude'], 'askClaude'],
    [['mode', 'ask-once', '--participants', 'codex'], 'askCodex']
  ];
  for (const [args, label] of modes) {
    const result = await run(control, args, { cwd: project, env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`(?:-> |unchanged: )${label}\\.`), result.stdout);
  }
  const invalid = await run(control, ['mode', 'normal', '--participants', 'codex'], { cwd: project, env });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /unsupported mode combination/);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'ask-once');
  assert.equal(state.participants, 'codex');
  assert.deepEqual(state.returnTo, { route: 'discussion', participants: 'codex' });
});

test('ask-once reverts on the next user prompt, not SessionStart', async (t) => {
  const { project, env } = await fixture(t);
  await run(control, ['mode', 'ask-once'], { cwd: project, env });
  const start = await run(session, [], { cwd: project, env, input: { cwd: project, hook_event_name: 'SessionStart' } });
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /Fabex mode: ask/);
  assert.equal((await readState(project, env)).state.route, 'ask-once');
  const prompt = await run(session, [], { cwd: project, env, input: { cwd: project, hook_event_name: 'UserPromptSubmit' } });
  assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /Fabex mode: work/);
  assert.equal((await readState(project, env)).state.route, 'normal');
});

test('ask-once restores route and participants from every persistent mode', async (t) => {
  const { directory, env } = await fixture(t);
  const persistent = [
    ['normal', 'both'], ['normal', 'claude'],
    ['discussion', 'both'], ['discussion', 'claude'], ['discussion', 'codex']
  ];
  for (const [route, participants] of persistent) {
    const project = join(directory, `${route}-${participants}`);
    await mkdir(project);
    await run(control, ['mode', route, '--participants', participants], { cwd: project, env });
    await run(control, ['mode', 'ask-once', '--participants', 'both'], { cwd: project, env });
    const armed = (await readState(project, env)).state;
    assert.deepEqual(armed.returnTo, { route, participants });
    const prompt = await run(session, [], { cwd: project, env, input: { cwd: project, hook_event_name: 'UserPromptSubmit' } });
    assert.equal(prompt.code, 0, prompt.stderr);
    const restored = (await readState(project, env)).state;
    assert.equal(restored.route, route);
    assert.equal(restored.participants, participants);
    assert.equal(restored.returnTo, null);
  }
});

test('discussionCodex clears its recorded thread on entry and exit', async (t) => {
  const { project, env } = await fixture(t);
  await run(control, ['status'], { cwd: project, env });
  let current = await readState(project, env);
  await updateState(project, (state) => {
    state.partner.threadId = 'stale-thread';
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation }, env);
  await run(control, ['mode', 'discussion', '--participants', 'codex'], { cwd: project, env });
  assert.equal((await readState(project, env)).state.partner.threadId, null);

  current = await readState(project, env);
  await updateState(project, (state) => {
    state.partner.threadId = 'discussion-thread';
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation }, env);
  await run(control, ['mode', 'normal'], { cwd: project, env });
  assert.equal((await readState(project, env)).state.partner.threadId, null);
});

test('config control prints effective config, all sources, and loaded flags', async (t) => {
  const { project, env } = await fixture(t);
  await mkdir(join(project, '.fabex'));
  await writeFile(join(project, '.fabex', 'config.json'), JSON.stringify({ models: { operational: 'haiku' } }));
  const result = await run(control, ['config'], { cwd: project, env });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.config.models.operational, 'haiku');
  assert.equal(payload.sources.shippedLoaded, true);
  assert.equal(payload.sources.machineLoaded, false);
  assert.equal(payload.sources.projectLoaded, true);
});

test('rendered normal-both session context stays within 700 UTF-8 bytes', () => {
  const config = { models: { operational: 'm'.repeat(128) }, collaboration: { jointByDefault: true }, display: { replyModeBadge: 'always' } };
  const context = renderSessionContext('normal', 'both', config);
  assert.ok(Buffer.byteLength(context, 'utf8') <= 700, Buffer.byteLength(context, 'utf8'));
  assert.match(context, /Questions authorize answers only; never infer implementation/);
  assert.match(context, /For ANY build, fix, change, or implement request you MUST invoke \/fabex:jointly first/);
  assert.match(context, /Codex alone edits files; never use Write\/Edit, shell, or node scripts/);
  assert.match(context, /never ask the user for write access/);
  assert.match(context, /Design\/judgment questions use blind independent views and convergence/);
  assert.match(context, /greetings\/trivial lookups/);
  assert.match(context, /Delegate every image\/screenshot inspection, GitHub\/gh sequence, and log dump to fabex-operational/);
  assert.match(context, /Prefix every reply with \[Fabex: work\]/);
});

test('every other mode has participant-specific bounded context and badge policy', () => {
  const caps = new Map([
    ['normal:claude', 650], ['discussion:both', 400], ['discussion:claude', 300],
    ['discussion:codex', 450], ['ask-once:both', 350], ['ask-once:claude', 300],
    ['ask-once:codex', 350], ['recovery-read-only:both', 180]
  ]);
  const config = { collaboration: { jointByDefault: true }, display: { replyModeBadge: 'changes' } };
  for (const [key, cap] of caps) {
    const [route, participants] = key.split(':');
    const context = renderSessionContext(route, participants, config);
    assert.ok(Buffer.byteLength(context, 'utf8') <= cap, `${key}: ${Buffer.byteLength(context, 'utf8')}`);
    assert.match(context, /Prefix a mode-transition reply/);
  }
  const workClaude = renderSessionContext('normal', 'claude', config);
  assert.match(workClaude, /Questions authorize answers only; never infer implementation/);
  assert.match(workClaude, /Codex alone edits files/);
  assert.match(workClaude, /Do not automatically consult Codex/);
  assert.match(workClaude, /switches to both participants/);
  assert.match(renderSessionContext('discussion', 'both', config), /user message verbatim/);
  assert.match(renderSessionContext('discussion', 'codex', config), /--resume-last/);
  assert.match(renderSessionContext('discussion', 'codex', config), /Claude stays substantively silent/);
  assert.match(renderSessionContext('ask-once', 'both', config), /restores the prior persistent mode/);
  assert.match(renderSessionContext('normal', 'both', { ...config, display: { replyModeBadge: 'off' } }), /Do not add a Fabex reply badge/);
});

test('session and guard resolve payload cwd to the same canonical project root', async (t) => {
  const { directory, project, env } = await fixture(t);
  const alias = join(directory, 'project-alias');
  await symlink(project, alias, 'dir');
  const sessionResult = await run(session, [], { cwd: directory, env, input: { cwd: alias, hook_event_name: 'SessionStart' } });
  assert.equal(sessionResult.code, 0, sessionResult.stderr);
  const guardResult = await run(guard, [], { cwd: directory, env, input: { cwd: alias, tool_name: 'Read', tool_input: { file_path: 'x' } } });
  assert.equal(guardResult.code, 0, guardResult.stderr);
  assert.equal(guardResult.stdout, '{}\n');
  const state = await readState(project, env);
  assert.equal(state.state.project.canonicalRoot, await realpath(project));
});

test('status first touch initializes healthy normal state', async (t) => {
  const { project, env } = await fixture(t);
  const result = await run(control, ['status'], { cwd: project, env });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.health, 'initialized');
  assert.equal(payload.route, 'normal');
  assert.equal(payload.participants, 'both');
  assert.equal(payload.label, 'work');
});

test('PreToolUse guard first touch initializes state from payload cwd', async (t) => {
  const { project, env } = await fixture(t);
  const result = await run(guard, [], { cwd: root, env, input: { cwd: project, tool_name: 'Read', tool_input: { file_path: 'README.md' } } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{}\n');
  const state = await readState(project, env);
  assert.equal(state.ok, true);
  assert.equal(state.state.route, 'normal');
});
