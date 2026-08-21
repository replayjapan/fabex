import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyToolUse, classifyUnhealthyToolUse, parseControlCommand, protectedGithubOperation } from '../../scripts/hook-route-guard.mjs';
import { PLUGIN_ROOT, projectIdFor } from '../../scripts/lib/paths.mjs';
import { initialState } from '../../scripts/lib/state.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fabex-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { canonicalRoot: root, projectId: projectIdFor(root) };
  return { root, paths, state: initialState(paths) };
}

async function decision(ctx, toolName, toolInput, executor) {
  return (await classifyToolUse({ toolName, toolInput, state: ctx.state, paths: ctx.paths, executor })).decision;
}

test('normal route defers every well-formed tool to native policy', async (t) => {
  const ctx = await fixture(t);
  for (const [name, input] of [
    ['Read', { file_path: 'x' }], ['Write', { file_path: 'x', content: 'y' }],
    ['Bash', { command: 'printenv' }], ['mcp__unknown__mutate', { target: 'x' }], ['Browser', { url: 'x' }]
  ]) assert.equal(await decision(ctx, name, input), 'defer', name);
});

test('main-session GitHub pushes and gh operations are denied', async (t) => {
  const ctx = await fixture(t);
  for (const command of [
    'git push origin main',
    '/usr/bin/git -C project push origin main',
    'git send-pack origin refs/heads/main',
    'git lfs push origin main',
    'gh pr create --fill',
    'npm test && git push origin main',
    'git push; printf done',
    'gh; printf done',
    "sh -c 'git push origin main'"
  ]) {
    assert.ok(protectedGithubOperation(command), command);
    assert.equal(await decision(ctx, 'Bash', { command }), 'deny', command);
  }
  assert.equal(await decision(ctx, 'Bash', { command: 'git status --short' }), 'defer');
  assert.equal(await decision(ctx, 'Bash', { command: "printf '%s' 'git push origin main'" }), 'defer');
});

test('verified plugin-scoped fabex-operational subagent may execute protected GitHub operations', async (t) => {
  const ctx = await fixture(t);
  const executor = { agentId: 'agent-123', agentType: 'fabex:fabex-operational' };
  assert.equal(await decision(ctx, 'Bash', { command: 'git push origin main' }, executor), 'defer');
  assert.equal(await decision(ctx, 'Bash', { command: 'gh pr create --fill' }, executor), 'defer');
});

test('protected GitHub operations fail closed on ambiguous or alternate executor identity', async (t) => {
  const ctx = await fixture(t);
  for (const executor of [
    { agentType: 'fabex:fabex-operational' },
    { agentId: 'agent-123' },
    { agentId: '', agentType: 'fabex:fabex-operational' },
    { agentId: 'agent-123', agentType: 'fabex-operational' },
    { agentId: 'agent-123', agentType: 'other:fabex-operational' },
    { agentId: 'agent-123', agentType: 'general-purpose' }
  ]) assert.equal(await decision(ctx, 'Bash', { command: 'git push' }, executor), 'deny');
});

test('all read-only routes defer reads and deny writes', async (t) => {
  const ctx = await fixture(t);
  for (const route of ['discussion', 'ask-once', 'recovery-read-only']) {
    ctx.state.route = route;
    for (const tool of ['Read', 'Glob', 'Grep']) assert.equal(await decision(ctx, tool, {}), 'defer', `${route} ${tool}`);
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) assert.equal(await decision(ctx, tool, {}), 'deny', `${route} ${tool}`);
  }
});

test('Fabex namespaced skills and exact bare route skills defer read-only', async (t) => {
  const ctx = await fixture(t);
  ctx.state.route = 'discussion';
  assert.equal(await decision(ctx, 'Skill', { skill: 'fabex:jointly' }), 'defer');
  assert.equal(await decision(ctx, 'Skill', { skill: 'askCodex' }), 'defer');
  assert.equal(await decision(ctx, 'SlashCommand', { command: '/work' }), 'defer');
  assert.equal(await decision(ctx, 'Skill', { skill: 'jointly' }), 'deny');
  assert.equal(await decision(ctx, 'Skill', { skill: 'other:work' }), 'deny');
});

test('exact controls parse and composed lookalikes do not', async (t) => {
  const ctx = await fixture(t);
  ctx.state.route = 'discussion';
  const control = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
  for (const command of [
    `node ${control} status`, `node ${control} config`, `node ${control} diagnose`,
    `node ${control} mode normal`, `node ${control} mode discussion`, `node ${control} mode ask-once`,
    `node ${control} mode normal --participants both`,
    `node ${control} mode normal --participants claude`,
    `node ${control} mode discussion --participants codex`,
    `node ${control} mode ask-once --participants claude`,
    `node ${control} thread begin primary`,
    `node ${control} thread begin write`,
    `node ${control} thread complete 11111111-1111-4111-8111-111111111111 --thread-id thread-123`,
    `node ${control} thread complete 11111111-1111-4111-8111-111111111111 --job-id task-m123abc-abc123`,
    `node ${control} thread checkpoint --decision 'accepted direction'`
  ]) assert.equal(await decision(ctx, 'Bash', { command }), 'defer', command);
  assert.equal(parseControlCommand(`node ${control} mode discussion --participants neither`), null);
  assert.equal(parseControlCommand(`node ${control} mode discussion --participants both extra`), null);
  assert.equal(parseControlCommand(`node ${control} mode normal extra`), null);
  assert.equal(await decision(ctx, 'Bash', { command: `node ${control} status; node other.mjs` }), 'deny');
});

test('config and recovery controls remain available for unhealthy state', () => {
  const control = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
  const id = '11111111-1111-4111-8111-111111111111';
  const commands = [
    `node ${control} status`, `node ${control} config`, `node ${control} diagnose`,
    `node ${control} recover clear-dead-lock`,
    `node ${control} recover inspect --operation-id ${id}`,
    `node ${control} recover retry --operation-id ${id}`,
    `node ${control} recover abandon --operation-id ${id}`,
    `node ${control} recover resolve-transaction --commit`,
    `node ${control} recover resolve-transaction --discard`
  ];
  for (const command of commands) assert.equal(classifyUnhealthyToolUse({ toolName: 'Bash', toolInput: { command }, health: 'corrupt' }).decision, 'defer', command);
  assert.equal(classifyUnhealthyToolUse({ toolName: 'Bash', toolInput: { command: `node ${control} mode normal` }, health: 'corrupt' }).decision, 'deny');
});

test('read-only routes accept only canonical read-only companion forms', async (t) => {
  const ctx = await fixture(t);
  const companionRoot = join(ctx.root, 'companion');
  const script = join(companionRoot, 'scripts', 'codex-companion.mjs');
  await mkdir(join(companionRoot, 'scripts'), { recursive: true });
  await writeFile(script, '');
  const before = process.env.FABEX_CODEX_PLUGIN_ROOT;
  process.env.FABEX_CODEX_PLUGIN_ROOT = companionRoot;
  t.after(() => before === undefined ? delete process.env.FABEX_CODEX_PLUGIN_ROOT : process.env.FABEX_CODEX_PLUGIN_ROOT = before);
  const job = 'task-m123abc-abc123';
  const allowed = [
    `node ${script} task --json --cwd ${ctx.root} --fresh --effort ultra 'question'`,
    `node ${script} task --json --background --cwd ${ctx.root} --fresh --model gpt-5.6 --effort xhigh 'question'`,
    `node ${script} task --json --cwd ${ctx.root} --resume --effort high 'follow up'`,
    `node ${script} task --json --background --cwd ${ctx.root} --resume-last --model gpt-5.6`,
    `node ${script} status --json --cwd ${ctx.root} ${job}`,
    `node ${script} status --json --wait --cwd ${ctx.root} ${job}`,
    `node ${script} result --json --cwd ${ctx.root} ${job}`
  ];
  for (const route of ['discussion', 'ask-once', 'recovery-read-only']) {
    ctx.state.route = route;
    for (const command of allowed) assert.equal(await decision(ctx, 'Bash', { command }), 'defer', command);
    assert.equal(await decision(ctx, 'Bash', { command: `node ${script} task --json --cwd ${ctx.root} --fresh --write 'change'` }), 'deny');
    assert.equal(await decision(ctx, 'Bash', { command: `node ${script} task --json --cwd ${join(ctx.root, 'other')} --fresh 'question'` }), 'deny');
    assert.equal(await decision(ctx, 'Bash', { command: `node ${script} task --json --cwd ${ctx.root} --fresh --effort 'bad value' 'question'` }), 'deny');
  }
});

test('Claude-only participants deny companion invocations even in normal mode', async (t) => {
  const ctx = await fixture(t);
  const companionRoot = join(ctx.root, 'companion');
  const script = join(companionRoot, 'scripts', 'codex-companion.mjs');
  await mkdir(join(companionRoot, 'scripts'), { recursive: true });
  await writeFile(script, '');
  const before = process.env.FABEX_CODEX_PLUGIN_ROOT;
  process.env.FABEX_CODEX_PLUGIN_ROOT = companionRoot;
  t.after(() => before === undefined ? delete process.env.FABEX_CODEX_PLUGIN_ROOT : process.env.FABEX_CODEX_PLUGIN_ROOT = before);
  ctx.state.participants = 'claude';
  const command = `node ${script} task --json --cwd ${ctx.root} --fresh 'question'`;
  assert.equal(await decision(ctx, 'Bash', { command }), 'deny');
  ctx.state.route = 'discussion';
  assert.equal(await decision(ctx, 'Bash', { command }), 'deny');
  ctx.state.participants = 'both';
  assert.equal(await decision(ctx, 'Bash', { command }), 'defer');
});

test('recovery route denies ordinary Bash and unknown tools', async (t) => {
  const ctx = await fixture(t);
  ctx.state.route = 'recovery-read-only';
  assert.equal(await decision(ctx, 'Bash', { command: 'node ordinary-tool.mjs' }), 'deny');
  assert.equal(await decision(ctx, 'mcp__unknown__read', {}), 'deny');
});
