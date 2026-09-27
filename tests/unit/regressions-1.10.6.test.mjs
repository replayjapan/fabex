import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { captureAuthorship, authorshipWarning, mergeWarnings } from '../../scripts/lib/authorship-audit.mjs';
import { relayBlock, missingRelays } from '../../scripts/lib/review.mjs';
import { settingsView } from '../../scripts/lib/settings-view.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeState, readState } from '../../scripts/lib/state.mjs';
import { registerSession, issueWorkspaceGrant, applyWorkspaceGrant, selectTaskRole, sealReading, workspaceStatus } from '../../scripts/lib/workspace.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { authorshipPolicy, isDocumentationTarget } from '../../scripts/lib/authorship.mjs';
import { recordAuthorizedPrompt } from '../../scripts/lib/hook-evidence.mjs';
import { submitOperation, submissionEnvelope, reconciliationEnvelope, claimNextOperation, runOperation } from '../../scripts/lib/sdk-controller.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1106-'))), root = join(dir, 'project');
  await mkdir(root); const env = { ...process.env, FABEX_HOME: join(dir, 'private') };
  await initializeState(root, env); await registerSession(root, { session_id: 'a' }, env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
async function settings(f, args) {
  const g = await issueWorkspaceGrant(f.root, { command_name: 'fabex:settings', command_args: args, session_id: 'a', expansion_type: 'slash_command', command_source: 'plugin' }, f.env);
  await applyWorkspaceGrant(f.root, g.id, f.env);
}
async function classify(f, toolName, toolInput, overrides = {}) {
  const { state, paths } = await readState(f.root, f.env);
  return classifyToolUse({ state, paths, config: {}, env: f.env, executor: { sessionId: 'a' }, toolName, toolInput, ...overrides });
}

test('1.10.6 documentation is a file classification, not all contents of a docs folder', async t => {
  const f = await fixture(t);
  for (const name of ['HANDOFF.md', 'plans/phase-one.markdown', 'docs/notes.txt', 'docs/overview.rst', 'README']) assert.equal(isDocumentationTarget(name, f.root), true, name);
  for (const name of ['app.ts', 'docs/example.js', 'docs/render.mdx', 'package.json', 'config.yaml', 'AGENTS.md', 'skills/SKILL.md', '.claude/notes.md', '../outside.md', '', null]) assert.equal(isDocumentationTarget(name, f.root), false, String(name));
  await writeFile(join(f.root, 'app.ts'), 'code');
  await symlink(join(f.root, 'app.ts'), join(f.root, 'linked.md'));
  await link(join(f.root, 'app.ts'), join(f.root, 'hardlink.md'));
  await mkdir(join(f.root, 'real')); await symlink(join(f.root, 'real'), join(f.root, 'linked-dir'));
  for (const name of ['linked.md', 'hardlink.md', 'linked-dir/new.md']) assert.equal(isDocumentationTarget(name, f.root), false);
});

test('1.10.6 Docs Both allows shared text edits but does not transfer code ownership', async t => {
  const f = await fixture(t); await selectTaskRole(f.root, 'docs', f.env);
  for (const tool of ['Write', 'Edit', 'mcp__files__edit_file']) {
    assert.equal((await classify(f, tool, { file_path: join(f.root, 'HANDOFF.md') })).decision, 'defer');
    for (const path of ['app.ts', 'test.spec.js', 'docs/script.js', 'package.json']) assert.equal((await classify(f, tool, { file_path: join(f.root, path) })).decision, 'deny');
    assert.equal((await classify(f, tool, {})).decision, 'deny');
  }
  assert.equal((await classify(f, 'Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'app.js\',\'x\')"' })).decision, 'deny');
  assert.equal((await classify(f, 'Bash', { command: 'echo changed > app.js' })).decision, 'deny');
  assert.equal((await classify(f, 'Edit', { file_path: join(f.root, 'HANDOFF.md') }, { executor: { sessionId: 'other' } })).decision, 'deny');
});

test('1.10.6 the Coding selection applies across roles and named helper exceptions stay scoped', async t => {
  const f = await fixture(t);
  await settings(f, 'roles.testWriting.executor=claude');
  await selectTaskRole(f.root, 'testWriting', f.env);
  const edit = { file_path: join(f.root, 'app.test.js') };
  assert.equal((await classify(f, 'Edit', edit)).decision, 'deny');
  await settings(f, 'roles.implementation.executor=claude');
  assert.equal((await classify(f, 'Edit', edit)).decision, 'defer');
  await selectTaskRole(f.root, 'docs', f.env);
  assert.equal((await classify(f, 'Edit', edit)).decision, 'defer');
  assert.equal((await classify(f, 'Edit', edit, { executor: { sessionId: 'a', agentId: 'helper-one' } })).decision, 'deny');
  const { state } = await readState(f.root, f.env);
  const busy = { ...state, controller: { ...state.controller, activeOperationId: 'active-docs-turn' } };
  assert.equal((await classify(f, 'Edit', { file_path: join(f.root, 'HANDOFF.md') }, { state: busy })).decision, 'deny', 'shared document edits remain serial even when Claude owns Coding');
  state.executorException = { executor: 'helper-one', scope: 'project file edits' };
  assert.equal((await classify(f, 'Edit', edit, { state, executor: { sessionId: 'a', agentId: 'helper-one' } })).decision, 'defer');
  assert.equal((await classify(f, 'Edit', edit, { state, executor: { sessionId: 'a', agentId: 'helper-two' } })).decision, 'deny');
  assert.equal((await classify(f, 'Edit', edit, { state: { ...state, route: 'discussion' }, executor: { sessionId: 'a', agentId: 'helper-one' } })).decision, 'deny');
});

test('1.10.6 Codex receives assignment-based authority and read-only non-document turns when Claude codes', async t => {
  for (const [coder, role, sandbox] of [['claude', 'implementation', 'read-only'], ['claude', 'testWriting', 'read-only'], ['claude', 'docs', 'workspace-write'], ['codex', 'docs', 'workspace-write']]) {
    const f = await fixture(t); await settings(f, `roles.implementation.executor=${coder}`);
    await selectTaskRole(f.root, role, f.env);
    const owner = 'Continue the selected task.'; await recordAuthorizedPrompt(f.root, owner, 'a', f.env);
    const first = await submitOperation(f.root, submissionEnvelope(owner), f.env, { spawnRunner: false });
    await sealReading(f.root, first.operationId, 'My independent review.', f.env);
    const createCodex = async config => ({ startThread: options => ({ runStreamed: async input => {
      assert.equal(options.sandboxMode, sandbox);
      assert.match(input, new RegExp(`sandbox=${sandbox}`));
      assert.ok(config.config.developer_instructions.includes(`selected Coding AI: ${coder}`));
      assert.match(config.config.developer_instructions, /Other task assignments do not transfer code-editing authority/);
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'authority-thread' };
        yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ scopeMismatch: null, parityConcern: null, answer: 'Reviewed.', ownerSummary: 'Reviewed.', evidence: [], assumptions: [], uncertainties: [], recommendation: null, changedFiles: [], tests: [] }) } };
        yield { type: 'turn.completed' };
      })() };
    } }) });
    await runOperation(f.root, await claimNextOperation(f.root, f.env), { createCodex }, f.env);
    assert.equal((await readState(f.root, f.env)).state.partner.envelope.sandbox, sandbox);
  }
  const p = authorshipPolicy({ 'roles.implementation.executor': 'claude', 'roles.docs.executor': 'claude' }, { role: 'docs' });
  assert.equal(p.codexDocuments, false);
});


test('1.10.6 file audit detects existing dirty edits, additions and deletions without flagging shared documents', async t => {
  const f = await fixture(t);
  execFileSync('git', ['init', '-q', f.root]);
  await writeFile(join(f.root, 'app.js'), 'original');
  await writeFile(join(f.root, 'removed.js'), 'original');
  execFileSync('git', ['-C', f.root, 'add', '.']);
  await writeFile(join(f.root, 'app.js'), 'already dirty');
  await writeFile(join(f.root, 'HANDOFF.md'), 'existing handoff');
  const before = await captureAuthorship(f.root);
  assert.equal(authorshipWarning(before, await captureAuthorship(f.root)), null);
  await writeFile(join(f.root, 'HANDOFF.md'), 'shared update');
  await writeFile(join(f.root, 'PLAN.md'), 'new document');
  assert.equal(authorshipWarning(before, await captureAuthorship(f.root)), null);
  await writeFile(join(f.root, 'app.js'), 'second dirty edit');
  await writeFile(join(f.root, 'new.test.js'), 'new test');
  await rm(join(f.root, 'removed.js'));
  const warning = authorshipWarning(before, await captureAuthorship(f.root));
  for (const file of ['app.js', 'new.test.js', 'removed.js']) assert.ok(warning.includes(JSON.stringify(file)));
  assert.doesNotMatch(warning, /HANDOFF|PLAN/);
  assert.match(warning, /not prevention or proof/);
  assert.match(authorshipWarning({ ...before, incomplete: true }, before), /could not be checked/);
  const longNames = { files: new Map(Array.from({ length: 10 }, (_, i) => [`${'資料'.repeat(100)}${i}.js`, { hash: 'new', document: false }])) };
  const bounded = mergeWarnings(authorshipWarning({ files: new Map() }, longNames), 'Additional warning.');
  assert.ok(Buffer.byteLength(bounded) <= 1024);
  assert.match(bounded, /path shortened/);
  assert.match(bounded, /9 more/);
});

test('1.10.6 controller flags non-coding Codex changes on completion, failure and cancellation; relay cannot omit warning', async t => {
  for (const outcome of ['completed', 'failed', 'cancelled']) {
    const f = await fixture(t);
    await settings(f, 'roles.implementation.executor=claude');
    await selectTaskRole(f.root, 'docs', f.env);
    const owner = 'Update the shared handoff.';
    await recordAuthorizedPrompt(f.root, owner, 'a', f.env);
    const first = await submitOperation(f.root, submissionEnvelope(owner), f.env, { spawnRunner: false });
    await sealReading(f.root, first.operationId, 'Independent reading.', f.env);
    const createCodex = async () => ({ startThread: () => ({ runStreamed: async () => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'audit-thread' };
      await writeFile(join(f.root, 'HANDOFF.md'), 'Shared document.');
      await writeFile(join(f.root, 'unexpected.js'), 'Unexpected source edit.');
      if (outcome !== 'completed') throw Object.assign(new Error('test interruption'), { name: outcome === 'cancelled' ? 'AbortError' : 'Error' });
      yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ scopeMismatch: null, parityConcern: null, answer: 'Updated.', ownerSummary: 'Updated.', evidence: [], assumptions: [], uncertainties: [], recommendation: null, changedFiles: [], tests: [] }) } };
      yield { type: 'turn.completed' };
    })() }) }) });
    const operation = await claimNextOperation(f.root, f.env);
    if (outcome === 'failed') await assert.rejects(runOperation(f.root, operation, { createCodex }, f.env), /test interruption/);
    else await runOperation(f.root, operation, { createCodex }, f.env);
    const { state } = await readState(f.root, f.env), saved = state.operations.find(op => op.id === first.operationId);
    assert.equal(saved.status, outcome);
    assert.match(saved.result.warning, /unexpected\.js/);
    assert.doesNotMatch(saved.result.warning, /HANDOFF/);
    assert.match(relayBlock(saved), /unexpected\.js/);
    if (outcome === 'completed') {
      assert.equal(missingRelays(state, { session_id: 'a', last_assistant_message: `${saved.result.relay.label} Updated.` }).length, 1);
      assert.equal(missingRelays(state, { session_id: 'a', last_assistant_message: relayBlock(saved) }).length, 0);
      const next = await submitOperation(f.root, reconciliationEnvelope(first.operationId, owner, 'Review the controller flag.'), f.env, { spawnRunner: false });
      const child = (await readState(f.root, f.env)).state.operations.find(op => op.id === next.operationId);
      assert.match(child.request.message, /CONTROLLER WARNING \(Phase 1\):[\s\S]*unexpected\.js/);
    }
  }
});

test('1.10.6 Testing describes the runner and Coding ownership even when legacy writing preference differs', async t => {
  const f = await fixture(t);
  await settings(f, 'roles.testRunning.executor=claude');
  for (const coder of ['codex', 'claude']) {
    await settings(f, `roles.implementation.executor=${coder}`);
    const view = await settingsView(await workspaceStatus(f.root, f.env, 'a'), f.env);
    const line = view.split('\n').find(line => line.startsWith('Testing:'));
    assert.match(line, /Claude .* runs tests/);
    assert.ok(line.includes(`test code is written by the Coding AI (${coder === 'codex' ? 'Codex' : 'Claude'})`));
    assert.doesNotMatch(line, /writing:/);
  }
});
