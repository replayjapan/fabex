import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { resolveSettings, executionPlan } from '../../scripts/lib/workspace-settings.mjs';
import { registerSession, issueWorkspaceGrant, applyWorkspaceGrant, titleFromText, parseGauge, sealReading, selectTaskRole, parseSettingsArgs } from '../../scripts/lib/workspace.mjs';
import { submitOperation, submissionEnvelope, reconciliationEnvelope, claimNextOperation, runOperation } from '../../scripts/lib/sdk-controller.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { usageControl } from '../../scripts/lib/usage-integration.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-110-'))), root = join(dir, 'project'); await mkdir(root);
  const env = { ...process.env, FABEX_HOME: join(dir, 'private') }; await initializeState(root, env);
  t.after(() => rm(dir, { recursive: true, force: true })); return { root, env };
}
async function grant(root, env, session, args, command = 'settings') {
  return issueWorkspaceGrant(root, { command_name: `fabex:${command}`, command_args: args, session_id: session, expansion_type: 'slash_command', command_source: 'plugin' }, env);
}
test('1.10 session overrides remain isolated and grants are consumed', async t => {
  const { root, env } = await fixture(t);
  await registerSession(root, { session_id: 'chat-a' }, env); await registerSession(root, { session_id: 'chat-b' }, env);
  const g = await grant(root, env, 'chat-a', 'roles.implementation.executor=claude');
  await applyWorkspaceGrant(root, g.id, env);
  const state = (await readState(root, env)).state;
  assert.equal(resolveSettings({}, state, 'chat-a').values['roles.implementation.executor'], 'claude');
  assert.equal(resolveSettings({}, state, 'chat-b').values['roles.implementation.executor'], 'codex');
  const cli=await exec(process.execPath,[new URL('../../scripts/control.mjs',import.meta.url).pathname,'settings','--session','chat-a','--json'],{cwd:root,env});
  assert.equal(JSON.parse(cli.stdout).values['roles.implementation.executor'],'claude');
  await assert.rejects(applyWorkspaceGrant(root, g.id, env), /grant/);
  await assert.rejects(issueWorkspaceGrant(root, { command_name: 'fabex:settings', command_args: 'summaries=false' }, env), /owner-typed/);
  const reset = await grant(root, env, 'chat-a', 'roles.implementation.executor=inherit'); await applyWorkspaceGrant(root, reset.id, env);
  assert.equal(resolveSettings({}, (await readState(root, env)).state, 'chat-a').values['roles.implementation.executor'], 'codex');
});
test('1.10 milestones preserve predecessor thread and reconnect the right chat', async t => {
  const { root, env } = await fixture(t); await registerSession(root, { session_id: 'a' }, env);
  await updateState(root, s => { s.partner.thread.threadId = 'original-thread'; s.generation++; return s; }, {}, env);
  await registerSession(root, { session_id: 'b' }, env);
  const g = await grant(root, env, 'b', 'Milestone Two', 'milestone'); await applyWorkspaceGrant(root, g.id, env);
  let state = (await readState(root, env)).state;
  assert.equal(state.partner.thread.threadId, null); assert.equal(state.workspace.milestones.legacy.thread.threadId, 'original-thread');
  await registerSession(root, { session_id: 'a' }, env); state = (await readState(root, env)).state;
  assert.equal(state.partner.thread.threadId, 'original-thread');
  const changed = await grant(root,env,'a','roles.implementation.executor=claude'); await applyWorkspaceGrant(root,changed.id,env);
  await applyWorkspaceGrant(root,(await grant(root,env,'a','Milestone Two','milestone')).id,env);
  assert.equal(resolveSettings({},(await readState(root,env)).state,'a').values['roles.implementation.executor'],'codex');
  await applyWorkspaceGrant(root,(await grant(root,env,'a','legacy','milestone')).id,env);
  assert.equal(resolveSettings({},(await readState(root,env)).state,'a').values['roles.implementation.executor'],'claude');
});
test('1.10 a registered Phase 1 cannot start until the independent assessment is sealed', async t => {
  const { root, env } = await fixture(t); await registerSession(root, { session_id: 'a' }, env);
  await updateState(root, s => { s.contextEvidence.ownerPrompt = { digest: 'a'.repeat(64), bytes: 1, capturedAt: new Date().toISOString(), sessionId: 'a' }; s.generation++; return s; }, {}, env);
  // Empty prompt evidence permits the legacy envelope; relay session binds the new gate.
  await updateState(root, s => { s.contextEvidence.ownerPrompt = null; s.recordedReply = null; s.generation++; return s; }, {}, env);
  const { recordAuthorizedPrompt } = await import('../../scripts/lib/hook-evidence.mjs');
  await recordAuthorizedPrompt(root, 'Review this', 'a', env);
  const op = await submitOperation(root, submissionEnvelope('Review this'), env, { spawnRunner: false });
  assert.equal(await claimNextOperation(root, env), null);
  await registerSession(root, { session_id: 'other-chat' }, env);
  assert.equal((await readState(root,env)).state.workspace.activeSessionId,'a');
  await sealReading(root, op.operationId, 'My independently formed assessment.', env);
  assert.equal((await claimNextOperation(root, env)).id, op.operationId);
  assert.equal((await sealReading(root, op.operationId, 'My independently formed assessment.', env)).sealed, true);
  await assert.rejects(sealReading(root, op.operationId, 'Changed after reading', env), /queued/);
});
test('1.10 project defaults preserve config and task roles select only configured authority', async t => {
  const { root, env } = await fixture(t); await registerSession(root, { session_id: 'a' }, env);
  await applyWorkspaceGrant(root, (await grant(root, env, 'a', 'roles.docs.executor=claude roles.docs.model=opus scope=project')).id, env);
  const { loadEffectiveConfig } = await import('../../scripts/lib/config.mjs');
  const config = (await loadEffectiveConfig(root, env)).config;
  assert.equal(config.settings['roles.docs.executor'], 'claude');
  await selectTaskRole(root, 'docs', env);
  const { state } = await readState(root, env);
  assert.deepEqual(executionPlan(config, state), { role: 'docs', executor: 'claude', model: 'opus', effort: null });
  assert.equal(resolveSettings(config, state).sources['roles.docs.executor'], 'project');
  await assert.rejects(applyWorkspaceGrant(root, (await grant(root, env, 'a', 'invented.key=yes')).id, env), /unknown setting/);
});
test('1.10 title parsing and context snapshots are bounded and honest', () => {
  assert.equal(parseSettingsArgs('usageTracker.path="/a folder/track"').updates['usageTracker.path'],'/a folder/track');
  assert.throws(() => parseSettingsArgs('usageTracker.path="/unclosed'),/unterminated/);
  assert.equal(titleFromText('{"type":"custom-title","sessionId":"a","customTitle":"M2"}\n', 'a'), 'M2');
  assert.equal(titleFromText('malformed', 'a'), null);
  const gauge = parseGauge(JSON.stringify({ timestamp: 'now', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 25 }, model_context_window: 100 } } }), true);
  assert.equal(gauge.lastCall.fraction, .25); assert.match(gauge.compactionCountCoverage, /tail/);
});
test('1.10 role authoring override applies only to its main session and preserves discussion', async t => {
  const { root, env } = await fixture(t); await registerSession(root, { session_id: 'a' }, env);
  await applyWorkspaceGrant(root, (await grant(root, env, 'a', 'roles.implementation.executor=claude')).id, env);
  const { state, paths } = await readState(root, env);
  const input = { state, paths, config: {}, env, toolName: 'Write', toolInput: { file_path: join(root, 'app.js'), content: 'x' }, executor: { sessionId: 'a' } };
  assert.notEqual((await classifyToolUse(input)).decision, 'deny');
  assert.equal((await classifyToolUse({ ...input, executor: { sessionId: 'a', agentId: 'other' } })).decision, 'deny');
  const otherActive=structuredClone(state); otherActive.workspace.activeSessionId='other';
  assert.equal((await classifyToolUse({ ...input,state:otherActive })).decision,'deny');
  assert.equal((await classifyToolUse({ ...input, state: { ...state, route: 'discussion' } })).decision, 'deny');
});
test('1.10 disabled tracking makes no call; enabled discussion only requests read-only reports', async t => {
  const { root, env } = await fixture(t); let called = false;
  assert.equal(await usageControl(root, ['report'], env, async () => { called = true; }), null); assert.equal(called, false);
  await registerSession(root, { session_id: 'a' }, env);
  const launcher = join(root, 'track'); await writeFile(launcher, 'placeholder');
  await applyWorkspaceGrant(root, (await grant(root, env, 'a', `usageTracker.mode=on usageTracker.path=${launcher}`)).id, env);
  await updateState(root, s => { s.route = 'discussion'; s.generation++; return s; }, {}, env);
  const run = async (file, args) => { called = true; assert.equal(file,'python3'); assert.ok(args.includes('--read-only')); return { stdout: '{}' }; };
  await usageControl(root, ['report'], env, run); assert.equal(called, true);
  assert.equal((await usageControl(root, ['snapshot', '--event', 'start'], env, run)).deferred, true);
});
test('1.10 sealed two-phase execution uses main then task model and preserves handoff history', async t => {
  const { root, env } = await fixture(t); await registerSession(root, { session_id: 'a' }, env);
  await applyWorkspaceGrant(root, (await grant(root, env, 'a', 'partners.codex.model=main-model roles.implementation.model=task-model')).id, env);
  const { recordAuthorizedPrompt } = await import('../../scripts/lib/hook-evidence.mjs');
  await recordAuthorizedPrompt(root, 'Implement the approved task', 'a', env);
  const phase1 = await submitOperation(root, submissionEnvelope('Implement the approved task'), env, { spawnRunner: false });
  const calls=[];
  const createCodex = async () => {
    const thread = options => ({ runStreamed: async prompt => {
      calls.push({ options, prompt });
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'fixture-thread' };
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'Fixture conclusion' } };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
      })() };
    } });
    return { startThread: thread, resumeThread: (_id,options) => thread(options) };
  };
  await sealReading(root, phase1.operationId, 'Sealed independent position', env);
  await runOperation(root, await claimNextOperation(root, env), { createCodex }, env);
  const phase2 = await submitOperation(root, reconciliationEnvelope(phase1.operationId, 'Implement the approved task', 'Review and implement'), env, { spawnRunner: false });
  await runOperation(root, await claimNextOperation(root, env), { createCodex }, env);
  assert.equal(calls[0].options.model,'main-model'); assert.equal(calls[1].options.model,'task-model');
  assert.doesNotMatch(calls[0].prompt,/Sealed independent position/);
  assert.match(calls[1].prompt,/Sealed independent position/);
  const { milestoneHandoff } = await import('../../scripts/lib/workspace.mjs');
  await milestoneHandoff(root,phase2.operationId,'Reviewed handoff',false,env);
  await milestoneHandoff(root,phase2.operationId,null,true,env);
  const state=(await readState(root,env)).state;
  assert.equal(state.partner.thread.threadId,null);
  assert.equal(state.workspace.milestones.legacy.parts[0].threadId,'fixture-thread');
  assert.equal(state.partner.thread.checkpoint.nextAction,'Reviewed handoff');
  const { paths } = await readState(root,env);
  const archive=JSON.parse(await readFile(join(paths.projectDir,'chats','Legacy--legacy','references.json'),'utf8'));
  assert.equal(archive.handoff,'Reviewed handoff'); assert.equal(archive.references[0].sessionId,'a');
  assert.equal(archive.archivedParts[0].threadId,'fixture-thread');
  await applyWorkspaceGrant(root,(await grant(root,env,'a','restore-part=0','milestone')).id,env);
  assert.equal((await readState(root,env)).state.partner.thread.threadId,'fixture-thread');
  assert.equal((await readState(root,env)).state.partner.thread.checkpoint.continuation.armed,false);
});
test('1.10 schema 16 adds only the private workspace registry and settings inheritance is explicit', async t => {
  const {root,env}=await fixture(t); const initial=await readState(root,env);
  const legacy=structuredClone(initial.state); delete legacy.workspace; legacy.schemaVersion=16;
  legacy.partner.thread.threadId='retained-legacy'; await writeFile(initial.paths.stateFile,JSON.stringify(legacy));
  const migrated=await readState(root,env); assert.equal(migrated.ok,true); assert.equal(migrated.state.partner.thread.threadId,'retained-legacy');
  const {workspace,schemaVersion,generation,...rest}=migrated.state;
  const {schemaVersion:oldSchema,generation:oldGeneration,...old}=legacy;
  assert.deepEqual(rest,old); assert.equal(workspace.activeMilestoneId,'legacy'); assert.equal(schemaVersion,17);
  await writeFile(join(env.FABEX_HOME,'config.json'),JSON.stringify({schemaVersion:1,settings:{'usageTracker.mode':'on'}}));
  await mkdir(join(root,'.fabex')); await writeFile(join(root,'.fabex','config.json'),JSON.stringify({schemaVersion:1,settings:{'usageTracker.mode':'inherit'}}));
  const {loadEffectiveConfig}=await import('../../scripts/lib/config.mjs');
  assert.equal((await loadEffectiveConfig(root,env)).config.settings['usageTracker.mode'],'on');
});
test('1.10 new Claude skills have explicit owner-only invocation metadata', async () => {
  for (const name of ['settings','milestone']) {
    const text=await readFile(new URL(`../../skills/${name}/SKILL.md`,import.meta.url),'utf8');
    assert.ok(text.startsWith('---\n')); assert.match(text,new RegExp(`\nname: ${name}\n`));
    assert.match(text,/\ndescription: [^\n]+\n/); assert.match(text,/\ndisable-model-invocation: true\n/);
  }
});
test('1.10 queued chats with identical words keep their own milestone and sealed review', async t => {
  const {root,env}=await fixture(t);
  await registerSession(root,{session_id:'a'},env); await registerSession(root,{session_id:'b'},env);
  await applyWorkspaceGrant(root,(await grant(root,env,'b','Second','milestone')).id,env);
  const second=(await readState(root,env)).state.workspace.activeMilestoneId;
  await registerSession(root,{session_id:'a'},env);
  const {recordAuthorizedPrompt}=await import('../../scripts/lib/hook-evidence.mjs');
  const {createHash}=await import('node:crypto');
  const envelope=session=>JSON.stringify({phase:'independent',ownerSessionId:session,ownerMessageStatus:'recorded',ownerMessageDigest:createHash('sha256').update('Continue').digest('hex'),previousReplyStatus:'none'});
  await recordAuthorizedPrompt(root,'Continue','a',env);
  const a=await submitOperation(root,envelope('a'),env,{spawnRunner:false});
  await registerSession(root,{session_id:'b'},env); await recordAuthorizedPrompt(root,'Continue','b',env);
  const b=await submitOperation(root,envelope('b'),env,{spawnRunner:false});
  await sealReading(root,a.operationId,'A first view',env); await sealReading(root,b.operationId,'B first view',env);
  assert.equal((await readState(root,env)).state.workspace.activeMilestoneId,'legacy');
  let count=0; const starts=[];
  const createCodex=async()=>{
    const thread=id=>({runStreamed:async()=>({events:(async function*(){yield {type:'thread.started',thread_id:id};yield {type:'item.completed',item:{type:'agent_message',text:'review'}};yield {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}};})()})});
    return {startThread:()=>{const id=`thread-${++count}`;starts.push(id);return thread(id);},resumeThread:id=>thread(id)};
  };
  assert.equal((await claimNextOperation(root,env)).id,a.operationId);
  await runOperation(root,(await readState(root,env)).state.operations.find(o=>o.id===a.operationId),{createCodex},env);
  assert.equal(await claimNextOperation(root,env),null);
  await submitOperation(root,JSON.stringify({...JSON.parse(reconciliationEnvelope(a.operationId,'Continue','Compare A')),ownerSessionId:'a'}),env,{spawnRunner:false});
  await runOperation(root,await claimNextOperation(root,env),{createCodex},env);
  const next=await claimNextOperation(root,env); assert.equal(next.id,b.operationId);
  assert.equal((await readState(root,env)).state.workspace.activeMilestoneId,second);
  await runOperation(root,next,{createCodex},env);
  assert.deepEqual(starts,['thread-1','thread-2']);
  assert.equal((await readState(root,env)).state.workspace.milestones.legacy.thread.threadId,'thread-1');
});
test('1.10 bundled usage reader executes read-only against a disposable fixture', async t => {
  const {root}=await fixture(t); const database=join(root,'usage.sqlite3');
  await exec('python3',['-c',"import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.executescript('CREATE TABLE allowances(provider,bucket,observed,used,resets,minutes,source); CREATE TABLE snapshots(id,project,milestone,event,checkpoint,captured);'); d.close()",database]);
  const before=await readFile(database);
  const {stdout}=await exec('python3',[new URL('../../scripts/tracker-read-only.py',import.meta.url).pathname,'--read-only','--database',database,'--project',root,'--milestone','fixture']);
  assert.equal(JSON.parse(stdout).read_only,true); assert.deepEqual(await readFile(database),before);
  assert.deepEqual(await readdir(root),['usage.sqlite3']);
});
