import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {realpathSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentControlService} from '../src/main/services/AgentControlService.ts';
import {EnvironmentRegistry} from '../src/main/services/EnvironmentRegistry.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {ScopedOrchestrationHandler} from '../src/main/services/agent-browser/OrchestrationTools.ts';
import {availableRegistry, fakeSpawner} from './helpers/terminal.mjs';

const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; };
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function until(predicate) {
 for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
 throw new Error('Expected review lifecycle transition did not occur');
}
async function fixture(t, {account=false,worktree=false} = {}) {
 const root=realpathSync(await mkdtemp(join(tmpdir(),'ctty-review-generation-')));
 const prompts=[],reviews=[],calls=[]; let terminals;
 terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner(calls,{onWrite(data){
  if(data.includes('Review only the supplied answer')){
   const reviewer=terminals.listMetadata().findLast(row=>row.title.startsWith('Review:'));
   prompts.push({id:reviewer.id,text:data});
   terminals.applyProviderSignal(reviewer.id,{state:'working'},'hook');
  }else{
   const worker=terminals.listMetadata().find(row=>row.role==='subagent'&&!row.title.startsWith('Review:'));
   if(worker)terminals.applyProviderSignal(worker.id,{state:'working'},'hook');
  }
 }}));
 terminals.configureIsolation({containment:()=>true,
  decide:({profile})=>profile==='plan'?{apply:true,profile,isolation:{state:'on',layer:'seatbelt'}}:{apply:false,profile},
  wrap:launch=>({command:launch.command,args:[...launch.args],env:launch.env,cleanup(){}})});
 if(worktree)terminals.configureEnvironments(new EnvironmentRegistry({
  providers:()=>[{pluginId:'fixture.worktree',pluginName:'Worktree',serviceId:'env',secrets:false,kinds:[{kind:'worktree',label:'Worktree',executionLocation:'local',fields:[]}]}],
  call:async(_p,_s,method,params)=>{
   if(method.endsWith('.prepare'))return {ref:{id:'one'},label:'Worktree'};
   if(method.endsWith('.wrap'))return {command:process.execPath,args:params.args,cwd:root};
   if(method.endsWith('.describe'))return {label:'Worktree'};
   return {};
  },secret:async()=>null
 }));
 const accounts=[],accountCleanups=[],forgotten=new Map();
 const forgetCompletion=id=>{let done=forgotten.get(id);if(!done){done=deferred();forgotten.set(id,done);}return done;};
 if(account){
  const {LaunchPipeline}=await import('../src/main/services/LaunchPipeline.ts');
  const pipeline=new LaunchPipeline({
   contributors:()=>[{pluginId:'canvastty-accounts',pluginName:'Accounts',serviceId:'accounts',secrets:false,
    launch:{fields:[{key:'account',label:'Model account',kind:'text'}],delegable:true}}],
   call:async()=>({env:{FIXTURE_RUN_FILE:'{launchFiles}/fixture.txt'},files:[{relPath:'fixture.txt',content:'fixture account data'}]}),
   secret:async()=>null,runsRoot:join(root,'runs'),timeoutMs:2000
  });
  const prepareLaunch=pipeline.prepare.bind(pipeline);
  pipeline.prepare=async input=>{
   const prepared=await prepareLaunch(input);
   if(prepared.ok){const cleanup=prepared.cleanup;prepared.cleanup=()=>{const pending=cleanup();accountCleanups.push(pending);return pending;};}
   return prepared;
  };
  const forget=pipeline.forgetSession.bind(pipeline);
  pipeline.forgetSession=id=>{const pending=forget(id);forgetCompletion(id).resolve(pending);return pending;};
  terminals.configureLaunchPipeline(pipeline);
  const prepare=terminals.prepareReviewerAccount.bind(terminals);
  terminals.prepareReviewerAccount=async input=>{
   const prepared=await prepare(input),row={id:prepared.id,directory:join(root,'runs',prepared.id),file:prepared.contribution.env.FIXTURE_RUN_FILE,cleanupCalls:0};
   accounts.push(row);const cleanup=prepared.contribution.cleanup;
   prepared.contribution.cleanup=()=>{row.cleanupCalls++;const pending=cleanup();row.cleanupPromise=pending;return pending;};return prepared;
  };
 }
 const control=new AgentControlService(terminals,{...(worktree?{resolveSubagentEnvironment:()=>({pluginId:'fixture.worktree',kind:'worktree'})}:{}),reviewModel:()=> 'fixture-reviewer',reviewDiff:async()=>'+worker scoped fixture',
  waitTiming:{checkMs:1,settleMs:0,quietMs:10_000},onReview:(_id,review)=>reviews.push(review)});
 t.after(async()=>{
  const parentCleanups=[];
  for(const row of terminals.listMetadata()){
   if(account && terminals.sessions.get(row.id)?.extras.options)parentCleanups.push(forgetCompletion(row.id).promise);
   control.forgetSession(row.id);
  }
  terminals.disposeAll();
  await Promise.all([...accountCleanups,...parentCleanups,...accounts.map(row=>row.cleanupPromise)]);
  await rm(root,{recursive:true,force:true});
 });
 const parent=terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const worker=await control.spawn({parentSessionId:parent.id,provider:'codex',cwd:root,review:true,initialPrompt:'first task',...(account?{launchOptions:{'canvastty-accounts':{account:'fixture-model'}}}:{})});
 const finish=(id,text)=>{terminals.recordAnswer(id,{text,truncated:false});terminals.applyProviderSignal(id,{state:'idle',event:'Stop'},'hook');};
 return {control,terminals,worker,prompts,reviews,finish,calls,accounts};
}

test('new worker input cancels obsolete review, ignores delayed old verdicts for all waiters, and replaces the automatic watcher',async t=>{
 const f=await fixture(t),oldWaitReached=deferred(),releaseOld=deferred();
 t.after(()=>releaseOld.resolve());
 const wait=f.control.waitFor.bind(f.control);let oldReviewerId;
 // Pause the old provider result at the return boundary; cancellation must remain effective even after it produced a verdict.
 f.control.waitFor=async(id,request)=>{
  const isReviewer=f.terminals.getMetadata(id)?.title.startsWith('Review:');
  if(isReviewer&&!oldReviewerId){
   oldReviewerId=id;const result=await wait(id,request);oldWaitReached.resolve();await releaseOld.promise;return result;
  }
  return wait(id,request);
 };
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":"old approval"}');await oldWaitReached.promise;
 const oldPoll1=f.control.resultWithReview(f.worker.id),oldPoll2=f.control.resultWithReview(f.worker.id);
 const oldWait=f.control.waitFor(f.worker.id,{timeoutMs:1000});
 await f.control.send(f.worker.id,'second task');
 assert.equal(f.terminals.getMetadata(oldReviewerId),null,'obsolete active reviewer is disposed');
 f.finish(f.worker.id,'second answer');await until(()=>f.prompts.length===2);
 assert.match(f.prompts[1].text,/second answer/u);assert.ok(!f.prompts[1].text.includes('first answer'));
 releaseOld.resolve();
 for(const result of await Promise.all([oldPoll1,oldPoll2,oldWait])){
  assert.equal(result.review.status,'unavailable');assert.equal(result.review.verdict,undefined);
  assert.match(result.review.reason,/prompt changed|removed/u);
 }
 assert.equal(f.reviews.length,0,'old verdict must not be cached or published');
 const pending=await f.control.resultWithReview(f.worker.id,{deferReview:true});
 assert.equal(pending.review.status,'pending');await tick();assert.equal(f.prompts.length,2,'old finally/watcher must not erase or restart the replacement');
 f.finish(f.prompts[1].id,'{"verdict":"reject","findings":"second task needs repair"}');
 await until(()=>f.reviews.length===1);
 const current=await f.control.resultWithReview(f.worker.id);
 assert.equal(current.answer.text,'second answer');assert.equal(current.review.status,'rejected');
 assert.match(current.review.notes,/second task needs repair/u);assert.equal(f.reviews[0].verdict,'reject');
 assert.equal(f.terminals.listMetadata().filter(row=>row.title.startsWith('Review:')).length,1);
});

test('a prompt sent while a cached review is returning cannot attach its old verdict to the latest answer',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const oldPoll=f.control.resultWithReview(f.worker.id);
 const sending=f.control.send(f.worker.id,'second task');
 f.finish(f.worker.id,'second answer');
 const result=await oldPoll;await sending;
 assert.equal(result.review.status,'unavailable');assert.equal(result.review.verdict,undefined);
 assert.equal(result.answer.text,'second answer');
});

test('an already-aborted send leaves the active review intact',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 const controller=new AbortController();controller.abort();
 await assert.rejects(f.control.send(f.worker.id,'never delivered',true,controller.signal),{name:'PromptNotDeliveredError'});
 assert.ok(f.terminals.getMetadata(f.prompts[0].id));
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 assert.equal((await f.control.resultWithReview(f.worker.id)).review.status,'accepted');
 assert.equal(f.prompts.length,1);
});


test('unsubmitted input invalidates the old verdict without reviewing the previous answer again',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 await f.control.send(f.worker.id,'draft input',false);
 // A partial input does not start a worker turn or complete an answer.
 f.terminals.applyProviderSignal(f.worker.id,{state:'idle'},'hook');
 const current=await f.control.resultWithReview(f.worker.id);
 assert.equal(current.review.status,'unavailable');assert.match(current.review.reason,/not been submitted/u);
 await tick();assert.equal(f.prompts.length,1);
});


test('successive successful account reviews release the previous reviewer, private workspace and account files exactly once',async t=>{
 const f=await fixture(t,{account:true});
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 const first=f.prompts[0].id,firstWorkspace=f.terminals.getMetadata(first).cwd;
 f.finish(first,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 assert.equal(f.accounts[0].cleanupCalls,0);assert.ok(existsSync(f.accounts[0].file));
 await f.control.send(f.worker.id,'second task');
 await f.accounts[0].cleanupPromise;
 assert.equal(existsSync(f.accounts[0].file),false);
 assert.equal(existsSync(f.accounts[0].directory),false,'reviewer account parent directory is removed');
 assert.equal(f.terminals.getMetadata(first),null);assert.equal(existsSync(firstWorkspace),false);
 assert.equal(f.control.isReadOnlyReviewer(first),false);assert.equal(f.accounts[0].cleanupCalls,1);
 f.finish(f.worker.id,'second answer');await until(()=>f.prompts.length===2);
 const second=f.prompts[1].id,secondWorkspace=f.terminals.getMetadata(second).cwd;
 f.finish(second,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===2);
 assert.equal(f.terminals.listMetadata().filter(row=>row.title.startsWith('Review:')).length,1);
 f.control.forgetSession(f.worker.id);
 await f.accounts[1].cleanupPromise;
 assert.equal(existsSync(f.accounts[1].file),false);
 assert.equal(existsSync(f.accounts[1].directory),false,'reviewer account parent directory is removed');
 assert.equal(f.terminals.getMetadata(second),null);assert.equal(existsSync(secondWorkspace),false);
 assert.equal(f.control.isReadOnlyReviewer(second),false);
 assert.deepEqual(f.accounts.map(row=>row.cleanupCalls),[1,1]);
});

for(const state of ['active','cached'])for(const failure of ['queued cancellation','readiness timeout','input gate rejection']){
 test(`${failure} before writing preserves the ${state} review`,async t=>{
  const f=await fixture(t);
  f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
  const reviewer=f.prompts[0].id;
  if(state==='cached'){f.finish(reviewer,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);}
  const session=f.terminals.sessions.get(f.worker.id),write=session.process.write;
  let writes=0;session.process.write=data=>{writes++;write(data);};
  const deliver=f.terminals.deliverInput.bind(f.terminals);
  f.terminals.deliverInput=(id,data,_wait,signal)=>deliver(id,data,25,signal);
  if(failure==='queued cancellation'){
   const gate=deferred();session.inputQueue=gate.promise;
   const controller=new AbortController();const sending=f.control.send(f.worker.id,'must not be delivered',true,controller.signal);
   controller.abort();gate.resolve();await assert.rejects(sending,/cancelled/u);
  }else if(failure==='readiness timeout'){
   session.agentRuntime={cleanup(){}};session.hookSignals=0;session.titleState=null;session.cliInputReady=false;
   await assert.rejects(f.control.send(f.worker.id,'must not be delivered'),/did not become ready/u);
   session.agentRuntime=null;
  }else{
   f.terminals.configureInputGate(()=>{throw new Error('fixture gate closed');});
   await assert.rejects(f.control.send(f.worker.id,'must not be delivered'),/no longer accepts/u);
   f.terminals.configureInputGate(()=>{});
  }
  assert.equal(writes,0);assert.ok(f.terminals.getMetadata(reviewer));assert.equal(f.control.isReadOnlyReviewer(reviewer),true);
  const observed=await f.control.resultWithReview(f.worker.id,{deferReview:true});
  assert.equal(observed.review.status,state==='cached'?'accepted':'pending');
  if(state==='active'){f.finish(reviewer,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);}
  await tick();assert.equal(f.prompts.length,1,'no replacement reviewer is launched for undelivered input');
 });
}

test('ambiguous acknowledgement after a write invalidates the old review without replaying text',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 const reviewer=f.prompts[0].id;
 f.finish(reviewer,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const session=f.terminals.sessions.get(f.worker.id);session.agentRuntime={cleanup(){}};
 const writes=[];session.process.write=data=>writes.push(data);
 const deliver=f.terminals.deliverInput.bind(f.terminals);
 f.terminals.deliverInput=(id,data,_wait,signal)=>deliver(id,data,25,signal);
 await assert.rejects(f.control.send(f.worker.id,'ambiguous second task'),/did not confirm accepting/u);
 assert.deepEqual(writes,['ambiguous second task\r']);
 assert.equal(f.terminals.getMetadata(reviewer),null);assert.equal(f.control.reviews.has(f.worker.id),false);
 assert.equal(f.control.isReadOnlyReviewer(reviewer),false);assert.equal(f.prompts.length,1);
 session.agentRuntime=null;
});


test('concurrent queued sends schedule only the latest written generation',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const first=f.control.send(f.worker.id,'queued second task');
 const second=f.control.send(f.worker.id,'queued third task');
 await Promise.all([first,second]);
 // The provider acknowledges a distinct turn for its latest queued input.
 f.terminals.applyProviderSignal(f.worker.id,{state:'idle',event:'Stop'},'hook');
 f.terminals.applyProviderSignal(f.worker.id,{state:'working'},'hook');
 f.finish(f.worker.id,'latest queued answer');await until(()=>f.prompts.length===2);
 assert.match(f.prompts[1].text,/latest queued answer/u);
 f.finish(f.prompts[1].id,'{"verdict":"accept","findings":"latest review"}');await until(()=>f.reviews.length===2);
 await tick();assert.equal(f.prompts.length,2);
 assert.equal((await f.control.resultWithReview(f.worker.id)).review.notes,'latest review');
});


for(const route of ['input','inputChecked'])for(const state of ['active','cached']){
 test(`manual ${route} invalidates ${state} review and automatically reviews the new completed turn`,async t=>{
  const f=await fixture(t);
  f.finish(f.worker.id,'first answer');await until(()=>f.prompts.length===1);
  const old=f.prompts[0].id;
  if(state==='cached'){f.finish(old,'{"verdict":"accept","findings":"old verdict"}');await until(()=>f.reviews.length===1);}
  const concurrent=state==='active'?f.control.resultWithReview(f.worker.id):null;
  const previousCount=f.reviews.length;
  f.terminals[route](f.worker.id,'manual next task\r');
  assert.equal(f.terminals.getMetadata(old),null);
  // A delayed provider message for the disposed reviewer cannot publish a verdict for the new task.
  f.finish(old,'{"verdict":"accept","findings":"late old verdict"}');
  if(concurrent){const result=await concurrent;assert.equal(result.review.status,'unavailable');assert.equal(result.review.verdict,undefined);}
  f.finish(f.worker.id,'manual second answer');await until(()=>f.prompts.length===2);
  assert.match(f.prompts[1].text,/manual second answer/u);assert.ok(!f.prompts[1].text.includes('first answer'));
  f.finish(f.prompts[1].id,'{"verdict":"reject","findings":"manual new verdict"}');await until(()=>f.reviews.length===previousCount+1);
  const result=await f.control.resultWithReview(f.worker.id);assert.equal(result.review.status,'rejected');
  assert.equal(result.review.notes,'manual new verdict');
 });
}

test('manual split typing and Enter do not review an old idle answer before the new turn begins',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'old answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const session=f.terminals.sessions.get(f.worker.id);session.process.write=()=>{};
 f.terminals.input(f.worker.id,'typed task');
 assert.equal((await f.control.resultWithReview(f.worker.id)).review.status,'unavailable');
 assert.equal(f.terminals.inputChecked(f.worker.id,'\r'),true);
 const early=await f.control.resultWithReview(f.worker.id);
 assert.equal(early.review.status,'pending');assert.equal(early.answer,undefined);
 await tick();assert.equal(f.prompts.length,1,'manual Enter must not review retained idle/answer state');
 f.terminals.applyProviderSignal(f.worker.id,{state:'working'},'hook');f.finish(f.worker.id,'new answer');
 await until(()=>f.prompts.length===2);
 assert.match(f.prompts[1].text,/new answer/u);assert.ok(!f.prompts[1].text.includes('old answer'));
});

test('a fresh final answer without a working hook remains reviewable after manual submission',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'old answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const session=f.terminals.sessions.get(f.worker.id);session.process.write=()=>{};
 f.terminals.input(f.worker.id,'quiet provider task\r');
 assert.equal((await f.control.resultWithReview(f.worker.id)).review.status,'pending');
 f.terminals.recordAnswer(f.worker.id,{text:'fresh answer without a working hook',truncated:false},{generation:f.terminals.answerCaptureGeneration(f.worker.id)});
 const waiting=f.control.resultWithReview(f.worker.id);await until(()=>f.prompts.length===2);
 assert.match(f.prompts[1].text,/fresh answer without a working hook/u);
 f.finish(f.prompts[1].id,'{"verdict":"accept","findings":"fresh result"}');
 assert.equal((await waiting).review.status,'accepted');
});

test('quiet input with neither a new turn nor a fresh answer ends with unavailable instead of reviewing stale work',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'old answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const session=f.terminals.sessions.get(f.worker.id);session.process.write=()=>{};
 f.control.options.waitTiming.quietMs=10;
 f.terminals.input(f.worker.id,'silent task\r');
 const result=await f.control.waitFor(f.worker.id,{timeoutMs:100});
 assert.equal(result.reason,'quiet');assert.equal(result.review.status,'unavailable');assert.equal(result.answer,undefined);
 assert.equal(f.prompts.length,1);
});

test('manual input blocked by the common gate preserves the current reviewer and answer',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'old answer');await until(()=>f.prompts.length===1);
 const reviewer=f.prompts[0].id;
 f.finish(reviewer,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 f.terminals.configureInputGate(()=>{throw new Error('fixture denied');});
 assert.equal(f.terminals.inputChecked(f.worker.id,'not allowed\r'),false);
 f.terminals.input(f.worker.id,'also denied\r');
 assert.ok(f.terminals.getMetadata(reviewer));
 const result=await f.control.resultWithReview(f.worker.id);assert.equal(result.review.status,'accepted');assert.equal(result.answer.text,'old answer');
});

test('an automatic Enter acknowledgement retry preserves the submitted generation and starts only one new review',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'old answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const session=f.terminals.sessions.get(f.worker.id);session.agentRuntime={cleanup(){}};
 const writes=[];let submittedGeneration;
 session.process.write=data=>{
  writes.push(data);
  if(data!=='\r'){
   submittedGeneration=f.control.reviewGenerations.get(f.worker.id);
   setImmediate(()=>session.process.emitData(data.replace(/\r$/u,'')));
  }else{
   assert.equal(f.control.reviewGenerations.get(f.worker.id),submittedGeneration,'retry does not invalidate the written task');
   f.terminals.applyProviderSignal(f.worker.id,{state:'working'},'hook');f.finish(f.worker.id,'answer after Enter retry');
  }
 };
 const deliver=f.terminals.deliverInput.bind(f.terminals);
 f.terminals.deliverInput=(id,data,_wait,signal)=>deliver(id,data,2000,signal);
 await f.control.send(f.worker.id,'echoed task');await until(()=>f.prompts.length===2);
 assert.deepEqual(writes,['echoed task\r','\r']);
 f.finish(f.prompts[1].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===2);
 await tick();assert.equal(f.prompts.length,2);session.agentRuntime=null;
});

test('forgetting a reviewed worker unregisters the common input observer',async t=>{
 const f=await fixture(t);assert.equal(f.terminals.inputWriteObservers.get(f.worker.id).size,1);
 f.control.forgetSession(f.worker.id);assert.equal(f.terminals.inputWriteObservers.has(f.worker.id),false);
 f.terminals.input(f.worker.id,'input after forgetting\r');await tick();assert.equal(f.prompts.length,0);
});


test('manual LF submits a fresh turn, while bracketed paste newlines remain unsubmitted',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'old answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 const session=f.terminals.sessions.get(f.worker.id);session.process.write=()=>{};
 f.terminals.input(f.worker.id,'\x1b[200~pasted first line\n');
 f.terminals.input(f.worker.id,'pasted second line\n');
 f.terminals.input(f.worker.id,'\x1b[201~');
 assert.equal((await f.control.resultWithReview(f.worker.id)).review.status,'unavailable');
 await tick();assert.equal(f.prompts.length,1);
 f.terminals.inputChecked(f.worker.id,'\n');
 const early=await f.control.resultWithReview(f.worker.id);
 assert.equal(early.review.status,'pending');assert.equal(early.answer,undefined);
 f.terminals.applyProviderSignal(f.worker.id,{state:'working'},'hook');f.finish(f.worker.id,'LF submitted answer');
 await until(()=>f.prompts.length===2);assert.match(f.prompts[1].text,/LF submitted answer/u);
});


test('deferred orchestration waits return terminal unavailable for a quiet uncorrelated turn without starting a reviewer',async t=>{
 const f=await fixture(t);
 f.finish(f.worker.id,'old answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 f.terminals.sessions.get(f.worker.id).process.write=()=>{};
 f.control.options.waitTiming.quietMs=10;
 f.terminals.input(f.worker.id,'silent next task\r');
 const handler=new ScopedOrchestrationHandler(f.control);
 for(let i=0;i<2;i++){
  const result=await handler.execute(f.worker.parentSessionId,{id:String(i),tool:'wait_for_agent',arguments:{sessionId:f.worker.id,timeoutSeconds:1}});
  assert.equal(result.reason,'quiet');assert.equal(result.review.status,'unavailable');assert.equal(result.answer,undefined);
 }
 assert.equal(f.prompts.length,1,'a terminal quiet outcome must not launch a billed review');
});

test('worktree retry reinstalls one observer and automatically reviews each retried and later manual turn', {timeout:5000},async t=>{
 const f=await fixture(t,{worktree:true}),id=f.worker.id;
 f.terminals.sessions.get(id).process.emitExit(1);
 const retried=await f.control.retry(id);assert.equal(retried.id,id);
 assert.equal(f.terminals.inputWriteObservers.get(id)?.size,1);
 f.finish(id,'retry answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 assert.equal((await f.control.resultWithReview(id)).review.status,'accepted');
 await f.control.send(id,'later task');
 assert.notEqual((await f.control.resultWithReview(id)).review.status,'accepted','old verdict must not survive later input');
 f.finish(id,'later answer');await until(()=>f.prompts.length===2);
 f.finish(f.prompts[1].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===2);
 f.terminals.sessions.get(id).process.emitExit(1);await f.control.retry(id);
 assert.equal(f.terminals.inputWriteObservers.get(id)?.size,1,'repeated retries must not accumulate observers');
 f.finish(id,'second retry answer');await until(()=>f.prompts.length===3);
 f.finish(f.prompts[2].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===3);
 f.terminals.sessions.get(id).process.emitExit(1);await assert.rejects(f.control.retry(id),/limit of 2 retries/u);
 assert.equal(f.terminals.inputWriteObservers.get(id)?.size,1);
});

for(const failure of ['restart','cancel before restart','delivery'])test(`worktree retry restores review ownership after ${failure} failure without a premature watcher`,{timeout:5000},async t=>{
 const f=await fixture(t,{worktree:true}),id=f.worker.id;f.terminals.sessions.get(id).process.emitExit(1);
 const restart=f.terminals.restartSession.bind(f.terminals),stop=f.terminals.stopRetryProcess.bind(f.terminals),deliver=f.terminals.deliverInput.bind(f.terminals),controller=new AbortController();
 if(failure==='restart')f.terminals.restartSession=()=>{throw new Error('fixture restart failed');};
 if(failure==='cancel before restart')f.terminals.stopRetryProcess=async(...args)=>{await stop(...args);controller.abort();};
 if(failure==='delivery')f.terminals.deliverInput=async()=>({delivered:false,reason:'fixture no write'});
 await assert.rejects(f.control.retry(id,undefined,controller.signal));
 assert.equal(f.terminals.inputWriteObservers.get(id)?.size,1);assert.equal(f.control.reviewWatchers.has(id),false);assert.equal(f.prompts.length,0);
 f.terminals.restartSession=restart;f.terminals.stopRetryProcess=stop;f.terminals.deliverInput=deliver;
 assert.equal(f.terminals.getMetadata(id).exitCode !== null,true,'failed retry retains a stopped card');
 await f.control.retry(id);assert.equal(f.terminals.inputWriteObservers.get(id)?.size,1);
 f.finish(id,'recovered answer');await until(()=>f.prompts.length===1);
 f.finish(f.prompts[0].id,'{"verdict":"accept","findings":""}');await until(()=>f.reviews.length===1);
 assert.equal((await f.control.resultWithReview(id)).review.status,'accepted');
});
