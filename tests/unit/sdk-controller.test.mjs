import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRecoverySeed, emptyCheckpoint, MAX_RECOVERY_SEED_BYTES } from '../../scripts/lib/checkpoint.mjs';
import {
  cancelOperation,
  claimNextOperation,
  claimRunner,
  isMissingSessionError,
  lifecycleUpdate,
  runOperation,
  releaseRunnerIfIdle,
  reconciliationEnvelope,
  submissionEnvelope,
  submitOperation,
  updateCheckpoint,
  verifyThreadStarted
} from '../../scripts/lib/sdk-controller.mjs';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { runQueue } from '../../scripts/controller.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-sdk-'));
  const project = join(directory, 'project');
  await mkdir(project);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { project, env: { ...process.env, FABEX_HOME: join(directory, 'data') } };
}

function sdkFactory(runs, capture = []) {
  return async (codexOptions) => {
    const makeThread = (kind, id, threadOptions) => ({
      async runStreamed(prompt, turnOptions) {
        capture.push({ kind, id, codexOptions, threadOptions, prompt, turnOptions });
        const next = runs.shift();
        if (next instanceof Error) throw next;
        return { events: (async function* () { for (const event of next) yield event; })() };
      }
    });
    return {
      startThread: (options) => makeThread('start', null, options),
      resumeThread: (id, options) => makeThread('resume', id, options)
    };
  };
}

const completed = (threadId, text = 'done') => [
  { type: 'thread.started', thread_id: threadId },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'a', type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
];

async function queued(project, env, message) {
  const submitted = await submitOperation(project, submissionEnvelope(message), env, { spawnRunner: false });
  const operation = await claimNextOperation(project, env);
  assert.equal(operation.id, submitted.operationId);
  return operation;
}

async function completedCycle(project, env, ownerMessage, createCodex) {
  const phase1 = await queued(project, env, ownerMessage);
  await runOperation(project, phase1, { createCodex, signal: new AbortController().signal }, env);
  const phase2Submission = await submitOperation(project, reconciliationEnvelope(phase1.id, ownerMessage, `Fable review of ${ownerMessage}`), env, { spawnRunner: false });
  const phase2 = await claimNextOperation(project, env);
  assert.equal(phase2.id, phase2Submission.operationId);
  await runOperation(project, phase2, { createCodex, signal: new AbortController().signal }, env);
  return { phase1, phase2 };
}

test('first turn persists thread.started and subsequent queued turns resume the exact id in FIFO order', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await submitOperation(project, submissionEnvelope('first owner message'), env, { spawnRunner: false });
  await submitOperation(project, submissionEnvelope('second owner message'), env, { spawnRunner: false });
  const capture = [];
  const factory = sdkFactory([
    completed('canonical-thread', 'first independent'), completed('canonical-thread', 'first convergence'),
    completed('canonical-thread', 'second independent'), completed('canonical-thread', 'second convergence')
  ], capture);
  const first = await claimNextOperation(project, env);
  await runOperation(project, first, { createCodex: factory, signal: new AbortController().signal }, env);
  assert.equal(await claimNextOperation(project, env), null);
  await submitOperation(project, reconciliationEnvelope(first.id, 'first owner message', 'first Fable response'), env, { spawnRunner: false });
  const second = await claimNextOperation(project, env);
  await runOperation(project, second, { createCodex: factory, signal: new AbortController().signal }, env);
  const nextOwner = await claimNextOperation(project, env);
  await runOperation(project, nextOwner, { createCodex: factory, signal: new AbortController().signal }, env);
  await submitOperation(project, reconciliationEnvelope(nextOwner.id, 'second owner message', 'second Fable response'), env, { spawnRunner: false });
  const final = await claimNextOperation(project, env);
  await runOperation(project, final, { createCodex: factory, signal: new AbortController().signal }, env);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.thread.threadId, 'canonical-thread');
  assert.equal(state.partner.thread.metadata.turnCount, 4);
  assert.deepEqual(state.operations.map((operation) => operation.status), ['completed', 'completed', 'completed', 'completed']);
  assert.equal(capture[0].kind, 'start');
  assert.doesNotMatch(capture[0].prompt, /Fabex continuity checkpoint|first Fable response/);
  assert.match(capture[0].codexOptions.config.developer_instructions, /Fabex continuity checkpoint/);
  assert.equal(capture[1].kind, 'resume');
  assert.equal(capture[1].id, 'canonical-thread');
  assert.match(capture[1].prompt, /^FABEX TURN: phase=reconcile; route=normal; sandbox=workspace-write; participants=both/);
  assert.match(capture[1].prompt, /CODEX PHASE 1 INDEPENDENT READING/);
  assert.match(capture[2].prompt, /OWNER MESSAGE \(verbatim\):\nsecond owner message/);
  assert.equal(capture[0].threadOptions.sandboxMode, 'workspace-write');
  assert.equal(capture[0].threadOptions.approvalPolicy, 'on-request');
  assert.equal(capture[0].codexOptions.apiKey, undefined);
  assert.match(capture[0].codexOptions.config.developer_instructions, /full equal Fabex partner/);
  assert.match(capture[0].codexOptions.config.developer_instructions, /Do not run git add, commit, tag/);
  assert.match(capture[0].codexOptions.config.compact_prompt, /structured checkpoint/);
});

test('discussion turn resumes the same id with a mechanical read-only sandbox', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await completedCycle(project, env, 'implement', sdkFactory([completed('same-thread', 'independent'), completed('same-thread', 'converged')]));
  const current = await readState(project, env);
  await updateState(project, (state) => { state.route = 'discussion'; state.generation += 1; return state; }, { expectedGeneration: current.state.generation }, env);
  const discussion = await queued(project, env, 'discuss');
  const capture = [];
  await runOperation(project, discussion, { createCodex: sdkFactory([completed('same-thread')], capture), signal: new AbortController().signal }, env);
  assert.equal(capture[0].kind, 'resume');
  assert.equal(capture[0].id, 'same-thread');
  assert.equal(capture[0].threadOptions.sandboxMode, 'read-only');
});

test('cancellation records cancelled and keeps canonical continuity', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await completedCycle(project, env, 'first', sdkFactory([completed('thread-cancel', 'independent'), completed('thread-cancel', 'converged')]));
  const second = await queued(project, env, 'cancel me');
  const controller = new AbortController();
  controller.abort();
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  await runOperation(project, second, { createCodex: sdkFactory([abortError]), signal: controller.signal }, env);
  const state = (await readState(project, env)).state;
  assert.equal(state.operations.at(-1).status, 'cancelled');
  assert.equal(state.partner.thread.threadId, 'thread-cancel');
});

test('queued cancellation removes the retained message without starting SDK work', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  const submitted = await submitOperation(project, submissionEnvelope('do not send'), env, { spawnRunner: false });
  await cancelOperation(project, submitted.operationId, env);
  const operation = (await readState(project, env)).state.operations[0];
  assert.equal(operation.status, 'cancelled');
  assert.equal(operation.request.message, null);
});

test('runner does not release ownership while a raced submission is queued', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  assert.equal(await claimRunner(project, process.pid, env), true);
  await submitOperation(project, submissionEnvelope('arrived at idle boundary'), env, { spawnRunner: false });
  assert.equal(await releaseRunnerIfIdle(project, process.pid, env), false);
  assert.equal((await readState(project, env)).state.controller.runnerPid, process.pid);
});

test('runner integration drains the FIFO sequentially and releases process ownership', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await submitOperation(project, submissionEnvelope('one'), env, { spawnRunner: false });
  await submitOperation(project, submissionEnvelope('two'), env, { spawnRunner: false });
  const capture = [];
  await runQueue(project, env, sdkFactory([completed('runner-thread', 'one independent')], capture));
  let state = (await readState(project, env)).state;
  assert.deepEqual(state.operations.map((operation) => operation.status), ['completed', 'queued']);
  await submitOperation(project, reconciliationEnvelope(state.operations[0].id, 'one', 'one Fable'), env, { spawnRunner: false });
  await runQueue(project, env, sdkFactory([completed('runner-thread', 'one converged'), completed('runner-thread', 'two independent')], capture));
  state = (await readState(project, env)).state;
  await submitOperation(project, reconciliationEnvelope(state.operations.find((operation) => operation.request.phase === 'independent' && operation.id !== state.operations[0].id).id, 'two', 'two Fable'), env, { spawnRunner: false });
  await runQueue(project, env, sdkFactory([completed('runner-thread', 'two converged')], capture));
  state = (await readState(project, env)).state;
  assert.deepEqual(state.operations.map((operation) => operation.status), ['completed', 'completed', 'completed', 'completed']);
  assert.equal(state.controller.runnerPid, null);
  assert.equal(state.controller.activeOperationId, null);
  assert.deepEqual(capture.map((item) => item.kind), ['start', 'resume', 'resume', 'resume']);
});

test('a replacement runner fails closed when the previous process died mid-turn', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await submitOperation(project, submissionEnvelope('ambiguous in-flight message'), env, { spawnRunner: false });
  await claimNextOperation(project, env);
  const current = await readState(project, env);
  await updateState(project, (state) => { state.controller.runnerPid = 2147483646; state.generation += 1; return state; }, { expectedGeneration: current.state.generation }, env);
  assert.equal(await claimRunner(project, process.pid, env), true);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'recovery-read-only');
  assert.equal(state.operations[0].status, 'failed');
  assert.equal(state.operations[0].request.message, null);
  assert.equal(state.controller.activeOperationId, null);
});

test('mismatched thread.started fails closed without adopting the returned id', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await completedCycle(project, env, 'first', sdkFactory([completed('recorded', 'independent'), completed('recorded', 'converged')]));
  const next = await queued(project, env, 'next');
  await assert.rejects(runOperation(project, next, { createCodex: sdkFactory([completed('wrong')]), signal: new AbortController().signal }, env), /thread mismatch/i);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.thread.threadId, 'recorded');
  assert.equal(state.route, 'recovery-read-only');
  assert.equal(state.operations.at(-1).status, 'failed');
});

test('exact missing-session text is detected and puts resume failure into recovery', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await completedCycle(project, env, 'first', sdkFactory([completed('missing-later', 'independent'), completed('missing-later', 'converged')]));
  const next = await queued(project, env, 'next');
  const error = new Error('Session not found for thread_id: missing-later');
  assert.equal(isMissingSessionError(error), true);
  await assert.rejects(runOperation(project, next, { createCodex: sdkFactory([error]), signal: new AbortController().signal }, env), /Session not found/);
  assert.equal((await readState(project, env)).state.route, 'recovery-read-only');
  assert.equal(isMissingSessionError(new Error('transport timeout')), false);
});

test('thread verification and lifecycle mapping expose status but never reasoning', () => {
  assert.equal(verifyThreadStarted('same', { type: 'thread.started', thread_id: 'same' }), 'same');
  assert.throws(() => verifyThreadStarted('same', { type: 'thread.started', thread_id: 'other' }), /mismatch/);
  assert.deepEqual(lifecycleUpdate({ type: 'item.started', item: { type: 'command_execution', command: 'pnpm test' } }).phase, 'tests');
  assert.equal(lifecycleUpdate({ type: 'item.completed', item: { type: 'reasoning', text: 'private' } }), null);
});

test('complete recovery seed has a hard 48 KiB budget', async (t) => {
  const checkpoint = emptyCheckpoint();
  const seed = buildRecoverySeed(checkpoint, '/synthetic/project');
  assert.ok(Buffer.byteLength(seed, 'utf8') < MAX_RECOVERY_SEED_BYTES);
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  await assert.rejects(updateCheckpoint(project, 'objective', 'x'.repeat(MAX_RECOVERY_SEED_BYTES), env), /8192-byte cap|49152-byte budget|invalid state/);
  assert.equal((await readState(project, env)).state.partner.thread.checkpoint.objective, null);
});
