import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BrowserAutomationService } from "../src/main/services/browser/BrowserAutomationService.ts";
import { BrowserCore } from "../src/main/services/browser/BrowserCore.ts";
import { browserKeyChord, browserTextMode } from "../src/main/services/browser/BrowserInput.ts";
import { TOOL_DEFINITIONS } from "../src/agent-browser/tool-catalog.mjs";

function fixture() {
  const commands = [];
  const debuggerApi = new EventEmitter();
  debuggerApi.isAttached = () => true;
  debuggerApi.attach = () => {};
  debuggerApi.detach = () => {};
  debuggerApi.sendCommand = async (method, params) => {
    commands.push({ method, params });
    if (method === "DOM.resolveNode") return { object: { objectId: "target" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: true } };
    return {};
  };
  const contents = new EventEmitter();
  contents.debugger = debuggerApi;
  contents.isDestroyed = () => false;
  contents.getURL = () => "https://fixture.test/";
  contents.getTitle = () => "Fixture";
  const automation = new BrowserAutomationService();
  return { automation, contents, commands };
}

async function registered() {
  const f = fixture();
  await f.automation.register("tab", f.contents, 3);
  const session = f.automation.sessions.get("tab");
  session.refs.set("editor", { value: { ref: "editor", tabId: "tab", documentRevision: 3, frameId: "main", backendNodeId: 7 }, bounds: { x: 0, y: 0, width: 100, height: 40 } });
  f.automation.refPoint = async (tabId, revision) => {
    if (revision !== 3) throw Object.assign(new Error("stale"), { code: "STALE_REF" });
    return { session, entry: session.refs.get("editor"), point: { x: 2, y: 3 } };
  };
  f.commands.length = 0;
  return f;
}

test("browser chords accept aliases, combine modifiers, and reject malformed or unsupported keys", () => {
  assert.deepEqual(browserKeyChord("Ctrl+A"), browserKeyChord("Control+A"));
  assert.deepEqual(browserKeyChord("Ctrl+Shift+ArrowLeft"), { key: "ArrowLeft", code: "ArrowLeft", modifiers: 10, windowsVirtualKeyCode: 37 });
  assert.equal(browserKeyChord("Meta+A").modifiers, 4);
  assert.equal(browserKeyChord("Alt+Enter").modifiers, 1);
  assert.equal(browserKeyChord("Shift+a").key, "A");
  assert.equal(browserKeyChord("Space").key, " ");
  assert.equal(browserKeyChord("A").key, "A");
  for (const key of [undefined, "", "Ctrl+", "Ctrl+Control+A", "Super+A", "Ctrl+F12", "a+b", "Ctrl++A", "Ctrl+A+B", "constructor+A", "toString+A"]) {
    assert.throws(() => browserKeyChord(key), error => error.code === "INVALID_INPUT");
  }
  assert.equal(browserTextMode(undefined), "legacy");
  for (const mode of ["insert", "replace"]) assert.equal(browserTextMode(mode), mode);
  assert.throws(() => browserTextMode("legacy"), error => error.code === "INVALID_INPUT");
});

test("BrowserCore forwards replacement modes and returns sanitized actionable input errors", async () => {
  const calls = [];
  const host = {
    getSnapshot: () => ({ activeTabId: "tab" }),
    getTab: () => ({ id: "tab", url: "https://fixture.test/", documentRevision: 3, status: "ready" }),
    ensureRuntime: async () => {}, pendingDialog: () => null, touchActor: () => {}
  };
  const automation = { type: async (...args) => { calls.push(args); return { point: { x: 1, y: 2 }, typed: true }; },
    press: async (_tab, _revision, _ref, key) => { browserKeyChord(key); } };
  const audit = { append: async input => ({ ...input, hash: "hash", previousHash: null, sequence: 1, version: 1 }) };
  const core = new BrowserCore({ host, automation, policy: {}, audit });
  const actor = { kind: "agent", agentId: "editor", provider: "codex", terminalSessionId: "terminal", connectionId: "connection", cwd: "/tmp" };
  try {
    const result = await core.execute(actor, { type: "browser_type", requestId: "replace", ref: "ref_editor", text: "SELECT 1", mode: "replace" });
    assert.equal(result.ok, true);
    assert.equal(calls[0][5], "replace");
    const invalid = await core.execute(actor, { type: "browser_type", requestId: "invalid-mode", ref: "ref_editor", text: "private-input", mode: "bad" });
    assert.equal(invalid.error.code, "INVALID_INPUT");
    assert.match(invalid.error.message, /key chord.*editable target/);
    assert.equal(JSON.stringify(invalid).includes("private-input"), false);
    assert.equal(calls.length, 1);
    const chord = await core.execute(actor, { type: "browser_press", requestId: "invalid-chord", ref: "ref_editor", key: "Ctrl+" });
    assert.equal(chord.error.code, "INVALID_INPUT");
  } finally { await core.shutdown(); }
});

test("MCP schemas expose additive text modes and chord documentation", () => {
  const type = TOOL_DEFINITIONS.find(tool => tool.name === "browser_type");
  assert.deepEqual(type.inputSchema.properties.mode.enum, ["insert", "replace"]);
  assert.equal(type.inputSchema.required.includes("mode"), false);
  assert.match(TOOL_DEFINITIONS.find(tool => tool.name === "browser_press").description, /Ctrl\+Enter/);
});

test("press dispatches the chord and releases the key after a failed keydown", async () => {
  const f = await registered();
  try {
    await f.automation.press("tab", 3, "editor", "Ctrl+Enter");
    const events = f.commands.filter(c => c.method === "Input.dispatchKeyEvent");
    assert.deepEqual(events.map(e => [e.params.type, e.params.key, e.params.modifiers]), [["keyDown", "Enter", 2], ["keyUp", "Enter", 2]]);
    const original = f.contents.debugger.sendCommand;
    f.contents.debugger.sendCommand = async (method, params) => {
      const result = await original(method, params);
      if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") throw Error("keydown failed");
      return result;
    };
    await assert.rejects(f.automation.press("tab", 3, "editor", "Ctrl+A"), e => e.cause?.message === "keydown failed");
    assert.equal(f.commands.at(-1).params.type, "keyUp");
  } finally { f.automation.unregister("tab"); }
});

test("invalid and stale input fails before keyboard or text side effects", async () => {
  const f = await registered();
  try {
    await assert.rejects(f.automation.press("tab", 3, "editor", "Ctrl+"), e => e.code === "INVALID_INPUT");
    await assert.rejects(f.automation.press("tab", 2, "editor", "Ctrl+A"), e => e.code === "STALE_REF");
    await assert.rejects(f.automation.type("tab", 2, "editor", "new", undefined, "replace"), e => e.code === "STALE_REF");
    await assert.rejects(f.automation.type("tab", 3, "editor", "new", undefined, "bad"), e => e.code === "INVALID_INPUT");
    assert.equal(f.commands.some(c => c.method.startsWith("Input.")), false);
  } finally { f.automation.unregister("tab"); }
});

test("text replacement is explicit, bounded, and uses native editing input", async () => {
  const f = await registered();
  try {
    for (const mode of [undefined, "insert", "replace"]) {
      await f.automation.type("tab", 3, "editor", "SELECT 1;\nSELECT 2;", undefined, mode);
      const select = f.commands.findLast(c => c.method === "Runtime.callFunctionOn" && c.params.arguments);
      assert.equal(select.params.arguments[0].value, mode ?? "legacy");
      assert.equal(f.commands.at(-1).method, "Input.insertText");
    }
    await f.automation.type("tab", 3, "editor", "", undefined, "replace");
    assert.equal(f.commands.at(-1).params.key, "Backspace");
    const original = f.contents.debugger.sendCommand;
    f.contents.debugger.sendCommand = async (method, params) => method === "Runtime.callFunctionOn" ? { result: { value: false } } : original(method, params);
    f.commands.length = 0;
    await assert.rejects(f.automation.type("tab", 3, "editor", "x", undefined, "replace"), e => e.code === "INVALID_INPUT");
    assert.equal(f.commands.some(c => c.method.startsWith("Input.")), false);
  } finally { f.automation.unregister("tab"); }
});

test("replacement stops if a select-all handler redirects focus", async () => {
  const f = await registered();
  try {
    const original = f.contents.debugger.sendCommand;
    f.contents.debugger.sendCommand = async (method, params) => {
      if (method === "Runtime.callFunctionOn" && !params.arguments) return { result: { value: false } };
      return original(method, params);
    };
    await assert.rejects(f.automation.type("tab", 3, "editor", "private text", undefined, "replace"), e => e.code === "INVALID_INPUT");
    assert.equal(f.commands.some(c => c.method === "Input.insertText"), false);
    assert.deepEqual(f.commands.filter(c => c.method === "Input.dispatchKeyEvent").map(c => c.params.type), ["keyDown", "keyUp"]);
  } finally { f.automation.unregister("tab"); }
});
