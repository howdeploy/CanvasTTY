import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {request as httpRequest} from 'node:http';
import {RuntimeGateway} from '../src/main/services/agent-runtime/RuntimeGateway.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {createCheckpointTurnBarrier} from '../src/main/services/checkpointTurnBarrier.ts';
import {GitCheckpoints} from '../src/main/services/GitCheckpoints.ts';
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


// The production callbacks (main/index.ts wires these into RuntimeGateway and onPermissionRequest).
function barrierFixture(t,capture,profile='yolo',options={}){
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));t.after(()=>terminals.disposeAll());
 const worker=terminals.create({provider:'codex',profile,cwd:process.cwd(),position:{x:0,y:0}});terminals.resize(worker.id,80,24);
 const barrier=createCheckpointTurnBarrier({terminals:()=>terminals,checkpoints:{capture},redact:text=>text,warn(){},...options});
 return{terminals,worker,barrier};
}
const working={state:'working',event:'pre_llm_call'};

const status=(terminals,id,state)=>terminals.applyProviderSignal(id,{kind:'lifecycle',state});
test('one rollback point per agent turn: the hook turn id or, without one, a submit while the card is not working',async t=>{
 let captures=0;const capture=async()=>{captures++;};
 const manual=barrierFixture(t,capture,'normal');
 assert.equal(await manual.barrier.beforeLifecycle(manual.worker.id,working,new AbortController().signal),true);assert.equal(captures,0);
 const {terminals,worker,barrier}=barrierFixture(t,capture);
 await barrier.beforeLifecycle(worker.id,{...working,turnId:'one'},new AbortController().signal);status(terminals,worker.id,'working');
 await barrier.beforeLifecycle(worker.id,{state:'working',event:'PostToolUse',turnId:'one'},new AbortController().signal);
 assert.equal(await barrier.beforePermission(worker.id,new AbortController().signal),null);assert.equal(captures,1,'a permission inside a known turn takes none');
 assert.equal(terminals.inputChecked(worker.id,'1\r'),true,'answering a prompt or menu inside the turn');
 await barrier.beforeLifecycle(worker.id,{state:'working',event:'PostToolUse'},new AbortController().signal);assert.equal(captures,1,'an Enter inside a running turn is not a new turn');
 await barrier.beforeLifecycle(worker.id,{...working,turnId:'two'},new AbortController().signal);assert.equal(captures,2,'a new hook turn id is a new turn');
 barrier.onSignal(worker.id,'needs_approval');await barrier.beforeLifecycle(worker.id,{...working,turnId:'two'},new AbortController().signal);assert.equal(captures,2,'an approval stays in the turn');
 barrier.onSignal(worker.id,'idle');status(terminals,worker.id,'idle');
 assert.equal(terminals.inputChecked(worker.id,'typing without submit'),true);
 assert.equal(terminals.inputChecked(worker.id,'next task\r'),true);
 await barrier.beforeLifecycle(worker.id,working,new AbortController().signal);assert.equal(captures,3,'a turn end and a submitted prompt start the next turn');
 await barrier.beforeLifecycle(worker.id,working,new AbortController().signal);assert.equal(captures,3);
 barrier.forget(worker.id);terminals.dispose(worker.id);await barrier.beforeLifecycle(worker.id,working,new AbortController().signal);assert.equal(captures,3,'a closed card gets none');
});

test('a permission decision takes a point only when no turn is known, bounded in time',{timeout:5000},async t=>{
 let captures=0,aborted=null;
 const {worker,barrier}=barrierFixture(t,async(_id,_cwd,signal)=>{captures++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));aborted=signal.aborted;throw signal.reason;},'yolo',{barrierMs:30});
 const started=Date.now();assert.equal(await barrier.beforePermission(worker.id,new AbortController().signal),null);
 assert.ok(Date.now()-started<1000);await tick();assert.equal(aborted,true,'the capture is cancelled at the bound');assert.equal(captures,1);
 assert.equal(await barrier.beforePermission(worker.id,new AbortController().signal),null);assert.equal(captures,1,'not retried within the turn');
});

for(const mode of ['aborted','failed'])test(`a ${mode} rollback point is not retried within its turn (it would snapshot the turn's own edits)`,async t=>{
 const entered=deferred(),release=deferred();let captures=0;
 const {terminals,worker,barrier}=barrierFixture(t,async(_id,_cwd,signal)=>{captures++;if(captures===1){entered.resolve();await release.promise;if(mode==='aborted')signal.throwIfAborted();throw new Error('capture failed');}});
 const cancel=new AbortController();const first=barrier.beforeLifecycle(worker.id,working,cancel.signal);await entered.promise;
 // A barrier cancelled with no other barrier of the turn waiting cancels the capture (after the current callback).
 if(mode==='aborted'){cancel.abort();await first;await tick();}
 const post=barrier.beforeLifecycle(worker.id,{state:'working',event:'PostToolUse'},new AbortController().signal);
 const permission=barrier.beforePermission(worker.id,new AbortController().signal);
 release.resolve();await Promise.all([first,post,permission]);assert.equal(captures,1);
 await barrier.beforeLifecycle(worker.id,working,new AbortController().signal);assert.equal(captures,1,'a settled failure still counts for this turn');
 assert.equal(terminals.inputChecked(worker.id,'new task\r'),true);
 await barrier.beforeLifecycle(worker.id,working,new AbortController().signal);assert.equal(captures,2);
});

test('a turn that changed while its rollback point was taken is stale: the start is dropped and the permission denied',async t=>{
 const entered=deferred(),release=deferred();
 const {terminals,worker,barrier}=barrierFixture(t,async()=>{entered.resolve();await release.promise;});
 const permission=barrier.beforePermission(worker.id,new AbortController().signal);
 const start=barrier.beforeLifecycle(worker.id,working,new AbortController().signal);
 await entered.promise;assert.equal(terminals.inputChecked(worker.id,'something else\r'),true);release.resolve();
 assert.equal(await start,false);assert.match(await permission,/turn changed/u);
 assert.equal(barrier.lifecycleGuard(worker.id)(),true,'the new turn is current');
 assert.equal(barrier.lifecycleGuard('missing')(),false);
});

test('a permission decision waits for the current turn\'s point in flight, and takes one for a stale turn',{timeout:5000},async t=>{
 const entered=deferred(),release=deferred();let captures=0,settled=false;
 const {terminals,worker,barrier}=barrierFixture(t,async()=>{captures++;if(captures===1){entered.resolve();await release.promise;settled=true;}},'yolo',{barrierMs:2000});
 const start=barrier.beforeLifecycle(worker.id,{...working,turnId:'one'},new AbortController().signal);await entered.promise;
 const permission=barrier.beforePermission(worker.id,new AbortController().signal);await tick();
 assert.equal(settled,false);release.resolve();assert.equal(await permission,null);assert.equal(settled,true,'the decision waited for the point');assert.equal(captures,1);await start;
 // The person submitted a new prompt while the card was idle: the known entry is stale.
 status(terminals,worker.id,'idle');assert.equal(terminals.inputChecked(worker.id,'next\r'),true);
 assert.equal(await barrier.beforePermission(worker.id,new AbortController().signal),null);assert.equal(captures,2,'a stale turn gets its point at the permission');
});

test('a reported turn id never revives a turn the person moved past',async t=>{
 let captures=0;const {terminals,worker,barrier}=barrierFixture(t,async()=>{captures++;});
 await barrier.beforeLifecycle(worker.id,{...working,turnId:'one'},new AbortController().signal);assert.equal(captures,1);
 status(terminals,worker.id,'idle');assert.equal(terminals.inputChecked(worker.id,'next\r'),true);
 await barrier.beforeLifecycle(worker.id,{...working,turnId:'one'},new AbortController().signal);assert.equal(captures,2);
});

test('the runtime gateway holds a working hook for the production barrier and drops the stale start',{timeout:5000},async t=>{
 const entered=deferred(),release=deferred();let captures=0;
 const {terminals,worker,barrier}=barrierFixture(t,async()=>{captures++;entered.resolve();await release.promise;});
 const f=await fixture(t,{lifecycleGuard:id=>barrier.lifecycleGuard(id),beforeLifecycle:(id,signal,cancel)=>barrier.beforeLifecycle(id,signal,cancel)});
 const cap=f.gateway.registerSession(worker.id,'codex');
 const held=send(cap,'pre_llm_call','old');await entered.promise;
 assert.equal(terminals.inputChecked(worker.id,'new task\r'),true);release.resolve();
 assert.equal(await held.done,true,'the hook is answered (fail-open)');await tick();
 assert.ok(!f.signals.some(row=>row.signal.turnId==='old'),'a stale turn start never reaches the app');assert.equal(captures,1);
});

test('a CLI that stays working (no turn-end hook): a new prompt without a turn id takes a new point once input was submitted',async t=>{
 let captures=0;const {terminals,worker,barrier}=barrierFixture(t,async()=>{captures++;});
 const prompt={state:'working',event:'UserPromptSubmit'};
 await barrier.beforeLifecycle(worker.id,prompt,new AbortController().signal);status(terminals,worker.id,'working');assert.equal(captures,1);
 await barrier.beforeLifecycle(worker.id,prompt,new AbortController().signal);assert.equal(captures,1,'no input since the point: the same turn');
 assert.equal(terminals.inputChecked(worker.id,'next task\r'),true,'submitted while the card still shows working');
 await barrier.beforeLifecycle(worker.id,{state:'working',event:'PostToolUse'},new AbortController().signal);assert.equal(captures,1,'a tool event is not a new prompt');
 await barrier.beforeLifecycle(worker.id,prompt,new AbortController().signal);assert.equal(captures,2,'the new prompt gets its own point');
 status(terminals,worker.id,'needs_approval');assert.equal(terminals.inputChecked(worker.id,'1\r'),true,'answering an approval');status(terminals,worker.id,'working');
 await barrier.beforeLifecycle(worker.id,prompt,new AbortController().signal);assert.equal(captures,2,'an approval answer is not a new prompt');
});

test('a failing HTTP lifecycle barrier still answers the hook',{skip:process.platform==='win32'?'HTTP lifecycle hooks are POSIX-only':false,timeout:5000},async t=>{
 const f=await fixture(t,{httpHooks:true,beforeLifecycle:async()=>undefined});
 f.gateway.waitBeforeLifecycle=async()=>{throw new Error('fixture barrier failed');};
 const cap=f.gateway.registerSession('claude','claude'),url=new URL('/claude/v1/working/UserPromptSubmit',f.gateway.httpHookBase);
 const status=await new Promise((resolve,reject)=>{const req=httpRequest(url,{method:'POST',headers:{'content-type':'application/json',[CLAUDE_HTTP_HOOK.sessionHeader]:cap.terminalSessionId,[CLAUDE_HTTP_HOOK.capabilityHeader]:cap.capabilityToken}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{"prompt_id":"one"}');});
 assert.equal(status,200);
});

// Live (OpenCode, auto profile): a send_to_agent follow-up into an idle card reports its turn start, then
// session.status:busy again for the same turn about 150-370 ms later, independent of the first hook's answer. A capture
// takes 200-300 ms, so the second signal can arrive while it runs: it supersedes the first barrier (RuntimeGateway), and
// a capture tied to that barrier was aborted ("AbortError: This operation was aborted"), leaving the turn without a point.
test('a follow-up prompt keeps its rollback point when a second lifecycle signal of the same turn arrives (real Git project)',{skip:process.platform==='win32'?'the lifecycle socket fixture is POSIX-only':false,timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'ctty-followup-')),project=join(root,'project');
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
 git('init','-q',project);git('-C',project,'config','user.name','Fixture');git('-C',project,'config','user.email','fixture@example.invalid');
 await writeFile(join(project,'file.txt'),'base');git('-C',project,'add','.');git('-C',project,'commit','-qm','base');
 const checkpoints=new GitCheckpoints(text=>text,10,join(root,'registry.json'));
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));
 t.after(async()=>{terminals.disposeAll();await checkpoints.idle();await rm(root,{recursive:true,force:true});});
 const worker=terminals.create({provider:'codex',profile:'auto',cwd:project,position:{x:0,y:0}});terminals.resize(worker.id,80,24);
 // The follow-up turn's capture starts only once its second signal reached the barrier (deterministic overlap).
 let gate=null;const warnings=[];
 const barrier=createCheckpointTurnBarrier({terminals:()=>terminals,redact:text=>text,warn:(message,detail)=>warnings.push(`${message} ${detail}`),
  checkpoints:{capture:async(id,cwd,signal)=>{if(gate)await gate.promise;return checkpoints.capture(id,cwd,signal);}}});
 const entries=[];
 const f=await fixture(t,{lifecycleGuard:id=>barrier.lifecycleGuard(id),
  beforeLifecycle:(id,signal,cancel)=>{entries.push(signal.turnId);if(gate&&entries.filter(turn=>turn==='two').length===2)gate.resolve();return barrier.beforeLifecycle(id,signal,cancel);},
  onSignal:(id,signal)=>{barrier.onSignal(id,signal.state);terminals.applyProviderSignal(id,{kind:'lifecycle',state:signal.state});}});
 const cap=f.gateway.registerSession(worker.id,'codex');
 assert.equal(await send(cap,'session.status:busy','one').done,true);await tick();
 assert.equal((await checkpoints.list(worker.id,project)).length,1,'the first turn has its point');
 await writeFile(join(project,'file.txt'),'first turn edit');
 assert.equal(await send(cap,'session.status:idle','one',{state:'idle'}).done,true);await tick();
 // send_to_agent: the follow-up prompt reaches the idle card through the one delivery path.
 assert.deepEqual(await terminals.deliverInput(worker.id,'follow-up task\r'),{delivered:true});
 gate=deferred();
 const first=send(cap,'session.status:busy','two');await new Promise(resolve=>first.socket.on('connect',resolve));
 while(!entries.includes('two'))await tick();
 const second=send(cap,'session.status:busy','two');
 assert.equal(await first.done,true);assert.equal(await second.done,true);
 await tick();await checkpoints.idle();
 assert.deepEqual(warnings,[],'no rollback point warning');
 const points=await checkpoints.list(worker.id,project);
 assert.equal(points.length,2,'the follow-up turn has its own rollback point');
 assert.equal(git('-C',project,'show',`${points[0].id}:file.txt`),'first turn edit','taken before the follow-up turn');
});

test('a superseded barrier of the same turn leaves the capture running; a new turn or the turn end cancels it',async t=>{
 const signals=[];const {terminals,worker,barrier}=barrierFixture(t,async(_id,_cwd,signal)=>{signals.push(signal);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},'yolo',{barrierMs:5000});
 const first=new AbortController();void barrier.beforeLifecycle(worker.id,{...working,turnId:'one'},first.signal);
 first.abort();void barrier.beforeLifecycle(worker.id,{...working,turnId:'one'},new AbortController().signal);await tick();await tick();
 assert.equal(signals.length,1);assert.equal(signals[0].aborted,false,'the same turn\'s next signal waits for the same capture');
 void barrier.beforeLifecycle(worker.id,{...working,turnId:'two'},new AbortController().signal);
 assert.equal(signals[0].aborted,true,'a new turn cancels the previous turn\'s capture');assert.equal(signals.length,2);
 barrier.onSignal(worker.id,'idle');assert.equal(signals[1].aborted,true,'the turn end cancels its capture');
 terminals.dispose(worker.id);
});
