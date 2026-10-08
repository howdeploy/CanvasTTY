import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import { SecretGrantService } from "../src/main/services/SecretGrantService.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";
import { importWithFakeReact, findAll, tick } from "./helpers/fake-react.mjs";
const api={secretId:"OPENAI_API_KEY",method:"GET",path:"models"};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const source=await readFile(new URL("../src/main/index.ts",import.meta.url),"utf8");
const start=source.indexOf("    getTurnIdentity: id =>");
const binding=(await transform("result={"+source.slice(start,source.indexOf("    getSession: id =>",start))+"};",{loader:"ts",format:"cjs"})).code;

async function setup(t,{provider="codex",enabled=true,getSecret,execute,launchEnvironment={}}={}){
 const root=await mkdtemp(join(tmpdir(),"ctty-turn-grant-")),epochs=new Map(),leases=new Map(),calls=[],runs=[];let service,serial=0;
 const gateway={registerSession(id,provider){const capabilityToken=String(++serial);leases.set(id,capabilityToken);epochs.set(id,null);return{address:join(root,"socket"),terminalSessionId:id,provider,capabilityToken};},revokeTerminalSession(id,token){if(token===undefined||leases.get(id)===token){leases.delete(id);epochs.delete(id);}},currentTurnEpoch:id=>epochs.get(id)??null,currentStatus:()=>null};
 const bridge=new AgentRuntimeBridge(gateway,{helper:{command:process.execPath,args:[join(root,"hook-helper.mjs")]},runtimeDirectory:join(root,"runtime"),openCodePluginPath:join(root,"opencode-plugin.mjs"),kimiHomeDirectory:join(root,"kimi"),hermesHomeDirectory:join(root,"hermes"),grokHomeDirectory:join(root,"grok"),environment:launchEnvironment,coreHooksEnabled:enabled,onTurnAuthorityChanged:id=>service?.revalidateTurn(id)});
 const terminals=new TerminalManager(()=>{},availableRegistry(),undefined,bridge,enabled,fakeSpawner(calls));
 t.after(async()=>{terminals.disposeAll();await rm(root,{recursive:true,force:true});});
 const row=terminals.create({provider,cwd:root,profile:"normal",position:{x:0,y:0}});
 const sandbox={managedTerminals:terminals,agentRuntimeBridge:bridge,result:null};runInNewContext(binding,sandbox);
 service=new SecretGrantService({...sandbox.result,getSession:id=>{const row=terminals.getMetadata(id);return row?{provider:row.provider,cwd:root,profile:"normal",active:row.exitCode===null}:null;},getSecret:getSecret??(async()=>"fake-grant-value"),execute:execute??(async request=>{runs.push(request);return{status:200,body:"ok",truncated:false};})});
 const working=(epoch=1)=>{epochs.set(row.id,epoch);terminals.applyProviderSignal(row.id,{kind:"lifecycle",state:"working",event:"UserPromptSubmit"});service.revalidateTurn(row.id);};
 const request=()=>service.requestSecret(row.id,"OPENAI_API_KEY","Run a fake API check.");
 return{root,bridge,terminals,service,row,calls,runs,epochs,working,request,binding:sandbox.result};
}

test("turn secret authority requires this launch's installed completion transport and request-time identity",async t=>{
 for(const options of [{provider:"minimax"},{provider:"hermes"},{enabled:false}]){
  const f=await setup(t,options);f.working();const request=f.request();
  assert.equal(request.turnAvailable,false);assert.throws(()=>f.service.approve(request.id,"turn"),/unavailable/u);
  f.bridge.setCoreHooksEnabled(true);assert.equal(f.request().turnAvailable,false,"enabling does not install hooks into the running launch");
  f.service.approve(request.id,"10m");await f.service.runSecretRequest(f.row.id,api);assert.equal(f.runs.length,1,"intentional longer duration remains available");
 }
 const f=await setup(t);const pending=f.request();assert.equal(pending.turnAvailable,false);
 f.working();assert.equal(f.service.pending()[0].turnAvailable,false,"a request made outside a turn cannot borrow a later turn");
 assert.throws(()=>f.service.approve(pending.id,"turn"),/unavailable/u);
});

test("accepted production idle keeps asynchronous human approval available only for longer scopes", async t => {
 const signalStart=source.indexOf("      onSignal: (terminalSessionId, signal)");
 const signalCode=(await transform("result={"+source.slice(signalStart,source.indexOf("      onAnswerCaptureRevoked:",signalStart))+"};",{loader:"ts",format:"cjs"})).code;
 for(const duration of ["10m","session"]){
  let reads=0;
  const f=await setup(t,{getSecret:async()=>{reads+=1;return "fake-grant-value";}});
  f.working();const pending=f.request();assert.equal(pending.turnAvailable,true);
  const sandbox={result:null,console,terminalManager:f.terminals,humanQuestions:null,secretGrants:f.service,checkpointTurns:new Map(),
   timeline:{append:async()=>{}},agentControl:null};
  runInNewContext(signalCode,sandbox);
  sandbox.result.onSignal(f.row.id,{state:"idle",event:"Stop"});
  assert.equal(f.terminals.getMetadata(f.row.id).status,"idle","the production handler accepted completion");
  assert.deepEqual(f.service.pending(),[{...pending,turnAvailable:false}]);
  await assert.rejects(f.service.runSecretRequest(f.row.id,api),/Human approval is required/u);
  assert.equal(reads,0,"neither request nor idle nor an unapproved run reads the secret");
  assert.throws(()=>f.service.approve(pending.id,"turn"),/unavailable/u);
  if(duration==="session"){
   f.working(2);
   assert.throws(()=>f.service.approve(pending.id,"turn"),/unavailable/u,"a later active turn cannot be borrowed");
  }
  f.service.approve(pending.id,duration);
  await f.service.runSecretRequest(f.row.id,api);
  assert.equal(reads,1);assert.equal(f.runs.length,1);assert.equal(f.service.listGrants()[0].duration,duration);
 }
});

test("real guarded input preserves typing/approval/control replies but new prompt invalidates turn grants",async t=>{
 const f=await setup(t);f.working();const request=f.request();assert.equal(request.turnAvailable,true);
 assert.equal("turnIdentity" in request,false);f.service.approve(request.id,"turn");
 for(const input of ["typing","\x1b[A","\x03"]){assert.equal(f.terminals.inputChecked(f.row.id,input),true);assert.equal(f.service.listGrants().length,1);}
 f.terminals.applyProviderSignal(f.row.id,{kind:"lifecycle",state:"needs_approval",event:"PermissionRequest"});
 assert.equal(f.terminals.inputChecked(f.row.id,"y\r"),true);assert.equal(f.service.listGrants().length,1,"approval is same turn even before next working hook");
 await f.service.runSecretRequest(f.row.id,api);assert.equal(f.runs.length,1);
 f.terminals.applyProviderSignal(f.row.id,{kind:"lifecycle",state:"working",event:"PostToolUse"});
 f.terminals.inputChecked(f.row.id,"new task\r");assert.equal(f.service.listGrants().length,0);
 assert.equal(f.binding.getTurnIdentity(f.row.id),null,"new input cannot borrow preceding accepted working state");
 const stale=f.request();f.terminals.applyProviderSignal(f.row.id,{kind:"lifecycle",state:"idle",event:"Stop"});f.working(2);
 assert.throws(()=>f.service.approve(stale.id,"turn"),/unavailable/u);
});

test("turn changes and hook revocation during credential read prevent execution and never resurrect grants",async t=>{
 for(const invalidate of [f=>{f.epochs.set(f.row.id,2);},f=>f.bridge.setCoreHooksEnabled(false),f=>{f.calls.at(-1).process.emitExit(0);f.terminals.restart(f.row.id);}]){
  const read=deferred(),f=await setup(t,{getSecret:()=>read.promise});f.working();f.service.approve(f.request().id,"turn");
  const running=f.service.runSecretRequest(f.row.id,api);invalidate(f);read.resolve("fake-grant-value");
  await assert.rejects(running,/revoked|expired/u);assert.equal(f.runs.length,0);assert.equal(f.service.listGrants().length,0);
  f.bridge.setCoreHooksEnabled(true);assert.equal(f.service.listGrants().length,0);
 }
});

test("turn revocation aborts an active execution while 10m/session grant lifetimes survive",async t=>{
 const started=deferred();let signal;
 const f=await setup(t,{execute:request=>{signal=request.signal;started.resolve();return new Promise(()=>{});}});f.working();f.service.approve(f.request().id,"turn");
 const running=f.service.runSecretRequest(f.row.id,api);await started.promise;f.bridge.setCoreHooksEnabled(false);
 assert.equal(signal.aborted,true);await assert.rejects(running,/canceled/u);
 for(const duration of ["10m","session"]){
  const g=await setup(t);g.working();g.service.approve(g.request().id,duration);g.bridge.setCoreHooksEnabled(false);assert.equal(g.service.listGrants()[0].duration,duration);
 }
});

test("late runtime cleanup cannot invalidate replacement launch and unsupported prepared transport never gains authority",async t=>{
 const f=await setup(t);f.working();
 const first=f.bridge.prepareLaunch({terminalSessionId:"reused",provider:"codex",cwd:f.root});f.epochs.set("reused",1);
 const previous=f.bridge.currentTurnIdentity("reused");const next=f.bridge.prepareLaunch({terminalSessionId:"reused",provider:"codex",cwd:f.root});f.epochs.set("reused",1);
 const current=f.bridge.currentTurnIdentity("reused");assert.notEqual(current,previous);first.cleanup();assert.equal(f.bridge.currentTurnIdentity("reused"),current);next.cleanup();assert.equal(f.bridge.currentTurnIdentity("reused"),null);
 f.terminals.dispose(f.row.id);assert.equal(f.binding.getTurnIdentity(f.row.id),null);
});

test("failed replacement preparation promptly revokes the previous turn's active execution",async t=>{
 const started=deferred();let signal;
 const f=await setup(t,{launchEnvironment:{OPENCODE_CONFIG_CONTENT:"{invalid"},execute:request=>{signal=request.signal;started.resolve();return new Promise(()=>{});}});
 f.working();f.service.approve(f.request().id,"turn");const running=f.service.runSecretRequest(f.row.id,api);await started.promise;
 assert.throws(()=>f.bridge.prepareLaunch({terminalSessionId:f.row.id,provider:"opencode",cwd:f.root}),/JSON|invalid/iu);
 assert.equal(signal.aborted,true);await assert.rejects(running,/canceled/u);assert.equal(f.service.listGrants().length,0);
});

const panel=await importWithFakeReact("src/renderer/src/features/workspace/SecretGrantsPanel.tsx","SecretGrantsPanel");
test("secret grants panel disables unavailable turn approval while keeping explicit longer scopes",async t=>{
 const oldWindow=globalThis.window,oldDocument=globalThis.document;
 const requests=[{id:"request",sessionId:"s",secretId:"OPENAI_API_KEY",reason:"check",createdAt:1,expiresAt:99999,turnAvailable:false}];
 globalThis.document={hidden:false,addEventListener(){},removeEventListener(){}};
 globalThis.window={setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){},canvasTTY:{backlog:{secretRequests:async()=>requests,humanQuestions:null,secretGrants:async()=>[]}}};
 t.after(()=>{panel.__unmount();globalThis.window=oldWindow;globalThis.document=oldDocument;});panel.__reset();
 const props={sessionId:"s",sessions:[],locale:"en",onError:()=>{}};const render=()=>{panel.__flush();const child=panel.SecretGrantsPanel(props);return panel.__render(child.type,child.props);};
 render();await tick();let tree=render();const button=label=>findAll(tree,node=>node.type==="button"&&node.props.children===label)[0];
 assert.equal(button("Until this turn ends").props.disabled,true);assert.match(button("Until this turn ends").props.title,/cannot track/u);
 assert.equal(button("10 minutes").props.disabled,false);assert.equal(button("Until card closes").props.disabled,false);
 requests[0]={...requests[0],turnAvailable:true};await button("Refresh").props.onClick();await tick();tree=render();assert.equal(button("Until this turn ends").props.disabled,false);
});
