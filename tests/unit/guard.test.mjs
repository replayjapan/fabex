import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyToolUse, classifyUnhealthyToolUse, parseControllerCommand, parseControlCommand, protectedGithubOperation } from '../../scripts/hook-route-guard.mjs';
import { PLUGIN_ROOT } from '../../scripts/lib/paths.mjs';
import { initialState } from '../../scripts/lib/state.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fabex-guard-'));
  await mkdir(join(root, 'project'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = join(root, 'project');
  return { state: initialState({ projectId: '0000000000000000', canonicalRoot }), paths: { canonicalRoot } };
}

const classify = (ctx, toolName, toolInput, executor = {}) => classifyToolUse({ toolName, toolInput, state: ctx.state, paths: ctx.paths, executor });

test('normal mode preserves Codex edit authority and the recorded owner-named exception', async (t) => {
  const ctx = await fixture(t);
  assert.equal((await classify(ctx, 'Write', { file_path: join(ctx.paths.canonicalRoot, 'x') })).decision, 'deny');
  assert.equal((await classify(ctx, 'Read', { file_path: join(ctx.paths.canonicalRoot, 'x') })).decision, 'defer');
  ctx.state.partner.thread.checkpoint.acceptedDecisions.push('Executor exception authorized: executor=claude-main; scope=project file edits; reason=owner named');
  assert.equal((await classify(ctx, 'Edit', { file_path: join(ctx.paths.canonicalRoot, 'x') })).decision, 'defer');
  ctx.state.partner.thread.checkpoint.acceptedDecisions.push('Executor exception reconciled: executor=claude-main; scope=project file edits; outcome=done');
  assert.equal((await classify(ctx, 'Edit', { file_path: join(ctx.paths.canonicalRoot, 'x') })).decision, 'deny');
});

test('exact SDK controller entry points are gated and the internal runner is denied', async (t) => {
  const ctx = await fixture(t);
  const controller = resolve(PLUGIN_ROOT, 'scripts', 'controller.mjs');
  const id = '11111111-1111-4111-8111-111111111111';
  const submit = `node ${controller} submit --message 'owner message with $ literal'`;
  assert.equal(parseControllerCommand(submit).kind, 'controller-submit');
  assert.equal((await classify(ctx, 'Bash', { command: submit })).decision, 'defer');
  const heredoc = `node "${controller}" submit <<'FABEX_OWNER_A1B2C3D4'\nowner's $HOME and $(literal)\n\`code\` | symbols\nFABEX_OWNER_A1B2C3D4`;
  assert.equal(parseControllerCommand(heredoc).kind, 'controller-submit');
  assert.equal((await classify(ctx, 'Bash', { command: heredoc })).decision, 'defer');
  for (const action of ['status', 'result', 'cancel']) {
    const command = `node ${controller} ${action} --operation-id ${id}`;
    assert.equal(parseControllerCommand(command).kind, `controller-${action}`);
    assert.equal((await classify(ctx, 'Bash', { command })).decision, 'defer');
  }
  assert.equal((await classify(ctx, 'Bash', { command: `node ${controller} runner --root ${ctx.paths.canonicalRoot}` })).decision, 'deny');
  assert.equal((await classify(ctx, 'Bash', { command: `node ${controller} submit --message x extra` })).decision, 'deny');
});

test('Claude-only mode denies SDK submit while allowing status and cancellation', async (t) => {
  const ctx = await fixture(t);
  ctx.state.participants = 'claude';
  const controller = resolve(PLUGIN_ROOT, 'scripts', 'controller.mjs');
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal((await classify(ctx, 'Bash', { command: `node ${controller} submit --message owner` })).decision, 'deny');
  assert.equal((await classify(ctx, 'Bash', { command: `node ${controller} status --operation-id ${id}` })).decision, 'defer');
  assert.equal((await classify(ctx, 'Bash', { command: `node ${controller} cancel --operation-id ${id}` })).decision, 'defer');
});

test('discussion allows exact SDK controls but denies writes and unrelated effects', async (t) => {
  const ctx = await fixture(t);
  ctx.state.route = 'discussion';
  const controller = resolve(PLUGIN_ROOT, 'scripts', 'controller.mjs');
  assert.equal((await classify(ctx, 'Bash', { command: `node ${controller} submit --message discuss` })).decision, 'defer');
  assert.equal((await classify(ctx, 'Write', { file_path: 'x' })).decision, 'deny');
  assert.equal((await classify(ctx, 'mcp__codex__codex', { prompt: 'obsolete' })).decision, 'deny');
});

test('MCP transport has no special tool gate in normal mode', async (t) => {
  const ctx = await fixture(t);
  assert.equal((await classify(ctx, 'mcp__codex__codex', { prompt: 'not a Fabex path' })).decision, 'defer');
});

test('control parser permits current checkpoint, mode, diagnostic, and recovery paths only', () => {
  const control = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
  const id = '11111111-1111-4111-8111-111111111111';
  for (const command of [
    `node ${control} status`, `node ${control} config`, `node ${control} diagnose`,
    `node ${control} checkpoint decision 'accepted direction'`,
    `node ${control} checkpoint test-status passing`,
    `node ${control} mode discussion --participants both`,
    `node ${control} recover inspect --operation-id ${id}`,
    `node ${control} recover replace-missing-thread --operation-id ${id}`,
    `node ${control} recover abandon --operation-id ${id}`
  ]) assert.ok(parseControlCommand(command), command);
  assert.equal(parseControlCommand(`node ${control} thread begin`), null);
  assert.equal(parseControlCommand(`node ${control} recover retry --operation-id ${id}`), null);
});

test('GitHub push and gh operations remain operational-agent-only', async (t) => {
  const ctx = await fixture(t);
  for (const command of ['git push origin main', 'git send-pack origin', 'git lfs push origin main', 'gh pr create']) assert.ok(protectedGithubOperation(command), command);
  assert.equal((await classify(ctx, 'Bash', { command: 'git push origin main' })).decision, 'deny');
  assert.equal((await classify(ctx, 'Bash', { command: 'git push origin main' }, { agentId: 'agent', agentType: 'fabex:fabex-operational' })).decision, 'defer');
  assert.equal((await classify(ctx, 'Bash', { command: 'git push origin main' }, { agentId: 'agent', agentType: 'fabex-operational' })).decision, 'deny');
});

test('unhealthy and recovery routes permit only bounded status/cancel and recovery controls', async (t) => {
  const ctx = await fixture(t);
  const controller = resolve(PLUGIN_ROOT, 'scripts', 'controller.mjs');
  const control = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
  const id = '11111111-1111-4111-8111-111111111111';
  for (const command of [
    `node ${control} status`, `node ${control} diagnose`, `node ${control} recover inspect --operation-id ${id}`,
    `node ${controller} status --operation-id ${id}`, `node ${controller} result --operation-id ${id}`, `node ${controller} cancel --operation-id ${id}`
  ]) assert.equal(classifyUnhealthyToolUse({ toolName: 'Bash', toolInput: { command }, health: 'corrupt' }).decision, 'defer', command);
  ctx.state.route = 'recovery-read-only';
  assert.equal((await classify(ctx, 'Bash', { command: `node ${controller} submit --message no` })).decision, 'deny');
  assert.equal((await classify(ctx, 'Bash', { command: 'node unrelated.mjs' })).decision, 'deny');
});
