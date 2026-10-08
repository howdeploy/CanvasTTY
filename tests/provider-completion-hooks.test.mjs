import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { AGENT_RUNTIME_ENV, toolOutcomeFromHook } from "../src/agent-runtime/runtime-protocol.mjs";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { ProviderRuntimeLaunchAdapters } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";
import { IMPLEMENTATIONS, SKIP_NATIVE, baseEnvironment, runOnce } from "./native-helper-harness.mjs";

// Real shell-hook envelopes: Kimi hooks/events.py (9ab1286b), Hermes shell_hooks.py + model_tools.py (457a1e1c).
const session_id="0f8fad5b-d9cb-469f-a165-70867728950e";
const kimi=(extra={})=>({hook_event_name:"PostToolUse",session_id,cwd:"/work",tool_name:"Shell",tool_input:{command:"private command"},tool_call_id:"call-1",tool_output:"private output",...extra});
const hermes=(extra={})=>({hook_event_name:"post_tool_call",session_id,cwd:"/work",profile:"default",tool_name:"terminal",tool_input:{command:"private command"},extra:{result:"private output",status:"ok",tool_call_id:"call-1",turn_id:"turn-1",api_request_id:"turn-1:api:1",duration_ms:12,...extra}});
const cases=[
 {provider:"kimi",event:"PostToolUse",input:kimi(),result:"unknown",output:"private output"},
 {provider:"kimi",event:"PostToolUse",input:kimi({tool_output:'{"success":true}'}),result:"unknown",output:'{"success":true}'},
 {provider:"kimi",event:"PostToolUseFailure",input:kimi({hook_event_name:"PostToolUseFailure",tool_output:undefined,error:"private exception"}),result:"error",error:"private exception"},
 {provider:"hermes",event:"post_tool_call",input:hermes(),result:"success",output:"private output"},
 {provider:"hermes",event:"post_tool_call",input:hermes({status:"error",error_message:"private exception"}),result:"error",error:"private exception"},
 {provider:"hermes",event:"post_tool_call",input:hermes({status:"timeout",error_message:"private timeout"}),result:"error",error:"private timeout"},
 {provider:"hermes",event:"post_tool_call",input:hermes({status:"blocked",error_message:"private policy"}),result:"denied",output:"private output"},
 {provider:"hermes",event:"post_tool_call",input:hermes({status:"cancelled"}),result:"unknown",output:"private output"},
 {provider:"hermes",event:"post_tool_call",input:hermes({status:"future-state",result:'{"success":true}'}),result:"unknown",output:'{"success":true}'},
 {provider:"hermes",event:"post_tool_call",input:hermes({status:undefined,result:"success"}),result:"unknown",output:"success"}
];
const sha=text=>createHash("sha256").update(text).digest("hex");
function check(outcome,entry){
 assert.equal(outcome.resultClass,entry.result);
 assert.match(outcome.normalizedActionHash,/^[a-f0-9]{64}$/u);
 assert.equal(outcome.outputHash,entry.output===undefined?undefined:sha(entry.output));
 assert.equal(outcome.errorHash,entry.error===undefined?undefined:sha(entry.error));
 assert.deepEqual(outcome.changedPathHashes,[]);
 assert.ok(!JSON.stringify(outcome).includes("private"));
 assert.ok(JSON.stringify(outcome).length<600);
}
test("actual Kimi/Hermes completion payloads use only explicit status, bounded hashes and legacy precedence",()=>{
 for(const entry of cases)check(toolOutcomeFromHook(entry.provider,entry.event,entry.input),entry);
 for(const provider of ["kimi","hermes"]){
  const input=provider==="kimi"?kimi():hermes({status:"error",error_message:"ignored"});
  const response={success:true,output:"legacy"};input.tool_response=response;
  const outcome=toolOutcomeFromHook(provider,provider==="kimi"?"PostToolUse":"post_tool_call",input);
  assert.equal(outcome.resultClass,"success");assert.equal(outcome.outputHash,sha(JSON.stringify(response)));
 }
 const big=kimi({tool_output:"a".repeat(20000)+"tail"});
 assert.equal(toolOutcomeFromHook("kimi","PostToolUse",big).outputHash,sha("a".repeat(16384)));
 assert.equal(toolOutcomeFromHook("codex","PostToolUseFailure",kimi({error:"not Kimi"})),undefined);
});

function commandFrom(config,provider,event){
 if(provider==="hermes")return parseYaml(config).hooks[event][0].command;
 const block=config.split("[[hooks]]").find(block=>block.includes(`event = "${event}"`));
 assert.ok(block,`${event} core hook is present without plugins`);
 return JSON.parse(/^command = (.+)$/mu.exec(block)[1]);
}

test("generated Kimi/Hermes core completion commands deliver real envelopes through native and JS helpers",{skip:SKIP_NATIVE,timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),"ctty-completion-")),signals=[],launches=[];
 const gateway=new RuntimeGateway({runtimeDirectory:join(root,"runtime"),windowsHostPath:join(process.cwd(),"build/windows-agent-pipe-host/canvastty-windows-agent-pipe-host.exe"),onSignal:(id,signal)=>signals.push({id,signal})});
 await gateway.start();t.after(async()=>{try{for(const launch of launches)launch.releaseConfiguration();}finally{await gateway.close();await rm(root,{recursive:true,force:true});}});
 const all=[];
 for(const implementation of IMPLEMENTATIONS){
  const command=implementation.hook("","");
  const adapters=new ProviderRuntimeLaunchAdapters({helper:{command:command[0],args:command.slice(1,-2),env:{}},runtimeDirectory:join(root,implementation.name),openCodePluginPath:join(root,"unused.mjs"),kimiHomeDirectory:join(root,implementation.name,"kimi"),hermesHomeDirectory:join(root,implementation.name,"hermes"),platform:process.platform,environment:{}});
  const collected=[];
  for(const provider of ["kimi","hermes"]){
   const launch=adapters.prepare(provider,implementation.name+provider,true);launches.push(launch);
   const config=await readFile(join(root,implementation.name,provider,provider==="kimi"?"config.toml":"config.yaml"),"utf8");
   const capability=gateway.registerSession("completion-"+provider,provider);
   const env=baseEnvironment({[AGENT_RUNTIME_ENV.address]:capability.address,[AGENT_RUNTIME_ENV.terminalSessionId]:capability.terminalSessionId,[AGENT_RUNTIME_ENV.provider]:provider,[AGENT_RUNTIME_ENV.capabilityToken]:capability.capabilityToken});
   const run=async(event,input)=>{
    const configured=commandFrom(config,provider,event);
    // Let Node wrap cmd.exe's /s /c command and preserve its quotes verbatim on Windows.
    // Passing that shell manually through ordinary argv escaping corrupts quoted executable paths.
    const result=await runOnce([configured],{env,input:JSON.stringify(input),shell:true});
    assert.equal(result.code,0,`${implementation.name} ${provider} ${event}: ${result.stderr}`);
    assert.equal(result.stdout,"");
   };
   await run(provider==="kimi"?"TurnStarted":"pre_llm_call",{session_id,...(provider==="hermes"?{extra:{turn_id:"turn-1"}}:{})});
   for(const entry of cases.filter(row=>row.provider===provider)){
    const before=signals.length;await run(entry.event,entry.input);assert.equal(signals.length,before+1);
    const signal=signals.at(-1).signal;assert.equal(signal.state,"working");assert.equal(signal.event,entry.event);
    if(provider==="hermes")assert.equal(signal.turnId,"turn-1","nested turn identity matches pre_llm_call");
    check(signal.toolOutcome,entry);collected.push(signal.toolOutcome);
   }
   if(provider==="hermes"){
    await run("pre_llm_call",{session_id,extra:{turn_id:"turn-2"}});
    const before=signals.length;await run("post_tool_call",hermes({turn_id:"turn-1"}));
    assert.equal(signals.length,before,"late completion from previous actual turn is rejected");
    await run("post_tool_call",hermes({turn_id:"turn-2"}));assert.equal(signals.at(-1).signal.turnId,"turn-2");
   }
   launch.releaseConfiguration();
  }
  all.push(collected);
 }
 assert.deepEqual(all[1],all[0],"native implementation preserves complete JS outcome semantics");
});
