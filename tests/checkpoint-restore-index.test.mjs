import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitCheckpoints} from '../src/main/services/GitCheckpoints.ts';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ctty-checkpoint-index-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false');git('config','core.eol','lf');
 for(const name of ['file.txt','remove.txt','rename-old.txt','unstaged-delete.txt'])await writeFile(join(root,name),`base ${name}\n`);
 git('add','.');git('commit','-qm','base');const checkpoints=new GitCheckpoints(text=>text);
 t.after(async()=>{await checkpoints.captures.catch(()=>{});await rm(root,{recursive:true,force:true});});
 return{root,git,checkpoints};
}

for(const change of ['addition','removal','rename','combined'])test(`checkpoint restore reverses staged ${change} and can round-trip through its safety checkpoint`,{timeout:30000},async t=>{
 const {root,git,checkpoints}=await fixture(t);
 // Save an index/worktree split plus a path that will later be absent from the current index.
 await writeFile(join(root,'file.txt'),'target index\n');await writeFile(join(root,'target-added.txt'),'target added index\n');git('add','file.txt','target-added.txt');
 await writeFile(join(root,'file.txt'),'target worktree\n');await writeFile(join(root,'target-added.txt'),'target added worktree\n');
 await checkpoints.capture('worker',root);const [target]=await checkpoints.list('worker',root);
 const savedIndex=git('diff','--cached','--binary'),savedWorktree=git('diff','--binary');
 if(change==='addition'||change==='combined'){await writeFile(join(root,'new.txt'),'new staged file\n');git('add','new.txt');await writeFile(join(root,'new.txt'),'new unstaged contents\n');}
 if(change==='removal'||change==='combined')git('rm','-q','remove.txt');
 if(change==='rename'||change==='combined')git('mv','rename-old.txt','renamed-new.txt');
 git('rm','-q','-f','target-added.txt');await writeFile(join(root,'file.txt'),'later index\n');git('add','file.txt');await writeFile(join(root,'file.txt'),'later worktree\n');await rm(join(root,'unstaged-delete.txt'));
 await writeFile(join(root,'unrelated.txt'),'untracked unrelated\n');
 const beforeIndex=git('diff','--cached','--binary'),beforeWorktree=git('diff','--binary'),beforeStatus=git('status','--porcelain=v1');
 await checkpoints.restore('worker',root,target.id);
 if(change==='addition'||change==='combined')await assert.rejects(stat(join(root,'new.txt')),{code:'ENOENT'},'post-checkpoint staged addition must be removed from disk');
 if(change==='rename'||change==='combined')await assert.rejects(stat(join(root,'renamed-new.txt')),{code:'ENOENT'},'post-checkpoint rename destination must not survive as an untracked file');
 assert.equal(git('diff','--cached','--binary'),savedIndex);assert.equal(git('diff','--binary'),savedWorktree);
 assert.equal(await readFile(join(root,'target-added.txt'),'utf8'),'target added worktree\n');assert.equal(git('show',':target-added.txt'),'target added index\n');
 assert.equal(await readFile(join(root,'unrelated.txt'),'utf8'),'untracked unrelated\n');
 const safety=(await checkpoints.list('worker',root)).find(row=>row.id!==target.id);assert.ok(safety);
 await checkpoints.restore('worker',root,safety.id);
 assert.equal(git('diff','--cached','--binary'),beforeIndex);assert.equal(git('diff','--binary'),beforeWorktree);assert.equal(git('status','--porcelain=v1'),beforeStatus);
 if(change==='addition'||change==='combined'){assert.equal(git('show',':new.txt'),'new staged file\n');assert.equal(await readFile(join(root,'new.txt'),'utf8'),'new unstaged contents\n');}
 assert.equal(await readFile(join(root,'unrelated.txt'),'utf8'),'untracked unrelated\n');
});
