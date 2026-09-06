import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkpointWarnings } from '../../scripts/lib/checkpoint.mjs';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { classifyToolUse, parseControllerCommand, parseControlCommand, protectedGithubOperation } from '../../scripts/hook-route-guard.mjs';
import { developerInstructions, reconciliationEnvelope, resolveRepositoryDirectory, runOperation, submissionEnvelope, submitOperation, claimNextOperation, turnPrompt } from '../../scripts/lib/sdk-controller.mjs';
import { initialState, initializeState, readState, updateState } from '../../scripts/lib/state.mjs';

const pluginRoot = resolve(import.meta.dirname, '..', '..');
const control = join(pluginRoot, 'scripts', 'control.mjs');
const controller = join(pluginRoot, 'scripts', 'controller.mjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-15-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'data') };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env };
}

async function run(script, args, { cwd, env, input = '' }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function sdkFactory(capture, id = 'thread-15') {
  return async (codexOptions) => ({
    startThread: (threadOptions) => ({ runStreamed: stream(capture, codexOptions, threadOptions, id) }),
    resumeThread: (_id, threadOptions) => ({ runStreamed: stream(capture, codexOptions, threadOptions, id) })
  });
}

function stream(capture, codexOptions, threadOptions, id) {
  return async (prompt) => {
    capture.push({ codexOptions, threadOptions, prompt });
    return { events: (async function* () {
      yield { type: 'thread.started', thread_id: id };
      yield { type: 'turn.started' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'done' } };
      yield { type: 'turn.completed' };
    })() };
  };
}

test('item 1: owner-visible context sharing is bidirectional', async () => {
  const skill = await readFile(join(pluginRoot, 'skills', 'jointly', 'SKILL.md'), 'utf8');
  assert.match(skill, /Never relay private reasoning or tool logs; always relay owner-visible replies verbatim/);
  assert.doesNotMatch(skill, /Never relay full transcripts/);
  assert.match(developerInstructions(), /CLAUDE REPLY/);
  const message = 'OWNER MESSAGE (verbatim):\nquestion\n\nCLAUDE REPLY (owner-visible, verbatim):\nanswer';
  assert.match(turnPrompt({ request: { phase: 'single', route: 'normal', sandbox: 'workspace-write', participants: 'both', message } }), /CLAUDE REPLY \(owner-visible, verbatim\):\nanswer/);
});

test('item 2: checkpoint capacity, atomic replace, compact, and full-cap errors are sanctioned', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  const values = Array.from({ length: 24 }, (_, index) => `decision ${index}`);
  assert.equal((await run(control, ['checkpoint', 'replace', 'decision'], { cwd: project, env, input: JSON.stringify(values) })).code, 0);
  const full = await run(control, ['checkpoint', 'decision', 'overflow'], { cwd: project, env });
  assert.equal(full.code, 1);
  assert.match(full.stderr, /acceptedDecisions is full: 24\/24/);
  const capacity = JSON.parse((await run(control, ['checkpoint', 'capacity'], { cwd: project, env })).stdout);
  assert.deepEqual(capacity.fields.acceptedDecisions.count, 24);
  const exported = JSON.parse((await run(control, ['checkpoint', 'export'], { cwd: project, env })).stdout);
  assert.deepEqual(exported.acceptedDecisions, values);
  assert.equal((await run(control, ['checkpoint', 'compact', 'decision', '--keep-last', '2'], { cwd: project, env })).code, 0);
  assert.equal((await readState(project, env)).state.partner.thread.checkpoint.acceptedDecisions.length, 2);
});

test('item 3: structured executor exceptions survive decision compaction and prose grants nothing', async (t) => {
  const { project, env } = await fixture(t);
  const state = initialState({ projectId: 'id', canonicalRoot: project });
  const paths = { canonicalRoot: project };
  state.partner.thread.checkpoint.acceptedDecisions.push('Executor exception authorized: executor=claude-main; scope=project file edits; reason=prose only');
  assert.equal((await classifyToolUse({ toolName: 'Edit', toolInput: { file_path: join(project, 'x') }, state, paths })).decision, 'deny');
  state.executorException = { executor: 'claude-main', scope: 'project file edits', reason: 'structured', authorizedAt: new Date().toISOString() };
  state.partner.thread.checkpoint.acceptedDecisions = [];
  assert.equal((await classifyToolUse({ toolName: 'Edit', toolInput: { file_path: join(project, 'x') }, state, paths })).decision, 'defer');
  const initialized = await initializeState(project, env); const legacy = structuredClone(initialized.state);
  legacy.schemaVersion = 5; delete legacy.executorException; delete legacy.partner.thread.checkpoint.updatedAt; delete legacy.partner.thread.checkpoint.fieldUpdatedAt;
  legacy.partner.thread.checkpoint.acceptedDecisions = ['Executor exception authorized: executor=claude-main; scope=project file edits; reason=migrated'];
  await writeFile(initialized.paths.stateFile, JSON.stringify(legacy));
  assert.equal((await readState(project, env)).state.executorException.executor, 'claude-main');
  assert.equal((await run(control, ['executor-exception', 'reconcile', '--outcome', 'migration checked'], { cwd: project, env })).code, 0);
  assert.equal((await run(control, ['executor-exception', 'authorize', '--executor', 'claude-main', '--scope', 'project file edits', '--reason', 'owner named'], { cwd: project, env })).code, 0);
  assert.equal((await run(control, ['checkpoint', 'replace', 'decision'], { cwd: project, env, input: '[]' })).code, 0);
  const persisted = (await readState(project, env)).state;
  assert.equal(persisted.executorException.reason, 'owner named');
  assert.equal((await classifyToolUse({ toolName: 'Edit', toolInput: { file_path: join(project, 'y') }, state: persisted, paths })).decision, 'defer');
});

test('item 4: abandon then submit then complete clears sticky partner-unavailable state', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  const failed = await submitOperation(project, submissionEnvelope('old'), env, { spawnRunner: false });
  await claimNextOperation(project, env);
  let current = await readState(project, env);
  await updateState(project, (state) => {
    state.operations[0].status = 'failed'; state.operations[0].request.message = null; state.operations[0].lifecycle.phase = 'failed'; state.operations[0].lifecycle.finishedAt = new Date().toISOString();
    state.controller.activeOperationId = null; state.route = 'recovery-read-only'; state.task.status = 'recovery-required'; state.generation += 1; return state;
  }, { expectedGeneration: current.state.generation }, env);
  assert.equal((await run(control, ['recover', 'abandon', '--operation-id', failed.operationId], { cwd: project, env })).code, 0);
  assert.equal((await readState(project, env)).state.task.status, null);
  await submitOperation(project, submissionEnvelope('new'), env, { spawnRunner: false });
  const operation = await claimNextOperation(project, env);
  await runOperation(project, operation, { createCodex: sdkFactory([]), signal: new AbortController().signal }, env);
  assert.equal((await readState(project, env)).state.task.status, 'active');
});

test('item 5: checkpoint freshness exposes bounded contradiction and staleness warnings', () => {
  const state = initialState({ projectId: 'id', canonicalRoot: '/synthetic' });
  const checkpoint = state.partner.thread.checkpoint;
  checkpoint.currentTask = 'work'; checkpoint.updatedAt = '2026-01-01T00:00:00.000Z';
  checkpoint.fieldUpdatedAt.testStatus = '2026-01-01T00:00:00.000Z'; checkpoint.fieldUpdatedAt.implementationStatus = '2026-01-02T00:00:00.000Z';
  const warnings = checkpointWarnings(checkpoint, { lastUsedAt: '2026-01-03T00:00:00.000Z' }, { repositoryRootConfigured: false });
  for (const expected of ['objective is empty', 'nextAction is empty while currentTask is set', 'testStatus predates implementationStatus', 'checkpoint older than the last thread turn', 'repositoryRoot is not configured; fingerprint unavailable']) assert.ok(warnings.includes(expected));
});

test('item 6: atomic snapshot rejects task-notification payloads without changing objective', async (t) => {
  const { project, env } = await fixture(t);
  await run(control, ['checkpoint', 'objective', 'keep me'], { cwd: project, env });
  const payload = { objective: '<task-notification>{"tool_use_id":"x"}</task-notification>', nextAction: 'bad' };
  const result = await run(control, ['checkpoint', 'snapshot'], { cwd: project, env, input: JSON.stringify(payload) });
  assert.equal(result.code, 1); assert.match(result.stderr, /owner-visible prose/);
  assert.equal((await readState(project, env)).state.partner.thread.checkpoint.objective, 'keep me');
  assert.equal((await run(control, ['checkpoint', 'objective', '<system-reminder>bad</system-reminder>'], { cwd: project, env })).code, 1);
  assert.equal((await run(control, ['checkpoint', 'replace', 'decision'], { cwd: project, env, input: JSON.stringify(['{"hookSpecificOutput":true}']) })).code, 1);
});

test('item 7: repositoryRoot is project-only, explicit, and escape-safe', async (t) => {
  const { directory, project, env } = await fixture(t);
  const repo = join(project, 'app'); await mkdir(repo); await mkdir(join(project, '.fabex'));
  await mkdir(join(directory, 'data')); await writeFile(join(directory, 'data', 'config.json'), JSON.stringify({ project: { repositoryRoot: 'ignored' } }));
  await writeFile(join(project, '.fabex', 'config.json'), JSON.stringify({ project: { repositoryRoot: 'app' } }));
  const effective = await loadEffectiveConfig(project, env);
  assert.equal(effective.config.project.repositoryRoot, 'app');
  assert.match(effective.warnings.join('\n'), /project-layer only/);
  assert.equal(await resolveRepositoryDirectory(project, effective.config), await realpath(repo));
  await assert.rejects(resolveRepositoryDirectory(project, { project: { repositoryRoot: '../escape' } }), /escapes/);
});

test('item 8: normal route enforces Bash, subagent edit, and MCP allowlists', async (t) => {
  const { project } = await fixture(t); const state = initialState({ projectId: 'id', canonicalRoot: project }); const paths = { canonicalRoot: project };
  const classify = (toolName, toolInput, executor = {}) => classifyToolUse({ toolName, toolInput, state, paths, executor });
  assert.equal((await classify('Edit', { file_path: join(project, 'x') }, { agentId: 'sub', agentType: 'worker' })).decision, 'deny');
  for (const command of ['grep x file', "sed -n '1,2p' file", 'git status', 'pnpm test']) assert.equal((await classify('Bash', { command })).decision, 'defer', command);
  for (const command of ["sed -i 's/x/y/' file", 'echo x > file', 'env touch file', 'find . -delete', 'git branch -D old', 'git branch new', 'git diff --output=patch.txt', 'pnpm test -- --update']) assert.equal((await classify('Bash', { command })).decision, 'deny', command);
  const config = { guard: { externalWriteRoots: [join(project, '..')] } };
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command: `echo x > ${join(project, '..', 'outside.txt')}` }, state, paths, config })).decision, 'defer');
  const outside = join(project, '..', 'outside-note');
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command: `cat <<'FABEX_OUT_12345678' > ${outside}\n$ literal owner text\nFABEX_OUT_12345678` }, state, paths, config })).decision, 'defer');
  assert.equal((await classify('mcp__context7__query-docs', {})).decision, 'defer');
  assert.equal((await classify('mcp__service__create_item', {})).decision, 'deny');
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command: 'custom-verify --check' }, state, paths, config: { guard: { allowedCommands: ['custom-verify'], readOnlyMcpTools: [] } } })).decision, 'defer');
});

test('item 8 correction: normal route defers host orchestration without weakening mutation guards', async (t) => {
  const { project } = await fixture(t); const state = initialState({ projectId: 'id', canonicalRoot: project }); const paths = { canonicalRoot: project };
  for (const [toolName, toolInput] of [
    ['Agent', { prompt: 'deliver' }], ['ToolSearch', { query: 'select:Agent' }], ['Monitor', {}], ['TaskStop', {}],
    ['WebFetch', { url: 'https://example.invalid' }], ['AskUserQuestion', { questions: [] }], ['Skill', { skill: 'unrelated' }]
  ]) assert.equal((await classifyToolUse({ toolName, toolInput, state, paths })).decision, 'defer', toolName);
  assert.equal((await classifyToolUse({ toolName: 'mcp__service__create_item', toolInput: {}, state, paths })).decision, 'deny');
  assert.equal((await classifyToolUse({ toolName: 'Edit', toolInput: { file_path: join(project, 'x') }, state, paths, executor: { agentId: 'sub', agentType: 'worker' } })).decision, 'deny');
});

test('item 8 correction: verification pipelines allow only safe composed segments', async (t) => {
  const { project } = await fixture(t); const state = initialState({ projectId: 'id', canonicalRoot: project }); const paths = { canonicalRoot: project };
  const classify = (command) => classifyToolUse({ toolName: 'Bash', toolInput: { command }, state, paths });
  for (const command of ['pnpm test 2>&1 | tail -20', 'grep -rn x . | head -5', 'git diff --stat | tail -5', 'cd fabex && pnpm test', 'ls -la | wc -l']) {
    assert.equal((await classify(command)).decision, 'defer', command);
  }
  for (const command of ['pnpm test > out.txt', 'cat x | tee y', 'grep x . | xargs rm', 'ls; rm -rf dir']) {
    assert.equal((await classify(command)).decision, 'deny', command);
  }
});

test('item 9: the entire Git delivery lane is operational-agent-only', () => {
  for (const command of ['git add .', 'git commit -m x', 'git tag v1', 'git merge branch', 'git rebase main', 'git cherry-pick abc', 'git push', 'git send-pack origin', 'git lfs push origin', 'git -C app commit -m x', 'env git commit -m x']) assert.ok(protectedGithubOperation(command), command);
});

test('item 10: network is opt-in only for workspace-write and sandbox never becomes danger-full-access', async (t) => {
  const { project, env } = await fixture(t); await mkdir(join(project, '.fabex'));
  await writeFile(join(project, '.fabex', 'config.json'), JSON.stringify({ models: { codex: { networkAccessEnabled: true } } }));
  await initializeState(project, env); const capture = []; const operation = await (async () => { await submitOperation(project, submissionEnvelope('work'), env, { spawnRunner: false }); return claimNextOperation(project, env); })();
  await runOperation(project, operation, { createCodex: sdkFactory(capture), signal: new AbortController().signal }, env);
  assert.equal(capture[0].threadOptions.networkAccessEnabled, true); assert.ok(['read-only', 'workspace-write'].includes(capture[0].threadOptions.sandboxMode)); assert.notEqual(capture[0].threadOptions.sandboxMode, 'danger-full-access');
  await submitOperation(project, reconciliationEnvelope(operation.id, 'work', 'Fable review'), env, { spawnRunner: false });
  const reconciliation = await claimNextOperation(project, env); await runOperation(project, reconciliation, { createCodex: sdkFactory(capture), signal: new AbortController().signal }, env);
  let current = await readState(project, env); await updateState(project, (state) => { state.route = 'discussion'; state.generation += 1; return state; }, { expectedGeneration: current.state.generation }, env);
  await submitOperation(project, submissionEnvelope('discuss'), env, { spawnRunner: false }); const discussion = await claimNextOperation(project, env); await runOperation(project, discussion, { createCodex: sdkFactory(capture), signal: new AbortController().signal }, env);
  assert.equal(capture[2].threadOptions.networkAccessEnabled, false); assert.equal(capture[2].threadOptions.sandboxMode, 'read-only');
});

test('item 11: diagnose reports installed registry mismatch and remedy', async (t) => {
  const { directory, project, env } = await fixture(t); const claude = join(directory, 'claude'); await mkdir(join(claude, 'plugins'), { recursive: true });
  await writeFile(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fabex@fabex': [{ version: '1.0.0', installPath: join(directory, 'old') }] } }));
  const diagnosed = JSON.parse((await run(control, ['diagnose'], { cwd: project, env: { ...env, CLAUDE_CONFIG_DIR: claude } })).stdout);
  assert.equal(diagnosed.plugin.installed.registryVersion, '1.0.0'); assert.equal(diagnosed.plugin.installed.matchesSource, false); assert.match(diagnosed.plugin.warnings[0], /update or reinstall/);
});

test('item 12: regression suite names every reported failure item', async () => {
  const source = await readFile(new URL(import.meta.url), 'utf8');
  for (let item = 1; item <= 14; item += 1) assert.match(source, new RegExp(`test\\('item ${item}:`));
});

test('item 13: blocking wait returns terminal state and reports timeout', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  const pending = await submitOperation(project, submissionEnvelope('queued'), env, { spawnRunner: false });
  const timed = await run(controller, ['wait', '--operation-id', pending.operationId, '--timeout', '1'], { cwd: project, env });
  assert.equal(timed.code, 3); assert.equal(JSON.parse(timed.stdout).status, 'queued');
  await import('../../scripts/lib/sdk-controller.mjs').then(({ cancelOperation }) => cancelOperation(project, pending.operationId, env));
  const done = await run(controller, ['wait', '--operation-id', pending.operationId, '--timeout', '1'], { cwd: project, env }); assert.equal(done.code, 0); assert.equal(JSON.parse(done.stdout).status, 'cancelled');
  assert.equal(parseControllerCommand(`node ${controller} wait --operation-id ${pending.operationId} --timeout 590`).kind, 'controller-wait');
});

test('item 14: guard script recognition is path-based rather than substring-based', async (t) => {
  const { project } = await fixture(t); const state = initialState({ projectId: 'id', canonicalRoot: project }); const paths = { canonicalRoot: project };
  for (const command of ["grep controller scripts/lib/sdk-controller.mjs", "sed -n '1,20p' scripts/lib/sdk-controller.mjs", "printf 'controller.mjs' > /tmp/fabex-note"]) {
    const decision = await classifyToolUse({ toolName: 'Bash', toolInput: { command }, state, paths });
    assert.doesNotMatch(decision.reason ?? '', /only exact Fabex controller/);
  }
});

test('item 15: developer instructions are route-neutral and every resumed prompt starts with current authority', () => {
  const instructions = developerInstructions(); assert.doesNotMatch(instructions, /read-only|route=/);
  const operation = { request: { route: 'normal', sandbox: 'workspace-write', participants: 'both', message: 'continue' } };
  assert.match(turnPrompt(operation), /^FABEX TURN: phase=single; route=normal; sandbox=workspace-write; participants=both/);
});

test('item 16: intermediate schema 6 state loads without losing thread or decisions', async (t) => {
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env);
  const intermediate = structuredClone(initialized.state); intermediate.schemaVersion = 6; intermediate.partner.thread.threadId = 'preserved-v6'; intermediate.partner.thread.checkpoint.acceptedDecisions = ['keep'];
  intermediate.executorException = { executor: 'claude-main', scope: 'project file edits', reason: 'preserve', authorizedAt: '2026-09-04T00:00:00.000Z' };
  intermediate.partner.thread.checkpoint.updatedAt = '2026-09-04T00:00:00.000Z'; intermediate.partner.thread.checkpoint.fieldUpdatedAt.acceptedDecisions = '2026-09-04T00:00:00.000Z';
  delete intermediate.partner.thread.checkpoint.repoFingerprintCapturedAt; delete intermediate.partner.thread.metadata.repoFingerprintCapturedAt; delete intermediate.partner.thread.metadata.lastRecordedTurn;
  await writeFile(initialized.paths.stateFile, JSON.stringify(intermediate));
  const loaded = await readState(project, env); assert.equal(loaded.ok, true); assert.equal(loaded.state.schemaVersion, 13); assert.equal(loaded.state.partner.thread.threadId, 'preserved-v6'); assert.deepEqual(loaded.state.partner.thread.checkpoint.acceptedDecisions, ['keep']);
  assert.equal(loaded.state.executorException.reason, 'preserve'); assert.equal(loaded.state.partner.thread.checkpoint.updatedAt, '2026-09-04T00:00:00.000Z'); assert.equal(loaded.state.partner.thread.checkpoint.fieldUpdatedAt.acceptedDecisions, '2026-09-04T00:00:00.000Z');
});

test('guard accepts sanctioned checkpoint heredocs only in exact shapes', () => {
  const replace = `node "${control}" checkpoint replace decision <<'FABEX_CP_12345678'\n["one"]\nFABEX_CP_12345678`;
  const snapshot = `node "${control}" checkpoint snapshot <<'FABEX_CP_87654321'\n{"objective":"one"}\nFABEX_CP_87654321`;
  assert.equal(parseControlCommand(replace).kind, 'checkpoint-replace'); assert.equal(parseControlCommand(snapshot).kind, 'checkpoint-snapshot');
});
