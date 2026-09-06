import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { issueModeGrant } from '../../scripts/lib/hook-evidence.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { captureClaudeModel } from '../../scripts/hook-session.mjs';
import { missingRelays, relayBlock } from '../../scripts/lib/review.mjs';
import { claimNextOperation, submissionEnvelope, submitOperation } from '../../scripts/lib/sdk-controller.mjs';
import { validateState } from '../../scripts/lib/validation.mjs';

const plugin = resolve(import.meta.dirname, '../..');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-181-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'state'), CLAUDE_CONFIG_DIR: join(directory, 'claude'), CODEX_HOME: join(directory, 'codex') };
  const initialized = await initializeState(project, env);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env, ...initialized, config: (await loadEffectiveConfig(project, env)).config };
}
function run(f, script, args = [], input = {}) {
  const output = spawnSync(process.execPath, [join(plugin, 'scripts', script), ...args], { cwd: f.project, env: f.env, encoding: 'utf8', input: JSON.stringify({ cwd: f.project, ...input }) });
  assert.equal(output.status, 0, output.stderr);
  return JSON.parse(output.stdout);
}

test('1.8.1 relay omits JSON, renders only non-empty flags, and preserves exact-answer checks', () => {
  const answer = 'Scope mismatch: none.\n\n“Exact” owner-facing words.\n\nFinal paragraph.';
  const operation = { status: 'completed', request: { phase: 'reconcile' }, result: {
    finalResponse: answer, warning: null,
    relay: { label: 'Codex (Astra):', sessionId: 'session-a', status: 'pending' },
    structured: { answer, scopeMismatch: null, parityConcern: '', disagreements: [], uncertainties: [], evidence: ['internal evidence'], assumptions: ['internal assumption'], recommendation: 'internal recommendation', changedFiles: ['internal-file'], tests: [{ command: 'internal-test', exitCode: 0 }] }
  } };
  const original = structuredClone(operation);
  let block = relayBlock(operation);
  assert.equal(block, `Codex (Astra): Phase 2 — reconciliation/corrections\n\n${answer.split('\n').map(line => '> ' + line).join('\n')}`);
  assert.deepEqual(operation, original);
  Object.assign(operation.result.structured, { scopeMismatch: 'Read-only scope', parityConcern: 'Keep complete words', disagreements: ['Different conclusion', ' '], uncertainties: ['Not observed live', ''] });
  block = relayBlock(operation);
  for (const text of ['Codex flags:', '- Scope mismatch: Read-only scope', '- Parity concern: Keep complete words', '- Disagreement: Different conclusion', '- Uncertainty: Not observed live']) assert.ok(block.includes(text));
  assert.doesNotMatch(block, /Structured review fields|```json|internal-|internal evidence|internal assumption|internal recommendation/);
  assert.deepEqual(missingRelays({ operations: [operation] }, { session_id: 'session-a', last_assistant_message: block }), []);
  assert.equal(missingRelays({ operations: [operation] }, { session_id: 'session-a', last_assistant_message: block.replace('Final paragraph.', '') }).length, 1);
  assert.equal(missingRelays({ operations: [operation] }, { session_id: 'session-a', last_assistant_message: block.replace('Codex (Astra):', '') }).length, 1);
  operation.result.structured = null; operation.result.warning = 'Structured output unavailable';
  assert.match(relayBlock(operation), /Fabex warning: Structured output unavailable/);
});

test('1.8.1 composed mode commands receive shape guidance without weakening image denial or grants', async (t) => {
  const f = await fixture(t);
  const image = join(f.project, 'photo.jpg'); await writeFile(image, 'isolated fixture');
  const grant = await issueModeGrant(f.project, { sessionId: 'session-a', route: 'discussion', participants: 'both', ownerMessage: 'image' }, f.env);
  const current = await readState(f.project, f.env);
  const command = `node "${join(plugin, 'scripts/control.mjs')}" mode discussion --participants both --grant ${grant.id} --attach "${image}"`;
  const classify = (toolName, toolInput) => classifyToolUse({ ...current, config: f.config, env: f.env, toolName, toolInput, executor: { sessionId: 'session-a' } });
  assert.equal((await classify('Bash', { command })).decision, 'defer');
  for (const composed of [`cd "${f.project}" && ${command}`, `${command} | head`, `${command}; echo done`, `${command} && pwd`]) {
    const denied = await classify('Bash', { command: composed });
    assert.equal(denied.decision, 'deny'); assert.match(denied.reason, /not an exact Fabex control.*standalone.*prefix, chain, or pipe/);
  }
  for (const [toolName, toolInput] of [['Read', { file_path: image }], ['Bash', { command: `cat "${image}"` }]]) {
    const denied = await classify(toolName, toolInput); assert.equal(denied.decision, 'deny'); assert.match(denied.reason, /Image inspection belongs to Codex/);
  }
  assert.deepEqual((await readState(f.project, f.env)).state.modeGrant, current.state.modeGrant);
  const withoutGrant = structuredClone(current); withoutGrant.state.modeGrant = null;
  assert.equal((await classifyToolUse({ ...withoutGrant, config: f.config, env: f.env, toolName: 'Bash', toolInput: { command }, executor: { sessionId: 'session-a' } })).decision, 'deny');
});

test('1.8.1 model-less same-session SessionStart retains metadata and exposes bounded diagnosis', async (t) => {
  const f = await fixture(t);
  run(f, 'hook-session.mjs', [], { hook_event_name: 'SessionStart', session_id: 'session-a', model: 'claude-fable-5-1', source: 'compact' });
  const before = (await readState(f.project, f.env)).state.claudeModel;
  const output = run(f, 'hook-session.mjs', [], { hook_event_name: 'SessionStart', session_id: 'session-a', source: 'resume', transcript_path: 'never-read-private-transcript' });
  assert.match(output.hookSpecificOutput.additionalContext, /Claude \(Fable\):/);
  const state = (await readState(f.project, f.env)).state;
  assert.deepEqual(state.claudeModel, before);
  assert.deepEqual(Object.keys(state.sessionStartDiagnostic).sort(), ['at', 'modelStatus', 'sessionId', 'source']);
  assert.equal(state.sessionStartDiagnostic.source, 'resume'); assert.equal(state.sessionStartDiagnostic.modelStatus, 'absent');
  assert.doesNotMatch(JSON.stringify(state.sessionStartDiagnostic), /transcript/);
  const diagnose = run(f, 'control.mjs', ['diagnose']);
  assert.deepEqual(diagnose.claude.model, before); assert.equal(diagnose.claude.lastSessionStart.modelStatus, 'absent'); assert.match(diagnose.claude.explanation, /Not a per-response/);
});

test('1.8.1 cross-session starts and invalid model switches use honest unknown labels', async (t) => {
  const f = await fixture(t);
  run(f, 'hook-session.mjs', [], { hook_event_name: 'SessionStart', session_id: 'session-a', model: 'claude-fable-5-1' });
  const output = run(f, 'hook-session.mjs', [], { hook_event_name: 'SessionStart', session_id: 'session-b', source: 'resume' });
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Claude \(Fable\)/);
  assert.equal((await readState(f.project, f.env)).state.claudeModel, null);
  let state = (await readState(f.project, f.env)).state;
  captureClaudeModel(state, { hook_event_name: 'SessionStart', session_id: 'session-b', model: 'claude-fable-5-1' });
  captureClaudeModel(state, { hook_event_name: 'SessionStart', session_id: 'session-b', source: 'x'.repeat(500), model: 'invalid model' });
  assert.equal(state.sessionStartDiagnostic.source, 'unknown'); assert.equal(state.sessionStartDiagnostic.modelStatus, 'invalid');
  captureClaudeModel(state, { hook_event_name: 'PostModelSwitch', session_id: 'session-b', to_model: 'invalid model' });
  assert.equal(state.claudeModel, null); validateState(state, f.paths);
  captureClaudeModel(state, { hook_event_name: 'SessionStart', model: 'claude-fable-5-1' }); assert.equal(state.claudeModel, null);
});

test('1.8.1 PostModelSwitch captures the documented target without changing route or grant', async (t) => {
  const f = await fixture(t);
  await issueModeGrant(f.project, { sessionId: 'session-a', route: 'discussion', participants: 'both' }, f.env);
  const before = (await readState(f.project, f.env)).state;
  const output = run(f, 'hook-session.mjs', [], { hook_event_name: 'PostModelSwitch', session_id: 'session-a', from_model: 'claude-sonnet-5', to_model: 'claude-fable-5-1', source: 'resume' });
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostModelSwitch');
  const state = (await readState(f.project, f.env)).state;
  assert.equal(state.claudeModel.id, 'claude-fable-5-1'); assert.equal(state.route, before.route); assert.deepEqual(state.modeGrant, before.modeGrant); assert.equal(state.sessionStartDiagnostic, null);
  const hooks = JSON.parse(await readFile(join(plugin, 'hooks/hooks.json'), 'utf8'));
  assert.ok(hooks.hooks.PostModelSwitch);
});

test('1.8.1 schema 13 migrates losslessly and defers while a runner is active', async (t) => {
  const f = await fixture(t);
  await submitOperation(f.project, submissionEnvelope('preserve owner'), f.env, { spawnRunner: false });
  await claimNextOperation(f.project, f.env);
  const legacy = structuredClone((await readState(f.project, f.env)).state);
  legacy.schemaVersion = 13; delete legacy.sessionStartDiagnostic;
  legacy.claudeModel = { id: 'claude-fable-5-1', sessionId: 'session-a', at: new Date().toISOString() };
  legacy.controller.runnerPid = process.pid;
  await writeFile(f.paths.stateFile, JSON.stringify(legacy));
  const deferred = await readState(f.project, f.env); assert.equal(deferred.health, 'migration-deferred');
  assert.deepEqual(JSON.parse(await readFile(f.paths.stateFile, 'utf8')), legacy);
  legacy.controller.runnerPid = null;
  await writeFile(f.paths.stateFile, JSON.stringify(legacy));
  const migrated = await readState(f.project, f.env); assert.equal(migrated.ok, true, migrated.error?.message);
  const expected = { ...legacy, schemaVersion: 14, generation: migrated.state.generation, sessionStartDiagnostic: null };
  assert.deepEqual(migrated.state, expected);
  const recovery = structuredClone(legacy); recovery.controller.activeOperationId = null; recovery.operations = []; recovery.ownerSelectedMode = null; recovery.route = 'recovery-read-only'; recovery.task.status = 'recovery-required';
  await writeFile(f.paths.stateFile, JSON.stringify(recovery));
  assert.equal((await readState(f.project, f.env)).state.route, 'recovery-read-only');
});
