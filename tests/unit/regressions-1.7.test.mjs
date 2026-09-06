import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { attachmentShape, validateAttachments } from '../../scripts/lib/attachments.mjs';
import { parseReview, relayBlock, reviewSchema } from '../../scripts/lib/review.mjs';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { cancelOperation, claimNextOperation, normalizeSubmissionEnvelope, pruneOperations, reconciliationEnvelope, runOperation, submissionEnvelope, submitOperation } from '../../scripts/lib/sdk-controller.mjs';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';

const root = resolve(import.meta.dirname, '../..');
const answer = 'Scope mismatch: none.\nPartnership-parity concern: none.\n\n日本語 — complete answer.\n\nThe ending must stay.';
const structured = (phase) => ({ scopeMismatch: null, parityConcern: null, answer, evidence: ['fixture evidence'], assumptions: [], uncertainties: [], ...(phase === 'reconcile' ? { disagreements: [] } : {}), recommendation: null, changedFiles: [], tests: [{ command: 'pnpm test', exitCode: 0 }] });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-170-'));
  const project = join(directory, 'workspace'); await mkdir(join(project, 'app'), { recursive: true });
  const env = { ...process.env, FABEX_HOME: join(directory, 'state'), CODEX_HOME: join(directory, 'codex'), CLAUDE_CONFIG_DIR: join(directory, 'claude') };
  await mkdir(join(project, '.fabex'));
  await writeFile(join(project, '.fabex/config.json'), JSON.stringify({ schemaVersion: 1, project: { repositoryRoot: 'app' }, guard: { externalWriteRoots: [join(directory, 'artifacts')] } }));
  await initializeState(project, env);
  const config = (await loadEffectiveConfig(project, env)).config;
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env, config };
}
function fakeSdk(capture, phase, response = JSON.stringify(structured(phase))) {
  return async (codexOptions) => {
    const thread = (id, options) => ({ runStreamed: async (input, turnOptions) => {
      capture.push({ id, options, input, turnOptions, codexOptions });
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'canonical' };
        yield { type: 'item.completed', item: { type: 'reasoning', text: 'never retain reasoning' } };
        yield { type: 'item.completed', item: { type: 'agent_message', text: response } };
        yield { type: 'turn.completed' };
      })() };
    } });
    return { startThread: (options) => thread(null, options), resumeThread: (id, options) => thread(id, options) };
  };
}
async function execute(project, env, envelope, capture, phase, response) {
  const submitted = await submitOperation(project, envelope, env, { spawnRunner: false });
  const claimed = await claimNextOperation(project, env);
  assert.equal(claimed.id, submitted.operationId);
  await runOperation(project, claimed, { createCodex: fakeSdk(capture, phase, response) }, env);
  return (await readState(project, env)).state.operations.find((op) => op.id === claimed.id);
}

test('1.7 item 1: images reach separate read-only phases without current Fable input in Phase 1', async (t) => {
  const { project, env, config } = await fixture(t);
  const before = await readState(project, env);
  await updateState(project, (state) => { state.route = 'discussion'; state.ownerSelectedMode.route = 'discussion'; state.generation++; return state; }, { expectedGeneration: before.state.generation }, env);
  const path = join(project, 'app', 'screen.png'); await writeFile(path, Buffer.from('89504e470d0a1a0a', 'hex'));
  const envelope = JSON.stringify({ ...JSON.parse(submissionEnvelope('review this')), attachments: [path] });
  const command = `node "${join(root, 'scripts/controller.mjs')}" submit <<'FABEX_IMAGE_1234'\n${envelope}\nFABEX_IMAGE_1234`;
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...(await readState(project, env)), config })).decision, 'defer');
  const capture = [];
  const first = await execute(project, env, envelope, capture, 'independent');
  const second = await execute(project, env, JSON.stringify({ ...JSON.parse(reconciliationEnvelope(first.id, 'review this', 'CURRENT FABLE OPINION')), attachments: [path] }), capture, 'reconcile');
  assert.equal(capture.length, 2); assert.equal(capture[1].id, 'canonical');
  assert.doesNotMatch(capture[0].input[0].text, /CURRENT FABLE OPINION/);
  assert.match(capture[1].input[0].text, /CURRENT FABLE OPINION/);
  for (const call of capture) {
    assert.equal(call.options.sandboxMode, 'read-only'); assert.equal(call.options.networkAccessEnabled, false);
    assert.deepEqual(call.input[1], { type: 'local_image', path: await realpath(path) });
  }
  assert.deepEqual(first.request.attachments, []); assert.deepEqual(second.request.attachments, []);
  assert.equal(second.result.finalResponse, answer); assert.deepEqual(second.result.structured, structured('reconcile'));
  assert.doesNotMatch(JSON.stringify(second), /never retain reasoning/);
});

test('1.7 item 1: attachment bounds, external roots, symlink escape and guard rejection', async (t) => {
  const { directory, project, env, config } = await fixture(t);
  await mkdir(join(directory, 'artifacts'));
  const external = join(directory, 'artifacts', 'ok.png'); await writeFile(external, 'image');
  assert.deepEqual(validateAttachments([external], project, config), [await realpath(external)]);
  const denied = join(directory, 'denied.png'); await writeFile(denied, 'image');
  const link = join(project, 'link.png'); await symlink(denied, link);
  assert.throws(() => validateAttachments([link], project, config), /outside permitted/);
  for (const value of [['relative.png'], ['file.txt'], Array(7).fill(external), [12]]) assert.throws(() => attachmentShape(value));
  const large = join(project, 'large.png'); await writeFile(large, Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.throws(() => validateAttachments([large], project, config), /16 MiB/);
  const envelope = JSON.stringify({ ...JSON.parse(submissionEnvelope('owner')), attachments: [link] });
  await assert.rejects(submitOperation(project, envelope, env, { spawnRunner: false }), /outside permitted/);
  assert.throws(() => normalizeSubmissionEnvelope(`${envelope}\nFABLE NOTE`, 'both'), /trailing/);
  const command = `node "${join(root, 'scripts/controller.mjs')}" submit <<'FABEX_IMAGE_1234'\n${envelope}\nFABEX_IMAGE_1234`;
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...(await readState(project, env)), config })).decision, 'deny');
});

test('1.7 item 1: cancellation and failed image revalidation erase stored paths', async (t) => {
  const { directory, project, env } = await fixture(t);
  const path = join(project, 'screen.png'); await writeFile(path, 'image');
  const body = JSON.stringify({ ...JSON.parse(submissionEnvelope('owner')), attachments: [path] });
  const queued = await submitOperation(project, body, env, { spawnRunner: false });
  await cancelOperation(project, queued.operationId, env);
  assert.deepEqual((await readState(project, env)).state.operations[0].request.attachments, []);
  const next = await submitOperation(project, body, env, { spawnRunner: false });
  const operation = await claimNextOperation(project, env);
  const outside = join(directory, 'outside.png'); await writeFile(outside, 'image'); await rm(path); await symlink(outside, path);
  const calls = [];
  await assert.rejects(runOperation(project, operation, { createCodex: fakeSdk(calls, 'independent') }, env), /outside permitted/);
  assert.equal(calls.length, 0);
  assert.deepEqual((await readState(project, env)).state.operations.find((op) => op.id === next.operationId).request.attachments, []);
});

test('1.7 item 2: both-participant outputSchema and lossless malformed-output fallback', async (t) => {
  const { project, env } = await fixture(t); const calls = [];
  const first = await execute(project, env, submissionEnvelope('owner'), calls, 'independent', 'plain answer, not JSON');
  assert.deepEqual(calls[0].turnOptions.outputSchema, reviewSchema('independent'));
  assert.equal(first.result.finalResponse, 'plain answer, not JSON'); assert.equal(first.result.structured, null); assert.match(first.result.warning, /Structured review unavailable/);
  const second = await execute(project, env, reconciliationEnvelope(first.id, 'owner', 'Fable review'), calls, 'reconcile');
  assert.ok(calls[1].turnOptions.outputSchema.required.includes('disagreements'));
  assert.equal(second.result.finalResponse, answer);
  assert.equal(parseReview(JSON.stringify({ answer: 'missing fields' }), 'independent').structured, null);
  assert.equal(parseReview(JSON.stringify({ ...structured('independent'), answer: 'x'.repeat(32769) }), 'independent').structured, null);
});

test('1.7 item 2: Codex-only retains free text without outputSchema', async (t) => {
  const { project, env } = await fixture(t); const before = await readState(project, env);
  await updateState(project, (state) => { state.route = 'discussion'; state.participants = 'codex'; state.ownerSelectedMode = { route: 'discussion', participants: 'codex', selectedAt: new Date().toISOString() }; state.generation++; return state; }, { expectedGeneration: before.state.generation }, env);
  const calls = []; const op = await execute(project, env, 'owner question', calls, 'single', 'free text');
  assert.equal(calls[0].turnOptions.outputSchema, undefined); assert.equal(op.result.finalResponse, 'free text'); assert.equal(op.result.structured, null); assert.equal(op.result.warning, null);
});

test('1.7 item 3: Stop rejects truncated or unlabeled quotes, accepts full quotes and records delivery', async (t) => {
  const { project, env } = await fixture(t); const calls = [];
  const first = await execute(project, env, submissionEnvelope('owner'), calls, 'independent');
  const second = await execute(project, env, reconciliationEnvelope(first.id, 'owner', 'Fable review'), calls, 'reconcile', JSON.stringify({ ...structured('reconcile'), answer: `${answer}\nPhase 2 correction: a distinct final position.` }));
  const stateResult = await readState(project, env);
  assert.equal(stopDecision({ last_assistant_message: relayBlock(first) }, stateResult).decision, 'block');
  assert.equal(stopDecision({ last_assistant_message: `Codex:\n${answer.slice(0, 45)}`, stop_hook_active: true }, stateResult).decision, 'block');
  assert.equal(stopDecision({ last_assistant_message: answer }, stateResult).decision, 'block');
  const visible = `${relayBlock(first)}\n\n${relayBlock(second)}\n\nClaude: My separate answer.`;
  assert.deepEqual(stopDecision({ last_assistant_message: visible }, stateResult), {});
  const stopped = spawnSync(process.execPath, [join(root, 'scripts/hook-stop.mjs')], { cwd: project, env, encoding: 'utf8', input: JSON.stringify({ cwd: project, session_id: 'session', hook_event_name: 'Stop', last_assistant_message: visible }) });
  assert.equal(stopped.status, 0, stopped.stderr); assert.deepEqual(JSON.parse(stopped.stdout), {});
  assert.ok((await readState(project, env)).state.operations.every((op) => op.result.relay.status === 'delivered'));
  const result = spawnSync(process.execPath, [join(root, 'scripts/controller.mjs'), 'result', '--operation-id', second.id], { cwd: project, env, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(JSON.parse(result.stdout).relayBlock, /Phase 2 — reconciliation\/corrections/);
});

test('1.7 relay session binding survives a later prompt and absent Stop text fails closed', async (t) => {
  const { project, env } = await fixture(t);
  const { recordOwnerPromptEvidence } = await import('../../scripts/lib/hook-evidence.mjs');
  await recordOwnerPromptEvidence(project, { prompt: 'owner', session_id: 'first-session' }, env);
  await submitOperation(project, submissionEnvelope('owner'), env, { spawnRunner: false });
  await recordOwnerPromptEvidence(project, { prompt: 'later owner', session_id: 'second-session' }, env);
  await runOperation(project, await claimNextOperation(project, env), { createCodex: fakeSdk([], 'independent') }, env);
  const current = await readState(project, env);
  assert.equal(current.state.operations[0].result.relay.sessionId, 'first-session');
  assert.equal(stopDecision({ session_id: 'first-session', stop_hook_active: true }, current).decision, 'block');
  // Another session must not acknowledge or waive the first session's relay.
  assert.deepEqual(stopDecision({ session_id: 'second-session', stop_hook_active: true }, current), {});
});

test('1.7 item 3: recover abandon waives the completed cycle without losing the canonical thread', async (t) => {
  const { project, env } = await fixture(t); const calls = [];
  const first = await execute(project, env, submissionEnvelope('owner'), calls, 'independent');
  const second = await execute(project, env, reconciliationEnvelope(first.id, 'owner', 'Fable review'), calls, 'reconcile');
  const recovered = spawnSync(process.execPath, [join(root, 'scripts/control.mjs'), 'recover', 'abandon', '--operation-id', second.id], { cwd: project, env, encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr); assert.match(recovered.stdout, /Preserved route/);
  const current = await readState(project, env);
  assert.equal(current.state.partner.thread.threadId, 'canonical'); assert.equal(current.state.route, 'normal');
  assert.ok(current.state.operations.every((op) => op.result.relay.status === 'waived'));
  assert.deepEqual(stopDecision({}, current), {});
  assert.equal(current.state.operations[0].result.finalResponse, answer);
});

test('1.7 item 4: incompatible permission profiles are documented, not silently layered over sandbox', async (t) => {
  const { config } = await fixture(t);
  assert.equal('codexDeniedPaths' in config.guard, false);
  const source = await readFile(join(root, 'scripts/lib/sdk-controller.mjs'), 'utf8');
  assert.match(source, /sandboxMode: operation.request.sandbox/); assert.doesNotMatch(source, /default_permissions|configOverrides/);
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  assert.match(readme, /Permission-profile compatibility/); assert.match(readme, /do not combine/);
});

test('1.7 schema 10 migration preserves identity, evidence, grants, results and schema gate', async (t) => {
  const { project, env } = await fixture(t); const current = await readState(project, env);
  const op = await execute(project, env, submissionEnvelope('owner'), [], 'independent', 'legacy answer');
  const legacy = structuredClone((await readState(project, env)).state);
  legacy.schemaVersion = 10;
  legacy.partner.thread.checkpoint.acceptedDecisions = ['preserve decision'];
  legacy.claudeModel = { id: 'claude-fable-5-1', sessionId: 'session', at: new Date().toISOString() };
  legacy.executorException = { executor: 'named-executor', scope: 'Edit', reason: 'owner-approved fixture', authorizedAt: new Date().toISOString() };
  for (const item of legacy.operations) { delete item.request.attachments; delete item.result.structured; delete item.result.warning; delete item.result.relay; }
  await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  const migrated = await readState(project, env);
  assert.equal(migrated.ok, true); assert.equal(migrated.state.schemaVersion, 13);
  assert.equal(migrated.state.partner.thread.threadId, 'canonical');
  assert.deepEqual(migrated.state.ownerSelectedMode, legacy.ownerSelectedMode);
  assert.deepEqual(migrated.state.contextEvidence, legacy.contextEvidence);
  assert.deepEqual(migrated.state.partner.thread.checkpoint, legacy.partner.thread.checkpoint);
  assert.deepEqual(migrated.state.claudeModel, legacy.claudeModel);
  assert.deepEqual(migrated.state.executorException, legacy.executorException);
  assert.equal(migrated.state.operations[0].id, op.id); assert.equal(migrated.state.operations[0].result.finalResponse, 'legacy answer');
  assert.equal(migrated.state.operations[0].result.relay, null);
});

test('1.7 bounded pruning keeps linked phases and unrelayed answers together', () => {
  const operations = Array.from({ length: 10 }, (_, i) => ({ id: `op${i}`, status: 'completed', request: { phase: i % 2 ? 'reconcile' : 'independent', parentOperationId: i % 2 ? `op${i - 1}` : null }, result: { relay: { status: i >= 8 ? 'pending' : 'delivered' } } }));
  const kept = pruneOperations(operations, 3);
  assert.deepEqual(kept.map((op) => op.id), ['op8', 'op9']);
});
