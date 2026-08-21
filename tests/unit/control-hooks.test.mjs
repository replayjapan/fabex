import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readState, updateState } from '../../scripts/lib/state.mjs';
import { renderSessionContext } from '../../scripts/hook-session.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const control = resolve(root, 'scripts', 'control.mjs');
const session = resolve(root, 'scripts', 'hook-session.mjs');
const guard = resolve(root, 'scripts', 'hook-route-guard.mjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-control-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const env = { ...process.env, FABEX_HOME: join(directory, 'data') };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env };
}

async function run(script, args, { cwd, env, input } = {}) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const code = await new Promise((done) => child.once('close', done));
  return { code, stdout, stderr };
}

test('mode controls reach all eight canonical modes and reject normal-codex', async (t) => {
  const { project, env } = await fixture(t);
  const modes = [
    [['mode', 'normal'], 'work'],
    [['mode', 'normal', '--participants', 'claude'], 'workClaude'],
    [['mode', 'discussion'], 'discussion'],
    [['mode', 'discussion', '--participants', 'claude'], 'discussionClaude'],
    [['mode', 'discussion', '--participants', 'codex'], 'discussionCodex'],
    [['mode', 'ask-once'], 'ask'],
    [['mode', 'ask-once', '--participants', 'claude'], 'askClaude'],
    [['mode', 'ask-once', '--participants', 'codex'], 'askCodex']
  ];
  for (const [args, label] of modes) {
    const result = await run(control, args, { cwd: project, env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`(?:-> |unchanged: )${label}\\.`), result.stdout);
  }
  const invalid = await run(control, ['mode', 'normal', '--participants', 'codex'], { cwd: project, env });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /unsupported mode combination/);
  const state = (await readState(project, env)).state;
  assert.equal(state.route, 'ask-once');
  assert.equal(state.participants, 'codex');
  assert.deepEqual(state.returnTo, { route: 'discussion', participants: 'codex' });
});

test('ask-once reverts on the next user prompt, not SessionStart', async (t) => {
  const { project, env } = await fixture(t);
  await run(control, ['mode', 'ask-once'], { cwd: project, env });
  const start = await run(session, [], { cwd: project, env, input: { cwd: project, hook_event_name: 'SessionStart' } });
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /Fabex mode: ask/);
  assert.equal((await readState(project, env)).state.route, 'ask-once');
  const prompt = await run(session, [], { cwd: project, env, input: { cwd: project, hook_event_name: 'UserPromptSubmit' } });
  assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /Fabex mode: work/);
  assert.equal((await readState(project, env)).state.route, 'normal');
});

test('ask-once restores route and participants from every persistent mode', async (t) => {
  const { directory, env } = await fixture(t);
  const persistent = [
    ['normal', 'both'], ['normal', 'claude'],
    ['discussion', 'both'], ['discussion', 'claude'], ['discussion', 'codex']
  ];
  for (const [route, participants] of persistent) {
    const project = join(directory, `${route}-${participants}`);
    await mkdir(project);
    await run(control, ['mode', route, '--participants', participants], { cwd: project, env });
    await run(control, ['mode', 'ask-once', '--participants', 'both'], { cwd: project, env });
    const armed = (await readState(project, env)).state;
    assert.deepEqual(armed.returnTo, { route, participants });
    const prompt = await run(session, [], { cwd: project, env, input: { cwd: project, hook_event_name: 'UserPromptSubmit' } });
    assert.equal(prompt.code, 0, prompt.stderr);
    const restored = (await readState(project, env)).state;
    assert.equal(restored.route, route);
    assert.equal(restored.participants, participants);
    assert.equal(restored.returnTo, null);
  }
});

test('discussionCodex preserves the continuous primary thread on entry and exit', async (t) => {
  const { project, env } = await fixture(t);
  await run(control, ['status'], { cwd: project, env });
  let current = await readState(project, env);
  await updateState(project, (state) => {
    state.partner.threads.primaryThreadId = 'continuous-thread';
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation }, env);
  await run(control, ['mode', 'discussion', '--participants', 'codex'], { cwd: project, env });
  assert.equal((await readState(project, env)).state.partner.threads.primaryThreadId, 'continuous-thread');
  await run(control, ['mode', 'normal'], { cwd: project, env });
  assert.equal((await readState(project, env)).state.partner.threads.primaryThreadId, 'continuous-thread');
});

test('config control prints effective config, all sources, and loaded flags', async (t) => {
  const { project, env } = await fixture(t);
  await mkdir(join(project, '.fabex'));
  await writeFile(join(project, '.fabex', 'config.json'), JSON.stringify({ models: { operational: 'haiku' } }));
  const result = await run(control, ['config'], { cwd: project, env });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.config.models.operational, 'haiku');
  assert.equal(payload.sources.shippedLoaded, true);
  assert.equal(payload.sources.machineLoaded, false);
  assert.equal(payload.sources.projectLoaded, true);
});

test('rendered normal-both session context stays within 800 UTF-8 bytes', () => {
  const config = { models: { operational: 'm'.repeat(128) }, collaboration: { jointByDefault: true }, display: { replyModeBadge: 'always' } };
  const context = renderSessionContext('normal', 'both', config);
  assert.ok(Buffer.byteLength(context, 'utf8') <= 800, Buffer.byteLength(context, 'utf8'));
  assert.match(context, /Questions authorize answers only; never infer implementation/);
  assert.match(context, /For ANY build, fix, change, or implement request you MUST invoke \/fabex:jointly first/);
  assert.match(context, /Codex alone edits files/);
  assert.match(context, /Current-turn opinion-blind/);
  assert.match(context, /including greetings and lookups/);
  assert.match(context, /Verify every resumed thread ID/);
  assert.match(context, /Delegate image\/screenshot, GitHub\/gh, and log chores to fabex-operational/);
  assert.match(context, /Prefix every reply with \[Fabex: work\]/);
});

test('every other mode has participant-specific bounded context and badge policy', () => {
  const caps = new Map([
    ['normal:claude', 650], ['discussion:both', 440], ['discussion:claude', 300],
    ['discussion:codex', 450], ['ask-once:both', 390], ['ask-once:claude', 300],
    ['ask-once:codex', 350], ['recovery-read-only:both', 180]
  ]);
  const config = { collaboration: { jointByDefault: true }, display: { replyModeBadge: 'changes' } };
  for (const [key, cap] of caps) {
    const [route, participants] = key.split(':');
    const context = renderSessionContext(route, participants, config);
    assert.ok(Buffer.byteLength(context, 'utf8') <= cap, `${key}: ${Buffer.byteLength(context, 'utf8')}`);
    assert.match(context, /Prefix a mode-transition reply/);
  }
  const workClaude = renderSessionContext('normal', 'claude', config);
  assert.match(workClaude, /Questions authorize answers only; never infer implementation/);
  assert.match(workClaude, /Codex alone edits files/);
  assert.match(workClaude, /Do not automatically consult Codex/);
  assert.match(workClaude, /switches to both participants/);
  assert.match(renderSessionContext('discussion', 'both', config), /message verbatim/);
  assert.match(renderSessionContext('discussion', 'codex', config), /--resume-last/);
  assert.match(renderSessionContext('discussion', 'codex', config), /Claude stays substantively silent/);
  assert.match(renderSessionContext('ask-once', 'both', config), /restores the prior persistent mode/);
  assert.match(renderSessionContext('normal', 'both', { ...config, display: { replyModeBadge: 'off' } }), /Do not add a Fabex reply badge/);
});

test('thread controls verify resumes and fail closed on a mismatched returned id', async (t) => {
  const { directory, project, env } = await fixture(t);
  const companionRoot = join(directory, 'companion');
  await mkdir(join(companionRoot, 'scripts'), { recursive: true });
  await writeFile(join(companionRoot, 'scripts', 'codex-companion.mjs'), `
if(process.argv[2]!=='task-resume-candidate')process.exit(8);
process.stdout.write(JSON.stringify({available:true,sessionId:null,candidate:{threadId:'thread-primary'}}));
`);
  env.FABEX_CODEX_PLUGIN_ROOT = companionRoot;
  const first = await run(control, ['thread', 'begin', 'primary'], { cwd: project, env });
  assert.equal(first.code, 0, first.stderr);
  const opening = JSON.parse(first.stdout);
  assert.equal(opening.plan.companionFlag, '--fresh');
  const completed = await run(control, ['thread', 'complete', opening.operationId, '--thread-id', 'thread-primary'], { cwd: project, env });
  assert.equal(completed.code, 0, completed.stderr);

  const resumed = JSON.parse((await run(control, ['thread', 'begin', 'primary'], { cwd: project, env })).stdout);
  assert.equal(resumed.plan.companionFlag, '--resume-last');
  assert.equal(resumed.plan.expectedThreadId, 'thread-primary');
  const mismatch = await run(control, ['thread', 'complete', resumed.operationId, '--thread-id', 'wrong-thread'], { cwd: project, env });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /thread mismatch.*pause and ask the owner/i);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.threads.primaryThreadId, 'thread-primary');
  assert.equal(state.operations.at(-1).status, 'running');
});

test('thread controls visibly complete a pre-launch candidate replacement', async (t) => {
  const { directory, project, env } = await fixture(t);
  const companionRoot = join(directory, 'companion');
  await mkdir(join(companionRoot, 'scripts'), { recursive: true });
  await writeFile(join(companionRoot, 'scripts', 'codex-companion.mjs'), `
if(process.argv[2]!=='task-resume-candidate')process.exit(8);
process.stdout.write(JSON.stringify({available:true,sessionId:null,candidate:{threadId:'write-sibling'}}));
`);
  env.FABEX_CODEX_PLUGIN_ROOT = companionRoot;
  const first = JSON.parse((await run(control, ['thread', 'begin', 'primary'], { cwd: project, env })).stdout);
  await run(control, ['thread', 'complete', first.operationId, '--thread-id', 'old-primary'], { cwd: project, env });
  const recovery = JSON.parse((await run(control, ['thread', 'begin', 'primary'], { cwd: project, env })).stdout);
  assert.equal(recovery.plan.action, 'recover');
  assert.equal(recovery.plan.companionFlag, '--fresh');
  assert.equal(recovery.plan.predictedThreadId, 'write-sibling');
  const completed = await run(control, ['thread', 'complete', recovery.operationId, '--thread-id', 'new-primary'], { cwd: project, env });
  assert.equal(completed.code, 0, completed.stderr);
  const payload = JSON.parse(completed.stdout);
  assert.equal(payload.recovered, true);
  assert.equal(payload.replacedThreadId, 'old-primary');
  assert.equal(payload.threadId, 'new-primary');
});

test('Claude-only mode denies thread lifecycle controls', async (t) => {
  const { project, env } = await fixture(t);
  await run(control, ['mode', 'normal', '--participants', 'claude'], { cwd: project, env });
  const denied = await run(control, ['thread', 'begin', 'primary'], { cwd: project, env });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Claude-only mode denies Codex companion lifecycle controls/);
});

test('accepted decisions are checkpointed exactly and status exposes only their count', async (t) => {
  const { project, env } = await fixture(t);
  const recorded = await run(control, ['thread', 'checkpoint', '--decision', 'Use the owner-selected API.'], { cwd: project, env });
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.deepEqual((await readState(project, env)).state.partner.threads.checkpoint.acceptedDecisions, ['Use the owner-selected API.']);
  const visible = await run(control, ['status'], { cwd: project, env });
  assert.doesNotMatch(visible.stdout, /owner-selected API/);
  assert.equal(JSON.parse(visible.stdout).partner.threads.checkpoint.acceptedDecisionCount, 1);
});

test('SessionStart requires a checkpoint-seeded primary re-sync', async (t) => {
  const { project, env } = await fixture(t);
  const opened = JSON.parse((await run(control, ['thread', 'begin', 'primary'], { cwd: project, env })).stdout);
  await run(control, ['thread', 'complete', opened.operationId, '--thread-id', 'old-primary'], { cwd: project, env });
  const current = await readState(project, env);
  await updateState(project, (state) => {
    state.partner.threads.checkpoint.ownerGoals = ['owner goal verbatim'];
    state.partner.threads.checkpoint.acceptedDecisions = ['accepted decision'];
    state.partner.threads.checkpoint.currentStatus = 'bounded status';
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation }, env);
  await run(session, [], { cwd: project, env, input: { cwd: project, hook_event_name: 'SessionStart' } });
  const planned = JSON.parse((await run(control, ['thread', 'begin', 'primary'], { cwd: project, env })).stdout);
  assert.equal(planned.plan.action, 'resync');
  assert.equal(planned.plan.companionFlag, '--fresh');
  assert.match(planned.plan.seed, /owner goal verbatim/);
  assert.match(planned.plan.seed, /accepted decision/);
  assert.match(planned.plan.seed, /bounded status/);
  assert.match(planned.plan.seed, /earlier file observations are non-authoritative/);
});

test('real SessionStart creates, awaits, and records a checkpoint-seeded background re-sync thread', async (t) => {
  const { directory, project, env } = await fixture(t);
  const companionRoot = join(directory, 'companion');
  const companionScript = join(companionRoot, 'scripts', 'codex-companion.mjs');
  const companionLog = join(directory, 'companion.log');
  await mkdir(join(companionRoot, 'scripts'), { recursive: true });
  await writeFile(companionScript, `
import fs from 'node:fs';
const command=process.argv[2];
const args=process.argv.slice(3);
fs.appendFileSync(process.env.FAKE_COMPANION_LOG, JSON.stringify({command,args,sessionId:process.env.CODEX_COMPANION_SESSION_ID??null})+'\\n');
if(command==='task'){
  const prompt=args.at(-1);
  if(!args.includes('--background')||!args.includes('--fresh')||!prompt.includes('persist me verbatim')||!prompt.includes('full equal partner'))process.exit(9);
  process.stdout.write(JSON.stringify({jobId:'task-resync-1',status:'queued'}));
}else if(command==='status'){
  process.stdout.write(JSON.stringify({job:{id:'task-resync-1',status:'completed'},waitTimedOut:false}));
}else if(command==='result'){
  process.stdout.write(JSON.stringify({job:{id:'task-resync-1',status:'completed'},storedJob:{id:'task-resync-1',status:'completed',threadId:'resynced-primary',result:{status:0,threadId:'resynced-primary',rawOutput:'re-synced status'}}}));
}else if(command==='task-resume-candidate'){
  process.stdout.write(JSON.stringify({available:true,sessionId:process.env.CODEX_COMPANION_SESSION_ID??null,candidate:{threadId:'resynced-primary'}}));
}else process.exit(8);
`);
  env.FABEX_CODEX_PLUGIN_ROOT = companionRoot;
  env.FAKE_COMPANION_LOG = companionLog;
  const opened = JSON.parse((await run(control, ['thread', 'begin', 'primary'], { cwd: project, env })).stdout);
  await run(control, ['thread', 'complete', opened.operationId, '--thread-id', 'old-primary'], { cwd: project, env });
  const current = await readState(project, env);
  await updateState(project, (state) => {
    state.partner.threads.checkpoint.ownerGoals = ['persist me verbatim'];
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation }, env);
  const started = await run(session, [], {
    cwd: project,
    env,
    input: { cwd: project, hook_event_name: 'SessionStart', session_id: 'claude-session-1' }
  });
  assert.equal(started.code, 0, started.stderr);
  assert.match(JSON.parse(started.stdout).hookSpecificOutput.additionalContext, /Session re-sync Codex output.*re-synced status/);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.threads.primaryThreadId, 'resynced-primary');
  assert.equal(state.partner.threads.metadata.resyncStatus, 're-synced');
  assert.equal(state.partner.threads.checkpoint.currentStatus, 're-synced status');
  const calls = (await readFile(companionLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.command), ['task', 'status', 'result']);
  assert.ok(calls[0].args.includes('--background'));
  assert.equal(calls[0].sessionId, 'claude-session-1');
  const resumed = JSON.parse((await run(control, ['thread', 'begin', 'primary'], { cwd: project, env })).stdout);
  assert.equal(resumed.plan.action, 'resume');
  assert.equal(resumed.plan.expectedThreadId, 'resynced-primary');
});

test('controls and hooks walk from a subdirectory to the existing Fabex workstream root', async (t) => {
  const { project, env } = await fixture(t);
  const nested = join(project, 'packages', 'feature');
  await mkdir(nested, { recursive: true });
  await run(control, ['status'], { cwd: project, env });
  const nestedStatus = await run(control, ['status'], { cwd: nested, env });
  assert.equal(JSON.parse(nestedStatus.stdout).project.canonicalRoot, await realpath(project));
  await run(session, [], { cwd: nested, env, input: { cwd: nested, hook_event_name: 'UserPromptSubmit', prompt: 'hello' } });
  const state = (await readState(project, env)).state;
  assert.deepEqual(state.partner.threads.checkpoint.ownerGoals, ['hello']);
  const visible = await run(control, ['status'], { cwd: nested, env });
  assert.doesNotMatch(visible.stdout, /hello/);
  assert.equal(JSON.parse(visible.stdout).partner.threads.checkpoint.ownerGoalCount, 1);
});

test('session and guard resolve payload cwd to the same canonical project root', async (t) => {
  const { directory, project, env } = await fixture(t);
  const alias = join(directory, 'project-alias');
  await symlink(project, alias, 'dir');
  const sessionResult = await run(session, [], { cwd: directory, env, input: { cwd: alias, hook_event_name: 'SessionStart' } });
  assert.equal(sessionResult.code, 0, sessionResult.stderr);
  const guardResult = await run(guard, [], { cwd: directory, env, input: { cwd: alias, tool_name: 'Read', tool_input: { file_path: 'x' } } });
  assert.equal(guardResult.code, 0, guardResult.stderr);
  assert.equal(guardResult.stdout, '{}\n');
  const state = await readState(project, env);
  assert.equal(state.state.project.canonicalRoot, await realpath(project));
});

test('status first touch initializes healthy normal state', async (t) => {
  const { project, env } = await fixture(t);
  const result = await run(control, ['status'], { cwd: project, env });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.health, 'initialized');
  assert.equal(payload.route, 'normal');
  assert.equal(payload.participants, 'both');
  assert.equal(payload.label, 'work');
});

test('PreToolUse guard first touch initializes state from payload cwd', async (t) => {
  const { project, env } = await fixture(t);
  const result = await run(guard, [], { cwd: root, env, input: { cwd: project, tool_name: 'Read', tool_input: { file_path: 'README.md' } } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{}\n');
  const state = await readState(project, env);
  assert.equal(state.ok, true);
  assert.equal(state.state.route, 'normal');
});
