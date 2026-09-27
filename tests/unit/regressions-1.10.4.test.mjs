import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, realpath, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availableModels, cleanModels } from '../../scripts/lib/model-catalog.mjs';
import { initializeState } from '../../scripts/lib/state.mjs';
import { registerSession, issueWorkspaceGrant, applyWorkspaceGrant } from '../../scripts/lib/workspace.mjs';
import { validateSettings, SETTING_DEFAULTS } from '../../scripts/lib/workspace-settings.mjs';
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
  const env={...process.env,FABEX_HOME:join(dir,'private')};
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
