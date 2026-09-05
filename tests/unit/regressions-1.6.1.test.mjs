import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modeGrantDecision } from '../../scripts/hook-mode-grant.mjs';
import { issueModeGrant, modeGrantMatches } from '../../scripts/lib/hook-evidence.mjs';
import {
  applyOwnerModeTransition, claimNextOperation, claimRunner, reconciliationEnvelope, runOperation,
  submissionEnvelope, submitOperation, turnPrompt
} from '../../scripts/lib/sdk-controller.mjs';
import { clearDeadLock, initializeState, readState, updateState } from '../../scripts/lib/state.mjs';

const pluginRoot = resolve(import.meta.dirname, '..', '..');
const control = join(pluginRoot, 'scripts', 'control.mjs');
const controller = join(pluginRoot, 'scripts', 'controller.mjs');
const modeSkills = ['discussion', 'discussionClaude', 'discussionCodex', 'work', 'workClaude', 'ask', 'askClaude', 'askCodex'];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-161-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'data'), CLAUDE_CONFIG_DIR: join(directory, 'claude') };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env };
}

async function run(script, args, { cwd, env } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

const controlMode = (project, env, route, participants, grantId) => run(control, ['mode', route, '--participants', participants, '--grant', grantId], { cwd: project, env });

function sdkFactory(response, prompts = []) {
  return async () => {
    const thread = () => ({ runStreamed: async (prompt) => {
      prompts.push(prompt);
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-161' };
        yield { type: 'item.completed', item: { type: 'agent_message', text: response } };
        yield { type: 'turn.completed' };
      })() };
    } });
    return { startThread: thread, resumeThread: thread };
  };
}

test('1.6.1 discussion command with no arguments changes mode only', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const decision = await modeGrantDecision({ command_name: 'fabex:discussion', command_args: '', command_source: 'plugin', expansion_type: 'slash_command', session_id: 'session-a' }, project, env);
  const grant = (await readState(project, env)).state.modeGrant;
  assert.match(decision.hookSpecificOutput.additionalContext, /No trailing owner message/);
  const changed = await controlMode(project, env, 'discussion', 'both', grant.id);
  assert.equal(changed.code, 0, changed.stderr);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'discussion'); assert.equal(state.operations.length, 0); assert.equal(state.modeGrant, null);
});

test('1.6.1 work command forwards same-line text after applying its grant', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'normal', participants: 'both', ownerMessage: 'build the focused patch' }, env);
  const changed = await controlMode(project, env, 'normal', 'both', grant.id);
  assert.equal(changed.code, 0, changed.stderr); assert.match(changed.stdout, new RegExp(grant.operationId));
  const operation = (await readState(project, env)).state.operations.at(-1);
  assert.equal(operation.request.ownerMessage, 'build the focused patch'); assert.equal(operation.request.phase, 'independent');
});

test('1.6.1 discussion command forwards multiline text exactly', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const message = 'first line\n\nthird line\n- list item';
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'both', ownerMessage: message }, env);
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  assert.equal((await readState(project, env)).state.operations.at(-1).request.ownerMessage, message);
});

test('1.6.1 mode text preserves Unicode Japanese punctuation Markdown and blank lines byte for byte', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const message = '日本語—「確認」🙂\n\n**bold** `code`\n\n- 終わり。';
  const decision = await modeGrantDecision({ command_name: '/fabex:discussion', command_args: message, command_source: 'plugin', expansion_type: 'slash_command', session_id: 'session-a' }, project, env);
  assert.doesNotMatch(JSON.stringify(decision), /日本語|bold|終わり/);
  const grant = (await readState(project, env)).state.modeGrant;
  assert.equal(grant.ownerMessage, message);
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  assert.deepEqual(Buffer.from((await readState(project, env)).state.operations.at(-1).request.ownerMessage), Buffer.from(message));
});

test('1.6.1 trailing mode text becomes a fresh Phase 1 owner message', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'both', ownerMessage: 'owner-only phase input' }, env);
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  const operation = await claimNextOperation(project, env); const prompts = [];
  await runOperation(project, operation, { createCodex: sdkFactory('independent answer', prompts), signal: new AbortController().signal }, env);
  assert.match(prompts[0], /OWNER MESSAGE \(verbatim\):\nowner-only phase input/);
  const completed = (await readState(project, env)).state.operations.find((item) => item.id === operation.id);
  assert.equal(completed.request.ownerMessage, 'owner-only phase input');
  const result = await run(controller, ['result', '--operation-id', operation.id], { cwd: project, env });
  assert.equal(JSON.parse(result.stdout).request.ownerMessage, 'owner-only phase input');
  await submitOperation(project, reconciliationEnvelope(operation.id, 'owner-only phase input', 'Fable response'), env, { spawnRunner: false });
  const phase2 = await claimNextOperation(project, env);
  await runOperation(project, phase2, { createCodex: sdkFactory('converged answer'), signal: new AbortController().signal }, env);
  assert.equal((await readState(project, env)).state.operations.find((item) => item.id === operation.id).request.ownerMessage, null);
});

test('1.6.1 current Claude commentary is absent from mode-created Phase 1', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'normal', participants: 'both', ownerMessage: 'owner text' }, env);
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'normal', participants: 'both' }, env, { spawnRunner: false });
  const prompt = turnPrompt((await readState(project, env)).state.operations.at(-1));
  assert.doesNotMatch(prompt, /FABLE RESPONSE|FABLE NOTE|current Claude commentary/);
  assert.match(prompt, /PREVIOUS CLAUDE REPLY STATUS: unavailable/);
});

test('1.6.1 failed mode transition consumes no grant and loses no text', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const message = 'retain this exactly';
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'both', ownerMessage: message }, env);
  await assert.rejects(applyOwnerModeTransition(project, { grantId: grant.id, route: 'normal', participants: 'both' }, env, { spawnRunner: false }), /grant/);
  const retained = (await readState(project, env)).state.modeGrant;
  assert.equal(retained.id, grant.id); assert.equal(retained.ownerMessage, message);

  const second = await fixture(t); await initializeState(second.project, second.env);
  await submitOperation(second.project, submissionEnvelope('active work'), second.env, { spawnRunner: false });
  const active = await claimNextOperation(second.project, second.env);
  const pendingGrant = await issueModeGrant(second.project, { sessionId: 'session-a', route: 'discussion', participants: 'both', ownerMessage: message }, second.env);
  await applyOwnerModeTransition(second.project, { grantId: pendingGrant.id, route: 'discussion', participants: 'both' }, second.env, { spawnRunner: false });
  await assert.rejects(runOperation(second.project, active, { createCodex: async () => { throw new Error('synthetic failure'); }, signal: new AbortController().signal }, second.env));
  const failed = (await readState(second.project, second.env)).state;
  assert.equal(failed.route, 'recovery-read-only'); assert.equal(failed.modeGrant.id, pendingGrant.id); assert.equal(failed.modeGrant.ownerMessage, message);
});

test('1.6.1 pending Phase 2 does not cause an owner mode command to be ignored', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const first = await submitOperation(project, submissionEnvelope('unfinished cycle'), env, { spawnRunner: false });
  const operation = await claimNextOperation(project, env);
  await runOperation(project, operation, { createCodex: sdkFactory('stored reading'), signal: new AbortController().signal }, env);
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'both' }, env);
  const changed = await controlMode(project, env, 'discussion', 'both', grant.id);
  assert.equal(changed.code, 0, changed.stderr);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'discussion'); assert.equal(state.operations.find((item) => item.id === first.operationId).request.interrupted, true);
});

test('1.6.1 switching to discussion cancels pending work and prevents later writes', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const old = await submitOperation(project, submissionEnvelope('old work'), env, { spawnRunner: false });
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'both', ownerMessage: 'new read-only review' }, env);
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  const state = (await readState(project, env)).state;
  assert.equal(state.operations.find((item) => item.id === old.operationId).status, 'cancelled');
  const next = state.operations.find((item) => item.id === grant.operationId);
  assert.equal(next.request.route, 'discussion'); assert.equal(next.request.sandbox, 'read-only');
  assert.equal(state.operations.some((item) => item.status === 'queued' && item.request.sandbox === 'workspace-write'), false);
});

test('1.6.1 recover abandon preserves the owner-selected discussion route', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const modeGrant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'both' }, env);
  await applyOwnerModeTransition(project, { grantId: modeGrant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  const submitted = await submitOperation(project, submissionEnvelope('fail safely'), env, { spawnRunner: false });
  const operation = await claimNextOperation(project, env);
  await assert.rejects(runOperation(project, operation, { createCodex: async () => ({ startThread: () => ({ runStreamed: async () => { throw new Error('synthetic failure'); } }) }), signal: new AbortController().signal }, env));
  const recovered = await run(control, ['recover', 'abandon', '--operation-id', submitted.operationId], { cwd: project, env });
  assert.equal(recovered.code, 0, recovered.stderr); assert.match(recovered.stdout, /Preserved route: discussion/);
  assert.equal((await readState(project, env)).state.route, 'discussion');
});

test('1.6.1 resume and dead-lock recovery preserve the prior route', async (t) => {
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env);
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'both' }, env);
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  const submitted = await submitOperation(project, submissionEnvelope('orphan'), env, { spawnRunner: false }); await claimNextOperation(project, env);
  const resumed = await initializeState(project, env, { recoverUnresolved: true });
  assert.equal(resumed.state.ownerSelectedMode.route, 'discussion');
  await run(control, ['recover', 'abandon', '--operation-id', submitted.operationId], { cwd: project, env });
  await mkdir(initialized.paths.lockDir); await writeFile(initialized.paths.lockOwnerFile, JSON.stringify({ pid: 2147483646, operationId: '11111111-1111-4111-8111-111111111111', purpose: 'test' }));
  await clearDeadLock(project, env);
  assert.equal((await readState(project, env)).state.route, 'discussion');
});

test('1.6.1 unknown prior route fails closed and requires an owner command', async (t) => {
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env);
  const legacy = structuredClone(initialized.state); legacy.schemaVersion = 8; legacy.route = 'recovery-read-only'; legacy.participants = 'both'; delete legacy.ownerSelectedMode;
  await writeFile(initialized.paths.stateFile, JSON.stringify(legacy));
  const migrated = await readState(project, env);
  assert.equal(migrated.state.route, 'discussion'); assert.equal(migrated.state.participants, 'both'); assert.equal(migrated.state.ownerSelectedMode, null);
  await assert.rejects(submitOperation(project, submissionEnvelope('must not run'), env, { spawnRunner: false }), /owner-selected mode is unknown/);
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'both' }, env);
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  assert.equal((await readState(project, env)).state.ownerSelectedMode.route, 'discussion');
});

test('1.6.1 no-argument mode commands create no empty Phase 1', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const existing = await submitOperation(project, submissionEnvelope('already queued'), env, { spawnRunner: false });
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'normal', participants: 'both', ownerMessage: '\n\n' }, env);
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'normal', participants: 'both' }, env, { spawnRunner: false });
  const state = (await readState(project, env)).state;
  assert.equal(state.operations.length, 1);
  assert.equal(state.operations[0].id, existing.operationId);
  assert.equal(state.operations[0].status, 'queued');
});

test('1.6.1 every mode and ask template forwards captured arguments privately', async () => {
  for (const skill of modeSkills) {
    const text = await readFile(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(text, /captures?.*(?:command text|question).*byte-for-byte|captures? command arguments byte-for-byte/s, skill);
    assert.match(text, /grant/i, skill);
    assert.doesNotMatch(text, /\$ARGUMENTS/, skill);
  }
});

test('1.6.1 transient lock contention at runner start retries instead of failing', async (t) => {
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env);
  await submitOperation(project, submissionEnvelope('lock retry'), env, { spawnRunner: false });
  await mkdir(initialized.paths.lockDir); await writeFile(initialized.paths.lockOwnerFile, JSON.stringify({ pid: process.pid, operationId: '11111111-1111-4111-8111-111111111111', purpose: 'brief contention' }));
  const release = new Promise((done) => setTimeout(() => rm(initialized.paths.lockDir, { recursive: true, force: true }).then(done), 300));
  assert.equal(await claimRunner(project, process.pid, env), true);
  await release;
  const operation = await claimNextOperation(project, env);
  assert.equal(operation.status, 'working');
});

test('1.6.1 paused grants survive expiry until an active operation stops', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  await submitOperation(project, submissionEnvelope('active work'), env, { spawnRunner: false }); const active = await claimNextOperation(project, env);
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'both', ownerMessage: 'retained next message', now: Date.now() - 59_500 }, env);
  const pending = await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  assert.equal(pending.status, 'pending');
  const retained = (await readState(project, env)).state.modeGrant;
  assert.ok(retained.pausedAt); assert.equal(retained.ownerMessage, 'retained next message');
  assert.equal(modeGrantMatches(retained, { id: grant.id, route: 'discussion', participants: 'both', now: Date.now() + 120_000 }), true);
  const abort = new AbortController(); abort.abort();
  await runOperation(project, active, { createCodex: async () => { throw new DOMException('cancelled', 'AbortError'); }, signal: abort.signal }, env);
  const applied = (await readState(project, env)).state;
  assert.equal(applied.modeGrant, null); assert.equal(applied.route, 'discussion');
  assert.equal(applied.operations.find((item) => item.id === grant.operationId).request.sandbox, 'read-only');
});

test('1.6.1 paused Claude-only text remains private until the mode command is retried after active work', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  await submitOperation(project, submissionEnvelope('active work'), env, { spawnRunner: false }); const active = await claimNextOperation(project, env);
  const grant = await issueModeGrant(project, { sessionId: 'session-a', route: 'discussion', participants: 'claude', ownerMessage: 'Claude-only owner text' }, env);
  const pending = await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'claude' }, env, { spawnRunner: false });
  assert.equal(pending.status, 'pending'); assert.equal(pending.ownerMessage, null);
  const abort = new AbortController(); abort.abort();
  await runOperation(project, active, { createCodex: async () => { throw new DOMException('cancelled', 'AbortError'); }, signal: abort.signal }, env);
  let state = (await readState(project, env)).state;
  assert.equal(state.modeGrant.ownerMessage, 'Claude-only owner text'); assert.equal(state.route, 'discussion'); assert.equal(state.participants, 'claude');
  const applied = await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'claude' }, env, { spawnRunner: false });
  assert.equal(applied.ownerMessage, 'Claude-only owner text');
  state = (await readState(project, env)).state;
  assert.equal(state.modeGrant, null); assert.equal(state.route, 'discussion'); assert.equal(state.participants, 'claude');
});
