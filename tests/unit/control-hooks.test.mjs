import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readState } from '../../scripts/lib/state.mjs';
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

test('mode controls initialize on first touch and move among healthy routes', async (t) => {
  const { project, env } = await fixture(t);
  const discussion = await run(control, ['mode', 'discussion'], { cwd: project, env });
  assert.equal(discussion.code, 0, discussion.stderr);
  assert.match(discussion.stdout, /normal → discussion/);
  const ask = await run(control, ['mode', 'ask-once'], { cwd: project, env });
  assert.equal(ask.stdout, 'already read-only (discussion)\n');
  const normal = await run(control, ['mode', 'normal'], { cwd: project, env });
  assert.equal(normal.code, 0, normal.stderr);
  assert.equal((await readState(project, env)).state.route, 'normal');
});

test('ask-once reverts on the next user prompt, not SessionStart', async (t) => {
  const { project, env } = await fixture(t);
  await run(control, ['mode', 'ask-once'], { cwd: project, env });
  const start = await run(session, [], { cwd: project, env, input: { cwd: project, hook_event_name: 'SessionStart' } });
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /ask-once/);
  assert.equal((await readState(project, env)).state.route, 'ask-once');
  const prompt = await run(session, [], { cwd: project, env, input: { cwd: project, hook_event_name: 'UserPromptSubmit' } });
  assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /route: normal/);
  assert.equal((await readState(project, env)).state.route, 'normal');
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

test('rendered normal session context stays within 700 UTF-8 bytes', () => {
  const config = { models: { operational: 'm'.repeat(128) }, collaboration: { jointByDefault: true } };
  const context = renderSessionContext('normal', config);
  assert.ok(Buffer.byteLength(context, 'utf8') <= 700, Buffer.byteLength(context, 'utf8'));
  assert.match(context, /Questions authorize answers only; never infer implementation/);
  assert.match(context, /For ANY build, fix, change, or implement request you MUST invoke \/fabex:jointly first/);
  assert.match(context, /Codex alone edits files; never use Write\/Edit, shell, or node scripts/);
  assert.match(context, /never ask the user for write access/);
  assert.match(context, /Design\/judgment questions: jointly gets blind independent views, then converges/);
  assert.match(context, /greetings\/trivial lookups/);
  const delegation = 'You MUST delegate every image or screenshot inspection, GitHub or gh command sequence, and log-dump analysis to fabex-operational; do not perform any part of those in the primary session.';
  assert.ok(context.includes(delegation));
  assert.ok(context.indexOf(delegation) < context.indexOf('/discussion is persistent read-only'));
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
