import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { registerSession, issueWorkspaceGrant, applyWorkspaceGrant, selectTaskRole, sealReading, workspaceStatus, recordWorkspaceQuestion, recordWorkspaceSelection } from '../../scripts/lib/workspace.mjs';
import { isTestTarget, authorshipPolicy } from '../../scripts/lib/authorship.mjs';
import { applyTestEdits } from '../../scripts/lib/test-edits.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { recordAuthorizedPrompt } from '../../scripts/lib/hook-evidence.mjs';
import { submitOperation, submissionEnvelope, claimNextOperation, runOperation } from '../../scripts/lib/sdk-controller.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1110-'))), root = join(dir, 'project'); await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'state'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') };
  await initializeState(root, env); await registerSession(root, { session_id: 'a' }, env);
  t.after(() => rm(dir, { recursive: true, force: true })); return { root, env };
}
const grant = (f, args, command = 'settings', session = 'a') => issueWorkspaceGrant(f.root, { command_name: `fabex:${command}`, command_args: args, session_id: session, expansion_type: 'slash_command', command_source: 'plugin' }, f.env, { catalog: async () => ({ models: [], error: null }) });
const settings = async (f, args, command, session) => applyWorkspaceGrant(f.root, (await grant(f, args, command, session)).id, f.env);
async function guard(f, path, toolName = 'Edit', overrides = {}) {
  return classifyToolUse({ ...(await readState(f.root, f.env)), toolName, toolInput: { file_path: join(f.root, path) }, executor: { sessionId: 'a' }, config: {}, env: f.env, ...overrides });
}
test('split and same-agent assignments grant only their file class; helper and read-only boundaries remain', async t => {
  for (const coder of ['claude', 'codex']) for (const writer of ['claude', 'codex']) {
    const f = await fixture(t); await settings(f, `roles.implementation.executor=${coder} roles.testWriting.executor=${writer} roles.testRunning.executor=codex`);
    await selectTaskRole(f.root, 'testWriting', f.env);
    for (const path of ['tests/unit/example.ts', 'src/example.test.ts', 'src/config.test.ts', 'test_example.py', 'src/main_test.go']) assert.equal((await guard(f, path)).decision, writer === 'claude' ? 'defer' : 'deny', `${coder}/${writer} ${path}`);
    for (const path of ['src/app.ts', 'package.json', 'tests/runner.config.js']) assert.equal((await guard(f, path)).decision, coder === 'claude' ? 'defer' : 'deny');
    assert.equal((await guard(f, 'tests/a.ts', 'Edit', { executor: { sessionId: 'a', agentId: 'helper' } })).decision, 'deny');
    assert.equal((await guard(f, 'tests/a.ts', 'mcp__files__edit_file')).decision, coder === 'claude' && writer === 'claude' ? 'defer' : 'deny');
    const current = (await readState(f.root, f.env)).state;
    for (const route of ['discussion', 'recovery-read-only']) assert.equal((await guard(f, 'tests/a.ts', 'Edit', { state: { ...current, route } })).decision, 'deny');
    const p = authorshipPolicy((await workspaceStatus(f.root, f.env)).values, { role: 'testWriting' });
    assert.equal(p.codexTestEdits, coder === 'claude' && writer === 'codex');
    assert.match(p.instructions, new RegExp(`Test Writing belongs to ${writer}`)); assert.match(p.instructions, /Test Running belongs to codex/);
  }
});
test('test classification and batch application reject escapes, links, configuration, mixed batches and stale reads', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'tests')); await writeFile(join(f.root, 'app.js'), 'application'); await writeFile(join(f.root, 'tests/a.js'), 'old');
  await symlink(join(f.root, 'app.js'), join(f.root, 'tests/link.js')); await link(join(f.root, 'app.js'), join(f.root, 'tests/hard.js'));
  await symlink(join(f.root, 'tests'), join(f.root, 'linked'));
  for (const path of ['../tests/a.js', '.github/tests/a.js', 'tests/AGENTS.md', 'tests/link.js', 'tests/hard.js', 'linked/a.test.js', 'tests/package.json', 'tests/conftest.py', 'src/application.ts', 'tests/runner.config.js']) assert.equal(isTestTarget(path, f.root), false, path);
  const edit = { path: 'tests/a.js', expectedHash: sha('old'), content: 'new' };
  assert.throws(() => applyTestEdits(f.root, [edit, { path: 'app.js', expectedHash: sha('application'), content: 'bad' }]), /recognized/);
  assert.equal(await readFile(join(f.root, 'tests/a.js'), 'utf8'), 'old');
  assert.throws(() => applyTestEdits(f.root, [{ ...edit, expectedHash: sha('stale') }]), /changed/);
  applyTestEdits(f.root, [edit, { path: 'src/new.test.ts', expectedHash: null, content: 'new test' }]);
  assert.equal(await readFile(join(f.root, 'tests/a.js'), 'utf8'), 'new'); assert.equal(await readFile(join(f.root, 'app.js'), 'utf8'), 'application');
});
test('milestone-only writer and runner choices survive new chats but do not leak to another milestone', async t => {
  const f = await fixture(t); await settings(f, 'Plan One', 'milestone');
  const g = await grant(f, '');
  async function choose(labels) {
    const current = (await readState(f.root, f.env)).state.workspace.grants[g.id];
    const input = { tool_name: 'AskUserQuestion', session_id: 'a', tool_use_id: `test-${current.flow.stage}`, tool_input: { questions: current.questions }, tool_response: { answers: Object.fromEntries(current.questions.map((q,i) => [q.question, labels[i]])) } };
    await recordWorkspaceQuestion(f.root, { ...input, hook_event_name: 'PreToolUse' }, f.env);
    assert.ok(await recordWorkspaceSelection(f.root, { ...input, hook_event_name: 'PostToolUse' }, f.env));
  }
  await choose(['Who does what']); await choose(['Testing','Continue']); await choose(['Claude','Codex','This milestone','Apply']); await applyWorkspaceGrant(f.root, g.id, f.env);
  await registerSession(f.root, { session_id: 'b' }, f.env);
  let status = await workspaceStatus(f.root, f.env, 'b');
  assert.equal(status.values['roles.testWriting.executor'], 'claude'); assert.equal(status.values['roles.testRunning.executor'], 'codex'); assert.equal(status.sources['roles.testWriting.executor'], 'milestone');
  await settings(f, 'Plan Two', 'milestone', 'b'); status = await workspaceStatus(f.root, f.env, 'b');
  assert.equal(status.values['roles.testWriting.executor'], 'codex'); assert.equal(status.values['roles.testRunning.executor'], 'claude');
  await settings(f, 'Plan One', 'milestone', 'b');
  await settings(f, 'roles.testWriting.executor=inherit scope=milestone', 'settings', 'b'); status = await workspaceStatus(f.root, f.env, 'b');
  assert.equal(status.values['roles.testWriting.executor'], 'codex'); assert.equal(status.values['roles.testRunning.executor'], 'codex');
});
const review = edits => JSON.stringify({ scopeMismatch: null, parityConcern: null, answer: 'Proposed tests.', ownerSummary: 'Proposed tests.', evidence: [], assumptions: [], uncertainties: [], recommendation: null, changedFiles: [], tests: [], testEdits: edits });
test('split Codex test writer stays read-only with no helpers and controller applies tests only after successful authorized turns', async t => {
  for (const outcome of ['success','failure','scope-change','cancelled','truncated']) {
    const f = await fixture(t); await settings(f, 'roles.implementation.executor=claude roles.testWriting.executor=codex roles.testRunning.executor=claude'); await selectTaskRole(f.root, 'testWriting', f.env);
    const owner = 'Write the tests.'; await recordAuthorizedPrompt(f.root, owner, 'a', f.env);
    const queued = await submitOperation(f.root, submissionEnvelope(owner), f.env, { spawnRunner: false }); await sealReading(f.root, queued.operationId, 'Independent review.', f.env);
    const factory = async (config, context) => {
      assert.equal(context.helperServers, 'off'); assert.match(config.config.developer_instructions, /TEST WRITING:/);
      return { startThread: options => {
        assert.equal(options.sandboxMode, 'read-only'); assert.equal(options.approvalPolicy, 'never');
        return { runStreamed: async (_input, opts) => {
          assert.ok(opts.outputSchema.properties.testEdits);
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'split-thread' };
            if (outcome === 'cancelled') { const r = await updateState(f.root, s => { s.operations[0].lifecycle.cancelRequested = true; s.generation++; return s; }, {}, f.env); assert.equal(r.ok, true); }
            if (outcome === 'scope-change') {
              const change = await updateState(f.root, s => { s.workspace.sessions.a.settings['roles.testWriting.executor'] = 'claude'; s.generation++; return s; }, {}, f.env); assert.equal(change.ok, true);
            }
            yield { type: 'item.completed', item: { type: 'agent_message', text: review([{ path: 'tests/new.test.js', expectedHash: null, content: 'test code' }]) } };
            if (outcome === 'failure') yield { type: 'turn.failed', error: { message: 'fixture failure' } }; else if (outcome !== 'truncated') yield { type: 'turn.completed' };
          })() };
        } };
      } };
    };
    const work = runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex: factory }, f.env);
    if (outcome === 'success') {
      await work; assert.equal(await readFile(join(f.root, 'tests/new.test.js'), 'utf8'), 'test code');
      const saved = (await readState(f.root, f.env)).state.operations[0]; assert.match(saved.result.warning, /Controller applied 1/); assert.doesNotMatch(saved.result.warning, /Authorship check:/); assert.equal('testEdits' in saved.result.structured, false);
    } else { await assert.rejects(work); await assert.rejects(readFile(join(f.root, 'tests/new.test.js')), /ENOENT/); }
  }
});
