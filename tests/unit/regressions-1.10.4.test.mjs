import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, realpath, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availableModels, cleanModels } from '../../scripts/lib/model-catalog.mjs';
import { initializeState, readState } from '../../scripts/lib/state.mjs';
import { registerSession, selectTaskRole, sealReading, issueWorkspaceGrant, applyWorkspaceGrant } from '../../scripts/lib/workspace.mjs';
import { submitOperation, submissionEnvelope, reconciliationEnvelope, claimNextOperation, runOperation } from '../../scripts/lib/sdk-controller.mjs';
import { recordAuthorizedPrompt } from '../../scripts/lib/hook-evidence.mjs';
import { saveDocumentationDraft, readDocumentationDrafts, assembleDocumentation, documentationJob } from '../../scripts/lib/docs-both.mjs';
import { validateSettings, SETTING_DEFAULTS } from '../../scripts/lib/workspace-settings.mjs';
import { parseControlCommand, classifyToolUse } from '../../scripts/hook-route-guard.mjs';
const model = (id, efforts=['low','high']) => ({ model:id, supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort})), defaultReasoningEffort:'high', isDefault:true });
test('1.10.4 model catalog uses account model/list, handles pages and filters hidden models', async()=>{
  const requests=[];let killed=false;
  const launch=()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed=true;};
    child.stdin=new Writable({write(chunk,_,done){const m=JSON.parse(chunk);requests.push(m);queueMicrotask(()=>{
      if(m.id===1)child.stdout.write(JSON.stringify({id:1,result:{}})+'\n');
      if(m.id===2)child.stdout.write(JSON.stringify({id:2,result:{data:m.params.cursor?[model('second')]:[model('actual'),{...model('hidden'),hidden:true}],nextCursor:m.params.cursor?null:'page2'}})+'\n');
    });done();}});return child;
  };
  const result=await availableModels(process.cwd(),process.env,{launch});
  assert.deepEqual(result.models.map(m=>m.id),['actual','second']);assert.equal(killed,true);
  assert.ok(requests.filter(r=>r.method==='model/list').every(r=>r.params.includeHidden===false));
  assert.ok(!requests.some(r=>/turn|thread/.test(r.method)));
  assert.throws(()=>cleanModels([model('bad model')]),/Invalid/);
});
test('1.10.4 unavailable catalog never falls back to history and kills only its own child',async()=>{
  let killed=0;
  const launch=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.kill=()=>killed++;return c;};
  const result=await availableModels(process.cwd(),process.env,{launch,timeout:10});
  assert.deepEqual(result.models,[]);assert.match(result.error,/unavailable/);assert.equal(killed,1);
});
async function fixture(t){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'fabex-1104-'))),root=join(dir,'project');await mkdir(root);
  const env={...process.env,FABEX_HOME:join(dir,'private'),FABEX_DOCUMENTATION_OPERATION:''};
  await initializeState(root,env);await registerSession(root,{session_id:'a'},env);
  t.after(()=>rm(dir,{recursive:true,force:true}));return {root,env};
}
test('1.10.4 Docs Both is the unset default, preserves saved choices and is invalid for code/testing',async t=>{
  assert.equal(SETTING_DEFAULTS['roles.docs.executor'],'both');
  assert.throws(()=>validateSettings({'roles.implementation.executor':'both'}),/invalid/);
  assert.throws(()=>validateSettings({'roles.testWriting.executor':'both'}),/invalid/);
  const f=await fixture(t);
  const g=await issueWorkspaceGrant(f.root,{command_name:'fabex:settings',command_args:'roles.docs.executor=claude scope=project',session_id:'a',expansion_type:'slash_command',command_source:'plugin'},f.env);
  const result=await applyWorkspaceGrant(f.root,g.id,f.env);assert.equal(result.values['roles.docs.executor'],'claude');
});
test('1.10.4 real controller lifecycle preserves blind drafts and assembles each author verbatim after review',async t=>{
  const f=await fixture(t);await selectTaskRole(f.root,'docs',f.env);
  const owner='Write two independent perspectives in a new document.';await recordAuthorizedPrompt(f.root,owner,'a',f.env);
  const first=await submitOperation(f.root,submissionEnvelope(owner),f.env,{spawnRunner:false});const id=first.operationId;
  await assert.rejects(sealReading(f.root,id,'Claude assessment',f.env),/save its independent/);
  await writeFile(join(f.root,'existing.md'),'keep me');
  await assert.rejects(saveDocumentationDraft(f.root,id,{path:'existing.md',body:'no'},f.env),/existing files/);
  await assert.rejects(saveDocumentationDraft(f.root,id,{path:'../escape.md',body:'no'},f.env),/inside/);
  await saveDocumentationDraft(f.root,id,{path:'perspectives.md',body:'Claude original.\n'},f.env);
  await sealReading(f.root,id,'Claude assessment',f.env);
  await assert.rejects(saveDocumentationDraft(f.root,id,{body:'too late'},f.env),/before sealing/);
  let active,phase=0;const requests=[];
  const createCodex=async()=>{
    const thread=options=>({runStreamed:async input=>{
      requests.push({input,options});
      return {events:(async function*(){
        yield {type:'thread.started',thread_id:'docs-test-thread'};
        const codexEnv={...f.env,FABEX_DOCUMENTATION_OPERATION:active.id};
        const visible=await readDocumentationDrafts(f.root,id,codexEnv);
        if(phase===0){assert.equal(visible.body,null);assert.equal(visible.claude,undefined);assert.match(visible.other,/Hidden/);}
        else assert.equal(visible.claude,'Claude revised only its own.');
        const response={scopeMismatch:null,parityConcern:null,answer:'Separate contribution returned.',ownerSummary:'My own contribution is ready.',evidence:[],assumptions:[],uncertainties:[],recommendation:null,changedFiles:[],tests:[],documentation:phase++===0?'Codex original.':'Codex revised only its own.',...(active.request.phase==='reconcile'?{disagreements:[]}: {})};
        yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(response)}};
        yield {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}};
      })()};
    }});return {startThread:thread,resumeThread:(_id,o)=>thread(o)};
  };
  active=await claimNextOperation(f.root,f.env);await runOperation(f.root,active,{createCodex},f.env);
  assert.ok(!requests[0].input.includes('Claude original.'));
  await saveDocumentationDraft(f.root,id,{body:'Claude revised only its own.'},f.env);
  assert.equal((await documentationJob(f.root,id,f.env)).codex,'Codex original.');
  const child=await submitOperation(f.root,reconciliationEnvelope(id,owner,'Review each contribution separately.'),f.env,{spawnRunner:false});
  await assert.rejects(assembleDocumentation(f.root,id,child.operationId,f.env),/completed matching/);
  active=await claimNextOperation(f.root,f.env);await runOperation(f.root,active,{createCodex},f.env);
  assert.ok(requests[1].input.includes('Claude revised only its own.'));
  await assembleDocumentation(f.root,id,child.operationId,f.env);
  assert.equal(await readFile(join(f.root,'perspectives.md'),'utf8'),'# Claude\n\nClaude revised only its own.\n\n# Codex\n\nCodex revised only its own.\n');
  const job=await documentationJob(f.root,id,f.env);assert.equal(job.original.claude.body,'Claude original.\n');assert.equal(job.original.codex.body,'Codex original.');
  await writeFile(join(f.root,'perspectives.md'),'External edit');await assert.rejects(assembleDocumentation(f.root,id,child.operationId,f.env),/changed outside/);
});
test('1.10.4 documentation controls are narrow and do not grant ordinary Claude writes',async t=>{
  const f=await fixture(t);await selectTaskRole(f.root,'docs',f.env);await recordAuthorizedPrompt(f.root,'Write docs','a',f.env);
  const {operationId:id}=await submitOperation(f.root,submissionEnvelope('Write docs'),f.env,{spawnRunner:false});
  const script=new URL('../../scripts/control.mjs',import.meta.url).pathname;
  const command=`node "${script}" docs draft --operation-id ${id} <<'FABEX_DOCS_1234'\n{"path":"out.md","body":"Claude words"}\nFABEX_DOCS_1234`;
  assert.equal(parseControlCommand(command).kind,'docs-draft');assert.equal(parseControlCommand(command+'\necho bypass'),null);
  const current=await readState(f.root,f.env);const input={state:current.state,paths:current.paths,config:{},env:f.env,executor:{sessionId:'a'},toolName:'Bash',toolInput:{command}};
  assert.equal((await classifyToolUse(input)).decision,'defer');
  assert.equal((await classifyToolUse({...input,executor:{sessionId:'other'}})).decision,'deny');
  assert.equal((await classifyToolUse({...input,executor:{sessionId:'a',agentId:'helper'}})).decision,'deny');
  assert.equal((await classifyToolUse({...input,toolName:'Write',toolInput:{file_path:join(f.root,'out.md'),content:'overwrite'}})).decision,'deny');
});

test('1.10.4 missing second contribution cannot complete a Docs Both SDK turn',async t=>{
  const f=await fixture(t);await selectTaskRole(f.root,'docs',f.env);await recordAuthorizedPrompt(f.root,'Write both views','a',f.env);
  const first=await submitOperation(f.root,submissionEnvelope('Write both views'),f.env,{spawnRunner:false});
  await saveDocumentationDraft(f.root,first.operationId,{path:'incomplete.md',body:'Preserve Claude draft.'},f.env);
  await sealReading(f.root,first.operationId,'Independent assessment',f.env);
  const createCodex=async()=>({startThread:()=>({runStreamed:async()=>({events:(async function*(){yield{type:'thread.started',thread_id:'incomplete'};yield{type:'turn.completed'};})()})})});
  await assert.rejects(runOperation(f.root,await claimNextOperation(f.root,f.env),{createCodex},f.env),/no valid Codex contribution/);
  assert.equal((await documentationJob(f.root,first.operationId,f.env)).claude,'Preserve Claude draft.');
  assert.equal((await readState(f.root,f.env)).state.operations.find(o=>o.id===first.operationId).status,'failed');
  await assert.rejects(readFile(join(f.root,'incomplete.md')),{code:'ENOENT'});
});
