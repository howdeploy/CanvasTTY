// GitCheckpoints against real repositories: the turn barrier's time budget, filter attributes (Git LFS-like),
// the host's Git environment, restore refusals, and how the registry and its packs stay bounded.
// Run with a fake HOME and GIT_CONFIG_GLOBAL=/dev/null (the fixture also isolates the Git config it uses itself).
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {GitCheckpoints} from '../src/main/services/GitCheckpoints.ts';

const NULL=process.platform==='win32'?'NUL':'/dev/null';
const env={...process.env,GIT_CONFIG_GLOBAL:NULL,GIT_CONFIG_NOSYSTEM:'1'};
async function fixture(t,{files={file:'saved\n'}}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ctty-checkpoint-hardening-'))),project=join(root,'project');
 // Background pack writes of every store made here finish before the folder goes.
 const made=[];t.after(async()=>{await Promise.all(made.map(checkpoints=>checkpoints.idle().catch(()=>undefined)));await rm(root,{recursive:true,force:true});});
 const git=(...args)=>execFileSync('git',['-C',project,...args],{env,encoding:'utf8',maxBuffer:64*1024*1024}).trimEnd();
 await mkdir(project);git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false');
 for(const [name,content] of Object.entries(files)){await mkdir(join(project,name,'..'),{recursive:true});await writeFile(join(project,name),content);}
 git('add','-A');git('commit','-qm','base');
 const storage=join(root,'private','checkpoints.json');
 const make=(limits=50)=>{const checkpoints=new GitCheckpoints(text=>text,limits,storage);made.push(checkpoints);return checkpoints;};
 return{root,project,git,storage,make};
}
const code=expected=>error=>error.code===expected;
const packsOf=async root=>(await readdir(join(root,'private','checkpoint-objects'),{recursive:true}).catch(()=>[])).filter(name=>name.endsWith('.pack'));

test('a medium repository (2000 files, tens of MB, dirty) gets its rollback point within the turn barrier',{timeout:120000},async t=>{
 const files={};
 for(let index=0;index<2000;index++)files[`src/${index%40}/file-${index}.txt`]=`line ${index}\n`.repeat(200+(index%50)*10);
 for(let index=0;index<12;index++)files[`assets/blob-${index}.bin`]=randomBytes(2*1024*1024).toString('base64');
 const f=await fixture(t,{files});
 const total=Number(f.git('count-objects','-v').match(/size-pack: (\d+)|size: (\d+)/u)?.slice(1).find(Boolean)??0);
 // An agent's previous turn changed 60 files, one of them large, and staged some.
 for(let index=0;index<60;index++)await writeFile(join(f.project,`src/${index%40}/file-${index}.txt`),`changed ${index}\n`.repeat(400));
 await writeFile(join(f.project,'assets/blob-0.bin'),randomBytes(3*1024*1024).toString('base64'));
 f.git('add','src/0');
 const checkpoints=f.make();
 await checkpoints.list('warmup',f.project);
 const timings=[];
 for(let round=0;round<3;round++){
  await writeFile(join(f.project,'src/1/file-1.txt'),`round ${round}\n`);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('barrier timed out')),750);
  const started=performance.now();
  await checkpoints.capture('worker',f.project,controller.signal);
  timings.push(performance.now()-started);clearTimeout(timer);
  const packStarted=performance.now();await checkpoints.idle();timings.push(-(performance.now()-packStarted));
 }
 const barrier=timings.filter(value=>value>=0),packing=timings.filter(value=>value<0).map(value=>-value);
 t.diagnostic(`repository ~${Math.round(total/1024)} MiB in the object store; barrier ${barrier.map(value=>value.toFixed(0)).join('/')} ms; protective packs after it ${packing.map(value=>value.toFixed(0)).join('/')} ms`);
 assert.equal((await checkpoints.list('worker',f.project)).length,3);
 for(const value of barrier)assert.ok(value<750,`capture took ${value.toFixed(0)} ms inside the barrier`);
 const sizes=await Promise.all((await packsOf(f.root)).map(name=>stat(join(f.root,'private','checkpoint-objects',name)).then(info=>info.size)));
 sizes.sort((a,b)=>b-a);assert.equal(sizes.length,3);
 t.diagnostic(`pack sizes ${sizes.map(size=>Math.round(size/1024)+' KiB').join(', ')}`);
 assert.ok(sizes[1]*20<sizes[0],'later points pack only what changed since the previous one');
});

test('a filter attribute (Git LFS-like) refuses rollback points, and the project\'s filter driver never runs',{timeout:30000},async t=>{
 const f=await fixture(t,{files:{file:'saved\n','asset.bin':'binary\n'}});
 const checkpoints=f.make();await checkpoints.capture('worker',f.project);const [point]=await checkpoints.list('worker',f.project);
 const marker=join(f.root,'filter-ran');
 f.git('config','filter.lfs.clean',`sh -c 'touch ${marker}; cat'`);f.git('config','filter.lfs.smudge',`sh -c 'touch ${marker}; cat'`);f.git('config','filter.lfs.required','true');
 await writeFile(join(f.project,'.gitattributes'),'*.bin filter=lfs diff=lfs merge=lfs -text\n');f.git('add','.gitattributes');f.git('commit','-qm','lfs');
 await writeFile(join(f.project,'asset.bin'),'changed\n');
 await rm(marker,{force:true});// the fixture's own git commands may have run the driver
 await assert.rejects(checkpoints.capture('worker',f.project),code('filters'));
 assert.equal((await checkpoints.list('worker',f.project)).length,1,'no point for a filtered project');
 await assert.rejects(checkpoints.restore('worker',f.project,point.id),code('filters'));
 assert.equal(await readFile(join(f.project,'asset.bin'),'utf8'),'changed\n');assert.equal(existsSync(marker),false);
 // An attribute only in .git/info/attributes (agent-writable outside isolation) counts as well.
 await rm(join(f.project,'.gitattributes'));f.git('commit','-qam','drop');
 await writeFile(join(f.project,'.git','info','attributes'),'* filter=lfs\n');await rm(marker,{force:true});
 await assert.rejects(checkpoints.capture('worker',f.project),code('filters'));assert.equal(existsSync(marker),false);
});

test('host Git ignores inherited GIT_* variables, hooks and fsmonitor, and blanks the project\'s own filter drivers',{timeout:30000},async t=>{
 const f=await fixture(t);const other=await fixture(t,{files:{other:'other\n'}});const marker=join(f.root,'ran');
 f.git('config','core.fsmonitor',`sh -c 'touch ${marker}-fsmonitor'`);
 await writeFile(join(f.project,'.git','hooks','reference-transaction'),`#!/bin/sh\ntouch ${marker}-hook\n`,{mode:0o755});
 // A driver for a name no tracked file uses yet: blanked anyway (an attribute could appear in a race).
 f.git('config','filter.evil.clean',`sh -c 'touch ${marker}-filter; cat'`);
 const saved={...process.env};t.after(()=>{for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_CONFIG_PARAMETERS','GIT_INDEX_FILE'])if(key in saved)process.env[key]=saved[key];else delete process.env[key];});
 Object.assign(process.env,{GIT_DIR:join(other.project,'.git'),GIT_WORK_TREE:other.project,GIT_INDEX_FILE:join(f.root,'index'),GIT_CONFIG_PARAMETERS:`'core.hooksPath'='${f.root}'`});
 const checkpoints=f.make();await writeFile(join(f.project,'file'),'changed\n');
 await checkpoints.capture('worker',f.project);const [point]=await checkpoints.list('worker',f.project);
 await writeFile(join(f.project,'file'),'later\n');await checkpoints.preview('worker',f.project,point.id);await checkpoints.restore('worker',f.project,point.id);
 assert.equal(await readFile(join(f.project,'file'),'utf8'),'changed\n');
 for(const suffix of ['fsmonitor','hook','filter'])assert.equal(existsSync(`${marker}-${suffix}`),false,suffix);
 assert.equal(execFileSync('git',['-C',other.project,'for-each-ref','refs/canvastty/'],{env:{...env,GIT_DIR:undefined}}).toString(),'','another repository is never touched');
});

test('restore refuses to overwrite an untracked file and files Git ignores changes in; HEAD stays put',{timeout:30000},async t=>{
 const f=await fixture(t,{files:{file:'saved\n','added.txt':'saved added\n'}});
 const checkpoints=f.make();await checkpoints.capture('worker',f.project);const [point]=await checkpoints.list('worker',f.project);
 f.git('rm','-q','--cached','added.txt');await writeFile(join(f.project,'added.txt'),'precious untracked work\n');
 await assert.rejects(checkpoints.restore('worker',f.project,point.id),code('worktree-conflict'));
 assert.equal(await readFile(join(f.project,'added.txt'),'utf8'),'precious untracked work\n');
 await rm(join(f.project,'added.txt'));
 // An untracked file where the saved tree has a folder blocks it as well.
 f.git('reset','-q','--hard');await mkdir(join(f.project,'dir'));await writeFile(join(f.project,'dir','inner.txt'),'tracked\n');f.git('add','dir');
 await checkpoints.capture('worker',f.project);const [withFolder]=await checkpoints.list('worker',f.project);
 f.git('rm','-q','-r','--cached','dir');await rm(join(f.project,'dir'),{recursive:true});await writeFile(join(f.project,'dir'),'a file now\n');
 await assert.rejects(checkpoints.restore('worker',f.project,withFolder.id),code('worktree-conflict'));
 await rm(join(f.project,'dir'));
 f.git('update-index','--assume-unchanged','file');await writeFile(join(f.project,'file'),'hidden change\n');
 await assert.rejects(checkpoints.restore('worker',f.project,point.id),code('worktree-conflict'));
 f.git('update-index','--no-assume-unchanged','file');
 const head=f.git('rev-parse','HEAD');await writeFile(join(f.project,'later.txt'),'x');f.git('add','later.txt');f.git('commit','-qm','later');const moved=f.git('rev-parse','HEAD');
 await checkpoints.restore('worker',f.project,point.id);
 assert.equal(f.git('rev-parse','HEAD'),moved,'HEAD and the branch stay where they are');assert.notEqual(moved,head);
 assert.equal(await readFile(join(f.project,'file'),'utf8'),'saved\n');assert.equal(existsSync(join(f.project,'later.txt')),false);
});

test('a file that became a folder of tracked files restores; an untracked or ignored file inside that folder still refuses it',{timeout:30000},async t=>{
 const f=await fixture(t,{files:{config:'saved\n'}});
 const checkpoints=f.make();await checkpoints.capture('worker',f.project);const [point]=await checkpoints.list('worker',f.project);
 // The turn turned the file into a folder (every file in it tracked): nothing unsaved is in the way.
 f.git('rm','-q','config');await mkdir(join(f.project,'config','nested'),{recursive:true});await writeFile(join(f.project,'config','nested','main.ini'),'turn\n');f.git('add','config');
 // An untracked file (or one Git ignores) inside the folder would be deleted by the restore: refused, and kept.
 await writeFile(join(f.project,'config','notes.txt'),'precious\n');
 await assert.rejects(checkpoints.restore('worker',f.project,point.id),code('worktree-conflict'));
 assert.equal(await readFile(join(f.project,'config','notes.txt'),'utf8'),'precious\n');
 await rm(join(f.project,'config','notes.txt'));
 await writeFile(join(f.project,'.git','info','exclude'),'*.log\n');await writeFile(join(f.project,'config','nested','debug.log'),'ignored\n');
 await assert.rejects(checkpoints.restore('worker',f.project,point.id),code('worktree-conflict'));
 assert.equal(await readFile(join(f.project,'config','nested','debug.log'),'utf8'),'ignored\n');
 await rm(join(f.project,'config','nested','debug.log'));
 await checkpoints.restore('worker',f.project,point.id);
 assert.equal(await readFile(join(f.project,'config'),'utf8'),'saved\n');assert.equal(f.git('status','--porcelain'),'');
 // The folder of the turn is in the safety point taken before the restore.
 const [safety]=await checkpoints.list('worker',f.project);assert.equal(safety.kind,'before-restore');
 await checkpoints.restore('worker',f.project,safety.id);
 assert.equal(await readFile(join(f.project,'config','nested','main.ini'),'utf8'),'turn\n');
});

test('chained packs survive rewritten history and immediate garbage collection',{timeout:30000},async t=>{
 const f=await fixture(t,{files:{a:'a\n',b:'b\n',c:'c\n'}});const checkpoints=f.make();
 await writeFile(join(f.project,'a'),'first\n');await checkpoints.capture('worker',f.project);
 await writeFile(join(f.project,'b'),'second\n');await checkpoints.capture('worker',f.project);
 const [second,first]=await checkpoints.list('worker',f.project);
 const rows=JSON.parse(await readFile(f.storage,'utf8'));assert.equal(rows.find(row=>row.id===second.id).packs.length,2,'the second point references the first one\'s pack');
 f.git('checkout','-q','--orphan','other');f.git('rm','-q','-rf','.');await writeFile(join(f.project,'z'),'z\n');f.git('add','z');f.git('commit','-qm','unrelated');
 f.git('branch','-D','main');f.git('for-each-ref','--format=delete %(refname)','refs/canvastty/');
 for(const ref of f.git('for-each-ref','--format=%(refname)','refs/canvastty/').split('\n').filter(Boolean))f.git('update-ref','-d',ref);
 f.git('reflog','expire','--expire=now','--all');f.git('gc','-q','--prune=now');
 const restarted=new GitCheckpoints(text=>text,50,f.storage);t.after(()=>restarted.idle());
 await rm(join(f.project,'z'));f.git('rm','-q','--cached','z');
 await restarted.restore('worker',f.project,second.id);
 assert.equal(await readFile(join(f.project,'a'),'utf8'),'first\n');assert.equal(await readFile(join(f.project,'b'),'utf8'),'second\n');assert.equal(await readFile(join(f.project,'c'),'utf8'),'c\n');
 assert.ok(first);
});

test('retention is bounded per card, in total and in pack bytes; dropped points lose their refs and packs',{timeout:60000},async t=>{
 const f=await fixture(t);const checkpoints=f.make({perSession:3,total:5});
 for(let index=0;index<5;index++){await writeFile(join(f.project,'file'),`a ${index}\n`);await checkpoints.capture('a',f.project);}
 assert.equal((await checkpoints.list('a',f.project)).length,3);
 for(let index=0;index<3;index++){await writeFile(join(f.project,'file'),`b ${index}\n`);await checkpoints.capture('b',f.project);}
 await checkpoints.idle();
 const a=await checkpoints.list('a',f.project),b=await checkpoints.list('b',f.project);
 assert.equal(a.length+b.length,5,'five in total');assert.equal(b.length,3);
 assert.deepEqual(f.git('for-each-ref','--format=%(refname)','refs/canvastty/').split('\n').sort(),[...a,...b].map(row=>row.id).sort());
 const rows=JSON.parse(await readFile(f.storage,'utf8'));const referenced=new Set(rows.flatMap(row=>row.packs??[]));
 assert.equal((await packsOf(f.root)).length,referenced.size,'no pack outlives the points that need it');
 const tight=new GitCheckpoints(text=>text,{packBytes:1},join(f.root,'tight','checkpoints.json'));t.after(()=>tight.idle());
 await writeFile(join(f.project,'file'),'big\n'.repeat(1000));await tight.capture('c',f.project);
 assert.equal((await tight.list('c',f.project)).length,1,'a point too large to copy is kept, relying on the repository');
 assert.equal(JSON.parse(await readFile(join(f.root,'tight','checkpoints.json'),'utf8'))[0].packs,undefined);
});

test('closing a card and cards known not to come back remove their points; a missing folder keeps them; a broken registry is set aside',{timeout:60000},async t=>{
 const f=await fixture(t);const gone=await fixture(t);
 const checkpoints=new GitCheckpoints(text=>text,50,f.storage);t.after(()=>checkpoints.idle());
 for(const id of ['kept','closed','stale']){await writeFile(join(f.project,'file'),id);await checkpoints.capture(id,f.project);}
 await writeFile(join(gone.project,'file'),'x');await checkpoints.capture('elsewhere',gone.project);
 await checkpoints.forgetSession('closed');await checkpoints.idle();
 assert.deepEqual(await checkpoints.list('closed',f.project),[]);
 assert.equal(f.git('for-each-ref','refs/canvastty/closed/'),'');
 await checkpoints.forgetSessions(['stale']);await checkpoints.idle();
 assert.deepEqual(await checkpoints.list('stale',f.project),[]);assert.equal((await checkpoints.list('kept',f.project)).length,1);
 await checkpoints.capture('closed',f.project);assert.deepEqual(await checkpoints.list('closed',f.project),[],'a closed card never gets a point again');
 await rm(gone.project,{recursive:true,force:true});
 const restarted=new GitCheckpoints(text=>text,50,f.storage);t.after(()=>restarted.idle());await restarted.list('kept',f.project);
 const rows=JSON.parse(await readFile(f.storage,'utf8'));assert.deepEqual(rows.map(row=>row.sessionId).sort(),['elsewhere','kept'],'a missing folder\'s points stay (it may be an unmounted volume)');
 assert.equal((await packsOf(f.root)).length,new Set(rows.flatMap(row=>row.packs??[])).size);
 // One invalid row is dropped (a copy is set aside); the rest survives.
 await writeFile(f.storage,JSON.stringify([...rows,{id:'refs/canvastty/x/1-bad',cwd:f.project,sessionId:'x',oid:'nope'}]));
 const partial=new GitCheckpoints(text=>text,50,f.storage);t.after(()=>partial.idle());
 assert.equal((await partial.list('kept',f.project)).length,1);assert.ok(existsSync(`${f.storage}.quarantined`));
 // Unreadable or oversized: set aside, and rollback points start over instead of failing every capture.
 for(const broken of ['{not json',' '.repeat(4*1024*1024+1)]){
  await writeFile(f.storage,broken);
  const fresh=new GitCheckpoints(text=>text,50,f.storage);t.after(()=>fresh.idle());
  assert.deepEqual(await fresh.list('kept',f.project),[]);
  await writeFile(join(f.project,'file'),'again');await fresh.capture('kept',f.project);assert.equal((await fresh.list('kept',f.project)).length,1);
  assert.equal(await readFile(`${f.storage}.quarantined`,'utf8'),broken);
 }
});

test('points taken in one millisecond, or after the clock went back, keep their order: retention drops the oldest',{timeout:60000},async t=>{
 const f=await fixture(t);const checkpoints=f.make({perSession:2,total:10});
 const realNow=Date.now;let frozen=realNow();Date.now=()=>frozen;t.after(()=>{Date.now=realNow;});
 for(let index=0;index<3;index++){await writeFile(join(f.project,'file'),`same ms ${index}\n`);await checkpoints.capture('a',f.project);}
 frozen-=60_000;await writeFile(join(f.project,'file'),'clock went back\n');await checkpoints.capture('a',f.project);
 await checkpoints.idle();
 const kept=await checkpoints.list('a',f.project);assert.equal(kept.length,2);
 assert.ok(kept[0].at>kept[1].at,'strictly ordered');
 await checkpoints.restore('a',f.project,kept[0].id);await checkpoints.idle();
 assert.equal(await readFile(join(f.project,'file'),'utf8'),'clock went back\n','the newest point is the last one taken');
});

