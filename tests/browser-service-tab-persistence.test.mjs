import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { browserServiceHarness, flushBrowser } from "./fixtures/browser-service-harness.mjs";

const saved = {
  version: 1,
  tabs: [
    { id: "saved-first", url: "https://fixture.test/first" },
    { id: "saved-active", url: "https://fixture.test/active" }
  ],
  activeTabId: "saved-active"
};

async function savedBrowser(t) {
  const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t);
  const path = join(root, "browser-state.json");
  await writeFile(path, JSON.stringify(saved));
  const owner = new FakeWindow();
  const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs: true });
  onCleanup(() => browser.dispose());
  await browser.ready();
  return { browser, readSaved: async () => JSON.parse(await readFile(path, "utf8")) };
}

test("reapplying enabled restore before opening Browser preserves saved tabs and active selection", async (t) => {
  const { browser, readSaved } = await savedBrowser(t);
  assert.equal(browser.tabs.size, 0, "startup leaves runtime tabs lazy");
  await browser.setRestoreTabs(true);
  assert.deepEqual(await readSaved(), saved);
  const restored = await browser.open();
  assert.deepEqual(restored.tabs.map(({ id, url }) => ({ id, url })), saved.tabs);
  assert.equal(restored.activeTabId, saved.activeTabId);
});

test("quitting before opening Browser preserves saved tabs and active selection", async (t) => {
  const { browser, readSaved } = await savedBrowser(t);
  assert.equal(browser.tabs.size, 0, "startup leaves runtime tabs lazy");
  await browser.dispose();
  assert.deepEqual(await readSaved(), saved);
});

test("explicitly closing the last restored tab persists an empty tab list", async (t) => {
  const { browser, readSaved } = await savedBrowser(t);
  await browser.open();
  for (const { id } of saved.tabs) await browser.closeTab(id);
  await flushBrowser();
  await browser.setRestoreTabs(true);
  await browser.dispose();
  assert.deepEqual(await readSaved(), { version: 1, tabs: [], activeTabId: null });
});

test("disabling restore before opening Browser explicitly clears saved tabs", async (t) => {
  const { browser, readSaved } = await savedBrowser(t);
  await browser.setRestoreTabs(false);
  assert.deepEqual(await readSaved(), { version: 1, tabs: [], activeTabId: null });
  await browser.setRestoreTabs(true);
  await browser.dispose();
  assert.deepEqual(await readSaved(), { version: 1, tabs: [], activeTabId: null });
});
