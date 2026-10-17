import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { missingSessionThreadId, isMissingSessionError, submitOperation, submissionEnvelope, claimNextOperation, runOperation } from '../../scripts/lib/sdk-controller.mjs';
import { recordAuthorizedPrompt } from '../../scripts/lib/hook-evidence.mjs';
import { issueWorkspaceGrant, applyWorkspaceGrant, recordWorkspaceQuestion, recordWorkspaceSelection } from '../../scripts/lib/workspace.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';

const plugin = resolve(import.meta.dirname, '../..'), control = join(plugin, 'scripts/control.mjs');
const missing = id => `Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: no rollout found for thread id ${id} (code -32600)\n`;
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1108-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'private'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') };
  await initializeState(root, env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
async function mutate(f, change) {
  const result = await updateState(f.root, state => { change(state); state.generation++; return state; }, { purpose: 'fixture' }, f.env);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result;
}
const command = (f, args) => spawnSync(process.execPath, [control, ...args], { cwd: f.root, env: f.env, encoding: 'utf8' });

test('1.10.8 missing-thread recognition accepts observed SDK wrappers, not unrelated failures', () => {
  assert.equal(missingSessionThreadId(new Error(missing('thread-one'))), 'thread-one');
  assert.equal(missingSessionThreadId('Session not found for thread_id: thread-two'), 'thread-two');
  assert.equal(isMissingSessionError({ cause: new Error(missing('thread-one')) }), true);
  for (const error of ['network timeout', 'thread/resume: permission denied', 'thread/resume: invalid credentials', 'no rollout found for thread id thread-one (code -1)', missing('one') + missing('two')]) assert.equal(missingSessionThreadId(error), null);
  assert.equal(missingSessionThreadId({ finalResponse: missing('one') }), null, 'an answer is not SDK failure evidence');
});

test('1.10.8 exact missing-thread recovery preserves milestone/history and seeds a replacement; stale errors cannot clear it', async t => {
  const f = await fixture(t);
  const queued = await submitOperation(f.root, submissionEnvelope('Continue the planned task.'), f.env, { spawnRunner: false });
  await mutate(f, state => {
    state.partner.thread.threadId = 'lost-thread'; state.partner.thread.checkpoint.currentTask = 'M003 shared handoff';
  });
  await assert.rejects(runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex: async () => ({
    resumeThread: id => {
      assert.equal(id, 'lost-thread');
      return { runStreamed: async () => { throw new Error(missing(id)); } };
    }
  }) }, f.env), /no rollout found/);
  const before = (await readState(f.root, f.env)).state;
  assert.equal(before.route, 'recovery-read-only');
  const args = ['recover', 'replace-missing-thread', '--operation-id', queued.operationId];
  await mutate(f, state => { state.operations[0].result.error = missing('different-thread'); });
  assert.equal(command(f, args).status, 1);
  assert.equal((await readState(f.root, f.env)).state.partner.thread.threadId, 'lost-thread');
  const activeId = randomUUID();
  await mutate(f, state => {
    state.operations[0].result.error = missing('lost-thread');
    const active = structuredClone(state.operations[0]); active.id = activeId; active.status = 'working';
    state.operations.push(active); state.controller.activeOperationId = activeId;
  });
  const busy = command(f, args); assert.equal(busy.status, 1); assert.match(busy.stderr, /active partner work/);
  await mutate(f, state => { state.operations = state.operations.filter(op => op.id !== activeId); state.controller.activeOperationId = null; });
  const recovered = command(f, args); assert.equal(recovered.status, 0, recovered.stderr);
  let state = (await readState(f.root, f.env)).state;
  assert.equal(state.route, before.ownerSelectedMode.route);
  assert.equal(state.partner.thread.threadId, null);
  assert.equal(state.partner.thread.checkpoint.currentTask, 'M003 shared handoff');
  assert.equal(state.workspace.activeMilestoneId, before.workspace.activeMilestoneId);
  assert.deepEqual(Object.keys(state.workspace.milestones), Object.keys(before.workspace.milestones));
  assert.equal(state.workspace.milestones[state.workspace.activeMilestoneId].parts.at(-1).threadId, 'lost-thread');
  assert.equal(state.operations[0].status, 'failed');
  await recordAuthorizedPrompt(f.root, 'Continue from the shared handoff.', 'a', f.env);
  await submitOperation(f.root, submissionEnvelope('Continue from the shared handoff.'), f.env, { spawnRunner: false });
  const createCodex = async config => {
    assert.match(config.config.developer_instructions, /M003 shared handoff/);
    return { startThread: () => ({ runStreamed: async () => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'replacement-thread' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'Replacement resumed the handoff.' } };
      yield { type: 'turn.completed' };
    })() }) }) };
  };
  await runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex }, f.env);
  assert.equal(command(f, args).status, 1, 'old failure cannot clear the replacement');
  state = (await readState(f.root, f.env)).state;
  assert.equal(state.partner.thread.threadId, 'replacement-thread');
});

test('1.10.8 resumed chat can use only its owner-granted settings dialog in recovery without enabling work', async t => {
  const f = await fixture(t);
  await mutate(f, state => { state.route = 'recovery-read-only'; state.partner.thread.threadId = 'missing-thread'; });
  const input = { command_name: 'fabex:settings', command_args: '', session_id: 'resumed-chat', expansion_type: 'slash_command', command_source: 'plugin' };
  const g = await issueWorkspaceGrant(f.root, input, f.env, { catalog: async () => ({ models: [], error: 'Offline' }) });
  const classify = async (toolName, toolInput, executor = { sessionId: input.session_id }) => {
    const { state, paths } = await readState(f.root, f.env);
    return classifyToolUse({ toolName, toolInput, state, paths, executor, config: {}, env: f.env });
  };
  assert.equal((await classify('AskUserQuestion', { questions: g.questions })).decision, 'defer');
  for (const executor of [{ sessionId: 'other' }, { sessionId: input.session_id, agentId: 'helper' }]) assert.equal((await classify('AskUserQuestion', { questions: g.questions }, executor)).decision, 'deny');
  assert.equal((await classify('AskUserQuestion', { questions: [] })).decision, 'deny');
  await mutate(f, state => { state.workspace.grants[g.id].expiresAt = Date.now() - 1; });
  assert.equal((await classify('AskUserQuestion', { questions: g.questions })).decision, 'deny', 'expired questions are not authorized');
  await mutate(f, state => { state.workspace.grants[g.id].expiresAt = g.expiresAt; });
  async function choose(labels) {
    const grant = (await readState(f.root, f.env)).state.workspace.grants[g.id];
    const event = { tool_name: 'AskUserQuestion', session_id: input.session_id, tool_use_id: `question-${grant.flow.stage}`, tool_input: { questions: grant.questions } };
    await recordWorkspaceQuestion(f.root, { ...event, hook_event_name: 'PreToolUse' }, f.env);
    return recordWorkspaceSelection(f.root, { ...event, hook_event_name: 'PostToolUse', tool_response: { answers: Object.fromEntries(grant.questions.map((q, i) => [q.question, labels[i]])) } }, f.env);
  }
  await choose(['Weekly usage']); await choose(['On', 'Whole project', 'Apply']);
  assert.equal((await classify('Bash', { command: `node ${control} settings apply --grant ${g.id}` })).decision, 'defer');
  assert.equal((await applyWorkspaceGrant(f.root, g.id, f.env)).values['usageTracker.mode'], 'on');
  const state = (await readState(f.root, f.env)).state;
  assert.equal(state.route, 'recovery-read-only'); assert.equal(state.partner.thread.threadId, 'missing-thread');
  assert.equal(state.operations.length, 0);
  assert.equal((await classify('Write', { file_path: join(f.root, 'app.js'), content: 'code' })).decision, 'deny');
  assert.equal((await classify('AskUserQuestion', { questions: g.questions })).decision, 'deny', 'consumed grant cannot be reused');
  const milestone = await issueWorkspaceGrant(f.root, { ...input, command_name: 'fabex:milestone', command_args: 'M003' }, f.env);
  await assert.rejects(applyWorkspaceGrant(f.root, milestone.id, f.env), /not a recovery action/);
  assert.equal((await classify('Bash', { command: `node ${control} settings apply --grant ${milestone.id}` })).decision, 'deny');
});

test('1.10.8 failed settings expansion names settings rather than a mode command', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [join(plugin, 'scripts/hook-mode-grant.mjs')], { cwd: f.root, env: f.env, encoding: 'utf8', input: JSON.stringify({ cwd: f.root, command_name: 'fabex:settings', command_args: 42 }) });
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block'); assert.match(output.reason, /could not open settings/); assert.match(output.reason, /diagnose/); assert.doesNotMatch(output.reason, /verify this mode command/);
});
