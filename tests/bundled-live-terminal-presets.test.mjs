import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PixelSkinPackRegistry, PIXEL_SKIN_SLOTS } from '../src/main/services/PixelSkinPackRegistry.ts';
import { inspectSkinMedia } from '../src/shared/skinMedia.ts';
import { SettingsStore } from '../src/main/services/SettingsStore.ts';
import { testPng } from './helpers/png.mjs';

const resources = fileURLToPath(new URL('../assets/live-terminal-presets/', import.meta.url));
const catalog = JSON.parse(await readFile(join(resources, 'catalog.json'), 'utf8'));
const webpFrameArchives = new Set(['steampunk-airship.zip', 'brutalist-monolith.zip', 'cyberpunk-noodle-bar.zip']);

test('all approved live themes install and survive restart without duplicates', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'ct-bundled-live-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const registry = new PixelSkinPackRegistry(profile, resources);
  await registry.initialize();
  assert.deepEqual(registry.list().map(p => p.name), ['Living Forge', 'Kisa’s Theme', 'Teo’s Theme', 'Steampunk Airship', 'Brutalist Monolith', 'Cyberpunk Noodle Bar']);
  assert.deepEqual(registry.list().map(p => p.id), catalog.presets.map(p => p.id));
  for (const pack of registry.list()) {
    const preset = catalog.presets.find(p => p.id === pack.id);
    assert.deepEqual(pack.apertures, preset.apertures);
    assert.ok(pack.controls?.detailed);
    for (const slot of PIXEL_SKIN_SLOTS) {
      const bytes = await registry.readAsset(pack.id, slot);
      const info = inspectSkinMedia(bytes);
      assert.equal(info.animated, true, `${pack.name}/${slot}`);
      const usesWebp = slot === 'background' ? preset.archive !== 'volcanic-forge.zip' : webpFrameArchives.has(preset.archive);
      const format = usesWebp ? 'webp' : 'gif';
      assert.equal(info.format, format, `${pack.name}/${slot}`);
      if (slot !== 'background') assert.deepEqual([info.width, info.height], [1536, 1024]);
    }
    assert.notDeepEqual(await registry.readAsset(pack.id, 'master_idle'), await registry.readAsset(pack.id, 'master_working'));
    assert.notDeepEqual(await registry.readAsset(pack.id, 'master_working'), await registry.readAsset(pack.id, 'master_completed'));
  }
  const settings = new SettingsStore(profile, 'en');
  await settings.update({ terminalBorderSkin: catalog.presets[0].id });
  const custom = await registry.install({ name: 'Keep my theme', files: Object.fromEntries(PIXEL_SKIN_SLOTS.map(slot => [slot, testPng()])) });
  const reopened = new PixelSkinPackRegistry(profile, resources);
  await reopened.initialize();
  assert.deepEqual(reopened.list().map(p => p.id).sort(), [...catalog.presets.map(p => p.id), custom.id].sort());
  assert.equal((await new SettingsStore(profile, 'en').load()).terminalBorderSkin, catalog.presets[0].id);
  assert.equal((await readdir(join(profile, 'pixel-skins'))).length, catalog.presets.length + 1);
});

test('retired experiments are archived once and personal imports are preserved', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'ct-retired-live-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const old = new PixelSkinPackRegistry(profile);
  await old.initialize();
  const bytes = await readFile(join(resources, catalog.presets[0].archive));
  for (const id of catalog.retiredIds) await old.installZip(bytes, 'Old experiment', undefined, id);
  const own = await old.install({ name: 'Personal Forge', files: Object.fromEntries(PIXEL_SKIN_SLOTS.map(slot => [slot, testPng()])) });
  for (let restart = 0; restart < 2; restart++) {
    const registry = new PixelSkinPackRegistry(profile, resources);
    await registry.initialize();
    assert.deepEqual(registry.list().map(p => p.id).sort(), [...catalog.presets.map(p => p.id), own.id].sort());
    const archived = await readdir(join(profile, 'pixel-skins', '.retired'));
    assert.equal(archived.length, catalog.retiredIds.length);
    for (const folder of archived) {
      const saved = JSON.parse(await readFile(join(profile, 'pixel-skins', '.retired', folder, 'manifest.json'), 'utf8'));
      assert.ok(catalog.retiredIds.includes(saved.id));
    }
  }
});

test('updated bundled artwork replaces the old stable ID once and keeps its selection', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'ct-forge-upgrade-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const old = new PixelSkinPackRegistry(profile);
  await old.initialize();
  const preset = catalog.presets[0];
  await old.installZip(await readFile(join(resources, preset.archive)), 'Previous Forge', preset.apertures, preset.id);
  const settings = new SettingsStore(profile, 'en');
  await settings.update({ terminalBorderSkin: preset.id });
  const custom = await old.install({ name: 'Personal', files: Object.fromEntries(PIXEL_SKIN_SLOTS.map(slot => [slot, testPng()])) });
  // A legacy profile has no trusted bundle digest. First startup upgrades it;
  // subsequent startups must neither duplicate it nor keep archiving it.
  for (let restart = 0; restart < 2; restart++) {
    const next = new PixelSkinPackRegistry(profile, resources);
    await next.initialize();
    assert.equal(next.list().find(p => p.id === preset.id).name, 'Living Forge');
    assert.equal(next.list().length, catalog.presets.length + 1);
    assert.ok(next.list().some(p => p.id === custom.id));
    assert.equal((await new SettingsStore(profile, 'en').load()).terminalBorderSkin, preset.id);
    assert.equal((await readdir(join(profile, 'pixel-skins', '.retired'))).length, 1);
  }
  // Corrupt shipped replacement must leave the currently installed theme usable.
  const broken = join(profile, 'broken-resources'); await mkdir(broken);
  await writeFile(join(broken, 'catalog.json'), JSON.stringify(catalog));
  await writeFile(join(broken, preset.archive), Buffer.alloc(30));
  await Promise.all(catalog.presets.slice(1).map(({ archive }) => copyFile(join(resources, archive), join(broken, archive))));
  const fallback = new PixelSkinPackRegistry(profile, broken);
  await fallback.initialize();
  assert.equal(fallback.list().length, catalog.presets.length + 1);
  assert.deepEqual(await fallback.readAsset(preset.id, 'master_idle'), await old.readAsset(preset.id, 'master_idle'));
  assert.equal((await readdir(join(profile, 'pixel-skins', '.retired'))).length, 1);
});

test('a broken bundled catalog fails open without hiding existing user themes', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'ct-bundled-bad-'));
  const resources = await mkdtemp(join(tmpdir(), 'ct-bundled-resources-'));
  t.after(() => Promise.all([profile, resources].map(path => rm(path, { recursive: true, force: true }))));
  const registry = new PixelSkinPackRegistry(profile);
  await registry.initialize();
  const own = await registry.install({ name: 'Personal', files: Object.fromEntries(PIXEL_SKIN_SLOTS.map(slot => [slot, testPng()])) });
  await writeFile(join(resources, 'catalog.json'), JSON.stringify({ schemaVersion: 1, presets: [{ ...catalog.presets[0], archive: '../outside.zip' }] }));
  const reopened = new PixelSkinPackRegistry(profile, resources);
  await reopened.initialize();
  assert.deepEqual(reopened.list().map(p => p.id), [own.id]);
});
