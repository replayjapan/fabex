import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSessionContext } from '../../scripts/hook-session.mjs';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const control = join(root, 'scripts', 'control.mjs');
const sessionHook = join(root, 'scripts', 'hook-session.mjs');
const resultHook = join(root, 'scripts', 'hook-mcp-result.mjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-control-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'data') };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env };
}

async function run(script, args, { cwd, env, input } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

async function controlRun(project, env, ...args) {
  return run(control, args, { cwd: project, env });
}

async function hookRun(script, project, env, payload) {
  return run(script, [], { cwd: project, env, input: JSON.stringify({ cwd: project, ...payload }) });
}

function completedResponse(threadId, text = 'done') {
  return { structuredContent: { threadId }, content: [{ type: 'text', text }] };
}

test('mode controls reach all eight canonical modes and reject normal-codex', async (t) => {
  const { project, env } = await fixture(t);
  const matrix = [
    ['normal', 'both', 'work'], ['normal', 'claude', 'workClaude'],
    ['discussion', 'both', 'discussion'], ['discussion', 'claude', 'discussionClaude'], ['discussion', 'codex', 'discussionCodex'],
    ['ask-once', 'both', 'ask'], ['ask-once', 'claude', 'askClaude'], ['ask-once', 'codex', 'askCodex']
  ];
  for (const [route, participants, label] of matrix) {
    const changed = await controlRun(project, env, 'mode', route, '--participants', participants);
    assert.equal(changed.code, 0, changed.stderr);
    assert.match(changed.stdout, new RegExp(label));
  }
  const denied = await controlRun(project, env, 'mode', 'normal', '--participants', 'codex');
  assert.equal(denied.code, 1);
});

test('ask-once reverts on the next prompt and Claude-only raw Q&A is not captured', async (t) => {
  const { project, env } = await fixture(t);
  await controlRun(project, env, 'mode', 'discussion', '--participants', 'claude');
  await controlRun(project, env, 'mode', 'ask-once', '--participants', 'claude');
  const submit = await hookRun(sessionHook, project, env, { hook_event_name: 'UserPromptSubmit', prompt: 'private Claude-only question' });
  assert.equal(submit.code, 0, submit.stderr);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'discussion');
  assert.equal(state.participants, 'claude');
  assert.deepEqual(state.partner.thread.checkpoint.ownerGoals, []);
});

test('joint owner prompts are captured while Claude-only prompts remain excluded', async (t) => {
  const { project, env } = await fixture(t);
  await hookRun(sessionHook, project, env, { hook_event_name: 'UserPromptSubmit', prompt: 'joint owner goal' });
  await controlRun(project, env, 'mode', 'normal', '--participants', 'claude');
  await hookRun(sessionHook, project, env, { hook_event_name: 'UserPromptSubmit', prompt: 'Claude-only raw question' });
  const goals = (await readState(project, env)).state.partner.thread.checkpoint.ownerGoals;
  assert.deepEqual(goals, ['joint owner goal']);
});

test('session contexts state canonical MCP continuity and discussion sandbox limit', () => {
  const config = { collaboration: { jointByDefault: true }, display: { replyModeBadge: 'always' } };
  const work = renderSessionContext('normal', 'both', config);
  assert.match(work, /canonical Codex MCP thread/);
  assert.match(work, /Write\/Edit\/NotebookEdit is denied/);
  assert.ok(Buffer.byteLength(work, 'utf8') <= 800);
  const discussion = renderSessionContext('discussion', 'both', config);
  assert.match(discussion, /workspace-write/);
  assert.match(discussion, /cannot mechanically remove its write capability/);
  const claude = renderSessionContext('discussion', 'claude', config);
  assert.match(claude, /do not checkpoint raw Claude-only/i);
});

test('thread begin authorizes exact MCP call and PostToolUse verifies its structured id', async (t) => {
  const { project, env } = await fixture(t);
  const begunResult = await controlRun(project, env, 'thread', 'begin');
  assert.equal(begunResult.code, 0, begunResult.stderr);
  const begun = JSON.parse(begunResult.stdout);
  assert.equal(begun.toolName, 'mcp__codex__codex');
  assert.equal(begun.arguments.sandbox, 'workspace-write');
  const toolInput = { prompt: `${begun.plan.seed}\n\nOwner request`, ...begun.arguments };
  const completed = await hookRun(resultHook, project, env, {
    hook_event_name: 'PostToolUse',
    tool_name: begun.toolName,
    tool_input: toolInput,
    tool_response: completedResponse('canonical-thread')
  });
  assert.equal(completed.code, 0, completed.stderr);
  assert.match(completed.stdout, /verified Codex MCP thread canonical-thread/);
  const reply = JSON.parse((await controlRun(project, env, 'thread', 'begin')).stdout);
  assert.equal(reply.toolName, 'mcp__codex__codex-reply');
  assert.deepEqual(reply.arguments, { threadId: 'canonical-thread' });
});

test('PostToolUse thread mismatch enters recovery and does not adopt the mismatch', async (t) => {
  const { project, env } = await fixture(t);
  const initial = JSON.parse((await controlRun(project, env, 'thread', 'begin')).stdout);
  await hookRun(resultHook, project, env, {
    hook_event_name: 'PostToolUse', tool_name: initial.toolName,
    tool_input: { prompt: initial.plan.seed, ...initial.arguments }, tool_response: completedResponse('thread-a')
  });
  const reply = JSON.parse((await controlRun(project, env, 'thread', 'begin')).stdout);
  await hookRun(resultHook, project, env, {
    hook_event_name: 'PostToolUse', tool_name: reply.toolName,
    tool_input: { prompt: 'continue', ...reply.arguments }, tool_response: completedResponse('thread-b')
  });
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.thread.threadId, 'thread-a');
  assert.equal(state.route, 'recovery-read-only');
  assert.equal(state.operations.at(-1).status, 'interrupted');
});

test('PostToolUseFailure records forced interruption fail-closed', async (t) => {
  const { project, env } = await fixture(t);
  const begun = JSON.parse((await controlRun(project, env, 'thread', 'begin')).stdout);
  const interrupted = await hookRun(resultHook, project, env, {
    hook_event_name: 'PostToolUseFailure',
    tool_name: begun.toolName,
    tool_input: { prompt: begun.plan.seed, ...begun.arguments },
    error: { code: 'transport_interrupted', message: 'forced test interruption' }
  });
  assert.equal(interrupted.code, 0, interrupted.stderr);
  assert.match(interrupted.stdout, /interrupted Codex MCP operation/);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'recovery-read-only');
  assert.equal(state.operations.at(-1).status, 'interrupted');
});

test('Claude-only mode denies MCP begin but allows bounded decision and status checkpoints', async (t) => {
  const { project, env } = await fixture(t);
  await controlRun(project, env, 'mode', 'normal', '--participants', 'claude');
  const denied = await controlRun(project, env, 'thread', 'begin');
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Claude-only mode denies Codex MCP/);
  assert.equal((await controlRun(project, env, 'thread', 'checkpoint', '--decision', 'owner-approved decision')).code, 0);
  assert.equal((await controlRun(project, env, 'thread', 'checkpoint', '--status', 'bounded current status')).code, 0);
  const state = (await readState(project, env)).state;
  assert.deepEqual(state.partner.thread.checkpoint.acceptedDecisions, ['owner-approved decision']);
  assert.equal(state.partner.thread.checkpoint.currentStatus, 'bounded current status');
});

test('SessionStart marks lazy exact-id reattachment without making a model call', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await updateState(project, (state) => {
    state.partner.thread.threadId = 'persisted-thread';
    state.partner.thread.metadata.reattachStatus = 'attached';
    state.generation += 1;
    return state;
  }, { expectedGeneration: 0 }, env);
  const session = await hookRun(sessionHook, project, env, { hook_event_name: 'SessionStart', session_id: 'new-session' });
  assert.equal(session.code, 0, session.stderr);
  const payload = JSON.parse(session.stdout);
  assert.match(payload.hookSpecificOutput.additionalContext, /next Codex turn/);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.thread.threadId, 'persisted-thread');
  assert.equal(state.partner.thread.metadata.reattachStatus, 'required');
  assert.equal(state.operations.length, 0);
});

test('controls and hooks resolve subdirectories to the owning workstream', async (t) => {
  const { project, env } = await fixture(t);
  const child = join(project, 'nested');
  await mkdir(child);
  await controlRun(project, env, 'status');
  const checkpoint = await run(control, ['thread', 'checkpoint', '--decision', 'from child'], { cwd: child, env });
  assert.equal(checkpoint.code, 0, checkpoint.stderr);
  const state = (await readState(project, env)).state;
  assert.deepEqual(state.partner.thread.checkpoint.acceptedDecisions, ['from child']);
});

test('status first touch initializes healthy canonical state', async (t) => {
  const { project, env } = await fixture(t);
  const result = await controlRun(project, env, 'status');
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.health, 'initialized');
  assert.equal(status.partner.transport, 'codex-mcp');
  assert.equal(status.threadContinuity.canonicalThreadId, null);
});
