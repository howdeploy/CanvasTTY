import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateToolArguments } from "../src/agent-browser/tool-catalog.mjs";
import { browserCanvasEntries, browserCanvasPatch } from "../src/shared/browserWindows.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { actor, deferred, fixture } from "./browser-workspace-fixture.mjs";

const a = actor("a"), b = actor("b");

test("two agents get independent cards, active tabs and implicit command targets", async (t) => {
  const f = await fixture(t);
  const [one, two] = await Promise.all([f.create(a), f.create(b)]);
  assert.notEqual(one.browserId, two.browserId);
  await f.call(a, "browser_new_tab", { url: "https://a.test/" });
  await f.call(b, "browser_navigate", { url: "https://b.test/" });
  const first = await f.call(a, "browser_list_tabs");
  const second = await f.call(b, "browser_list_tabs");
  assert.equal(first.data.tabs.length, 2);
  assert.equal(second.data.tabs.length, 1);
  assert.equal(second.data.activeTabId, two.tabId);
  assert.equal(second.data.tabs[0].url, "https://b.test/");
  assert.ok(first.data.tabs.every((tab) => tab.browserId === one.browserId));
  assert.equal(f.workspace.getState().browserId, "default", "agent creation does not change the user's selected browser");
});

test("a slow command in one card does not block another card", async (t) => {
  const f = await fixture(t);
  const one = await f.create(a), two = await f.create(b);
  const gate = deferred(); f.instances.get(one.browserId).gate = gate;
  let finished = false;
  const pending = f.call(a, "browser_navigate", { browserId: one.browserId, url: "https://slow.test/" }).then((r) => { finished = true; return r; });
  const other = await f.call(b, "browser_navigate", { browserId: two.browserId, url: "https://fast.test/" });
  assert.equal(other.ok, true);
  assert.equal(finished, false);
  gate.resolve(); assert.equal((await pending).ok, true);
});

test("foreign browser IDs and tab IDs cannot bypass ownership", async (t) => {
  const f = await fixture(t);
  const one = await f.create(a), two = await f.create(b);
  for (const command of [
    { type: "browser_activate_window", browserId: two.browserId },
    { type: "browser_navigate", browserId: two.browserId, tabId: two.tabId, url: "https://wrong.test/" },
    { type: "browser_navigate", tabId: two.tabId, url: "https://wrong.test/" },
    { type: "browser_navigate", ref: { tabId: two.tabId }, url: "https://wrong.test/" }
  ]) {
    const result = await f.call(a, command.type, command);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "BROWSER_IN_USE");
  }
  const mismatched = await f.call(a, "browser_navigate", { browserId: one.browserId, tabId: two.tabId, url: "https://wrong.test/" });
  assert.equal(mismatched.error.code, "TAB_NOT_FOUND");
  assert.deepEqual(f.instances.get(two.browserId).commands.map((command) => command.type), ["browser_new_tab"]);
});

test("window creation replay is deduplicated and invalid inputs create no instance", async (t) => {
  const f = await fixture(t);
  const command = { type: "browser_new_window", requestId: "create-once", title: "Docs" };
  const [first, replay] = await Promise.all([f.workspace.execute(a, command), f.workspace.execute(a, command)]);
  assert.equal(first.data.browserId, replay.data.browserId);
  assert.equal(f.instances.size, 2);
  for (const params of [{ url: "file:///tmp/private" }, { title: "x".repeat(81) }, { title: "bad\nname" }]) {
    assert.equal((await f.call(a, "browser_new_window", params)).ok, false);
  }
  assert.equal(f.instances.size, 2);
  assert.ok(f.records.some((record) => record.operation === "browser_new_window"));
});

test("closing or resizing one card preserves the other and window IDs restore", async (t) => {
  const f = await fixture(t);
  const one = await f.create(a), two = await f.create(b);
  f.workspace.setViewport({ x: 10, y: 20, width: 600, height: 400, surface: "native" }, one.browserId);
  assert.equal(f.instances.get(one.browserId).viewport.width, 600);
  assert.equal(f.instances.get(two.browserId).viewport, null);
  await f.workspace.close(one.browserId);
  const states = f.workspace.getState().windows;
  assert.equal(states.find((entry) => entry.id === one.browserId).snapshot.visible, false);
  assert.equal(states.find((entry) => entry.id === two.browserId).snapshot.visible, true);
  const stored = JSON.parse(await readFile(join(f.root, "browser-windows.json"), "utf8"));
  assert.equal(stored.windows.length, 3);
  const restored = await fixture(t, f.root);
  assert.deepEqual(restored.workspace.getState().windows.map((entry) => entry.id), states.map((entry) => entry.id));
  assert.ok(restored.workspace.getState().windows.every((entry) => entry.owner === null));
});

test("browser layout migration preserves the legacy card and independent bounds", () => {
  const bounds = { position: { x: 12, y: 34 }, size: { width: 900, height: 600 } };
  const entries = browserCanvasEntries({ browserCanvas: bounds });
  assert.deepEqual(entries, [{ id: "default", ...bounds }]);
  const second = { id: "second", position: { x: 1000, y: 34 }, size: bounds.size };
  assert.deepEqual(browserCanvasEntries(browserCanvasPatch([...entries, second])), [...entries, second]);
  assert.equal(browserCanvasPatch([second]).browserCanvas, null);
});

test("browser tools accept scoped windows and still validate fields", () => {
  assert.equal(validateToolArguments("browser_new_window", { title: "Docs", url: "https://example.com/" }).ok, true);
  assert.equal(validateToolArguments("browser_activate_window", {}).ok, false);
  assert.equal(validateToolArguments("browser_type", { browserId: "one", ref: "ref-1", text: "task" }).ok, true);
  assert.equal(validateToolArguments("browser_screenshot", { browserId: 123 }).ok, false);
});

test("a disconnect releases ownership only after its in-flight command settles", async (t) => {
  const f = await fixture(t);
  const one = await f.create(a);
  const gate = { ...deferred(), started: deferred() };
  f.instances.get(one.browserId).gate = gate;
  const running = f.call(a, "browser_navigate", { browserId: one.browserId, url: "https://slow.test/" });
  await gate.started.promise;
  f.workspace.agentDisconnected(a);
  assert.equal((await f.call(b, "browser_activate_window", { browserId: one.browserId })).error.code, "BROWSER_IN_USE");
  gate.resolve(); await running;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.call(b, "browser_activate_window", { browserId: one.browserId })).ok, true);
});

test("settings migrate a legacy Browser and persist independent card bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctty-browser-layout-"));
  const store = new SettingsStore(root, "en");
  const bounds = { position: { x: 30, y: 60 }, size: { width: 920, height: 620 } };
  await writeFile(store.filePath, JSON.stringify({ browserCanvas: bounds }));
  const legacy = await store.load();
  assert.deepEqual(legacy.browserCanvases, [{ id: "default", ...bounds }]);
  const second = { id: "second", position: { x: 1100, y: 80 }, size: { width: 800, height: 500 } };
  await store.update({ ...browserCanvasPatch([...legacy.browserCanvases, second]), locale: "en" });
  const reopened = new SettingsStore(root, "en");
  const restored = await reopened.load();
  assert.deepEqual(restored.browserCanvases, [...legacy.browserCanvases, second]);
  const filtered = await reopened.update({ browserCanvases: [second, { ...second }, { ...second, id: "../invalid" }] });
  assert.deepEqual(filtered.browserCanvases, [second]);
  await reopened.update(browserCanvasPatch([second]));
  const final = await new SettingsStore(root, "en").load();
  assert.equal(final.browserCanvas, null);
  assert.deepEqual(final.browserCanvases, [second]);
});
