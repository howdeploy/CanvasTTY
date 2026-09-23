import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readdir, rm, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const rule = (id, scope, value, extra = {}) => ({ id, scope, category: 'design', key: 'button.text', value, tags: [], dataClass: 'D0', source: 'explicit', confidence: 1, enabled: true, updatedAt: 1, ...extra });
test('context resolves winners before privacy filtering, with deterministic scope and source precedence', async () => {
  const { resolveContext } = await import('../src/shared/contextProfiles.ts');
  const rules = [rule('user', 'user', 'beige'), rule('project', 'project', 'private', { ownerId: 'p', dataClass: 'D2' }), rule('other', 'project', 'unrelated', { ownerId: 'other' })];
  const low = resolveContext(rules, { projectId: 'p', maxDataClass: 'D1', categories: ['design'] });
  assert.equal(low.text, ''); assert.equal(JSON.stringify(low).includes('private'), false); assert.equal(JSON.stringify(low).includes('button.text'), false);
  assert.match(resolveContext([...rules, rule('now', 'current', 'black')], { projectId: 'p', maxDataClass: 'D3', categories: ['design'] }).text, /black/);
  assert.match(resolveContext([...rules, rule('inferred', 'project', 'guess', { ownerId: 'p', source: 'inferred', confidence: 0.99, updatedAt: 10 })], { projectId: 'p', maxDataClass: 'D3', categories: ['design'] }).text, /private/);
});
test('context includes security regardless of task category and counts UTF-8 without splitting rules', async () => {
  const { resolveContext } = await import('../src/shared/contextProfiles.ts');
  const rules = [rule('design', 'user', 'я'.repeat(700), { key: 'palette' }), rule('security', 'user', 'Never publish secrets', { category: 'security', key: 'secrets' })];
  const result = resolveContext(rules, { maxDataClass: 'D2', categories: ['testing'], byteBudget: 1024 });
  assert.match(result.text, /Never publish/); assert.doesNotMatch(result.text, /palette/);
  const truncated = resolveContext(rules, { maxDataClass: 'D2', categories: ['design'], byteBudget: 1024 });
  assert.equal(truncated.omitted, 1); assert.ok(Buffer.byteLength(truncated.text) <= 1024);
});
test('private context store is lazy, revisioned, bounded, persists canonical projects and refuses stale writes', async t => {
  const { ContextProfileStore } = await import('../src/main/services/ContextProfileStore.ts');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-context-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'context'), store = new ContextProfileStore(directory);
  assert.deepEqual(await readdir(root), []);
  const empty = store.get(); assert.deepEqual(await readdir(root), []);
  const project = await store.saveProject({ label: 'Project', root }, empty.revision);
  assert.equal(project.projects[0].root, root);
  const saved = await store.saveRule({ scope: 'project', ownerId: project.projects[0].id, category: 'design', key: 'palette', value: '#fff', tags: [], enabled: true }, project.revision);
  assert.equal(saved.rules[0].dataClass, 'D2'); assert.equal(saved.rules[0].source, 'explicit');
  await assert.rejects(store.saveRule({ ...saved.rules[0], value: 'stale' }, project.revision), /changed|revision/i);
  assert.deepEqual(new ContextProfileStore(directory).get(), saved);
  assert.equal(JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8')).rules.length, 1);
  await assert.rejects(store.saveRule({ ...saved.rules[0], source: 'inferred' }, saved.revision), /source|explicit/i);
  await assert.rejects(store.saveRule({ ...saved.rules[0], value: 'я'.repeat(5000) }, saved.revision), /bound|limit|large/i);
  await symlink(root, join(root, 'alias'));
  await assert.rejects(store.saveProject({ label: 'Alias', root: join(root, 'alias') }, saved.revision), /canonical|link/i);
});

test('task and organization rules are project-scoped and required-rule overflow is explicit', async () => {
  const { resolveContext } = await import('../src/shared/contextProfiles.ts');
  const rules = [rule('a', 'user', 'user'), rule('b', 'organization', 'org', { ownerId: 'org' }), rule('c', 'project', 'project', { ownerId: 'p' }), rule('d', 'task', 'task', { ownerId: 't' })];
  for (const [selection, expected] of [[{}, 'user'], [{ organizationId: 'org' }, 'org'], [{ projectId: 'p', organizationId: 'org' }, 'project'], [{ projectId: 'p', taskId: 't' }, 'task']]) {
    const result = resolveContext(rules, { ...selection, maxDataClass: 'D3' }); assert.equal(result.included[0].value, expected);
  }
  assert.throws(() => resolveContext([rule('s', 'user', 'x'.repeat(900), { category: 'security' })], { maxDataClass: 'D3', byteBudget: 512 }), /Required|budget/);
});

test('serialized context mutations reject duplicate revisions and remove only owned task/project rules', async t => {
  const { ContextProfileStore } = await import('../src/main/services/ContextProfileStore.ts');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ct-context-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ContextProfileStore(join(root, 'context'));
  const outcomes = await Promise.allSettled([store.saveProject({ label: 'One', root }, 0), store.saveProject({ label: 'Two', root }, 0)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  let state = store.get(), p = state.projects[0]; state = await store.saveTask({ projectId: p.id, label: 'Task' }, state.revision);
  const ownerId = state.tasks[0].id;
  const input = { scope: 'task', ownerId, category: 'testing', key: 'test', value: 'Use unit tests', tags: [], enabled: true };
  state = await store.saveRule(input, state.revision);
  await assert.rejects(store.saveRule({ ...input, ownerId: 'foreign' }, state.revision), /scope/);
  const clone = store.get(); clone.rules[0].value = 'changed'; assert.notEqual(store.get().rules[0].value, 'changed');
  state = await store.remove('project', p.id, state.revision); assert.equal(state.rules.length, 0); assert.equal(state.tasks.length, 0);
});
