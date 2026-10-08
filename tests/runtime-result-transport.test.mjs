import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {AGENT_RUNTIME_ENV,CAPTURE_RESULT_ENV,OPENCODE_DECISIONS_ENV} from '../src/agent-runtime/runtime-protocol.mjs';
import {RuntimeGateway} from '../src/main/services/agent-runtime/RuntimeGateway.ts';
import {AgentRuntimeBridge} from '../src/main/services/agent-runtime/AgentRuntimeBridge.ts';
import {AgentControlService} from '../src/main/services/AgentControlService.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {createDiffOnlyReviewWorkspace} from '../src/main/services/DiffOnlyReviewWorkspace.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';

const POSIX={timeout:10_000,skip:process.platform==='win32'?'Real Unix socket roundtrip; pure launch/generation tests run on Windows.':false};
const helper=fileURLToPath(new URL('../src/agent-runtime/hook-helper.mjs',import.meta.url));
const plugin=fileURLToPath(new URL('../src/agent-runtime/opencode-plugin.mjs',import.meta.url));
function run(args,env,input=''){
 const child=spawn(process.execPath,args,{env:{...process.env,...env},stdio:['pipe','ignore','pipe']});
 const timeout=setTimeout(()=>child.kill(),5000);
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdin.end(input);
 return new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error(stderr||`exit ${code}`));});});
}
for(const provider of ['codex','opencode'])test(`${provider} readonly reviewer receives its actual configured result hook with lifecycle UI disabled`,POSIX,async t=>{
 const root=realpathSync(await mkdtemp(join(tmpdir(),'ctty-rt-'))),calls=[],registrations=[];
 let terminals;const gateway=new RuntimeGateway({runtimeDirectory:root,onSignal(id,signal){
  const accepted=terminals.applyProviderSignal(id,{state:signal.state,event:signal.event,requestId:signal.turnId});
  if(accepted&&signal.result)terminals.recordAnswer(id,signal.result,{turnId:signal.turnId});
 }});
 await gateway.start();
 const register=gateway.registerSession.bind(gateway);gateway.registerSession=(...args)=>{registrations.push(args);return register(...args);};
 const bridge=new AgentRuntimeBridge(gateway,{runtimeDirectory:join(root,'configs'),helper:{command:process.execPath,args:[helper]},
  permissionGate:{command:process.execPath,args:[fileURLToPath(new URL('../src/agent-runtime/permission-gate.mjs',import.meta.url))]},
  openCodePluginPath:plugin,coreHooksEnabled:false,wantsDecisions:()=>true,environment:{},
  kimiHomeDirectory:join(root,'kimi'),hermesHomeDirectory:join(root,'hermes'),grokHomeDirectory:join(root,'grok')});
 terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,bridge,false,fakeSpawner(calls));
 terminals.configureIsolation({containment:()=>true,decide:({profile})=>profile==='plan'?{apply:true,profile,isolation:{state:'on',layer:'seatbelt'}}:{apply:false,profile},
  wrap:launch=>({command:launch.command,args:[...launch.args],env:launch.env,cleanup(){}})});
 t.after(async()=>{terminals.disposeAll();await gateway.close();await rm(root,{recursive:true,force:true});});
 const parent=terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const reviewer=terminals.createReadOnlyReviewer({taskRootSessionId:parent.id,provider,model:provider==='opencode'?'fixture/review-model':'fixture-review-model',title:'Review: fixture',workspace:createDiffOnlyReviewWorkspace('+fixture')});
 assert.equal(reviewer.exitCode,null,reviewer.failureDetails);
 const launch=calls.at(-1),env=launch.options.env;
 assert.equal(env[CAPTURE_RESULT_ENV],'1');assert.ok(env[AGENT_RUNTIME_ENV.capabilityToken]);
 assert.equal(registrations.find(args=>args[0]===reviewer.id)[4],false,'read-only result lease has no decision privilege');
 assert.equal(env[OPENCODE_DECISIONS_ENV],undefined);
 assert.equal(env.CANVASTTY_CONTROL_CONNECTION,undefined);
 bridge.setCoreHooksEnabled(true);bridge.setCoreHooksEnabled(false);
 if(provider==='codex'){
  assert.ok(launch.args.some(arg=>arg.startsWith('hooks.Stop=')));
  assert.ok(!launch.args.some(arg=>arg.startsWith('hooks.PreToolUse=')));
  await run([helper,'working','UserPromptSubmit'],env,JSON.stringify({turn_id:'fixture-turn'}));
  await run([helper,'idle','Stop'],env,JSON.stringify({turn_id:'fixture-turn',last_assistant_message:'{"verdict":"accept","findings":"transport verified"}'}));
 }else{
  const configured=JSON.parse(env.OPENCODE_CONFIG_CONTENT).plugin;
  assert.ok(configured.some(path=>path.includes('opencode-plugin.mjs')));
  await run(['--input-type=module','-e',`
   const {CanvasTTYLifecycle}=await import(${JSON.stringify(new URL('../src/agent-runtime/opencode-plugin.mjs',import.meta.url).href)});
   const hooks=await CanvasTTYLifecycle({client:{session:{messages:async()=>({data:[{info:{role:'assistant'},parts:[{type:'text',text:'{"verdict":"accept","findings":"transport verified"}'}]}]})}}});
   const event=(type,properties)=>hooks.event({event:{type,properties}});
   await event('session.created',{info:{id:'fixture-root'}});
   await event('session.status',{sessionID:'fixture-root',status:{type:'busy'}});
   await event('session.status',{sessionID:'fixture-root',status:{type:'idle'}});
   await event('session.idle',{sessionID:'fixture-root'});
  `],env);
 }
 assert.match(terminals.answer(reviewer.id)?.text??'',/transport verified/u);
 assert.equal(terminals.getMetadata(reviewer.id).status,'unavailable','capture did not turn lifecycle UI back on');
 assert.equal(bridge.currentStatus(reviewer.id),null);
 terminals.dispose(reviewer.id);assert.equal(gateway.currentStatus(reviewer.id),null,'cleanup revokes the result lease');
});


test('UI-disabled worker and readonly reviewer complete an actual accepted review through configured runtime hooks',POSIX,async t=>{
 const root=realpathSync(await mkdtemp(join(tmpdir(),'ctty-rr-'))),calls=[],children=[],prompts=[];
 let terminals,control,reviewing=false,reviewChild;
 const gateway=new RuntimeGateway({runtimeDirectory:root,onSignal(id,signal){
  const accepted=terminals.applyProviderSignal(id,{state:signal.state,event:signal.event,requestId:signal.turnId});
  if(!accepted)return;
  if(signal.result)terminals.recordAnswer(id,signal.result,{turnId:signal.turnId});
 }});await gateway.start();
 const bridge=new AgentRuntimeBridge(gateway,{runtimeDirectory:join(root,'configs'),helper:{command:process.execPath,args:[helper]},openCodePluginPath:plugin,
  coreHooksEnabled:false,environment:{},kimiHomeDirectory:join(root,'kimi'),hermesHomeDirectory:join(root,'hermes'),grokHomeDirectory:join(root,'grok')});
 const fake=fakeSpawner(calls,{onWrite(data){if(data.includes('Review only the supplied answer')){prompts.push(data);reviewChild.stdin.end(data);}}});
 terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,bridge,false,(...args)=>{
  const pty=fake(...args);
  if(reviewing){
   const script=`
    const {CanvasTTYLifecycle}=await import(${JSON.stringify(new URL('../src/agent-runtime/opencode-plugin.mjs',import.meta.url).href)});
    const hooks=await CanvasTTYLifecycle({client:{session:{messages:async()=>({data:[{info:{role:'assistant'},parts:[{type:'text',text:'{"verdict":"accept","findings":"real result transport"}'}]}]})}}});
    const event=(type,rest={})=>hooks.event({event:{type,properties:{sessionID:'review-root',...rest}}});
    await new Promise(done=>process.stdin.once('data',done));
    await event('session.created',{info:{id:'review-root'}});
    await event('session.status',{status:{type:'busy'}});await event('session.status',{status:{type:'idle'}});await event('session.idle');
   `;
   reviewChild=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,...args[2].env},stdio:['pipe','ignore','pipe']});
   let stderr='';reviewChild.stderr.on('data',chunk=>stderr+=chunk);
   queueMicrotask(()=>pty.emitData('Ask anything…\nctrl+p commands\n'));
   children.push(new Promise((resolve,reject)=>{reviewChild.on('error',reject);reviewChild.on('close',code=>code===0?resolve():reject(new Error(stderr||`exit ${code}`)));}));
  }
  return pty;
 });
 terminals.configureIsolation({containment:()=>true,decide:({profile})=>profile==='plan'?{apply:true,profile,isolation:{state:'on',layer:'seatbelt'}}:{apply:false,profile},
  wrap:launch=>({command:launch.command,args:[...launch.args],env:launch.env,cleanup(){}})});
 t.after(async()=>{reviewChild?.kill();for(const row of terminals.listMetadata())control?.forgetSession(row.id);terminals.disposeAll();await Promise.allSettled(children);await gateway.close();await rm(root,{recursive:true,force:true});});
 control=new AgentControlService(terminals,{reviewModel:()=> 'fixture/reviewer',reviewDiff:async()=>'+worker change',reviewStartupMs:3000,reviewTimeoutMs:3000,waitTiming:{checkMs:5,settleMs:0,quietMs:1000}});
 const parent=terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const worker=await control.spawn({parentSessionId:parent.id,provider:'opencode',cwd:root,review:true});
 const env=calls.at(-1).options.env;
 reviewing=true;
 terminals.input(worker.id,'worker task\r');
 await run(['--input-type=module','-e',`
  const {CanvasTTYLifecycle}=await import(${JSON.stringify(new URL('../src/agent-runtime/opencode-plugin.mjs',import.meta.url).href)});
  const hooks=await CanvasTTYLifecycle({client:{session:{messages:async()=>({data:[{info:{role:'assistant'},parts:[{type:'text',text:'worker final answer'}]}]})}}});
  const event=(type,rest={})=>hooks.event({event:{type,properties:{sessionID:'worker-root',...rest}}});
  await event('session.created',{info:{id:'worker-root'}});await event('session.status',{status:{type:'busy'}});
  await event('session.status',{status:{type:'idle'}});await event('session.idle');
 `],env);
 assert.equal(terminals.getMetadata(worker.id).status,'unavailable');
 const result=await control.resultWithReview(worker.id);
 assert.equal(result.review.status,'accepted',result.review.reason);
 assert.match(prompts[0],/worker final answer/u);assert.equal(prompts.length,1);
 assert.equal(terminals.getMetadata(result.review.reviewerSessionId).status,'unavailable');
 const waited=await control.waitFor(worker.id,{timeoutMs:100});assert.equal(waited.reason,'idle');assert.equal(waited.review.status,'accepted');
 await Promise.all(children);
});
