import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { applyOwnerModeTransition, cancelOperation, claimNextOperation, claimRunner, normalizeSubmissionEnvelope, runOperation, submitOperation, turnPrompt } from '../../scripts/lib/sdk-controller.mjs';
import { issueModeGrant, recordOwnerPromptEvidence, recordOwnerVisibleReplyEvidence } from '../../scripts/lib/hook-evidence.mjs';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { classifyToolUse, classifyUnhealthyToolUse, parseControlCommand } from '../../scripts/hook-route-guard.mjs';
import { relayBlock } from '../../scripts/lib/review.mjs';
import { buildRecoverySeed } from '../../scripts/lib/checkpoint.mjs';
import { inspectCleanup } from '../../scripts/lib/cleanup.mjs';

const plugin = resolve(import.meta.dirname, '../..');
const session = 'phone-session';
const offline = { spawnRunner: false };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fabex-180-'));
  const project = join(dir, 'workspace');
  await mkdir(join(project, 'app'), { recursive: true });
  const env = { ...process.env, FABEX_HOME: join(dir, 'state'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') };
  await mkdir(join(env.CLAUDE_CONFIG_DIR, 'uploads', session), { recursive: true });
  const images = [join(env.CLAUDE_CONFIG_DIR, 'uploads', session, 'one.jpg'), join(env.CLAUDE_CONFIG_DIR, 'uploads', session, 'two.png')];
  for (const image of images) await writeFile(image, 'isolated image fixture');
  await initializeState(project, env);
  await mkdir(join(project, '.fabex'));
  await writeFile(join(project, '.fabex/config.json'), JSON.stringify({ schemaVersion: 1, project: { repositoryRoot: 'app' } }));
  assert.equal(spawnSync('git', ['init', join(project, 'app')], { encoding: 'utf8' }).status, 0);
  const config = (await loadEffectiveConfig(project, env)).config;
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, project, env, images, config };
}
const envelope = (ownerMessage, attachments, extra = {}) => JSON.stringify({ phase: 'independent', ownerMessage, previousReplyStatus: 'none', attachments, ...extra });
async function setState(f, fn) {
  const current = await readState(f.project, f.env);
  const changed = await updateState(f.project, (state) => { fn(state); state.generation++; return state; }, { expectedGeneration: current.state.generation }, f.env);
  assert.equal(changed.ok, true, changed.error?.details?.join(';'));
}
const sdk = (calls) => async () => {
  const thread = (id, options) => ({ runStreamed: async (input) => {
    calls.push({ id, options, input });
    return { events: (async function* () {
      yield { type: 'thread.started', thread_id: 'same-canonical' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'Complete “verbatim” answer.\nSecond line.' } };
      yield { type: 'turn.completed' };
    })() };
  } });
  return { startThread: (options) => thread(null, options), resumeThread: thread };
};
async function guard(f, toolName, toolInput, executor = {}) {
  return classifyToolUse({ ...(await readState(f.project, f.env)), config: f.config, env: f.env, executor, toolName, toolInput });
}

test('1.8 upload matrix: ordinary and mode-command photos reach Phase 1 in work discussion ask', async (t) => {
  for (const route of ['normal', 'discussion', 'ask-once']) for (const modeCommand of [false, true]) {
    const f = await fixture(t); const owner = '画像を確認\n\n**exact caption**';
    let submitted;
    if (modeCommand) {
      const grant = await issueModeGrant(f.project, { sessionId: session, route, participants: 'both', ownerMessage: owner }, f.env);
      const command = `node "${join(plugin, 'scripts/control.mjs')}" mode ${route} --participants both --grant ${grant.id} --attach "${f.images[0]}" --attach "${f.images[1]}"`;
      assert.equal((await guard(f, 'Bash', { command }, { sessionId: session })).decision, 'defer');
      assert.equal(parseControlCommand(command).attachments.length, 2);
      submitted = await applyOwnerModeTransition(f.project, { grantId: grant.id, route, participants: 'both', attachments: f.images }, f.env, offline);
    } else {
      await setState(f, (state) => { state.route = route; state.ownerSelectedMode.route = route; });
      await recordOwnerPromptEvidence(f.project, { prompt: owner, session_id: session }, f.env);
      submitted = await submitOperation(f.project, envelope(owner, f.images), f.env, offline);
    }
    const calls = [];
    const op = await claimNextOperation(f.project, f.env);
    assert.equal(op.id, submitted.operationId);
    assert.equal(op.request.ownerMessage, owner);
    assert.doesNotMatch(turnPrompt(op), /FABLE RESPONSE|FABLE NOTE/);
    await runOperation(f.project, op, { createCodex: sdk(calls) }, f.env);
    assert.equal(calls[0].options.sandboxMode, route === 'normal' ? 'workspace-write' : 'read-only');
    assert.equal(calls[0].input.filter((item) => item.type === 'local_image').length, 2);
    const phase2 = JSON.stringify({ phase: 'reconcile', phase1OperationId: op.id, ownerMessage: owner, fableResponse: 'Fable uses the independent description.' });
    await submitOperation(f.project, phase2, f.env, offline);
    await runOperation(f.project, await claimNextOperation(f.project, f.env), { createCodex: sdk(calls) }, f.env);
    assert.equal(calls[1].id, 'same-canonical');
  }
});

test('1.8 image-only and Codex-only submissions preserve empty words; Claude-only stays excluded', async (t) => {
  for (const participants of ['both', 'codex']) {
    const f = await fixture(t);
    await setState(f, (state) => { state.route = 'discussion'; state.participants = participants; state.ownerSelectedMode = { ...state.ownerSelectedMode, route: 'discussion', participants }; });
    await recordOwnerPromptEvidence(f.project, { prompt: '', session_id: session }, f.env);
    const body = participants === 'both' ? envelope('', f.images) : JSON.stringify({ phase: 'single', ownerMessage: '', attachments: f.images });
    const submitted = await submitOperation(f.project, body, f.env, offline);
    assert.equal(submitted.phase, participants === 'both' ? 'independent' : 'single');
    const calls = [];
    await runOperation(f.project, await claimNextOperation(f.project, f.env), { createCodex: sdk(calls) }, f.env);
    assert.equal(calls[0].input[1].type, 'local_image');
    assert.match(calls[0].input[0].text, /OWNER MESSAGE \(verbatim\):\n/);
  }
  const f = await fixture(t);
  const grant = await issueModeGrant(f.project, { sessionId: session, route: 'discussion', participants: 'both' }, f.env);
  const result = await applyOwnerModeTransition(f.project, { grantId: grant.id, route: 'discussion', participants: 'both', attachments: f.images }, f.env, offline);
  assert.ok(result.operationId);
  assert.equal((await readState(f.project, f.env)).state.operations[0].request.ownerMessage, '');
  await setState(f, (state) => { state.participants = 'claude'; });
  await assert.rejects(submitOperation(f.project, envelope('', f.images), f.env, offline), /Claude-only/);
  assert.throws(() => normalizeSubmissionEnvelope(envelope('', []), 'both'), /at least one image/);
});

test('1.8 pending mode attachments survive state reload and cancel old work before read-only execution', async (t) => {
  const f = await fixture(t);
  await recordOwnerPromptEvidence(f.project, { prompt: 'old work', session_id: session }, f.env);
  await submitOperation(f.project, envelope('old work', []), f.env, offline);
  const old = await claimNextOperation(f.project, f.env);
  const grant = await issueModeGrant(f.project, { sessionId: session, route: 'discussion', participants: 'both', ownerMessage: 'new photo' }, f.env);
  const transition = await applyOwnerModeTransition(f.project, { grantId: grant.id, route: 'discussion', participants: 'both', attachments: f.images }, f.env, offline);
  assert.equal(transition.status, 'pending');
  const reloaded = await readState(f.project, f.env);
  assert.deepEqual(reloaded.state.modeGrant.attachments, f.images);
  assert.ok(reloaded.state.modeGrant.pausedAt);
  const calls = [];
  assert.equal((await runOperation(f.project, old, { createCodex: sdk(calls) }, f.env)).status, 'cancelled');
  assert.equal(calls.length, 0);
  const next = await claimNextOperation(f.project, f.env);
  assert.equal(next.request.sandbox, 'read-only');
  assert.equal(next.request.attachments.length, 2);
  await runOperation(f.project, next, { createCodex: sdk(calls) }, f.env);
  assert.equal(calls[0].options.sandboxMode, 'read-only');
});

test('1.8 invalid mode upload retains grant and text; cancellation clears paths and retry IDs deduplicate', async (t) => {
  const f = await fixture(t);
  const grant = await issueModeGrant(f.project, { sessionId: session, route: 'discussion', participants: 'both', ownerMessage: 'retain me' }, f.env);
  await assert.rejects(applyOwnerModeTransition(f.project, { grantId: grant.id, route: 'discussion', participants: 'both', attachments: [join(f.dir, 'missing.jpg')] }, f.env, offline), /validation failed/);
  const after = (await readState(f.project, f.env)).state;
  assert.equal(after.modeGrant.id, grant.id); assert.equal(after.modeGrant.ownerMessage, 'retain me'); assert.equal(after.operations.length, 0);
  await recordOwnerPromptEvidence(f.project, { prompt: 'repeat caption', session_id: session }, f.env);
  const requestId = randomUUID(); const body = envelope('repeat caption', f.images, { requestId });
  const first = await submitOperation(f.project, body, f.env, offline);
  assert.equal((await submitOperation(f.project, body, f.env, offline)).duplicate, true);
  await assert.rejects(submitOperation(f.project, envelope('different', f.images, { requestId }), f.env, offline), /different submission/);
  await cancelOperation(f.project, first.operationId, f.env);
  assert.deepEqual((await readState(f.project, f.env)).state.operations[0].request.attachments, []);
  assert.equal((await submitOperation(f.project, body, f.env, offline)).status, 'cancelled');
  assert.notEqual((await submitOperation(f.project, envelope('repeat caption', f.images, { requestId: randomUUID() }), f.env, offline)).operationId, first.operationId);
});

test('1.8 submission and runner lock contention retry without stealing a live lock', async (t) => {
  const f = await fixture(t);
  await recordOwnerPromptEvidence(f.project, { prompt: 'lock test', session_id: session }, f.env);
  const current = await readState(f.project, f.env);
  const locked = async (fn) => {
    await mkdir(current.paths.lockDir);
    await writeFile(current.paths.lockOwnerFile, JSON.stringify({ pid: process.pid, purpose: 'fixture submit', createdAt: new Date().toISOString() }));
    const timer = setTimeout(() => rm(current.paths.lockDir, { recursive: true }), 200);
    try { return await fn(); } finally { clearTimeout(timer); }
  };
  await locked(() => submitOperation(f.project, envelope('lock test', []), f.env, offline));
  assert.equal(await locked(() => claimRunner(f.project, process.pid, f.env)), true);
});

test('1.8 ask return ignores notifications and unknown destination fails closed without a grant', async (t) => {
  const f = await fixture(t);
  await setState(f, (state) => { state.route = 'ask-once'; state.returnTo = { route: 'discussion', participants: 'both' }; });
  const hook = (prompt) => spawnSync(process.execPath, [join(plugin, 'scripts/hook-session.mjs')], { env: f.env, cwd: f.project, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: f.project, session_id: session, prompt }), encoding: 'utf8' });
  assert.equal(hook('<task-notification>done</task-notification>').status, 0);
  assert.equal((await readState(f.project, f.env)).state.route, 'ask-once');
  await setState(f, (state) => { state.returnTo = null; });
  assert.match(hook('next owner message').stdout, /failed closed to discussion/);
  const state = (await readState(f.project, f.env)).state;
  assert.equal(state.route, 'discussion'); assert.equal(state.ownerSelectedMode, null); assert.equal(state.modeGrant, null);
});

test('1.8 ask selected without text waits for its first ordinary image question', async (t) => {
  const f = await fixture(t);
  const grant = await issueModeGrant(f.project, { sessionId: session, route: 'ask-once', participants: 'both' }, f.env);
  await applyOwnerModeTransition(f.project, { grantId: grant.id, route: 'ask-once', participants: 'both' }, f.env, offline);
  const hook = (prompt) => spawnSync(process.execPath, [join(plugin, 'scripts/hook-session.mjs')], { cwd: f.project, env: f.env, input: JSON.stringify({ cwd: f.project, hook_event_name: 'UserPromptSubmit', session_id: session, prompt }), encoding: 'utf8' });
  assert.equal(hook('').status, 0);
  assert.equal((await readState(f.project, f.env)).state.route, 'ask-once');
  await submitOperation(f.project, envelope('', f.images), f.env, offline);
  assert.equal((await readState(f.project, f.env)).state.operations[0].request.sandbox, 'read-only');
  assert.equal(hook('next message').status, 0);
  assert.equal((await readState(f.project, f.env)).state.route, 'normal');
});

test('1.8 recorded replies are exact session-bound bounded and excluded from recovery seeds', async (t) => {
  const f = await fixture(t); const reply = 'Previous “quotes”\n\n```json\n{"ok":true}\n```';
  await recordOwnerVisibleReplyEvidence(f.project, { session_id: session, last_assistant_message: reply }, f.env);
  await recordOwnerPromptEvidence(f.project, { session_id: session, prompt: 'new words' }, f.env);
  const body = envelope('new words', [], { previousReplyStatus: 'recorded' });
  assert.equal((await submitOperation(f.project, body, f.env, offline)).claudeReplyVerified, true);
  const state = (await readState(f.project, f.env)).state;
  assert.equal(state.operations[0].request.previousReply, reply);
  assert.doesNotMatch(buildRecoverySeed(state.partner.thread.checkpoint, f.project), /Previous “quotes”/);
  await recordOwnerVisibleReplyEvidence(f.project, { session_id: session, last_assistant_message: 'x'.repeat(32 * 1024 + 1) }, f.env);
  assert.equal((await readState(f.project, f.env)).state.recordedReply.status, 'unavailable');
  await submitOperation(f.project, body, f.env, offline);
  assert.equal((await readState(f.project, f.env)).state.operations[1].request.previousReplyStatus, 'unavailable');
  await recordOwnerVisibleReplyEvidence(f.project, { session_id: 'other', last_assistant_message: reply }, f.env);
  await submitOperation(f.project, body, f.env, offline);
  assert.equal((await readState(f.project, f.env)).state.operations[2].request.previousReply, null);
  await setState(f, (state) => { state.participants = 'claude'; });
  await recordOwnerVisibleReplyEvidence(f.project, { session_id: session, last_assistant_message: 'private Claude-only reply' }, f.env);
  assert.equal((await readState(f.project, f.env)).state.recordedReply.text, null);
});

test('1.8 relay command emits only the unmodified block and is guard-allowed', async (t) => {
  const f = await fixture(t);
  await submitOperation(f.project, envelope('review', []), f.env, offline);
  const op = await claimNextOperation(f.project, f.env);
  await runOperation(f.project, op, { createCodex: sdk([]) }, f.env);
  const completed = (await readState(f.project, f.env)).state.operations[0];
  const result = spawnSync(process.execPath, [join(plugin, 'scripts/controller.mjs'), 'relay', '--operation-id', op.id], { cwd: f.project, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout, relayBlock(completed) + '\n');
  assert.equal((await guard(f, 'Bash', { command: `node "${join(plugin, 'scripts/controller.mjs')}" relay --operation-id ${op.id}` })).decision, 'defer');
});

test('1.8 guards preserve image denial during trouble and permit only healthy external scratch writes', async (t) => {
  const f = await fixture(t); const scratch = join(f.dir, 'scratch'); await mkdir(scratch);
  f.config.guard.externalWriteRoots = [scratch];
  const note = join(scratch, 'note.md');
  for (const route of ['discussion', 'ask-once']) {
    await setState(f, (state) => { state.route = route; });
    for (const toolName of ['Write', 'Edit']) assert.equal((await guard(f, toolName, { file_path: note })).decision, 'defer');
    assert.equal((await guard(f, 'Bash', { command: `printf "note" >> "${note}"` })).decision, 'defer');
    assert.equal((await guard(f, 'Write', { file_path: join(f.project, 'app/file') })).decision, 'deny');
    assert.equal((await guard(f, 'Write', { file_path: join(f.dir, 'outside.md') })).decision, 'deny');
    assert.equal((await guard(f, 'Bash', { command: 'pnpm build' })).decision, 'deny');
  }
  await symlink(f.project, join(scratch, 'escape'));
  assert.equal((await guard(f, 'Write', { file_path: join(scratch, 'escape', 'file') })).decision, 'deny');
  for (const health of ['lock-contention', 'corrupt', 'migration-deferred']) for (const toolName of ['Read', 'Bash', 'mcp__service__read_file']) {
    assert.equal(classifyUnhealthyToolUse({ health, toolName, toolInput: toolName === 'Bash' ? { command: `cat "${f.images[0]}"` } : { path: f.images[0] } }).decision, 'deny');
  }
});

test('1.8 exact read diagnostics do not grant Git delivery or environment dumps', async (t) => {
  const f = await fixture(t);
  for (const route of ['normal', 'discussion', 'ask-once']) {
    await setState(f, (state) => { state.route = route; });
    for (const command of ['git tag --list', 'git tag -l "v*"', 'git tag --list | head -5', 'du -sh .', 'ps -axo pid,ppid,rss,etime,comm | grep codex']) assert.equal((await guard(f, 'Bash', { command })).decision, 'defer', command);
    for (const command of ['git tag v9.0.0', 'git tag --list; git commit -m x', 'ps e', 'ps -axo command', 'du -sh . | tee out']) assert.equal((await guard(f, 'Bash', { command })).decision, 'deny', command);
  }
});

test('1.8 schema 12 migration retains queued images pending grants reply digests and canonical identity', async (t) => {
  const f = await fixture(t);
  await recordOwnerPromptEvidence(f.project, { prompt: 'photo', session_id: session }, f.env);
  await submitOperation(f.project, envelope('photo', f.images), f.env, offline);
  await issueModeGrant(f.project, { sessionId: session, route: 'discussion', participants: 'both', ownerMessage: 'next' }, f.env);
  const current = await readState(f.project, f.env); const legacy = structuredClone(current.state);
  legacy.schemaVersion = 12; delete legacy.recordedReply; delete legacy.modeGrant.attachments;
  for (const op of legacy.operations) delete op.request.submissionDigest;
  legacy.partner.thread.threadId = 'preserved';
  await writeFile(current.paths.stateFile, JSON.stringify(legacy));
  const migrated = await readState(f.project, f.env);
  assert.equal(migrated.ok, true); assert.equal(migrated.state.schemaVersion, 14);
  assert.deepEqual(migrated.state.operations[0].request.attachments, await Promise.all(f.images.map((path) => realpath(path))));
  assert.deepEqual(migrated.state.operations[0].result, legacy.operations[0].result);
  assert.equal(migrated.state.modeGrant.ownerMessage, 'next'); assert.equal(migrated.state.partner.thread.threadId, 'preserved');
  assert.deepEqual(migrated.state.contextEvidence, legacy.contextEvidence);
});

test('1.8 cleanup refuses symlinks unique files wrong names and active use before removal', async (t) => {
  const f = await fixture(t); const target = join(f.project, 'fabex-next-1.8.3');
  await cp(plugin, target, { recursive: true, filter: (path) => !path.includes('/node_modules') && !path.includes('/.git') });
  await writeFile(join(target, 'unique-owner-note'), 'keep this');
  await assert.rejects(inspectCleanup(f.project, target, { source: plugin, activeCheck: async () => {} }), /unique\/untracked/);
  const alias = join(f.project, 'fabex-next'); await symlink(target, alias);
  await assert.rejects(inspectCleanup(f.project, alias), /symlink/);
  await assert.rejects(inspectCleanup(f.project, f.project), /exact absolute/);
  assert.equal(await readFile(join(target, 'unique-owner-note'), 'utf8'), 'keep this');
  await rm(join(target, 'unique-owner-note'));
  await cp(join(plugin, '.git'), join(target, '.git'), { recursive: true });
  await assert.rejects(inspectCleanup(f.project, target, { source: plugin, activeCheck: async () => { throw new Error('fixture active process'); } }), /fixture active process/);
  assert.equal((await inspectCleanup(f.project, target, { source: plugin, activeCheck: async () => {} })).verified, true);
});

test('1.8 missing pending image never becomes a text-only operation and retained grant remains retryable', async (t) => {
  const f = await fixture(t);
  await submitOperation(f.project, envelope('old work', []), f.env, offline);
  const old = await claimNextOperation(f.project, f.env);
  const grant = await issueModeGrant(f.project, { sessionId: session, route: 'discussion', participants: 'both', ownerMessage: 'photo' }, f.env);
  await applyOwnerModeTransition(f.project, { grantId: grant.id, route: 'discussion', participants: 'both', attachments: [f.images[0]] }, f.env, offline);
  await rm(f.images[0]);
  await runOperation(f.project, old, { createCodex: sdk([]) }, f.env);
  const state = (await readState(f.project, f.env)).state;
  assert.equal(state.operations.length, 1); assert.equal(state.modeGrant.id, grant.id);
  assert.match(state.operations[0].result.warning, /could not validate/);
  await writeFile(f.images[0], 'restored fixture');
  const outcome = await applyOwnerModeTransition(f.project, { grantId: grant.id, route: 'discussion', participants: 'both' }, f.env, offline);
  assert.ok(outcome.operationId);
});
