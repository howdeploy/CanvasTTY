import assert from "node:assert/strict";
import test from "node:test";
import { browserServiceHarness, flushBrowser } from "./fixtures/browser-service-harness.mjs";

for (const restoreTabs of [false, true]) {
  for (const withSurvivor of [false, true]) {
    test(`reload recovers a destroyed tab (restore=${restoreTabs}, other tab=${withSurvivor})`, async (t) => {
      const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t);
      const owner = new FakeWindow();
      const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs });
      onCleanup(() => browser.dispose());
      const url = "https://fixture.test/recover";
      const opened = await browser.newTab(url);
      const tabId = opened.activeTabId;
      const before = browser.tabs.get(tabId);
      if (withSurvivor) await browser.newTab("https://fixture.test/survivor");
      browser.setViewport({ x: 0, y: 120, width: 900, height: 600, surface: "native", showAgentPresence: false });
      const activeId = browser.getState().activeTabId;
      const revision = before.documentRevision;
      before.view.webContents.close();
      assert.equal(browser.getState().tabs.find((tab) => tab.id === tabId).status, "crashed");

      const snapshot = await browser.reload(tabId);
      await flushBrowser();
      const after = browser.tabs.get(tabId);
      assert.notEqual(after, before);
      assert.equal(after.view.webContents.isDestroyed(), false);
      assert.equal(after.view.webContents.getURL(), url);
      assert.deepEqual(after.view.webContents.loads, [url], "recovery loads once rather than restoring and reloading");
      assert.ok(after.documentRevision > revision, "existing automation observations are invalid after recovery");
      assert.equal(after.status, "ready");
      assert.equal(after.crashState, null);
      assert.equal(after.visible, !withSurvivor, "an active replacement is mounted immediately");
      assert.equal(snapshot.activeTabId, activeId, "recovery preserves the active selection");
      assert.equal(snapshot.tabs.length, withSurvivor ? 2 : 1);
      assert.equal(snapshot.tabs.some((tab) => tab.id === tabId), true);
    });
  }
}

for (const platform of ["linux", "win32"]) {
  test(`${platform} also recovers destroyed tabs`, async (t) => {
    const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t, { platform });
    const owner = new FakeWindow();
    const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs: false });
    onCleanup(() => browser.dispose());
    const opened = await browser.newTab("https://fixture.test/recover");
    browser.tabs.get(opened.activeTabId).view.webContents.close();
    await browser.reload(opened.activeTabId);
    assert.equal(browser.tabs.size, 1);
  });
}
