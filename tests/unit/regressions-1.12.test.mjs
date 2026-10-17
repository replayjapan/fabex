import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { heavyShape } from '../../scripts/lib/heavy.mjs';
import { helperServerOptions } from '../../scripts/lib/sdk-process.mjs';
import { initializeState, readState } from '../../scripts/lib/state.mjs';
import { registerSession, sealReading, selectTaskRole } from '../../scripts/lib/workspace.mjs';
import { observeHost } from '../../scripts/vendor/modes/state.mjs';
import { observeActivity, aliasActivity, activitySnapshot } from '../../scripts/lib/activity.mjs';
import { captureOwnerDelivery } from '../../scripts/lib/owner-delivery.mjs';
import { modeTargetForSkill, ownerFabexCommand } from '../../scripts/lib/hook-evidence.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { dispatchOwnerDeliveries, claimNextOperation, runOperation, submitOperation, reconciliationEnvelope } from '../../scripts/lib/sdk-controller.mjs';
const rootRepo = resolve(import.meta.dirname, '../..');

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-112-'))), root = join(dir,'project'); await mkdir(root);
  const env = { ...process.env, FABEX_HOME:join(dir,'state'), MODES_HOME:join(dir,'modes'), CLAUDE_CONFIG_DIR:join(dir,'claude') };
  await initializeState(root,env); await registerSession(root,{session_id:'a'},env);
  t.after(() => rm(dir,{recursive:true,force:true}));
  return { dir,root,env,input:{session_id:'a',cwd:root,permission_mode:'default'} };
}
const review = phase => ({ scopeMismatch:null,parityConcern:null,answer:'Reviewed.',ownerSummary:'Reviewed.',evidence:[],assumptions:[],uncertainties:[],...(phase==='reconcile'?{disagreements:[]}:{}),recommendation:null,changedFiles:[],tests:[] });
const expansion = (f,name) => ({...f.input,command_name:name,expansion_type:'slash_command',command_source:'plugin',command_args:''});
async function guard(f,toolName,toolInput) { return classifyToolUse({...(await readState(f.root,f.env)),toolName,toolInput,executor:{sessionId:'a'},config:{},env:f.env}); }

test('Modes commands supply activity evidence without changing the canonical state schema',async t => {
  const f=await fixture(t);
  await observeHost(f.root,f.input,f.env,true);
  await observeActivity(f.root,f.input,f.env);
  assert.equal((await activitySnapshot(f.root,'a',f.env)).activity,'work');
  await aliasActivity(f.root,expansion(f,'modes:discussion'),f.env);
  assert.equal((await activitySnapshot(f.root,'a',f.env)).activity,'discussion');
  await aliasActivity(f.root,expansion(f,'modes:work'),f.env);
  assert.equal((await activitySnapshot(f.root,'a',f.env)).activity,'work');
  assert.equal(modeTargetForSkill('fabex:discussion'),null);
  assert.equal(modeTargetForSkill('modes:discussion').route,'discussion');
  assert.equal(ownerFabexCommand('/modes:ask A question'),true);
  assert.equal((await readState(f.root,f.env)).state.schemaVersion,18);
  await observeActivity(f.root,{...f.input,permission_mode:undefined},f.env);
  assert.equal((await activitySnapshot(f.root,'a',f.env)).activity,'discussion');
});

test('restricted activity cannot use a stale work route to start servers or bypass coding and pending-review gates',async t => {
  const f=await fixture(t); await observeHost(f.root,f.input,f.env,true); await observeActivity(f.root,f.input,f.env);
  await aliasActivity(f.root,expansion(f,'modes:discussion'),f.env);
  const dev=await guard(f,'Bash',{command:`node ${join(rootRepo,'scripts/control.mjs')} dev start`});
  assert.equal(dev.decision,'deny');
  assert.equal((await guard(f,'Write',{file_path:join(f.root,'app.js'),content:'bad'})).decision,'deny');
  assert.equal((await guard(f,'Read',{file_path:join(f.root,'photo.png')})).decision,'deny');
  await selectTaskRole(f.root,'docs',f.env);
  const plan={file_path:join(f.root,'Planning/active/plan.md'),content:'Plan'};
  assert.equal((await guard(f,'Write',plan)).decision,'defer');
  const encoded = Buffer.from(JSON.stringify([{path:plan.file_path,expectedHash:null,content:plan.content}])).toString('base64');
  const command = `node ${join(rootRepo,'scripts/activity-control.mjs')} write ${f.root} a ${encoded}`;
  if(process.platform==='darwin') assert.equal((await guard(f,'Bash',{command})).decision,'defer');
  await captureOwnerDelivery(f.root,{...f.input,prompt:'Review this plan'},(await readState(f.root,f.env)).state,f.env);
  assert.equal((await guard(f,'Write',plan)).decision,'deny');
  assert.equal((await guard(f,'Bash',{command})).decision,'deny');
});

test('research reconciliation uses native read-only and validates plan proposals after the turn',async t => {
  const f=await fixture(t); await observeHost(f.root,f.input,f.env,true); await observeActivity(f.root,f.input,f.env);
  await aliasActivity(f.root,expansion(f,'modes:discussion'),f.env);
  const entry=await captureOwnerDelivery(f.root,{...f.input,prompt:'Write a text plan in Planning/active/plan.md.'},(await readState(f.root,f.env)).state,f.env);
  await dispatchOwnerDeliveries(f.root,'a',f.env,{spawnRunner:false});
  await sealReading(f.root,entry.id,'Independent view.',f.env);
  async function execute(phase) {
    const op=await claimNextOperation(f.root,f.env); assert.ok(op);
    const createCodex=async(_config,context)=> {
      assert.equal(context.helperServers,'research');
      const thread=options=>({runStreamed:async(_input,turnOptions)=>{
        assert.equal(options.sandboxMode,'read-only'); assert.equal(options.networkAccessEnabled,true); assert.equal(options.webSearchMode,'live');
        const result=review(phase);
        if(phase==='reconcile') { assert.ok(turnOptions.outputSchema.properties.researchEdits); result.researchEdits=[{path:'Planning/active/plan.md',expectedHash:null,content:'Reviewed plan'}]; }
        return {events:(async function*(){ yield {type:'thread.started',thread_id:'research-thread'}; yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}; yield {type:'turn.completed'}; })()};
      }});
      return {startThread:thread,resumeThread:(_id,options)=>thread(options)};
    };
    return runOperation(f.root,op,{createCodex},f.env);
  }
  await execute('independent');
  await assert.rejects(readFile(join(f.root,'Planning/active/plan.md')),{code:'ENOENT'});
  await submitOperation(f.root,reconciliationEnvelope(entry.id,entry.text,'Agreed: write the plan.'),f.env,{spawnRunner:false});
  await execute('reconcile');
  assert.equal(await readFile(join(f.root,'Planning/active/plan.md'),'utf8'),'Reviewed plan');
});

test('packaged compatibility policy is byte-identical to the reviewed Modes source',async () => {
  const source=resolve(rootRepo,'../modes/scripts/lib');
  // Release CI may test Fabex alone; the checked-in manifest still verifies its
  // bundled copies. A sibling source, when present, must match byte for byte.
  const manifest=JSON.parse(await readFile(join(rootRepo,'scripts/vendor/modes/manifest.json'),'utf8'));
  const {createHash}=await import('node:crypto');
  for(const [file,hash] of Object.entries(manifest.files)) {
    const bundled=await readFile(join(rootRepo,'scripts/vendor/modes',file));
    assert.equal(createHash('sha256').update(bundled).digest('hex'),hash,file);
    try { assert.deepEqual(await readFile(join(source,file)),bundled,file); } catch(e) { if(e.code!=='ENOENT') throw e; }
  }
  assert.deepEqual((await readdir(join(rootRepo,'scripts/vendor/modes'))).filter(f=>f.endsWith('.mjs')).sort(),Object.keys(manifest.files).sort());
});

test('research SDK retains hosted helpers and filters global servers using the shared read-only tools',async () => {
  const options={env:{FABEX_SDK_BINARY:'/pinned/codex',CODEX_HOME:'/isolated/config'}};
  const context={root:'/project',helperServers:'research'};
  const config=async()=> '[mcp_servers.mobbin]\nurl="https://example.test/mcp"\n[mcp_servers.mutator]\ncommand="mutator"\n';
  const catalog=async()=>({stdout:JSON.stringify([{name:'hosted',enabled:true},{name:'mobbin',enabled:true},{name:'mutator',enabled:true}])});
  const result=await helperServerOptions(options,context,catalog,config);
  assert.equal(result.configOverrides.some(s=>s.includes('hosted')),false);
  assert.ok(result.configOverrides.includes('mcp_servers.mutator.enabled=false'));
  assert.match(result.configOverrides.find(s=>s.startsWith('mcp_servers.mobbin.enabled_tools=')),/search_sections/);
  assert.equal(result.fabexHelperServers.hostManaged,1);
  assert.equal(result.fabexHelperServers.verified,false);
  const unavailable=await helperServerOptions(options,context,async()=>{throw new Error('unavailable');},config);
  assert.match(unavailable.fabexHelperServers.warning,/unavailable/);
});

test('Fabex without Modes follows host evidence, preserving plan restrictions when a payload omits it',async t=>{
  const f=await fixture(t);
  assert.equal((await activitySnapshot(f.root,'a',f.env)).source,'host-unknown');
  assert.equal((await activitySnapshot(f.root,'a',f.env)).activity,'discussion');
  assert.equal((await guard(f,'Write',{file_path:join(f.root,'app.js'),content:'bad'})).decision,'deny');
  await observeActivity(f.root,f.input,f.env);
  const before=(await readState(f.root,f.env)).state;
  assert.equal((await activitySnapshot(f.root,'a',f.env)).activity,'work');
  assert.equal(await aliasActivity(f.root,expansion(f,'fabex:discussion'),f.env),null);
  await observeActivity(f.root,{...f.input,permission_mode:undefined},f.env);
  assert.deepEqual((await readState(f.root,f.env)).state,before);
  await observeActivity(f.root,{...f.input,permission_mode:'plan'},f.env);
  assert.equal((await activitySnapshot(f.root,'a',f.env)).activity,'discussion');
  await observeActivity(f.root,{...f.input,permission_mode:undefined},f.env);
  assert.equal((await activitySnapshot(f.root,'a',f.env)).activity,'discussion');
  assert.equal((await activitySnapshot(f.root,'unknown-session',f.env)).activity,'discussion');
  assert.equal((await guard(f,'Write',{file_path:join(f.root,'app.js'),content:'bad'})).decision,'deny');
  await observeActivity(f.root,{...f.input,permission_mode:undefined},f.env);
  assert.equal((await activitySnapshot(f.root,'a',f.env)).source,'host-plan');
  await observeActivity(f.root,f.input,f.env);
  assert.equal((await activitySnapshot(f.root,'a',f.env)).activity,'work');
  assert.deepEqual((await readState(f.root,f.env)).state,before);
});

test('contained experiment commands enter the shared heavy-work classifier',()=>{
  assert.equal(heavyShape('node /plugins/modes/scripts/control.mjs run /project session -- node experiment.mjs'),'contained research');
});
