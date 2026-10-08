import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {AgentControlService} from '../src/main/services/AgentControlService.ts';
import {EnvironmentRegistry} from '../src/main/services/EnvironmentRegistry.ts';
import {GitCheckpoints} from '../src/main/services/GitCheckpoints.ts';
import {availableRegistry, fakeSpawner} from './helpers/terminal.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',cwd,...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const wait = async predicate => {
 for (let i=0;i<200;i++) { if (predicate()) return; await new Promise(resolve=>setTimeout(resolve,5)); }
 throw new Error('Fixture did not reach expected state');
};
async function fixture(t) {
 const root = realpathSync(await mkdtemp(join(tmpdir(),'ctty-review-attribution-')));
 const project = join(root,'project'); await mkdir(project);
 git(project,'init'); await writeFile(join(project,'.gitignore'),'.workers/\n');
 await writeFile(join(project,'tracked.txt'),'original\n'); git(project,'add','.'); git(project,'commit','-m','baseline');
 const worktree = join(project,'.workers','one'); git(project,'worktree','add','-b','worker',worktree);
 const calls=[], prompts=[]; let terminals;
 terminals = new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner(calls,{onWrite(data) {
  if (!data.includes('Review only the supplied answer')) return;
  prompts.push(data);
  const reviewer=terminals.listMetadata().find(row=>row.title.startsWith('Review:'));
  terminals.applyProviderSignal(reviewer.id,{state:'working'},'hook');
  terminals.recordAnswer(reviewer.id,{text:'{"verdict":"accept","findings":""}',truncated:false});
  terminals.applyProviderSignal(reviewer.id,{state:'idle',event:'Stop'},'hook');
 }}));
 terminals.configureIsolation({containment:()=>true,
  decide:({profile})=>profile==='plan'?{apply:true,profile,isolation:{state:'on',layer:'seatbelt'}}:{apply:false,profile},
  wrap:launch=>({command:launch.command,args:[...launch.args],env:launch.env,cleanup(){}})});
 t.after(async()=>{terminals.disposeAll();await rm(root,{recursive:true,force:true});});
 const control=new AgentControlService(terminals,{reviewModel:()=> 'fixture-reviewer',waitTiming:{checkMs:1,settleMs:0,quietMs:10}});
 const parent=terminals.create({provider:'codex',profile:'normal',cwd:project,role:'orchestrator',position:{x:0,y:0}});
 return {root,project,worktree,terminals,control,parent,calls,prompts};
}

test('a shared dirty project refuses automatic review without starting a reviewer',async t=>{
 const f=await fixture(t); await writeFile(join(f.project,'tracked.txt'),'pre-existing unrelated change\n');
 const worker=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.project,review:true});
 f.calls.at(-1).process.emitExit(0);
 const result=await f.control.resultWithReview(worker.id);
 assert.equal(result.review.status,'unavailable'); assert.match(result.review.reason,/separate worktree|shares/u);
 assert.equal(f.prompts.length,0); assert.equal(f.terminals.listMetadata().filter(row=>row.title.startsWith('Review:')).length,0);
});

test('a clean separate worktree reviews committed, staged, unstaged and untracked worker changes from its initial HEAD',async t=>{
 const f=await fixture(t);
 const worker=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.worktree,review:true});
 await writeFile(join(f.worktree,'tracked.txt'),'worker committed change\n'); git(f.worktree,'add','.');git(f.worktree,'commit','-m','worker change');
 await writeFile(join(f.worktree,'staged.txt'),'worker staged change\n');git(f.worktree,'add','staged.txt');
 await writeFile(join(f.worktree,'tracked.txt'),'worker committed change\nworker unstaged change\n');
 await writeFile(join(f.worktree,'untracked.txt'),'worker untracked change\n');
 await writeFile(join(f.project,'tracked.txt'),'unrelated parent change\n');
 f.calls.at(-1).process.emitExit(0);
 const result=await f.control.resultWithReview(worker.id);assert.equal(result.review.status,'accepted',result.review.reason);
 assert.equal(f.prompts.length,1);
 for (const kind of ['committed','staged','unstaged','untracked']) assert.ok(f.prompts[0].includes(`worker ${kind} change`));
 assert.ok(!f.prompts[0].includes('unrelated parent change'));
});

test('a separate worktree with pre-existing untracked data cannot establish a baseline',async t=>{
 const f=await fixture(t); await writeFile(join(f.worktree,'pre-existing.txt'),'not the worker\n');
 const worker=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.worktree,review:true});
 await assert.rejects(f.terminals.readReviewDiff(worker.id),/already dirty/u);
});

test('a non-review managed session invalidates the worker baseline even after it closes',async t=>{
 const f=await fixture(t);
 const worker=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.worktree,review:true});
 const other=f.terminals.create({provider:'terminal',profile:'normal',cwd:f.worktree,position:{x:0,y:0}});
 f.terminals.dispose(other.id);
 await assert.rejects(f.terminals.readReviewDiff(worker.id),/Another managed session/u);
});

test('a delayed environment captures its final effective cwd immediately before the actual PTY launch',async t=>{
 const f=await fixture(t); let release, wrapping=false;
 const gate=new Promise(resolve=>{release=resolve;});
 const registry=new EnvironmentRegistry({providers:()=>[{pluginId:'fixture.env',pluginName:'Fixture',serviceId:'env',secrets:false,
  kinds:[{kind:'worktree',label:'Worktree',fields:[]}]}],
  call:async(_plugin,_service,method,params)=>{
   if(method.endsWith('.prepare'))return {ref:{id:'one'},label:'worktree'};
   if(method.endsWith('.wrap')){wrapping=true;await gate;return {command:process.execPath,args:params.args,cwd:f.worktree};}
   if(method.endsWith('.describe'))return {label:'worktree'};
   return {};
  },secret:async()=>null});
 f.terminals.configureEnvironments(registry);
 const worker=f.terminals.create({provider:'codex',profile:'normal',cwd:f.project,role:'subagent',parentSessionId:f.parent.id,
  position:{x:0,y:0},environment:{pluginId:'fixture.env',kind:'worktree'}},{origin:'subagent',captureReviewDiff:true});
 await wait(()=>wrapping);await assert.rejects(f.terminals.readReviewDiff(worker.id),/No worker-specific/u);
 // This parent-only dirt was created while preparing; the actual worker tree remains clean.
 await writeFile(join(f.project,'tracked.txt'),'parent edit during environment preparation\n');
 release();await wait(()=>f.calls.length===2);
 assert.equal(f.calls[1].options.cwd,f.worktree);
 await writeFile(join(f.worktree,'tracked.txt'),'effective worktree edit\n');
 const diff=await f.terminals.readReviewDiff(worker.id);
 assert.match(diff,/effective worktree edit/u);assert.ok(!diff.includes('parent edit during'));
});

test('restart captures a fresh baseline and removing the session releases it',async t=>{
 const f=await fixture(t);
 const worker=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.worktree,review:true});
 await writeFile(join(f.worktree,'tracked.txt'),'first launch\n');git(f.worktree,'add','.');git(f.worktree,'commit','-m','first launch');
 f.calls.at(-1).process.emitExit(0);f.terminals.restart(worker.id);
 assert.equal(await f.terminals.readReviewDiff(worker.id),'');
 await writeFile(join(f.worktree,'tracked.txt'),'second launch\n');
 const diff=await f.terminals.readReviewDiff(worker.id);assert.match(diff,/-first launch\n\+second launch/u);
 f.terminals.dispose(worker.id);await assert.rejects(f.terminals.readReviewDiff(worker.id),/No worker-specific/u);
});

test('review baseline rejects an option-shaped or malformed commit before running git',async()=>{
 const checkpoints=new GitCheckpoints(text=>text);
 await assert.rejects(checkpoints.workingDiff('/missing','--output=/tmp/unwanted'),/Invalid review baseline/u);
});

test('independent workers retain their baselines when a reviewer or unrelated non-Git terminal starts',async t=>{
 const f=await fixture(t); const secondTree=join(f.project,'.workers','two');git(f.project,'worktree','add','-b','second',secondTree);
 const first=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.worktree,review:true});
 const firstProcess=f.calls.at(-1).process;
 const second=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:secondTree,review:true});
 const nonGit=join(f.root,'ordinary-terminal');await mkdir(nonGit);
 const terminal=f.terminals.create({provider:'terminal',profile:'normal',cwd:nonGit,position:{x:0,y:0}});
 f.terminals.dispose(terminal.id);
 await writeFile(join(f.worktree,'tracked.txt'),'first independent change\n');
 await writeFile(join(secondTree,'tracked.txt'),'second independent change\n');
 firstProcess.emitExit(0);
 const result=await f.control.resultWithReview(first.id);assert.equal(result.review.status,'accepted',result.review.reason);
 assert.match(await f.terminals.readReviewDiff(second.id),/second independent change/u);
});

test('submodule worktrees fail attribution explicitly instead of including pre-existing submodule changes',async t=>{
 const f=await fixture(t);
 const head=git(f.worktree,'rev-parse','HEAD');
 git(f.worktree,'update-index','--add','--cacheinfo',`160000,${head},module`);git(f.worktree,'commit','-m','module fixture');
 const worker=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.worktree,review:true});
 await assert.rejects(f.terminals.readReviewDiff(worker.id),/containing submodules/u);
});

test('inherited Git directory overrides cannot redirect baseline capture or diff reads',async t=>{
 const f=await fixture(t); const previous=process.env.GIT_DIR;
 process.env.GIT_DIR=join(f.project,'.git');
 t.after(()=>{if(previous===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=previous;});
 const worker=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.worktree,review:true});
 await writeFile(join(f.worktree,'tracked.txt'),'intended worktree change\n');
 await writeFile(join(f.project,'tracked.txt'),'wrong repository change\n');
 const diff=await f.terminals.readReviewDiff(worker.id);
 assert.match(diff,/intended worktree change/u);assert.ok(!diff.includes('wrong repository change'));
});

test('a failed PTY restart discards the prior launch baseline',async t=>{
 const f=await fixture(t);
 const worker=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.worktree,review:true});
 f.calls.at(-1).process.emitExit(0);
 f.terminals.spawnPty=()=>{throw new Error('fixture spawn failure');};
 assert.throws(()=>f.terminals.restart(worker.id),/fixture spawn failure/u);
 await assert.rejects(f.terminals.readReviewDiff(worker.id),/No worker-specific/u);
});

test('a competitor starting while the diff is read invalidates the in-flight result',async t=>{
 const f=await fixture(t);
 const worker=await f.control.spawn({parentSessionId:f.parent.id,provider:'codex',cwd:f.worktree,review:true});
 await writeFile(join(f.worktree,'tracked.txt'),'worker change\n');
 const pending=f.terminals.readReviewDiff(worker.id);
 const other=f.terminals.create({provider:'terminal',profile:'normal',cwd:f.worktree,position:{x:0,y:0}});
 f.terminals.dispose(other.id);
 await assert.rejects(pending,/Another managed session/u);
});
