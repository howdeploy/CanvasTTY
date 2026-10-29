import assert from "node:assert/strict";
import test from "node:test";
import { browserServiceHarness } from "./fixtures/browser-service-harness.mjs";

test("extra Mac browser windows inherit the pause setting and follow live updates", async (t) => {
  const { MacBrowserWindows, windows, onCleanup } = await browserServiceHarness(t, { entry: "MacBrowserWindows" });
  const manager = new MacBrowserWindows();
  onCleanup(() => manager.dispose());
  manager.setPauseHiddenTabs(false);
  await manager.open("https://fixture.test/first");
  await manager.open("https://fixture.test/second");
  const browsers = () => windows.map((window) => manager.forRenderer(window.webContents));
  assert.equal(browsers().length, 2);
  assert.ok(browsers().every((browser) => browser.lifecycle.isEnabled === false));

  manager.setPauseHiddenTabs(true);
  assert.ok(browsers().every((browser) => browser.lifecycle.isEnabled === true));
  await manager.open("https://fixture.test/third");
  assert.equal(browsers().length, 3);
  assert.ok(browsers().every((browser) => browser.lifecycle.isEnabled === true));

  manager.setPauseHiddenTabs(false);
  assert.ok(browsers().every((browser) => browser.lifecycle.isEnabled === false));
  windows[0].destroy();
  manager.setPauseHiddenTabs(true);
  assert.equal(manager.forRenderer(windows[0].webContents), null);
  assert.ok(browsers().slice(1).every((browser) => browser.lifecycle.isEnabled === true));
});

for (const platform of ["linux", "win32"]) {
  test(`additional browser windows remain unavailable on ${platform}`, async (t) => {
    const { MacBrowserWindows, windows, onCleanup } = await browserServiceHarness(t, { entry: "MacBrowserWindows", platform });
    const manager = new MacBrowserWindows();
    onCleanup(() => manager.dispose());
    await assert.rejects(manager.open("https://fixture.test/"), /available on macOS/);
    assert.equal(windows.length, 0);
  });
}
