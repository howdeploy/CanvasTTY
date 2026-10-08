import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentControlService} from '../src/main/services/AgentControlService.ts';
import {OrchestrationTemplateService} from '../src/main/services/OrchestrationTemplateService.ts';
import {OrchestrationTaskBoard} from '../src/main/services/OrchestrationTaskBoard.ts';
import {ScopedOrchestrationHandler} from '../src/main/services/agent-browser/OrchestrationTools.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';

test('all four built-in flows launch fixture agents and collect every final result through scoped tools',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ctty-four-flows-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const templates=new OrchestrationTemplateService();
 const {templates:flows}=await templates.list(root);assert.equal(flows.length,4);
 for(const flow of flows){
  const calls=[];const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner(calls));
  try{
   const control=new AgentControlService(terminals),handler=new ScopedOrchestrationHandler(control,null,undefined,{templates});
   const parent=terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
   const execute=(tool,args={})=>handler.execute(parent.id,{id:crypto.randomUUID(),tool,arguments:args});
   const applied=await execute('apply_orchestration_template',{templateId:flow.id,task:'Verify fixture flow'});
   assert.equal(applied.expectedSubagents,flow.expectedSubagents);assert.ok(applied.instructions.includes(flow.finalStep));
   const agents=[];
   for(const role of flow.roles)for(let i=0;i<role.count;i++){
    const spawned=await execute('spawn_agent',{provider:'codex',cwd:root,title:role.title,prompt:role.instruction});
    agents.push(spawned.sessionId);
    // A real final-answer capture carries the current input generation; uncorrelated old answers are rejected.
    const generation=terminals.answerCaptureGeneration(spawned.sessionId);
    terminals.recordAnswer(spawned.sessionId,{text:`${role.id}:${i}:completed`,truncated:false},{generation});
    assert.equal(terminals.answer(spawned.sessionId)?.text,`${role.id}:${i}:completed`);
    calls.at(-1).process.emitExit(0);
   }
   const results=await Promise.all(agents.map(sessionId=>execute('get_agent_result',{sessionId})));
   assert.equal(results.length,flow.expectedSubagents);assert.ok(results.every(row=>row.state==='done' && row.answer.text.endsWith(':completed')));
   assert.ok(terminals.listMetadata().filter(row=>row.parentSessionId===parent.id).length===flow.expectedSubagents);
  }finally{terminals.disposeAll();}
 }
});

test('task board tools cannot read another task tree or a standalone agent scope',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ctty-task-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));t.after(()=>terminals.disposeAll());
 const control=new AgentControlService(terminals),board=new OrchestrationTaskBoard(root),handler=new ScopedOrchestrationHandler(control,null,undefined,{taskBoard:board});
 const create=role=>terminals.create({provider:'codex',profile:'normal',cwd:root,position:{x:0,y:0},...(role?{role}:{})});
 const one=create('orchestrator'),two=create('orchestrator'),standalone=create();
 await board.addTask(root,one.id,one.id,{title:'Only tree one'});
 await board.addTask(root,two.id,two.id,{title:'Only tree two'});
 const execute=(id,args={})=>handler.execute(id,{id:crypto.randomUUID(),tool:'list_tasks',arguments:args});
 const list=await execute(two.id);assert.ok(!JSON.stringify(list).includes('Only tree one'));assert.ok(JSON.stringify(list).includes('Only tree two'));
 const spoofed=await execute(two.id,{rootSessionId:one.id});assert.ok(!JSON.stringify(spoofed).includes('Only tree one'));
 const isolated=await execute(standalone.id);assert.ok(!JSON.stringify(isolated).includes('Only tree one'));assert.ok(!JSON.stringify(isolated).includes('Only tree two'));
});
