import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {LaunchPipeline} from '../src/main/services/LaunchPipeline.ts';
import {createDiffOnlyReviewWorkspace} from '../src/main/services/DiffOnlyReviewWorkspace.ts';
import {EnvironmentRegistry} from '../src/main/services/EnvironmentRegistry.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(t,{spawnFailure=false}={}){
 const root=await mkdtemp(join(tmpdir(),'ctty-launch-files-')),runs=join(root,'runs'),calls=[],pipelines=[],gates=[],disposals=[];
 const fake=fakeSpawner(calls);
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,(...args)=>{
  if(spawnFailure)throw new Error('fixture PTY spawn failure');return fake(...args);
 });
 const forget=terminals.forgetLaunchFiles.bind(terminals);
 terminals.forgetLaunchFiles=session=>{const pending=forget(session);disposals.push(pending);return pending;};
 const gate=()=>{const result=deferred();gates.push(result);return result;};
 function pipeline({holdPrepare=false,holdForget=false,failCleanup=false}={}){
  const started=deferred(),release=gate(),forgetStarted=deferred(),forgetRelease=gate(),events=[],rows=[];
  if(!holdPrepare)release.resolve();if(!holdForget)forgetRelease.resolve();
  const value=new LaunchPipeline({
   contributors:()=>[{pluginId:'fixture.files',pluginName:'Files',serviceId:'launch',secrets:false,
    launch:{fields:[{key:'enabled',label:'Enabled',kind:'boolean'}]}}],
   call:async()=>{started.resolve();await release.promise;return {env:{FIXTURE_FILE:'{launchFiles}/run.txt'},files:[{relPath:'run.txt',content:'temporary'}]};},
   secret:async()=>null,runsRoot:runs,timeoutMs:4000
  });
  const prepare=value.prepare.bind(value),remove=value.forgetSession.bind(value);
  value.prepare=async context=>{
   const result=await prepare(context);assert.equal(result.ok,true);
   const row={file:result.env.FIXTURE_FILE,cleanupCalls:0},cleanup=result.cleanup;rows.push(row);
   result.cleanup=async()=>{row.cleanupCalls++;events.push('child');if(failCleanup)throw new Error('fixture cleanup failure');await cleanup();};
   return result;
  };
  value.forgetSession=async id=>{events.push('parent:start');forgetStarted.resolve();await forgetRelease.promise;await remove(id);events.push('parent:done');};
  const result={value,started,release,forgetStarted,forgetRelease,events,rows};pipelines.push(result);return result;
 }
 const create=(extra={})=>terminals.create({provider:'codex',profile:'normal',cwd:root,position:{x:0,y:0},launchOptions:{'fixture.files':{enabled:true}},...extra});
 const drain=async()=>{await Promise.allSettled(disposals);};
 t.after(async()=>{for(const item of gates)item.resolve();terminals.disposeAll();await drain();await rm(root,{recursive:true,force:true});});
 return {root,runs,calls,terminals,pipeline,create,gate,drain,disposals};
}

for(const failCleanup of [false,true])test(`closing during preparation drains its late files before parent deletion (${failCleanup?'failed':'successful'} child cleanup)`,{timeout:5000},async t=>{
 const f=await fixture(t),p=f.pipeline({holdPrepare:true,failCleanup});f.terminals.configureLaunchPipeline(p.value);
 const session=f.create();await p.started.promise;
 f.terminals.dispose(session.id);assert.deepEqual(p.events,[]);
 p.release.resolve();await f.drain();
 assert.deepEqual(p.events,['child','parent:start','parent:done']);assert.equal(p.rows[0].cleanupCalls,1);assert.equal(f.calls.length,0);
 await assert.rejects(stat(join(f.runs,session.id)),{code:'ENOENT'});
});

test('restart tracks both pending preparations and sequentially forgets their original pipelines after reconfiguration',{timeout:5000},async t=>{
 const f=await fixture(t),a=f.pipeline({holdPrepare:true,holdForget:true}),b=f.pipeline({holdPrepare:true}),c=f.pipeline();
 f.terminals.configureLaunchPipeline(a.value);const session=f.create();await a.started.promise;
 // Force a restart while its original plugin response is still in flight, as restoration can do.
 const internal=f.terminals.sessions.get(session.id);internal.metadata.status='failed';internal.metadata.exitCode=1;
 f.terminals.configureLaunchPipeline(b.value);f.terminals.restart(session.id);await b.started.promise;
 f.terminals.configureLaunchPipeline(c.value);f.terminals.dispose(session.id);
 a.release.resolve();await Promise.resolve();assert.deepEqual(a.events,[],'parent cannot precede pending preparation');
 b.release.resolve();await a.forgetStarted.promise;
 assert.deepEqual(a.events,['child','parent:start']);assert.deepEqual(b.events,['child'],'same parent cannot be removed concurrently by another pipeline');
 assert.deepEqual(c.events,[],'current configuration is not the owner');
 a.forgetRelease.resolve();await f.drain();
 assert.deepEqual(b.events,['child','parent:start','parent:done']);assert.deepEqual([a.rows[0].cleanupCalls,b.rows[0].cleanupCalls],[1,1]);
 assert.equal(f.calls.length,0);await assert.rejects(stat(join(f.runs,session.id)),{code:'ENOENT'});
});

for(const outcome of ['success','refusal','throw'])test(`close while environment wrapping ${outcome} releases planned capability and files once`,{timeout:5000},async t=>{
 const f=await fixture(t),p=f.pipeline();f.terminals.configureLaunchPipeline(p.value);
 const wrapping=deferred(),release=f.gate();let plannedCleanups=0;
 const plan=f.terminals.planSpawn.bind(f.terminals);
 f.terminals.planSpawn=(...args)=>{const result=plan(...args);assert.ok(!('failure' in result));const cleanup=result.cleanup;result.cleanup=()=>{plannedCleanups++;cleanup();};return result;};
 const registry=new EnvironmentRegistry({providers:()=>[{pluginId:'fixture.env',pluginName:'Environment',serviceId:'env',secrets:false,kinds:[{kind:'test',label:'Test',fields:[]}]}],
  call:async(_p,_s,method)=>method.endsWith('.prepare')?{ref:{id:'one'},label:'Test'}:{},secret:async()=>null});
 registry.wrap=async(_environment,input)=>{
  wrapping.resolve();await release.promise;
  if(outcome==='throw')throw new Error('fixture wrapper threw');
  if(outcome==='refusal')return {ok:false,reason:'fixture refused'};
  return {ok:true,...input.launch,secrets:[]};
 };
 f.terminals.configureEnvironments(registry);
 const session=f.create({environment:{pluginId:'fixture.env',kind:'test'}});await wrapping.promise;
 await stat(p.rows[0].file);f.terminals.dispose(session.id);assert.deepEqual(p.events,[]);
 release.resolve();await f.drain();
 assert.equal(plannedCleanups,1);assert.equal(p.rows[0].cleanupCalls,1);assert.equal(f.calls.length,0);
 assert.deepEqual(p.events,['child','parent:start','parent:done']);await assert.rejects(stat(join(f.runs,session.id)),{code:'ENOENT'});
});

test('closing a budget-paused prepared launch wakes its waiter before draining files',{timeout:5000},async t=>{
 const f=await fixture(t),p=f.pipeline({holdPrepare:true});f.terminals.configureLaunchPipeline(p.value);
 const session=f.create();await p.started.promise;
 const waiting=deferred(),wait=f.terminals.awaitBudgetResume.bind(f.terminals);
 f.terminals.awaitBudgetResume=async internal=>{waiting.resolve();return wait(internal);};
 f.terminals.budgetPausedTaskRoots.add(session.id);p.release.resolve();await waiting.promise;
 f.terminals.dispose(session.id);await f.drain();
 assert.equal(p.rows[0].cleanupCalls,1);assert.equal(f.calls.length,0);await assert.rejects(stat(join(f.runs,session.id)),{code:'ENOENT'});
});

test('spawn refusal releases unadopted files and capabilities before eventual parent cleanup',{timeout:5000},async t=>{
 const f=await fixture(t,{spawnFailure:true}),p=f.pipeline();f.terminals.configureLaunchPipeline(p.value);
 let cleanups=0;const plan=f.terminals.planSpawn.bind(f.terminals);
 f.terminals.planSpawn=(...args)=>{const result=plan(...args),cleanup=result.cleanup;result.cleanup=()=>{cleanups++;cleanup();};return result;};
 const session=f.create(),internal=f.terminals.sessions.get(session.id);
 await Promise.all([...internal.launchTasks]);assert.equal(internal.metadata.status,'failed');
 assert.equal(cleanups,1);assert.equal(p.rows[0].cleanupCalls,1);assert.deepEqual(p.events,['child']);
 f.terminals.dispose(session.id);await f.drain();assert.deepEqual(p.events,['child','parent:start','parent:done']);
 await assert.rejects(stat(join(f.runs,session.id)),{code:'ENOENT'});
});

for(const failure of ['none','prepare','cleanup'])test(`unadopted reviewer account retains its originating pipeline through reconfiguration (${failure})`,{timeout:5000},async t=>{
 const f=await fixture(t),started=deferred(),release=f.gate(),events=[];
 const parent=f.terminals.create({provider:'codex',profile:'normal',cwd:f.root,role:'orchestrator',position:{x:0,y:0}});
 const workspace=createDiffOnlyReviewWorkspace('+fixture');t.after(()=>workspace.cleanup());
 const pipeline=new LaunchPipeline({
  contributors:()=>[{pluginId:'canvastty-accounts',pluginName:'Accounts',serviceId:'accounts',secrets:false,
   launch:{fields:[{key:'account',label:'Account',kind:'text'}],delegable:true}}],
  call:async()=>{started.resolve();await release.promise;return {env:{FIXTURE_FILE:'{launchFiles}/account.txt'},files:[{relPath:'account.txt',content:'temporary account config'}]};},
  secret:async()=>null,runsRoot:f.runs,timeoutMs:4000
 });
 const prepare=pipeline.prepare.bind(pipeline),forget=pipeline.forgetSession.bind(pipeline);let preparedId;
 pipeline.prepare=async context=>{
  preparedId=context.sessionId;const result=await prepare(context);assert.equal(result.ok,true);
  if(failure==='prepare')throw new Error('fixture failed after file creation');
  const cleanup=result.cleanup;result.cleanup=async()=>{events.push('child');if(failure==='cleanup')throw new Error('fixture child failure');await cleanup();};return result;
 };
 pipeline.forgetSession=async id=>{events.push('parent');await forget(id);};
 f.terminals.configureLaunchPipeline(pipeline);
 const preparing=f.terminals.prepareReviewerAccount({taskRootSessionId:parent.id,provider:'codex',workspace,launchOptions:{'canvastty-accounts':{account:'fixture'}}});
 await started.promise;
 const other=f.pipeline();f.terminals.configureLaunchPipeline(other.value);f.terminals.dispose(parent.id);
 release.resolve();
 if(failure==='prepare')await assert.rejects(preparing,/fixture failed/u);
 else {
  const prepared=await preparing;await stat(prepared.contribution.env.FIXTURE_FILE);
  const first=prepared.contribution.cleanup(),second=prepared.contribution.cleanup();assert.equal(first,second,'one cleanup ownership handle');
  if(failure==='cleanup')await assert.rejects(first,/fixture child failure/u);else await first;
 }
 assert.deepEqual(events,failure==='prepare'?['parent']:['child','parent']);assert.deepEqual(other.events,[]);
 await assert.rejects(stat(join(f.runs,preparedId)),{code:'ENOENT'});await f.drain();
});
