import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { heavyShape, beginHeavy, finishHeavy, heavyStatus, waitHeavy, HEAVY_MAX_AGE_MS } from '../../scripts/lib/heavy.mjs';
import { parseMemory, memoryDecision, sampleMemory } from '../../scripts/lib/memory.mjs';
import { registerHostResource, resourceList, retainResource, releaseResource } from '../../scripts/lib/resources.mjs';
import { recordToolCompletion } from '../../scripts/hook-heavy.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';
import { classifyToolUse, classifyUnhealthyToolUse } from '../../scripts/hook-route-guard.mjs';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { recordOwnerPromptEvidence, recentOwnerPromptEvidence, issueModeGrant, resolveRecordedPrompt, textDigest, closePrompt } from '../../scripts/lib/hook-evidence.mjs';
import { submitOperation, submissionEnvelope, applyOwnerModeTransition, updateCheckpoint, claimNextOperation, runOperation, reconciliationEnvelope } from '../../scripts/lib/sdk-controller.mjs';
import { sidecar } from '../../scripts/lib/private-store.mjs';
import { relayBlock } from '../../scripts/lib/review.mjs';

const plugin = resolve(import.meta.dirname, '../..');
const normal = () => Promise.resolve({ at: new Date().toISOString(), level: 'normal', freePercent: 60 });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fabex-192-')); const root = join(dir, 'project'); await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'private') };
  t.after(() => rm(dir, { recursive: true, force: true }));
  await initializeState(root, env);
  return { dir, root, env };
}
test('1.9.2 heavy admission is atomic, wait resumes, and expiry never assumes a process is dead', async t => {
  const { root, env } = await fixture(t);
  for (const command of ['pnpm --dir app test', 'npm ci', 'node --test foo.mjs', 'npx playwright test', 'vitest run', 'pnpm payload migrate', 'node /x/control.mjs dev start']) assert.ok(heavyShape(command), command);
  for (const command of ['rg hello src', 'node /x/control.mjs heavy wait', 'git status', 'rg "pnpm test" README.md', 'echo "vitest run"', "node /x/controller.mjs submit <<'BODY'\n{\"ownerMessage\":\"pnpm test\"}\nBODY"]) assert.equal(heavyShape(command), null, command);
  assert.ok(heavyShape('/bin/zsh -lc "pnpm test"'));
  const start = id => beginHeavy(root, { id, command: 'pnpm test', executor: 'test' }, env, { sample: normal });
  const results = await Promise.all([start('a'), start('b')]);
  assert.equal(results.filter(result => result.allowed).length, 1);
  const job = (await heavyStatus(root, env)).jobs[0];
  assert.equal((await heavyStatus(root, env, Date.parse(job.startedAt) + HEAVY_MAX_AGE_MS + 1)).jobs[0].expired, true);
  assert.equal((await start('c')).allowed, false);
  let clock = 0;
  const waiting = await waitHeavy(root, 1, env, { sample: normal, now: () => clock, sleep: async ms => { clock += ms; await finishHeavy(root, job.id, env, { sample: normal }); } });
  assert.equal(waiting.ready, true);
  assert.equal((await start('c')).allowed, true);
  await finishHeavy(root, 'c', env, { sample: normal });
  assert.equal((await beginHeavy(root, { id: 'logs', command: 'pnpm test > /tmp/example.log 2>&1', executor: 'test' }, env, { sample: normal })).allowed, true);
  await finishHeavy(root, 'logs', env, { sample: normal });
  const file = await sidecar(root, 'heavy-jobs.json', env);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test('1.9.2 memory parsing and gates are query-only and never infer pressure from free percent', async () => {
  const parsed = parseMemory({ level: '4', pressure: 'System-wide memory free percentage: 35%', vm: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapouts: 10.', swap: 'total = 1024M used = 500M' });
  assert.equal(parsed.level, 'critical'); assert.equal(parsed.pages.Swapouts, 10); assert.equal(parsed.pageSize, 16384);
  assert.equal(memoryDecision(parsed).allowed, false);
  assert.equal(memoryDecision({ ...parsed, level: 'warn' }).allowed, true);
  assert.match(memoryDecision({ ...parsed, level: 'unknown' }).warning, /unknown/);
  const calls = [];
  await sampleMemory({ platform: 'darwin', execute: async (file, args) => { calls.push([file, args]); return file.endsWith('sysctl') && args.includes('-n') ? '1' : ''; } });
  assert.deepEqual(calls.find(([file]) => file.endsWith('memory_pressure'))[1], ['-Q']);
});
test('1.9.2 critical gate denies, warn permits, SDK observations do not pretend to intercept execution', async t => {
  const { root, env } = await fixture(t);
  const critical = () => Promise.resolve({ at: new Date(Date.now() - 11000).toISOString(), level: 'critical' });
  assert.equal((await beginHeavy(root, { id: 'host', command: 'pnpm build', executor: 'host' }, env, { sample: critical })).allowed, false);
  assert.equal((await heavyStatus(root, env)).jobs.length, 0);
  const warn = () => Promise.resolve({ at: new Date().toISOString(), level: 'warn' });
  assert.match((await beginHeavy(root, { id: 'host', command: 'pnpm build', executor: 'host' }, env, { sample: warn })).warning, /warn/);
  assert.match((await beginHeavy(root, { id: 'sdk', command: 'node --test', executor: 'codex', observed: true }, env, { sample: normal })).warning, /overlap/);
});
test('1.9.2 host background completion does not clear reservations; host TaskOutput does', async t => {
  const { root, env } = await fixture(t);
  const input = { tool_use_id: 'a', session_id: 's', tool_name: 'Bash', hook_event_name: 'PostToolUse', tool_input: { command: 'pnpm test', run_in_background: true }, tool_response: { task_id: 'task-a' } };
  await beginHeavy(root, { id: 'host:s:a', command: 'pnpm test', executor: 'host' }, env, { sample: normal });
  await recordToolCompletion(root, input, env, { sample: normal });
  assert.equal((await heavyStatus(root, env)).jobs.length, 1);
  assert.equal((await resourceList(root, env)).entries.length, 1);
  await recordToolCompletion(root, { ...input, tool_name: 'TaskOutput', tool_input: { task_id: 'task-a' }, tool_use_id: 'b', tool_response: { status: 'completed' } }, env, { sample: normal });
  assert.equal((await heavyStatus(root, env)).jobs.length, 0);
  assert.equal((await resourceList(root, env)).entries.length, 0);
});
test('1.9.2 resources retain notes, release via host controls, stale identity never signals', async t => {
  const { root, env } = await fixture(t);
  await registerHostResource(root, { taskId: 'forward', command: 'stripe listen' }, env);
  await retainResource(root, 'host:forward', 'Preview still requested', env);
  assert.equal((await resourceList(root, env)).entries[0].kind, 'forwarder');
  assert.equal((await resourceList(root, env)).warnings.length, 0);
  assert.equal((await releaseResource(root, 'host:forward', { env })).released, false);
  await assert.rejects(releaseResource(root, 'arbitrary-pid', { env }), /not found/);
  const record = await sidecar(root, 'dev-server.json', env);
  await writeFile(record, JSON.stringify({ pid: 12345, pgid: 12345, signature: 'old', cwd: await realpath(root), command: ['node', 'server.mjs'], port: 3456, logFile: record.replace('.json', '.log'), startedAt: new Date().toISOString() }));
  let signals = 0;
  const result = await releaseResource(root, 'dev-server', { env, authorize: async () => {}, dependencies: { identity: async () => ({ pid: 12345, pgid: 12345, signature: 'reused' }), signal: () => { signals++; } } });
  assert.equal(result.status, 'stale'); assert.equal(signals, 0);
});
test('1.9.2 Stop continuation is work-only, bounded, and disarmed by new questions', async t => {
  const { root, env } = await fixture(t);
  await recordOwnerPromptEvidence(root, { prompt: 'Complete the approved checks', session_id: 's' }, env);
  await updateCheckpoint(root, 'openWork', 'Run remaining approved checks', env);
  let current = await readState(root, env);
  assert.equal(stopDecision({}, current).decision, 'block');
  const checkpoint = current.state.partner.thread.checkpoint;
  checkpoint.continuation.used = 20;
  assert.match(stopDecision({}, current).systemMessage, /budget/);
  checkpoint.continuation.used = 0; checkpoint.blocker = 'Host permission refused';
  assert.notEqual(stopDecision({}, current).decision, 'block');
  checkpoint.blocker = null; current.state.route = 'discussion';
  assert.notEqual(stopDecision({}, current).decision, 'block');
  await recordOwnerPromptEvidence(root, { prompt: 'Explain only', session_id: 's' }, env);
  current = await readState(root, env);
  assert.equal(current.state.partner.thread.checkpoint.continuation.armed, false);
  assert.notEqual(stopDecision({}, current).decision, 'block');
});
test('1.9.2 recorded digest and latest insert originals, ambiguous and absent references fail, retries deduplicate', async t => {
  const { root, env } = await fixture(t);
  const text = 'Please verify the approved development changes.\r\n ';
  await recordOwnerPromptEvidence(root, { prompt: text, session_id: 's' }, env);
  const message = JSON.stringify({ phase: 'independent', ownerMessageStatus: 'recorded', ownerMessageDigest: textDigest(text), previousReplyStatus: 'none', requestId: randomUUID() });
  const result = await submitOperation(root, message, env, { spawnRunner: false });
  assert.equal((await submitOperation(root, message, env, { spawnRunner: false })).duplicate, true);
  const state = (await readState(root, env)).state;
  assert.equal(state.operations.find(op => op.id === result.operationId).request.ownerMessage, text);
  assert.equal((await resolveRecordedPrompt(root, { ownerMessage: text.replace(/\r\n /, '\n') }, state, env)).text, text);
  assert.equal((await resolveRecordedPrompt(root, { ownerMessage: text.replace('verify', 'verfy') }, state, env)).text, text);
  const substituted = await submitOperation(root, submissionEnvelope(text.replace('verify', 'verfy')), env, { spawnRunner: false });
  assert.equal(substituted.messageResolution, 'substituted recorded original');
  await assert.rejects(submitOperation(root, submissionEnvelope('Completely unrelated instruction that has no match.'), env, { spawnRunner: false }), /does not match/);
  await assert.rejects(resolveRecordedPrompt(root, { ownerMessageRef: 'latest' }, state, env), /missing or ambiguous/);
  await recordOwnerPromptEvidence(root, { prompt: 'A fresh owner task', session_id: 's' }, env);
  assert.equal((await resolveRecordedPrompt(root, { ownerMessageRef: 'latest' }, state, env)).text, 'A fresh owner task');
  await recordOwnerPromptEvidence(root, { prompt: 'Another fresh owner task', session_id: 's' }, env);
  await assert.rejects(resolveRecordedPrompt(root, { ownerMessageRef: 'latest' }, state, env), /ambiguous/);
  assert.equal(closePrompt('x'.repeat(100000), 'y'.repeat(100000)), false);
});
test('1.9.2 a consumed mode grant records trailing text for continuation; unused grant does not', async t => {
  const { root, env } = await fixture(t);
  const text = 'Implement the already approved task';
  const grant = await issueModeGrant(root, { sessionId: 's', route: 'normal', participants: 'both', ownerMessage: text }, env);
  assert.equal((await recentOwnerPromptEvidence(root, env)).length, 0);
  await applyOwnerModeTransition(root, { grantId: grant.id, route: 'normal', participants: 'both' }, env, { spawnRunner: false });
  assert.equal((await recentOwnerPromptEvidence(root, env))[0].text, text);
  const result = await submitOperation(root, submissionEnvelope(text), env, { spawnRunner: false });
  assert.equal(result.status, 'queued');
});
test('1.9.2 read-only controls never create data, resource mutations remain work-only', async t => {
  const { root, env } = await fixture(t); const current = await readState(root, env);
  const before = await readFile(current.paths.stateFile, 'utf8');
  const names = await readdir(current.paths.projectDir);
  for (const args of [['heavy', 'status'], ['resources', 'list'], ['prompts'], ['mem']]) {
    const r = spawnSync(process.execPath, [join(plugin, 'scripts/control.mjs'), ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(await readFile(current.paths.stateFile, 'utf8'), before);
  assert.deepEqual(await readdir(current.paths.projectDir), names);
  for (const route of ['discussion', 'ask-once', 'recovery-read-only']) {
    current.state.route = route;
    const classify = command => classifyToolUse({ toolName: 'Bash', toolInput: { command: `node "${join(plugin, 'scripts/control.mjs')}" ${command}` }, state: current.state, paths: current.paths });
    assert.equal((await classify('mem')).decision, 'defer');
    assert.equal((await classify('resources release dev-server')).decision, 'deny');
  }
});

test('1.9.2 real hook subprocesses reserve, deny overlap, clear failure and retry without an owner message', async t => {
  const { root, env } = await fixture(t);
  // Seed a fresh harmless injected sample: no memory load or actual suite launched.
  await beginHeavy(root, { id: 'seed', command: 'pnpm test', executor: 'fixture' }, env, { sample: normal });
  await finishHeavy(root, 'seed', env, { sample: normal });
  const run = (file, input) => {
    const result = spawnSync(process.execPath, [join(plugin, 'scripts', file)], { cwd: root, env, encoding: 'utf8', input: JSON.stringify({ cwd: root, ...input }) });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's', tool_use_id: 'first', tool_input: { command: 'pnpm test' } };
  assert.notEqual(run('hook-route-guard.mjs', input).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal((await heavyStatus(root, env)).jobs.length, 1);
  assert.match(run('hook-route-guard.mjs', { ...input, tool_use_id: 'second' }).hookSpecificOutput.permissionDecisionReason, /heavy wait/);
  run('hook-heavy.mjs', { ...input, hook_event_name: 'PostToolUseFailure', error: 'fixture command failed' });
  assert.equal((await heavyStatus(root, env)).jobs.length, 0);
  assert.notEqual(run('hook-route-guard.mjs', { ...input, tool_use_id: 'second' }).hookSpecificOutput?.permissionDecision, 'deny');
  run('hook-heavy.mjs', { ...input, tool_use_id: 'second', hook_event_name: 'PermissionDenied' });
  assert.equal((await heavyStatus(root, env)).jobs.length, 0);
  assert.match(run('hook-route-guard.mjs', { ...input, tool_input: { command: 'pnpm test & pnpm build' } }).hookSpecificOutput.permissionDecisionReason, /sequentially/);
});

test('1.9.2 host stop errors and unknown responses cannot discard a live task reservation', async t => {
  const { root, env } = await fixture(t);
  await beginHeavy(root, { id: 'host:s:launch', command: 'pnpm test', executor: 'fixture' }, env, { sample: normal });
  await recordToolCompletion(root, { tool_use_id: 'launch', session_id: 's', tool_name: 'Bash', hook_event_name: 'PostToolUse', tool_input: { run_in_background: true }, tool_response: { task_id: 'task' } }, env);
  const input = { tool_name: 'TaskStop', hook_event_name: 'PostToolUse', tool_input: { task_id: 'task' } };
  for (const response of [{ is_error: true }, { success: false }, {}, 'unrecognized response']) {
    await recordToolCompletion(root, { ...input, tool_response: response }, env);
    assert.equal((await heavyStatus(root, env)).jobs.length, 1);
  }
  await recordToolCompletion(root, { ...input, tool_response: { success: true } }, env, { sample: normal });
  assert.equal((await heavyStatus(root, env)).jobs.length, 0);
});

test('1.9.2 recorded mode task runs two complete linked cycles and observes SDK command lifetime', async t => {
  const { root, env } = await fixture(t);
  const text = 'Complete the approved isolated checks';
  const grant = await issueModeGrant(root, { sessionId: 's', route: 'normal', participants: 'both', ownerMessage: text }, env);
  await applyOwnerModeTransition(root, { grantId: grant.id, route: 'normal', participants: 'both' }, env, { spawnRunner: false });
  await updateCheckpoint(root, 'openWork', 'Finish the isolated checks', env);
  const fakeSdk = phase => ({ createCodex: async () => {
    const thread = () => ({ runStreamed: async () => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'continued-thread' };
      yield { type: 'item.started', item: { type: 'command_execution', id: 'command-1', command: 'node --test example.test.mjs' } };
      assert.equal((await heavyStatus(root, env)).jobs.length, 1);
      yield { type: 'item.completed', item: { type: 'command_execution', id: 'command-1', command: 'node --test example.test.mjs', exit_code: 0 } };
      assert.equal((await heavyStatus(root, env)).jobs.length, 0);
      yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ scopeMismatch: null, parityConcern: null, answer: 'Fixture phase completed.', ownerSummary: 'Fixture checked.', evidence: [], assumptions: [], uncertainties: [], recommendation: null, changedFiles: [], tests: [], ...(phase === 'reconcile' ? { disagreements: [] } : {}) }) } };
      yield { type: 'turn.completed' };
    })() }) });
    return { startThread: thread, resumeThread: thread };
  } });
  for (let cycle = 0; cycle < 2; cycle++) {
    if (cycle) await submitOperation(root, JSON.stringify({ phase: 'independent', ownerMessageStatus: 'recorded', ownerMessageDigest: textDigest(text), previousReplyStatus: 'none', requestId: randomUUID() }), env, { spawnRunner: false });
    const parent = await claimNextOperation(root, env);
    assert.equal(parent.request.ownerMessage, text);
    await runOperation(root, parent, fakeSdk('independent'), env);
    await submitOperation(root, JSON.stringify({ phase: 'reconcile', phase1OperationId: parent.id, ownerMessageStatus: 'recorded', ownerMessageDigest: textDigest(text), fableResponse: 'Fixture agrees.' }), env, { spawnRunner: false });
    const child = await claimNextOperation(root, env);
    await runOperation(root, child, fakeSdk('reconcile'), env);
    const current = await readState(root, env);
    assert.equal(current.state.partner.thread.checkpoint.continuation.used, cycle * 2 + 1);
    const last = current.state.operations.find(op => op.id === child.id);
    const result = spawnSync(process.execPath, [join(plugin, 'scripts/hook-stop.mjs')], { cwd: root, env, encoding: 'utf8', input: JSON.stringify({ cwd: root, session_id: 's', last_assistant_message: current.state.operations.filter(op => op.result.relay?.status === 'pending').map(op => relayBlock(op)).join('\n') }) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).reason, /Continue authorized feasible work/);
    assert.ok(last.result.structured.ownerSummary);
  }
  assert.equal((await readState(root, env)).state.partner.thread.threadId, 'continued-thread');
});

test('1.9.2 schema-15 migration preserves old fields and defers byte-for-byte for a live runner', async t => {
  const { root, env } = await fixture(t);
  await submitOperation(root, submissionEnvelope('Retain this active cycle'), env, { spawnRunner: false });
  await claimNextOperation(root, env);
  const current = await readState(root, env), legacy = structuredClone(current.state);
  legacy.schemaVersion = 15;
  const cp = legacy.partner.thread.checkpoint;
  cp.objective = 'Keep the original task';
  for (const field of ['openWork', 'ownerActionRequired', 'blocker', 'continuation']) { delete cp[field]; delete cp.fieldUpdatedAt[field]; }
  legacy.controller.runnerPid = process.pid;
  await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  const bytes = await readFile(current.paths.stateFile, 'utf8');
  assert.equal((await readState(root, env)).health, 'migration-deferred');
  assert.equal(await readFile(current.paths.stateFile, 'utf8'), bytes);
  const hook = spawnSync(process.execPath, [join(plugin, 'scripts/hook-session.mjs')], { cwd: root, env, encoding: 'utf8', input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'Question while migration is deferred', session_id: 's' }) });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal((await recentOwnerPromptEvidence(root, env)).at(-1).text, undefined, 'unknown/deferred participants must not retain possibly Claude-only raw text');
  assert.equal(await readFile(current.paths.stateFile, 'utf8'), bytes);
  legacy.controller.runnerPid = null;
  await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  const migrated = await readState(root, env);
  assert.equal(migrated.ok, true, migrated.error?.message);
  assert.equal(migrated.state.schemaVersion, 16);
  const next = migrated.state.partner.thread.checkpoint;
  for (const [key, value] of Object.entries(cp)) if (key !== 'fieldUpdatedAt') assert.deepEqual(next[key], value);
  assert.deepEqual(next.openWork, []); assert.equal(next.continuation.armed, false);
});

test('1.9.2 prompt retention is bounded and private; read-only routes cannot arm continuation', async t => {
  const { root, env } = await fixture(t);
  for (let i = 0; i < 10; i++) await recordOwnerPromptEvidence(root, { prompt: `Owner message ${i}`, session_id: 's' }, env);
  let entries = await recentOwnerPromptEvidence(root, env);
  assert.equal(entries.length, 8); assert.equal(entries[0].text, 'Owner message 2');
  assert.equal((await stat(await sidecar(root, 'owner-prompt-digests.json', env))).mode & 0o777, 0o600);
  await recordOwnerPromptEvidence(root, { prompt: 'Private Claude-only question', session_id: 's' }, env, { retainText: false });
  entries = await recentOwnerPromptEvidence(root, env);
  assert.equal(entries.at(-1).text, undefined);
  await recordOwnerPromptEvidence(root, { prompt: 'x'.repeat(192 * 1024 + 1), session_id: 's' }, env);
  assert.equal((await recentOwnerPromptEvidence(root, env)).at(-1).text, undefined);
  assert.equal(await recordOwnerPromptEvidence(root, { prompt: '<task-notification>not owner authority</task-notification>', session_id: 's' }, env), null);
  await updateState(root, state => { state.route = 'discussion'; state.ownerSelectedMode.route = 'discussion'; state.generation++; return state; }, {}, env);
  await assert.rejects(updateCheckpoint(root, 'openWork', 'Do not implement from discussion', env), /work mode/);
});
