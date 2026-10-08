import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ProviderModelCatalog} from '../src/main/services/providerModels.ts';
import {configuredModel} from '../src/main/services/configuredModel.ts';
import {AgentControlService} from '../src/main/services/AgentControlService.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';
import {ProviderUsageSource} from '../src/main/services/ProviderUsageSource.ts';
import {SessionTimelineService} from '../src/main/services/SessionTimelineService.ts';

function installReviewerIsolation(terminals, launches=[]) {
 terminals.configureIsolation({
  containment:()=>true,
  decide:({profile})=>profile==='plan'?{apply:true,profile,isolation:{state:'on',layer:'seatbelt'}}:{apply:false,profile},
  wrap:launch=>{launches.push(launch);return {command:launch.command,args:[...launch.args],env:launch.env,cleanup(){}};}
 });
}

test('published Codex model cache is read without a paid request; configured default is explicit only',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ctty-review-model-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-fast'},{slug:'fixture-strong'},{slug:'private-hidden',visibility:'hide'},{slug:'../../invalid'}]}));
 await writeFile(join(root,'config.toml'),'model = "fixture-fast"\n[profiles.custom]\nmodel="another"\n');
 const catalog=new ProviderModelCatalog(availableRegistry(),{codexHome:root,run:()=>{throw Error('must not spawn');}});
 await catalog.refresh('codex');assert.deepEqual(catalog.peek('codex').models,['fixture-fast','fixture-strong']);
 assert.equal(configuredModel('codex',{codex:root}),'fixture-fast');
 await writeFile(join(root,'config.toml'),'[profiles.custom]\nmodel="another"\n');assert.equal(configuredModel('codex',{codex:root}),null);
});

test('default-model worker receives a different Plan reviewer and its observed cost is updated separately',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ctty-review-default-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const calls=[];let terminals;let cost=null;let observedWorker;const isolatedLaunches=[];
 terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner(calls,{onWrite(data){
  if(!data.includes('Review only the supplied answer'))return;
  const reviewer=terminals.listMetadata().find(s=>s.title.startsWith('Review:'));
  terminals.applyProviderSignal(reviewer.id,{state:'working'},'hook');
  terminals.recordAnswer(reviewer.id,{text:'{"verdict":"accept","findings":""}',truncated:false});
  terminals.applyProviderSignal(reviewer.id,{state:'idle',event:'Stop'},'hook');
 }}));installReviewerIsolation(terminals,isolatedLaunches);t.after(()=>terminals.disposeAll());
 const control=new AgentControlService(terminals,{workerModel:()=> 'fixture-fast',reviewModel:(_provider,worker)=>{observedWorker=worker;return worker==='fixture-fast'?'fixture-strong':null;},reviewCost:()=>cost,
  reviewDiff:async()=>'+example',waitTiming:{checkMs:1,settleMs:0,quietMs:10}});
 const parent=terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const worker=await control.spawn({parentSessionId:parent.id,provider:'codex',cwd:root,review:true});calls.at(-1).process.emitExit(0);
 const result=await control.resultWithReview(worker.id);assert.equal(observedWorker,'fixture-fast');assert.equal(result.review.status,'accepted',result.review.reason);
 const reviewer=terminals.getMetadata(result.review.reviewerSessionId);assert.equal(reviewer.model,'fixture-strong');assert.equal(reviewer.profile,'plan');
 assert.notEqual(reviewer.cwd,root);assert.equal(isolatedLaunches.length,1);assert.ok(isolatedLaunches[0].deniedReadPaths.includes(realpathSync(root)));
 assert.equal(result.review.costUsd,null);cost=0.012;assert.equal((await control.resultWithReview(worker.id)).review.costUsd,0.012);assert.equal((await control.waitFor(worker.id,{timeoutMs:0})).review.costUsd,0.012);
 assert.equal(terminals.listMetadata().filter(s=>s.title.startsWith('Review:')).length,1);
});

test('published reviewer counters flow through the usage worker and timeline into a separate review cost', async t => {
 const root=await mkdtemp(join(tmpdir(),'ctty-review-counter-flow-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const workerRollout=join(root,'worker.jsonl'),reviewRollout=join(root,'review.jsonl');
 const counter=(model,input,output)=>JSON.stringify({type:'turn_context',payload:{model}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output,total_tokens:input+output}}}})+'\n';
 await writeFile(workerRollout,counter('fixture-fast',4_000,1_000));
 await writeFile(reviewRollout,counter('fixture-strong',1_000,200));
 const db=new DatabaseSync(join(root,'state_5.sqlite'));
 db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,tokens_used INTEGER,model TEXT,updated_at_ms INTEGER)');
 db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('worker-counter',workerRollout,5_000,'fixture-fast',1);
 db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('review-counter',reviewRollout,1_200,'fixture-strong',2);db.close();
 const source=new ProviderUsageSource(root),timeline=new SessionTimelineService(root,text=>text);await timeline.load();
 const prices=[{provider:'codex',model:'fixture-fast',inputPerMillion:2,outputPerMillion:8},{provider:'codex',model:'fixture-strong',inputPerMillion:4,outputPerMillion:12}];
 const calls=[];let terminals;let observed;const isolatedLaunches=[];
 terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner(calls,{onWrite(data){
  if(!data.includes('Review only the supplied answer'))return;
  const reviewer=terminals.listMetadata().find(row=>row.title.startsWith('Review:'));
  terminals.applyProviderSignal(reviewer.id,{state:'working'},'hook');
  observed=source.codexUsage('review-counter').then(async usage=>{
   await timeline.recordCumulativeUsage(reviewer.id,usage,'codex-cli conversation counter','review-counter',{provider:'codex',model:usage.model});
   terminals.recordAnswer(reviewer.id,{text:'{"verdict":"accept","findings":""}',truncated:false});
   terminals.applyProviderSignal(reviewer.id,{state:'idle',event:'Stop'},'hook');
  });
 }}));installReviewerIsolation(terminals,isolatedLaunches);t.after(()=>terminals.disposeAll());
 const control=new AgentControlService(terminals,{workerModel:async()=> (await source.codexUsage('worker-counter')).model,
  reviewModel:(_provider,model)=>model==='fixture-fast'?'fixture-strong':null,
  reviewCost:id=>timeline.usage([id],prices).cost,reviewDiff:async()=>'+fixture',waitTiming:{checkMs:1,settleMs:0,quietMs:10}});
 const parent=terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const worker=await control.spawn({parentSessionId:parent.id,provider:'codex',cwd:root,review:true});
 const workerUsage=await source.codexUsage('worker-counter');
 await timeline.recordCumulativeUsage(worker.id,workerUsage,'codex-cli conversation counter','worker-counter',{provider:'codex',model:workerUsage.model});
 calls.at(-1).process.emitExit(0);
 const result=await control.resultWithReview(worker.id);await observed;
 assert.equal(result.review.status,'accepted');assert.equal(result.review.costUsd,0.0064);
 assert.ok(isolatedLaunches[0].deniedReadPaths.includes(realpathSync(root)));
 assert.deepEqual(timeline.usage([worker.id],prices),{tokens:{input:4_000,output:1_000,total:5_000},cost:0.016,currency:'USD',source:'codex-cli conversation counter'});
 assert.equal(timeline.usage([result.review.reviewerSessionId],prices).tokens.total,1_200);
 await writeFile(reviewRollout,counter('fixture-strong',2_000,500));
 const updated=await source.codexUsage('review-counter');
 await timeline.recordCumulativeUsage(result.review.reviewerSessionId,updated,'codex-cli conversation counter','review-counter',{provider:'codex',model:updated.model});
 assert.equal((await control.resultWithReview(worker.id)).review.costUsd,0.014);
 assert.equal(timeline.usage([worker.id],prices).cost,0.016);
});

test('a worker on a model account is reviewed on that account (its key and model), not on a missing own sign-in', async t => {
 const {LaunchPipeline}=await import('../src/main/services/LaunchPipeline.ts');
 const root=await mkdtemp(join(tmpdir(),'ctty-review-account-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const prepared=[];let terminals;const isolatedLaunches=[];
 const spawn=fakeSpawner([],{onWrite(data){
  if(!data.includes('Review only the supplied answer'))return;
  const reviewer=terminals.listMetadata().find(s=>s.title.startsWith('Review:'));
  terminals.applyProviderSignal(reviewer.id,{state:'working'},'hook');
  terminals.recordAnswer(reviewer.id,{text:'{"verdict":"revise","findings":"name the constant"}',truncated:false});
  terminals.applyProviderSignal(reviewer.id,{state:'idle',event:'Stop'},'hook');
 }});
 terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,(...args)=>{
  const pty=spawn(...args);queueMicrotask(()=>pty.emitData('Ask anything…\nctrl+p commands\n'));return pty;
 });installReviewerIsolation(terminals,isolatedLaunches);t.after(()=>terminals.disposeAll());
 terminals.configureLaunchPipeline(new LaunchPipeline({
  contributors:()=>[{pluginId:'canvastty-accounts',pluginName:'Accounts',serviceId:'accounts',secrets:false,
   launch:{fields:[{key:'account',label:'Model account',kind:'text'}],delegable:true}}],
  call:async(_plugin,_service,_method,params)=>{prepared.push({role:params.role,options:params.options,chosen:params.chosen});return {env:{},secretEnv:{},args:[],files:[]};},
  secret:async()=>null,runsRoot:join(root,'runs'),timeoutMs:2000
 }));
 // No catalog model differs from an unknown worker model: before, this review was always "unavailable".
 const control=new AgentControlService(terminals,{workerModel:()=>null,reviewModel:()=>null,reviewDiff:async()=>'+example',reviewStartupMs:50,waitTiming:{checkMs:1,settleMs:0,quietMs:10}});
 const parent=terminals.create({provider:'opencode',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const worker=await control.spawn({parentSessionId:parent.id,provider:'opencode',cwd:root,review:true,launchOptions:{'canvastty-accounts':{account:'glm-flash'}}});
 await new Promise(r=>setTimeout(r,50));
 terminals.applyProviderSignal(worker.id,{state:'working'},'hook');terminals.applyProviderSignal(worker.id,{state:'idle',event:'Stop'},'hook');
 const result=await control.resultWithReview(worker.id);
 assert.equal(result.review.status,'revise',result.review.reason);
 assert.match(result.review.notes,/worker's model account/u);
 const reviewer=terminals.getMetadata(result.review.reviewerSessionId);
 assert.equal(reviewer.profile,'plan');assert.equal(reviewer.model ?? null,null,'the account decides the reviewer model');
 assert.ok(prepared.filter(p=>p.chosen && p.options.account==='glm-flash').length>=2,JSON.stringify(prepared));
});

test('an explicit model next to a model account is refused with the reason instead of a crashing double --model', t => {
 const root=realpathSync(tmpdir());
 const terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));t.after(()=>terminals.disposeAll());
 assert.throws(()=>terminals.create({provider:'opencode',profile:'normal',cwd:root,position:{x:0,y:0},model:'zai-coding-plan/glm-5.3',
  launchOptions:{'canvastty-accounts':{account:'glm-flash'}}}),/Model account glm-flash sets the model of this launch/u);
});

test('a reviewer on the worker model account keeps only that account run file as its OpenCode config', async t => {
 const {prepareReviewerHome}=await import('../src/main/services/isolation/reviewerHome.ts');
 const root=await mkdtemp(join(tmpdir(),'ctty-reviewer-home-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const plugin=join(root,'opencode-plugin.mjs');await writeFile(plugin,'export const P=async()=>({});');
 const base=()=>({HOME:root,OPENCODE_CONFIG:'/project/opencode.json',OPENCODE_CONFIG_CONTENT:'{"plugin":[]}'});
 const dropped=base();prepareReviewerHome(dropped,'opencode',root,[plugin]);
 assert.equal(dropped.OPENCODE_CONFIG,undefined,'without an account no config file is kept');
 const kept=base();prepareReviewerHome(kept,'opencode',join(root,'t2'),[plugin],'/userdata/launch-runs/s/r/canvastty-accounts/opencode.json');
 assert.equal(kept.OPENCODE_CONFIG,'/userdata/launch-runs/s/r/canvastty-accounts/opencode.json');
 assert.deepEqual(JSON.parse(kept.OPENCODE_CONFIG_CONTENT).plugin.length,1,'still only the host lifecycle plugin');
});

test('a reviewer still starting its CLI (silent, no turn yet) is waited for instead of being called unresponsive', async t => {
 const root=await mkdtemp(join(tmpdir(),'ctty-review-slow-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let terminals;
 terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([],{onWrite(data){
  if(!data.includes('Review only the supplied answer'))return;
  const reviewer=terminals.listMetadata().find(s=>s.title.startsWith('Review:'));
  // Silent for 30x the wait's normal quiet window before the first turn (a fresh home installing its provider package).
  setTimeout(()=>{
   terminals.applyProviderSignal(reviewer.id,{state:'working'},'hook');
   terminals.recordAnswer(reviewer.id,{text:'{"verdict":"accept","findings":""}',truncated:false});
   terminals.applyProviderSignal(reviewer.id,{state:'idle',event:'Stop'},'hook');
  },300);
 }}));installReviewerIsolation(terminals);t.after(()=>terminals.disposeAll());
 const control=new AgentControlService(terminals,{workerModel:()=> 'fixture-fast',reviewModel:()=> 'fixture-strong',reviewDiff:async()=>'+example',waitTiming:{checkMs:1,settleMs:0,quietMs:10}});
 const parent=terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const worker=await control.spawn({parentSessionId:parent.id,provider:'codex',cwd:root,review:true});
 terminals.applyProviderSignal(worker.id,{state:'working'},'hook');terminals.applyProviderSignal(worker.id,{state:'idle',event:'Stop'},'hook');
 const result=await control.resultWithReview(worker.id);
 assert.equal(result.review.status,'accepted',result.review.reason);
});

test('an OpenCode reviewer gets its prompt only after its TUI reported a first status', async t => {
 const root=await mkdtemp(join(tmpdir(),'ctty-review-ready-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let terminals;let readyAt=null;let promptAt=null;
 terminals=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([],{onWrite(data){
  if(!data.includes('Review only the supplied answer'))return;
  promptAt=Date.now();
  const reviewer=terminals.listMetadata().find(s=>s.title.startsWith('Review:'));
  terminals.applyProviderSignal(reviewer.id,{state:'working'},'hook');
  terminals.recordAnswer(reviewer.id,{text:'{"verdict":"accept","findings":""}',truncated:false});
  terminals.applyProviderSignal(reviewer.id,{state:'idle',event:'Stop'},'hook');
 }}));installReviewerIsolation(terminals);t.after(()=>terminals.disposeAll());
 const control=new AgentControlService(terminals,{workerModel:()=> 'p/fast',reviewModel:()=> 'p/strong',reviewDiff:async()=>'+example',reviewStartupMs:5000,waitTiming:{checkMs:1,settleMs:0,quietMs:10}});
 const parent=terminals.create({provider:'opencode',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
 const worker=await control.spawn({parentSessionId:parent.id,provider:'opencode',cwd:root,review:true});
 const watcher=setInterval(()=>{const reviewer=terminals.listMetadata().find(s=>s.title.startsWith('Review:'));
  if(reviewer && readyAt===null){readyAt=Date.now()+150;setTimeout(()=>terminals.applyProviderSignal(reviewer.id,{state:'idle',event:'session.created'},'hook'),150);}},5);
 t.after(()=>clearInterval(watcher));
 terminals.applyProviderSignal(worker.id,{state:'working'},'hook');terminals.applyProviderSignal(worker.id,{state:'idle',event:'Stop'},'hook');
 const result=await control.resultWithReview(worker.id);
 assert.equal(result.review.status,'accepted',result.review.reason);
 assert.ok(promptAt>=readyAt,`prompt ${promptAt} before the TUI was ready ${readyAt}`);
});


for (const scenario of ["creation throws", "cancelled during preparation", "success"]) {
 test(`reviewer account contribution is cleaned exactly once: ${scenario}`, {timeout:5000}, async t => {
  const {LaunchPipeline} = await import('../src/main/services/LaunchPipeline.ts');
  const root = await mkdtemp(join(tmpdir(), 'ctty-review-cleanup-'));
  let terminals, releaseCleanup;
  terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([], {onWrite(data) {
   if (!data.includes('Review only the supplied answer')) return;
   const reviewer = terminals.listMetadata().find(row => row.title.startsWith('Review:'));
   terminals.applyProviderSignal(reviewer.id, {state:'working'}, 'hook');
   terminals.recordAnswer(reviewer.id, {text:'{"verdict":"accept","findings":""}',truncated:false});
   terminals.applyProviderSignal(reviewer.id, {state:'idle',event:'Stop'}, 'hook');
  }}));
  installReviewerIsolation(terminals);
  const disposals=[],forgetFiles=terminals.forgetLaunchFiles.bind(terminals);
  terminals.forgetLaunchFiles=session=>{const pending=forgetFiles(session);disposals.push(pending);return pending;};
  t.after(async()=>{releaseCleanup?.();terminals.disposeAll();await Promise.allSettled(disposals);await rm(root,{recursive:true,force:true});});
  terminals.configureLaunchPipeline(new LaunchPipeline({
   contributors: () => [{pluginId:'canvastty-accounts',pluginName:'Accounts',serviceId:'accounts',secrets:false,
    launch:{fields:[{key:'account',label:'Model account',kind:'text'}],delegable:true}}],
   call: async () => ({env:{FIXTURE_FILE:'{launchFiles}/account.txt'},secretEnv:{},args:[],files:[{relPath:'account.txt',content:'temporary account config'}]}),
   secret: async () => null, runsRoot:join(root,'runs'), timeoutMs:2000
  }));
  const control = new AgentControlService(terminals, {reviewDiff:async () => '+fixture',waitTiming:{checkMs:1,settleMs:0,quietMs:10}});
  const parent = terminals.create({provider:'codex',profile:'normal',cwd:root,role:'orchestrator',position:{x:0,y:0}});
  const worker = await control.spawn({parentSessionId:parent.id,provider:'codex',cwd:root,review:true,
   launchOptions:{'canvastty-accounts':{account:'fixture-model'}}});
  let cleanupCalls = 0, cleanupDone = false;
  let cleanupStarted;const started=new Promise(resolve=>{cleanupStarted=resolve;});
  let cleanupFinished;const finished=new Promise(resolve=>{cleanupFinished=resolve;});
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  let preparedAccount;
  const prepare = terminals.prepareReviewerAccount.bind(terminals);
  terminals.prepareReviewerAccount = async input => {
   const prepared = await prepare(input); preparedAccount = prepared;
   const cleanup = prepared.contribution.cleanup;
   prepared.contribution.cleanup = async () => {
    cleanupCalls++; cleanupStarted(); await cleanupGate; await cleanup(); cleanupDone = true; cleanupFinished();
   };
   if (scenario === 'cancelled during preparation') control.forgetSession(worker.id);
   return prepared;
  };
  if (scenario === 'creation throws') terminals.createReadOnlyReviewer = () => { throw new Error('isolation unavailable'); };
  terminals.applyProviderSignal(worker.id,{state:'working'},'hook');
  terminals.applyProviderSignal(worker.id,{state:'idle',event:'Stop'},'hook');
  let settled = false;
  const review = control.resultWithReview(worker.id).then(result => { settled = true; return result; });
  if (scenario === 'success') {
   const result = await review;
   assert.equal(result.review.status, 'accepted', result.review.reason);
   assert.equal(cleanupCalls, 0, 'successful creation transfers ownership to the reviewer session');
   terminals.dispose(result.review.reviewerSessionId);
   assert.equal(cleanupCalls, 1);
   releaseCleanup();
   await finished;
   assert.equal(cleanupDone, true);
   terminals.dispose(result.review.reviewerSessionId);
  } else {
   await started;
   assert.ok(preparedAccount, 'preparation completed');
   assert.equal(cleanupCalls, 1);
   assert.equal(settled, false, 'failure/cancellation must wait for account cleanup');
   releaseCleanup();
   const result = await review;
   assert.equal(result.review.status, 'unavailable');
   assert.equal(cleanupDone, true);
   assert.equal(terminals.listMetadata().filter(row => row.title.startsWith('Review:')).length, 0);
  }
  await assert.rejects(stat(join(root,'runs',preparedAccount.id)),{code:'ENOENT'},'account parent removed for every ownership outcome');
  terminals.disposeAll();
  assert.equal(cleanupCalls, 1, 'cleanup is not duplicated by service and terminal manager');
 });
}
