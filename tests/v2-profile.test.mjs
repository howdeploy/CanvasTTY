import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareV2Profile, FILES_PLUGIN_ID } from '../scripts/prepare-v2-profile.mjs';

test('alpha preparation installs offline Files without granting filesystem access and preserves user state on rerun', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'ct-v2-profile-'));
  try {
    assert.equal((await prepareV2Profile(profile)).created, true);
    const settingsPath = join(profile, 'settings.json');
    const initial = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(initial.pluginCanvas, []);
    assert.equal(initial.homeTime.clocks.length, 1);
    assert.equal(initial.homeTime.timers.length, 2);
    assert.ok(initial.homeAvatarWallpaper);
    await assert.rejects(access(join(profile, 'plugin-file-roots.json')), { code: 'ENOENT' });
    const manifest = JSON.parse(await readFile(join(profile, 'plugins', FILES_PLUGIN_ID, 'canvastty.plugin.json'), 'utf8'));
    assert.deepEqual(manifest.permissions, ['storage', 'files:read']);
    // Simulate real use: custom title, a running timer, plugin disabled and persisted folder access.
    initial.homeTime.timers[0] = { ...initial.homeTime.timers[0], label: 'Мой таймер', status: 'running', endsAt: Date.now() + 90000 };
    initial.pluginCanvas.push({ id: 'mine', pluginId: FILES_PLUGIN_ID, contributionId: 'explorer', title: 'Мои файлы' });
    const saved = JSON.stringify(initial);
    await writeFile(settingsPath, saved);
    const registryPath = join(profile, 'plugins.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    assert.equal(registry['com.canvastty.app-windows'], undefined);
    registry[FILES_PLUGIN_ID].enabled = false;
    const savedRegistry = JSON.stringify(registry);
    await writeFile(registryPath, savedRegistry);
    const grants = '[{"id":"existing-grant","path":"/unchanged"}]';
    await writeFile(join(profile, 'plugin-file-roots.json'), grants);
    assert.equal((await prepareV2Profile(profile)).created, false);
    assert.equal(await readFile(settingsPath, 'utf8'), saved);
    assert.equal(await readFile(registryPath, 'utf8'), savedRegistry);
    assert.equal(await readFile(join(profile, 'plugin-file-roots.json'), 'utf8'), grants);
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test('alpha preparation refuses a corrupt registry without replacing profile data', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'ct-v2-corrupt-'));
  try {
    const path = join(profile, 'plugins.json');
    await writeFile(path, 'corrupt');
    await assert.rejects(prepareV2Profile(profile));
    assert.equal(await readFile(path, 'utf8'), 'corrupt');
    await assert.rejects(access(join(profile, 'settings.json')), { code: 'ENOENT' });
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test('new Home uses distinct animated assets, a larger avatar and a Files slot in the dock', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'ct-v2-art-'));
  try {
    await prepareV2Profile(profile);
    const settings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
    assert.notEqual(settings.homeAvatarWallpaper, settings.homeClockWallpaper);
    const summary = async id => JSON.parse(await readFile(join(profile, 'wallpapers', id.slice(10), 'wallpaper.json'), 'utf8'));
    const avatar = await summary(settings.homeAvatarWallpaper), clock = await summary(settings.homeClockWallpaper);
    assert.equal(avatar.media.animated, true); assert.equal(clock.media.animated, true);
    assert.deepEqual([avatar.media.width, avatar.media.height], [256, 256]);
    assert.deepEqual([clock.media.width, clock.media.height], [512, 256]);
    assert.equal(settings.homeLayout.find(item => item.widgetId === 'core.media').columnSpan, 4);
    assert.equal(settings.homeLauncherProviders.includes('hermes'), false);
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test('Home upgrade preserves custom layouts, custom art, running timers and folder grants', async () => {
  const { upgradeV2Home } = await import('../scripts/upgrade-v2-home.mjs');
  const profile = await mkdtemp(join(tmpdir(), 'ct-v2-upgrade-'));
  try {
    await prepareV2Profile(profile);
    const path = join(profile, 'settings.json'), settings = JSON.parse(await readFile(path, 'utf8'));
    settings.homeTime.timers[0] = { ...settings.homeTime.timers[0], status: 'running', endsAt: Date.now() + 999999 };
    settings.homeLayout[3].columnSpan = 3;
    await writeFile(path, JSON.stringify(settings));
    const grants = '[{"id":"mine","path":"/keep"}]';
    await writeFile(join(profile, 'plugin-file-roots.json'), grants);
    assert.equal((await upgradeV2Home(profile)).updated, false);
    const after = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(after.homeTime, settings.homeTime);
    assert.deepEqual(after.homeLayout, settings.homeLayout);
    assert.equal(after.homeAvatarWallpaper, settings.homeAvatarWallpaper);
    assert.equal(await readFile(join(profile, 'plugin-file-roots.json'), 'utf8'), grants);
  } finally { await rm(profile, { recursive: true, force: true }); }
});
