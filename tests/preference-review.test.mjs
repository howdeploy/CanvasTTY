import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskCapsuleService } from '../src/main/services/TaskCapsuleService.ts';
import { CapsuleLaunchService } from '../src/main/services/CapsuleLaunchService.ts';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-advisory-review-'))), source = join(root, 'source');
  await mkdir(source); execFileSync('git', ['init', source], { stdio: 'ignore' });
  await writeFile(join(source, 'code.ts'), 'private before\n');
  const settings = { defaultDataClass: 'D2', pathPolicies: [] };
  const storage = new TaskCapsuleService({ rootDirectory: join(root, 'capsules') }), capsules = new CapsuleLaunchService(storage, () => settings);
  const parent = randomUUID(), authority = { generation: randomUUID(), binding: 'parent', cwd: source, dataClass: 'D2' };
  capsules.configureParentAuthority(id => { if (id !== parent) throw Error('Wrong parent'); return authority; });
  const original = await capsules.prepareForParent(parent, ['code.ts'], 'Change code');
  await writeFile(join(original.directory, 'code.ts'), 'private after\n');
  const review = await capsules.review(original.id);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source, settings, storage, capsules, parent, authority, original, review };
}

test('derived advisory artifact has only immutable patch/task, no source baseline or apply authority', async t => {
  const f = await fixture(t);
  const derived = await f.capsules.prepareAdvisory(f.original.id, f.review.reviewId, f.parent);
  assert.equal(derived.kind, 'advisory-review');
  assert.deepEqual((await readdir(derived.directory)).sort(), ['Review.patch', 'Task.md']);
  assert.equal(await readFile(join(derived.directory, 'Review.patch'), 'utf8'), f.review.patch);
  const manifest = JSON.parse(await readFile(join(f.root, 'capsules', derived.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 0);
  for (const operation of [() => f.capsules.review(derived.id), () => f.capsules.apply(derived.id, f.review.reviewId), () => f.capsules.recoverApply(derived.id, f.review.reviewId), () => f.capsules.conventionSnapshot(derived.id, f.review.reviewId)]) await assert.rejects(operation(), /advisory|source capsule/i);
  const request = { cwd: f.source, isolation: { mode: 'container', profileId: 'image', capsuleId: derived.id }, parentSessionId: f.parent, role: 'subagent', allowSubagents: false };
  assert.equal(f.capsules.classify(request), 'D2');
  const recovered = new CapsuleLaunchService(new TaskCapsuleService({ rootDirectory: join(f.root, 'capsules') }), () => f.settings);
  recovered.configureParentAuthority(() => f.authority); await recovered.storage.recover();
  assert.throws(() => recovered.classify(request), /live|expired|advisory/i);
  await f.capsules.cleanup(derived.id);
});

test('advisory live proof notices source, reviewed output, policy, owner and derived payload changes synchronously', async t => {
  for (const mutation of ['source', 'output', 'policy', 'owner', 'payload']) {
    const f = await fixture(t), derived = await f.capsules.prepareAdvisory(f.original.id, f.review.reviewId, f.parent);
    if (mutation === 'source') await writeFile(join(f.source, 'code.ts'), 'new source');
    if (mutation === 'output') await writeFile(join(f.original.directory, 'code.ts'), 'new output');
    if (mutation === 'policy') f.settings.defaultDataClass = 'D3';
    if (mutation === 'owner') f.authority.generation = randomUUID();
    if (mutation === 'payload') { await chmod(join(derived.directory, 'Review.patch'), 0o600); await writeFile(join(derived.directory, 'Review.patch'), 'forged'); }
    assert.throws(() => f.capsules.classify({ cwd: f.source, isolation: { mode: 'container', profileId: 'image', capsuleId: derived.id }, parentSessionId: f.parent, role: 'subagent', allowSubagents: false }), /changed|expired|authorized|advisory/i, mutation);
  }
});

import { preferenceReviewFixture } from './helpers/preference-review-fixture.mjs';
import { DEFAULT_AGENT_BUDGETS } from '../src/shared/contracts.ts';

test('real budget/account/coordinator chain creates readonly diff-only child with actual filtered context once', async t => {
  const f = await preferenceReviewFixture(t);
  const choices = await f.reviews.choices(f.original.id, f.review.reviewId);
  assert.equal(choices.parents[0].id, f.parent.id); assert.equal(choices.routes.length, 1);
  const preview = await f.reviews.preview(f.input);
  assert.match(preview.text, /REVIEW_PRIVATE_PREFERENCE/); assert.doesNotMatch(preview.text, /NEVER_DISCLOSE_D3/);
  assert.equal(f.keyReads(), 0); assert.equal(f.engine.calls.length, 0);
  const child = await f.reviews.launch(preview.previewId); await f.manager.waitForLaunch(child.id);
  const actual = f.manager.list().find(s => s.id === child.id);
  assert.equal(actual.exitCode, null, actual.failureDetails); assert.equal(actual.allowSubagents, false); assert.equal(actual.dataClass, 'D2');
  const created = f.engine.calls.find(c => c.args.includes('create'));
  assert.match(created.args.find(a => a.startsWith('--mount=')), /readonly=true/);
  assert.equal(created.args.filter(a => a.startsWith('--mount=')).length, 1);
  assert.equal(created.args.some(a => a.includes(f.source)), false);
  const recipe = JSON.parse(created.environment.CANVASTTY_CONTAINER_RECIPE);
  const prompt = recipe.args[recipe.args.indexOf('--prompt') + 1];
  assert.match(prompt, /immutable.*Review.patch/); assert.equal(prompt.match(/REVIEW_PRIVATE_PREFERENCE/g)?.length, 1); assert.doesNotMatch(prompt, /NEVER_DISCLOSE_D3/);
  const derived = f.storage.describe(actual.execution.workspaceId);
  assert.deepEqual((await readdir(derived.directory)).filter(n => !n.startsWith('.canvastty-')).sort(), ['Review.patch', 'Task.md']);
  assert.equal(await readFile(join(derived.directory, 'Review.patch'), 'utf8'), f.review.patch);
  assert.equal(f.calls.filter(c => c.command === '/usr/bin/docker').length, 1);
  assert.throws(() => f.control.spawn({ parentSessionId: child.id, provider: 'claude', cwd: f.source }), /delegation/);
  assert.throws(() => f.control.send(child.id, 'apply now'), /Task.md|classified/);
  await f.stop(child.id); assert.equal((await f.capsules.summary(derived.id)).state, 'retained');
  await f.capsules.cleanup(derived.id); assert.equal(await readFile(join(f.source, 'code.ts'), 'utf8'), 'private before\n');
});

test('D2 deleted bytes cannot reach a D0 model, and budget/owner/route rejection does no credential or engine work', async t => {
  for (const reason of ['class', 'budget', 'owner', 'route', 'forged']) {
    const f = await preferenceReviewFixture(t, { deleted: true });
    let input = f.input;
    if (reason === 'class') f.settings.providerAccounts[0].maxDataClass = 'D0';
    if (reason === 'budget') f.settings.agentBudgets = { ...DEFAULT_AGENT_BUDGETS, maxLocalAgents: 1 };
    if (reason === 'owner') input = { ...input, parentSessionId: randomUUID() };
    if (reason === 'route') input = { ...input, model: 'not-configured' };
    if (reason === 'forged') input = { ...input, patch: 'fake D0 patch' };
    await assert.rejects(f.reviews.preview(input), /D2|limit|authorized|route|fields|account/i);
    assert.equal(f.keyReads(), 0, reason); assert.equal(f.engine.calls.length, 0, reason); assert.equal((await f.storage.list()).length, 1);
  }
});

test('preview becomes stale on context, output, source, policy and owner changes before allocation', async t => {
  for (const kind of ['context', 'output', 'source', 'policy', 'owner']) {
    const f = await preferenceReviewFixture(t), preview = await f.reviews.preview(f.input);
    if (kind === 'context') { const state = f.store.get(); await f.store.saveRule({ scope: 'project', ownerId: f.projectId, category: 'design', key: 'new-rule', value: 'changed', dataClass: 'D2', tags: [], enabled: true }, state.revision); }
    if (kind === 'output') await writeFile(join(f.original.directory, 'code.ts'), 'new output');
    if (kind === 'source') await writeFile(join(f.source, 'code.ts'), 'new source');
    if (kind === 'policy') f.settings.pathPolicies = [{ pattern: '/code.ts', dataClass: 'D3' }];
    if (kind === 'owner') f.manager.dispose(f.parent.id);
    await assert.rejects(f.reviews.launch(preview.previewId), /changed|authorized|current|stale|expired|running/i, kind);
    assert.equal(f.keyReads(), 0); assert.equal(f.engine.calls.length, 0); assert.equal((await f.storage.list()).length, 1);
  }
});

test('inherited optional context opt-out does not disable mandatory diff class', async t => {
  const f = await preferenceReviewFixture(t, { parentContextOff: true });
  const preview = await f.reviews.preview(f.input); assert.equal(preview.text, ''); assert.equal(preview.dataClass, 'D2');
  const child = await f.reviews.launch(preview.previewId); await f.manager.waitForLaunch(child.id);
  const actual = f.manager.list().find(s => s.id === child.id); assert.equal(actual.contextDisabled, true); assert.equal(actual.exitCode, null, actual.failureDetails);
  const created = f.engine.calls.find(c => c.args.includes('create')); assert.doesNotMatch(created.environment.CANVASTTY_CONTAINER_RECIPE, /REVIEW_PRIVATE_PREFERENCE/);
  await f.stop(child.id);
});

test('cancellation crosses capture, allocation, reserve, credential, engine and pre-spawn boundaries', async t => {
  for (const boundary of ['capture', 'allocation', 'reserve', 'credential', 'engine', 'created']) {
    const abort = new AbortController();
    const hooks = boundary === 'credential' ? { account: async () => abort.abort() } : boundary === 'engine' ? { info: async () => abort.abort() } : boundary === 'created' ? { created: async () => abort.abort() } : {};
    const f = await preferenceReviewFixture(t, hooks);
    if (boundary === 'capture') {
      const original = f.capsules.conventionSnapshot.bind(f.capsules);
      f.capsules.conventionSnapshot = async (...args) => { const result = await original(...args); abort.abort(); return result; };
      await assert.rejects(f.reviews.preview(f.input, abort.signal), /abort/i);
    } else {
      const preview = await f.reviews.preview(f.input);
      if (boundary === 'allocation' || boundary === 'reserve') {
        const name = boundary === 'allocation' ? 'createAdvisory' : 'reserve', original = f.storage[name].bind(f.storage);
        f.storage[name] = async (...args) => { const result = await original(...args); abort.abort(); return result; };
      }
      if (boundary === 'allocation') await assert.rejects(f.reviews.launch(preview.previewId, undefined, abort.signal), /abort/i);
      else { const child = await f.reviews.launch(preview.previewId, undefined, abort.signal); await f.manager.waitForLaunch(child.id); assert.notEqual(f.manager.list().find(s => s.id === child.id)?.exitCode, null); }
    }
    assert.equal(f.calls.filter(c => c.command === '/usr/bin/docker').length, 0, boundary);
    if (['capture', 'allocation', 'reserve'].includes(boundary)) { assert.equal(f.keyReads(), 0); assert.equal(f.engine.calls.length, 0); }
    if (boundary === 'created') assert.equal(f.engine.state.exists, false);
  }
});

test('source change after reservation rejects synchronously before credential lookup', async t => {
  const f = await preferenceReviewFixture(t), preview = await f.reviews.preview(f.input);
  const reserve = f.storage.reserve.bind(f.storage);
  f.storage.reserve = async (...args) => { const result = await reserve(...args); await writeFile(join(f.source, 'code.ts'), 'swapped just before secret'); return result; };
  const child = await f.reviews.launch(preview.previewId); await f.manager.waitForLaunch(child.id);
  assert.equal(f.keyReads(), 0); assert.equal(f.engine.calls.length, 0); assert.equal(f.calls.length, 1);
});

test('original preview context and route stay bound across credential waits', async t => {
  for (const kind of ['context', 'config', 'source', 'output', 'owner']) {
    let f;
    f = await preferenceReviewFixture(t, { account: async () => {
      if (kind === 'context') { const state = f.store.get(); await f.store.saveRule({ scope: 'project', ownerId: f.projectId, category: 'design', key: 'new', value: 'late context', dataClass: 'D2', tags: [], enabled: true }, state.revision); }
      if (kind === 'config') f.settings.containerProfiles[0].memoryMb = 768;
      if (kind === 'source') await writeFile(join(f.source, 'code.ts'), 'late source');
      if (kind === 'output') await writeFile(join(f.original.directory, 'code.ts'), 'late output');
      if (kind === 'owner') f.manager.dispose(f.parent.id);
    } });
    const preview = await f.reviews.preview(f.input), child = await f.reviews.launch(preview.previewId); await f.manager.waitForLaunch(child.id);
    assert.equal(f.keyReads(), 1); assert.equal(f.engine.calls.length, 0, kind); assert.equal(f.calls.length, 1);
    assert.notEqual(f.manager.list().find(s => s.id === child.id)?.exitCode, null);
  }
});

test('payload tampering after daemon create is stopped before PTY, and rejected RW inspection retains uncertainty', async t => {
  const f = await preferenceReviewFixture(t, { created: async dir => { await chmod(join(dir, 'Review.patch'), 0o600); await writeFile(join(dir, 'Review.patch'), 'forged'); } });
  const p = await f.reviews.preview(f.input), child = await f.reviews.launch(p.previewId); await f.manager.waitForLaunch(child.id);
  assert.equal(f.calls.length, 1); assert.equal(f.engine.state.exists, false);
  const g = await preferenceReviewFixture(t, { inspect: async record => { record.Mounts[0].RW = true; } });
  const q = await g.reviews.preview(g.input), failed = await g.reviews.launch(q.previewId); await g.manager.waitForLaunch(failed.id);
  assert.equal(g.calls.length, 1); assert.equal(g.engine.state.exists, true); assert.equal((await g.containers.list())[0].state, 'cleanup-needed');
});

test('ownerless choices are explicit, scoped previews omit preferences, and preview tokens cannot cross owners', async t => {
  const f = await preferenceReviewFixture(t);
  const ownerless = await f.capsules.prepare({ sourceCwd: f.source, files: ['code.ts'], task: { text: 'User task', dataClass: 'D2' } });
  assert.equal((await f.reviews.choices(ownerless.id, randomUUID())).unavailable, 'ownerless');
  const args = { capsuleId: f.original.id, reviewId: f.review.reviewId, accountId: 'api', model: 'fixture-model', containerProfileId: 'image' };
  const result = await f.scope.execute(f.parent.id, 'preview_capsule_review_agent', args);
  assert.equal(result.text, undefined); assert.doesNotMatch(JSON.stringify(result), /REVIEW_PRIVATE_PREFERENCE/);
  await assert.rejects(f.reviews.launch(result.previewId, randomUUID()), /another parent/);
  f.reviews.cancel(result.previewId, f.parent.id); await assert.rejects(f.reviews.launch(result.previewId), /expired/);
  assert.equal(f.keyReads(), 0);
});

test('unknown/forged artifact kinds never become source baselines or restart authority', async t => {
  for (const kind of ['unknown', undefined, 'source']) {
    const f = await fixture(t), derived = await f.capsules.prepareAdvisory(f.original.id, f.review.reviewId, f.parent);
    const path = join(f.root, 'capsules', derived.id, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.capsule.kind = kind; await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
    const recovered = new TaskCapsuleService({ rootDirectory: join(f.root, 'capsules') });
    const item = (await recovered.list()).find(c => c.id === derived.id); assert.equal(item.state, 'unavailable');
    await assert.rejects(recovered.apply(derived.id, f.review.reviewId), /manifest|Invalid/);
  }
});

test('synchronous seal rejects enlarged source/payload and metadata before unbounded reads', async t => {
  const f = await fixture(t), guard = f.storage.freshnessGuard(f.original.id, true);
  await writeFile(join(f.source, 'code.ts'), Buffer.alloc(2 * 1024 * 1024));
  assert.throws(guard, /changed/);
  const g = await fixture(t), second = g.storage.freshnessGuard(g.original.id, true);
  await writeFile(join(g.root, 'capsules', g.original.id, 'review.json'), 'new metadata', { mode: 0o600 });
  assert.throws(second, /changed/);
});

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
test('synchronous seal bounds a file that grows after fstat and checks changed review metadata before source reads', async t => {
  const f = await fixture(t), guard = f.storage.freshnessGuard(f.original.id, true), originalRead = fs.readSync;
  let changed = false;
  fs.readSync = (...args) => { if (!changed && fs.fstatSync(args[0]).ino === fs.statSync(join(f.root, 'capsules', f.original.id, 'manifest.json')).ino) { changed = true; fs.appendFileSync(join(f.root, 'capsules', f.original.id, 'manifest.json'), 'grow'); } return originalRead(...args); };
  syncBuiltinESMExports();
  try { assert.throws(guard, /changed/); } finally { fs.readSync = originalRead; syncBuiltinESMExports(); }
  const g = await fixture(t), check = g.storage.freshnessGuard(g.original.id, true);
  await writeFile(join(g.root, 'capsules', g.original.id, 'manifest.json'), 'changed metadata', { mode: 0o600 });
  let reads = 0; fs.readSync = (...args) => { reads++; return originalRead(...args); }; syncBuiltinESMExports();
  try { assert.throws(check, /changed/); assert.equal(reads, 4); /* Two bounded ownership files through EOF; no payload/source read. */ } finally { fs.readSync = originalRead; syncBuiltinESMExports(); }
});

test('derived manifest or installation ownership replacement after reservation cannot precede secret access', async t => {
  for (const kind of ['manifest', 'owner']) {
    const f = await preferenceReviewFixture(t), preview = await f.reviews.preview(f.input), reserve = f.storage.reserve.bind(f.storage);
    f.storage.reserve = async (id, ...args) => { const result = await reserve(id, ...args); const path = kind === 'manifest' ? join(f.root, 'capsules', id, 'manifest.json') : join(f.root, 'capsules', 'owner'); await writeFile(path, 'replaced', { mode: 0o600 }); return result; };
    const child = await f.reviews.launch(preview.previewId); await f.manager.waitForLaunch(child.id);
    assert.equal(f.keyReads(), 0); assert.equal(f.engine.calls.length, 0); assert.equal(f.calls.length, 1);
  }
});
