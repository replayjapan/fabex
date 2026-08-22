import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { classifyToolUse, classifyUnhealthyToolUse, parseControlCommand, protectedGithubOperation } from '../../scripts/hook-route-guard.mjs';
import { PLUGIN_ROOT, projectIdFor } from '../../scripts/lib/paths.mjs';
import { initialState } from '../../scripts/lib/state.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fabex-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { canonicalRoot: root, projectId: projectIdFor(root) };
  return { root, paths, state: initialState(paths) };
}

async function classify(ctx, toolName, toolInput, executor) {
  return classifyToolUse({ toolName, toolInput, state: ctx.state, paths: ctx.paths, executor });
}

function initialInput(root, extra = {}) {
  return {
    prompt: `Fabex partner — ${basename(root)} — continuous session\nOwner request`,
    'approval-policy': 'on-request', cwd: root, sandbox: 'workspace-write',
    config: { model_reasoning_effort: 'high' },
    ...extra
  };
}

function arm(ctx, action, externalId = null) {
  ctx.state.operations = [{ id: '11111111-1111-4111-8111-111111111111', kind: 'partner', name: `fabex:${action}`, status: 'running', externalId }];
  ctx.state.partner.status = 'running';
}

test('normal mode hard-denies Claude main-session Write/Edit/NotebookEdit but defers reads and Bash', async (t) => {
  const ctx = await fixture(t);
  for (const tool of ['Write', 'Edit', 'NotebookEdit']) assert.equal((await classify(ctx, tool, {})).decision, 'deny');
  for (const [tool, input] of [['Read', {}], ['Glob', {}], ['Grep', {}], ['Bash', { command: 'git status --short' }]]) {
    assert.equal((await classify(ctx, tool, input)).decision, 'defer');
  }
  assert.equal((await classify(ctx, 'Write', {}, { agentId: 'subagent', agentType: 'other:agent' })).decision, 'defer');
});

test('owner-named recorded executor exception is the only main-session edit escape', async (t) => {
  const ctx = await fixture(t);
  ctx.state.partner.thread.checkpoint.acceptedDecisions.push('Executor exception authorized: executor=Claude; scope=project file edits; reason=owner named alternate');
  assert.equal((await classify(ctx, 'Write', {})).decision, 'defer');
  ctx.state.partner.thread.checkpoint.acceptedDecisions.push('Executor exception reconciled: executor=Claude; scope=project file edits; outcome=done');
  assert.equal((await classify(ctx, 'Write', {})).decision, 'deny');
});

test('exact Codex MCP tools require a running begin record and validated arguments', async (t) => {
  const ctx = await fixture(t);
  assert.equal((await classify(ctx, 'mcp__codex__codex', initialInput(ctx.root))).decision, 'deny');
  arm(ctx, 'initial');
  assert.equal((await classify(ctx, 'mcp__codex__codex', initialInput(ctx.root))).decision, 'defer');
  assert.equal((await classify(ctx, 'mcp__codex__codex', initialInput(ctx.root, { sandbox: 'read-only' }))).decision, 'deny');
  assert.equal((await classify(ctx, 'mcp__codex__codex', initialInput(ctx.root, { unexpected: true }))).decision, 'deny');
  assert.equal((await classify(ctx, 'mcp__codex__status', {})).decision, 'deny');
  ctx.state.partner.thread.threadId = 'canonical-thread';
  arm(ctx, 'reply', 'canonical-thread');
  assert.equal((await classify(ctx, 'mcp__codex__codex-reply', { prompt: 'continue', threadId: 'canonical-thread' })).decision, 'defer');
  assert.equal((await classify(ctx, 'mcp__codex__codex-reply', { prompt: 'continue', threadId: 'other' })).decision, 'deny');
  assert.equal((await classify(ctx, 'mcp__codex__codex-reply', { prompt: 'continue', threadId: 'canonical-thread', cwd: ctx.root })).decision, 'deny');
});

test('Claude-only modes deny both exact Codex MCP tools', async (t) => {
  const ctx = await fixture(t);
  ctx.state.participants = 'claude';
  arm(ctx, 'initial');
  assert.equal((await classify(ctx, 'mcp__codex__codex', initialInput(ctx.root))).decision, 'deny');
  ctx.state.partner.thread.threadId = 'thread';
  arm(ctx, 'reply', 'thread');
  assert.equal((await classify(ctx, 'mcp__codex__codex-reply', { prompt: 'x', threadId: 'thread' })).decision, 'deny');
});

test('discussion permits exact begin-authorized MCP while still denying Claude write tools', async (t) => {
  const ctx = await fixture(t);
  ctx.state.route = 'discussion';
  arm(ctx, 'initial');
  assert.equal((await classify(ctx, 'mcp__codex__codex', initialInput(ctx.root))).decision, 'defer');
  for (const tool of ['Write', 'Edit', 'NotebookEdit']) assert.equal((await classify(ctx, tool, {})).decision, 'deny');
  for (const tool of ['Read', 'Glob', 'Grep']) assert.equal((await classify(ctx, tool, {})).decision, 'defer');
});

test('main-session GitHub pushes and gh remain denied', async (t) => {
  const ctx = await fixture(t);
  for (const command of ['git push origin main', 'git send-pack origin main', 'git lfs push origin main', 'gh pr create --fill', 'npm test && git push origin main']) {
    assert.ok(protectedGithubOperation(command), command);
    assert.equal((await classify(ctx, 'Bash', { command })).decision, 'deny', command);
  }
});

test('verified plugin-scoped operational subagent may execute protected GitHub operations', async (t) => {
  const ctx = await fixture(t);
  const executor = { agentId: 'agent-123', agentType: 'fabex:fabex-operational' };
  assert.equal((await classify(ctx, 'Bash', { command: 'git push origin main' }, executor)).decision, 'defer');
  for (const bad of [{}, { agentId: 'x', agentType: 'fabex-operational' }, { agentType: 'fabex:fabex-operational' }]) {
    assert.equal((await classify(ctx, 'Bash', { command: 'git push' }, bad)).decision, 'deny');
  }
});

test('exact controls omit removed complete/result and sibling paths', async (t) => {
  const ctx = await fixture(t);
  ctx.state.route = 'discussion';
  const control = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
  const allowed = [
    `node ${control} status`, `node ${control} config`, `node ${control} diagnose`,
    `node ${control} thread begin`,
    `node ${control} thread checkpoint --decision 'accepted direction'`,
    `node ${control} thread checkpoint --status 'bounded status'`,
    `node ${control} mode normal --participants both`
  ];
  for (const command of allowed) assert.equal((await classify(ctx, 'Bash', { command })).decision, 'defer', command);
  for (const command of [
    `node ${control} thread begin primary`,
    `node ${control} thread begin write`,
    `node ${control} thread complete 11111111-1111-4111-8111-111111111111 --thread-id thread`,
    `node ${control} thread complete 11111111-1111-4111-8111-111111111111 --job-id task-old`
  ]) assert.equal(parseControlCommand(command), null, command);
});

test('diagnostic and recovery controls remain available for unhealthy state', () => {
  const control = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
  const id = '11111111-1111-4111-8111-111111111111';
  for (const command of [
    `node ${control} status`, `node ${control} config`, `node ${control} diagnose`,
    `node ${control} recover clear-dead-lock`, `node ${control} recover inspect --operation-id ${id}`,
    `node ${control} recover retry --operation-id ${id}`, `node ${control} recover abandon --operation-id ${id}`,
    `node ${control} recover resolve-transaction --commit`, `node ${control} recover resolve-transaction --discard`
  ]) assert.equal(classifyUnhealthyToolUse({ toolName: 'Bash', toolInput: { command }, health: 'corrupt' }).decision, 'defer');
});

test('recovery route denies ordinary Bash and unrecognized tools', async (t) => {
  const ctx = await fixture(t);
  ctx.state.route = 'recovery-read-only';
  assert.equal((await classify(ctx, 'Bash', { command: 'node ordinary-tool.mjs' })).decision, 'deny');
  assert.equal((await classify(ctx, 'mcp__unknown__read', {})).decision, 'deny');
});
