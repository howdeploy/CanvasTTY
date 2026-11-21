import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { inspectSkinMedia } from '../src/shared/skinMedia.ts';
import { AuthorThemeService } from '../src/main/services/AuthorThemeService.ts';
import { SettingsStore } from '../src/main/services/SettingsStore.ts';
import { PixelSkinPackRegistry } from '../src/main/services/PixelSkinPackRegistry.ts';
import { WallpaperRegistry } from '../src/main/services/WallpaperRegistry.ts';

const assets = fileURLToPath(new URL('../assets', import.meta.url));
async function fixture(t, root = assets) {
  const dir = await mkdtemp(join(tmpdir(), 'ct-author-theme-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new SettingsStore(dir, 'ru'); await settings.load();
  const skins = new PixelSkinPackRegistry(dir, join(assets, 'live-terminal-presets')); await skins.initialize();
  const wallpapers = new WallpaperRegistry(dir); await wallpapers.initialize();
  const service = new AuthorThemeService(root, settings, skins, wallpapers);
  return { dir, settings, skins, wallpapers, service };
}

test('all bundled profiles apply atomically and survive restart without duplicate wallpapers', async t => {
  const f = await fixture(t);
  const initial = f.settings.get();
  const timer = { id: 'personal', label: 'Keep running', durationMs: 60000, remainingMs: 54000, endsAt: Date.now() + 54000, status: 'running' };
  await f.settings.update({ homeTime: { ...initial.homeTime, clocks: [{ id: 'local', label: 'My clock', timeZone: 'local' }], timers: [timer], hour12: false, showSeconds: true } });
  const before = f.settings.get();
  const listing = await f.service.list(); assert.equal(listing.length, 6);
  for (const item of listing) {
    for (const slot of ['canvas', 'avatar', 'clock']) {
      assert.equal(inspectSkinMedia(await f.service.preview(item.id, slot)).animated, true);
    }
    assert.deepEqual(Buffer.from(await f.skins.readAsset(item.skin, 'background')), Buffer.from(await f.service.preview(item.id, 'canvas')),
      item.id + ' must use the full canvas artwork in both appearance pickers');
    const next = await f.service.apply(item.id);
    assert.match(next.canvasBackground, /^wallpaper:/);
    assert.match(next.homeAvatarWallpaper, /^wallpaper:/);
    assert.match(next.homeClockWallpaper, /^wallpaper:/);
    assert.equal(new Set([next.canvasBackground, next.homeAvatarWallpaper, next.homeClockWallpaper]).size, 3);
    assert.deepEqual(next.homeTime, before.homeTime, 'personal timers and clocks must remain unchanged');
    assert.deepEqual(next.shortcuts, before.shortcuts);
    assert.deepEqual(next.canvasRegions, before.canvasRegions);
    assert.deepEqual(next.stickyNotes, before.stickyNotes);
    assert.equal(next.homeAccentPreset, 'custom'); assert.equal(next.terminalSkinAnimationEnabled, true);
    assert.equal(next.homeClockDesign, 'new');
    assert.equal(next.terminalBorderSkin, item.skin);
    if (item.id === 'teo-kurohane') {
      const { summary } = await f.wallpapers.read(next.canvasBackground);
      assert.equal(summary.media.format, 'webp');
      assert.equal(summary.media.animated, true);
      assert.deepEqual([summary.media.width, summary.media.height], [1935, 812]);
      assert.equal(summary.recipe.fit, 'cover');
      assert.equal(summary.recipe.pixelated, true);
      assert.equal(next.canvasBackgroundFit, 'cover');
      assert.equal(next.terminalBorderSkin, 'pixel:92020000-0000-4000-8000-000000000006');
    }
    const same = await f.service.apply(item.id);
    assert.equal(same.canvasBackground, next.canvasBackground);
    assert.equal(same.homeAvatarWallpaper, next.homeAvatarWallpaper);
  }
  assert.equal(f.wallpapers.list().length, listing.length * 3);
  const restarted = new WallpaperRegistry(f.dir); await restarted.initialize();
  const service = new AuthorThemeService(assets, f.settings, f.skins, restarted);
  await service.apply('kisa-nocturne'); assert.equal(restarted.list().length, listing.length * 3);
  const persisted = new SettingsStore(f.dir, 'ru'); await persisted.load();
  assert.equal(persisted.get().appearanceFont, 'mono');
  const background = await restarted.read(persisted.get().canvasBackground);
  assert.equal(background.summary.recipe.fit, 'cover');
  assert.equal(background.summary.recipe.pixelated, false);
  assert.deepEqual([background.summary.media.width, background.summary.media.height], [1920, 784]);
});

test('invalid IDs and corrupted assets leave appearance and wallpaper library untouched', async t => {
  const f = await fixture(t);
  const root = join(f.dir, 'assets'); await cp(join(assets, 'kisa-nocturne-profile'), join(root, 'kisa-nocturne-profile'), { recursive: true });
  const service = new AuthorThemeService(root, f.settings, f.skins, f.wallpapers);
  const before = f.settings.get();
  await assert.rejects(service.apply('../kisa-nocturne'), /Unknown/);
  await assert.rejects(service.preview('kisa-nocturne', '../clock'), /Invalid theme preview/);
  await assert.rejects(service.apply('kisa-nocturne', () => false), /Only the host/);
  let checks = 0;
  await assert.rejects(service.apply('kisa-nocturne', () => checks++ === 0), /Only the host/);
  assert.deepEqual(f.settings.get(), before);
  assert.equal(f.wallpapers.list().length, 0);

  const manifest = JSON.parse(await readFile(join(root, 'kisa-nocturne-profile/preset.json'), 'utf8'));
  await writeFile(join(root, 'kisa-nocturne-profile', manifest.wallpapers.clock.file), '{}');
  await assert.rejects(service.preview('kisa-nocturne', 'clock'), /checksum/);
  await assert.rejects(service.apply('kisa-nocturne'), /checksum/);
  assert.deepEqual(f.settings.get(), before); assert.equal(f.wallpapers.list().length, 0);
});

test('failed settings persistence rolls back newly imported wallpapers and permits retry', async t => {
  const f = await fixture(t); const before = f.settings.get();
  let fail = true;
  const service = new AuthorThemeService(assets, { update: patch => fail ? Promise.reject(new Error('disk full')) : f.settings.update(patch) }, f.skins, f.wallpapers);
  await assert.rejects(service.apply('kisa-nocturne'), /disk full/);
  assert.deepEqual(f.settings.get(), before); assert.equal(f.wallpapers.list().length, 0);
  fail = false; await service.apply('kisa-nocturne'); assert.equal(f.wallpapers.list().length, 3);
});

test('concurrent requests serialize complete profiles', async t => {
  const f = await fixture(t);
  await Promise.all([f.service.apply('kisa-nocturne'), f.service.apply('steampunk-airship')]);
  assert.equal(f.settings.get().terminalBorderSkin, 'pixel:92020000-0000-4000-8000-000000000007');
  assert.equal(f.settings.get().appearanceFont, 'serif');
  assert.equal(f.wallpapers.list().length, 6);
});
