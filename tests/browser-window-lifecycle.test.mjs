import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MAX_BROWSER_WINDOWS } from "../src/main/services/browser/BrowserWorkspace.ts";
import { actor, fixture } from "./browser-workspace-fixture.mjs";

const a = actor("a"), b = actor("b");
const CYCLES = MAX_BROWSER_WINDOWS * 2 + 8;

const persisted = async (root) => JSON.parse(await readFile(join(root, "browser-windows.json"), "utf8")).windows;
const windowsOf = (workspace) => workspace.getState().windows;
const hidden = (workspace) => windowsOf(workspace).filter((entry) => !entry.snapshot.visible).map((entry) => entry.id);

/** Disconnect-driven releases persist asynchronously; polls until `condition` holds or fails after a second. */
async function waitFor(condition, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

/** Simulates HOME's Browser action: open without a card ID, then close the card it produced. */
async function cycle(workspace) {
  const opened = await workspace.open();
  assert.ok(opened.browserId, "open() reports the card it opened");
  assert.equal(windowsOf(workspace).find((entry) => entry.id === opened.browserId).snapshot.visible, true);
  await workspace.close(opened.browserId);
  return opened.browserId;
}

test("repeated open/close cycles from a fresh workspace reuse the same card and never hit the window limit", async (t) => {
  const f = await fixture(t);
  const ids = new Set();
  for (let index = 0; index < CYCLES; index += 1) ids.add(await cycle(f.workspace));
  assert.deepEqual([...ids], ["default"], "a fresh workspace reopens its hidden legacy card");
  assert.equal(windowsOf(f.workspace).length, 1);
  assert.equal((await persisted(f.root)).length, 1);
  assert.equal(f.instances.size, 1, "no extra browser services are created");
  const agent = await f.call(a, "browser_new_window");
  assert.equal(agent.ok, true, JSON.stringify(agent.error));
});

test("open/close cycles with two user cards keep at most two live entries and reopen the most recently hidden one", async (t) => {
  const f = await fixture(t);
  const first = (await f.workspace.open()).browserId;
  const second = (await f.workspace.open()).browserId;
  assert.notEqual(first, second, "a second open while the first card is visible creates a new card");
  await f.workspace.close(first);
  await f.workspace.close(second);
  for (let index = 0; index < CYCLES; index += 1) {
    assert.equal(await cycle(f.workspace), second, "the most recently hidden card is reopened");
    assert.equal(windowsOf(f.workspace).length, 2);
  }
  assert.equal((await persisted(f.root)).length, 2);
  assert.equal(f.instances.size, 2);
  assert.deepEqual(hidden(f.workspace).sort(), [first, second].sort());
  await f.workspace.open(undefined, first);
  await f.workspace.close(first);
  assert.equal((await f.workspace.open()).browserId, first, "hiding a card makes it the next reopen candidate");
});

test("a hidden card with retained tabs is reopened with its tabs", async (t) => {
  const f = await fixture(t);
  const id = (await f.workspace.open()).browserId;
  await f.workspace.newTab("https://second.test/", id);
  const before = windowsOf(f.workspace).find((entry) => entry.id === id).snapshot;
  assert.equal(before.tabs.length, 2);
  await f.workspace.close(id);
  assert.equal(f.instances.get(id).disposed, false, "a card with tabs is retained, not released");
  const reopened = await f.workspace.open();
  assert.equal(reopened.browserId, id);
  const after = windowsOf(f.workspace).find((entry) => entry.id === id).snapshot;
  assert.deepEqual(after.tabs.map((tab) => tab.url), before.tabs.map((tab) => tab.url));
  assert.equal(after.activeTabId, before.activeTabId);
  await f.workspace.close(id);
  const navigated = await f.workspace.open("https://third.test/");
  assert.equal(navigated.browserId, id);
  const tabs = windowsOf(f.workspace).find((entry) => entry.id === id).snapshot.tabs;
  assert.equal(tabs.length, 2, "opening with a URL navigates the retained active tab instead of adding one");
  assert.equal(tabs.find((tab) => tab.id === before.activeTabId).url, "https://third.test/");
});

test("a hidden card without tabs is released on close and a restart does not restore it", async (t) => {
  const f = await fixture(t);
  await f.workspace.open();
  const spare = (await f.workspace.open()).browserId;
  await f.workspace.closeAllTabs(spare);
  await f.workspace.close(spare);
  assert.equal(windowsOf(f.workspace).some((entry) => entry.id === spare), false, "the empty card leaves the map");
  assert.equal(f.instances.get(spare).disposed, true, "the released card's service is disposed");
  assert.equal((await persisted(f.root)).some((entry) => entry.id === spare), false, "the released card leaves persistence");
  assert.equal(f.workspace.getState().browserId, "default", "the user's current card falls back to the legacy card");
  await f.workspace.close("default");
  assert.equal((await f.workspace.open()).browserId, "default", "the released card is not a reopen candidate");
  await f.workspace.close("default");
  const restarted = await fixture(t, f.root);
  assert.deepEqual(windowsOf(restarted.workspace).map((entry) => entry.id), ["default"]);
  assert.equal(windowsOf(restarted.workspace)[0].snapshot.tabs.length, 1, "retained tabs survive the restart");
  const listed = await restarted.call(a, "browser_list_windows");
  assert.equal(listed.data.windows.some((entry) => entry.id === spare), false);
});

test("startup sweeps persisted hidden cards that have nothing to retain", async (t) => {
  const f = await fixture(t);
  const kept = (await f.workspace.open()).browserId;
  await f.workspace.close(kept);
  const stale = ["dead-one", "dead-two"].map((id) => ({ id, title: "Browser", visible: false }));
  await writeFile(join(f.root, "browser-windows.json"), JSON.stringify({ version: 1, windows: [...await persisted(f.root), ...stale] }));
  const restarted = await fixture(t, f.root);
  assert.deepEqual(windowsOf(restarted.workspace).map((entry) => entry.id), [kept]);
  assert.deepEqual((await persisted(f.root)).map((entry) => entry.id), [kept], "the sweep is written back so the next restart is clean");
  assert.equal((await restarted.workspace.open()).browserId, kept);
});

test("an agent-owned card coexists with user open/close cycles and is never reused for the user", async (t) => {
  const f = await fixture(t);
  const owned = await f.create(a);
  await f.call(a, "browser_navigate", { url: "https://agent.test/" });
  await f.workspace.close(owned.browserId);
  for (let index = 0; index < CYCLES; index += 1) {
    const reused = await cycle(f.workspace);
    assert.notEqual(reused, owned.browserId, "the user never gets the agent's hidden card");
  }
  assert.equal(windowsOf(f.workspace).length, 2);
  const agentView = windowsOf(f.workspace).find((entry) => entry.id === owned.browserId);
  assert.notEqual(agentView.owner, null);
  assert.equal(agentView.snapshot.visible, false);
  assert.equal(agentView.snapshot.tabs[0].url, "https://agent.test/", "the agent's tabs are untouched");
  const other = await f.call(b, "browser_activate_window", { browserId: owned.browserId });
  assert.equal(other.error.code, "BROWSER_IN_USE");
  const listed = await f.call(b, "browser_list_windows");
  assert.equal(listed.data.windows.find((entry) => entry.id === owned.browserId).available, false);
  const activated = await f.call(a, "browser_activate_window", { browserId: owned.browserId });
  assert.equal(activated.ok, true, "the owner can still bring its own hidden card back");
  assert.equal(windowsOf(f.workspace).find((entry) => entry.id === owned.browserId).snapshot.visible, true);
});

test("a hidden agent card with tabs becomes reusable only after its owner disconnects, an empty one is released", async (t) => {
  const f = await fixture(t);
  const withTabs = await f.create(a);
  const empty = await f.create(b);
  await f.call(b, "browser_close_tab", { tabId: empty.tabId });
  await f.workspace.close(withTabs.browserId);
  await f.workspace.close(empty.browserId);
  assert.equal(windowsOf(f.workspace).length, 3, "owned cards are never released while their agent is connected");
  assert.equal((await f.workspace.open()).browserId, "default", "hidden agent cards are skipped");
  await f.workspace.close("default");
  f.workspace.agentDisconnected(a); f.workspace.agentDisconnected(b);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windowsOf(f.workspace).some((entry) => entry.id === empty.browserId), false, "the empty card is released on disconnect");
  await waitFor(async () => !(await persisted(f.root)).some((entry) => entry.id === empty.browserId), "the release reaches browser-windows.json");
  assert.equal(f.instances.get(empty.browserId).disposed, true);
  assert.equal((await f.workspace.open()).browserId, "default", "the card hidden most recently is reopened first");
  await f.workspace.close("default");
  await f.workspace.open(undefined, withTabs.browserId);
  await f.workspace.close(withTabs.browserId);
  const reopened = await f.workspace.open();
  assert.equal(reopened.browserId, withTabs.browserId, "an unowned card with tabs is reusable by the user once its agent is gone");
  assert.equal(windowsOf(f.workspace).find((entry) => entry.id === withTabs.browserId).snapshot.tabs.length, 1);
});
