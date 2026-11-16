import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginFileService } from "../src/main/services/PluginFileService.ts";
import { validatePluginManifest, PluginManager } from "../src/main/services/PluginManager.ts";

const ID = "com.canvastty.file-explorer";
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), "ct-files-"));
  const folder = join(directory, "Media");
  await mkdir(folder);
  let enabled = true;
  const authorize = (id, permission) => {
    assert.equal(permission, "files:read");
    if (!enabled || ![ID, "other.plugin"].includes(id)) throw new Error("Permission denied");
  };
  const service = new PluginFileService(directory, authorize);
  await service.load();
  const root = await service.addRoot(ID, folder);
  try { await fn({ directory, folder, service, root, authorize, disable: () => { enabled = false; } }); }
  finally { await rm(directory, { force: true, recursive: true }); }
}

test("file roots are opaque, plugin-scoped, persistent and revocable", async () => fixture(async ({ directory, folder, service, root, authorize }) => {
  assert.deepEqual(Object.keys(root).sort(), ["id", "name"]);
  assert.equal(root.name, "Media");
  assert.deepEqual(await service.addRoot(ID, folder), root);
  const restored = new PluginFileService(directory, authorize);
  await restored.load();
  assert.deepEqual(restored.roots(ID), [root]);
  assert.deepEqual(restored.roots("other.plugin"), []);
  await assert.rejects(restored.list("other.plugin", root.id, "", {}), /access/);
  await restored.revoke(ID, root.id);
  await assert.rejects(restored.list(ID, root.id, "", {}), /access/);
}));

test("lists directories first, filters all pages, hides dotfiles and paginates", async () => fixture(async ({ folder, service, root }) => {
  await mkdir(join(folder, "Zoo"));
  await writeFile(join(folder, ".hidden"), "secret");
  await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(join(folder, `item-${i}.txt`), "hello")));
  const first = await service.list(ID, root.id, "", {});
  assert.equal(first.entries[0].kind, "directory");
  assert.equal(first.entries.length, 200);
  assert.equal(first.total, 206);
  const second = await service.list(ID, root.id, "", { offset: first.nextOffset });
  assert.equal(second.entries.length, 6);
  assert.equal(second.nextOffset, null);
  const filtered = await service.list(ID, root.id, "", { query: "item-204" });
  assert.equal(filtered.entries.length, 1);
  assert.equal(filtered.entries[0].kind, "text");
  assert.equal((await service.list(ID, root.id, "", { showHidden: true })).total, 207);
  await assert.rejects(service.list(ID, root.id, "", { offset: -1 }), /offset/);
}));

test("refuses traversal, absolute paths, Windows drive/ADS syntax and symlink escapes", async () => fixture(async ({ directory, folder, service, root }) => {
  await writeFile(join(directory, "outside.mp4"), "private");
  for (const relative of ["../outside.mp4", "/tmp", "C:/Windows", "file:stream", "a\\b", "a//b", "a/./b", "a\nb"]) {
    await assert.rejects(service.entry(ID, root.id, relative), /Invalid/);
  }
  if (process.platform !== "win32") {
    await symlink(join(directory, "outside.mp4"), join(folder, "escape.mp4"));
    await assert.rejects(service.entry(ID, root.id, "escape.mp4"), /outside/);
    assert.equal((await service.list(ID, root.id, "", {})).entries.length, 0);
  }
}));

test("streams PNG, video and audio through seekable authenticated grants", async () => fixture(async ({ folder, service, root }) => {
  for (const [name, type] of [["photo.PNG", "image/png"], ["photo.JPG", "image/jpeg"], ["animation.gif", "image/gif"], ["movie.mp4", "video/mp4"], ["song.mp3", "audio/mpeg"]]) {
    await writeFile(join(folder, name), Buffer.from([0, 1, 2, 3, 4, 5]));
    const entry = await service.entry(ID, root.id, name);
    const response = await service.protocolResponse(new Request(entry.streamUrl, { headers: { Range: "bytes=1-3" } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), type);
    assert.equal(response.headers.get("content-range"), "bytes 1-3/6");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
    const head = await service.protocolResponse(new Request(entry.streamUrl, { method: "HEAD" }));
    assert.equal(head.headers.get("content-length"), "6");
    assert.equal(await head.text(), "");
  }
  const movie = await service.entry(ID, root.id, "movie.mp4");
  assert.equal((await service.protocolResponse(new Request(movie.streamUrl, { headers: { Range: "bytes=80-90" } }))).status, 416);
  await service.revoke(ID, root.id);
  assert.equal((await service.protocolResponse(new Request(movie.streamUrl))).status, 404);
}));

test("text preview is bounded, inert and refuses binary data", async () => fixture(async ({ folder, service, root }) => {
  await writeFile(join(folder, "large.html"), "<script>bad()</script>" + "x".repeat(300_000));
  const preview = await service.readText(ID, root.id, "large.html");
  assert.equal(Buffer.byteLength(preview.content), 256 * 1024);
  assert.equal(preview.truncated, true);
  await writeFile(join(folder, "binary.txt"), Buffer.from([0, 1]));
  await assert.rejects(service.readText(ID, root.id, "binary.txt"), /Binary/);
  await assert.rejects(service.readText(ID, root.id, ""), /regular/);
}));

test("drag handles resolve real quoted paths without newlines and respect revocation", async () => fixture(async ({ folder, service, root, disable }) => {
  const name = "it's $(echo pwned) a file.txt";
  await writeFile(join(folder, name), "safe");
  const entry = await service.entry(ID, root.id, name);
  const text = await service.dropText(entry.dragToken, "darwin");
  assert.ok(text.includes("'\"'\"'"));
  assert.ok(text.endsWith(" "));
  assert.ok(!text.includes("\n"));
  const windows = await service.dropText(entry.dragToken, "win32");
  assert.ok(windows.includes("it''s"));
  await assert.rejects(service.dropText("fake"), /expired/);
  disable();
  await assert.rejects(service.dropText(entry.dragToken), /Permission/);
}));

test("uninstall blocks pending folder grants and invalidates drag handles", async () => fixture(async ({ folder, service, root }) => {
  await writeFile(join(folder, "a.txt"), "a");
  const entry = await service.entry(ID, root.id, "a.txt");
  service.beginRemoval(ID);
  await assert.rejects(service.addRoot(ID, folder), /removed/);
  await assert.rejects(service.dropText(entry.dragToken), /unavailable/);
  await service.revokeAll(ID);
  service.endRemoval(ID);
  assert.deepEqual(service.roots(ID), []);
  await assert.rejects(service.dropText(entry.dragToken), /expired/);
}));

test("the explorer manifest, real asset CSP and disabled-plugin stream revocation work together", async () => fixture(async ({ directory, folder }) => {
  const manifest = JSON.parse(await readFile(new URL("../examples/plugins/file-explorer/canvastty.plugin.json", import.meta.url), "utf8"));
  const validated = validatePluginManifest(manifest);
  assert.ok(validated.permissions.includes("files:read"));
  assert.deepEqual(validated.contributions.map((item) => item.kind), ["canvas-app", "window"]);
  await cp(new URL("../examples/plugins/file-explorer", import.meta.url), join(directory, "plugins", ID), { recursive: true });
  await writeFile(join(directory, "plugins.json"), JSON.stringify({ [ID]: {
    sourceUrl: "https://github.com/howdeploy/CanvasTTY", enabled: true, installedAt: Date.now()
  } }));
  const manager = new PluginManager(directory);
  try {
    await manager.load();
    const asset = await manager.protocolResponse(`canvastty-plugin://${ID}/index.html`);
    assert.equal(asset.status, 200);
    const csp = asset.headers.get("content-security-policy");
    for (const directive of ["img-src", "media-src", "connect-src"]) {
      assert.match(csp.split("; ").find((part) => part.startsWith(directive)), /canvastty-files:/);
    }
    assert.ok(!csp.includes("https:"));
    const sdk = await (await manager.protocolResponse("canvastty-plugin://host/sdk.js")).text();
    assert.ok(sdk.includes('pickFolder: () => request("files.pickFolder")'));
    assert.ok(!sdk.includes("fileDropText")); // Path resolution belongs only to the host renderer.
    const files = new PluginFileService(join(directory, "data"), (id, permission) => manager.assertPermission(id, permission));
    const root = await files.addRoot(ID, folder);
    await writeFile(join(folder, "demo.png"), "fixture");
    const entry = await files.entry(ID, root.id, "demo.png");
    await manager.setEnabled(ID, false);
    assert.equal((await files.protocolResponse(new Request(entry.streamUrl))).status, 404);
    await assert.rejects(files.dropText(entry.dragToken), /disabled/);
  } finally { await manager.dispose(); }
}));
