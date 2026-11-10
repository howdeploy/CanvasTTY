import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MacSparkleUpdater } from "../src/main/services/updates/MacSparkleUpdater.ts";
import { UpdateController } from "../src/main/services/updates/UpdateController.ts";

test("Mac check treats an older release without update assets as up to date", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-mac-old-release-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      tag_name: "v1.5.2", body: null, draft: false, prerelease: false, assets: []
    }), { status: 200 });
    const updater = new MacSparkleUpdater(directory, "unused.app", "unused-helper", "unused-server", "1.5.3");
    const update = new UpdateController(updater, "1.5.3");
    await update.check();
    assert.deepEqual(update.status(), { type: "upToDate" });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mac hotfix check and download preserve the exact version and signed-feed probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-mac-hotfix-"));
  const originalFetch = globalThis.fetch;
  const version = "1.8.6-hotfix.1";
  const prefix = `https://github.com/howdeploy/CanvasTTY/releases/download/v${version}/`;
  const archive = Buffer.from("hotfix archive");
  const feed = Buffer.from("signed appcast");
  try {
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.endsWith("/releases/latest")) return new Response(JSON.stringify({
        tag_name: `v${version}`, draft: false, prerelease: false, body: "hotfix notes",
        assets: [
          { name: `CanvasTTY-${version}-mac-arm64.zip`, browser_download_url: prefix + `CanvasTTY-${version}-mac-arm64.zip`, size: archive.length },
          { name: "appcast.xml", browser_download_url: prefix + "appcast.xml", size: feed.length }
        ]
      }));
      if (url === prefix + "appcast.xml") return new Response(feed);
      if (url === prefix + `CanvasTTY-${version}-mac-arm64.zip`) return new Response(archive);
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const updater = new MacSparkleUpdater(directory, "unused.app", "unused-helper", "unused-server", "1.8.6");
    let probed;
    updater.probeSignedFeed = async (path, selectedVersion) => { probed = selectedVersion; return true; };
    const controller = new UpdateController(updater, "1.8.6");
    await controller.check();
    assert.equal(probed, version);
    assert.deepEqual(controller.status(), { type: "available", version, notes: "hotfix notes" });
    await controller.download();
    assert.deepEqual(controller.status(), { type: "ready", version });
    assert.deepEqual(await readFile(updater.cached.archivePath), archive);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["normal", "crash"]) {
  test(`Mac staged download does not install after ${mode} exit`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "canvastty-mac-update-"));
    try {
      const installed = join(directory, "installed-version");
      await writeFile(installed, "1.5.2");
      const child = spawnSync(process.execPath, ["tests/fixtures/mac-update-stage.mjs", directory, mode], {
        cwd: process.cwd(), encoding: "utf8"
      });
      assert.match(child.stdout, /READY/);
      if (mode === "normal") assert.equal(child.status, 0);
      else if (process.platform === "win32") assert.ok(Number.isInteger(child.status) && child.status !== 0);
      else assert.equal(child.signal, "SIGKILL");
      assert.equal(await readFile(installed, "utf8"), "1.5.2");
      const cache = await readdir(join(directory, "updates"));
      assert.equal(cache.length, 1);
      const restarted = new MacSparkleUpdater(directory, "unused.app", "unused-helper", "unused-server", "1.5.2");
      await assert.rejects(restarted.install(), /No cached Mac update/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("Mac check clears abandoned downloads but leaves an active installer cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-mac-cache-cleanup-"));
  const root = join(directory, "updates");
  const abandoned = join(root, "mac-abandoned");
  const active = join(root, "mac-active");
  const expired = join(root, "mac-expired");
  const originalFetch = globalThis.fetch;
  try {
    for (const path of [abandoned, active, expired]) await mkdir(path, { recursive: true });
    for (const path of [active, expired]) await writeFile(join(path, "installing"), "");
    const old = new Date(Date.now() - 30 * 60_000);
    await utimes(join(expired, "installing"), old, old);
    globalThis.fetch = async () => { throw new Error("Network unavailable"); };
    const updater = new MacSparkleUpdater(directory, "unused.app", "unused-helper", "unused-server", "1.5.2");
    await assert.rejects(updater.check(), /Network unavailable/);
    assert.deepEqual((await readdir(root)).sort(), ["mac-active"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const version of ["1.6.0", "1.8.6-hotfix.1"])
test(`Mac update server accepts ${version} and removes its cache after the installer exits`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-mac-server-cleanup-"));
  try {
    const cache = join(directory, "mac-finished");
    await mkdir(cache);
    const appcast = join(cache, "appcast.xml");
    const archive = join(cache, "update.zip");
    const helper = join(directory, "helper.mjs");
    await writeFile(helper, "process.exit(0);\n");
    await writeFile(appcast, "appcast");
    await writeFile(archive, "archive");
    const child = spawnSync(process.execPath, ["src/native/updates/mac-update-server.mjs",
      process.execPath, helper, appcast, archive, version], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(await readdir(directory), ["helper.mjs"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
