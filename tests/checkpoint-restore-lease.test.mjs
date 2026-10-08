import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm,realpath,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {TerminalSessionStore} from '../src/main/services/TerminalSessionStore.ts';
import {EnvironmentRegistry} from '../src/main/services/EnvironmentRegistry.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function fixture(t,{supported=true,ui=true}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ctty-restore-lease-'))),other=join(root,'other'),project=join(root,'project');await mkdir(other);await mkdir(project);
 const paused=new Set(),events=[],calls=[],writes=[];let failPause=false,failResume=false;
 const pause={supported,isPaused:p=>paused.has(p),pause(p){paused.add(p);events.push(['pause',p.pid]);return{supported, ...(failPause?{failed:'partial suspension'}:{})};},resume(p){events.push(['resume',p.pid]);if(failResume)return{supported,failed:'resume failure'};paused.delete(p);return{supported};}};
 const terminal=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,ui,fakeSpawner(calls,{onWrite:value=>writes.push(value)}),pause);
 const create=(cwd=project)=>{const row=terminal.create({provider:'codex',profile:'normal',cwd,position:{x:0,y:0}});terminal.resize(row.id,80,24);return row;};
 const idle=id=>terminal.applyProviderSignal(id,{kind:'lifecycle',state:'idle',event:'SessionStart'});
 t.after(async()=>{terminal.disposeAll();await rm(root,{recursive:true,force:true});});
 return{root,terminal,project,other,create,idle,calls,writes,paused,events,pause,failPause:()=>{failPause=true;},failResume:()=>{failResume=true;}};
}

test('restore excludes all input, launches, restart and lifecycle for affected owned sessions; unrelated close and deferred target close remain safe',async t=>{
 const f=await fixture(t),a=f.create(),b=f.create(),other=f.create(f.other);f.idle(a.id);f.idle(b.id);
 const entered=deferred(),release=deferred();const restore=f.terminal.withCheckpointRestore(a.id,async cwd=>{assert.equal(cwd,f.project);entered.resolve();await release.promise;return 7;});await entered.promise;
 assert.equal(f.paused.size,2);for(const value of ['hello','\r','\x03'])assert.equal(f.terminal.inputChecked(a.id,value),false);
 f.terminal.input(b.id,'new\r');assert.equal((await f.terminal.deliverInput(a.id,'controlled\r',50)).delivered,false);assert.deepEqual(f.writes,[]);
 assert.throws(()=>f.create(),/restoration/);assert.throws(()=>f.terminal.restart(a.id),/restoration/);
 await assert.rejects(f.terminal.stopSubagentPtyForRetry(a.id),/restoration/);
 assert.equal(f.terminal.applyProviderSignal(a.id,{state:'working'}),false);
 f.terminal.dispose(other.id);assert.equal(f.terminal.getMetadata(other.id),null);
 f.terminal.dispose(a.id);assert.ok(f.terminal.getMetadata(a.id),'close is deferred, without killing protected PTY');
 release.resolve();assert.equal(await restore,7);assert.equal(f.paused.size,0);assert.equal(f.terminal.getMetadata(a.id),null);
 assert.equal(f.terminal.inputChecked(b.id,'next\r'),true);
});

for(const state of ['working','needs_approval','unobserved','submitted'])test(`restore rejects ${state} with lifecycle UI disabled`,async t=>{
 const f=await fixture(t,{ui:false}),a=f.create();
 if(state!=='unobserved')f.terminal.applyProviderSignal(a.id,{state:state==='submitted'?'idle':state});
 if(state==='submitted')assert.equal(f.terminal.inputChecked(a.id,'new\r'),true);
 assert.equal(f.terminal.getMetadata(a.id).status,'unavailable');let ran=false;
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>{ran=true;}),/observed agent idle/);assert.equal(ran,false);assert.equal(f.events.length,0);
});

test('Windows live restore refuses rather than pretending input gating suspends a process',async t=>{
 const f=await fixture(t,{supported:false}),a=f.create();f.idle(a.id);
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>assert.fail()),/cannot safely suspend/);assert.equal(f.events.length,0);
});

test('pending environment preparation prevents restore before an effective cwd exists',async t=>{
 const f=await fixture(t),a=f.create(),other=f.create(f.other);f.idle(a.id);
 const task=deferred();f.terminal.sessions.get(other.id).launchTasks=new Set([task.promise]);
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>assert.fail()),/pending agent launches/);
 task.resolve();f.terminal.sessions.get(other.id).launchTasks.clear();
});

test('existing budget pause stays owned; clearing budget during restore defers resume until transaction ends',async t=>{
 const f=await fixture(t),a=f.create();f.idle(a.id);f.terminal.setBudgetPaused(a.id,true);
 await f.terminal.withCheckpointRestore(a.id,async()=>{});assert.equal(f.paused.size,1);assert.equal(f.events.filter(([type])=>type==='resume').length,0);
 await f.terminal.withCheckpointRestore(a.id,async()=>{f.terminal.setBudgetPaused(a.id,false);assert.equal(f.paused.size,1);assert.equal(f.terminal.inputChecked(a.id,'x'),false);});assert.equal(f.paused.size,0);
});

test('partial pause failure resumes acquired ownership; failed transaction and natural exit do not resume descendants early',async t=>{
 const f=await fixture(t),a=f.create();f.idle(a.id);f.failPause();
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>assert.fail()),/partial suspension/);assert.equal(f.paused.size,0);
 const g=await fixture(t),b=g.create();g.idle(b.id);g.terminal.setBudgetPaused(b.id,true);
 await assert.rejects(g.terminal.withCheckpointRestore(b.id,async()=>{g.calls[0].process.emitExit(0);assert.equal(g.paused.size,1);throw new Error('restore failed');}),/restore failed/);assert.equal(g.paused.size,0);
});

test('failed resume keeps budget input gate, with neutral diagnostic even when restore failed',async t=>{
 const f=await fixture(t),a=f.create();f.idle(a.id);f.failResume();
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>{throw new Error('git failed');}),error=>/remains budget-paused/.test(error.message)&&!/Files were restored/.test(error.message));
 assert.equal(f.terminal.isBudgetPaused(a.id),true);assert.equal(f.terminal.inputChecked(a.id,'x'),false);
});

test('shutdown drains a protected transaction before disposing sessions',async t=>{
 const f=await fixture(t),a=f.create();f.idle(a.id);const entered=deferred(),release=deferred();
 const restore=f.terminal.withCheckpointRestore(a.id,async()=>{entered.resolve();await release.promise;});await entered.promise;
 const shutdown=f.terminal.shutdown();assert.ok(f.terminal.getMetadata(a.id));release.resolve();await restore;await shutdown;assert.equal(f.terminal.getMetadata(a.id),null);
});

 test('missing unrelated exited folder does not prevent restoring a valid owned workspace',async t=>{
 const f=await fixture(t),a=f.create(),other=f.create(f.other);f.idle(a.id);f.calls[1].process.emitExit(0);await rm(f.other,{recursive:true});let restored=false;
 await f.terminal.withCheckpointRestore(a.id,async()=>{restored=true;});assert.equal(restored,true);
 });

async function environmentFixture(t,{isolated=true,relocate=false,kind='box',flipDuringWrap=false,removeProjectDuringWrap=false,persist=false}={}) {
 const f=await fixture(t),provider={pluginId:'fixture.environment',pluginName:'Environment',serviceId:'environment',secrets:false,kinds:[{kind,label:'Fixture',keeps:{launch:true,...(isolated===null?{}:{isolated})}}]};
 let providers=[provider],resumeFailure=false;
 if(persist)f.terminal.configureSessionPersistence(new TerminalSessionStore(f.root),"continue");
 const registry=new EnvironmentRegistry({providers:()=>providers,secret:async()=>null,call:async(_plugin,_service,method,params)=>{
  if(method.endsWith('.prepare'))return{ref:{id:'fixture'},label:'Fixture',...(relocate?{cwd:f.other}:{})};
  if(method.endsWith('.wrap')){if(removeProjectDuringWrap)await rm(f.project,{recursive:true});if(flipDuringWrap)provider.kinds[0].keeps.isolated=false;return{command:process.execPath,args:['fake-environment'],cwd:f.other};}
  if(method.endsWith('.resume'))return resumeFailure?{refuse:{reason:'fixture resume refused'}}:{ok:true};
  return{};
 }});
 f.terminal.configureEnvironments(registry);
 const launched=f.terminal.create({provider:'codex',profile:'normal',cwd:f.project,position:{x:0,y:0},environment:{pluginId:provider.pluginId,kind}});
 await Promise.all([...f.terminal.sessions.get(launched.id).launchTasks]);
 assert.equal(f.calls.length,1);assert.equal(f.terminal.getMetadata(launched.id).exitCode,null);f.idle(launched.id);
 return{...f,launched,provider,registry,failEnvironmentResume:()=>{resumeFailure=true;},remove:()=>{providers=[];}};
}

for(const mutation of ['unchanged','flip','remove','during-wrap'])test(`isolated launch rejects restoration before pause or Git, retaining its original declaration (${mutation})`,{timeout:5000},async t=>{
 const f=await environmentFixture(t,{flipDuringWrap:mutation==='during-wrap'});
 if(mutation==='flip')f.provider.kinds[0].keeps.isolated=false;
 if(mutation==='remove')f.remove();
 let mutated=false;
 await assert.rejects(f.terminal.withCheckpointRestore(f.launched.id,async()=>{mutated=true;}),/isolated environment.*local wrapper/);
 assert.equal(mutated,false);assert.deepEqual(f.events,[]);
});

test('isolated sibling original project cannot be hidden by prepared and wrapper cwd; distinct verified projects remain usable',{timeout:5000},async t=>{
 const f=await environmentFixture(t,{relocate:true}),sibling=f.create();f.idle(sibling.id);
 assert.equal(f.terminal.getMetadata(f.launched.id).cwd,f.other);
 await assert.rejects(f.terminal.withCheckpointRestore(sibling.id,async()=>assert.fail()),/isolated environment/);assert.deepEqual(f.events,[]);
 const distinct=join(f.root,'distinct');await mkdir(distinct);const local=f.create(distinct);f.idle(local.id);let restored=false;
 await f.terminal.withCheckpointRestore(local.id,async()=>{restored=true;});assert.equal(restored,true);
});

test('isolated scope survives wrapper exit and same-card local restart',{timeout:5000},async t=>{
 const f=await environmentFixture(t);f.calls[0].process.emitExit(0);f.events.length=0;
 await assert.rejects(f.terminal.withCheckpointRestore(f.launched.id,async()=>assert.fail()),/does not prove/);assert.deepEqual(f.events,[]);
 f.provider.kinds[0].keeps.isolated=false;f.terminal.restart(f.launched.id);await Promise.all([...f.terminal.sessions.get(f.launched.id).launchTasks]);f.idle(f.launched.id);
 await assert.rejects(f.terminal.withCheckpointRestore(f.launched.id,async()=>assert.fail()),/isolated environment/);

});

for(const isolated of [false,null])test(`local worktree environment retains restore support (${isolated===false?'explicit local':'undeclared isolated'})`,{timeout:5000},async t=>{
 const f=await environmentFixture(t,{isolated,kind:'worktree'});let restored=false;
 await f.terminal.withCheckpointRestore(f.launched.id,async()=>{restored=true;assert.equal(f.paused.size,1);});assert.equal(restored,true);assert.equal(f.paused.size,0);
});

test('unverifiable isolated launch scope refuses restoration rather than assuming a distinct project',{timeout:5000},async t=>{
 const f=await environmentFixture(t,{removeProjectDuringWrap:true});const distinct=join(f.root,'distinct');await mkdir(distinct);const local=f.create(distinct);f.idle(local.id);
 await assert.rejects(f.terminal.withCheckpointRestore(local.id,async()=>assert.fail()),/isolated environment/);assert.deepEqual(f.events,[]);
});

for(const condition of ['plugin-removed','resume-failed','declaration-changed','stopped'])test(`isolated launch evidence survives disk reload into a new manager (${condition})`,{timeout:5000},async t=>{
 const f=await environmentFixture(t,{persist:true,relocate:true});
 if(condition==='stopped')f.calls[0].process.emitExit(0);
 await f.terminal.shutdown();
 const stored=JSON.parse(await readFile(join(f.root,'terminal-sessions.json'),'utf8'));
 assert.ok(stored.sessions[0].isolatedEnvironmentScopes.roots.includes(f.project));
 assert.equal(f.terminal.getMetadata(f.launched.id),null);
 if(condition==='declaration-changed')f.provider.kinds[0].keeps.isolated=false;
 if(condition==='resume-failed')f.failEnvironmentResume();
 const calls=[],manager=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls),f.pause);
 t.after(()=>manager.disposeAll());
 if(condition!=='plugin-removed')manager.configureEnvironments(f.registry);
 manager.configureSessionPersistence(new TerminalSessionStore(f.root),'continue');await manager.restorePersistedSessions();
 await Promise.all([...manager.sessions.get(f.launched.id).launchTasks??[]]);
 assert.ok(manager.getMetadata(f.launched.id));assert.equal('isolatedEnvironmentScopes' in manager.getMetadata(f.launched.id),false,'history remains host-only');
 const local=manager.create({provider:'codex',profile:'normal',cwd:f.project,position:{x:0,y:0}});manager.applyProviderSignal(local.id,{state:'idle'});f.events.length=0;
 await assert.rejects(manager.withCheckpointRestore(local.id,async()=>assert.fail()),/isolated environment/);assert.deepEqual(f.events,[]);
 await manager.shutdown();const again=await new TerminalSessionStore(f.root).load();assert.deepEqual(again.find(row=>row.id===f.launched.id).isolatedEnvironmentScopes,stored.sessions[0].isolatedEnvironmentScopes);
});

for(const evidence of [undefined,null,{roots:['relative'],ambiguous:false},{roots:['/absolute'],ambiguous:'no'},{roots:Array.from({length:33},(_,i)=>'/'+i),ambiguous:false}])test(`legacy or malformed isolation evidence restores as unknown rather than losing the card (${JSON.stringify(evidence)})`,{timeout:5000},async t=>{
 const f=await environmentFixture(t,{persist:true});await f.terminal.shutdown();const file=join(f.root,'terminal-sessions.json'),saved=JSON.parse(await readFile(file,'utf8'));
 if(evidence===undefined)delete saved.sessions[0].isolatedEnvironmentScopes;else saved.sessions[0].isolatedEnvironmentScopes=evidence;
 await writeFile(file,JSON.stringify(saved));
 const manager=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner([]),f.pause);t.after(()=>manager.disposeAll());manager.configureSessionPersistence(new TerminalSessionStore(f.root),'continue');await manager.restorePersistedSessions();
 assert.ok(manager.getMetadata(f.launched.id));const persisted=await new TerminalSessionStore(f.root).load();assert.deepEqual(persisted[0].isolatedEnvironmentScopes,{roots:[],ambiguous:true});
 await assert.rejects(manager.withCheckpointRestore(f.launched.id,async()=>assert.fail()),/isolated environment/);await manager.shutdown();
});

test('verified local environment persists explicit empty isolation history and remains restorable after reload',{timeout:5000},async t=>{
 const f=await environmentFixture(t,{persist:true,isolated:false,kind:'worktree'});await f.terminal.shutdown();
 const manager=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner([]),f.pause);t.after(()=>manager.disposeAll());manager.configureEnvironments(f.registry);manager.configureSessionPersistence(new TerminalSessionStore(f.root),'continue');await manager.restorePersistedSessions();await Promise.all([...manager.sessions.get(f.launched.id).launchTasks??[]]);manager.applyProviderSignal(f.launched.id,{state:'idle'});
 await manager.withCheckpointRestore(f.launched.id,async()=>{});await manager.shutdown();
});
