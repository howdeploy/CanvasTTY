import assert from "node:assert/strict";
import test from "node:test";
import { browserServiceHarness, flushBrowser } from "./fixtures/browser-service-harness.mjs";

for (const platform of ["linux", "win32", "darwin"]) {
  test(`${platform} gives an off-canvas tab layout before its first viewport report`, async (t) => {
    const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t, { platform });
    const owner = new FakeWindow();
    const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs: false });
    onCleanup(() => browser.dispose());
    await browser.ready();
    const opened = await browser.newTab("https://fixture.test/");
    const tab = browser.tabs.get(opened.activeTabId);
    assert.ok(tab.view.getBounds().width > 0);
    assert.ok(tab.view.getBounds().height > 0);
    assert.equal(tab.visible, false, "layout does not reveal a hidden card");
  });
}

test("owner hide/minimize throttles the visible tab and restore/show makes it visible again", async (t) => {
  const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t);
  const owner = new FakeWindow();
  const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs: false });
  onCleanup(() => browser.dispose());
  await browser.ready();
  const opened = await browser.newTab("https://fixture.test/");
  const tab = browser.tabs.get(opened.activeTabId);
  browser.setViewport({ x: 0, y: 120, width: 900, height: 600, surface: "native", showAgentPresence: false });
  // Showing the surface updates page presence through automation; let its grace window finish.
  await flushBrowser();
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(browser.busyAutomationTabs.size, 0);
  assert.equal(tab.visible, true);
  assert.equal(tab.view.webContents.throttled, false);

  for (const [hide, show] of [["hide", "show"], ["minimize", "restore"]]) {
    owner[hide]();
    await flushBrowser();
    assert.equal(tab.visible, false, hide);
    assert.equal(tab.view.webContents.throttled, true, hide);
    assert.equal(browser.lifecycle.entries.get(tab.id).visible, false, "the lifecycle sees a hidden tab");
    browser.setTabAutomationBusy(tab.id, true);
    assert.equal(tab.view.webContents.throttled, false, "automation may still drive a hidden page");
    browser.setTabAutomationBusy(tab.id, false);
    assert.equal(tab.view.webContents.throttled, true, "throttling resumes when automation stops");
    owner[show]();
    await flushBrowser();
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(tab.visible, true, show);
    assert.equal(tab.view.webContents.throttled, false, show);
    assert.equal(browser.lifecycle.entries.get(tab.id).visible, true);
  }
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} pauses native surfaces with its owner`, async (t) => {
    const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t, { platform });
    const owner = new FakeWindow();
    const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs: false });
    onCleanup(() => browser.dispose());
    const opened = await browser.newTab("https://fixture.test/");
    const tab = browser.tabs.get(opened.activeTabId);
    browser.setViewport({ x: 0, y: 120, width: 900, height: 600, surface: "native", showAgentPresence: false });
    await flushBrowser();
    await new Promise((resolve) => setTimeout(resolve, 650));
    owner.hide();
    owner.minimize();
    await flushBrowser();
    assert.equal(tab.visible, false);
    assert.equal(tab.view.webContents.throttled, true);
  });
}

test("disposing the browser removes its download callback from the persistent session", async (t) => {
  const { BrowserService, FakeWindow, root, browserSession } = await browserServiceHarness(t);
  const owner = new FakeWindow();
  const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs: false });
  t.after(() => browser.dispose());
  await browser.ready();
  assert.equal(browserSession.listenerCount("will-download"), 1);
  await browser.dispose();
  assert.equal(browserSession.listenerCount("will-download"), 0);
});
