import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BrowserAutomationService } from "../src/main/services/browser/BrowserAutomationService.ts";
import { BrowserCore } from "../src/main/services/browser/BrowserCore.ts";
import { formatToolResult } from "../src/agent-browser/mcp-helper.mjs";

function fixture(t) {
  const state = { width: 800, height: 600, nodes: true, emptyImage: false, emptyEncoding: false, evaluations: [] };
  let attached = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach() { attached = true; }, detach() { attached = false; }, isAttached() { return attached; },
    async sendCommand(method, params) {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: state.width, clientHeight: state.height } };
      if (method === "Accessibility.getFullAXTree") return { nodes: state.nodes ? [{
        backendDOMNodeId: 41, frameId: "main", role: { value: "button" }, name: { value: "Create fork" }
      }] : [] };
      if (method === "DOM.getBoxModel") return { model: { border: [20, 20, 120, 20, 120, 50, 20, 50] } };
      if (method === "DOM.describeNode") return { node: { nodeName: "BUTTON", attributes: [] } };
      if (method === "DOM.getFlattenedDocument") return { nodes: [{ backendNodeId: 1, nodeName: "HTML", attributes: [] }] };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate") state.evaluations.push(params);
      return {};
    }
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=", "base64");
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi, isDestroyed: () => false, isLoading: () => false,
    getURL: () => "https://fixture.test/", getTitle: () => "Fixture",
    async capturePage() {
      return {
        isEmpty: () => state.emptyImage,
        getSize: () => state.emptyImage ? { width: 0, height: 0 } : { width: 1, height: 1 },
        toPNG: () => state.emptyImage || state.emptyEncoding ? Buffer.alloc(0) : png
      };
    }
  });
  const automation = new BrowserAutomationService();
  t.after(() => automation.unregister("tab"));
  return { state, contents, automation };
}

test("observe distinguishes an unavailable viewport from a page without controls and recovers", async (t) => {
  const { state, contents, automation } = fixture(t);
  await automation.register("tab", contents, 1);
  for (const [width, height] of [[0, 0], [0, 600], [800, 0]]) {
    Object.assign(state, { width, height });
    await assert.rejects(automation.observe("tab", 1), (error) => error.code === "VIEWPORT_UNAVAILABLE" && error.retryable);
  }
  Object.assign(state, { width: 800, height: 600 });
  assert.equal((await automation.observe("tab", 1)).elements[0].name, "Create fork");
  state.nodes = false;
  assert.deepEqual((await automation.observe("tab", 1)).elements, []);
});

test("empty screenshots fail, restore masks and recover on the same tab", async (t) => {
  const { state, contents, automation } = fixture(t);
  await automation.register("tab", contents, 1);
  state.emptyImage = true;
  await assert.rejects(automation.screenshot("tab", 1), (error) => error.code === "VIEWPORT_UNAVAILABLE" && error.retryable);
  assert.equal(state.evaluations.length, 2, "mask and restore both execute on the failed capture");
  state.emptyImage = false;
  state.emptyEncoding = true;
  await assert.rejects(automation.screenshot("tab", 1), (error) => error.code === "VIEWPORT_UNAVAILABLE");
  state.emptyEncoding = false;
  const shot = await automation.screenshot("tab", 1);
  assert.ok(shot.base64.length > 0);
  assert.equal(shot.width, 1);
  assert.equal(shot.height, 1);
});

test("viewport errors reach the agent through BrowserCore and MCP without an invalid image", async (t) => {
  const { state, contents, automation } = fixture(t);
  await automation.register("tab", contents, 1);
  Object.assign(state, { width: 0, height: 0, emptyImage: true });
  const tab = { id: "tab", documentRevision: 1, url: "https://fixture.test/", status: "ready" };
  const host = {
    getSnapshot: () => ({ activeTabId: "tab", tabs: [tab] }), getTab: () => tab,
    ensureRuntime: async () => {}, touchActor() {}, pendingDialog: () => null
  };
  const audit = { append: async (input) => ({ ...input, hash: "hash", previousHash: null, sequence: 1, version: 1 }) };
  const core = new BrowserCore({ host, automation, policy: {}, audit });
  const actor = { kind: "agent", agentId: "agent", provider: "codex", terminalSessionId: "terminal", connectionId: "connection", cwd: "/tmp" };
  for (const type of ["browser_observe", "browser_screenshot"]) {
    const result = await core.execute(actor, { type, tabId: "tab", requestId: type });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "VIEWPORT_UNAVAILABLE");
    assert.match(result.error.message, /Browser card.*view.*retry/i);
    const tool = formatToolResult(result);
    assert.equal(tool.isError, true);
    assert.ok(tool.content.every((item) => item.type === "text"));
    assert.match(tool.content[0].text, /VIEWPORT_UNAVAILABLE/);
  }
});
