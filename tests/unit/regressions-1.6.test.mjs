import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkpointWarnings } from '../../scripts/lib/checkpoint.mjs';
import {
  claimWakeWatcher, issueModeGrant, modeGrantMatches, recordCompaction,
  notificationLikePrompt, recentOwnerPromptEvidence, recordOperationalLifecycle, recordOwnerPromptEvidence, recordOwnerVisibleReplyEvidence,
  releaseWakeWatcher, textDigest
} from '../../scripts/lib/hook-evidence.mjs';
import { modeGrantDecision } from '../../scripts/hook-mode-grant.mjs';
import { operationIdFromHookInput } from '../../scripts/hook-wake.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';
import {
  cancelOperation, claimNextOperation, claimRunner, reconciliationEnvelope, runOperation, submissionEnvelope,
  submitOperation
} from '../../scripts/lib/sdk-controller.mjs';
import { initialState, initializeState, readState, updateState } from '../../scripts/lib/state.mjs';

const pluginRoot = resolve(import.meta.dirname, '..', '..');
const control = join(pluginRoot, 'scripts', 'control.mjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-160-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'data'), CLAUDE_CONFIG_DIR: join(directory, 'claude') };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env };
}

function sdkFactory(responses, capture = []) {
  return async () => {
    const thread = () => ({ runStreamed: async (prompt) => {
      capture.push(prompt);
      const response = responses.shift();
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-160' };
        yield { type: 'turn.started' };
        yield { type: 'item.completed', item: { type: 'agent_message', text: response } };
        yield { type: 'turn.completed' };
      })() };
    } });
    return { startThread: thread, resumeThread: thread };
  };
}

async function run(script, args, { cwd, env } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('1.6 item 1: strict Phase 1 rejects trailing Fable text and Phase 2 is a separate prompt', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const trailing = `${submissionEnvelope('owner words')}\nFABLE NOTE: current opinion`;
  await assert.rejects(submitOperation(project, trailing, env, { spawnRunner: false }), /strict JSON|trailing/i);
  const guardState = (await readState(project, env)).state;
  const submitCommand = `node ${join(pluginRoot, 'scripts', 'controller.mjs')} submit <<'FABEX_PHASE1_TEST'\n${trailing}\nFABEX_PHASE1_TEST`;
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command: submitCommand }, state: guardState, paths: { canonicalRoot: project }, executor: { sessionId: 'session-a' } })).decision, 'deny');
  await assert.rejects(submitOperation(project, JSON.stringify({ phase: 'independent', ownerMessage: 'owner words', previousReplyStatus: 'none', fableFraming: 'current opinion' }), env, { spawnRunner: false }), /trailing Fable fields/i);
  const phase1Submission = await submitOperation(project, submissionEnvelope('owner may literally say FABLE NOTE'), env, { spawnRunner: false });
  const phase1 = await claimNextOperation(project, env); const prompts = [];
  await runOperation(project, phase1, { createCodex: sdkFactory(['independent finding', 'converged finding'], prompts), signal: new AbortController().signal }, env);
  assert.match(prompts[0], /^FABEX TURN: phase=independent/);
  assert.doesNotMatch(prompts[0], /current Fable response/);
  const phase2Submission = await submitOperation(project, reconciliationEnvelope(phase1Submission.operationId, 'owner may literally say FABLE NOTE', 'current Fable response'), env, { spawnRunner: false });
  const phase2 = await claimNextOperation(project, env);
  await runOperation(project, phase2, { createCodex: sdkFactory(['converged finding'], prompts), signal: new AbortController().signal }, env);
  assert.notEqual(phase1Submission.operationId, phase2Submission.operationId);
  assert.equal(phase2.request.parentOperationId, phase1Submission.operationId);
  assert.match(prompts[1], /CODEX PHASE 1 INDEPENDENT READING \(stored verbatim\):\nindependent finding/);
  assert.match(prompts[1], /FABLE RESPONSE \(owner-visible, verbatim\):\ncurrent Fable response/);
});

test('1.6 item 2: queue barrier keeps later owner cycles behind the matching Phase 2', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const first = await submitOperation(project, submissionEnvelope('first'), env, { spawnRunner: false });
  const later = await submitOperation(project, submissionEnvelope('later'), env, { spawnRunner: false });
  const factory = sdkFactory(['first independent', 'first convergence']);
  const phase1 = await claimNextOperation(project, env); await runOperation(project, phase1, { createCodex: factory, signal: new AbortController().signal }, env);
  assert.equal(await claimNextOperation(project, env), null);
  const reconciliation = await submitOperation(project, reconciliationEnvelope(first.operationId, 'first', 'Fable review'), env, { spawnRunner: false });
  const phase2 = await claimNextOperation(project, env); assert.equal(phase2.id, reconciliation.operationId);
  await runOperation(project, phase2, { createCodex: factory, signal: new AbortController().signal }, env);
  assert.equal((await claimNextOperation(project, env)).id, later.operationId);
});

test('1.6 item 3: owner and previous-reply digests verify without storing their text', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  await recordOwnerPromptEvidence(project, { prompt: 'exact owner', session_id: 'session-a' }, env);
  await recordOwnerVisibleReplyEvidence(project, { last_assistant_message: 'previous visible reply', session_id: 'session-a' }, env);
  await assert.rejects(submitOperation(project, submissionEnvelope('changed owner', 'provided', 'previous visible reply'), env, { spawnRunner: false }), /ownerMessage does not match/);
  await assert.rejects(submitOperation(project, submissionEnvelope('exact owner', 'provided', 'changed reply'), env, { spawnRunner: false }), /previousReply does not match/);
  const accepted = await submitOperation(project, submissionEnvelope('exact owner', 'provided', 'previous visible reply'), env, { spawnRunner: false });
  assert.equal(accepted.claudeReplyVerified, true);
  const serialized = JSON.stringify((await readState(project, env)).state.contextEvidence);
  assert.doesNotMatch(serialized, /exact owner|previous visible reply/);
  assert.match(serialized, new RegExp(textDigest('exact owner')));
});

test('1.6 item 4: owner-typed mode grant is bound, single-use, and AI mode skills are denied', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const decision = await modeGrantDecision({ command_name: 'fabex:discussion', command_args: '', command_source: 'plugin', expansion_type: 'slash_command', session_id: 'session-a' }, project, env);
  const state = (await readState(project, env)).state; const grant = state.modeGrant;
  assert.match(decision.hookSpecificOutput.additionalContext, new RegExp(grant.id));
  const paths = { canonicalRoot: project };
  assert.equal((await classifyToolUse({ toolName: 'Skill', toolInput: { skill: 'fabex:work' }, state, paths, executor: { sessionId: 'session-a' } })).decision, 'deny');
  const command = `node ${control} mode discussion --participants both --grant ${grant.id}`;
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, state, paths, executor: { sessionId: 'session-a' } })).decision, 'defer');
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, state, paths, executor: { sessionId: 'other' } })).decision, 'deny');
  assert.equal((await run(control, ['mode', 'discussion', '--participants', 'both', '--grant', grant.id], { cwd: project, env })).code, 0);
  assert.equal((await run(control, ['mode', 'discussion', '--participants', 'both', '--grant', grant.id], { cwd: project, env })).code, 1);
  const expired = await issueModeGrant(project, { sessionId: 'session-a', route: 'normal', participants: 'both', now: Date.now() - 120_000 }, env);
  assert.equal(modeGrantMatches(expired, { id: expired.id, sessionId: 'session-a', route: 'normal', participants: 'both' }), false);
});

test('1.6 item 5: Stop blocks the Phase 2 gap and explicit recovery releases it', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const submitted = await submitOperation(project, submissionEnvelope('review'), env, { spawnRunner: false });
  const phase1 = await claimNextOperation(project, env);
  await runOperation(project, phase1, { createCodex: sdkFactory(['independent']), signal: new AbortController().signal }, env);
  let stateResult = await readState(project, env); assert.equal(stopDecision({}, stateResult).decision, 'block');
  const abandoned = await run(control, ['recover', 'abandon', '--operation-id', submitted.operationId], { cwd: project, env });
  assert.equal(abandoned.code, 0, abandoned.stderr);
  stateResult = await readState(project, env); assert.deepEqual(stopDecision({}, stateResult), {});
});

test('1.6 item 6: stable hooks record bounded delivery and compaction metadata only', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  await recordOperationalLifecycle(project, { hook_event_name: 'SubagentStart', agent_type: 'fabex:fabex-operational', agent_id: 'delivery-a' }, env);
  await recordOperationalLifecycle(project, { hook_event_name: 'SubagentStop', agent_type: 'fabex:fabex-operational', agent_id: 'delivery-a', last_assistant_message: 'owner-visible delivery result' }, env);
  await recordCompaction(project, { trigger: 'manual', session_id: 'session-a', compact_summary: 'must not be stored' }, env);
  const state = (await readState(project, env)).state;
  assert.equal(state.operationalDelivery.status, 'completed');
  assert.equal(state.operationalDelivery.resultDigest, textDigest('owner-visible delivery result'));
  assert.equal(state.partner.thread.metadata.lastCompaction.trigger, 'manual');
  assert.doesNotMatch(JSON.stringify(state), /owner-visible delivery result|must not be stored/);
  assert.ok(checkpointWarnings(state.partner.thread.checkpoint, state.partner.thread.metadata).includes('checkpoint predates the last Claude compaction'));
});

test('1.6 item 7: async wake parsing is exact and watcher ownership is deduplicated', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const submitted = await submitOperation(project, submissionEnvelope('wake me'), env, { spawnRunner: false });
  const command = `node ${join(pluginRoot, 'scripts', 'controller.mjs')} submit --message '${submissionEnvelope('wake me')}'`;
  assert.equal(operationIdFromHookInput({ tool_input: { command }, tool_response: { content: [{ text: JSON.stringify({ operationId: submitted.operationId }) }] } }), submitted.operationId);
  assert.equal(operationIdFromHookInput({ tool_input: { command: 'echo safe' }, tool_response: JSON.stringify({ operationId: submitted.operationId }) }), null);
  assert.equal(await claimWakeWatcher(project, submitted.operationId, process.pid, env), true);
  assert.equal(await claimWakeWatcher(project, submitted.operationId, process.pid, env), false);
  await releaseWakeWatcher(project, process.pid, env);
  assert.equal((await readState(project, env)).state.controller.wakeWatcher, null);
});

test('1.6 item 8: schema 7 migrates losslessly through schema 11', async (t) => {
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env);
  const legacy = structuredClone(initialized.state); legacy.schemaVersion = 7;
  delete legacy.modeGrant; delete legacy.contextEvidence; delete legacy.operationalDelivery; delete legacy.controller.wakeWatcher;
  delete legacy.ownerSelectedMode;
  delete legacy.partner.thread.metadata.lastCompaction;
  legacy.partner.thread.threadId = 'preserved-schema-7'; legacy.partner.thread.checkpoint.acceptedDecisions = ['preserved decision'];
  await writeFile(initialized.paths.stateFile, JSON.stringify(legacy));
  const loaded = await readState(project, env);
  assert.equal(loaded.ok, true); assert.equal(loaded.state.schemaVersion, 14);
  assert.equal(loaded.state.partner.thread.threadId, 'preserved-schema-7');
  assert.deepEqual(loaded.state.partner.thread.checkpoint.acceptedDecisions, ['preserved decision']);
});

test('1.6 item 9: hook registration uses stable events and no function-hook preview', async () => {
  const hooks = await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8');
  for (const event of ['UserPromptExpansion', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PostCompact', 'PostToolUse']) assert.match(hooks, new RegExp(`"${event}"`));
  assert.doesNotMatch(hooks, /ENABLE_FUNCTION_HOOKS|tool\.call|ui\.render/);
});

test('1.6 item 10: mode command itself rejects missing grants, including direct SDK attempts', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const direct = await run(control, ['mode', 'discussion', '--participants', 'both'], { cwd: project, env });
  assert.equal(direct.code, 1); assert.match(direct.stderr, /unknown or malformed|grant/);
  const state = initialState({ projectId: 'id', canonicalRoot: project });
  const decision = await classifyToolUse({ toolName: 'Bash', toolInput: { command: `node ${control} mode discussion --participants both --grant 11111111-1111-4111-8111-111111111111` }, state, paths: { canonicalRoot: project }, executor: { sessionId: 'session-a' } });
  assert.equal(decision.decision, 'deny');
});

test('1.6 live fix 1: schema migration defers while a live runner owns an active operation', async (t) => {
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env);
  const submitted = await submitOperation(project, submissionEnvelope('migration gate'), env, { spawnRunner: false });
  await claimRunner(project, process.pid, env); await claimNextOperation(project, env);
  const live = (await readState(project, env)).state;
  live.schemaVersion = 7;
  delete live.modeGrant; delete live.contextEvidence; delete live.operationalDelivery; delete live.controller.wakeWatcher;
  delete live.ownerSelectedMode;
  delete live.partner.thread.metadata.lastCompaction;
  for (const operation of live.operations) {
    delete operation.request.phase; delete operation.request.parentOperationId;
    delete operation.request.ownerMessageDigest; delete operation.request.claudeReplyVerified;
    delete operation.request.ownerMessage; delete operation.request.previousReplyStatus;
    delete operation.request.previousReply; delete operation.request.interrupted;
  }
  await writeFile(initialized.paths.stateFile, JSON.stringify(live));
  const deferred = await readState(project, env);
  assert.equal(deferred.ok, false); assert.equal(deferred.health, 'migration-deferred');
  assert.equal(JSON.parse(await readFile(initialized.paths.stateFile, 'utf8')).schemaVersion, 7);
  live.controller.runnerPid = 2147483646;
  await writeFile(initialized.paths.stateFile, JSON.stringify(live));
  const migrated = await readState(project, env);
  assert.equal(migrated.ok, true); assert.equal(migrated.state.schemaVersion, 14);
  assert.equal(migrated.state.operations[0].id, submitted.operationId);
});

test('1.6 live fix 2: notification prompts are skipped and a bounded digest ring tolerates interleaving', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  await recordOwnerPromptEvidence(project, { prompt: 'first owner prompt', session_id: 'session-a' }, env);
  for (const marker of ['<task-notification>done</task-notification>', '[SYSTEM NOTIFICATION: background]', '<system-reminder>internal</system-reminder>', '<local-command-caveat>internal</local-command-caveat>']) {
    assert.equal(notificationLikePrompt(marker), true);
    assert.equal(await recordOwnerPromptEvidence(project, { prompt: marker, session_id: 'session-a' }, env), null);
  }
  await recordOwnerPromptEvidence(project, { prompt: 'second owner prompt', session_id: 'session-a' }, env);
  const ring = await recentOwnerPromptEvidence(project, env);
  assert.deepEqual(ring.map((entry) => entry.digest), [textDigest('first owner prompt'), textDigest('second owner prompt')]);
  const accepted = await submitOperation(project, submissionEnvelope('first owner prompt'), env, { spawnRunner: false });
  assert.equal(accepted.status, 'queued');
  assert.doesNotMatch(JSON.stringify(ring), /first owner prompt|second owner prompt|notification/);
});

test('1.6 live fix 3: node test verification cannot execute paths outside the workstream', async (t) => {
  const { project, env } = await fixture(t); const state = (await initializeState(project, env)).state;
  const paths = { canonicalRoot: project };
  const classify = (command) => classifyToolUse({ toolName: 'Bash', toolInput: { command }, state, paths, executor: { sessionId: 'session-a' }, config: { project: { repositoryRoot: null }, guard: {} } });
  assert.equal((await classify('node --test')).decision, 'defer');
  assert.equal((await classify('node --test tests/unit/safe.test.mjs')).decision, 'defer');
  assert.equal((await classify('node --test /tmp/outside.test.mjs')).decision, 'deny');
  assert.equal((await classify('node --test ../outside.test.mjs')).decision, 'deny');
  assert.equal((await classify('node --test --test-reporter /tmp/reporter.mjs')).decision, 'deny');
});

test('1.6 live fix 4: cancel and abandon recover a working operation whose runner is dead', async (t) => {
  const first = await fixture(t); await initializeState(first.project, first.env);
  const cancelled = await submitOperation(first.project, submissionEnvelope('stuck cancel'), first.env, { spawnRunner: false });
  await claimRunner(first.project, process.pid, first.env); await claimNextOperation(first.project, first.env);
  let current = await readState(first.project, first.env);
  await updateState(first.project, (state) => { state.controller.runnerPid = 2147483646; state.generation += 1; return state; }, { expectedGeneration: current.state.generation }, first.env);
  const cancellation = await cancelOperation(first.project, cancelled.operationId, first.env);
  assert.equal(cancellation.status, 'failed'); assert.equal(cancellation.deadRunner, true);
  current = await readState(first.project, first.env);
  assert.equal(current.state.route, 'recovery-read-only'); assert.equal(current.state.controller.activeOperationId, null);

  const second = await fixture(t); await initializeState(second.project, second.env);
  const abandoned = await submitOperation(second.project, submissionEnvelope('stuck abandon'), second.env, { spawnRunner: false });
  await claimRunner(second.project, process.pid, second.env); await claimNextOperation(second.project, second.env);
  current = await readState(second.project, second.env);
  await updateState(second.project, (state) => { state.controller.runnerPid = 2147483646; state.generation += 1; return state; }, { expectedGeneration: current.state.generation }, second.env);
  const result = await run(control, ['recover', 'abandon', '--operation-id', abandoned.operationId], { cwd: second.project, env: second.env });
  assert.equal(result.code, 0, result.stderr);
  current = await readState(second.project, second.env);
  assert.equal(current.state.operations.some((operation) => operation.id === abandoned.operationId), false);
  assert.equal(current.state.route, 'normal'); assert.equal(current.state.controller.activeOperationId, null);
});
