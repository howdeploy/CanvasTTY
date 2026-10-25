// GitCheckpoints, second review: a restore never runs without its safety point, filter drivers stay blank in a race,
// pack chains stay bounded, start-up cleanup keeps what it cannot prove dead, previews never hold up a capture, and
// case-only renames restore on case-insensitive file systems.
// Run with a fake HOME and GIT_CONFIG_GLOBAL=/dev/null (the fixture also isolates the Git config it uses itself).
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,rename,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitCheckpoints} from '../src/main/services/GitCheckpoints.ts';
import {TerminalManager} from '../src/main/services/TerminalManager.ts';
import {TerminalSessionStore} from '../src/main/services/TerminalSessionStore.ts';
import {availableRegistry,fakeSpawner} from './helpers/terminal.mjs';

const NULL=process.platform==='win32'?'NUL':'/dev/null';
const env={...process.env,GIT_CONFIG_GLOBAL:NULL,GIT_CONFIG_NOSYSTEM:'1'};
async function fixture(t,{files={file:'saved\n'}}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ctty-cp-'))),project=join(root,'project');
 // Background pack writes of every store made here finish before the folder goes (else rm meets ENOTEMPTY).
 const made=[];t.after(async()=>{await Promise.all(made.map(checkpoints=>checkpoints.idle().catch(()=>undefined)));await rm(root,{recursive:true,force:true});});
 const git=(...args)=>execFileSync('git',['-C',project,...args],{env,encoding:'utf8'}).trimEnd();
 await mkdir(project);git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false');
 for(const [name,content] of Object.entries(files)){await mkdir(join(project,name,'..'),{recursive:true});await writeFile(join(project,name),content);}
 git('add','-A');git('commit','-qm','base');
 const storage=join(root,'private','checkpoints.json');
 const make=(limits=50)=>{const checkpoints=new GitCheckpoints(text=>text,limits,storage);made.push(checkpoints);return checkpoints;};
 return{root,project,git,storage,make};
}
const code=expected=>error=>error.code===expected;
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const packsOf=async root=>(await readdir(join(root,'private','checkpoint-objects'),{recursive:true}).catch(()=>[])).filter(name=>name.endsWith('.pack'));

test('a restore whose safety point cannot be taken (an orphan branch without a commit) is refused and deletes nothing',{timeout:30000},async t=>{
 const f=await fixture(t);const checkpoints=f.make();
 await checkpoints.capture('worker',f.project);const [point]=await checkpoints.list('worker',f.project);
 f.git('checkout','-q','--orphan','x');await writeFile(join(f.project,'work.txt'),'unsaved work\n');f.git('add','work.txt');
 await assert.rejects(checkpoints.restore('worker',f.project,point.id),code('no-safety-point'));
 assert.equal(await readFile(join(f.project,'work.txt'),'utf8'),'unsaved work\n');
 assert.equal((await checkpoints.list('worker',f.project)).length,1,'no before-restore point was claimed');
});

test('the person\'s global filter driver never runs, even when .git/info/attributes names it during a capture or a restore',{timeout:30000},async t=>{
 const f=await fixture(t);const marker=join(f.root,'driver-ran');
 const home=join(f.root,'home');await mkdir(home);
 await writeFile(join(home,'.gitconfig'),`[filter "lfs"]\n\tclean = sh -c 'touch ${marker}; echo CIPHER'\n\tsmudge = sh -c 'touch ${marker}; echo CIPHER'\n\trequired = true\n`);
 const saved=process.env.HOME;process.env.HOME=home;t.after(()=>{process.env.HOME=saved;});
 const checkpoints=f.make();await checkpoints.capture('worker',f.project);const [point]=await checkpoints.list('worker',f.project);
 // The attribute appears after the first filter check (an agent writing it in a race): the snapshot reads raw files
 // and the second check drops the point.
 const check=checkpoints.requireNoFilters.bind(checkpoints);let calls=0;
 checkpoints.requireNoFilters=async(...args)=>{if(calls++===0){await check(...args);await writeFile(join(f.project,'.git','info','attributes'),'* filter=lfs\n');return;}return check(...args);};
 await writeFile(join(f.project,'file'),'changed\n');
 await assert.rejects(checkpoints.capture('worker',f.project),code('filters'));
 assert.equal(existsSync(marker),false,'the global driver did not run during the snapshot');
 assert.equal((await checkpoints.list('worker',f.project)).length,1,'no point for a snapshot taken under a filter');
 // A restore that races the same way writes raw content and runs no driver.
 checkpoints.requireNoFilters=async()=>undefined;
 await checkpoints.restore('worker',f.project,point.id);
 assert.equal(await readFile(join(f.project,'file'),'utf8'),'saved\n');assert.equal(existsSync(marker),false,'the global driver did not run during the restore');
});

test('pack chains restart with a complete pack after 16 points, so no pack keeps growing',{timeout:120000},async t=>{
 const f=await fixture(t,{files:Object.fromEntries(Array.from({length:20},(_,index)=>[`f${index}`,`base ${index}\n`.repeat(50)]))});const checkpoints=f.make();
 for(let index=0;index<20;index++){await writeFile(join(f.project,`f${index}`),`turn ${index}\n`.repeat(50));await checkpoints.capture('worker',f.project);}
 await checkpoints.idle();
 const rows=JSON.parse(await readFile(f.storage,'utf8')).sort((a,b)=>Number(a.id.split('/').pop().split('-')[0])-Number(b.id.split('/').pop().split('-')[0]));
 const lengths=rows.map(row=>row.packs.length);
 assert.deepEqual(lengths,[...Array.from({length:16},(_,index)=>index+1),1,2,3,4],'the chain restarts after 16 packs');
 assert.equal((await packsOf(f.root)).length,new Set(rows.flatMap(row=>row.packs)).size);
});

test('start-up keeps points of a folder that cannot be found (an unmounted volume) and the packs a set-aside registry names',{timeout:60000},async t=>{
 const f=await fixture(t);const first=f.make();
 await writeFile(join(f.project,'file'),'one\n');await first.capture('worker',f.project);await first.idle();
 const away=join(f.root,'away');await rename(f.project,away);
 const second=f.make();assert.deepEqual(await second.list('other',join(f.root,'missing')),[]);await second.idle();
 await rename(away,f.project);
 const third=f.make();assert.equal((await third.list('worker',f.project)).length,1,'the point survived the folder being away');
 const packs=await packsOf(f.root);assert.equal(packs.length,1);
 // A registry that no longer parses is set aside; the packs it names stay for recovery by hand.
 await writeFile(f.storage,(await readFile(f.storage,'utf8'))+'garbage');
 const fourth=f.make();assert.deepEqual(await fourth.list('worker',f.project),[]);await fourth.idle();
 assert.deepEqual(await packsOf(f.root),packs,'the set-aside registry\'s packs are kept');
});

test('a transient registry read error is retried next time instead of disabling points for the run',{timeout:30000},async t=>{
 const f=await fixture(t);await mkdir(f.storage,{recursive:true});// reading a folder fails with EISDIR
 const checkpoints=f.make();
 await assert.rejects(checkpoints.list('worker',f.project));
 await rm(f.storage,{recursive:true});
 await checkpoints.capture('worker',f.project);assert.equal((await checkpoints.list('worker',f.project)).length,1);
});

test('only saved cards known not to come back lose their points',{timeout:30000},async t=>{
 const f=await fixture(t);const checkpoints=f.make();
 for(const id of ['kept','gone','unknown']){await writeFile(join(f.project,'file'),id);await checkpoints.capture(id,f.project);}
 await checkpoints.forgetSessions([]);await checkpoints.forgetSessions(['gone']);await checkpoints.idle();
 assert.deepEqual((await Promise.all(['kept','gone','unknown'].map(id=>checkpoints.list(id,f.project)))).map(rows=>rows.length),[1,0,1]);
 assert.equal(f.git('for-each-ref','refs/canvastty/gone/'),'');
});

test('restorePersistedSessions names only saved cards that did not come back, and none when the saved cards cannot be trusted',{timeout:30000},async t=>{
 // Each manager has its own store on the same file, and a store's write uses one temporary name per process: every
 // store's queued writes finish before the next manager starts or the file is replaced by hand.
 const directory=await mkdtemp(join(tmpdir(),'ctty-cards-'));const stores=[];const settled=()=>Promise.all(stores.map(store=>store.flush().catch(()=>undefined)));
 t.after(async()=>{await settled();await rm(directory,{recursive:true,force:true});});
 const make=(mode='continue')=>{const manager=new TerminalManager(()=>undefined,availableRegistry(),undefined,undefined,true,fakeSpawner([]));const store=new TerminalSessionStore(directory);stores.push(store);manager.configureSessionPersistence(store,mode);return manager;};
 const first=make();assert.deepEqual(await first.restorePersistedSessions(),[]);
 const kept=first.create({provider:'codex',profile:'normal',cwd:process.cwd(),position:{x:0,y:0}});
 const dropped=first.create({provider:'codex',profile:'normal',cwd:process.cwd(),position:{x:0,y:0}});
 first.setRestore(dropped.id,false);await first.shutdown();
 const saved=await readFile(join(directory,'terminal-sessions.json'),'utf8');
 const second=make();assert.deepEqual(await second.restorePersistedSessions(),[dropped.id]);assert.ok(second.list().some(row=>row.id===kept.id));second.disposeAll();await settled();
 await writeFile(join(directory,'terminal-sessions.json'),saved);
 assert.deepEqual(await make('off').restorePersistedSessions(),[],'restore turned off removes nothing');
 await settled();const newer=JSON.parse(saved);newer.version=99;await writeFile(join(directory,'terminal-sessions.json'),JSON.stringify(newer));
 const third=make();assert.deepEqual(await third.restorePersistedSessions(),[],'a newer version\'s cards');third.disposeAll();
});

test('a preview runs beside captures (never ahead of a turn\'s point), holds the packs it reads, and shows what the restore does',{timeout:30000},async t=>{
 const f=await fixture(t);const checkpoints=f.make();
 await checkpoints.capture('worker',f.project);const [point]=await checkpoints.list('worker',f.project);
 await writeFile(join(f.project,'file'),'changed‮\n');
 const entered=deferred(),release=deferred();const complete=checkpoints.complete.bind(checkpoints);
 checkpoints.complete=async(...args)=>{entered.resolve();await release.promise;return complete(...args);};
 const preview=checkpoints.preview('worker',f.project,point.id);await entered.promise;
 assert.ok(checkpoints.heldPacks.size>0,'the point\'s packs are held while the preview reads them');
 checkpoints.complete=complete;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('barrier timed out')),5000);t.after(()=>clearTimeout(timer));
 await checkpoints.capture('worker',f.project,controller.signal);assert.equal(controller.signal.aborted,false,'the capture did not wait for the preview');
 release.resolve();const result=await preview;
 assert.match(result.text,/^-changed$/mu,'the current line goes');assert.match(result.text,/^\+saved$/mu,'the saved line comes back');
 assert.match(result.text,/^diff --git a\/\S+ b\//mu,'headers read from the current files (a/) to the point (b/), not swapped');assert.doesNotMatch(result.text,/^diff --git b\//mu);
 assert.doesNotMatch(result.text,/‮/u,'bidirectional controls are removed');
 await checkpoints.idle();assert.equal(checkpoints.heldPacks.size,0);
});

test('a file renamed only in case since the point restores on a case-insensitive file system',{timeout:30000},async t=>{
 const f=await fixture(t,{files:{'Foo.txt':'saved\n'}});
 // Git leaves core.ignorecase unset on a case-sensitive file system (ext4), and `git config` then exits with 1.
 let ignoreCase='false';try{ignoreCase=f.git('config','--type=bool','core.ignorecase');}catch{}
 if(ignoreCase!=='true'){t.skip('the file system is case-sensitive');return;}
 const checkpoints=f.make();await checkpoints.capture('worker',f.project);const [point]=await checkpoints.list('worker',f.project);
 f.git('mv','-f','Foo.txt','foo.txt');await writeFile(join(f.project,'foo.txt'),'renamed and changed\n');f.git('add','foo.txt');
 await checkpoints.restore('worker',f.project,point.id);
 assert.equal(await readFile(join(f.project,'Foo.txt'),'utf8'),'saved\n');assert.equal(f.git('ls-files'),'Foo.txt');assert.equal(f.git('status','--porcelain'),'');
 const [safety]=await checkpoints.list('worker',f.project);assert.equal(safety.kind,'before-restore');
});

test('a repository without core.ignorecase (as Git leaves it on ext4) restores; the missing key counts as false',{timeout:30000},async t=>{
 const f=await fixture(t,{files:{'Foo.txt':'saved\n'}});
 try{f.git('config','--unset','core.ignorecase');}catch{}
 const checkpoints=f.make();await checkpoints.capture('worker',f.project);const [point]=await checkpoints.list('worker',f.project);
 await writeFile(join(f.project,'Foo.txt'),'changed\n');
 await checkpoints.restore('worker',f.project,point.id);
 assert.equal(await readFile(join(f.project,'Foo.txt'),'utf8'),'saved\n');
});
