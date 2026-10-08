import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdtemp,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {AgentControlService} from "../src/main/services/AgentControlService.ts";
import {ScopedOrchestrationHandler} from "../src/main/services/agent-browser/OrchestrationTools.ts";
import {TerminalManager} from "../src/main/services/TerminalManager.ts";
import {availableRegistry,fakeSpawner} from "./helpers/terminal.mjs";

const plugin=process.env.CANVASTTY_ASSISTANT_PLUGIN_DIR ?? resolve("../canvastty-work/canvastty-plugin-assistant");
test("core effort-only spawn reaches real Assistant rules and Jev transport (local fixture, no live model)",{
  skip:!existsSync(join(plugin,"src/service/assistant.ts")) ? "Assistant plugin checkout unavailable." : false
},async t=>{
  const [{Assistant},{DEFAULT_ASSISTANT_SETTINGS},{startFakeSystemOne}]=await Promise.all([
    import(pathToFileURL(join(plugin,"src/service/assistant.ts"))),
    import(pathToFileURL(join(plugin,"src/shared/settings.ts"))),
    import(pathToFileURL(join(plugin,"tests/helpers/fake-systemone.mjs")))
  ]);
  const dir=await mkdtemp(join(tmpdir(),"ctty-core-assistant-route-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const fake=await startFakeSystemOne({mode:"typesafe",brain(state,question,labels){
    if(JSON.stringify(state).includes("CI run finished")) {
      if(question.type==="noul")return [0.99,0.01];
      if(question.type==="choice")return labels.map(label=>label==="none_of_these" ? 0.99 : 0.01/Math.max(1,labels.length-1));
      const harmless=question.criteria.findIndex(level=>/harmless: documentation only/u.test(level));
      return labels.map((_label,index)=>index===harmless ? 0.99 : 0.01/Math.max(1,labels.length-1));
    }
    if(question.type==="score")return [0.98,0.01,0.005,0.005];
    if(question.type==="noul")return labels.map(label=>["true","yes"].includes(label) ? 0.99 : 0.01);
    return labels.map((_label,index)=>index===0 ? 0.99 : 0.01/Math.max(1,labels.length-1));
  }});t.after(()=>fake.close());
  const host={async callHost(method,params={}){return method==="secrets.get" && params.key==="decision-jev" ? JSON.stringify({origin:"https://api.typesafe.ai",value:"k-good"}) : null;},log(){},emit(){}};
  const settings={...structuredClone(DEFAULT_ASSISTANT_SETTINGS),enabled:true,engine:"jev",grant:"D2",dataClassMode:"off",defaultDataClass:"D0",
    modes:{...DEFAULT_ASSISTANT_SETTINGS.modes,"task.route":"suggest"},backends:[{id:"jev",preset:"typesafe",enabled:true,trust:"D2"}],
    routeRules:[{match:"authored-rule",model:"gpt-6-luna",reason:"Person's rule"}]};
  const assistant=new Assistant({host,dataDir:dir,settings,transport:fake.transport(),git:null});t.after(()=>assistant.engine.dispose());
  await assistant.engine.check("jev");
  const calls=[],terminals=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner(calls));t.after(()=>terminals.disposeAll());
  const parent=terminals.create({provider:"codex",profile:"normal",cwd:dir,position:{x:0,y:0},role:"orchestrator"});
  const routed=[];
  const handler=new ScopedOrchestrationHandler(new AgentControlService(terminals),null,{
    cli:()=>"available",limits:()=>null,models:()=>({models:["gpt-6-sol","gpt-6-luna","gpt-6-astra"],checkedAt:Date.now()}),checkModel:async()=>null
  },{router:{async route(request){routed.push(request);return assistant.route(request);}}});
  for(const prompt of ["authored-rule perform this task","format independent files with prettier"]){
    const child=await handler.execute(parent.id,{id:prompt,tool:"spawn_agent",arguments:{provider:"codex",cwd:dir,model:"auto",effort:"low",prompt}});
    assert.equal(child.model,"gpt-6-luna");assert.equal(child.effort,"low");
  }
  assert.ok(routed.every(request=>request.humanChoice===null && request.requested.reasoningEffort==="low"));
  assert.equal(fake.requests.filter(request=>request.method==="POST" && request.path==="/v1/systemone" && request.json?.state?.task==="format independent files with prettier").length,1);
});
