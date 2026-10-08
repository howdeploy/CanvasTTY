import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitCheckpoints} from '../src/main/services/GitCheckpoints.ts';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ctty-cancel-point-')),project=join(root,'project');
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
 git('init','-q',project);git('-C',project,'config','user.name','Fixture');git('-C',project,'config','user.email','fixture@example.invalid');git('-C',project,'config','core.autocrlf','false');git('-C',project,'config','core.eol','lf');
 await writeFile(join(project,'file.txt'),'base');git('-C',project,'add','.');git('-C',project,'commit','-qm','base');
 const checkpoints=new GitCheckpoints(text=>text,1,join(root,'registry.json'));
 t.after(async()=>{await checkpoints.captures.catch(()=>{});await rm(root,{recursive:true,force:true});});
 return{root,project,checkpoints,git};
}
for(const stage of ['stash','pack','ref'])test(`aborted ${stage} capture never registers a late checkpoint or removes the older one`,{timeout:10000},async t=>{
 const f=await fixture(t);await f.checkpoints.capture('worker',f.project);const previous=await f.checkpoints.list('worker',f.project);
 await writeFile(join(f.project,'file.txt'),'pending change');const entered=deferred(),release=deferred(),controller=new AbortController();t.after(()=>release.resolve());
 const original=f.checkpoints.git.bind(f.checkpoints),protect=f.checkpoints.protectObjects.bind(f.checkpoints);
 if(stage==='pack')f.checkpoints.protectObjects=async(...args)=>{entered.resolve();await release.promise;return protect(...args);};
 else f.checkpoints.git=async(cwd,args,signal)=>{
  if(stage==='stash'&&args[0]==='stash'){entered.resolve();await release.promise;}
  const value=await original(cwd,args,signal);
  if(stage==='ref'&&args[0]==='update-ref'&&args[1]!=='-d'){entered.resolve();await release.promise;}
  return value;
 };
 const pending=f.checkpoints.capture('worker',f.project,controller.signal);await entered.promise;controller.abort();
 await assert.rejects(pending);await writeFile(join(f.project,'file.txt'),'agent already started');release.resolve();await f.checkpoints.captures.catch(()=>{});
 assert.deepEqual(await f.checkpoints.list('worker',f.project),previous);
 const refs=f.git('-C',f.project,'for-each-ref','--format=%(refname)','refs/canvastty/').split('\n');assert.deepEqual(refs,previous.map(row=>row.id));
 const packs=(await readdir(join(f.root,'checkpoint-objects'),{recursive:true})).filter(path=>path.endsWith('.pack'));assert.equal(packs.length,1);
 const reloaded=new GitCheckpoints(text=>text,1,join(f.root,'registry.json'));assert.deepEqual(await reloaded.list('worker',f.project),previous);
});

test('an aborted queued checkpoint never begins snapshotting after the current job finishes',{timeout:10000},async t=>{
 const f=await fixture(t),entered=deferred(),release=deferred(),controller=new AbortController();t.after(()=>release.resolve());let stashes=0;
 const original=f.checkpoints.git.bind(f.checkpoints);f.checkpoints.git=async(cwd,args,...rest)=>{if(args[0]==='stash'){stashes++;entered.resolve();await release.promise;}return original(cwd,args,...rest);};
 const first=f.checkpoints.capture('first',f.project);await entered.promise;const second=f.checkpoints.capture('second',f.project,controller.signal);controller.abort();await assert.rejects(second);
 release.resolve();await first;await f.checkpoints.captures.catch(()=>{});assert.equal(stashes,1);assert.deepEqual(await f.checkpoints.list('second',f.project),[]);
});

test('a hook capture completes at durable publication while old-pack pruning drains separately',{timeout:10000},async t=>{
 const f=await fixture(t);await f.checkpoints.capture('worker',f.project);const before=await f.checkpoints.list('worker',f.project);
 await writeFile(join(f.project,'file.txt'),'new checkpoint');const pruning=deferred(),release=deferred(),controller=new AbortController();t.after(()=>release.resolve());
 const git=f.checkpoints.git.bind(f.checkpoints);f.checkpoints.git=async(cwd,args,...rest)=>{
  if(args[0]==='update-ref'&&args[1]==='-d'&&args[2]===before[0].id){pruning.resolve();await release.promise;}
  return git(cwd,args,...rest);
 };
 const completed=f.checkpoints.capture('worker',f.project,controller.signal);await pruning.promise;await completed;
 controller.abort();release.resolve();await f.checkpoints.captures;
 const after=await f.checkpoints.list('worker',f.project);assert.equal(after.length,1);assert.notEqual(after[0].id,before[0].id);
 const loaded=new GitCheckpoints(text=>text,1,join(f.root,'registry.json'));assert.deepEqual(await loaded.list('worker',f.project),after);
});

test('restore serializes safety capture and both restores against queued captures and later restores',{timeout:15000},async t=>{
 const f=await fixture(t);await writeFile(join(f.project,'file.txt'),'saved uncommitted change');await f.checkpoints.capture('worker',f.project);const [point]=await f.checkpoints.list('worker',f.project);
 await writeFile(join(f.project,'file.txt'),'changed');const entered=deferred(),release=deferred();t.after(()=>release.resolve());
 const original=f.checkpoints.git.bind(f.checkpoints),operations=[];let hold=true;
 f.checkpoints.git=async(cwd,args,...rest)=>{if(args[0]==='stash'||args[0]==='restore')operations.push(args[0]==='stash'?'capture':args.includes('--staged')?'index':'worktree');if(args[0]==='restore'&&args.includes('--worktree')&&hold){hold=false;entered.resolve();await release.promise;}return original(cwd,args,...rest);};
 const restoring=f.checkpoints.restore('worker',f.project,point.id);await entered.promise;
 const captured=f.checkpoints.capture('later',f.project);assert.deepEqual(operations,['capture','worktree']);
 release.resolve();await Promise.all([restoring,captured]);assert.deepEqual(operations,['capture','worktree','index','capture']);
 const [later]=await f.checkpoints.list('later',f.project);assert.equal((await f.checkpoints.preview('later',f.project,later.id)).text,'');
});

test('large real Git preview is truncated and redacted while the complete checkpoint remains restorable',{timeout:15000},async t=>{
 const f=await fixture(t);await writeFile(join(f.project,'file.txt'),'saved text\n');await f.checkpoints.capture('worker',f.project);const [point]=await f.checkpoints.list('worker',f.project);
 f.checkpoints.redact=text=>text.replaceAll('PREVIEW_SECRET','[REDACTED]');
 await writeFile(join(f.project,'file.txt'),('PREVIEW_SECRET '+ 'x'.repeat(180)+'\n').repeat(16000));
 const preview=await f.checkpoints.preview('worker',f.project,point.id);
 assert.match(preview.text,/Preview truncated/);assert.match(preview.text,/\[REDACTED\]/);assert.doesNotMatch(preview.text,/PREVIEW_SECRET/);assert.ok(Buffer.byteLength(preview.text)<2*1024*1024+512);assert.deepEqual(preview.changedFiles,['file.txt']);
 await f.checkpoints.restore('worker',f.project,point.id);assert.equal(await readFile(join(f.project,'file.txt'),'utf8'),'saved text\n');
});

test('preview still rejects real Git command failures instead of calling them truncation',{timeout:10000},async t=>{
 const f=await fixture(t);await f.checkpoints.capture('worker',f.project);const [point]=await f.checkpoints.list('worker',f.project),original=f.checkpoints.git.bind(f.checkpoints);
 f.checkpoints.git=(cwd,args,...rest)=>original(cwd,args[0]==='diff'?[...args.slice(0,1),'--definitely-invalid-checkpoint-option',...args.slice(1)]:args,...rest);
 await assert.rejects(f.checkpoints.preview('worker',f.project,point.id),error=>error.code!==0&&/invalid|usage|unknown/i.test(error.stderr));
});
