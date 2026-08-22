import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_CODEX_TOOL,
  MCP_REPLY_TOOL,
  beginPartnerOperation,
  buildCheckpointSeed,
  completeMcpToolCall,
  markReattachRequired,
  planMcpCall,
  pruneOperations,
  verifyReturnedThread
} from '../../scripts/lib/mcp-adapter.mjs';
import { initialState, initializeState, readState, updateState } from '../../scripts/lib/state.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-mcp-'));
  const project = join(directory, 'project');
  await mkdir(project);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { project, env: { ...process.env, FABEX_HOME: join(directory, 'data') } };
}

function inputFor(begun, prompt = null) {
  return { prompt: prompt ?? `${begun.plan.seed ?? 'Continue.'}\n\nOwner message`, ...begun.arguments };
}

function response(threadId, text = 'bounded result') {
  return { structuredContent: { threadId }, content: [{ type: 'text', text }] };
}

async function createThread(project, env, threadId = 'thread-1') {
  await initializeState(project, env);
  const begun = await beginPartnerOperation(project, {}, env);
  const toolInput = inputFor(begun);
  await completeMcpToolCall(project, { toolName: begun.toolName, toolInput, toolResponse: response(threadId) }, env);
}

test('plans use one canonical MCP thread across all turns', () => {
  const state = initialState({ projectId: '0000000000000000', canonicalRoot: '/synthetic/project' });
  const initial = planMcpCall(state, '/synthetic/project');
  assert.equal(initial.action, 'initial');
  assert.equal(initial.toolName, MCP_CODEX_TOOL);
  assert.match(initial.seed.split('\n')[0], /^Fabex partner — project — continuous session$/);
  state.partner.thread.threadId = 'thread-a';
  const reply = planMcpCall(state, '/synthetic/project');
  assert.equal(reply.action, 'reply');
  assert.equal(reply.toolName, MCP_REPLY_TOOL);
  assert.equal(reply.expectedThreadId, 'thread-a');
  state.partner.thread.metadata.reattachStatus = 'required';
  const reattach = planMcpCall(state, '/synthetic/project');
  assert.equal(reattach.action, 'reattach');
  assert.match(reattach.seed, /continuity checkpoint/);
});

test('returned thread verification rejects missing and mismatched ids', () => {
  assert.equal(verifyReturnedThread('thread-a', 'thread-a'), 'thread-a');
  assert.throws(() => verifyReturnedThread('thread-a', 'thread-b'), (error) => error.code === 'thread-mismatch');
  assert.throws(() => verifyReturnedThread('thread-a', null), /thread mismatch/i);
});

test('checkpoint seed contains bounded continuity and stale-repository warning', () => {
  const seed = buildCheckpointSeed({ ownerGoals: ['goal'], acceptedDecisions: ['decision'], currentStatus: 'passing' }, '/repo/fabex');
  assert.equal(seed.split('\n')[0], 'Fabex partner — fabex — continuous session');
  assert.match(seed, /goal/);
  assert.match(seed, /decision/);
  assert.match(seed, /earlier file observations are non-authoritative/);
});

test('MCP calls serialize per workstream and continuations keep the exact id', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  const initial = await beginPartnerOperation(project, {}, env);
  await assert.rejects(beginPartnerOperation(project, {}, env), /already running/);
  await completeMcpToolCall(project, {
    toolName: initial.toolName,
    toolInput: inputFor(initial),
    toolResponse: response('canonical-thread', 'first status')
  }, env);
  const reply = await beginPartnerOperation(project, {}, env);
  assert.equal(reply.toolName, MCP_REPLY_TOOL);
  assert.deepEqual(reply.arguments, { threadId: 'canonical-thread' });
  await completeMcpToolCall(project, {
    toolName: reply.toolName,
    toolInput: inputFor(reply, 'second owner turn'),
    toolResponse: response('canonical-thread', 'second status')
  }, env);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.thread.threadId, 'canonical-thread');
  assert.equal(state.partner.thread.metadata.turnCount, 2);
  assert.equal(state.partner.thread.checkpoint.currentStatus, 'second status');
});

test('mismatched continuation fails closed and never adopts the returned id', async (t) => {
  const { project, env } = await fixture(t);
  await createThread(project, env, 'recorded-thread');
  const begun = await beginPartnerOperation(project, {}, env);
  await assert.rejects(completeMcpToolCall(project, {
    toolName: begun.toolName,
    toolInput: inputFor(begun, 'continue'),
    toolResponse: response('unrelated-thread')
  }, env), /thread mismatch/i);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.thread.threadId, 'recorded-thread');
  assert.equal(state.route, 'recovery-read-only');
  assert.equal(state.operations.at(-1).status, 'interrupted');
});

test('restart does one exact-id reattach and a confirmed missing thread authorizes one seeded replacement', async (t) => {
  const { project, env } = await fixture(t);
  await createThread(project, env, 'old-thread');
  await markReattachRequired(project, env);
  const reattach = await beginPartnerOperation(project, {}, env);
  assert.equal(reattach.plan.action, 'reattach');
  assert.equal(reattach.arguments.threadId, 'old-thread');
  const failed = await completeMcpToolCall(project, {
    toolName: reattach.toolName,
    toolInput: inputFor(reattach),
    toolResponse: { isError: true, error: { code: 'thread_not_found' } }
  }, env);
  assert.equal(failed.confirmedMissing, true);
  const replacement = await beginPartnerOperation(project, {}, env);
  assert.equal(replacement.plan.action, 'replacement');
  assert.equal(replacement.toolName, MCP_CODEX_TOOL);
  assert.match(replacement.plan.seed, /one permitted checkpoint-seeded replacement/);
  await completeMcpToolCall(project, {
    toolName: replacement.toolName,
    toolInput: inputFor(replacement),
    toolResponse: response('replacement-thread')
  }, env);
  const next = await beginPartnerOperation(project, {}, env);
  const secondFailure = await completeMcpToolCall(project, {
    toolName: next.toolName,
    toolInput: inputFor(next, 'later turn'),
    toolResponse: { isError: true, error: { code: 'thread_not_found' } }
  }, env);
  assert.equal(secondFailure.confirmedMissing, true);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'recovery-read-only');
  assert.equal(state.partner.thread.metadata.replacementStatus, 'used');
});

test('ambiguous MCP failure is interrupted and never authorizes replacement', async (t) => {
  const { project, env } = await fixture(t);
  await createThread(project, env, 'thread-a');
  const begun = await beginPartnerOperation(project, {}, env);
  const failed = await completeMcpToolCall(project, {
    toolName: begun.toolName,
    toolInput: inputFor(begun, 'continue'),
    toolResponse: { isError: true, error: { code: 'transport_timeout' } }
  }, env);
  assert.equal(failed.confirmedMissing, false);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'recovery-read-only');
  assert.equal(state.partner.thread.metadata.replacementStatus, 'not-needed');
  assert.equal(state.operations.at(-1).status, 'interrupted');
});

test('terminal operation pruning is bounded and preserves unresolved records', () => {
  const terminal = Array.from({ length: 40 }, (_, index) => ({
    id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    kind: 'partner',
    name: `turn:${index}`,
    status: 'completed',
    externalId: `thread-${index}`
  }));
  const running = { id: 'aaaaaaaa-1111-4111-8111-111111111111', kind: 'partner', name: 'turn:reply', status: 'running', externalId: 'thread' };
  const pruned = pruneOperations([...terminal, running]);
  assert.equal(pruned.filter((item) => item.status === 'completed').length, 24);
  assert.equal(pruned.at(-1), running);
  assert.equal(pruned[0].name, 'turn:16');
});
