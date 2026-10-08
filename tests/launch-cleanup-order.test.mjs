import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {LaunchPipeline} from '../src/main/services/LaunchPipeline.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(t,{rejectChild=false}={}){
 const root=await mkdtemp(join(tmpdir(),'ctty-cleanup-order-'));
 const runs=join(root,'runs'),rows=[],calls=[],events=[],spawned=[deferred(),deferred()],forgotten=deferred();
 const pipeline=new LaunchPipeline({
  contributors:()=>[{pluginId:'fixture.cleanup',pluginName:'Cleanup fixture',serviceId:'launch',secrets:false,
   launch:{fields:[{key:'enabled',label:'Enabled',kind:'boolean',default:true}]}}],
  call:async()=>({env:{FIXTURE_FILE:'{launchFiles}/run.txt'},files:[{relPath:'run.txt',content:'temporary launch data'}]}),
  secret:async()=>null,runsRoot:runs,timeoutMs:2000
 });
 const prepare=pipeline.prepare.bind(pipeline),forget=pipeline.forgetSession.bind(pipeline);
 pipeline.prepare=async context=>{
  const contribution=await prepare(context);assert.equal(contribution.ok,true);
  const cleanup=contribution.cleanup,index=rows.length,row={started:deferred(),release:deferred(),calls:0};rows.push(row);
  contribution.cleanup=async()=>{
   row.calls++;events.push(`child${index}:start`);row.started.resolve();
   try{await row.release.promise;if(rejectChild)throw new Error('fixture child cleanup failure');await cleanup();}
   finally{events.push(`child${index}:settled`);}
  };
  return contribution;
 };
 let forgetCalls=0;
 pipeline.forgetSession=id=>{
  forgetCalls++;events.push('parent:start');
  const pending=forget(id).then(()=>{events.push('parent:done');});forgotten.resolve(pending);return pending;
 };
 const fake=fakeSpawner(calls);
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,(...args)=>{
  const pty=fake(...args);spawned[calls.length-1]?.resolve();return pty;
 });
 terminals.configureLaunchPipeline(pipeline);
 t.after(async()=>{for(const row of rows)row.release.resolve();terminals.disposeAll();await forgotten.promise;await rm(root,{recursive:true,force:true});});
 const session=terminals.create({provider:'codex',profile:'normal',cwd:root,position:{x:0,y:0},launchOptions:{'fixture.cleanup':{enabled:true}}});
 await spawned[0].promise;
 return {root,runs,rows,calls,events,spawned,forgotten,terminals,session,forgetCalls:()=>forgetCalls};
}

for(const exited of [false,true])for(const rejectChild of [false,true])test(`parent launch cleanup waits for ${exited?'previous exit':'active disposal'} cleanup (${rejectChild?'rejection':'success'})`,{timeout:5000},async t=>{
 const f=await fixture(t,{rejectChild});
 if(exited)f.calls[0].process.emitExit(1);
 f.terminals.dispose(f.session.id);f.terminals.dispose(f.session.id);
 await f.rows[0].started.promise;
 assert.equal(f.forgetCalls(),0,'parent removal must not overlap a held child removal');
 assert.deepEqual(f.events,['child0:start']);
 f.rows[0].release.resolve();await f.forgotten.promise;
 assert.deepEqual(f.events,['child0:start','child0:settled','parent:start','parent:done']);
 assert.equal(f.rows[0].calls,1);assert.equal(f.forgetCalls(),1,'disposal remains idempotent');
 await assert.rejects(stat(join(f.runs,f.session.id)),{code:'ENOENT'},'parent still cleaned after child failure');
});

test('restart retains every pending run cleanup and invokes each captured callback once before forgetting the card',{timeout:5000},async t=>{
 const f=await fixture(t);
 f.calls[0].process.emitExit(1);await f.rows[0].started.promise;
 f.terminals.restart(f.session.id);await f.spawned[1].promise;
 assert.equal(f.rows.length,2);
 f.terminals.dispose(f.session.id);
 assert.equal(f.rows[1].calls,0,'the newer cleanup queues behind the old launch callback');
 assert.equal(f.forgetCalls(),0);
 // A late notification from the old PTY must neither consume nor overwrite the new launch cleanup.
 f.calls[0].process.emitExit(1);
 f.rows[0].release.resolve();await f.rows[1].started.promise;
 assert.equal(f.forgetCalls(),0,'parent waits for both run directories');
 f.rows[1].release.resolve();await f.forgotten.promise;
 assert.deepEqual(f.events,['child0:start','child0:settled','child1:start','child1:settled','parent:start','parent:done']);
 assert.deepEqual(f.rows.map(row=>row.calls),[1,1]);assert.equal(f.forgetCalls(),1);
 await assert.rejects(stat(join(f.runs,f.session.id)),{code:'ENOENT'});
});
