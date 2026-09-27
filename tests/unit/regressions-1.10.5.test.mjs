import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeState, readState } from '../../scripts/lib/state.mjs';
import { sidecar } from '../../scripts/lib/private-store.mjs';
import { registerSession, selectTaskRole, sealReading, milestoneHandoff, issueWorkspaceGrant, applyWorkspaceGrant } from '../../scripts/lib/workspace.mjs';
import { submitOperation, submissionEnvelope, reconciliationEnvelope, claimNextOperation, runOperation } from '../../scripts/lib/sdk-controller.mjs';
import { recordAuthorizedPrompt } from '../../scripts/lib/hook-evidence.mjs';
import { classifyToolUse, parseControlCommand } from '../../scripts/hook-route-guard.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-1105-'))), root = join(dir, 'project');
  await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'private') };
  await initializeState(root, env); await registerSession(root, { session_id: 'a' }, env);
  await selectTaskRole(root, 'docs', env);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root, env };
}
async function classify(f, toolName = 'Edit', toolInput = { file_path: join(f.root, 'HANDOFF.md'), old_string: 'Next', new_string: 'Next steps' }, overrides = {}) {
  const { state, paths } = await readState(f.root, f.env);
  return classifyToolUse({ state, paths, config: {}, env: f.env, executor: { sessionId: 'a' }, toolName, toolInput, ...overrides });
}

test('1.10.5 both partners update the existing handoff through the ordinary controller and preserve continuity', async t => {
  const f = await fixture(t), file = join(f.root, 'HANDOFF.md');
  const original = '# Handoff\n\n## Decisions\nKeep the existing API.\n\n## Completed\n\n## Next steps\nReview deployment.\n';
  await writeFile(file, original);
  await writeFile(join(f.root, 'README.md'), 'Existing project README.\n');
  // Previously saved private work is neither required nor discarded by the upgrade.
  const legacy = await sidecar(f.root, 'documentation-legacy.json', f.env);
  await writeFile(legacy, '{"saved":"old owner work"}');
  const g = await issueWorkspaceGrant(f.root, { command_name: 'fabex:settings', command_args: 'partners.codex.model=main-model roles.docs.model=docs-model roles.docs.effort=low', session_id: 'a', expansion_type: 'slash_command', command_source: 'plugin' }, f.env);
  await applyWorkspaceGrant(f.root, g.id, f.env);
  assert.equal((await classify(f)).decision, 'defer');
  await writeFile(file, original.replace('Keep the existing API.', 'Keep the existing API. Claude verified the owner decision.'));
  const owner = 'Update our existing HANDOFF.md together so the next chat can continue.';
  await recordAuthorizedPrompt(f.root, owner, 'a', f.env);
  const first = await submitOperation(f.root, submissionEnvelope(owner), f.env, { spawnRunner: false });
  assert.equal(await claimNextOperation(f.root, f.env), null, 'strategy assessment still requires sealing');
  await sealReading(f.root, first.operationId, 'Independent assessment of the requested handoff correction.', f.env);
  const requests = [];
  let active;
  const createCodex = async () => {
    const thread = options => ({ runStreamed: async (input, runOptions) => {
      requests.push({ input, options, schema: runOptions.outputSchema });
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'shared-handoff-thread' };
        assert.equal((await classify(f)).decision, 'deny', 'Claude waits while Codex edits');
        assert.equal((await classify(f, 'Read', { file_path: file })).decision, 'defer');
        const existing = await readFile(file, 'utf8');
        assert.match(existing, /Claude verified the owner decision/);
        if (active.request.phase === 'independent') {
          await writeFile(file, existing.replace('## Completed\n', '## Completed\nCodex implemented the fix and ran its tests.\n'));
        } else {
          assert.match(existing, /Claude checked the test evidence/);
          await writeFile(file, existing.replace('Review deployment.', 'Review deployment. Codex confirmed no migration is needed.'));
        }
        const response = { scopeMismatch: null, parityConcern: null, answer: 'Updated the existing handoff and checked the shared content.', ownerSummary: 'The shared handoff is ready.', evidence: [], assumptions: [], uncertainties: [], recommendation: null, changedFiles: ['HANDOFF.md'], tests: [], ...(active.request.phase === 'reconcile' ? { disagreements: [] } : {}) };
        yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
      })() };
    } });
    return { startThread: thread, resumeThread: (_id, options) => thread(options) };
  };
  active = await claimNextOperation(f.root, f.env);
  await runOperation(f.root, active, { createCodex }, f.env);
  assert.equal((await classify(f)).decision, 'defer');
  const afterCodex = await readFile(file, 'utf8');
  assert.match(afterCodex, /Codex implemented the fix/);
  await writeFile(file, afterCodex.replace('## Next steps\n', '## Next steps\nClaude checked the test evidence.\n'));
  const review = await submitOperation(f.root, reconciliationEnvelope(first.operationId, owner, 'I read the same handoff, verified the decision and test evidence, and updated the next steps.'), f.env, { spawnRunner: false });
  active = await claimNextOperation(f.root, f.env);
  await runOperation(f.root, active, { createCodex }, f.env);
  assert.equal(requests[0].options.model, 'main-model');
  assert.equal(requests[1].options.model, 'docs-model');
  assert.equal(requests[1].options.modelReasoningEffort, 'low');
  for (const r of requests) {
    assert.equal(r.schema.properties.documentation, undefined);
    assert.ok(!r.schema.required.includes('documentation'));
    assert.match(r.input, /Read the existing file/);
    assert.doesNotMatch(r.input, /COMPLETED INDEPENDENT DOCUMENTATION CONTRIBUTIONS/);
  }
  const final = await readFile(file, 'utf8');
  assert.match(final, /Claude verified the owner decision/);
  assert.match(final, /Codex implemented the fix/);
  assert.match(final, /Claude checked the test evidence/);
  assert.match(final, /Codex confirmed no migration/);
  assert.deepEqual(final.match(/^#+ .*$/gm), original.match(/^#+ .*$/gm), 'keep topic headings');
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'Existing project README.\n');
  assert.deepEqual((await readdir(f.root)).sort(), ['HANDOFF.md', 'README.md']);
  assert.equal(await readFile(legacy, 'utf8'), '{"saved":"old owner work"}');
  assert.deepEqual((await readdir(dirname(legacy))).filter(n => n.startsWith('documentation-')), ['documentation-legacy.json']);
  await milestoneHandoff(f.root, review.operationId, 'Continue from HANDOFF.md; review deployment next.', false, f.env);
  await milestoneHandoff(f.root, review.operationId, null, true, f.env);
  const state = (await readState(f.root, f.env)).state;
  assert.match(state.partner.thread.checkpoint.nextAction, /HANDOFF.md/);
  assert.equal(await readFile(file, 'utf8'), final, 'rotation reuses the same handoff');
});

test('1.10.5 shared documentation authoring stays session-bound, serial and work-only', async t => {
  const f = await fixture(t);
  const { state } = await readState(f.root, f.env);
  for (const toolName of ['Write', 'Edit']) assert.equal((await classify(f, toolName)).decision, 'defer');
  assert.equal((await classify(f, 'Edit', undefined, { executor: { sessionId: 'other' } })).decision, 'deny');
  assert.equal((await classify(f, 'Edit', undefined, { executor: { sessionId: 'a', agentId: 'helper' } })).decision, 'deny');
  assert.equal((await classify(f, 'Edit', undefined, { state: { ...state, route: 'discussion' } })).decision, 'deny');
  assert.equal((await classify(f, 'Edit', undefined, { state: { ...state, modeGrant: { pausedAt: Date.now() } } })).decision, 'deny');
  await selectTaskRole(f.root, 'implementation', f.env);
  assert.equal((await classify(f)).decision, 'deny', 'Docs Both does not change the coding role');
});

test('1.10.5 single-writer Docs choices still control Claude authoring', async t => {
  const f = await fixture(t);
  for (const writer of ['codex', 'claude', 'both']) {
    const grant = await issueWorkspaceGrant(f.root, { command_name: 'fabex:settings', command_args: `roles.docs.executor=${writer}`, session_id: 'a', expansion_type: 'slash_command', command_source: 'plugin' }, f.env);
    await applyWorkspaceGrant(f.root, grant.id, f.env);
    assert.equal((await classify(f)).decision, writer === 'codex' ? 'deny' : 'defer');
  }
});

test('1.10.5 old draft commands fail clearly without writing or assembling files', async t => {
  const f = await fixture(t), script = new URL('../../scripts/control.mjs', import.meta.url).pathname;
  const id = '12345678-1234-1234-1234-123456789abc';
  const run = promisify(execFile);
  for (const command of ['draft', 'read', 'assemble']) {
    assert.equal(parseControlCommand(`node "${script}" docs ${command} --operation-id ${id}`), null);
    await assert.rejects(run(process.execPath, [script, 'docs', command, '--operation-id', id], { cwd: f.root, env: f.env }), e => {
      assert.match(e.stderr, /Retired: Docs Both updates the shared document directly/);
      return true;
    });
  }
  assert.deepEqual(await readdir(f.root), []);
});
