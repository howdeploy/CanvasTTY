import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceArchive} from '../src/main/services/WorkspaceArchive.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {SettingsStore} from '../src/main/services/SettingsStore.ts';
const descriptor=(cwd,id,extra={})=>({id,provider:'codex',profile:'normal',role:'orchestrator',title:id,titleCustomized:true,cwd,position:{x:0,y:0},size:{width:600,height:400},lastState:'running',restore:true,...extra});
const snapshot=sessions=>JSON.stringify({format:'canvastty-workspace',version:1,sessions});
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'ctty-bypass-import-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const settings=new SettingsStore(directory,'en','linux');await settings.load();const spawns=[];
 const terminals=new TerminalManager(()=>{}, {get:provider=>({state:'available',provider,executable:'/fixture/cli',launcher:'native',environment:{},checked:[]})},undefined,undefined,true,
  (...args)=>{spawns.push(args);return{pid:50000+spawns.length,process:'fixture',write(){},resize(){},kill(){},onData(){return{dispose(){}};},onExit(){return{dispose(){}};}};});
 t.after(()=>terminals.shutdown());
 const acknowledged=provider=>settings.get().acknowledgedDangerousProfiles.includes(provider);
 terminals.configureYoloAcknowledgement(acknowledged);
 const archive=new WorkspaceArchive(directory,{descriptors:()=>[],create:request=>terminals.create(request),setBounds:(id,bounds)=>terminals.setBounds(id,bounds),available:()=>true,bypassAcknowledged:acknowledged,redact:text=>text});
 return{directory,settings,spawns,archive};
}
test('Bypass import preflights host launcher authority before normal cards or dependent children are created',async t=>{
 const f=await fixture(t),rows=[descriptor(f.directory,'normal-first'),descriptor(f.directory,'bypass',{profile:'yolo'}),descriptor(f.directory,'child',{role:'subagent',parentSessionId:'bypass'})];
 const text=snapshot(rows),before=f.settings.get().acknowledgedDangerousProfiles;
 await assert.rejects(f.archive.import(text,false),/Confirm Bypass/);assert.equal(f.spawns.length,0);
 await assert.rejects(f.archive.import(text,true),/Acknowledge Bypass for codex.*launcher.*retry.*No cards were created/);assert.equal(f.spawns.length,0);
 assert.deepEqual(f.settings.get().acknowledgedDangerousProfiles,before,'import cannot persist launcher consent');
 await f.settings.update({acknowledgedDangerousProfiles:['codex']});
 const result=await f.archive.import(text,true);assert.equal(result.sessions.length,3);assert.equal(f.spawns.length,3);
 assert.equal(result.sessions[2].parentSessionId,result.sessions[1].id);assert.deepEqual(result.warnings.filter(text=>/not acknowledged|could not/.test(text)),[]);
 assert.deepEqual(f.settings.get().acknowledgedDangerousProfiles,['codex']);
 const main=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8');
 assert.match(main,/bypassAcknowledged: provider => settings\.get\(\)\.acknowledgedDangerousProfiles\.includes\(provider as AgentProviderId\)/);
});
test('acknowledged Bypass still cannot be assigned to an imported subagent',async t=>{
 const f=await fixture(t);await f.settings.update({acknowledgedDangerousProfiles:['codex']});
 await assert.rejects(f.archive.import(snapshot([descriptor(f.directory,'root'),descriptor(f.directory,'child',{profile:'yolo',role:'subagent',parentSessionId:'root'})]),true),/never permitted for subagents/);
 assert.equal(f.spawns.length,0);
});
test('missing host acknowledgement fails closed; terminal and inert remote cards keep their existing semantics',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ctty-bypass-unavailable-'));t.after(()=>rm(directory,{recursive:true,force:true}));let creates=0;
 const archive=new WorkspaceArchive(directory,{descriptors:()=>[],create:request=>({...request,id:`new-${++creates}`}),setBounds(){},available:()=>true,redact:text=>text});
 await assert.rejects(archive.import(snapshot([descriptor(directory,'agent',{profile:'yolo'})]),true),/Acknowledge Bypass/);assert.equal(creates,0);
 const terminal=await archive.import(snapshot([descriptor(directory,'terminal',{provider:'terminal',profile:'yolo',role:'agent'})]),true);assert.equal(terminal.sessions.length,1);
 const remote=await archive.import(snapshot([descriptor(directory,'remote',{profile:'yolo',environment:{pluginId:'fixture.plugin',kind:'remote',ref:null,label:'Reconnect environment'}})]),true);
 assert.equal(remote.sessions.length,0);assert.equal(creates,1);assert.match(remote.warnings.join(' '),/reconnected.*skipped/);
});
