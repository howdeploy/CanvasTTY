import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCanvasGestureController } from "../src/main/services/browser/BrowserCanvasGestureController.ts";
import { BrowserCanvasPointerRouter } from "../src/main/services/browser/BrowserCanvasPointerRouter.ts";

function wheelInput(overrides = {}) {
  return {
    deltaX: 2,
    deltaY: 8,
    deltaMode: 0,
    viewportWidth: 800,
    viewportHeight: 600,
    ctrlKey: false,
    metaKey: false,
    screenX: 240,
    screenY: 280,
    topFrame: true,
    clientX: 140,
    clientY: 160,
    ...overrides
  };
}

function gestureHarness() {
  let now = 1_000;
  let focused = false;
  let captureMode = "off";
  let overrides = { wheelActive: false, navigationActive: false };
  let viewport = {
    x: 100,
    y: 100,
    width: 800,
    height: 600,
    surface: "native",
    showAgentPresence: false
  };
  const trace = [];
  const contents = {
    isDestroyed: () => false,
    capturePage: async () => { throw new Error("capture unavailable in unit test"); }
  };
  const sink = {
    preserve: () => {
      trace.push("sink:preserve");
      return true;
    },
    restore: () => {
      trace.push("sink:restore");
      return true;
    }
  };
  const tab = { id: "tab-1", view: { webContents: contents }, canvasSinkViewport: sink };
  const owner = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 100, y: 120, width: 1_200, height: 900 })
  };
  const controller = new BrowserCanvasGestureController({
    getOwner: () => owner,
    getViewport: () => viewport,
    getActiveTab: () => tab,
    getTab: (tabId) => tabId === tab.id ? tab : undefined,
    isVisible: () => true,
    isDisposed: () => false,
    getOverrideState: () => overrides,
    getCursorScreenPoint: () => ({ x: 140, y: 180 }),
    requestSurfaceSync: () => trace.push("surface:sync"),
    beforeSequenceEnd: () => trace.push("pointer:cancel"),
    shouldDeferIdleEnd: () => false,
    sendWheel: (payload) => trace.push(["wheel", payload]),
    sendFreezeFrame: (payload) => trace.push(["freeze", payload])
  }, { captureMode, now: () => now });

  return {
    controller,
    contents,
    trace,
    setNow(value) { now = value; },
    setFocused(value) {
      focused = value;
      controller.setInputFocused(focused);
    },
    setCaptureMode(value) {
      captureMode = value;
      controller.setCaptureMode(captureMode);
    },
    setOverrides(value) { overrides = value; },
    setViewport(value) {
      const previous = viewport;
      viewport = { ...viewport, ...value };
      controller.viewportChanged(previous, viewport);
    }
  };
}

test("BrowserCanvasGestureController latches focus-aware page ownership until reset", () => {
  const harness = gestureHarness();
  harness.setFocused(true);
  harness.setCaptureMode("off");

  const first = harness.controller.decidePageWheel(harness.contents, wheelInput());
  assert.deepEqual(first, { generation: 1, owner: "page" });

  harness.setFocused(false);
  harness.setCaptureMode("always");
  harness.setNow(1_100);
  assert.deepEqual(
    harness.controller.decidePageWheel(harness.contents, wheelInput({ metaKey: true })),
    { generation: 1, owner: "page" }
  );

  harness.controller.endSequence(false);
  harness.setNow(1_400);
  const next = harness.controller.decidePageWheel(harness.contents, wheelInput({ metaKey: true }));
  assert.deepEqual(next, { generation: 2, owner: "canvas" });
  harness.controller.endSequence(false);
});

test("BrowserCanvasGestureController owns freeze, sink, relay, and restoration order", () => {
  const harness = gestureHarness();
  harness.setFocused(false);

  const decision = harness.controller.decidePageWheel(harness.contents, wheelInput());
  assert.equal(decision.owner, "canvas");
  assert.equal(harness.controller.activeNativeSink?.tabId, "tab-1");
  assert.equal(
    harness.controller.surfaceDecision("tab-1", { x: 100, y: 100, width: 800, height: 600 }, { width: 1_200, height: 900 }).kind,
    "sink"
  );

  harness.controller.handlePageWheel(harness.contents, { ...wheelInput(), generation: decision.generation });
  const relay = harness.trace.find((entry) => Array.isArray(entry) && entry[0] === "wheel");
  assert.deepEqual(relay?.[1], {
    tabId: "tab-1",
    clientX: 140,
    clientY: 160,
    deltaX: 2,
    deltaY: 8,
    ctrlKey: false,
    metaKey: false
  });

  harness.trace.length = 0;
  harness.controller.endSequence();
  assert.deepEqual(harness.trace.slice(0, 4).map((entry) => Array.isArray(entry) ? entry[0] : entry), [
    "pointer:cancel",
    "surface:sync",
    "sink:restore",
    "freeze"
  ]);
  assert.equal(harness.controller.activeNativeSink, null);
  assert.equal(harness.controller.isFreezeActive, false);
});

test("BrowserCanvasGestureController preserves a canvas sequence across placeholder viewport state", () => {
  const harness = gestureHarness();
  const decision = harness.controller.decidePageWheel(harness.contents, wheelInput());
  assert.equal(decision.owner, "canvas");
  harness.setViewport({ surface: "placeholder" });
  harness.controller.handlePageWheel(harness.contents, { ...wheelInput(), generation: decision.generation });
  assert.ok(harness.trace.some((entry) => Array.isArray(entry) && entry[0] === "wheel"));
  harness.controller.endSequence(false);
});

function pointerHarness() {
  const cursors = [];
  const ownerEvents = [];
  const browserEvents = [];
  const navigationEvents = [];
  let navigationOverrideActive = false;
  let nativeSink = null;
  let freezeActive = false;
  let frozenTabId = null;
  const contents = {
    isDestroyed: () => false,
    focus: () => undefined,
    sendInputEvent: (event) => browserEvents.push(event)
  };
  const tab = {
    id: "tab-1",
    view: { webContents: contents },
    canvasCursor: { set: (cursor) => cursors.push(cursor) }
  };
  const owner = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 100, y: 100, width: 1_000, height: 800 }),
    webContents: { sendInputEvent: (event) => ownerEvents.push(event) }
  };
  const router = new BrowserCanvasPointerRouter({
    getOwner: () => owner,
    getViewport: () => ({ x: 200, y: 150, width: 600, height: 400, surface: "native", showAgentPresence: false }),
    getTab: (tabId) => tabId === tab.id ? tab : undefined,
    getTabs: () => [tab],
    getNativeWheelSink: () => nativeSink,
    getFrozenTabId: () => frozenTabId,
    isFreezeActive: () => freezeActive,
    isNavigationOverrideActive: () => navigationOverrideActive,
    getCursorScreenPoint: () => ({ x: 340, y: 300 }),
    endWheelSequence: () => navigationEvents.push({ sequenceEnded: true }),
    sendNavigationPointer: (payload) => navigationEvents.push(payload)
  });
  return {
    router,
    tab,
    owner,
    cursors,
    ownerEvents,
    browserEvents,
    navigationEvents,
    setNavigationOverrideActive(value) { navigationOverrideActive = value; },
    setNativeSink(value) { nativeSink = value; },
    setFreeze(value, tabId = "tab-1") {
      freezeActive = value;
      frozenTabId = value ? tabId : null;
    }
  };
}

function nativeEvent() {
  let prevented = false;
  return {
    event: { preventDefault: () => { prevented = true; } },
    prevented: () => prevented
  };
}

test("BrowserCanvasPointerRouter latches full-override drag and cursor across surfaces", () => {
  const harness = pointerHarness();
  harness.setNavigationOverrideActive(true);
  harness.router.setNavigationActive(true);
  assert.equal(harness.cursors.at(-1), "grab");

  const down = nativeEvent();
  assert.equal(harness.router.handleBrowserMouse(harness.tab, harness.owner, down.event, {
    type: "mouseDown",
    button: "left",
    x: 20,
    y: 30,
    modifiers: []
  }), true);
  assert.equal(down.prevented(), true);
  assert.equal(harness.cursors.at(-1), "grabbing");
  assert.equal(harness.navigationEvents.at(-1).type, "down");

  harness.setNavigationOverrideActive(false);
  harness.router.setNavigationActive(false);
  const move = nativeEvent();
  assert.equal(harness.router.handleOwnerMouse(move.event, {
    type: "mouseMove",
    x: 310,
    y: 260,
    modifiers: []
  }, harness.owner), true);
  assert.equal(move.prevented(), true);
  assert.equal(harness.navigationEvents.at(-1).type, "move");

  const up = nativeEvent();
  assert.equal(harness.router.handleOwnerMouse(up.event, {
    type: "mouseUp",
    button: "left",
    x: 315,
    y: 265,
    modifiers: []
  }, harness.owner), true);
  assert.equal(harness.navigationEvents.at(-1).type, "up");
  assert.equal(harness.cursors.at(-1), null);
});

test("BrowserCanvasPointerRouter forwards ordinary frozen clicks without stealing full override", () => {
  const harness = pointerHarness();
  harness.setFreeze(true);
  const down = nativeEvent();
  assert.equal(harness.router.handleOwnerMouse(down.event, {
    type: "mouseDown",
    button: "left",
    x: 240,
    y: 200,
    clickCount: 1,
    modifiers: ["shift"]
  }, harness.owner), true);
  assert.equal(down.prevented(), true);
  assert.equal(harness.browserEvents.at(-1).type, "mouseDown");

  const up = nativeEvent();
  assert.equal(harness.router.handleOwnerMouse(up.event, {
    type: "mouseUp",
    button: "left",
    x: 245,
    y: 205,
    modifiers: ["shift"]
  }, harness.owner), true);
  assert.equal(harness.browserEvents.at(-1).type, "mouseUp");

  harness.setNavigationOverrideActive(true);
  harness.router.setNavigationActive(true);
  const overrideDown = nativeEvent();
  assert.equal(harness.router.handleOwnerMouse(overrideDown.event, {
    type: "mouseDown",
    button: "left",
    x: 250,
    y: 210,
    modifiers: []
  }, harness.owner), false);
  assert.equal(overrideDown.prevented(), false);
});
