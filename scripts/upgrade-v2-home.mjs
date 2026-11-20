// Explicit, conservative update of the known first-alpha demo. Never resets custom art or timers.
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SettingsStore } from '../src/main/services/SettingsStore.ts';
import { WallpaperRegistry } from '../src/main/services/WallpaperRegistry.ts';
import { DEFAULT_HOME_LAYOUT } from '../src/shared/contracts.ts';
const repo = resolve(import.meta.dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function upgradeV2Home(profile) {
  const store = new SettingsStore(profile, 'ru'); await store.load();
  const settings = store.get(), patch = {};
  const library = new WallpaperRegistry(profile); await library.initialize();
  const oldDigest = digest(await readFile(join(repo, 'tests/fixtures/live-skins/clock.gif')));
  for (const [key, kind] of [['homeAvatarWallpaper', 'avatar'], ['homeClockWallpaper', 'clock']]) {
    const selected = settings[key] ? await library.read(settings[key]) : null;
    if (selected?.summary.name !== 'Pixel night' || digest(selected.bytes) !== oldDigest) continue;
    const asset = await library.install({ name: kind === 'avatar' ? 'Pixel companion' : 'Night shift', bytes: await readFile(join(repo, `resources/home/${kind}.gif`)),
      width: kind === 'avatar' ? 96 : 240, height: kind === 'avatar' ? 96 : 135,
      recipe: { fit: kind === 'avatar' ? 'contain' : 'cover', x: 50, y: 50, width: kind === 'avatar' ? 512 : 1440, height: kind === 'avatar' ? 512 : 810, pixelated: true, clockFont: 'pixel', dim: kind === 'avatar' ? 0 : .2 } });
    patch[key] = asset.id;
  }
  const oldLayout = [
    { widgetId: 'core.limits', column: 0, row: 0, columnSpan: 7, rowSpan: 3 },
    { widgetId: 'core.sessions', column: 7, row: 0, columnSpan: 5, rowSpan: 3 },
    { widgetId: 'core.clock', column: 0, row: 3, columnSpan: 9, rowSpan: 5 },
    { widgetId: 'core.media', column: 9, row: 3, columnSpan: 3, rowSpan: 3 },
    { widgetId: 'core.launcher', column: 0, row: 8, columnSpan: 10, rowSpan: 2 },
    { widgetId: 'core.settings', column: 10, row: 8, columnSpan: 2, rowSpan: 2 }
  ];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(settings.homeLayout, oldLayout)) {
    patch.homeLayout = structuredClone(DEFAULT_HOME_LAYOUT);
    if (same(settings.homeGridSize, { columns: 16, rows: 12 })) patch.homeGridSize = { columns: 12, rows: 10 };
  }
  if (same(settings.homeLauncherProviders, ['codex', 'claude', 'opencode', 'hermes', 'pi'])) patch.homeLauncherProviders = ['codex', 'claude', 'opencode', 'pi'];
  if (!Object.keys(patch).length) return { updated: false };
  const backupDir = join(profile, 'backups'); await mkdir(backupDir, { recursive: true });
  const backup = join(backupDir, `home-before-alpha2-${Date.now()}.json`);
  await copyFile(join(profile, 'settings.json'), backup);
  await store.update(patch);
  return { updated: true, fields: Object.keys(patch), backup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(await upgradeV2Home(resolve(process.argv[2] || join(repo, '../profile'))));
