import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderSessionContext } from '../../scripts/hook-session.mjs';
import { claimNextOperation, submissionEnvelope, submitOperation } from '../../scripts/lib/sdk-controller.mjs';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { issueModeGrant } from '../../scripts/lib/hook-evidence.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const control = join(root, 'scripts', 'control.mjs');
const controller = join(root, 'scripts', 'controller.mjs');
const sessionHook = join(root, 'scripts', 'hook-session.mjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-control-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'data') };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { project, env };
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

const controlRun = (project, env, ...args) => run(control, args, { cwd: project, env });
const hookRun = (project, env, payload) => run(sessionHook, [], { cwd: project, env, input: JSON.stringify({ cwd: project, session_id: 'test-session', ...payload }) });

async function changeMode(project, env, route, participants) {
  await initializeState(project, env);
  const grant = await issueModeGrant(project, { sessionId: 'test-session', route, participants }, env);
  return controlRun(project, env, 'mode', route, '--participants', participants, '--grant', grant.id);
}

test('mode controls reach all eight modes and reject normal-codex', async (t) => {
  const { project, env } = await fixture(t);
  const matrix = [
    ['normal', 'both', 'work'], ['normal', 'claude', 'workClaude'],
    ['discussion', 'both', 'discussion'], ['discussion', 'claude', 'discussionClaude'], ['discussion', 'codex', 'discussionCodex'],
    ['ask-once', 'both', 'ask'], ['ask-once', 'claude', 'askClaude'], ['ask-once', 'codex', 'askCodex']
  ];
  for (const [route, participants, label] of matrix) {
    const changed = await changeMode(project, env, route, participants);
    assert.equal(changed.code, 0, changed.stderr);
    assert.match(changed.stdout, new RegExp(label));
  }
  assert.equal((await controlRun(project, env, 'mode', 'normal', '--participants', 'codex', '--grant', '11111111-1111-4111-8111-111111111111')).code, 1);
});

test('ask-once reverts on the next prompt without recording raw Claude-only Q&A', async (t) => {
  const { project, env } = await fixture(t);
  await changeMode(project, env, 'discussion', 'claude');
  await changeMode(project, env, 'ask-once', 'claude');
  const submit = await hookRun(project, env, { hook_event_name: 'UserPromptSubmit', prompt: 'private Claude-only question' });
  assert.equal(submit.code, 0, submit.stderr);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'discussion');
  assert.equal(state.participants, 'claude');
  assert.equal(state.partner.thread.checkpoint.objective, null);
});

test('session contexts describe SDK queue continuity and mechanical read-only discussion', () => {
  const config = { collaboration: { jointByDefault: true }, display: { replyModeBadge: 'always' } };
  const work = renderSessionContext('normal', 'both', config);
  assert.match(work, /canonical Codex SDK thread/);
  assert.match(work, /Claude project writes are denied/);
  assert.match(work, /thread\.started/);
  assert.ok(Buffer.byteLength(work, 'utf8') <= 900);
  const discussion = renderSessionContext('discussion', 'both', config);
  assert.match(discussion, /read-only sandbox/);
  const claude = renderSessionContext('discussion', 'claude', config);
  assert.match(claude, /Do not submit a Codex SDK turn/);
});

test('structured checkpoint controls update bounded fields and status omits their contents', async (t) => {
  const { project, env } = await fixture(t);
  assert.equal((await controlRun(project, env, 'checkpoint', 'objective', 'ship one SDK thread')).code, 0);
  assert.equal((await controlRun(project, env, 'checkpoint', 'decision', 'SDK first')).code, 0);
  assert.equal((await controlRun(project, env, 'checkpoint', 'test-status', 'unit tests passing')).code, 0);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.thread.checkpoint.objective, 'ship one SDK thread');
  assert.deepEqual(state.partner.thread.checkpoint.acceptedDecisions, ['SDK first']);
  const status = await controlRun(project, env, 'status');
  assert.equal(status.code, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /ship one SDK thread|SDK first|unit tests passing/);
  assert.match(status.stdout, /recoverySeedLimitBytes/);
  const statusJson = JSON.parse(status.stdout);
  assert.match(statusJson.partner.checkpoint.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Array.isArray(statusJson.partner.checkpoint.warnings), true);
});

test('controller status, result, and queued cancellation use isolated state', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  const submitted = await submitOperation(project, submissionEnvelope('retained only while queued'), env, { spawnRunner: false });
  const status = await run(controller, ['status', '--operation-id', submitted.operationId], { cwd: project, env });
  assert.equal(status.code, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /retained only while queued/);
  const pendingResult = await run(controller, ['result', '--operation-id', submitted.operationId], { cwd: project, env });
  assert.equal(pendingResult.code, 1);
  const cancelled = await run(controller, ['cancel', '--operation-id', submitted.operationId], { cwd: project, env });
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const result = await run(controller, ['result', '--operation-id', submitted.operationId], { cwd: project, env });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /retained only while queued/);
});

test('confirmed missing-session recovery clears only the exact failed canonical id', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  const submitted = await submitOperation(project, submissionEnvelope('resume'), env, { spawnRunner: false });
  await claimNextOperation(project, env);
  const current = await readState(project, env);
  await updateState(project, (state) => {
    state.partner.thread.threadId = 'missing-id';
    state.route = 'recovery-read-only';
    state.task.status = 'recovery-required';
    state.partner.status = 'failed';
    state.controller.activeOperationId = null;
    const operation = state.operations[0];
    operation.status = 'failed'; operation.request.message = null; operation.result.error = 'Session not found for thread_id: missing-id';
    operation.lifecycle.phase = 'failed'; operation.lifecycle.finishedAt = new Date().toISOString();
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation }, env);
  const recovered = await controlRun(project, env, 'recover', 'replace-missing-thread', '--operation-id', submitted.operationId);
  assert.equal(recovered.code, 0, recovered.stderr);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.thread.threadId, null);
  assert.equal(state.route, 'normal');
});

test('SessionStart preserves a live canonical id and declares exact resume verification', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  const current = await readState(project, env);
  await updateState(project, (state) => { state.partner.thread.threadId = 'persisted-thread'; state.generation += 1; return state; }, { expectedGeneration: current.state.generation }, env);
  const session = await hookRun(project, env, { hook_event_name: 'SessionStart' });
  assert.equal(session.code, 0, session.stderr);
  assert.match(JSON.parse(session.stdout).hookSpecificOutput.additionalContext, /resume this exact persisted SDK thread ID/);
  assert.equal((await readState(project, env)).state.partner.thread.threadId, 'persisted-thread');
});

test('controls resolve subdirectories to owning workstream and diagnose pinned SDK', async (t) => {
  const { project, env } = await fixture(t);
  const child = join(project, 'nested');
  await mkdir(child);
  await controlRun(project, env, 'status');
  const checkpoint = await run(control, ['checkpoint', 'decision', 'from child'], { cwd: child, env });
  assert.equal(checkpoint.code, 0, checkpoint.stderr);
  assert.deepEqual((await readState(project, env)).state.partner.thread.checkpoint.acceptedDecisions, ['from child']);
  const diagnosed = JSON.parse((await controlRun(project, env, 'diagnose')).stdout);
  assert.equal(diagnosed.plugin.version, '1.8.2');
  assert.equal(diagnosed.codex.transport, 'official TypeScript SDK');
  assert.equal(diagnosed.codex.installed, true);
  assert.equal(diagnosed.codex.dependency, '0.153.4');
});
