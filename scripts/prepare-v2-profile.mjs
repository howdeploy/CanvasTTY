import { SettingsStore } from '../src/main/services/SettingsStore.ts';
import { WallpaperRegistry } from '../src/main/services/WallpaperRegistry.ts';
import { defaultHomeTime } from '../src/shared/homeTime.ts';
import { readFile, writeFile, access, mkdir, cp, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const FILES_PLUGIN_ID = 'com.canvastty.file-explorer';
const repo = resolve(import.meta.dirname, '..');
const exists = async path => { try { await access(path); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; } };

/** Only the isolated alpha profile. Existing settings, trust, storage and folder grants survive. */
export async function prepareV2Profile(profile, { demo = true } = {}) {
  profile = resolve(profile);
  await mkdir(profile, { recursive: true });
  const registryPath = join(profile, 'plugins.json');
  const registry = await exists(registryPath) ? JSON.parse(await readFile(registryPath, 'utf8')) : {};
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Invalid plugin registry; refusing to replace it.');
  for (const [pluginId, folder] of [[FILES_PLUGIN_ID, 'file-explorer']]) {
    const destination = join(profile, 'plugins', pluginId);
    const manifestPath = join(destination, 'canvastty.plugin.json');
    // The first alpha carries the developer plugin as an offline package. Never overwrite a user's copy.
    if (!registry[pluginId] && !await exists(destination)) {
      await mkdir(join(profile, 'plugins'), { recursive: true });
      await cp(join(repo, 'examples/plugins', folder), destination, { recursive: true, errorOnExist: true, force: false });
      registry[pluginId] = { sourceUrl: 'https://github.com/howdeploy/CanvasTTY.git', enabled: true, installedAt: Date.now(), selectedModules: [], enabledHooks: [] };
      const temporary = registryPath + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(registry, null, 2), { mode: 0o600, flag: 'wx' });
        await rename(temporary, registryPath);
      } finally { await rm(temporary, { force: true }); }
    } else if (registry[pluginId] && !await exists(manifestPath)) {
      throw new Error('Bundled plugin registry exists but its package is missing. Restore the alpha profile before continuing.');
    } else if (!registry[pluginId]) {
      throw new Error('An unregistered bundled plugin directory already exists; refusing to overwrite it.');
    }
  }
  const settingsPath = join(profile, 'settings.json');
  if (await exists(settingsPath)) return { profile, created: false };
  const settings = new SettingsStore(profile, 'ru');
  await settings.load();
  const patch = {
    locale: 'ru', sessionRestoreMode: 'off',
    pluginCanvas: []
  };
  if (demo) {
    const library = new WallpaperRegistry(profile); await library.initialize();
    const avatar = await library.install({ name: 'AI pixel companion', bytes: await readFile(join(repo, 'resources/home/avatar-ai-v1.gif')), width: 256, height: 256, recipe: { fit: 'contain', x: 50, y: 50, width: 512, height: 512, pixelated: true, clockFont: 'pixel', dim: 0 } });
    const wallpaper = await library.install({ name: 'AI night rooftops', bytes: await readFile(join(repo, 'resources/home/background-ai-v1.gif')), width: 512, height: 256,
      recipe: { fit: 'cover', x: 50, y: 50, width: 1440, height: 810, pixelated: true, clockFont: 'pixel', dim: .2 } });
    const timer = (id, label, minutes) => ({ id, label, durationMs: minutes * 60000, remainingMs: minutes * 60000, endsAt: null, status: 'idle' });
    Object.assign(patch, {
      homeAvatarWallpaper: avatar.id, homeClockDesign: 'new', homeClockWallpaper: wallpaper.id, homeClockFont: 'pixel',
      canvasBackground: wallpaper.id, canvasBackgroundFit: 'cover', canvasBackgroundPaused: false,
      homeTime: { ...defaultHomeTime(), timers: [timer('focus', 'Фокус', 25), timer('break', 'Перерыв', 5)] },
      homeGridSize: { columns: 12, rows: 10 },
      homeLauncherProviders: ['codex', 'claude', 'opencode', 'pi'],
      homeLayout: settings.get().homeLayout
    });
  }
  await settings.update(patch);
  return { profile, created: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await prepareV2Profile(process.argv[2] || join(repo, '../profile'))));
}
