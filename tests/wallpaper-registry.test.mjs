import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WallpaperRegistry } from "../src/main/services/WallpaperRegistry.ts";
import { DEFAULT_WALLPAPER_RECIPE, isWallpaperId } from "../src/shared/wallpaper.ts";
import { inspectSkinMedia } from "../src/shared/skinMedia.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
const fixture = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ct-wallpaper-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new WallpaperRegistry(root); await library.initialize();
  return { root, library };
};
const gif = await readFile(new URL("./fixtures/live-skins/clock.gif", import.meta.url));
const recipe = { ...DEFAULT_WALLPAPER_RECIPE, width: 1440, height: 480, x: 35, y: 70, clockFont: "pixel", pixelated: true };
const request = { name: "Clock GIF", bytes: gif, width: 960, height: 320, recipe };

test("GIF parser detects animation and rejects truncated frames/foreign content", () => {
  assert.deepEqual(inspectSkinMedia(gif), { format: "gif", animated: true, width: 960, height: 320 });
  for (const bytes of [gif.subarray(0, -1), gif.subarray(0, 50), Buffer.concat([gif, Buffer.from("garbage")]), Buffer.from("<script>alert(1)</script>")]) assert.throws(() => inspectSkinMedia(bytes));
});

test("library copies media, preserves framing across reload and round-trips portable packages", async t => {
  const { root, library } = await fixture(t);
  let changes = 0; library.onChanged(() => changes++);
  const item = await library.install(request);
  assert.ok(isWallpaperId(item.id)); assert.deepEqual(item.recipe, recipe);
  assert.equal(changes, 1);
  const reopened = new WallpaperRegistry(root); await reopened.initialize();
  assert.deepEqual(reopened.list(), [item]);
  const asset = await reopened.read(item.id); assert.deepEqual(Buffer.from(asset.bytes), gif);
  const portable = await reopened.export(item.id);
  const restored = await reopened.importPackage(portable);
  assert.notEqual(restored.id, item.id); assert.deepEqual(restored.recipe, recipe);
  assert.deepEqual(Buffer.from((await reopened.read(restored.id)).bytes), gif);
  await reopened.remove(item.id); assert.equal(await reopened.read(item.id), null);
  const twice = new WallpaperRegistry(root); await twice.initialize(); assert.deepEqual(twice.list(), [restored]);
});

test("native video bytes and decoded dimensions survive install without transcoding", async t => {
  const { library } = await fixture(t);
  for (const extension of ["mp4", "webm"]) {
    const bytes = await readFile(new URL(`./fixtures/live-skins/background.${extension}`, import.meta.url));
    const saved = await library.install({ ...request, bytes, width: 320, height: 200 });
    assert.equal(saved.media.format, extension); assert.equal(saved.media.animated, true);
    assert.deepEqual(Buffer.from((await library.read(saved.id)).bytes), bytes);
  }
});

test("malformed recipes, sizes, dimensions and portable payloads leave library unchanged", async t => {
  const { library } = await fixture(t);
  for (const patch of [{ width: 959 }, { height: 0 }, { name: " " }, { recipe: { ...recipe, fit: "execute" } }, { recipe: { ...recipe, x: 101 } }, { recipe: { ...recipe, dim: NaN } }, { recipe: { ...recipe, width: 8192, height: 8192 } }]) await assert.rejects(library.install({ ...request, ...patch }));
  for (const source of ["{}", '{"kind":"canvastty-wallpaper","schemaVersion":1,"source":{"base64":"!!"}}']) await assert.rejects(library.importPackage(Buffer.from(source)));
  const item = await library.install(request), payload = JSON.parse(Buffer.from(await library.export(item.id)).toString());
  payload.source.base64 = "YQ==garbage";
  await assert.rejects(library.importPackage(Buffer.from(JSON.stringify(payload))));
  assert.equal(library.list().length, 1);
  assert.equal(await library.read("wallpaper:../../elsewhere"), null);
});

test("missing, replaced and symlinked media fail safely without hiding healthy entries", async t => {
  const { root, library } = await fixture(t);
  const item = await library.install(request), path = join(root, "wallpapers", item.id.slice(10), "media.gif");
  await rm(path); await symlink(join(root, "secret.gif"), path); await writeFile(join(root, "secret.gif"), gif);
  await assert.rejects(library.read(item.id));
  const good = await library.install(request);
  const manifest = join(root, "wallpapers", item.id.slice(10), "wallpaper.json");
  await writeFile(manifest, JSON.stringify({ ...item, media: { ...item.media, format: "../../secret" } }));
  const reopened = new WallpaperRegistry(root); await reopened.initialize(); assert.deepEqual(reopened.list(), [good]);
});

test("wallpaper selection and Home clock fonts persist and reject unknown IDs/styles", async t => {
  const { root, library } = await fixture(t); const item = await library.install(request);
  const settings = new SettingsStore(root, "ru"); await settings.load();
  await settings.update({ canvasBackground: item.id, homeAvatarWallpaper: item.id, homeClockWallpaper: item.id, homeClockFont: "pixel" });
  const reopened = await new SettingsStore(root, "ru").load();
  assert.equal(reopened.canvasBackground, item.id); assert.equal(reopened.homeAvatarWallpaper, item.id); assert.equal(reopened.homeClockWallpaper, item.id); assert.equal(reopened.homeClockFont, "pixel");
  await settings.update({ homeClockFont: "script", homeAvatarWallpaper: "../../secret" });
  assert.equal(settings.get().homeClockFont, "mono"); assert.equal(settings.get().homeAvatarWallpaper, null);
});
