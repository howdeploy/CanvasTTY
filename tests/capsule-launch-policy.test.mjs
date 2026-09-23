import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskCapsuleService } from '../src/main/services/TaskCapsuleService.ts';
import { SessionLaunchPolicy } from '../src/main/services/SessionLaunchPolicy.ts';
import { CapsuleLaunchService } from '../src/main/services/CapsuleLaunchService.ts';

async function fixture(t, options = {}) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'ct-capsule-policy-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source');await mkdir(source);await mkdir(join(source,'src'));
  const git=args=>execFileSync('git',['-C',source,...args],{encoding:'utf8',env:{PATH:process.env.PATH,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:'pipe'}).trim();
  git(['init']);await writeFile(join(source,'src/public.ts'),'committed\n');await writeFile(join(source,'private.txt'),'private source');git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);
  await writeFile(join(source,'src/public.ts'),'current selected bytes\n');
  const profile={id:'capsule-image',label:'Capsule fixture',hostId:'local',runtime:'docker',executable:'/usr/bin/docker',endpoint:{kind:'unix',socket:'/run/fixture.sock'},image:'fixture:existing',python:'/usr/bin/python3',commands:{minimax:'/usr/bin/minimax'},network:'bridge',cpus:1,memoryMb:512,pids:64,user:`${process.getuid()}:${process.getgid()}`};
  const settings={defaultDataClass:'D2',pathPolicies:[{pattern:'/src/public.ts',dataClass:'D1'}],providerAccounts:[],apiProfiles:[],remoteHosts:[],containerProfiles:[profile],maxAccountsPerProviderPerHost:1};
  const storage=new TaskCapsuleService({rootDirectory:join(root,'capsules'), ...options});
  const capsules=new CapsuleLaunchService(storage,()=>settings);
  const policy=new SessionLaunchPolicy(()=>settings,{capsulePolicy:request=>capsules.classify(request)});
  const request=id=>({provider:'minimax',profile:'normal',cwd:source,isolation:{mode:'container',profileId:profile.id,capsuleId:id}});
  return {root,source,git,profile,settings,storage,capsules,policy,request};
}

test('registered capsule classifies selected current bytes and Task.md independently of the full source',async t=>{
  const f=await fixture(t);
  const capsule=await f.capsules.prepare({sourceCwd:f.source,files:['src/public.ts'],task:{text:'Edit this component',dataClass:'D1'}});
  assert.equal(capsule.dataClass,'D1');assert.equal(f.policy.classify(f.request(capsule.id)).dataClass,'D1');
  const stored=(await f.storage.list())[0];assert.equal(await readFile(join(stored.directory,'src/public.ts'),'utf8'),'current selected bytes\n');
  await assert.rejects(readFile(join(stored.directory,'private.txt')),{code:'ENOENT'});await assert.rejects(readFile(join(stored.directory,'.git')),{code:'ENOENT'});
  assert.throws(()=>f.policy.classify({...f.request(capsule.id),isolation:{mode:'container',profileId:f.profile.id}}),/D2/);
  assert.throws(()=>f.policy.classify({...f.request(capsule.id),dataClass:'D2'}),/D2/);
  f.settings.pathPolicies=[];assert.throws(()=>f.policy.classify(f.request(capsule.id)),/D2|class|policy/i);
});

test('capsule task class, unknown files, foreign source and current first-match rules cannot be downgraded',async t=>{
  const f=await fixture(t);
  for(const [files,dataClass] of [[['private.txt'],'D1'],[['src/public.ts'],'D2']]){
    const capsule=await f.capsules.prepare({sourceCwd:f.source,files,task:{text:'Task',dataClass}});
    assert.throws(()=>f.policy.classify(f.request(capsule.id)),/D2/);
  }
  const capsule=await f.capsules.prepare({sourceCwd:f.source,files:['src/public.ts'],task:{text:'Task',dataClass:'D1'}});
  assert.throws(()=>f.policy.classify({...f.request(capsule.id),cwd:f.root}),/source|capsule/i);
  assert.throws(()=>f.policy.classify({...f.request(capsule.id),allowSubagents:true}),/capsule|delegat/i);
  f.settings.pathPolicies.unshift({pattern:'**',dataClass:'D2'});assert.throws(()=>f.policy.classify(f.request(capsule.id)),/D2|class|policy/i);
});

test('capsule preparation refuses a nested Git boundary and a changed source repository identity',async t=>{
  const f=await fixture(t);await mkdir(join(f.source,'nested'));execFileSync('git',['-C',join(f.source,'nested'),'init'],{stdio:'pipe'});await writeFile(join(f.source,'nested','file.txt'),'nested source');
  await assert.rejects(f.capsules.prepare({sourceCwd:f.source,files:['nested/file.txt'],task:{text:'Task',dataClass:'D2'}}),/nested|repository|submodule/i);
  const capsule=await f.capsules.prepare({sourceCwd:f.source,files:['src/public.ts'],task:{text:'Task',dataClass:'D1'}});
  const {rename}=await import('node:fs/promises');await rename(join(f.source,'.git'),join(f.root,'kept-git'));f.git(['init']);
  await assert.rejects(f.capsules.verify(capsule.id),/repository|identity|changed/i);
});

test('review/apply binds current source policy and exports only the exact still-current snapshot', async t => {
  const f = await fixture(t), c = await f.capsules.prepare({ sourceCwd: f.source, files: ['src/public.ts'], task: { text: 'Task', dataClass: 'D1' } });
  await writeFile(join(c.directory, 'src/public.ts'), 'reviewed output\n');
  const review = await f.capsules.review(c.id);
  f.settings.theme = 'unrelated UI choice';
  assert.equal((await f.capsules.exportReview(c.id, review.reviewId)).patch, review.patch);
  f.settings.pathPolicies = [{ pattern: '/src/public.ts', dataClass: 'D2' }];
  await assert.rejects(f.capsules.apply(c.id, review.reviewId), /policy|review/i);
  assert.equal(await readFile(join(f.source, 'src/public.ts'), 'utf8'), 'current selected bytes\n');
  const fresh = await f.capsules.review(c.id);
  await writeFile(join(c.directory, 'src/public.ts'), 'unreviewed output\n');
  await assert.rejects(f.capsules.exportReview(c.id, fresh.reviewId), /changed|review/i);
  const next = await f.capsules.review(c.id); await f.capsules.apply(c.id, next.reviewId);
  assert.equal(await readFile(join(f.source, 'src/public.ts'), 'utf8'), 'unreviewed output\n');
});

test('changing source policy immediately before the first write rolls back without applying output', async t => {
  let f; f = await fixture(t, { beforeApplyWrite: () => { f.settings.pathPolicies = []; } });
  const c = await f.capsules.prepare({ sourceCwd: f.source, files: ['src/public.ts'], task: { text: 'Task', dataClass: 'D1' } });
  await writeFile(join(c.directory, 'src/public.ts'), 'reviewed output\n');
  const review = await f.capsules.review(c.id);
  await assert.rejects(f.capsules.apply(c.id, review.reviewId), /rolled back/);
  assert.equal(await readFile(join(f.source, 'src/public.ts'), 'utf8'), 'current selected bytes\n');
  assert.equal((await f.capsules.list())[0].state, 'retained');
});

test('selected-file picker paths stay inside their canonical original directory and do not enumerate', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.capsules.selectedFiles(f.source, [join(f.source, 'src/public.ts')]), ['src/public.ts']);
  await assert.rejects(f.capsules.selectedFiles(f.source, [join(f.root, 'outside.txt')]), /outside|path|ENOENT/);
  const { symlink } = await import('node:fs/promises'); await symlink(join(f.source, 'src/public.ts'), join(f.source, 'link.ts'));
  await assert.rejects(f.capsules.selectedFiles(f.source, [join(f.source, 'link.ts')]), /link|canonical/);
});
