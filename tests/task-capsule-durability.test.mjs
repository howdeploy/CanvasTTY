import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskCapsuleService } from '../src/main/services/TaskCapsuleService.ts';

async function fixture(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'ct-capsule-durable-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const sourceDirectory=join(root,'source'),rootDirectory=join(root,'capsules');await mkdir(sourceDirectory);await mkdir(join(sourceDirectory,'src'));
  await writeFile(join(sourceDirectory,'src/component.ts'),'current uncommitted bytes\n',{mode:0o640});
  const input={sourceDirectory,files:['src/component.ts'],task:'Change selected component',dataClass:'D1',classifyFile:()=> 'D1'};
  return {root,rootDirectory,input,service:new TaskCapsuleService({rootDirectory})};
}

test('durable capsules retain edited bytes and private baseline after dispose and recovery',async t=>{
  const f=await fixture(t),capsule=await f.service.create(f.input);
  await writeFile(join(capsule.directory,'src/component.ts'),'retained output\n');await f.service.dispose();
  assert.equal(await readFile(join(capsule.directory,'src/component.ts'),'utf8'),'retained output\n');
  const recovered=new TaskCapsuleService({rootDirectory:f.rootDirectory});
  const rows=await recovered.list();assert.equal(rows.length,1);assert.equal(rows[0].id,capsule.id);assert.equal(rows[0].state,'retained');
  const review=await recovered.review(capsule.id);assert.match(review.patch,/-current uncommitted bytes/);assert.match(review.patch,/\+retained output/);
  await assert.rejects(recovered.cleanup(capsule.id),/changed|output|dirty/);
  assert.equal(await readFile(join(f.input.sourceDirectory,'src/component.ts'),'utf8'),'current uncommitted bytes\n');
});

test('durable capsule leases survive restart and only the exact confirmed lease releases output',async t=>{
  const f=await fixture(t),capsule=await f.service.create(f.input),lease=randomUUID();
  await f.service.reserve(capsule.id,lease);await f.service.setRunning(capsule.id,lease);await f.service.dispose();
  const recovered=new TaskCapsuleService({rootDirectory:f.rootDirectory});assert.equal((await recovered.list())[0].state,'uncertain');
  await assert.rejects(recovered.review(capsule.id),/confirm|running|uncertain|busy/);
  await recovered.confirmContainerStopped(capsule.id,randomUUID());assert.equal((await recovered.list())[0].state,'uncertain');
  await recovered.confirmContainerStopped(capsule.id,lease);assert.equal((await recovered.list())[0].state,'retained');
  await recovered.cleanup(capsule.id);assert.equal((await recovered.list()).length,0);
});

test('unused durable capsule storage performs no filesystem writes',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.service.list(),[]);await f.service.dispose();
  await assert.rejects(access(f.rootDirectory),{code:'ENOENT'});
});

test('corrupt or replaced capsule ownership stays discoverable and cannot delete source or output',async t=>{
  for(const scenario of ['missing manifest','foreign owner','modified baseline','linked manifest','replaced workspace','replaced source','public metadata'])await t.test(scenario,async t=>{
    const f=await fixture(t),capsule=await f.service.create(f.input),directory=join(f.rootDirectory,capsule.id),manifest=join(directory,'manifest.json');
    if(scenario==='missing manifest')await rm(manifest);
    if(scenario==='foreign owner')await writeFile(join(directory,'owner'),randomUUID());
    if(scenario==='modified baseline'){const value=JSON.parse(await readFile(manifest,'utf8'));value.files[0].path='../outside';await writeFile(manifest,JSON.stringify(value));}
    if(scenario==='linked manifest'){const original=join(f.root,'linked-manifest');await rename(manifest,original);await symlink(original,manifest);}
    if(scenario==='replaced workspace'){await rename(capsule.directory,capsule.directory+'-kept');await symlink(f.input.sourceDirectory,capsule.directory);}
    if(scenario==='replaced source'){await rename(f.input.sourceDirectory,f.input.sourceDirectory+'-kept');await mkdir(f.input.sourceDirectory);}
    if(scenario==='public metadata')await chmod(manifest,0o644);
    const recovered=new TaskCapsuleService({rootDirectory:f.rootDirectory}),rows=await recovered.list();
    assert.equal(rows.length,1);assert.equal(rows[0].state,'unavailable');
    await assert.rejects(recovered.cleanup(capsule.id));await assert.rejects(recovered.review(capsule.id));
    await access(directory);await access(f.input.sourceDirectory);
  });
});

test('durable cleanup refuses changed Task.md, output links and metadata changes after recovery',async t=>{
  const f=await fixture(t),capsule=await f.service.create(f.input);
  await writeFile(join(capsule.directory,'Task.md'),'retain this task edit');await assert.rejects(f.service.cleanup(capsule.id),/task changed/);
  await writeFile(join(capsule.directory,'Task.md'),f.input.task);
  await link(join(f.input.sourceDirectory,'src/component.ts'),join(capsule.directory,'extra'));
  await assert.rejects(f.service.review(capsule.id),/unselected|unlinked/i);await rm(join(capsule.directory,'extra'));
  const path=join(f.rootDirectory,capsule.id,'manifest.json'),value=JSON.parse(await readFile(path,'utf8'));
  value.createdAt++;await writeFile(path,JSON.stringify(value));await assert.rejects(f.service.reserve(capsule.id,randomUUID()),/manifest changed/);
});

test('capsule apply uses a durable frozen review, preserves rw permissions and is idempotent',async t=>{
  const f=await fixture(t),capsule=await f.service.create(f.input);
  await writeFile(join(capsule.directory,'src/component.ts'),Buffer.from([0,1,255,0,2]));await chmod(join(capsule.directory,'src/component.ts'),0o755);
  const review=await f.service.review(capsule.id);assert.match(review.reviewId,/^[a-f0-9-]{36}$/);assert.match(review.digest,/^[a-f0-9]{64}$/);
  const exactPatch=review.patch;review.patch='malicious replacement';
  const recovered=new TaskCapsuleService({rootDirectory:f.rootDirectory});await recovered.recover();
  assert.equal((await recovered.exportReview(capsule.id,review.reviewId)).patch,exactPatch);
  const applied=await recovered.apply(capsule.id,review.reviewId);assert.equal(applied.digest,review.digest);
  assert.deepEqual(await readFile(join(f.input.sourceDirectory,'src/component.ts')),Buffer.from([0,1,255,0,2]));
  const {stat}=await import('node:fs/promises');assert.equal((await stat(join(f.input.sourceDirectory,'src/component.ts'))).mode&0o777,0o751);
  await writeFile(join(f.input.sourceDirectory,'src/component.ts'),'later user edit');
  assert.deepEqual(await recovered.apply(capsule.id,review.reviewId),applied);
  assert.equal(await readFile(join(f.input.sourceDirectory,'src/component.ts'),'utf8'),'later user edit');
});

test('capsule apply rejects changed source and changed output before modifying any original file',async t=>{
  const f=await fixture(t);await writeFile(join(f.input.sourceDirectory,'second.txt'),'second original');f.input.files.push('second.txt');
  const capsule=await f.service.create(f.input);await writeFile(join(capsule.directory,'src/component.ts'),'first output');await rm(join(capsule.directory,'second.txt'));
  const review=await f.service.review(capsule.id);await writeFile(join(f.input.sourceDirectory,'second.txt'),'user edit');
  await assert.rejects(f.service.apply(capsule.id,review.reviewId),/source.*changed/i);
  assert.equal(await readFile(join(f.input.sourceDirectory,'src/component.ts'),'utf8'),'current uncommitted bytes\n');
  await writeFile(join(f.input.sourceDirectory,'second.txt'),'second original');await writeFile(join(capsule.directory,'src/component.ts'),'later output');
  await assert.rejects(f.service.apply(capsule.id,review.reviewId),/review|output.*changed/i);
  assert.equal(await readFile(join(f.input.sourceDirectory,'second.txt'),'utf8'),'second original');
});

test('failed capsule apply rolls back completed writes while retaining its reviewed result',async t=>{
  const f=await fixture(t);await writeFile(join(f.input.sourceDirectory,'second.txt'),'second original');f.input.files.push('second.txt');
  let writes=0;const service=new TaskCapsuleService({rootDirectory:f.rootDirectory,beforeApplyWrite:()=>{if(++writes===2)throw Error('fixture write failure');}});
  const capsule=await service.create(f.input);await writeFile(join(capsule.directory,'src/component.ts'),'first output');await writeFile(join(capsule.directory,'second.txt'),'second output');
  const review=await service.review(capsule.id);await assert.rejects(service.apply(capsule.id,review.reviewId),/rolled back/i);
  assert.equal(await readFile(join(f.input.sourceDirectory,'src/component.ts'),'utf8'),'current uncommitted bytes\n');
  assert.equal(await readFile(join(f.input.sourceDirectory,'second.txt'),'utf8'),'second original');
  assert.equal(await readFile(join(capsule.directory,'src/component.ts'),'utf8'),'first output');
});

test('uncertain apply preserves concurrent user edits and supports explicit safe recovery after restart',async t=>{
  const f=await fixture(t);await writeFile(join(f.input.sourceDirectory,'second.txt'),'second original');f.input.files.push('second.txt');
  let writes=0;const service=new TaskCapsuleService({rootDirectory:f.rootDirectory,beforeApplyWrite:async()=>{if(++writes===2){await writeFile(join(f.input.sourceDirectory,'src/component.ts'),'concurrent user edit');throw Error('fixture interrupted apply');}}});
  const capsule=await service.create(f.input);await writeFile(join(capsule.directory,'src/component.ts'),'first output');await writeFile(join(capsule.directory,'second.txt'),'second output');
  const review=await service.review(capsule.id);await assert.rejects(service.apply(capsule.id,review.reviewId),/needs recovery/);
  const recovered=new TaskCapsuleService({rootDirectory:f.rootDirectory});assert.equal((await recovered.list())[0].state,'apply-recovery-needed');
  await assert.rejects(recovered.recoverApply(capsule.id,review.reviewId),/source|recovery/i);
  assert.equal(await readFile(join(f.input.sourceDirectory,'src/component.ts'),'utf8'),'concurrent user edit');
  await writeFile(join(f.input.sourceDirectory,'src/component.ts'),'first output');
  await recovered.recoverApply(capsule.id,review.reviewId);
  assert.equal(await readFile(join(f.input.sourceDirectory,'src/component.ts'),'utf8'),'current uncommitted bytes\n');
  assert.equal((await recovered.list())[0].state,'retained');
});

test('capsule review refuses non-UTF8 text patches rather than exporting replacement characters',async t=>{
  const f=await fixture(t),capsule=await f.service.create(f.input);
  await writeFile(join(capsule.directory,'src/component.ts'),Buffer.from([255,254,10]));
  await assert.rejects(f.service.review(capsule.id),/UTF|encoding|encoded/i);
  assert.deepEqual(await readFile(join(capsule.directory,'src/component.ts')),Buffer.from([255,254,10]));
});

test('reviewed deletion applies exactly and stale or foreign review tokens cannot write source',async t=>{
  const f=await fixture(t),first=await f.service.create(f.input),second=await f.service.create(f.input);
  await rm(join(first.directory,'src/component.ts'));const review=await f.service.review(first.id);
  await assert.rejects(f.service.apply(second.id,review.reviewId),/expired/);
  const next=await f.service.review(first.id);await assert.rejects(f.service.apply(first.id,review.reviewId),/expired/);
  await f.service.apply(first.id,next.reviewId);await assert.rejects(access(join(f.input.sourceDirectory,'src/component.ts')),{code:'ENOENT'});
  const recovered=new TaskCapsuleService({rootDirectory:f.rootDirectory});
  assert.equal((await recovered.apply(first.id,next.reviewId)).digest,next.digest);
});
