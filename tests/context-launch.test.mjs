import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextProfileStore } from '../src/main/services/ContextProfileStore.ts';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-context-launch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'context'), project = join(root, 'project'); await mkdir(project);
  const store = new ContextProfileStore(directory);
  let state = await store.saveProject({ label: 'Project', root: project }, 0);
  const projectId = state.projects[0].id;
  state = await store.saveTask({ label: 'Task', projectId }, state.revision);
  const taskId = state.tasks[0].id;
  return { root, directory, project, projectId, taskId, store, file: join(directory, 'profiles.json') };
}

test('captured context detects same-revision external edits, internal writes and unsafe registry replacement', async t => {
  for (const mutation of ['external', 'internal', 'deleted', 'mode', 'symlink']) {
    const f = await fixture(t), capture = f.store.capture();
    assert.equal(capture.revision, f.store.get().revision); capture.assertCurrent();
    if (mutation === 'external') { const value = JSON.parse(await readFile(f.file, 'utf8')); value.projects[0].label = 'Replaced'; await writeFile(f.file, JSON.stringify(value)); }
    if (mutation === 'internal') await f.store.saveTask({ label: 'New', projectId: f.projectId }, capture.revision);
    if (mutation === 'deleted') await rm(f.file);
    if (mutation === 'mode') await chmod(f.file, 0o644);
    if (mutation === 'symlink') { await rename(f.file, join(f.directory, 'elsewhere')); await symlink('elsewhere', f.file); }
    assert.throws(() => capture.assertCurrent(), undefined, mutation);
    if (mutation !== 'internal') assert.throws(() => f.store.capture(), undefined, mutation);
  }
});

test('absent registry capture is immutable and becomes stale when a file appears', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-context-empty-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ContextProfileStore(join(root, 'context')), capture = store.capture();
  assert.equal(capture.digest, undefined); capture.assertCurrent();
  assert.throws(() => capture.state.rules.push({}));
  await mkdir(join(root, 'context'), { mode: 0o700 });
  await writeFile(join(root, 'context', 'profiles.json'), JSON.stringify(capture.state), { mode: 0o600 });
  assert.throws(() => capture.assertCurrent(), /changed/);
});

test('disabled and shell context perform zero store or source work', async () => {
  const { ContextLaunchService } = await import('../src/main/services/ContextLaunchService.ts');
  const service = new ContextLaunchService({ capture() { throw new Error('store touched'); } });
  const source = () => { throw new Error('source touched'); };
  assert.equal(service.capture({ enabled: false, provider: 'codex' }, source), undefined);
  assert.equal(service.capture({ enabled: true, provider: 'terminal' }, source), undefined);
  assert.equal(service.project(undefined, { provider: 'terminal', maxDataClass: 'D0' }), undefined);
  for (const provider of ['browser', 'note', 'unknown', 'constructor']) assert.throws(() => service.capture({ enabled: true, provider }, source), /intent/);
});

test('one capture projects route-specific winners, owns task selection and rejects forged handles', async t => {
  const { ContextLaunchService } = await import('../src/main/services/ContextLaunchService.ts');
  const f = await fixture(t); let state = f.store.get();
  for (const input of [
    { scope: 'user', key: 'palette', value: 'public fallback', dataClass: 'D0' },
    { scope: 'project', ownerId: f.projectId, key: 'palette', value: 'private winner', dataClass: 'D2' },
    { scope: 'task', ownerId: f.taskId, key: 'task-only', value: 'owned task', dataClass: 'D0' }
  ]) state = await f.store.saveRule({ category: 'design', tags: [], enabled: true, ...input }, state.revision);
  let captures = 0, sourceChecks = 0;
  const service = new ContextLaunchService({ capture() { captures++; return f.store.capture(); } });
  const source = { sourceCwd: f.project, assertCurrent() { sourceChecks++; } };
  const intent = { enabled: true, provider: 'codex', taskId: f.taskId, current: [{ category: 'testing', key: 'current', value: 'unknown private' }] };
  const capture = service.capture(intent, source);
  intent.current[0].value = 'caller mutated';
  const low = service.project(capture, { provider: 'codex', accountId: 'low', maxDataClass: 'D1' });
  const high = service.project(capture, { provider: 'codex', accountId: 'high', maxDataClass: 'D2' });
  assert.equal(captures, 1); assert.equal(sourceChecks, 1);
  assert.doesNotMatch(low.text, /palette|fallback|private|current/); assert.match(low.text, /owned task/);
  assert.match(high.text, /private winner/); assert.match(high.text, /unknown private/); assert.doesNotMatch(high.text, /caller mutated/);
  assert.equal(high.includedDataClass, 'D2'); assert.notEqual(low.digest, high.digest);
  assert.deepEqual(high.ref, { projectId: f.projectId, taskId: f.taskId, revision: state.revision });
  assert.throws(() => service.project({}, { provider: 'codex', maxDataClass: 'D2' }), /capture/);
  assert.throws(() => service.project(capture, { provider: 'claude', maxDataClass: 'D2' }), /provider/);
  assert.throws(() => service.capture({ ...intent, projectId: f.projectId }, source), /intent/);
  assert.throws(() => service.capture({ ...intent, current: [{ ...intent.current[0], source: 'explicit' }] }, source), /current/);
  for (const current of [[{ ...intent.current[0], scope: 'user' }], [{ ...intent.current[0], dataClass: null }], [{ ...intent.current[0], tags: null }], [intent.current[0], intent.current[0]], Array.from({ length: 49 }, (_, i) => ({ category: 'design', key: `key-${i}`, value: 'bounded' }))]) assert.throws(() => service.capture({ ...intent, current }, source));
  assert.throws(() => service.capture({ ...intent, taskId: 'foreign' }, source), /task/);
  const beforeGuard = sourceChecks; high.assertCurrent(); assert.equal(sourceChecks, beforeGuard + 1);
  await f.store.remove('task', f.taskId, state.revision);
  assert.throws(() => high.assertCurrent(), /changed/);
});

test('source identity and canonical longest project are checked without unrelated project inheritance', async t => {
  const { ContextLaunchService } = await import('../src/main/services/ContextLaunchService.ts');
  const f = await fixture(t), child = join(f.project, 'child'); await mkdir(child);
  let state = await f.store.saveProject({ label: 'Nested', root: child }, f.store.get().revision);
  const nested = state.projects.find(p => p.root === child);
  const service = new ContextLaunchService(f.store), source = { sourceCwd: child, assertCurrent() {} };
  assert.throws(() => service.capture({ enabled: true, provider: 'codex', taskId: f.taskId }, source), /task/);
  const capture = service.capture({ enabled: true, provider: 'codex' }, source);
  const plan = service.project(capture, { provider: 'codex', maxDataClass: 'D2' });
  assert.equal(plan.ref.projectId, nested.id);
  await rename(child, join(f.project, 'old')); await mkdir(child);
  assert.throws(() => plan.assertCurrent(), /source|project|changed/);
});
