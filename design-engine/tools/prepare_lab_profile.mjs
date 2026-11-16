#!/usr/bin/env node
// Prepare a NEW isolated profile through CanvasTTY's actual importers. Never edit a live profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repoArg, manifestArg, profileArg] = process.argv.slice(2);
if (!repoArg || !manifestArg || !profileArg) throw new Error('Usage: node prepare_lab_profile.mjs CANVASTTY_SOURCE preset.json NEW_PROFILE');
const repo = resolve(repoArg), manifestPath = resolve(manifestArg), base = dirname(manifestPath), profile = resolve(profileArg);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.kind, 'canvastty-appearance-preset');
assert.equal(manifest.schemaVersion, 1);
const allowed = new Set(['palette','appSkin','canvasColor','pattern','canvasBackgroundFit','canvasBackgroundPaused','terminalBackground','terminalSkinDetail','homeClockFont','homeAccentPreset','homeAccentColors','homeTime','homeLayout','homeGridSize']);
for (const key of Object.keys(manifest.settings)) assert.ok(allowed.has(key), `Not an appearance setting: ${key}`);
async function asset(entry) {
  assert.ok(entry && typeof entry.file === 'string' && !isAbsolute(entry.file));
  const path = resolve(base, entry.file);
  assert.ok(path.startsWith(base + sep), 'Asset must be inside the preset folder');
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 150 * 1024 * 1024);
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Asset checksum: ${entry.file}`);
  return bytes;
}
// Validate all input files before creating anything; mkdir refuses an existing profile.
const terminalBytes = await asset(manifest.terminals);
const wallpaperBytes = {};
for (const target of ['canvas','avatar','clock']) wallpaperBytes[target] = await asset(manifest.wallpapers[target]);
const requireFromRepo = createRequire(join(repo, 'package.json'));
const { build } = requireFromRepo('esbuild');
await mkdir(profile, { recursive: false, mode: 0o700 });
const bundle = join(profile, '.preset-services.cjs');
await build({ stdin: { contents: ['PixelSkinPackRegistry','WallpaperRegistry','SettingsStore'].map(name => `export { ${name} } from ${JSON.stringify(join(repo,'src/main/services',name+'.ts'))};`).join('\n'), resolveDir: repo }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, packages: 'external', logLevel: 'error', define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(repo,'package.json')).href) } });
const { PixelSkinPackRegistry, WallpaperRegistry, SettingsStore } = createRequire(import.meta.url)(bundle);
const skins = new PixelSkinPackRegistry(profile), wallpapers = new WallpaperRegistry(profile), settings = new SettingsStore(profile,'ru');
await skins.initialize(); await wallpapers.initialize(); await settings.load();
try {
  const skin = await skins.installZip(terminalBytes,manifest.name,manifest.apertures,manifest.terminals.id);
  const ids = {};
  for (const target of ['canvas','avatar','clock']) ids[target] = (await wallpapers.importPackage(wallpaperBytes[target])).id;
  const patch = { ...manifest.settings, terminalBorderSkin: skin.id, canvasBackground: ids.canvas, homeAvatarWallpaper: ids.avatar, homeClockWallpaper: ids.clock };
  const applied = await settings.update(patch);
  const restored = new SettingsStore(profile, 'ru'); await restored.load();
  for (const key of Object.keys(patch)) assert.deepEqual(restored.get()[key], applied[key], `Setting did not persist: ${key}`);
  const restoredSkins = new PixelSkinPackRegistry(profile), restoredWallpapers = new WallpaperRegistry(profile);
  await restoredSkins.initialize(); await restoredWallpapers.initialize();
  assert.equal(restoredSkins.list().length, 1); assert.equal(restoredWallpapers.list().length, 3);
  const receipt = { result: 'prepared', name: manifest.name, profile, terminalSkin: skin.id, wallpapers: ids, importers: 'production', settingsRestored: true, scope: 'isolated new profile; app playback is a separate check' };
  await writeFile(join(profile,'preset-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(receipt,null,2));
} finally {
  await unlink(bundle).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
