import assert from "node:assert/strict";
import test from "node:test";
import { UpdateController } from "../src/main/services/updates/UpdateController.ts";
import { ManualReleaseAdapter } from "../src/main/services/updates/ManualReleaseAdapter.ts";
import { terminalShutdownMessage } from "../src/main/services/updates/updateMessages.ts";

test("terminal confirmation uses correct singular and plural forms", () => {
  assert.equal(terminalShutdownMessage(1, "ru"), "Будет завершена 1 активная терминальная сессия.");
  assert.equal(terminalShutdownMessage(2, "ru"), "Будут завершены 2 активные терминальные сессии.");
  assert.equal(terminalShutdownMessage(5, "ru"), "Будут завершены 5 активных терминальных сессий.");
  assert.equal(terminalShutdownMessage(11, "ru"), "Будут завершены 11 активных терминальных сессий.");
  assert.equal(terminalShutdownMessage(21, "ru"), "Будет завершена 21 активная терминальная сессия.");
  assert.equal(terminalShutdownMessage(1, "en"), "1 active terminal session will close.");
  assert.equal(terminalShutdownMessage(2, "en"), "2 active terminal sessions will close.");
});

function fixture() {
  const calls = [];
  const adapter = {
    async check() { calls.push("check"); return { version: "1.6.0", notes: "Release notes" }; },
    async download(progress) { calls.push("download"); progress(50); },
    async install() { calls.push("install"); }
  };
  return { calls, controller: new UpdateController(adapter, "1.5.2") };
}

test("explicit check, download, install preserve a replayable status", async () => {
  const { calls, controller } = fixture();
  const seen = [];
  const unsubscribe = controller.onStatus(status => seen.push(status.type));
  await controller.check();
  assert.deepEqual(controller.status(), { type: "available", version: "1.6.0", notes: "Release notes" });
  await controller.download();
  assert.deepEqual(controller.status(), { type: "ready", version: "1.6.0" });
  unsubscribe();
  const replay = [];
  controller.onStatus(status => replay.push(status.type));
  await controller.install();
  assert.deepEqual(calls, ["check", "download", "install"]);
  assert.deepEqual(replay, ["ready", "installing"]);
  assert.deepEqual(seen, ["idle", "checking", "available", "downloading", "downloading", "ready"]);
});

test("download and install require the prior explicit stage", async () => {
  const { calls, controller } = fixture();
  await assert.rejects(controller.download());
  await assert.rejects(controller.install());
  assert.deepEqual(calls, []);
});

test("non-new stable releases are not offered", async () => {
  const controller = new UpdateController({
    async check() { return { version: "1.5.1" }; },
    async download() { throw new Error("unexpected"); },
    async install() { throw new Error("unexpected"); }
  }, "1.5.2");
  await controller.check();
  assert.deepEqual(controller.status(), { type: "upToDate" });
});

test("failed download cannot enter ready or install", async () => {
  const controller = new UpdateController({
    async check() { return { version: "1.6.0" }; },
    async download() { throw new Error("checksum mismatch"); },
    async install() { throw new Error("unexpected"); }
  }, "1.5.2");
  await controller.check();
  await assert.rejects(controller.download(), /checksum mismatch/);
  assert.deepEqual(controller.status(), { type: "error", message: "checksum mismatch" });
  await assert.rejects(controller.install());
});

test("a repeated check preserves a downloaded update", async () => {
  const { calls, controller } = fixture();
  await controller.check();
  await controller.download();
  await controller.check();
  assert.deepEqual(controller.status(), { type: "ready", version: "1.6.0" });
  assert.deepEqual(calls, ["check", "download"]);
});

test("a concurrent operation does not start another download", async () => {
  let releaseDownload;
  const calls = [];
  const controller = new UpdateController({
    async check() { return { version: "1.6.0" }; },
    async download() { calls.push("download"); await new Promise(resolve => { releaseDownload = resolve; }); },
    async install() { calls.push("install"); }
  }, "1.5.2");
  await controller.check();
  const first = controller.download();
  await assert.rejects(controller.download(), /No available update/);
  assert.equal(controller.status().type, "downloading");
  releaseDownload();
  await first;
  assert.deepEqual(calls, ["download"]);
});

test("prereleases and equal versions are excluded", async () => {
  const { isNewStableVersion } = await import("../src/main/services/updates/UpdateController.ts");
  for (const value of ["1.5.2", "1.5.1", "1.6.0-beta.1", "v1.6.0", "2.0", "invalid"]) {
    assert.equal(isNewStableVersion(value, "1.5.2"), false);
  }
  assert.equal(isNewStableVersion("1.6.0", "1.5.2"), true);
});

test("network and permission failures are visible and cannot advance the stage", async () => {
  const network = new UpdateController({
    async check() { throw new Error("Network unavailable"); },
    async download() { throw new Error("unexpected"); },
    async install() { throw new Error("unexpected"); }
  }, "1.5.2");
  await assert.rejects(network.check(), /Network unavailable/);
  assert.deepEqual(network.status(), { type: "error", message: "Network unavailable" });
  await assert.rejects(network.download());

  const denied = new UpdateController({
    async check() { return { version: "1.6.0" }; },
    async download() {},
    async install() { throw new Error("Permission denied"); }
  }, "1.5.2");
  await denied.check();
  await denied.download();
  await assert.rejects(denied.install(), /Permission denied/);
  assert.deepEqual(denied.status(), { type: "error", message: "Permission denied" });
});

test("portable updater refuses draft and prerelease releases", async () => {
  const originalFetch = globalThis.fetch;
  const release = { tag_name: "v1.6.0", body: "notes", html_url: "https://example.invalid", draft: false, prerelease: false };
  globalThis.fetch = async () => new Response(JSON.stringify(release), { status: 200 });
  try {
    const adapter = new ManualReleaseAdapter();
    release.draft = true;
    assert.equal(await adapter.check(), null);
    release.draft = false;
    release.prerelease = true;
    assert.equal(await adapter.check(), null);
    release.prerelease = false;
    release.tag_name = "v1.6.0-rc.1";
    assert.equal(await adapter.check(), null);
    release.tag_name = "v1.6.0";
    assert.deepEqual(await adapter.check(), {
      version: "1.6.0", notes: "notes", manualUrl: "https://github.com/howdeploy/CanvasTTY/releases/tag/v1.6.0"
    });
    await assert.rejects(adapter.download());
  } finally { globalThis.fetch = originalFetch; }
});
