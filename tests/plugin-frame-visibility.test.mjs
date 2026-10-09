import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { PluginManager } from "../src/main/services/PluginManager.ts";
import { pluginVisibilityMessage } from "../src/shared/pluginVisibility.ts";

// A canvas plugin is a document in an iframe; hiding its card (summary, HOME editing, off-screen) must stop
// its timers and animations without destroying it. The host posts a visibility message; the input bridge
// the host injects at the top of every plugin page turns it into page-visibility semantics. This runs the
// bridge the protocol really serves, plus a plugin with an animation loop and a 16 ms interval, in a
// sandboxed context on a fake clock, and counts how often the plugin's code runs.

/** A minimal frame: a document with native page visibility, timers and frames on a fake clock. */
function fakeFrame() {
  let now = 1_000_000;
  let nextHandle = 1;
  const tasks = new Map();
  const schedule = (at, callback) => {
    const handle = nextHandle++;
    tasks.set(handle, { at, callback });
    return handle;
  };
  const listeners = new Map();
  const documentListeners = new Map();
  const parent = {};
  class Document {
    get visibilityState() { return "visible"; }
    get hidden() { return false; }
  }
  const document = Object.create(Document.prototype);
  document.addEventListener = (type, listener) => {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set());
    documentListeners.get(type).add(listener);
  };
  document.removeEventListener = (type, listener) => documentListeners.get(type)?.delete(listener);
  document.dispatchEvent = (event) => {
    for (const listener of documentListeners.get(event.type) ?? []) listener(event);
    return true;
  };
  const window = {
    Document,
    document,
    parent,
    Date: { now: () => now },
    Event: class { constructor(type) { this.type = type; } },
    Math,
    Number,
    Map,
    Object,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    setTimeout: (callback, delay = 0) => schedule(now + Math.max(0, Number(delay) || 0), callback),
    clearTimeout: (handle) => { tasks.delete(handle); },
    setInterval: () => { throw new Error("the bridge must implement intervals itself"); },
    clearInterval: (handle) => { tasks.delete(handle); },
    requestAnimationFrame: (callback) => schedule(Math.floor(now / 16) * 16 + 16, () => callback(now)),
    cancelAnimationFrame: (handle) => { tasks.delete(handle); }
  };
  window.window = window;
  window.self = window;
  const context = vm.createContext(window);
  return {
    context,
    run: (source) => vm.runInContext(source, context),
    parent,
    post: (data) => { for (const listener of listeners.get("message") ?? []) listener({ source: parent, data }); },
    postFrom: (source, data) => { for (const listener of listeners.get("message") ?? []) listener({ source, data }); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [handle, task] of tasks) if (task.at <= end && (!due || task.at < due[1].at)) due = [handle, task];
        if (!due) break;
        tasks.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = end;
    },
    get pendingTasks() { return tasks.size; }
  };
}

const PLUGIN = `
  globalThis.counts = { frames: 0, ticks: 0, timeouts: 0, visibility: [] };
  globalThis.state = { note: "draft kept across suspension" };
  const frame = () => { counts.frames += 1; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  setInterval(() => { counts.ticks += 1; }, 16);
  const chain = () => { counts.timeouts += 1; setTimeout(chain, 50); };
  setTimeout(chain, 50);
  document.addEventListener("visibilitychange", () => counts.visibility.push(document.visibilityState));
`;

async function servedBridge(t) {
  const userData = await mkdtemp(join(tmpdir(), "canvastty-plugin-visibility-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const manager = new PluginManager(userData, async () => undefined);
  const response = await manager.protocolResponse("canvastty-plugin://host/input-bridge.js");
  assert.equal(response.status, 200);
  return response.text();
}

async function pluginFrame(t) {
  const frame = fakeFrame();
  frame.run(await servedBridge(t));
  frame.run(PLUGIN);
  const counts = () => ({ ...frame.run("counts"), visibility: [...frame.run("counts.visibility")] });
  return { frame, counts };
}

test("hidden: animation frames stop and timers drop to one wake-up a second; shown: they resume", async (t) => {
  const { frame, counts } = await pluginFrame(t);
  frame.advance(2_000);
  const visible = counts();
  assert.ok(visible.frames >= 120, `~60 frames a second while visible (${visible.frames})`);
  assert.ok(visible.ticks >= 120, `the 16 ms interval runs at its rate while visible (${visible.ticks})`);
  assert.ok(visible.timeouts >= 38, `the 50 ms timeout chain runs while visible (${visible.timeouts})`);

  frame.post(pluginVisibilityMessage(false));
  assert.equal(frame.run("document.visibilityState"), "hidden");
  assert.equal(frame.run("document.hidden"), true);
  frame.advance(10_000);
  const hidden = counts();
  assert.equal(hidden.frames - visible.frames, 0, "no animation frame runs while hidden");
  assert.ok(hidden.ticks - visible.ticks <= 11, `interval capped at 1/s while hidden (${hidden.ticks - visible.ticks} in 10 s)`);
  assert.ok(hidden.timeouts - visible.timeouts <= 11, `timeout chain capped at 1/s (${hidden.timeouts - visible.timeouts} in 10 s)`);
  assert.deepEqual(hidden.visibility, ["hidden"], "the plugin observed visibilitychange");

  frame.post(pluginVisibilityMessage(true));
  assert.equal(frame.run("document.visibilityState"), "visible");
  frame.advance(1_000);
  const shown = counts();
  assert.ok(shown.frames - hidden.frames >= 55, "animation frames resume at once");
  assert.ok(shown.ticks - hidden.ticks >= 55, "the interval resumes its own rate");
  assert.deepEqual(shown.visibility, ["hidden", "visible"]);
  assert.equal(frame.run("state.note"), "draft kept across suspension", "the document and its state survived");
});

test("clearing timers and frames works in every state, and repeated messages change nothing", async (t) => {
  const frame = fakeFrame();
  frame.run(await servedBridge(t));
  frame.run(`
    globalThis.fired = 0;
    const interval = setInterval(() => { fired += 1; }, 16);
    const frameId = requestAnimationFrame(() => { fired += 100; });
    globalThis.stop = () => { clearInterval(interval); cancelAnimationFrame(frameId); };
    document.addEventListener("visibilitychange", () => { globalThis.changes = (globalThis.changes || 0) + 1; });
  `);
  frame.post(pluginVisibilityMessage(false));
  frame.post(pluginVisibilityMessage(false));
  frame.run("stop()");
  frame.advance(5_000);
  frame.post(pluginVisibilityMessage(true));
  frame.post(pluginVisibilityMessage(true));
  frame.advance(5_000);
  assert.equal(frame.run("fired"), 0, "a cleared interval and a cancelled frame never run");
  assert.equal(frame.run("changes"), 2, "one visibilitychange per real change");
  assert.equal(frame.pendingTasks, 0, "nothing stays scheduled");
});

test("only the parent window can suspend a frame", async (t) => {
  const frame = fakeFrame();
  frame.run(await servedBridge(t));
  frame.run(`
    globalThis.frames = 0;
    const loop = () => { frames += 1; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  frame.postFrom({}, pluginVisibilityMessage(false));
  frame.postFrom(frame.context, pluginVisibilityMessage(false));
  frame.postFrom(frame.parent, { ...pluginVisibilityMessage(false), source: "canvastty-plugin" });
  assert.equal(frame.run("document.visibilityState"), "visible");
  frame.advance(1_000);
  assert.ok(frame.run("frames") >= 55, "frames keep running");
});

// The card side: PluginCanvasCard derives the frame's lifecycle from HOME editing, summary zoom, the
// camera (off-screen) and the window; rendered against a minimal React stand-in, the PluginFrame it
// renders is suspended exactly when nobody can see the card.
const { importWithFakeReact } = await import("./helpers/fake-react.mjs");
const { PluginCanvasCard, __render, __flush, __unmount, __reset } = await importWithFakeReact(
  "src/renderer/src/features/plugins/PluginCanvasCard.tsx",
  "PluginCanvasCard"
);

function findElement(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (Array.isArray(tree)) {
    for (const child of tree) { const found = findElement(child, predicate); if (found) return found; }
    return null;
  }
  if (predicate(tree)) return tree;
  return findElement(tree.props?.children, predicate);
}

test("the card suspends its frame while HOME editing, zoomed to a summary, off-screen or minimized", async (t) => {
  const timers = [];
  let visibility = "visible";
  globalThis.window = {
    innerWidth: 1600, innerHeight: 1000,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeout: () => undefined,
    addEventListener() {}, removeEventListener() {}
  };
  globalThis.document = { get visibilityState() { return visibility; }, addEventListener() {}, removeEventListener() {} };
  t.after(() => { __unmount(); delete globalThis.window; delete globalThis.document; });

  let camera = { x: 0, y: 0, zoom: 1 };
  const cameraStore = { get: () => camera, set() {}, subscribe: () => () => undefined };
  const contribution = { id: "probe", kind: "canvas-app", title: "Probe", entry: "apps/probe.html", defaultSize: { width: 680, height: 440 } };
  const plugin = { manifest: { id: "com.example.probe", name: "Probe", permissions: [], contributions: [contribution] }, sourceUrl: "https://github.com/example/probe", selectedModules: [], enabled: true };
  const props = (overrides = {}) => ({
    instance: { id: "p1", pluginId: plugin.manifest.id, contributionId: "probe", title: "Probe", position: { x: 100, y: 100 }, size: { width: 680, height: 440 } },
    plugin, contribution, locale: "en", palette: "default", camera: cameraStore, stackIndex: 1, snapEnabled: false,
    sessions: [], limits: null, getSnapTargets: () => [], captureCanvasWheelOverWidgets: false,
    onActivate() {}, onBoundsChange() {}, onDispose() {}, onOpenLauncher() {}, onError() {},
    onWidgetFocus() {}, onWidgetHoverChange() {}, onCanvasWheel() {},
    ...overrides
  });
  const render = (overrides) => {
    const tree = __render(PluginCanvasCard, props(overrides));
    const frame = findElement(tree, (element) => element.props && "suspended" in element.props && "canvasInstanceId" in element.props);
    assert.ok(frame, "the card renders a PluginFrame");
    return { suspended: frame.props.suspended, lifecycle: tree.props["data-surface-lifecycle"] };
  };

  __reset();
  assert.deepEqual(render(), { suspended: false, lifecycle: "visible" });
  assert.deepEqual(render({ hidden: true }), { suspended: true, lifecycle: "suspended" }, "HOME editing");
  assert.deepEqual(render(), { suspended: false, lifecycle: "visible" });

  camera = { x: 0, y: 0, zoom: 0.3 };
  assert.deepEqual(render(), { suspended: true, lifecycle: "suspended" }, "summary zoom");
  assert.deepEqual(render({ plugin: { ...plugin, sourceUrl: "mascot:fixture-project" } }),
    { suspended: false, lifecycle: "visible" }, "a mascot remains visible at summary zoom");

  camera = { x: -5000, y: 0, zoom: 1 };
  assert.deepEqual(render(), { suspended: false, lifecycle: "visible" }, "a pan across is not a suspension yet");
  const offscreenTimer = timers.at(-1);
  assert.ok(offscreenTimer.ms > 0);
  offscreenTimer.callback();
  __flush();
  assert.deepEqual(render(), { suspended: true, lifecycle: "suspended" }, "off-screen after the delay");
  camera = { x: 0, y: 0, zoom: 1 };
  __render(PluginCanvasCard, props());
  __flush();
  assert.deepEqual(render(), { suspended: false, lifecycle: "visible" }, "back on screen at once");

  visibility = "hidden";
  assert.deepEqual(render(), { suspended: true, lifecycle: "suspended" }, "minimized window");
});
