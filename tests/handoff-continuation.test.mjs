import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {PluginSessions} from '../src/main/services/PluginSessions.ts';
import {OrchestrationTaskBoard} from '../src/main/services/OrchestrationTaskBoard.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t,{competitor=false}={}) {
 const root=realpathSync(await mkdtemp(join(tmpdir(),'ctty-handoff-continuation-'))),project=join(root,'project'),worktree=join(root,'worktree');
 await mkdir(project);await mkdir(worktree);
 const calls=[],events=[];
 const manager=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,false,fakeSpawner(calls));
 t.after(async()=>{manager.disposeAll();await rm(root,{recursive:true,force:true});});
 const choice={pluginId:'fixture',kind:'worktree',options:{branch:'task'}};
 const ref={pluginId:'fixture',kind:'worktree',label:'Task tree',ref:{directory:worktree}};
 manager.configureEnvironments({normalizeChoice:(_provider,value)=>value,available:()=>true,unavailableReason:()=>'',keeps:()=>({launch:true}),
  prepare:async()=>{events.push('prepare');return {ok:true,environment:ref,cwd:worktree};},
  resume:async()=>{events.push('resume');return {ok:true};},
  wrap:async(environment,p)=>{events.push({type:'wrap',environment,sessionId:p.sessionId});return {ok:true,...p.launch,cwd:worktree,secrets:[]};},
  release:async(environment,sessionId,options)=>{events.push({type:'release',environment,sessionId,options});},describe:async()=>({})});
 const treeTarget={id:'tree',label:'Task tree',provider:'codex',accountId:'default',maxDataClass:'D3',environment:choice};
 let policy={enabled:true,defaultDataClass:'D2',targets:[...(competitor?[{...treeTarget,id:'local',environment:undefined}]:[]),treeTarget]};
 manager.configureExecutionPolicy(()=>policy);
 const source=manager.create({provider:'codex',profile:'normal',cwd:project,position:{x:0,y:0},role:'orchestrator',environment:choice});
 assert.equal((await manager.deliverInput(source.id,'start\r',2000)).delivered,true,manager.getMetadata(source.id)?.failureDetails);
 const board=new OrchestrationTaskBoard(root);
 const tasks=[];for(const title of ['First','Second','Third'])tasks.push(await board.addTask(project,source.id,source.id,{title,ownerSessionId:source.id}));
 let enabled=true,transfer=async(from,to)=>{
  const receipt=await board.transferOwnerWithRollback(project,source.id,from,to,'Replacement');return receipt.rollback;
 };
 const plugins=new PluginSessions({terminals:manager,experimentalEnabled:()=>enabled,notify:()=>true,handoffTaskOwner:(...args)=>transfer(...args)});
 const handoff=()=>plugins.withCardConsent('canvastty-accounts','handoff',source.id,()=>plugins.handle('canvastty-accounts','accounts','sessions.handoff',{sessionId:source.id,summary:'Continue task'},['sessions:launch']));
 return {root,project,worktree,manager,source,calls,events,board,tasks,handoff,choice,ref,treeTarget,
  setPolicy:p=>{policy=p;},setEnabled:value=>{enabled=value;},setTransfer:fn=>{transfer=fn;}};
}

test('handoff authorizes and launches the existing worktree before ownership adoption',async t=>{
 for(const competitor of [false,true]) {
  const f=await fixture(t,{competitor});const replacement=await f.handoff();
  assert.ok(replacement);assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.cwd,f.worktree);
  const descriptor=f.manager.archiveDescriptors().find(row=>row.id===replacement.id);
  assert.equal(descriptor.executionAuthorization.target.id,'tree','environmentless competitor must never authorize this PTY');
  assert.deepEqual(descriptor.executionAuthorization.target.environment,f.choice);
  assert.equal(f.events.filter(e=>e==='prepare').length,1);assert.equal(f.events.filter(e=>e==='resume').length,0);
  assert.equal(f.events.filter(e=>e.type==='wrap').length,2);assert.equal(f.events.filter(e=>e.type==='release').length,0);
  assert.equal(f.manager.getMetadata(f.source.id),null);
  const owned=await f.board.listTasks(f.project,f.source.id);assert.ok(owned.tasks.every(row=>row.ownerSessionId===replacement.id));
  f.manager.dispose(replacement.id,{keepEnvironmentData:true});assert.equal(f.events.filter(e=>e.type==='release').length,1);
 }
});

test('handoff refuses a local-only competitor and never prepares or launches a second tree',async t=>{
 const f=await fixture(t);f.setPolicy({enabled:true,defaultDataClass:'D2',targets:[{...f.treeTarget,id:'local',environment:undefined}]});
 await assert.rejects(f.handoff(),/execution target/i);assert.equal(f.calls.length,1);
 assert.ok(f.manager.getMetadata(f.source.id));assert.equal(f.events.filter(e=>e==='prepare').length,1);
 assert.equal(f.events.filter(e=>e.type==='release').length,0);
});

test('source or replacement close during board transfer compensates only that handoff',async t=>{
 for(const close of ['source','replacement']) {
  const f=await fixture(t,{competitor:true});const committed=deferred(),finish=deferred();let replacementId;
  const original=await readFile(f.board.boardLocation(f.project).path,'utf8');
  f.setTransfer(async(from,to)=>{replacementId=to;const receipt=await f.board.transferOwnerWithRollback(f.project,f.source.id,from,to,'Replacement');committed.resolve();await finish.promise;return receipt.rollback;});
  const pending=f.handoff();await committed.promise;
  f.manager.dispose(close==='source'?f.source.id:replacementId);
  finish.resolve();await assert.rejects(pending,/Handoff card is unavailable/);
  assert.equal(f.manager.getMetadata(replacementId),null);
  const state=await f.board.listTasks(f.project,f.source.id);assert.ok(state.tasks.every(row=>row.ownerSessionId===f.source.id));
  const before=JSON.parse(original),after=JSON.parse(await readFile(f.board.boardLocation(f.project).path,'utf8'));
  assert.deepEqual(after.tasks,before.tasks,'compensation restores exact pre-transfer state');
  if(close==='replacement')assert.equal(f.events.filter(e=>e.type==='release').length,0,'borrower close never releases source tree');
  else assert.ok(f.events.filter(e=>e.type==='release').every(e=>e.options.keepData),'source close preserves borrowed worktree data');
 }
});

test('compensation preserves concurrent completion and reassignment; failed rollback retains recovery owner',async t=>{
 const f=await fixture(t);const committed=deferred(),finish=deferred();let replacementId;
 f.setTransfer(async(from,to)=>{replacementId=to;const receipt=await f.board.transferOwnerWithRollback(f.project,f.source.id,from,to,'Replacement');committed.resolve();await finish.promise;return receipt.rollback;});
 const pending=f.handoff();await committed.promise;
 await f.board.completeTask(f.project,f.source.id,replacementId,f.tasks[0].id,'Completed during handoff');
 await f.board.assignTask(f.project,f.source.id,f.tasks[1].id,'different-owner');
 f.manager.dispose(f.source.id);finish.resolve();await assert.rejects(pending,/Handoff card is unavailable/);
 const rows=(await f.board.listTasks(f.project,f.source.id)).tasks;
 assert.equal(rows.find(row=>row.id===f.tasks[0].id).status,'done');assert.equal(rows.find(row=>row.id===f.tasks[0].id).ownerSessionId,replacementId);
 assert.equal(rows.find(row=>row.id===f.tasks[1].id).ownerSessionId,'different-owner');assert.equal(rows.find(row=>row.id===f.tasks[2].id).ownerSessionId,f.source.id);
 const g=await fixture(t);let retainedId;
 g.setTransfer(async(from,to)=>{retainedId=to;const receipt=await g.board.transferOwnerWithRollback(g.project,g.source.id,from,to);g.manager.dispose(from);t.mock.method(g.board,'mutate',async()=>{throw new Error('fixture disk refusal');});return receipt.rollback;});
 await assert.rejects(g.handoff(),/ownership could not be restored.*retained/i);
 assert.ok(g.manager.getMetadata(retainedId));assert.ok((await g.board.listTasks(g.project,g.source.id)).tasks.every(row=>row.ownerSessionId===retainedId));
});

test('opt-out after board commit compensates and retains the original card and worktree',async t=>{
 const f=await fixture(t);f.setTransfer(async(from,to)=>{const receipt=await f.board.transferOwnerWithRollback(f.project,f.source.id,from,to);f.setEnabled(false);return receipt.rollback;});
 await assert.rejects(f.handoff(),/disabled/);assert.equal(f.manager.listMetadata().length,1);assert.ok(f.manager.getMetadata(f.source.id));
 assert.ok((await f.board.listTasks(f.project,f.source.id)).tasks.every(row=>row.ownerSessionId===f.source.id));assert.equal(f.events.filter(e=>e.type==='release').length,0);
});


test('concurrent content edits retain the replacement instead of discarding its unfinished task',async t=>{
 const f=await fixture(t);let replacementId;
 f.setTransfer(async(from,to)=>{
  replacementId=to;const receipt=await f.board.transferOwnerWithRollback(f.project,f.source.id,from,to);
  await f.board.updateTask(f.project,f.source.id,to,f.tasks[0].id,{progress:'new work during transfer'});
  f.manager.dispose(from);return receipt.rollback;
 });
 await assert.rejects(f.handoff(),/ownership could not be restored.*retained/i);
 assert.ok(f.manager.getMetadata(replacementId));
 const rows=(await f.board.listTasks(f.project,f.source.id)).tasks;
 assert.equal(rows.find(row=>row.id===f.tasks[0].id).progress,'new work during transfer');
 assert.equal(rows.find(row=>row.id===f.tasks[0].id).ownerSessionId,replacementId);
 assert.equal(rows.find(row=>row.id===f.tasks[1].id).ownerSessionId,f.source.id);
});


test('source closure during borrowed wrap cannot start a stale replacement or release its tree twice',async t=>{
 const f=await fixture(t);const wrapping=deferred(),finish=deferred();
 const original=f.manager.environments.wrap;
 t.mock.method(f.manager.environments,'wrap',async(...args)=>{wrapping.resolve();await finish.promise;return original(...args);});
 const pending=f.handoff();await wrapping.promise;f.manager.dispose(f.source.id,{keepEnvironmentData:false});finish.resolve();
 await assert.rejects(pending,/Replacement did not accept/);
 assert.equal(f.calls.length,1,'the replacement never reaches PTY spawn');
 const releases=f.events.filter(e=>e.type==='release');assert.equal(releases.length,1);assert.equal(releases[0].options.keepData,true);
 assert.equal(f.events.filter(e=>e==='prepare').length,1);assert.equal(f.events.filter(e=>e==='resume').length,0);
 assert.equal(f.manager.listMetadata().length,0);
});

test('failed replacement delivery leaves original worktree ownership and never releases the borrowed ref',async t=>{
 const f=await fixture(t);t.mock.method(f.manager,'deliverInput',async()=>({delivered:false,reason:'fixture refusal'}));
 await assert.rejects(f.handoff(),/Replacement did not accept/);
 assert.ok(f.manager.getMetadata(f.source.id));assert.equal(f.manager.listMetadata().length,1);
 assert.equal(f.events.filter(e=>e.type==='release').length,0);
 assert.ok((await f.board.listTasks(f.project,f.source.id)).tasks.every(row=>row.ownerSessionId===f.source.id));
});
