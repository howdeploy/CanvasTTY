import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager } from "../src/main/services/PluginManager.ts";

const pluginId = "com.example.install-ownership";
const sourceUrl = "https://github.com/example/install-ownership";

async function fixture(t, { modular = false, failDownload = () => false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-plugin-install-ownership-"));
  const profile = join(root, "profile");
  const source = join(root, "source");
  await mkdir(source);
  const assets = new Map([["app.html", Buffer.from("<p>owned package</p>")], ["extra.js", Buffer.from("export const extra = true;")]]);
  const asset = (path) => ({ path, bytes: assets.get(path).length, sha256: createHash("sha256").update(assets.get(path)).digest("hex") });
  const manifest = {
    apiVersion: 1, id: pluginId, name: "Install ownership", version: "1.0.0",
    description: "An isolated installation fixture.", permissions: [],
    contributions: [{ id: "app", kind: "canvas-app", title: "App", entry: "app.html", defaultSize: { width: 480, height: 300 } }],
    ...(modular ? {
      coreFiles: [asset("app.html")],
      modules: [{ id: "extra", title: "Extra", defaultSelected: true, permissions: [], files: [asset("extra.js")] }]
    } : {})
  };
  await writeFile(join(source, "canvastty.plugin.json"), JSON.stringify(manifest));
  await writeFile(join(source, "app.html"), assets.get("app.html"));
  const manager = new PluginManager(profile, (_url, destination) => cp(source, destination, { recursive: true }),
    async (_url, destination, files) => {
      for (const file of files) {
        await writeFile(join(destination, file.path), assets.get(file.path));
        if (failDownload()) throw new Error("Synthetic module download failure");
      }
    });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  await manager.load();
  const destination = join(profile, "plugins", pluginId);
  const sibling = join(profile, "plugins", "unrelated-owner.txt");
  await writeFile(sibling, "other install's data");
  return { root, profile, manager, destination, sibling };
}

test("refuses existing unregistered plugin destinations without touching their contents", async (t) => {
  for (const kind of ["directory", "empty-directory", "file", "symlink", "modular-directory"]) {
    await t.test(kind, async (t) => {
      const { root, profile, manager, destination, sibling } = await fixture(t, { modular: kind === "modular-directory" });
      if (kind === "file") await writeFile(destination, "foreign file");
      else if (kind === "symlink") {
        await mkdir(join(root, "foreign"));
        await writeFile(join(root, "foreign", "owner.txt"), "foreign symlink target");
        await symlink(join(root, "foreign"), destination, process.platform === "win32" ? "junction" : "dir");
      } else {
        await mkdir(destination);
        if (kind !== "empty-directory") await writeFile(join(destination, "owner.txt"), "foreign directory");
      }
      const registry = await readFile(join(profile, "plugins.json"), "utf8");
      const preview = await manager.previewInstall(sourceUrl);
      const [result] = await Promise.allSettled([manager.install(preview.token)]);
      if (kind === "file") assert.equal(await readFile(destination, "utf8"), "foreign file");
      else if (kind === "symlink") {
        assert.equal((await lstat(destination)).isSymbolicLink(), true);
        assert.equal(await readFile(join(destination, "owner.txt"), "utf8"), "foreign symlink target");
      } else if (kind === "empty-directory") assert.deepEqual(await readdir(destination), []);
      else {
        assert.equal(await readFile(join(destination, "owner.txt"), "utf8"), "foreign directory");
        assert.deepEqual(await readdir(destination), ["owner.txt"]);
      }
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /Unregistered plugin directory exists/);
      assert.equal(await readFile(sibling, "utf8"), "other install's data");
      assert.deepEqual(manager.list(), []);
      assert.equal(await readFile(join(profile, "plugins.json"), "utf8"), registry);
      assert.deepEqual(await readdir(join(profile, "plugin-staging")), []);
    });
  }
});

test("cleans its reservation after a failed package move, then allows retry", async (t) => {
  const { profile, manager, destination, sibling } = await fixture(t);
  const preview = await manager.previewInstall(sourceUrl);
  const [staging] = await readdir(join(profile, "plugin-staging"));
  await rm(join(profile, "plugin-staging", staging, "repository"), { recursive: true });
  await assert.rejects(manager.install(preview.token), /ENOENT/);
  await assert.rejects(lstat(destination), /ENOENT/);
  assert.deepEqual(manager.list(), []);
  assert.equal(await readFile(sibling, "utf8"), "other install's data");
  await manager.install((await manager.previewInstall(sourceUrl)).token);
  assert.equal(await readFile(join(destination, "app.html"), "utf8"), "<p>owned package</p>");
});

test("removes only its partial modular package after a download fails", async (t) => {
  let fail = true;
  const { profile, manager, destination, sibling } = await fixture(t, { modular: true, failDownload: () => fail });
  const registry = await readFile(join(profile, "plugins.json"), "utf8");
  await assert.rejects(manager.install((await manager.previewInstall(sourceUrl)).token), /Synthetic module download failure/);
  await assert.rejects(lstat(destination), /ENOENT/);
  assert.deepEqual(manager.list(), []);
  assert.equal(await readFile(join(profile, "plugins.json"), "utf8"), registry);
  assert.equal(await readFile(sibling, "utf8"), "other install's data");
  assert.deepEqual(await readdir(join(profile, "plugin-staging")), []);
  fail = false;
  await manager.install((await manager.previewInstall(sourceUrl)).token);
  assert.equal(await readFile(join(destination, "extra.js"), "utf8"), "export const extra = true;");
});

test("rolls back an owned package when the registry write fails and can retry", async (t) => {
  const { profile, manager, destination, sibling } = await fixture(t);
  const registry = await readFile(join(profile, "plugins.json"), "utf8");
  const blockedTemporaryPath = join(profile, "plugins.json.tmp");
  await mkdir(blockedTemporaryPath);
  await writeFile(join(blockedTemporaryPath, "owner.txt"), "keep registry obstacle");
  await assert.rejects(manager.install((await manager.previewInstall(sourceUrl)).token), /EISDIR|EPERM|EACCES/);
  await assert.rejects(lstat(destination), /ENOENT/);
  assert.deepEqual(manager.list(), []);
  assert.equal(await readFile(join(profile, "plugins.json"), "utf8"), registry);
  assert.equal(await readFile(sibling, "utf8"), "other install's data");
  assert.equal(await readFile(join(blockedTemporaryPath, "owner.txt"), "utf8"), "keep registry obstacle");
  await rm(blockedTemporaryPath, { recursive: true });
  await manager.install((await manager.previewInstall(sourceUrl)).token);
  const reloaded = new PluginManager(profile);
  try {
    assert.deepEqual((await reloaded.load()).map((plugin) => plugin.manifest.id), [pluginId]);
    assert.equal(await readFile(join(destination, "app.html"), "utf8"), "<p>owned package</p>");
  } finally {
    await reloaded.dispose();
  }
});
