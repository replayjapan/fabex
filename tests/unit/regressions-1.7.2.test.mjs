import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeState, readState } from '../../scripts/lib/state.mjs';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { recordOwnerPromptEvidence } from '../../scripts/lib/hook-evidence.mjs';
import { MAX_IMAGE_BYTES, validateAttachments } from '../../scripts/lib/attachments.mjs';
import { cancelOperation, claimNextOperation, reconciliationEnvelope, runOperation, submissionEnvelope, submitOperation } from '../../scripts/lib/sdk-controller.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';

const root = resolve(import.meta.dirname, '../..');
const sessionId = 'phone-session';
const owner = 'Please review this phone photo — 日本語。';
async function fixture(t, evidence = true) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-172-'));
  const project = join(directory, 'workspace'); await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'state'), CLAUDE_CONFIG_DIR: join(directory, 'custom-claude'), CODEX_HOME: join(directory, 'codex') };
  const uploadRoot = join(env.CLAUDE_CONFIG_DIR, 'uploads');
  await mkdir(join(uploadRoot, sessionId), { recursive: true });
  await mkdir(join(uploadRoot, 'sibling-session'));
  const image = join(uploadRoot, sessionId, 'phone-image.jpg'); await writeFile(image, 'image fixture');
  const sibling = join(uploadRoot, 'sibling-session', 'other-image.jpg'); await writeFile(sibling, 'other image');
  await initializeState(project, env);
  if (evidence) await recordOwnerPromptEvidence(project, { prompt: owner, session_id: sessionId }, env);
  const config = (await loadEffectiveConfig(project, env)).config;
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env, config, image, sibling, uploadRoot };
}
const body = (image) => JSON.stringify({ ...JSON.parse(submissionEnvelope(owner)), attachments: [image] });
const command = (envelope) => `node "${join(root, 'scripts/controller.mjs')}" submit <<'FABEX_PHONE_1720'\n${envelope}\nFABEX_PHONE_1720`;
async function guard(f, envelope) {
  return classifyToolUse({ ...(await readState(f.project, f.env)), config: f.config, env: f.env, executor: { sessionId }, toolName: 'Bash', toolInput: { command: command(envelope) } });
}
function sdk(calls, events = [], onInput = async () => {}) {
  return async () => {
    const thread = (id, options) => ({ runStreamed: async (input) => {
      calls.push({ id, options, input });
      await onInput(input);
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'canonical-phone' };
        if (events.length) { yield* events; return; }
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'Codex reviewed the photo.' } };
        yield { type: 'turn.completed' };
      })() };
    } });
    return { startThread: (options) => thread(null, options), resumeThread: thread };
  };
}

test('1.7.2 session-scoped uploads honor CLAUDE_CONFIG_DIR and reach independent Phase 1', async (t) => {
  const f = await fixture(t);
  assert.equal((await guard(f, body(f.image))).decision, 'defer');
  const submitted = await submitOperation(f.project, body(f.image), f.env, { spawnRunner: false });
  assert.deepEqual(submitted.attachments, [{ path: f.image, status: 'selected' }]);
  const operation = await claimNextOperation(f.project, f.env);
  assert.equal(operation.request.ownerMessage, owner);
  const calls = []; await runOperation(f.project, operation, { createCodex: sdk(calls, [], async () => {
    assert.deepEqual((await readState(f.project, f.env)).state.operations[0].result.attachments, [{ index: 0, status: 'submitted' }]);
  }) }, f.env);
  assert.equal(calls[0].input[0].text.includes(owner), true);
  assert.doesNotMatch(calls[0].input[0].text, /FABLE RESPONSE/);
  assert.deepEqual(calls[0].input[1], { type: 'local_image', path: await realpath(f.image) });
  const completed = (await readState(f.project, f.env)).state.operations[0];
  assert.deepEqual(completed.request.attachments, []);
  assert.deepEqual(completed.result.attachments, [{ index: 0, status: 'delivered' }]);
  const second = await submitOperation(f.project, JSON.stringify({ ...JSON.parse(reconciliationEnvelope(submitted.operationId, owner, 'Fable uses Codex description')), attachments: [f.image] }), f.env, { spawnRunner: false });
  assert.equal(second.status, 'queued');
  await runOperation(f.project, await claimNextOperation(f.project, f.env), { createCodex: sdk(calls) }, f.env);
  assert.equal(calls[1].id, 'canonical-phone');
});

test('1.7.2 sibling-session uploads and missing or ambiguous hook evidence fail closed', async (t) => {
  const f = await fixture(t);
  for (const path of [f.sibling, join(f.uploadRoot, 'root-image.jpg')]) {
    if (path !== f.sibling) await writeFile(path, 'image');
    assert.equal((await guard(f, body(path))).decision, 'deny');
    await assert.rejects(submitOperation(f.project, body(path), f.env, { spawnRunner: false }), /matching hook-recorded session/);
  }
  // Broad scratch roots must not defeat the special upload session boundary.
  assert.throws(() => validateAttachments([f.sibling], f.project, { guard: { externalWriteRoots: [f.directory] } }, { env: f.env, sessionId }), /matching hook-recorded session/);
  const none = await fixture(t, false);
  await assert.rejects(submitOperation(none.project, body(none.image), none.env, { spawnRunner: false }), /matching hook-recorded session/);
  await recordOwnerPromptEvidence(f.project, { prompt: owner, session_id: 'different-session' }, f.env);
  await assert.rejects(submitOperation(f.project, body(f.image), f.env, { spawnRunner: false }), /matching hook-recorded session/);
  assert.equal((await readState(f.project, f.env)).state.operations.length, 0);
});

test('1.7.2 phone size bound is 16 MiB, with six-image and format limits retained', async (t) => {
  const f = await fixture(t); const context = { env: f.env, sessionId };
  await writeFile(f.image, Buffer.alloc(MAX_IMAGE_BYTES));
  assert.equal(validateAttachments([f.image], f.project, f.config, context).length, 1);
  await writeFile(f.image, Buffer.alloc(MAX_IMAGE_BYTES + 1));
  assert.throws(() => validateAttachments([f.image], f.project, f.config, context), /16 MiB/);
  await writeFile(f.image, '');
  assert.throws(() => validateAttachments([f.image], f.project, f.config, context), /nonempty/);
  assert.throws(() => validateAttachments(Array(7).fill(f.image), f.project, f.config, context), /at most 6/);
  assert.throws(() => validateAttachments([join(f.uploadRoot, sessionId, 'image.heic')], f.project, f.config, context), /png\/jpg/);
});

test('1.7.2 upload file and session-directory symlink escapes remain denied', async (t) => {
  const f = await fixture(t); const context = { env: f.env, sessionId };
  const link = join(f.uploadRoot, sessionId, 'link.jpg'); await symlink(f.sibling, link);
  assert.throws(() => validateAttachments([link], f.project, f.config, context), /matching hook-recorded session/);
  const alias = join(f.uploadRoot, 'alias-session'); await symlink(join(f.uploadRoot, 'sibling-session'), alias);
  assert.throws(() => validateAttachments([join(alias, 'other-image.jpg')], f.project, f.config, { env: f.env, sessionId: 'alias-session' }), /matching hook-recorded session/);
});

test('1.7.2 explicit failed submit reports per-path status and never queues a text-only fallback', async (t) => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [join(root, 'scripts/controller.mjs'), 'submit'], { cwd: f.project, env: f.env, input: body(f.sibling), encoding: 'utf8' });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.operationId, null); assert.equal(output.status, 'failed');
  assert.deepEqual(output.attachments, [{ path: f.sibling, status: 'failed' }]);
  assert.match(result.stderr, /no operation queued/);
  assert.equal((await readState(f.project, f.env)).state.operations.length, 0);
});

test('1.7.2 failed or cancelled SDK turns never claim delivered; Fable image reads stay denied', async (t) => {
  const f = await fixture(t);
  const submitted = await submitOperation(f.project, body(f.image), f.env, { spawnRunner: false });
  const op = await claimNextOperation(f.project, f.env);
  await assert.rejects(runOperation(f.project, op, { createCodex: sdk([], [{ type: 'turn.failed', error: { message: 'fixture failure' } }]) }, f.env), /fixture failure/);
  const failed = (await readState(f.project, f.env)).state.operations.find((item) => item.id === submitted.operationId);
  assert.deepEqual(failed.result.attachments, [{ index: 0, status: 'failed' }]);
  assert.deepEqual(failed.request.attachments, []);
  const queued = await fixture(t);
  const id = (await submitOperation(queued.project, body(queued.image), queued.env, { spawnRunner: false })).operationId;
  await cancelOperation(queued.project, id, queued.env);
  assert.deepEqual((await readState(queued.project, queued.env)).state.operations[0].result.attachments, [{ index: 0, status: 'failed' }]);
  for (const [toolName, toolInput] of [['Read', { file_path: queued.image }], ['Bash', { command: `cat "${queued.image}"` }], ['mcp__service__read_file', { path: queued.image }]]) {
    assert.equal((await classifyToolUse({ ...(await readState(queued.project, queued.env)), config: queued.config, env: queued.env, toolName, toolInput })).decision, 'deny');
  }
});

test('1.7.2 schema 11 migration preserves queued attachments, relay and canonical identity', async (t) => {
  const f = await fixture(t);
  await submitOperation(f.project, body(f.image), f.env, { spawnRunner: false });
  const current = await readState(f.project, f.env); const legacy = structuredClone(current.state);
  legacy.schemaVersion = 11; legacy.partner.thread.threadId = 'retained-canonical';
  legacy.partner.thread.checkpoint.acceptedDecisions = ['retain this'];
  delete legacy.operations[0].result.attachments;
  await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  const migrated = await readState(f.project, f.env);
  assert.equal(migrated.ok, true); assert.equal(migrated.state.schemaVersion, 14);
  assert.equal(migrated.state.partner.thread.threadId, 'retained-canonical');
  assert.deepEqual(migrated.state.partner.thread.checkpoint, legacy.partner.thread.checkpoint);
  assert.deepEqual(migrated.state.contextEvidence, legacy.contextEvidence);
  assert.deepEqual(migrated.state.operations[0].request, legacy.operations[0].request);
  assert.deepEqual(migrated.state.operations[0].result.relay, legacy.operations[0].result.relay);
  assert.deepEqual(migrated.state.operations[0].result.attachments, [{ index: 0, status: 'selected' }]);
});

test('1.7.2 skills forward host references without describing images or guessing upload files', async () => {
  for (const skill of ['jointly', 'ask', 'discussion']) {
    const text = await readFile(join(root, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(text, /host.*upload.*reference/i);
    assert.match(text, /Phase 1/);
    assert.match(text, /16 MiB/);
  }
});

test('1.7.2 schema 11 completed reviews migrate losslessly with delivery unknown and a live-runner gate', async (t) => {
  const f = await fixture(t);
  await submitOperation(f.project, body(f.image), f.env, { spawnRunner: false });
  await runOperation(f.project, await claimNextOperation(f.project, f.env), { createCodex: sdk([]) }, f.env);
  const current = await readState(f.project, f.env);
  const legacy = structuredClone(current.state); legacy.schemaVersion = 11;
  for (const op of legacy.operations) delete op.result.attachments;
  await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  const migrated = await readState(f.project, f.env);
  assert.equal(migrated.ok, true);
  const result = migrated.state.operations[0].result;
  assert.deepEqual(result, { ...legacy.operations[0].result, attachments: null });
  assert.deepEqual(migrated.state.ownerSelectedMode, legacy.ownerSelectedMode);
  assert.deepEqual(migrated.state.executorException, legacy.executorException);
  assert.deepEqual(migrated.state.modeGrant, legacy.modeGrant);
  // A still-finishing old runner must not observe a live schema replacement.
  legacy.controller.runnerPid = process.pid;
  legacy.controller.activeOperationId = legacy.operations[0].id;
  legacy.operations[0].status = 'working';
  legacy.operations[0].lifecycle.phase = 'working';
  legacy.operations[0].lifecycle.finishedAt = null;
  const bytes = JSON.stringify(legacy); await writeFile(current.paths.stateFile, bytes);
  assert.equal((await readState(f.project, f.env)).health, 'migration-deferred');
  assert.equal(await readFile(current.paths.stateFile, 'utf8'), bytes);
});
