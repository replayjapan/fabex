import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { registerSession, selectTaskRole, sealReading } from '../../scripts/lib/workspace.mjs';
import { observeActivity } from '../../scripts/lib/activity.mjs';
import { authorshipPolicy } from '../../scripts/lib/authorship.mjs';
import { ownerFabexCommand, recordOwnerPromptEvidence } from '../../scripts/lib/hook-evidence.mjs';
import { captureOwnerDelivery, ownerDeliveries } from '../../scripts/lib/owner-delivery.mjs';
import { dispatchOwnerDeliveries, submitOperation, reconciliationEnvelope, claimNextOperation, runOperation } from '../../scripts/lib/sdk-controller.mjs';
import { dispositionProblem, persistWorkDisposition } from '../../scripts/lib/work-disposition.mjs';
import { emptyCheckpoint } from '../../scripts/lib/checkpoint.mjs';
import { relayBlock } from '../../scripts/lib/review.mjs';
import { classifyToolUse, workCommandDenial } from '../../scripts/hook-route-guard.mjs';

const done = { status: 'done', remainingWork: [], reason: 'The requested work is complete.' };
const remaining = { status: 'remaining', remainingWork: ['Finish the approved document.'], reason: 'Documentation is still pending.' };
const review = (phase, disposition = remaining) => ({ scopeMismatch: null, parityConcern: null, answer: 'Reviewed the requested change.', evidence: [], assumptions: [], uncertainties: [], recommendation: null, changedFiles: [], tests: [], ...(phase === 'reconcile' ? { disagreements: [], workDisposition: disposition } : {}) });

async function fixture(t, settings = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1141-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'state'), MODES_HOME: join(dir, 'modes'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), AI_USAGE_TRACKER_DATA: join(dir, 'usage') };
  await initializeState(root, env);
  await registerSession(root, { session_id: 'session' }, env);
  await observeActivity(root, { session_id: 'session', permission_mode: 'default' }, env);
  await updateState(root, s => { Object.assign(s.workspace.sessions.session.settings, settings); s.generation++; return s; }, {}, env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
async function guard(f, toolName, toolInput, overrides = {}) {
  return classifyToolUse({ ...(await readState(f.root, f.env)), toolName, toolInput, executor: { sessionId: 'session' }, config: {}, env: f.env, ...overrides });
}
async function capture(f, prompt) {
  const input = { session_id: 'session', prompt };
  await recordOwnerPromptEvidence(f.root, input, f.env);
  return captureOwnerDelivery(f.root, input, (await readState(f.root, f.env)).state, f.env);
}
async function independent(f) {
  const entry = await capture(f, 'Update the approved documentation and tests.');
  await dispatchOwnerDeliveries(f.root, 'session', f.env, { spawnRunner: false });
  await sealReading(f.root, entry.id, 'Independent synthetic assessment.', f.env);
  return entry;
}
async function execute(f, phase, inspect = async () => {}, extra = {}) {
  const thread = options => ({ runStreamed: async (_input, runOptions) => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'synthetic-thread' };
    await inspect(options, runOptions);
    yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ...review(phase), ...extra }) } };
    yield { type: 'turn.completed' };
  })() }) });
  return runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex: async () => ({ startThread: thread, resumeThread: (_id, options) => thread(options) }) }, f.env);
}

test('documentation permissions apply with no role or any selected role; other file classes stay assigned', async t => {
  const f = await fixture(t);
  for (const role of [null, 'implementation', 'testWriting', 'testRunning', 'imageReview', 'gitDelivery', 'docs']) {
    if (role) await selectTaskRole(f.root, role, f.env);
    for (const tool of ['Edit', 'Write', 'mcp__files__edit_file']) {
      assert.equal((await guard(f, tool, { file_path: join(f.root, 'docs/Progress/Checkpoint.md') })).decision, 'defer', `${role}/${tool}`);
      for (const path of ['src/app.ts', 'docs/helper.js', 'package.json', 'CLAUDE.md', 'tests/example.test.js']) {
        assert.equal((await guard(f, tool, { file_path: join(f.root, path) })).decision, 'deny', path);
      }
    }
  }
  const values = { 'roles.implementation.executor': 'claude', 'roles.docs.executor': 'both', 'roles.testWriting.executor': 'codex' };
  for (const role of [null, 'implementation', 'docs', 'testWriting']) {
    const policy = authorshipPolicy(values, { role });
    assert.equal(policy.claudeDocuments, true); assert.equal(policy.codexDocuments, true); assert.equal(policy.codexTestEdits, true);
  }
  const denied = await fixture(t, { 'roles.docs.executor': 'codex' });
  const decision = await guard(denied, 'Edit', { file_path: join(denied.root, 'guide.md') });
  assert.equal(decision.decision, 'deny');
  assert.match(JSON.stringify(decision), /Documentation is assigned to codex/);
});

test('documentation still respects session, Discussion and concurrent writer boundaries', async t => {
  const f = await fixture(t), input = { file_path: join(f.root, 'guide.md') };
  assert.equal((await guard(f, 'Edit', input, { executor: { sessionId: 'another-session' } })).decision, 'deny');
  const current = (await readState(f.root, f.env)).state;
  const busy = { ...current, operations: [{ id: 'writer', status: 'working', request: { phase: 'reconcile', sandbox: 'workspace-write' } }] };
  assert.equal((await guard(f, 'Edit', input, { state: busy })).decision, 'deny');
  busy.operations[0].request.sandbox = 'read-only';
  assert.equal((await guard(f, 'Edit', input, { state: busy })).decision, 'defer');
  await observeActivity(f.root, { session_id: 'session', permission_mode: 'plan' }, f.env);
  assert.equal((await guard(f, 'Edit', input)).decision, 'deny');
});

test('short Modes commands skip ordinary capture; the expanded task creates one cycle', async t => {
  const f = await fixture(t);
  for (const name of ['work', 'discussion', 'ask']) {
    for (const suffix of ['', ' Update the guide.', '\nUpdate the guide.']) {
      const prompt = `/${name}${suffix}`;
      assert.equal(ownerFabexCommand(prompt), true);
      assert.equal(await capture(f, prompt), null);
    }
  }
  for (const text of ['/workshop', '/ask-more details', 'Explain /work', '`/work`', '/discussion.md']) assert.equal(ownerFabexCommand(text), false, text);
  assert.equal(ownerFabexCommand('/modes:work Update the guide.'), true);
  assert.equal(ownerFabexCommand('/fabex:settings'), true);
  assert.equal((await ownerDeliveries(f.root, f.env)).length, 0);
  const entry = await capture(f, 'Update the guide.');
  await dispatchOwnerDeliveries(f.root, 'session', f.env, { spawnRunner: false });
  const state = (await readState(f.root, f.env)).state;
  assert.equal(state.operations.length, 1); assert.equal(state.operations[0].id, entry.id);
});

test('role selection applies to the next queued turn, including between review phases', async t => {
  const f = await fixture(t), entry = await independent(f);
  await selectTaskRole(f.root, 'docs', f.env);
  await execute(f, 'independent', async options => {
    assert.equal(options.sandboxMode, 'read-only');
    await assert.rejects(selectTaskRole(f.root, 'testWriting', f.env), /Codex turn is running/);
  });
  await selectTaskRole(f.root, 'testWriting', f.env);
  await submitOperation(f.root, reconciliationEnvelope(entry.id, entry.text, 'Agreed.', remaining), f.env, { spawnRunner: false });
  await selectTaskRole(f.root, 'implementation', f.env);
  await execute(f, 'reconcile', async () => {
    assert.equal((await readState(f.root, f.env)).state.workspace.sessions.session.activeRole, 'implementation');
  });
});

test('assigned test execution is available while the task role is Test Writing', async t => {
  const f = await fixture(t, { 'roles.testRunning.executor': 'claude' });
  await selectTaskRole(f.root, 'testWriting', f.env);
  assert.equal((await guard(f, 'Bash', { command: 'node --test tests/unit/example.test.mjs' })).decision, 'defer');
  assert.equal((await guard(f, 'Bash', { command: 'printf changed > src/app.js' })).decision, 'deny');
});

test('computed sed ranges are reads; companion writes and executable sed remain checked', async t => {
  const f = await fixture(t);
  const lookup = 'grep -rn "export function executionPlan" scripts/lib | head -2; f=$(grep -rln "export function executionPlan" scripts/lib | head -1); n=$(grep -n "export function executionPlan" $f | cut -d: -f1); sed -n "${n},$((n+25))p" $f';
  for (const command of [lookup, `cd "${f.root}" && ${lookup}`, 'sed -n "${start},${end}p" "$file"', 'sed -n "${n},$((n + 25))p" "$file"']) {
    assert.equal(workCommandDenial(command, f.root), null, command);
    assert.equal((await guard(f, 'Bash', { command })).decision, 'defer');
  }
  for (const command of [
    `${lookup} > src/generated.js`, `${lookup} | tee src/generated.js`, `${lookup}; cp $file src/app.js`,
    'sed -i "${n}d" $file', 'sed -n "${n}w output.txt" $file', 'sed -n "${n}W output.txt" $file',
    'sed -n "${n}e touch output.txt" $file', 'sed -n "s/a/b/e" $file',
    'sed -n "$(touch output.txt)p" $file', 'sed -n "${n:-1w output.txt}" $file'
  ]) assert.ok(workCommandDenial(command, f.root), command);
});

test('split test-writing access works without selecting a test job and never applies application edits', async t => {
  const f = await fixture(t, { 'roles.implementation.executor': 'claude', 'roles.docs.executor': 'claude', 'roles.testWriting.executor': 'codex' });
  const entry = await independent(f);
  await execute(f, 'independent');
  await submitOperation(f.root, reconciliationEnvelope(entry.id, entry.text, 'Write the approved tests.', remaining), f.env, { spawnRunner: false });
  await execute(f, 'reconcile', async (options, runOptions) => {
    assert.equal(options.sandboxMode, 'read-only');
    assert.ok(runOptions.outputSchema.properties.testEdits);
  }, { testEdits: [{ path: 'tests/example.test.js', expectedHash: null, content: '// approved test\n' }] });
  assert.equal(await readFile(join(f.root, 'tests/example.test.js'), 'utf8'), '// approved test\n');
});

test('native document tools and assigned test edits coexist without transferring Coding', async t => {
  for (const applicationEdit of [false, true]) {
    const f = await fixture(t, { 'roles.implementation.executor': 'claude', 'roles.docs.executor': 'both', 'roles.testWriting.executor': 'codex' });
    const entry = await independent(f);
    await execute(f, 'independent');
    await submitOperation(f.root, reconciliationEnvelope(entry.id, entry.text, 'Update the approved documents and tests.', remaining), f.env, { spawnRunner: false });
    await execute(f, 'reconcile', async options => {
      assert.equal(options.sandboxMode, 'workspace-write');
      await writeFile(join(f.root, 'guide.md'), 'Approved documentation.');
      await mkdir(join(f.root, 'tests'));
      await writeFile(join(f.root, 'tests/example.test.js'), '// assigned test');
      if (applicationEdit) await writeFile(join(f.root, 'app.js'), '// unassigned application edit');
    });
    const warning = (await readState(f.root, f.env)).state.operations.at(-1).result.warning;
    if (applicationEdit) assert.match(warning, /Authorship check:.*app\.js/);
    else assert.equal(warning, null);
  }
});

test('an explicit scope-preserving reply does not produce a missing-record warning or clear work', () => {
  for (const pair of [[done, null], [null, done], [remaining, null], [null, remaining]]) for (const ownerAction of [null, 'Await the owner’s selection.']) {
    const cp = emptyCheckpoint();
    cp.openWork = ['Preserve the authorized implementation.', ...remaining.remainingWork]; cp.ownerActionRequired = ownerAction;
    const parent = { id: 'parent', request: { phase: 'independent' } };
    const op = { id: 'review', lifecycle: {}, request: { phase: 'reconcile', route: 'normal', parentOperationId: 'parent', ownerMessageDigest: 'a'.repeat(64), workDisposition: pair[0] }, result: { structured: review('reconcile', pair[1]), finalResponse: 'Reviewed.', relay: { sessionId: 'session', label: 'Codex' } } };
    const state = { route: 'normal', ownerSelectedMode: { route: 'normal' }, workspace: { activeSessionId: 'session' }, contextEvidence: { ownerPrompt: { digest: op.request.ownerMessageDigest } }, operations: [parent, op], partner: { thread: { checkpoint: cp } } };
    op.result.warning = persistWorkDisposition(state, op, '2026-01-01T00:00:00.000Z');
    assert.equal(op.result.warning, null);
    assert.doesNotMatch(relayBlock(op), /Fabex warning/);
    assert.deepEqual(cp.openWork, ['Preserve the authorized implementation.', ...remaining.remainingWork]);
    assert.equal(cp.ownerActionRequired, ownerAction);
    assert.equal(cp.continuation.armed, !ownerAction);
  }
  assert.match(dispositionProblem(done, undefined), /explicit disposition/);
  assert.match(dispositionProblem(remaining, done), /different outcomes/);
});

test('unrecorded remaining work is visible for either partner, including a partially recorded list', () => {
  const extended = { ...remaining, remainingWork: [...remaining.remainingWork, 'Review the updated examples.'] };
  for (const pair of [[extended, null], [null, extended]]) {
    for (const openWork of [[], remaining.remainingWork, ['Different authorized task.']]) {
      assert.match(dispositionProblem(...pair, { openWork }), /unfinished work not yet held in the checkpoint/);
    }
    assert.equal(dispositionProblem(...pair, { openWork: [...extended.remainingWork, 'Other retained work.'] }), null);
  }
  for (const pair of [[done, null], [null, done]]) assert.equal(dispositionProblem(...pair, { openWork: [] }), null);
});
