// TerminalManager.withCheckpointRestore: a rollback point restore never runs under a live card of its folder, holds
// the folder's cards while Git restores, and refuses related isolated environments (docs/plugins.md).
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
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const waitFor=async(predicate,timeoutMs=3000)=>{const end=Date.now()+timeoutMs;while(!predicate()){if(Date.now()>end)throw new Error('timed out');await new Promise(r=>setTimeout(r,5));}};
const code=expected=>error=>error.code===expected;

async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ctty-restore-lease-'))),other=join(root,'other'),project=join(root,'project');await mkdir(other);await mkdir(project);
 const calls=[],writes=[];
 const terminal=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls,{onWrite:value=>writes.push(value)}));
 const create=(cwd=project,provider='codex')=>{const row=terminal.create({provider,profile:'normal',cwd,position:{x:0,y:0}});terminal.resize(row.id,80,24);return row;};
 const exit=row=>calls.find(call=>call.options.cwd===terminal.getMetadata(row.id)?.cwd&&!call.exited&&(call.exited=true))?.process.emitExit(0);
 t.after(async()=>{terminal.disposeAll();await rm(root,{recursive:true,force:true});});
 return{root,terminal,project,other,create,calls,writes,exit};
}

test('restore is refused while any card of the folder still runs; a card elsewhere does not block it',async t=>{
 const f=await fixture(t),a=f.create(),b=f.create(),elsewhere=f.create(f.other);let ran=false;
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>{ran=true;}),code('agent-running'));
 f.calls[0].process.emitExit(0);
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>{ran=true;}),code('agent-running'),'a sibling card in the same folder still runs');
 f.calls[1].process.emitExit(0);
 assert.equal(f.terminal.getMetadata(elsewhere.id).exitCode,null);
 assert.equal(await f.terminal.withCheckpointRestore(a.id,async cwd=>{assert.equal(cwd,f.project);ran=true;return 7;}),7);
 assert.equal(ran,true);
 assert.equal(f.terminal.getMetadata(b.id).exitCode,0);
});

test('while it restores: no input, launch or restart in the folder, closes wait; other folders work',async t=>{
 const f=await fixture(t),a=f.create(),b=f.create(),other=f.create(f.other);
 f.calls[0].process.emitExit(0);f.calls[1].process.emitExit(0);
 const entered=deferred(),release=deferred();
 const restore=f.terminal.withCheckpointRestore(a.id,async()=>{entered.resolve();await release.promise;});await entered.promise;
 assert.equal(f.terminal.isCheckpointRestoreActive(a.id),true);
 assert.equal(f.terminal.inputChecked(a.id,'x'),false);
 assert.throws(()=>f.create(),/restoration is in progress/);
 assert.throws(()=>f.create(join(f.project,'..')),/restoration is in progress/,'a folder above the restored one is refused too');
 assert.throws(()=>f.terminal.restart(a.id),/restoration is in progress/);
 await assert.rejects(f.terminal.withCheckpointRestore(b.id,async()=>assert.fail()),code('restore-in-progress'));
 const elsewhere=f.create(f.other);assert.ok(elsewhere.id,'another folder still launches');
 assert.equal(f.terminal.inputChecked(other.id,'next\r'),true);
 f.terminal.dispose(b.id);assert.ok(f.terminal.getMetadata(b.id),'the close waits for the restore');
 release.resolve();await restore;
 assert.equal(f.terminal.getMetadata(b.id),null,'the deferred close ran');
 assert.equal(f.terminal.isCheckpointRestoreActive(a.id),false);
 f.terminal.restart(a.id);assert.equal(f.terminal.getMetadata(a.id).exitCode,null);
});

test('a plugin launch still preparing refuses the restore, and a restore refuses plugin launches',async t=>{
 const f=await fixture(t),a=f.create();f.calls[0].process.emitExit(0);
 const wrap=deferred();
 const registry=new EnvironmentRegistry({providers:()=>[{pluginId:'fixture.env',pluginName:'Env',serviceId:'env',secrets:false,kinds:[{kind:'box',label:'Box',keeps:{launch:true}}]}],
  secret:async()=>null,call:async(_p,_s,method)=>{if(method.endsWith('.prepare'))return{ref:{id:'x'},label:'Box'};if(method.endsWith('.wrap')){await wrap.promise;return{command:process.execPath,args:[]};}return{};}});
 f.terminal.configureEnvironments(registry);
 const placed=f.terminal.create({provider:'codex',profile:'normal',cwd:f.other,position:{x:0,y:0},environment:{pluginId:'fixture.env',kind:'box'}});
 await tick();
 await assert.rejects(f.terminal.withCheckpointRestore(a.id,async()=>assert.fail()),code('pending-launch'));
 wrap.resolve();await waitFor(()=>f.terminal.getMetadata(placed.id)?.exitCode===null&&f.calls.length===2);
 f.calls[1].process.emitExit(0);await tick();
 const entered=deferred(),release=deferred();
 const restore=f.terminal.withCheckpointRestore(a.id,async()=>{entered.resolve();await release.promise;});await entered.promise;
 assert.throws(()=>f.terminal.create({provider:'codex',profile:'normal',cwd:f.other,position:{x:0,y:0},environment:{pluginId:'fixture.env',kind:'box'}}),/restoration is in progress/);
 release.resolve();await restore;
});

test('shutdown waits for a running restore before it disposes the cards',async t=>{
 const f=await fixture(t),a=f.create();f.calls[0].process.emitExit(0);const entered=deferred(),release=deferred();
 const restore=f.terminal.withCheckpointRestore(a.id,async()=>{entered.resolve();await release.promise;});await entered.promise;
 const shutdown=f.terminal.shutdown();await tick();assert.ok(f.terminal.getMetadata(a.id));release.resolve();await restore;await shutdown;assert.equal(f.terminal.getMetadata(a.id),null);
});

test('a missing folder of an unrelated exited card does not prevent the restore',async t=>{
 const f=await fixture(t),a=f.create();f.create(f.other);f.calls[0].process.emitExit(0);f.calls[1].process.emitExit(0);await rm(f.other,{recursive:true});let restored=false;
 await f.terminal.withCheckpointRestore(a.id,async()=>{restored=true;});assert.equal(restored,true);
});

async function environmentFixture(t,{isolated=true,relocate=false,kind='box',removeProjectDuringWrap=false,persist=false}={}){
 const f=await fixture(t),provider={pluginId:'fixture.environment',pluginName:'Environment',serviceId:'environment',secrets:false,kinds:[{kind,label:'Fixture',keeps:{launch:true,...(isolated===null?{}:{isolated})}}]};
 let providers=[provider];
 if(persist)f.terminal.configureSessionPersistence(new TerminalSessionStore(f.root),'continue');
 const registry=new EnvironmentRegistry({providers:()=>providers,secret:async()=>null,call:async(_plugin,_service,method)=>{
  if(method.endsWith('.prepare'))return{ref:{id:'fixture'},label:'Fixture',...(relocate?{cwd:f.other}:{})};
  if(method.endsWith('.wrap')){if(removeProjectDuringWrap)await rm(f.project,{recursive:true});return{command:process.execPath,args:['fake-environment'],cwd:f.other};}
  if(method.endsWith('.resume'))return{ok:true};
  return{};
 }});
 f.terminal.configureEnvironments(registry);
 const launched=f.terminal.create({provider:'codex',profile:'normal',cwd:f.project,position:{x:0,y:0},environment:{pluginId:provider.pluginId,kind}});
 await waitFor(()=>f.calls.length===1);
 return{...f,launched,provider,registry,remove:()=>{providers=[];}};
}

for(const mutation of ['unchanged','flip','remove'])test(`an isolated environment refuses the restore even after its wrapper exited (${mutation})`,{timeout:5000},async t=>{
 const f=await environmentFixture(t);f.calls[0].process.emitExit(0);
 if(mutation==='flip')f.provider.kinds[0].keeps.isolated=false;
 if(mutation==='remove')f.remove();
 let ran=false;
 await assert.rejects(f.terminal.withCheckpointRestore(f.launched.id,async()=>{ran=true;}),code('isolated-environment'));assert.equal(ran,false);
});

test('an isolated sibling hides no project: a card of the same project is refused, a distinct project is not',{timeout:5000},async t=>{
 const f=await environmentFixture(t,{relocate:true});f.calls[0].process.emitExit(0);
 const sibling=f.create();f.calls[1].process.emitExit(0);
 await assert.rejects(f.terminal.withCheckpointRestore(sibling.id,async()=>assert.fail()),code('isolated-environment'));
 const distinct=join(f.root,'distinct');await mkdir(distinct);const local=f.create(distinct);f.calls[2].process.emitExit(0);let restored=false;
 await f.terminal.withCheckpointRestore(local.id,async()=>{restored=true;});assert.equal(restored,true);
});

test('an unverifiable isolated launch scope refuses every restore',{timeout:5000},async t=>{
 const f=await environmentFixture(t,{removeProjectDuringWrap:true});f.calls[0].process.emitExit(0);
 const distinct=join(f.root,'distinct');await mkdir(distinct);const local=f.create(distinct);f.calls[1].process.emitExit(0);
 await assert.rejects(f.terminal.withCheckpointRestore(local.id,async()=>assert.fail()),code('isolated-environment'));
});

for(const isolated of [false,null])test(`a local worktree environment keeps restore support (${isolated===false?'explicitly local':'undeclared'})`,{timeout:5000},async t=>{
 const f=await environmentFixture(t,{isolated,kind:'worktree'});f.calls[0].process.emitExit(0);let restored=false;
 await f.terminal.withCheckpointRestore(f.launched.id,async()=>{restored=true;});assert.equal(restored,true);
});

test('isolated launch evidence is saved with the card, survives a reload and stays host-only',{timeout:5000},async t=>{
 const f=await environmentFixture(t,{persist:true,relocate:true});f.calls[0].process.emitExit(0);
 await f.terminal.shutdown();
 const stored=JSON.parse(await readFile(join(f.root,'terminal-sessions.json'),'utf8'));
 assert.ok(stored.sessions[0].isolatedEnvironmentScopes.roots.includes(f.project));
 f.provider.kinds[0].keeps.isolated=false;
 const calls=[],manager=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls));
 t.after(()=>manager.disposeAll());
 manager.configureSessionPersistence(new TerminalSessionStore(f.root),'continue');await manager.restorePersistedSessions();
 assert.ok(manager.getMetadata(f.launched.id));assert.equal('isolatedEnvironmentScopes' in manager.getMetadata(f.launched.id),false,'evidence never reaches the renderer');
 const local=manager.create({provider:'codex',profile:'normal',cwd:f.project,position:{x:0,y:0}});calls.at(-1).process.emitExit(0);
 await assert.rejects(manager.withCheckpointRestore(local.id,async()=>assert.fail()),code('isolated-environment'));
 await manager.shutdown();const again=await new TerminalSessionStore(f.root).load();
 assert.deepEqual(again.find(row=>row.id===f.launched.id).isolatedEnvironmentScopes,stored.sessions[0].isolatedEnvironmentScopes);
});

for(const evidence of [undefined,null,{roots:['relative'],ambiguous:false},{roots:['/absolute'],ambiguous:'no'},{roots:Array.from({length:33},(_,i)=>'/'+i),ambiguous:false}])test(`legacy or malformed isolation evidence reads as unknown scope (${JSON.stringify(evidence)})`,{timeout:5000},async t=>{
 const f=await environmentFixture(t,{persist:true});f.calls[0].process.emitExit(0);await f.terminal.shutdown();
 const file=join(f.root,'terminal-sessions.json'),saved=JSON.parse(await readFile(file,'utf8'));
 if(evidence===undefined)delete saved.sessions[0].isolatedEnvironmentScopes;else saved.sessions[0].isolatedEnvironmentScopes=evidence;
 await writeFile(file,JSON.stringify(saved));
 const persisted=await new TerminalSessionStore(f.root).load();assert.deepEqual(persisted[0].isolatedEnvironmentScopes,{roots:[],ambiguous:true});
});

test('a card with unknown isolation scope blocks only restores of its own folder or task, not unrelated ones',{timeout:5000},async t=>{
 const f=await environmentFixture(t,{persist:true});f.calls[0].process.emitExit(0);await f.terminal.shutdown();
 const file=join(f.root,'terminal-sessions.json'),saved=JSON.parse(await readFile(file,'utf8'));
 saved.sessions[0].isolatedEnvironmentScopes={roots:[],ambiguous:true};await writeFile(file,JSON.stringify(saved));
 const calls=[],manager=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls)),store=new TerminalSessionStore(f.root);
 manager.configureEnvironments(f.registry);manager.configureSessionPersistence(store,'continue');await manager.restorePersistedSessions();
 for(const call of calls)call.process.emitExit(0);
 const distinct=join(f.root,'distinct');await mkdir(distinct);
 const unrelated=manager.create({provider:'codex',profile:'normal',cwd:distinct,position:{x:0,y:0}});calls.at(-1).process.emitExit(0);
 let restored=false;await manager.withCheckpointRestore(unrelated.id,async()=>{restored=true;});assert.equal(restored,true,'an unrelated folder is not blocked');
 const same=manager.create({provider:'codex',profile:'normal',cwd:f.project,position:{x:0,y:0}});calls.at(-1).process.emitExit(0);
 await assert.rejects(manager.withCheckpointRestore(same.id,async()=>assert.fail()),code('isolated-environment'));
 // Its saved-session writes finish before the fixture removes the folder they go to.
 manager.disposeAll();await store.flush().catch(()=>undefined);
});

test('plugin card actions on a folder wait until its restore ends',{timeout:5000},async t=>{
 const f=await fixture(t),{PluginCards}=await import('../src/main/services/PluginCards.ts');
 const card=f.create();f.calls[0].process.emitExit(0);
 const summary={id:card.id,provider:'codex',role:'agent',title:'x',status:'done',exitCode:0,cwd:f.project,workingDirectory:f.project,startedAt:0};
 let called=0;const cards=new PluginCards({providers:()=>[{pluginId:'p',pluginName:'P',serviceId:'s',actions:[{id:'apply',title:'Apply'}]}],trustedPlugins:()=>new Set(['p']),
  call:async()=>{called++;return{message:'ok'};},session:()=>summary,restoring:folder=>f.terminal.isRestoringFolder(folder),redact:x=>x,changed(){}});
 const release=deferred(),entered=deferred();
 const restoring=f.terminal.withCheckpointRestore(card.id,async()=>{entered.resolve();await release.promise;});await entered.promise;
 await assert.rejects(cards.invoke('p','apply',card.id),/restoration is in progress/u);assert.equal(called,0);
 release.resolve();await restoring;assert.equal((await cards.invoke('p','apply',card.id)).message,'ok');
});

test('typed and replayed input share one write: it moves the rollback point generation, and a restore refuses it',async t=>{
 const f=await fixture(t),a=f.create();
 const session=f.terminal.sessions.get(a.id),process=session.process;
 const generation=session.checkpointGeneration??0,submitted=f.terminal.submittedInputs(a.id);
 const guard=f.terminal.providerSignalGuard(a.id);
 // A writer that held input and replays it later goes through writeInput, like input() does.
 assert.equal(f.terminal.writeInput(a.id,session,process,'next task\r'),true);
 assert.equal(session.checkpointGeneration??0,generation+1);
 assert.equal(f.terminal.submittedInputs(a.id),submitted+1);
 assert.equal(guard(),false,'the replayed prompt makes the earlier turn\'s rollback point stale');
 process.emitExit(0);
 const entered=deferred(),release=deferred();
 const restore=f.terminal.withCheckpointRestore(a.id,async()=>{entered.resolve();await release.promise;});await entered.promise;
 // Even a replayer that still holds the card's process (as if it had not exited yet) types nothing while it restores.
 session.metadata.exitCode=null;const writes=f.writes.length;
 assert.equal(f.terminal.writeInput(a.id,session,process,'late\r'),false);
 assert.equal(f.writes.length,writes);
 session.metadata.exitCode=0;
 release.resolve();await restore;
});
