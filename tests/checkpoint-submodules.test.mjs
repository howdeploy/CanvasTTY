import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitCheckpoints} from '../src/main/services/GitCheckpoints.ts';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ctty-checkpoint-submodule-'));
 const env={...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'};
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trimEnd();
 async function repository(name){const cwd=join(root,name);await mkdir(cwd);git(cwd,'init','-q');git(cwd,'config','user.name','Fixture');git(cwd,'config','user.email','fixture@example.invalid');git(cwd,'config','core.autocrlf','false');git(cwd,'config','core.eol','lf');await writeFile(join(cwd,'base.txt'),'base\n');git(cwd,'add','.');git(cwd,'commit','-qm','base');return cwd;}
 const nested=await repository('nested'),project=await repository('project'),checkpoints=new GitCheckpoints(x=>x);
 t.after(async()=>{await checkpoints.captures.catch(()=>{});await rm(root,{recursive:true,force:true});});
 const add=async()=>{git(project,'-c','protocol.file.allow=always','submodule','add','-q',nested,'module');git(join(project,'module'),'config','core.autocrlf','false');await writeFile(join(project,'module','base.txt'),'dirty nested contents\n');await writeFile(join(project,'module','untracked.txt'),'untracked nested contents\n');};
 return{root,project,git,checkpoints,add};
}

for(const kind of ['current index','saved worktree','saved index only'])test(`restore refuses ${kind} gitlink without mutating superproject or nested dirty/untracked content`,{timeout:30000},async t=>{
 const {project,git,checkpoints,add}=await fixture(t);await checkpoints.capture('worker',project);const [plain]=await checkpoints.list('worker',project);await add();let target=plain;
 if(kind!=='current index'){
  await checkpoints.capture('worker',project);target=(await checkpoints.list('worker',project)).find(row=>row.id!==plain.id);
  if(kind==='saved index only'){
   // Host snapshots store independent worktree and index objects. Keep the real saved gitlink index,
   // but use the plain saved worktree to exercise its independent validation.
   checkpoints.trusted.get(target.id).oid=checkpoints.trusted.get(plain.id).oid;
  }
  git(project,'rm','--cached','-q','-f','module');
 }
 await writeFile(join(project,'base.txt'),'superproject still dirty\n');await writeFile(join(project,'unrelated.txt'),'unrelated untracked\n');
 const beforeIndex=await readFile(join(project,'.git','index')),beforeStatus=git(project,'status','--porcelain=v1'),beforeRefs=await checkpoints.list('worker',project),nestedStatus=git(join(project,'module'),'status','--porcelain=v1');
 await assert.rejects(checkpoints.restore('worker',project,target.id),/submodule.*not captured/i);
 assert.deepEqual(await readFile(join(project,'.git','index')),beforeIndex);assert.equal(git(project,'status','--porcelain=v1'),beforeStatus);assert.deepEqual(await checkpoints.list('worker',project),beforeRefs,'no safety capture was created');
 assert.equal(await readFile(join(project,'base.txt'),'utf8'),'superproject still dirty\n');assert.equal(await readFile(join(project,'unrelated.txt'),'utf8'),'unrelated untracked\n');
 assert.equal(await readFile(join(project,'module','base.txt'),'utf8'),'dirty nested contents\n');assert.equal(await readFile(join(project,'module','untracked.txt'),'utf8'),'untracked nested contents\n');assert.equal(git(join(project,'module'),'status','--porcelain=v1'),nestedStatus);
});

test('gitlink preflight parses NUL records, not mode-looking text inside newline/tab filenames',async()=>{
 const checkpoints=new GitCheckpoints(x=>x),oid='a'.repeat(40),commands=[];
 checkpoints.git=async(_cwd,args)=>{commands.push(args);return args[0]==='ls-files'?`100644 ${oid} 0\tname\n160000 pretend\tfile\0`:`100644 blob ${oid}\tname\n160000 pretend\tfile\0`;};
 await checkpoints.requireRestorableTrees('/fixture',oid,oid);assert.equal(commands.length,3);assert.ok(commands.every(args=>args.includes('-z')));
 checkpoints.git=async()=>`100644 ${oid} 0\tordinary\0`+`160000 ${oid} 0\tactual module\0`;
 await assert.rejects(checkpoints.requireRestorableTrees('/fixture',oid,oid),/Submodule contents/);
});

test('unverifiable bounded gitlink inventory fails before any capture or restore',async()=>{
 const checkpoints=new GitCheckpoints(x=>x);checkpoints.git=async()=>{throw new Error('fixture inventory exceeded output bound');};
 await assert.rejects(checkpoints.requireRestorableTrees('/fixture','a'.repeat(40),'b'.repeat(40)),/exceeded output bound/);
});

test('ordinary tracked filenames containing 160000 remain restorable',{timeout:30000},async t=>{
 const {project,git,checkpoints}=await fixture(t),file=join(project,'ordinary 160000 file.txt');await writeFile(file,'saved ordinary text\n');git(project,'add','.');await checkpoints.capture('worker',project);const [point]=await checkpoints.list('worker',project);
 await writeFile(file,'changed ordinary text\n');await checkpoints.restore('worker',project,point.id);assert.equal(await readFile(file,'utf8'),'saved ordinary text\n');
});
