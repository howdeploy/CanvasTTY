import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspacePresetStore } from '../src/main/services/WorkspacePresetStore.ts';
import { TerminalManager } from '../src/main/services/TerminalManager.ts';
import { availableRegistry, fakeSpawner } from './helpers/terminal.mjs';

const recipe = { id: 'preset-shell', provider: 'terminal', profile: 'normal', role: 'agent',
  title: 'Shell', titleCustomized: true, cwd: process.cwd(), position: { x: 340, y: 220 },
  size: { width: 700, height: 430 }, lastState: 'running', restore: true };

test('concurrent saves preserve independent named presets and recipes across reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-presets-'));
  try {
    const store = new WorkspacePresetStore(dir);
    await Promise.all([store.save('Project A', [recipe]), store.save('Project B', [recipe])]);
    const reloaded = new WorkspacePresetStore(dir);
    const list = await reloaded.list();
    assert.deepEqual(list.map(p => p.name), ['Project A', 'Project B']);
    assert.deepEqual((await reloaded.get(list[0].id)).sessions, [recipe]);
    await reloaded.save('Project renamed', [], list[0].id);
    await reloaded.remove(list[1].id);
    assert.deepEqual((await reloaded.list()).map(p => [p.name, p.sessions]), [['Project renamed', 0]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('future and damaged preset files are preserved on attempted writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-presets-future-'));
  try {
    const store = new WorkspacePresetStore(dir);
    for (const raw of ['{"version":2,"presets":[]}', '{damaged']) {
      await writeFile(store.filePath, raw);
      await assert.rejects(store.save('Must not overwrite', [recipe]));
      assert.equal(await readFile(store.filePath, 'utf8'), raw);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid names and recipes fail without replacing a good preset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-presets-invalid-'));
  try {
    const store = new WorkspacePresetStore(dir);
    await store.save('Valid', [recipe]);
    await assert.rejects(store.save('bad\nname', [recipe]));
    await assert.rejects(store.save('Bad recipe', [{ ...recipe, provider: 'not-a-provider' }]));
    assert.equal((await store.list()).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loading a preset keeps live processes and reuses their card identities', async () => {
  const calls = [];
  const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  try {
    const first = manager.create({ provider: 'terminal', profile: 'normal', cwd: process.cwd(), position: recipe.position });
    manager.rename(first.id, 'Saved shell');
    const saved = manager.captureWorkspaceSessions();
    const before = calls.length;
    const twice = await Promise.all([manager.restoreWorkspaceSessions(saved, 'continue'), manager.restoreWorkspaceSessions(saved, 'continue')]);
    assert.equal(calls.length, before);
    assert.equal(manager.list().length, 1);
    assert.equal(twice[0][0].state, 'existing');
    manager.dispose(first.id);
    const restored = await manager.restoreWorkspaceSessions(saved, 'continue');
    assert.equal(restored[0].state, 'opened');
    assert.equal(manager.list()[0].id, first.id);
    assert.equal(manager.list()[0].title, 'Saved shell');
    assert.deepEqual(manager.list()[0].position, recipe.position);
    assert.equal(calls.length, before + 1);
  } finally { await manager.shutdown(); }
});

test('an unavailable saved folder reports a stopped card instead of launching elsewhere', async () => {
  const calls = [];
  const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  try {
    const result = await manager.restoreWorkspaceSessions([{ ...recipe, cwd: join(tmpdir(), 'missing-preset-dir-7d7b553') }], 'continue');
    assert.equal(result[0].state, 'stopped');
    assert.ok(result[0].detail);
    assert.equal(calls.length, 0);
  } finally { await manager.shutdown(); }
});

test('workspace recipes restore browser URLs and missing cards without moving existing cards', async () => {
  const { SettingsStore } = await import('../src/main/services/SettingsStore.ts');
  const { capturePresetLayout, mergePresetLayout, normalizePresetLayout } = await import('../src/main/services/workspacePresetLayout.ts');
  const current = new SettingsStore('.', 'en').get();
  current.stickyNotes = [{ id: 'existing-note', text: 'current', position: { x: 10, y: 20 }, size: { width: 300, height: 220 } }];
  const saved = capturePresetLayout({ ...current, stickyNotes: [
    { ...current.stickyNotes[0], text: 'old value', position: { x: 900, y: 900 } },
    { id: 'new-note', text: 'saved note', position: { x: 30, y: 50 }, size: { width: 300, height: 220 } }
  ] }, ['https://example.com/path', 'file:///private/secret', 'https://user:password@example.com', 'https://example.com/path']);
  assert.deepEqual(saved.browserUrls, ['https://example.com/path']);
  const merged = mergePresetLayout(current, saved);
  assert.equal(merged.added, 1);
  assert.equal(merged.patch.stickyNotes[0].text, 'current');
  assert.deepEqual(merged.patch.stickyNotes[0].position, { x: 10, y: 20 });
  assert.equal(merged.patch.stickyNotes[1].id, 'new-note');
  assert.throws(() => normalizePresetLayout({ ...saved, browserUrls: ['javascript:alert(1)'] }));
  assert.throws(() => normalizePresetLayout({ ...saved, stickyNotes: [{ id: 'bad', position: { x: Infinity, y: 0 } }] }));
  const full = { ...current, stickyNotes: Array.from({length:128},(_,i)=>({...current.stickyNotes[0],id:`full-${i}`})) };
  assert.throws(() => mergePresetLayout(full, saved), /card limit/);
  assert.equal(full.stickyNotes.length, 128);
  const dir = await mkdtemp(join(tmpdir(), 'canvas-preset-layout-'));
  try {
    const store = new WorkspacePresetStore(dir);
    await store.save('Full workspace', [recipe], undefined, saved);
    const list = await store.list();
    assert.equal(list[0].surfaces, 2);
    assert.equal(list[0].browserTabs, 1);
    assert.deepEqual((await new WorkspacePresetStore(dir).get(list[0].id)).layout, saved);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
