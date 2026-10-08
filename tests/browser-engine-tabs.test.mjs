// Plugin-contributed browser engines (browser:engine) end to end without Electron: BrowserCore and
// BrowserAutomationService as the app runs them, BrowserEngineTabs with a fake engine behind a real loopback CDP
// WebSocket, and fake Chromium tabs standing in for BrowserService's WebContents.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";

import { BrowserAutomationService } from "../src/main/services/browser/BrowserAutomationService.ts";
import { BrowserCore } from "../src/main/services/browser/BrowserCore.ts";
import { BrowserEngineTabs, hostOf } from "../src/main/services/browser/BrowserEngineTabs.ts";
import { assertLoopbackCdpUrl } from "../src/main/services/browser/CdpTabDriver.ts";
import { isThinText } from "../src/main/services/browser/BrowserAutomationService.ts";
import { startFakeCdpEngine } from "./fixtures/fake-cdp-engine.mjs";

const DOCS = "https://docs.example.test/guide";
const WALL = "https://walled.example.test/package";
const THIN = "https://thin.example.test/app";
const ODD = "https://odd.example.test/";
const CLICKS = "https://docs.example.test/clicks";
const NO_RESOLVE = "https://noresolve.example.test/";
const NO_SHOT = "https://noshot.example.test/";

const longText = (label) => Array.from({ length: 12 }, (_, index) => `${label} paragraph ${index} with enough words to read.`);

const PAGES = {
  [DOCS]: { title: "Guide", texts: longText("Guide") },
  [CLICKS]: {
    title: "Clicks",
    texts: longText("Clicks"),
    buttons: [{ name: "Next page", id: 501, opens: DOCS }, { name: "Stay", id: 502 }]
  },
  [WALL]: { title: "Just a moment...", texts: ["Performing security verification"], status: 403, challenge: true },
  [THIN]: { title: "App", texts: ["Loading"], htmlChars: 60_000 },
  [ODD]: { title: "Odd", texts: longText("Odd"), unsupported: ["Accessibility.getFullAXTree"] },
  [NO_SHOT]: { title: "No shot", texts: longText("Shot") },
  [NO_RESOLVE]: { title: "No resolve", texts: longText("Resolve"), buttons: [{ name: "Go", id: 601 }], unsupported: ["DOM.resolveNode"] }
};

class FakeDebugger extends EventEmitter {
  attached = false;
  constructor(page) { super(); this.page = page; }
  attach() { this.attached = true; }
  detach() { this.attached = false; }
  isAttached() { return this.attached; }
  async sendCommand(method) {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "chromium-frame" } } };
    if (method === "Accessibility.getFullAXTree") {
      return { nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Chromium" }, backendDOMNodeId: 1 },
        { nodeId: "2", role: { value: "StaticText" }, name: { value: `Chromium copy of ${this.page.url}` }, backendDOMNodeId: 2 }
      ] };
    }
    if (method === "DOM.getFlattenedDocument") return { nodes: [{ nodeName: "HTML", backendNodeId: 1 }] };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
    return {};
  }
}

class FakeWebContents extends EventEmitter {
  constructor(url) { super(); this.page = { url }; this.debugger = new FakeDebugger(this.page); }
  isDestroyed() { return false; }
  getURL() { return this.page.url; }
  getTitle() { return "Chromium"; }
  isLoading() { return false; }
  async capturePage() {
    // A hidden page Chromium cannot paint answers an empty picture.
    if (this.page.url.includes("noshot")) return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) };
    return { isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), toPNG: () => Buffer.from("fake-png") };
  }
}

const agent = (id = "one") => ({
  kind: "agent", agentId: `agent-${id}`, provider: "codex", terminalSessionId: `terminal-${id}`,
  connectionId: `connection-${id}`, cwd: "/tmp"
});
const person = { kind: "human", connectionId: "renderer" };

async function harness(t, { providers } = {}) {
  const engine = await startFakeCdpEngine({ pages: PAGES });
  t.after(() => engine.close());
  const lent = [];
  const automation = new BrowserAutomationService(undefined, {
    captureSurface: async (tabId) => { lent.push(`lend:${tabId}`); return () => lent.push(`return:${tabId}`); }
  });
  const chromium = new Map();
  const openRequests = [];
  const closeNotices = [];
  let activeTabId = null;
  const providerList = providers ?? [{ pluginId: "canvastty-lightpanda", pluginName: "Lightpanda", serviceId: "engine", engineId: "fakepanda", title: "Fake", layout: false }];
  const createChromium = async (id, url, revision) => {
    const contents = new FakeWebContents(url);
    chromium.set(id, { id, url, revision, contents });
    await automation.register(id, contents, revision);
  };
  const engines = new BrowserEngineTabs({
    automation,
    providers: () => providerList,
    openEngineTab: async (provider, tabId) => {
      openRequests.push({ pluginId: provider.pluginId, params: { engineId: provider.engineId, tabId } });
      return { webSocketUrl: engine.url };
    },
    closeEngineTab: (_provider, tabId) => closeNotices.push(tabId),
    openChromiumTab: (id, url, revision) => createChromium(id, url, revision),
    changed: () => {}
  });
  const snapshot = () => ({
    tabs: [
      ...[...chromium.values()].map((tab) => ({ id: tab.id, url: tab.url, title: "Chromium", loading: false, canGoBack: false, canGoForward: false, documentRevision: tab.revision, status: "ready", favicon: null, agents: [], crashState: null })),
      ...engines.snapshots([])
    ],
    activeTabId, visible: true, agents: [], downloads: [], pendingDialog: null
  });
  const newChromiumTab = async (url) => {
    const id = randomUUID();
    await createChromium(id, url, 0);
    activeTabId = id;
    return snapshot();
  };
  const host = {
    getSnapshot: snapshot,
    getTab: (id) => engines.coreTab(id) ?? (chromium.has(id) ? { id, url: chromium.get(id).url, documentRevision: chromium.get(id).revision, status: "ready" } : null),
    ensureRuntime: async () => {},
    newTab: newChromiumTab,
    openTab: async (url, options) => {
      const choice = engines.choose({ engine: options.engine, actor: options.actor, url });
      if (choice.provider) {
        const tabId = await engines.open(choice.provider, url);
        return { snapshot: snapshot(), tabId, engine: choice.provider.engineId };
      }
      const opened = await newChromiumTab(url);
      return { snapshot: opened, tabId: opened.activeTabId, engine: "chromium", ...(choice.notice ? { notice: choice.notice } : {}) };
    },
    tabEngine: (id) => engines.engineOf(id) ?? (chromium.has(id) ? "chromium" : null),
    moveTabToChromium: (id, reason) => engines.moveToChromium(id, reason, { waitForLoad: reason !== "revealed" }),
    closeTab: async (id) => {
      if (engines.has(id)) engines.close(id);
      else { automation.unregister(id); chromium.delete(id); }
      return snapshot();
    },
    activateTab: async (id) => {
      if (engines.has(id)) await engines.moveToChromium(id, "revealed", { waitForLoad: false });
      activeTabId = id;
      return snapshot();
    },
    navigateTab: async (id, url) => {
      if (engines.has(id)) await engines.navigate(id, url);
      return snapshot();
    },
    back: async (id) => { if (engines.has(id)) await engines.history(id, -1); return snapshot(); },
    forward: async (id) => { if (engines.has(id)) await engines.history(id, 1); return snapshot(); },
    reload: async (id) => { if (engines.has(id)) await engines.reload(id); return snapshot(); },
    pendingDialog: () => null,
    waitForDownload: async () => { throw new Error("no downloads"); },
    touchActor: () => {},
    heartbeatActor: () => {},
    disconnectActor: () => {}
  };
  const audit = { append: async (input) => ({ ...input, hash: "hash", previousHash: null, sequence: 1, version: 1 }) };
  const core = new BrowserCore({ host, automation, policy: { assertNavigationUrl: (url) => url }, audit });
  t.after(() => engines.dispose());
  let request = 0;
  const run = (actor, type, args = {}) => core.execute(actor, { type, requestId: `r${++request}`, ...args });
  const ready = async (tabId, { revisionAfter = null } = {}) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const tab = host.getTab(tabId);
      if (tab?.status === "ready" && (revisionAfter === null || tab.documentRevision > revisionAfter)) return tab;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`tab never became ready after revision ${revisionAfter}`);
  };
  // A person's first tab is active in Chromium, as when the Browser card is open.
  await newChromiumTab("https://person.example.test/");
  const personTab = activeTabId;
  return { engine, engines, host, core, run, ready, chromium, openRequests, closeNotices, lent, personTab, active: () => activeTabId };
}

const cdpMethods = (engine) => engine.calls.map((call) => call.method);

test("an agent's new tab goes to the installed engine in the background; the person's active tab stays", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: DOCS });
  assert.equal(opened.ok, true, JSON.stringify(opened.error));
  assert.notEqual(opened.tabId, h.personTab);
  assert.equal(h.active(), h.personTab, "the engine tab is not shown");
  assert.equal(opened.data.tabs.find((tab) => tab.id === opened.tabId).engine, "fakepanda");
  // A command right after opening races the page's first commit: that commit is the core's own navigation.
  const waited = await h.run(agent(), "browser_wait_for", { tabId: opened.tabId, condition: "load", timeoutMs: 5_000 });
  assert.equal(waited.ok, true, JSON.stringify(waited.error));
  assert.deepEqual(h.openRequests, [{ pluginId: "canvastty-lightpanda", params: { engineId: "fakepanda", tabId: opened.tabId } }]);
  await h.ready(opened.tabId);
  // No tab id: the agent's commands go to the tab it opened, not to the person's active tab.
  const read = await h.run(agent(), "browser_read_page", {});
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.equal(read.tabId, opened.tabId);
  assert.match(read.data.text, /Guide paragraph 0/);
  assert.equal(read.notice, undefined);
  assert.deepEqual(cdpMethods(h.engine).slice(0, 2), ["Target.createTarget", "Target.attachToTarget"]);
});

test("the person's tabs and engine: chromium never use the engine; a missing engine opens Chromium with a notice", async (t) => {
  const h = await harness(t);
  const personal = await h.run(person, "browser_new_tab", { url: DOCS });
  assert.equal(personal.ok, true);
  assert.equal(personal.tabId, h.active());
  assert.equal(personal.data.tabs.find((tab) => tab.id === personal.tabId).engine, undefined);
  const forced = await h.run(agent(), "browser_new_tab", { url: DOCS, engine: "chromium" });
  assert.equal(forced.ok, true);
  assert.equal(forced.tabId, h.active(), "a Chromium tab opens visible, as before");
  const missing = await h.run(agent(), "browser_new_tab", { url: DOCS, engine: "otherpanda" });
  assert.equal(missing.ok, true);
  assert.match(missing.notice, /not installed or not running/);
  assert.equal(h.openRequests.length, 0, "the engine was never asked");
  assert.equal(h.engine.connections, 0);
  const invalid = await h.run(agent(), "browser_new_tab", { url: DOCS, engine: "Bad Engine!" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "PERMISSION_DENIED");
});

test("engines without layout: observe skips the fake geometry and clicks go through element.click()", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: CLICKS });
  await h.ready(opened.tabId);
  const observed = await h.run(agent(), "browser_observe", { tabId: opened.tabId });
  assert.equal(observed.ok, true, JSON.stringify(observed.error));
  assert.deepEqual(observed.data.elements.map((element) => element.name), ["Next page", "Stay"]);
  assert.ok(observed.data.elements.every((element) => element.bounds === null));
  const before = observed.data.documentRevision;
  const clicked = await h.run(agent(), "browser_click", { tabId: opened.tabId, ref: observed.data.elements[0].ref.ref });
  assert.equal(clicked.ok, true, JSON.stringify(clicked.error));
  assert.deepEqual(h.engine.clicks, [501]);
  const methods = cdpMethods(h.engine);
  assert.equal(methods.includes("Input.dispatchMouseEvent"), false, "no coordinate clicks");
  assert.equal(methods.includes("DOM.getBoxModel"), false, "no box models asked for");
  const navigated = await h.ready(opened.tabId, { revisionAfter: before });
  assert.ok(navigated.documentRevision > before, "the click navigated: a new revision");
  const hovered = await h.run(agent(), "browser_observe", { tabId: opened.tabId });
  assert.equal(hovered.ok, true);
});

test("a screenshot moves the tab to Chromium under the same id and tells the agent", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: DOCS });
  const { documentRevision } = await h.ready(opened.tabId);
  const shot = await h.run(agent(), "browser_screenshot", { tabId: opened.tabId });
  assert.equal(shot.ok, true, JSON.stringify(shot.error));
  assert.equal(shot.tabId, opened.tabId);
  assert.match(shot.notice, /moved to Chromium \(screenshots need Chromium\)/);
  assert.equal(h.host.tabEngine(opened.tabId), "chromium");
  assert.ok(h.host.getTab(opened.tabId).documentRevision > documentRevision);
  assert.equal(h.chromium.get(opened.tabId).url, DOCS, "Chromium opened the same URL");
  assert.deepEqual(h.closeNotices, [opened.tabId], "the plugin was told the engine tab closed");
  assert.equal(h.active(), h.personTab, "the moved tab stays in the background");
  assert.deepEqual(h.engines.rememberedSitesList(), [], "a screenshot says nothing about the site");
  assert.deepEqual(h.lent, [`lend:${opened.tabId}`, `return:${opened.tabId}`], "the host lent a surface for the capture and took it back");
});

test("a screenshot Chromium cannot take still says the tab moved", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: NO_SHOT });
  await h.ready(opened.tabId);
  const shot = await h.run(agent(), "browser_screenshot", { tabId: opened.tabId });
  assert.equal(shot.ok, false);
  assert.equal(shot.error.code, "VIEWPORT_UNAVAILABLE");
  assert.equal(shot.error.details.movedToChromium, true);
  assert.equal(h.host.tabEngine(opened.tabId), "chromium");
});

test("a bot wall falls back, answers from Chromium, and the site goes straight to Chromium afterwards", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: WALL });
  await h.ready(opened.tabId);
  const read = await h.run(agent(), "browser_read_page", { tabId: opened.tabId });
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.match(read.notice, /bot check/);
  assert.match(read.data.text, /Chromium copy of https:\/\/walled\.example\.test\/package/);
  assert.deepEqual(h.engines.rememberedSitesList(), ["walled.example.test"]);
  const again = await h.run(agent("two"), "browser_new_tab", { url: WALL });
  assert.equal(h.host.tabEngine(again.tabId), "chromium");
  assert.equal(h.openRequests.length, 1, "the engine was not asked for the remembered site");
  const named = await h.run(agent("two"), "browser_new_tab", { url: `${WALL}?b`, engine: "fakepanda" });
  assert.match(named.notice, /needed Chromium earlier/);
});

test("text far too thin for the page's size falls back", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: THIN });
  await h.ready(opened.tabId);
  const read = await h.run(agent(), "browser_read_page", { tabId: opened.tabId });
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.match(read.notice, /too little text/);
  assert.equal(h.host.tabEngine(opened.tabId), "chromium");
  assert.equal(isThinText(50, 60_000), true);
  assert.equal(isThinText(1_400, 1_300), false, "a small page with its text is fine");
  assert.equal(isThinText(5_000, 300_000), false);
  assert.equal(isThinText(300, 400_000), true, "under 0.2 % of a big page");
});

test("an unsupported CDP method falls back; a ref-based action after a fallback is STALE_REF with movedToChromium", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: ODD });
  await h.ready(opened.tabId);
  const read = await h.run(agent(), "browser_read_page", { tabId: opened.tabId });
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.match(read.notice, /does not support this command/);
  assert.deepEqual(h.engines.rememberedSitesList(), ["odd.example.test"]);

  // The engine cannot resolve the element to click: the tab moves, and the old ref is not replayed on Chromium.
  const clicks = await h.run(agent(), "browser_new_tab", { url: NO_RESOLVE });
  await h.ready(clicks.tabId);
  const observed = await h.run(agent(), "browser_observe", { tabId: clicks.tabId });
  assert.equal(observed.ok, true, JSON.stringify(observed.error));
  const clicked = await h.run(agent(), "browser_click", { tabId: clicks.tabId, ref: observed.data.elements[0].ref.ref });
  assert.equal(clicked.ok, false);
  assert.equal(clicked.error.code, "STALE_REF");
  assert.equal(clicked.error.details.movedToChromium, true);
  assert.equal(h.host.tabEngine(clicks.tabId), "chromium");
  assert.deepEqual(h.engine.clicks, [], "nothing was clicked twice or blindly");
});

test("an engine crash moves its tabs to Chromium; reading continues there", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: DOCS });
  await h.ready(opened.tabId);
  h.engine.crash();
  for (let attempt = 0; attempt < 100 && h.host.tabEngine(opened.tabId) !== "chromium"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(h.host.tabEngine(opened.tabId), "chromium");
  const read = await h.run(agent(), "browser_read_page", { tabId: opened.tabId });
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.match(read.data.text, /Chromium copy of/);
});

test("the person revealing an engine tab moves it to Chromium and shows it", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: DOCS });
  await h.ready(opened.tabId);
  const shown = await h.run(person, "browser_activate_tab", { tabId: opened.tabId });
  assert.equal(shown.ok, true, JSON.stringify(shown.error));
  assert.equal(h.active(), opened.tabId);
  assert.equal(h.host.tabEngine(opened.tabId), "chromium");
  assert.equal(shown.data.tabs.find((tab) => tab.id === opened.tabId).engine, undefined);
});

test("no cookies or profile reach the engine: the plugin gets only the engine and tab id, the page no cookie calls", async (t) => {
  const h = await harness(t);
  const opened = await h.run(agent(), "browser_new_tab", { url: CLICKS });
  await h.ready(opened.tabId);
  const observed = await h.run(agent(), "browser_observe", { tabId: opened.tabId });
  await h.run(agent(), "browser_type", { tabId: opened.tabId, ref: observed.data.elements[1].ref.ref, text: "hello" });
  await h.run(agent(), "browser_navigate", { tabId: opened.tabId, url: DOCS });
  await h.run(agent(), "browser_back", { tabId: opened.tabId });
  await h.run(agent(), "browser_close_tab", { tabId: opened.tabId });
  assert.deepEqual(Object.keys(h.openRequests[0].params).sort(), ["engineId", "tabId"]);
  const touched = cdpMethods(h.engine).filter((method) => /cookie|^Storage\.|setExtraHTTPHeaders|BrowserContext/i.test(method));
  assert.deepEqual(touched, []);
  for (let attempt = 0; attempt < 100 && !cdpMethods(h.engine).includes("Target.closeTarget"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(cdpMethods(h.engine).includes("Target.closeTarget"), "closing the tab closes its page");
  assert.equal(h.host.getTab(opened.tabId), null);
});

test("engine endpoints must be loopback ws:// with a port; site keys ignore www", () => {
  assert.equal(assertLoopbackCdpUrl("ws://127.0.0.1:9222/"), "ws://127.0.0.1:9222/");
  assert.equal(assertLoopbackCdpUrl("ws://[::1]:9222/devtools"), "ws://[::1]:9222/devtools");
  for (const bad of ["ws://example.com:9222/", "wss://127.0.0.1:9222/", "ws://127.0.0.1/", "ws://user:pw@127.0.0.1:1/", "http://127.0.0.1:9222/", 42]) {
    assert.throws(() => assertLoopbackCdpUrl(bad), /endpoint/, String(bad));
  }
  assert.equal(hostOf("https://www.Example.test/a"), "example.test");
  assert.equal(hostOf("about:blank"), null);
});

test("an engine that fails to open a tab falls back to Chromium and is skipped by auto for a while", async (t) => {
  const engine = await startFakeCdpEngine({ pages: PAGES });
  t.after(() => engine.close());
  const automation = new BrowserAutomationService();
  let asked = 0;
  const engines = new BrowserEngineTabs({
    automation,
    providers: () => [{ pluginId: "p", pluginName: "P", serviceId: "s", engineId: "fakepanda", title: "Fake", layout: false }],
    openEngineTab: async () => { asked += 1; throw new Error("Lightpanda is not installed."); },
    closeEngineTab: () => {},
    openChromiumTab: async () => {},
    changed: () => {}
  });
  const choice = engines.choose({ actor: agent(), url: DOCS });
  assert.ok(choice.provider);
  await assert.rejects(engines.open(choice.provider, DOCS), /not installed/);
  assert.equal(engines.choose({ actor: agent(), url: DOCS }).provider, null);
  assert.equal(asked, 1);
  assert.equal(engines.choose({ actor: person, url: DOCS }).provider, null, "a person's tab never");
});

test("manifests: a service's browserEngine needs browser:engine; ids are checked, unique and never auto or chromium", async () => {
  const { validatePluginManifest } = await import("../src/main/services/PluginManager.ts");
  const manifest = (engine, permissions = ["browser:engine"], extra = []) => ({
    apiVersion: 2, id: "canvastty-lightpanda", name: "Lightpanda", version: "0.1.0", description: "Engine.",
    permissions, contributions: [],
    services: [{ id: "engine", title: "Engine", entry: "services/engine.mjs", browserEngine: engine }, ...extra]
  });
  const checked = validatePluginManifest(manifest({ id: "lightpanda", title: "Lightpanda", description: "Headless." }));
  assert.deepEqual(checked.services[0].browserEngine, { id: "lightpanda", title: "Lightpanda", description: "Headless.", layout: false });
  assert.equal(validatePluginManifest(manifest({ id: "lp", title: "LP", layout: true })).services[0].browserEngine.layout, true);
  assert.throws(() => validatePluginManifest(manifest({ id: "lightpanda", title: "Lightpanda" }, [])), /browser:engine/u);
  for (const id of ["auto", "chromium", "Light Panda", "-x", ""]) {
    assert.throws(() => validatePluginManifest(manifest({ id, title: "X" })), /engine id|browser engine/u, id);
  }
  assert.throws(() => validatePluginManifest(manifest({ id: "lp", title: "X", layout: "no" })), /layout/u);
  assert.throws(() => validatePluginManifest(manifest({ id: "lp", title: "X", cookies: true })), /cookies/u);
  assert.throws(() => validatePluginManifest(manifest({ id: "lp", title: "X" }, ["browser:engine"], [
    { id: "second", title: "Second", entry: "services/second.mjs", browserEngine: { id: "lp", title: "Y" } }
  ])), /unique/u);
});
