import assert from "node:assert/strict";
import test from "node:test";
import { browserServiceHarness } from "./fixtures/browser-service-harness.mjs";

const wheel = { deltaX: -180, deltaY: 0, deltaMode: 0, viewportWidth: 900,
  viewportHeight: 600, ctrlKey: false, metaKey: false };

test("history swipe uses human navigation once and rejects foreign senders, stale generations and lost focus", async (t) => {
  const { BrowserService, FakeWindow, root, onCleanup } = await browserServiceHarness(t);
  const owner = new FakeWindow();
  const browser = new BrowserService(() => owner, { userDataPath: root, restoreTabs: false });
  onCleanup(() => browser.dispose());
  const state = await browser.newTab("https://fixture.test/");
  browser.setViewport({ x: 0, y: 120, width: 900, height: 600, surface: "native", showAgentPresence: false });
  browser.setInputFocused(true);
  const contents = browser.tabs.get(state.activeTabId).view.webContents;
  contents.navigationHistory = { canGoBack: () => true, canGoForward: () => true };
  const calls = [];
  browser.back = async (id) => calls.push(["back", id]);
  browser.forward = async (id) => calls.push(["forward", id]);
  const decision = browser.decidePageWheel(contents, wheel);
  assert.equal(decision.canGoBack, true);
  const request = { ...wheel, generation: decision.generation, historySwipe: "back" };
  browser.handlePageWheel(owner.webContents, request);
  browser.handlePageWheel(contents, { ...request, generation: 999 });
  owner.isFocused = () => false;
  browser.handlePageWheel(contents, request);
  assert.deepEqual(calls, []);
  owner.isFocused = () => true;
  browser.handlePageWheel(contents, request);
  browser.handlePageWheel(contents, request);
  assert.deepEqual(calls, [["back", state.activeTabId]]);
  // A new document's preload must not treat the old gesture's momentum as another swipe.
  browser.canvasGestures.endSequence(false);
  const tail = browser.decidePageWheel(contents, wheel);
  assert.equal(tail.canGoBack, false);
  browser.handlePageWheel(contents, { ...request, generation: tail.generation });
  assert.equal(calls.length, 1);
});
