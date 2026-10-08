import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {request as httpRequest} from 'node:http';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';
import {RuntimeGateway} from '../src/main/services/agent-runtime/RuntimeGateway.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';
import {AGENT_RUNTIME_ENV,CLAUDE_HTTP_HOOK} from '../src/agent-runtime/runtime-protocol.mjs';
import {IMPLEMENTATIONS,SKIP_NATIVE,baseEnvironment,runOnce} from './native-helper-harness.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const windowsHostPath=join(process.cwd(),'build/windows-agent-pipe-host/canvastty-windows-agent-pipe-host.exe');
async function fixture(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'ctty-barrier-')),signals=[];
 const gateway=new RuntimeGateway({runtimeDirectory:root,windowsHostPath,onSignal:(id,signal)=>signals.push({id,signal}),...options});
 await gateway.start();t.after(async()=>{await gateway.close();await rm(root,{recursive:true,force:true});});return{gateway,signals};
}
function send(capability,event='pre_llm_call',turnId='one',extra={}){
 const {address,...identity}=capability;
 const socket=createConnection(address),done=new Promise(resolve=>{socket.on('data',()=>{socket.destroy();resolve(true);});socket.on('error',()=>resolve(false));socket.on('close',()=>resolve(false));});
 socket.on('connect',()=>socket.write(JSON.stringify({v:1,type:'lifecycle',...identity,state:'working',event,turnId,...extra})+'\n'));
 return {socket,done};
}
for(const implementation of IMPLEMENTATIONS)test(`Grok ${implementation.name} hook waits for the checkpoint before ack, with no decision hooks`,{skip:implementation.name==='native'?SKIP_NATIVE:false,timeout:5000},async t=>{
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());let saved=false;
 const f=await fixture(t,{beforeLifecycle:async(_id,_signal,cancel)=>{entered.resolve();await release.promise;cancel.throwIfAborted();saved=true;}});
 const cap=f.gateway.registerSession('grok-auto','grok',false,undefined,false);
 const env=baseEnvironment(Object.fromEntries(Object.entries(AGENT_RUNTIME_ENV).map(([key,name])=>[name,cap[key]])));
 let exited=false;const running=runOnce(implementation.hook('working','pre_llm_call'),{env,input:'{"turn_id":"one"}'}).then(result=>{exited=true;return result;});
 await entered.promise;await tick();assert.equal(exited,false);assert.equal(saved,false);assert.equal(f.signals.length,0);
 release.resolve();assert.equal((await running).code,0);assert.equal(saved,true);await tick();assert.equal(f.signals.length,1);
});

test('Claude HTTP turn-start acknowledgement uses the same checkpoint barrier',{skip:process.platform==='win32'?'HTTP lifecycle hooks are POSIX-only':false,timeout:5000},async t=>{
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());const f=await fixture(t,{httpHooks:true,beforeLifecycle:async()=>{entered.resolve();await release.promise;}});
 const cap=f.gateway.registerSession('claude','claude'),url=new URL('/claude/v1/working/UserPromptSubmit',f.gateway.httpHookBase);let answered=false;
 const done=new Promise((resolve,reject)=>{const req=httpRequest(url,{method:'POST',headers:{'content-type':'application/json',[CLAUDE_HTTP_HOOK.sessionHeader]:cap.terminalSessionId,[CLAUDE_HTTP_HOOK.capabilityHeader]:cap.capabilityToken}},res=>{res.resume();res.on('end',()=>{answered=true;resolve(res.statusCode);});});req.on('error',reject);req.end('{"prompt_id":"one"}');});
 await entered.promise;await tick();assert.equal(answered,false);release.resolve();assert.equal(await done,200);
});

test('unauthenticated and stale starts never checkpoint; timeout and throw are bounded',{timeout:5000},async t=>{
 const calls=[],entered=deferred();let mode='ok';const f=await fixture(t,{lifecycleBarrierMs:25,beforeLifecycle:async(_id,signal,cancel)=>{
  calls.push(signal.turnId);if(mode==='throw')throw new Error('fixture checkpoint failed');if(mode==='hold'){entered.resolve(cancel);await new Promise(()=>{});}
 }});const cap=f.gateway.registerSession('grok','grok');
 assert.equal(await send(cap,'pre_llm_call','one',{capabilityToken:'x'.repeat(43)}).done,false);assert.deepEqual(calls,[]);
 await send(cap,'pre_llm_call','one').done;await send(cap,'pre_llm_call','two').done;await send(cap,'pre_llm_call','one').done;assert.deepEqual(calls,['one','two']);
 mode='throw';assert.equal(await send(cap,'pre_llm_call','three').done,true);
 mode='hold';const held=send(cap,'pre_llm_call','four');const cancel=await entered.promise;assert.equal(await held.done,true);assert.equal(cancel.aborted,true);
 const revoked=f.gateway.registerSession('revoked','grok');const pending=send(revoked);await tick();f.gateway.revokeTerminalSession('revoked');await pending.done;
});

// Execute the exact production checkpoint callbacks, while replacing only their host services.
const index=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8');
const cacheSource=index.slice(index.indexOf('  const checkpointTurns ='),index.indexOf('  diagnostics.configureRedaction'));
const callbacksSource=index.slice(index.indexOf('      lifecycleGuard:'),index.indexOf('      onSignal:',index.indexOf('      lifecycleGuard:')));
const callbackCode=(await transform(cacheSource+'\nresult={'+callbacksSource+'}; result.checkpointBeforeTurn=checkpointBeforeTurn;' ,{loader:'ts',format:'cjs'})).code;

test('production barrier skips ineligible sessions, deduplicates success and rejects stale host input even while cleanup is held',{timeout:5000},async t=>{
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));t.after(()=>terminals.disposeAll());
 const normal=terminals.create({provider:'grok',profile:'normal',cwd:process.cwd(),position:{x:0,y:0}});
 const worker=terminals.create({provider:'grok',profile:'yolo',cwd:process.cwd(),position:{x:0,y:0}});
 terminals.resize(worker.id,80,24);assert.ok(terminals.sessions.get(worker.id).process,'Grok starts after its measured grid');
 const entered=deferred(),release=deferred(),signals=[];t.after(()=>release.resolve());let captures=0,hold=false;
 const sandbox={timeline:{append:async()=>{}},terminalManager:terminals,checkpoints:{capture:async(_id,_cwd,signal)=>{captures++;if(hold){entered.resolve(signal);await release.promise;signal.throwIfAborted();}}},redaction:{redact:text=>text},console,AbortController,result:null};
 runInNewContext(callbackCode,sandbox);
 const f=await fixture(t,{...sandbox.result,lifecycleBarrierMs:35,onSignal:(id,signal)=>{signals.push(signal.turnId);terminals.applyProviderSignal(id,{state:signal.state,event:signal.event});}});
 const norm=f.gateway.registerSession(normal.id,'grok');await send(norm).done;assert.equal(captures,0);
 const cap=f.gateway.registerSession(worker.id,'grok');await send(cap,'pre_llm_call','first').done;await send(cap,'pre_llm_call','first').done;assert.equal(captures,1);
 // A new input needs a new checkpoint even before the previous turn's idle hook arrives.
 assert.equal(terminals.inputChecked(worker.id,'interrupt old turn\r'),true);await send(cap,'pre_llm_call','interrupted').done;assert.equal(captures,2);
 // End the turn so the next attempt receives its own checkpoint.
 await send(cap,'Stop','interrupted',{state:'idle'}).done;assert.equal(terminals.inputChecked(worker.id,'next task\r'),true);hold=true;
 const old=send(cap,'pre_llm_call','old'),cancel=await entered.promise;
 assert.equal(terminals.inputChecked(worker.id,'new task\r'),true);assert.equal(cancel.aborted,true);
 await old.done;await tick();assert.ok(!signals.includes('old'),'timeout must not bypass the independent host freshness token');
 release.resolve();await tick();hold=false;await send(cap,'pre_llm_call','new').done;await tick();assert.ok(signals.includes('new'));assert.equal(captures,4);
 assert.equal(terminals.inputWriteObservers.get(worker.id)?.size??0,0,'every barrier unregisters its temporary observer');
});

test('fast OpenCode busy then idle keeps ordered UI delivery and its final answer after the start ack',{timeout:5000},async t=>{
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));t.after(()=>terminals.disposeAll());
 const parent=terminals.create({provider:'codex',profile:'normal',role:'orchestrator',cwd:process.cwd(),position:{x:0,y:0}});
 const session=terminals.create({provider:'opencode',profile:'normal',role:'subagent',parentSessionId:parent.id,cwd:process.cwd(),position:{x:0,y:0}},{origin:'subagent',captureResult:true}),events=[];
 const f=await fixture(t,{
  beforeLifecycle:async()=>{},lifecycleGuard:(id,signal)=>terminals.providerSignalGuard(id,{state:signal.state,event:signal.event,requestId:signal.turnId}),
  onSignal:(id,signal)=>{const accepted=terminals.applyProviderSignal(id,{state:signal.state,event:signal.event,requestId:signal.turnId});assert.equal(accepted,true);events.push(signal.state);if(signal.result)terminals.recordAnswer(id,signal.result,{turnId:signal.turnId});}
 });
 const cap=f.gateway.registerSession(session.id,'opencode',true),queued=[],deliver=f.gateway.deliverLater.bind(f.gateway);
 f.gateway.deliverLater=value=>queued.push(value);
 await send(cap,'session.status:busy','turn-one').done;
 await send(cap,'session.idle','turn-one',{state:'idle',result:{text:'fresh answer',truncated:false}}).done;
 for(const value of queued)deliver(value);await tick();
 assert.deepEqual(events,['working','idle']);assert.equal(terminals.sessions.get(session.id).turnStarts,1);
 assert.equal(terminals.sessions.get(session.id).answer.text,'fresh answer');
});

for(const action of ['disconnect','revoke','supersede'])test(`an in-flight lifecycle barrier observes ${action} before any late checkpoint can complete`,{timeout:5000},async t=>{
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());let saved=false;
 const f=await fixture(t,{beforeLifecycle:async(_id,signal,cancel)=>{if(signal.turnId!=='old')return;entered.resolve(cancel);await release.promise;cancel.throwIfAborted();saved=true;}});
 const cap=f.gateway.registerSession('grok','grok'),old=send(cap,'pre_llm_call','old'),cancel=await entered.promise;
 if(action==='disconnect')old.socket.destroy();
 else if(action==='revoke')f.gateway.revokeTerminalSession('grok');
 else await send(cap,'pre_llm_call','new').done;
 await old.done;
 if(!cancel.aborted)await new Promise(resolve=>cancel.addEventListener('abort',resolve,{once:true}));
 assert.equal(cancel.aborted,true);release.resolve();await tick();assert.equal(saved,false);
 if(action!=='disconnect')assert.ok(!f.signals.some(row=>row.signal.turnId==='old'));
});

for(const [label,input,approval,changesTurn] of [
 ['typing','draft',false,false],['Control-C','\x03',false,false],['approval reply','y\r',true,false],['new submitted task','next task\r',false,true]
])test(`production checkpoint observer handles ${label} according to the actual turn generation`,{timeout:5000},async t=>{
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));t.after(()=>terminals.disposeAll());
 const worker=terminals.create({provider:'codex',profile:'yolo',cwd:process.cwd(),position:{x:0,y:0}});
 if(approval)terminals.applyProviderSignal(worker.id,{state:'needs_approval',event:'PermissionRequest'});
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());let saved=false;
 const sandbox={timeline:{append:async()=>{}},terminalManager:terminals,checkpoints:{capture:async(_id,_cwd,signal)=>{entered.resolve(signal);await release.promise;signal.throwIfAborted();saved=true;}},redaction:{redact:text=>text},console,AbortController,result:null};
 runInNewContext(callbackCode,sandbox);
 const pending=sandbox.result.beforeLifecycle(worker.id,{state:'working',event:'pre_llm_call',turnId:null},new AbortController().signal);
 const signal=await entered.promise;assert.equal(terminals.inputChecked(worker.id,input),true);
 assert.equal(signal.aborted,changesTurn);release.resolve();assert.equal(await pending,!changesTurn);assert.equal(saved,!changesTurn);
 assert.equal(terminals.inputWriteObservers.get(worker.id)?.size??0,0);
});

for(const mode of ['aborted','failed'])test(`production checkpoint ${mode} attempt remains unavailable through PostToolUse and approval until a new submitted turn`,{timeout:5000},async t=>{
 const terminals=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner([]));t.after(()=>terminals.disposeAll());
 const worker=terminals.create({provider:'grok',profile:'yolo',cwd:process.cwd(),position:{x:0,y:0}});terminals.resize(worker.id,80,24);
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());let captures=0;
 const sandbox={timeline:{append:async()=>{}},terminalManager:terminals,checkpoints:{capture:async(_id,_cwd,signal)=>{captures++;if(captures===1){entered.resolve();await release.promise;if(mode==='aborted')signal.throwIfAborted();throw new Error('capture failed');}}},redaction:{redact:x=>x},console:{warn(){}},AbortController,result:null};runInNewContext(callbackCode,sandbox);
 const cancel=new AbortController();const first=sandbox.result.beforeLifecycle(worker.id,{state:'working',event:'pre_llm_call'},cancel.signal);await entered.promise;
 if(mode==='aborted')cancel.abort();
 const post=sandbox.result.beforeLifecycle(worker.id,{state:'working',event:'PostToolUse'},new AbortController().signal);
 terminals.applyProviderSignal(worker.id,{state:'needs_approval'});
 const approval=sandbox.result.checkpointBeforeTurn(worker.id,new AbortController().signal);
 assert.equal(captures,1,'cleanup still pending must not allow a second capture');release.resolve();await Promise.all([first,post,approval]);
 await sandbox.result.checkpointBeforeTurn(worker.id,new AbortController().signal);assert.equal(captures,1,'settled failure remains an attempted turn');
 terminals.applyProviderSignal(worker.id,{state:'idle'});assert.equal(terminals.inputChecked(worker.id,'new task\r'),true);
 await sandbox.result.beforeLifecycle(worker.id,{state:'working',event:'pre_llm_call'},new AbortController().signal);assert.equal(captures,2);
});

test('restoration invalidates held pre-turn delivery and prevents late hooks snapshotting the restored generation', {timeout:5000},async t=>{
 const paused=new Set(),pause={supported:true,isPaused:p=>paused.has(p),pause(p){paused.add(p);return{supported:true};},resume(p){paused.delete(p);return{supported:true};}};
 const terminals=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner([]),pause);t.after(()=>terminals.disposeAll());
 const worker=terminals.create({provider:'grok',profile:'yolo',cwd:process.cwd(),position:{x:0,y:0}});terminals.resize(worker.id,80,24);terminals.applyProviderSignal(worker.id,{state:'idle'});
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());let captures=0;
 const sandbox={timeline:{append:async()=>{}},terminalManager:terminals,checkpoints:{capture:async()=>{captures++;if(captures===1){entered.resolve();await release.promise;}}},redaction:{redact:x=>x},console,AbortController,result:null};runInNewContext(callbackCode,sandbox);
 const first=sandbox.result.beforeLifecycle(worker.id,{state:'working',event:'pre_llm_call'},new AbortController().signal);await entered.promise;
 await terminals.withCheckpointRestore(worker.id,async()=>{});release.resolve();assert.equal(await first,false);
 await sandbox.result.beforeLifecycle(worker.id,{state:'working',event:'PostToolUse'},new AbortController().signal);
 await sandbox.result.checkpointBeforeTurn(worker.id,new AbortController().signal);assert.equal(captures,1);
 assert.equal(terminals.inputChecked(worker.id,'genuinely new task\r'),true);await sandbox.result.beforeLifecycle(worker.id,{state:'working',event:'pre_llm_call'},new AbortController().signal);assert.equal(captures,2);
});

test('accepted turn end clears a failed attempt; permission callbacks deny during restore and recheck after checkpoint await',{timeout:5000},async t=>{
 const signalSource=index.slice(index.indexOf('      onSignal: (terminalSessionId, signal)'),index.indexOf('      onAnswerCaptureRevoked:'));
 const permissionSource=index.slice(index.indexOf('      onPermissionRequest: async (terminalSessionId'),index.indexOf('      // Claude Code\'s lifecycle hooks'));
 const code=(await transform(cacheSource+'\nresult={'+callbacksSource+signalSource+permissionSource+'};',{loader:'ts',format:'cjs'})).code;
 const paused=new Set(),pause={supported:true,isPaused:p=>paused.has(p),pause(p){paused.add(p);return{supported:true};},resume(p){paused.delete(p);return{supported:true};}};
 const terminals=new TerminalManager(()=>{},availableRegistry(),undefined,undefined,true,fakeSpawner([]),pause);t.after(()=>terminals.disposeAll());
 const worker=terminals.create({provider:'grok',profile:'yolo',cwd:process.cwd(),position:{x:0,y:0}});terminals.resize(worker.id,80,24);terminals.applyProviderSignal(worker.id,{state:'idle'});
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());let captures=0,decisions=0,hold=false;const ended=[];
 const sandbox={humanQuestions:null,secretGrants:{turnEnded:id=>ended.push(id),revalidateTurn:()=>{}},timeline:{append:async()=>{}},terminalManager:terminals,checkpoints:{capture:async()=>{captures++;if(hold){entered.resolve();await release.promise;}else throw new Error('unavailable');}},redaction:{redact:x=>x},console:{warn(){}},AbortController,agentControl:undefined,evenG2:undefined,budgetInputGate:()=>{},decisionHooks:{decide:()=>{decisions++;return{behavior:'allow'};}},result:null};runInNewContext(code,sandbox);
 await sandbox.result.beforeLifecycle(worker.id,{state:'working'},new AbortController().signal);assert.equal(captures,1);
 sandbox.result.onSignal(worker.id,{state:'idle'});
 await sandbox.result.beforeLifecycle(worker.id,{state:'working'},new AbortController().signal);assert.equal(captures,2,'an accepted end allows the next provider turn');
 sandbox.result.onSignal(worker.id,{state:'idle'});hold=true;assert.deepEqual(ended,[worker.id,worker.id],'accepted idle signals revoke turn grants');
 const pending=sandbox.result.onPermissionRequest(worker.id,{},new AbortController().signal);await entered.promise;
 await terminals.withCheckpointRestore(worker.id,async()=>{sandbox.result.onSignal(worker.id,{state:'idle'});assert.equal(ended.length,2,'rejected stale signals cannot revoke grants');const answer=await sandbox.result.onPermissionRequest(worker.id,{},new AbortController().signal);assert.equal(answer.behavior,'deny');});
 release.resolve();assert.equal((await pending).behavior,'deny');assert.equal(decisions,0);
});
