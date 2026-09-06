import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { classifyToolUse, parseControllerCommand, parseControlCommand } from '../../scripts/hook-route-guard.mjs';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { claimNextOperation, reconciliationEnvelope, runOperation, submissionEnvelope, submitOperation, cancelOperation, turnPrompt } from '../../scripts/lib/sdk-controller.mjs';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';

const execFile = promisify(execFileCallback);
const pluginRoot = resolve(import.meta.dirname, '..', '..');
const control = join(pluginRoot, 'scripts', 'control.mjs');
const controller = join(pluginRoot, 'scripts', 'controller.mjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-151-'));
  const project = join(directory, 'workstream');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'data'), CLAUDE_CONFIG_DIR: join(directory, 'claude') };
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

async function context(project) {
  const initialized = await initializeState(project, { ...process.env, FABEX_HOME: join(project, '.test-state') });
  return { state: initialized.state, paths: { canonicalRoot: project } };
}

function sdkFactory(id = 'thread-151') {
  return async () => ({
    startThread: () => thread(id),
    resumeThread: () => thread(id)
  });
}

function thread(id) {
  return { runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: id };
    yield { type: 'turn.started' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: 'done' } };
    yield { type: 'turn.completed' };
  })() }) };
}

async function completeTurn(project, env, owner, id = 'thread-151') {
  const submitted = await submitOperation(project, submissionEnvelope(owner), env, { spawnRunner: false });
  let operation = await claimNextOperation(project, env);
  await runOperation(project, operation, { createCodex: sdkFactory(id), signal: new AbortController().signal }, env);
  await submitOperation(project, reconciliationEnvelope(submitted.operationId, owner, 'Fable verified the independent reading.'), env, { spawnRunner: false });
  operation = await claimNextOperation(project, env);
  await runOperation(project, operation, { createCodex: sdkFactory(id), signal: new AbortController().signal }, env);
}

test('item 1: exact command patterns match argv and repository-relative scripts only', async (t) => {
  const { project, env } = await fixture(t); const repository = join(project, 'app'); await mkdir(join(repository, 'scripts'), { recursive: true }); await mkdir(join(project, '.fabex'));
  await writeFile(join(project, '.fabex', 'config.json'), JSON.stringify({ project: { repositoryRoot: 'app' }, guard: { allowedCommandPatterns: [{ executable: 'node', args: ['scripts/review-screenshots.mjs'] }] } }));
  const config = (await loadEffectiveConfig(project, env)).config; const ctx = await context(project);
  const classify = (command) => classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...ctx, config });
  assert.equal((await classify('node scripts/review-screenshots.mjs')).decision, 'defer');
  assert.equal((await classify('MODE=review node scripts/review-screenshots.mjs')).decision, 'defer');
  assert.equal((await classify('node other-script.mjs')).decision, 'deny');
  await writeFile(join(project, '.fabex', 'config.json'), JSON.stringify({ guard: { allowedCommands: ['node'] } }));
  assert.match((await loadEffectiveConfig(project, env)).warnings.join('\n'), /grants every invocation of node/);
  const diagnosed = JSON.parse((await run(control, ['diagnose'], { cwd: project, env })).stdout); assert.match(diagnosed.effective.warnings.join('\n'), /grants every invocation of node/);
});

test('item 2: named package-manager verification scripts remain non-writing', async (t) => {
  const { project } = await fixture(t); const ctx = await context(project);
  for (const command of ['pnpm test', 'pnpm test:int', 'pnpm test:e2e', 'pnpm typecheck', 'pnpm lint', 'pnpm build', 'pnpm run test:e2e', 'npm run test:int', 'yarn check']) {
    assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...ctx })).decision, 'defer', command);
  }
  for (const command of ['pnpm test:e2e --update-snapshot', 'npm run lint -- --fix', 'yarn test --force']) assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...ctx })).decision, 'deny', command);
  assert.equal((await classifyToolUse({ toolName: 'Edit', toolInput: { file_path: join(project, 'source.js') }, ...ctx, executor: { agentId: 'fable', agentType: 'assistant' } })).decision, 'deny');
});

test('item 3: quote-aware safe composition validates every segment', async (t) => {
  const { project } = await fixture(t); const ctx = await context(project);
  const safe = [`node ${control} status | head -20`, 'pnpm test 2>&1 | tail -12', 'grep -rn -E "alpha|beta" dir | head -5', 'git status && git log -1'];
  const denied = ['ls | xargs rm', 'pnpm test | tee out.txt', 'echo changed > project.txt', 'git status; git commit -m hidden', "sh -c 'git commit -m hidden'"];
  for (const command of safe) assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...ctx })).decision, 'defer', command);
  for (const command of denied) assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...ctx })).decision, 'deny', command);
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command: 'git commit -m release | tee out.txt' }, ...ctx, executor: { agentId: 'delivery', agentType: 'fabex:fabex-operational' } })).decision, 'deny');
});

test('item 4: external scratch writes require one target inside an explicit root', async (t) => {
  const { directory, project } = await fixture(t); const ctx = await context(project); const scratch = join(directory, 'scratch'); await mkdir(scratch);
  const config = { guard: { externalWriteRoots: [scratch] } }; const note = join(scratch, 'note.txt');
  const heredoc = `cat <<'FABEX_NOTE_12345678' > ${note}\nowner-visible note\nFABEX_NOTE_12345678`;
  for (const command of [heredoc, `printf line >> ${note}`]) assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...ctx, config })).decision, 'defer', command);
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command: `echo x > ${join(directory, 'unlisted.txt')}` }, ...ctx, config })).decision, 'deny');
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command: `echo x > ${join(project, 'inside.txt')}` }, ...ctx, config })).decision, 'deny');
});

test('item 5: exact control and controller help probes are useful and guard-allowed', async (t) => {
  const { project, env } = await fixture(t); const ctx = await context(project);
  for (const [script, args] of [[control, []], [control, ['--help']], [control, ['checkpoint']], [control, ['checkpoint', '--help']], [controller, ['--help']]]) {
    const result = await run(script, args, { cwd: project, env }); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Usage:/);
    const command = `node ${script}${args.length ? ` ${args.join(' ')}` : ''}`;
    assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...ctx })).decision, 'defer', command);
  }
  assert.equal(parseControlCommand(`node ${control} checkpoint replace`), null);
});

test('item 6: read-only state access waits briefly and reports bounded lock metadata', async (t) => {
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env);
  await mkdir(initialized.paths.lockDir); await writeFile(initialized.paths.lockOwnerFile, JSON.stringify({ pid: process.pid, purpose: 'sdk-lifecycle', operationId: 'secret' }));
  const release = new Promise((resolveRelease) => setTimeout(() => rm(initialized.paths.lockDir, { recursive: true }).then(resolveRelease), 250));
  const started = Date.now(); const result = await readState(project, env); await release;
  assert.equal(result.ok, true); assert.ok(Date.now() - started >= 200);
  await mkdir(initialized.paths.lockDir); await writeFile(initialized.paths.lockOwnerFile, JSON.stringify({ pid: process.pid, purpose: 'checkpoint-read' }));
  const capacity = run(control, ['checkpoint', 'capacity'], { cwd: project, env });
  const releaseCapacity = new Promise((resolveRelease) => setTimeout(() => rm(initialized.paths.lockDir, { recursive: true }).then(resolveRelease), 250));
  const [capacityResult] = await Promise.all([capacity, releaseCapacity]); assert.equal(capacityResult.code, 0, capacityResult.stderr); assert.match(capacityResult.stdout, /"seed"/);
  await mkdir(initialized.paths.lockDir); await writeFile(initialized.paths.lockOwnerFile, JSON.stringify({ pid: process.pid, purpose: 'sdk-lifecycle', operationId: 'secret' }));
  const timeout = await readState(project, env, { lockWaitMs: 10 });
  assert.equal(timeout.health, 'lock-contention'); assert.deepEqual(Object.keys(timeout.lock).sort(), ['ageMs', 'pid', 'purpose']); assert.doesNotMatch(JSON.stringify(timeout.lock), /secret/);
  await rm(initialized.paths.lockDir, { recursive: true });
});

test('item 7: diagnose reports dynamic activation facts without stale pending text', async (t) => {
  const { project, env } = await fixture(t); await mkdir(join(env.CLAUDE_CONFIG_DIR, 'plugins'), { recursive: true });
  await writeFile(join(env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fabex@fabex': [{ version: '1.8.0', installPath: pluginRoot }] } }));
  await initializeState(project, env);
  let result = await run(control, ['diagnose'], { cwd: project, env }); let diagnosed = JSON.parse(result.stdout);
  assert.equal(diagnosed.activation.sourceVersion, '1.8.0'); assert.equal(diagnosed.activation.hooksValid, true); assert.match(diagnosed.activation.verdict, /not verified/); assert.doesNotMatch(result.stdout, /pending plugin install\/reload and live dogfood/);
  const current = await readState(project, env); await updateState(project, (state) => { state.partner.thread.metadata.lastRecordedTurn = { at: new Date().toISOString(), version: '1.8.0' }; state.generation += 1; return state; }, { expectedGeneration: current.state.generation }, env);
  result = await run(control, ['diagnose'], { cwd: project, env }); diagnosed = JSON.parse(result.stdout); assert.match(diagnosed.activation.verdict, /^verified by/);
});

test('item 8: both-participant envelopes reject ambiguity and preserve verbatim shared replies', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env);
  await assert.rejects(submitOperation(project, 'owner only', env, { spawnRunner: false }), /strict JSON phase envelope/i);
  const submitted = await submitOperation(project, submissionEnvelope('exact owner', 'provided', 'exact visible reply'), env, { spawnRunner: false });
  assert.equal(submitted.claudeReplyVerified, 'unavailable');
  const state = (await readState(project, env)).state; const prompt = turnPrompt(state.operations[0]); assert.match(prompt, /PREVIOUS CLAUDE REPLY STATUS: provided/); assert.match(prompt, /exact visible reply/);
  assert.equal(parseControllerCommand(`node ${controller} submit --message owner`, { participants: 'both' }), null);
  assert.doesNotMatch(await readFile(join(pluginRoot, 'scripts', 'hook-stop.mjs'), 'utf8'), /transcript_path/);
});

test('item 9: nested repository status separates live and captured fingerprints and refreshes on success', async (t) => {
  const { project, env } = await fixture(t); const one = join(project, 'one'); const two = join(project, 'two'); await mkdir(one); await mkdir(two); await execFile('git', ['init', one]); await execFile('git', ['init', two]);
  await rm(join(one, '.git'), { recursive: true }); await rm(join(two, '.git'), { recursive: true }); await cp(join(pluginRoot, '.git'), join(one, '.git'), { recursive: true }); await cp(join(pluginRoot, '.git'), join(two, '.git'), { recursive: true });
  const head = (await execFile('git', ['-C', pluginRoot, 'rev-parse', 'HEAD'])).stdout.trim(); await writeFile(join(two, '.git', 'HEAD'), `${head}\n`);
  await mkdir(join(project, '.fabex')); await writeFile(join(project, '.fabex', 'config.json'), JSON.stringify({ project: { repositoryRoot: 'one' } })); await initializeState(project, env);
  await completeTurn(project, env, 'capture one'); let state = (await readState(project, env)).state;
  assert.match(state.partner.thread.checkpoint.updatedAt, /^\d{4}-/); assert.equal(state.partner.thread.metadata.lastRecordedTurn.version, '1.8.0'); assert.deepEqual(state.partner.thread.checkpoint.repoFingerprint, state.partner.thread.metadata.repoFingerprint); assert.ok(state.partner.thread.metadata.repoFingerprintCapturedAt);
  await writeFile(join(project, '.fabex', 'config.json'), JSON.stringify({ project: { repositoryRoot: 'two' } }));
  const generationBeforeStatus = state.generation; let status = JSON.parse((await run(control, ['status'], { cwd: project, env })).stdout); assert.notEqual(status.capturedRepoFingerprint.branch, status.liveRepoFingerprint.branch); assert.ok(status.partner.checkpoint.warnings.includes('captured fingerprint differs from live')); assert.equal((await readState(project, env)).state.generation, generationBeforeStatus);
  await completeTurn(project, env, 'capture two'); status = JSON.parse((await run(control, ['status'], { cwd: project, env })).stdout); assert.equal(status.capturedRepoFingerprint.branch, status.liveRepoFingerprint.branch);
});

test('item 10: current metadata and 1.5.1 migration documentation stay consistent', async () => {
  assert.equal(JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')).version, '1.8.0');
  assert.equal(JSON.parse(await readFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version, '1.8.0');
  const readme = await readFile(join(pluginRoot, 'README.md'), 'utf8'); assert.match(readme, /allowedCommandPatterns/); assert.match(readme, /migrate broad entries/); assert.match(readme, /externalWriteRoots/);
});

test('item 11: controller wait survives an in-flight operation lock', async (t) => {
  const { project, env } = await fixture(t); const initialized = await initializeState(project, env); const submitted = await submitOperation(project, submissionEnvelope('queued'), env, { spawnRunner: false });
  await mkdir(initialized.paths.lockDir); await writeFile(initialized.paths.lockOwnerFile, JSON.stringify({ pid: process.pid, purpose: 'sdk-turn' }));
  const waiting = run(controller, ['wait', '--operation-id', submitted.operationId, '--timeout', '3'], { cwd: project, env });
  const release = new Promise((resolveRelease, rejectRelease) => setTimeout(async () => {
    try { await rm(initialized.paths.lockDir, { recursive: true }); await cancelOperation(project, submitted.operationId, env); resolveRelease(); } catch (error) { rejectRelease(error); }
  }, 300));
  const [result] = await Promise.all([waiting, release]); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'cancelled');
});

test('item 12: status defaults to relevant history with all and brief alternatives', async (t) => {
  const { project, env } = await fixture(t); await initializeState(project, env); const ctx = await context(project);
  for (let index = 0; index < 6; index += 1) { const item = await submitOperation(project, submissionEnvelope(`terminal ${index}`), env, { spawnRunner: false }); await cancelOperation(project, item.operationId, env); }
  await submitOperation(project, submissionEnvelope('queued'), env, { spawnRunner: false });
  const defaultStatus = JSON.parse((await run(control, ['status'], { cwd: project, env })).stdout); assert.equal(defaultStatus.operations.length, 4); assert.equal(defaultStatus.operations.filter((item) => item.status === 'cancelled').length, 3);
  const all = JSON.parse((await run(control, ['status', '--all'], { cwd: project, env })).stdout); assert.equal(all.operations.length, 7);
  const brief = JSON.parse((await run(control, ['status', '--brief'], { cwd: project, env })).stdout); assert.equal('operations' in brief, false); assert.equal('controller' in brief, false); assert.ok(brief.partner.thread); assert.ok(brief.liveRepoFingerprint.computedAt);
  for (const flag of ['--all', '--brief']) assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command: `node ${control} status ${flag}` }, ...ctx })).decision, 'defer');
});

test('item 13: default external roots cover Claude memory and session scratchpads', async (t) => {
  const { project, env } = await fixture(t); const config = (await loadEffectiveConfig(project, env)).config; const ctx = await context(project);
  const memory = join(env.CLAUDE_CONFIG_DIR, 'projects', 'project-id', 'memory', 'note.md');
  const scratch = '/private/tmp/claude-501/project-id/session-id/scratchpad/note.md';
  for (const target of [memory, scratch]) assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command: `printf note >> ${target}` }, ...ctx, config })).decision, 'defer', target);
  assert.ok(config.guard.externalWriteRoots.some((root) => root.includes('/projects/*/memory'))); assert.ok(config.guard.externalWriteRoots.includes(tmpdir()));
  assert.notEqual(homedir(), '');
});

test('item 14: exact submit heredoc bodies may mention protected Git text', async (t) => {
  const { project } = await fixture(t); const ctx = await context(project);
  const command = `node "${controller}" submit <<'FABEX_OWNER_151ABCDE'\n${submissionEnvelope('please explain git commit and gh pr create', 'provided', 'I will discuss git push without executing it.')}\nFABEX_OWNER_151ABCDE`;
  assert.equal(parseControllerCommand(command, { participants: 'both' }).kind, 'controller-submit');
  assert.equal((await classifyToolUse({ toolName: 'Bash', toolInput: { command }, ...ctx })).decision, 'defer');
});
