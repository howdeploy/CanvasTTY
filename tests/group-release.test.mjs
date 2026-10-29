import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformSync } from "esbuild";
import { importWithFakeReact } from "./helpers/fake-react.mjs";
import { translateBounds } from "../src/renderer/src/features/workspace/canvasRegions.ts";
import { snapMove } from "../src/renderer/src/features/workspace/snap.ts";

const react = await importWithFakeReact("src/renderer/src/features/workspace/useCanvasPointerNavigation.ts", "useCanvasPointerNavigation");
const workspace = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
const start = workspace.indexOf("  const beginGroupDrag =");
const end = workspace.indexOf("  const focusController =", start);
assert.ok(start >= 0 && end > start);
const groupCode = transformSync(workspace.slice(start, end), { loader: "ts" }).code;

function navigation({ platform = "darwin", zoom = 1, snapToGrid = false } = {}) {
  react.__reset();
  const previousWindow = globalThis.window;
  const previousElement = globalThis.Element;
  globalThis.Element = class {};
  const listeners = new Map();
  globalThis.window = {
    canvasTTY: {
      window: { platform, isMacOS: platform === "darwin" },
      canvasNavigation: { setPointerGestureActive() {} },
      browser: { onCanvasNavigationPointer: () => () => {} }
    },
    setTimeout() {}, addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); }
  };
  const boundsByLayer = new Map([
    ["terminal:a", { position: { x: 100, y: 200 }, size: { width: 300, height: 220 } }],
    ["note:b", { position: { x: 600, y: 400 }, size: { width: 300, height: 220 } }],
    ["files:c", { position: { x: 800, y: 500 }, size: { width: 400, height: 300 } }]
  ]);
  const marqueeSelection = new Set(boundsByLayer.keys());
  const groupDragBasis = { current: null };
  const commits = [];
  // Run the workspace's production freeze/commit callbacks as well as the hook:
  // observing a delta alone would miss a release that never froze the group basis.
  const group = new Function("useCallback", "boundsByLayer", "marqueeSelection", "groupDragBasis", "commitLayerBounds", "homeBounds", "renderedCanvasRegions", "settings", "translateBounds", "snapMove",
    groupCode + ";return { beginGroupDrag, commitGroupDrag };")(
      (callback) => callback, boundsByLayer, marqueeSelection, groupDragBasis,
      (bounds) => commits.push(bounds), { position: { x: -2000, y: -2000 }, size: { width: 100, height: 100 } },
      [], { snapToGrid }, translateBounds, snapMove);
  const captures = new Set();
  let captureCalls = 0;
  const viewport = {
    hasPointerCapture(id) { return captures.has(id); },
    setPointerCapture(id) { captureCalls++; captures.add(id); },
    releasePointerCapture(id) { captures.delete(id); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    ownerDocument: { addEventListener() {}, removeEventListener() {} }
  };
  const props = {
    viewport: { current: viewport }, settings: { canvasNavigationOverride: null, edgePan: false },
    cameraRef: { current: { x: 0, y: 0, zoom } }, canvasOverrideActiveRef: { current: false },
    commitCamera() {}, selectedLayerIds: marqueeSelection, onMarqueeSelection() {},
    onGroupDragStart(layerId) { starts.push(layerId); group.beginGroupDrag(layerId); },
    onGroupDrag: group.commitGroupDrag
  };
  const starts = [];
  let controller;
  const render = () => { react.__flush(); controller = react.__render(react.useCanvasPointerNavigation, props); };
  const target = new globalThis.Element();
  target.closest = (selector) => selector === "[data-canvas-layer-id]"
    ? { dataset: { canvasLayerId: "terminal:a" } }
    : selector.includes("data-interactive") ? target : null;
  const event = (x, y, extra = {}) => ({
    type: "pointermove", pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y,
    altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    target, currentTarget: viewport, preventDefault() {}, stopPropagation() { this.stopped = true; }, ...extra
  });
  render();
  return {
    event, starts, commits, boundsByLayer, listeners, groupDragBasis,
    get controller() { render(); return controller; },
    get captureCalls() { return captureCalls; },
    close() { react.__unmount(); globalThis.window = previousWindow; globalThis.Element = previousElement; }
  };
}

test("fast group release freezes and commits every selected layer at every zoom", () => {
  for (const zoom of [0.5, 1, 2]) {
    const h = navigation({ zoom });
    try {
      const down = h.event(10, 20);
      assert.equal(h.controller.handlePointerDownCapture(down), true);
      assert.equal(down.stopped, undefined, "the press still reaches the pressed card");
      const up = h.event(110, 80, { type: "pointerup", buttons: 0 });
      h.controller.handlePointerEndCapture(up);
      assert.equal(up.stopped, true, "the anchor's own pointerup cannot save it separately");
      assert.deepEqual(h.starts, ["terminal:a"]);
      assert.equal(h.captureCalls, 0, "release does not attempt capture of an inactive pointer");
      assert.equal(h.commits.length, 1);
      for (const [layerId, bounds] of h.boundsByLayer) {
        assert.deepEqual(h.commits[0].get(layerId), {
          position: { x: bounds.position.x + 100 / zoom, y: bounds.position.y + 60 / zoom }, size: bounds.size
        });
      }
      h.controller.handlePointerEndCapture(up);
      assert.equal(h.commits.length, 1, "the group commits once");
      assert.equal(h.controller.handleClickCapture(h.event(110, 80)), true);
      assert.equal(h.controller.handleClickCapture(h.event(110, 80)), false);
    } finally { h.close(); }
  }
});

test("group release under the threshold leaves the card's click path intact", () => {
  const h = navigation();
  try {
    h.controller.handlePointerDownCapture(h.event(10, 20));
    const up = h.event(13, 23, { type: "pointerup", buttons: 0 });
    h.controller.handlePointerEndCapture(up);
    assert.equal(up.stopped, undefined);
    assert.deepEqual(h.starts, []);
    assert.deepEqual(h.commits, []);
    assert.equal(h.controller.handleClickCapture(h.event(13, 23)), false);
  } finally { h.close(); }
});

test("group release ignores other pointers and keeps one basis after a real move", () => {
  const h = navigation();
  try {
    h.controller.handlePointerDownCapture(h.event(10, 20));
    h.controller.handlePointerEndCapture(h.event(110, 80, { pointerId: 2, type: "pointerup", buttons: 0 }));
    assert.deepEqual(h.starts, []);
    assert.deepEqual(h.commits, []);
    h.controller.handlePointerMoveCapture(h.event(60, 50));
    assert.deepEqual(h.starts, ["terminal:a"]);
    assert.equal(h.captureCalls, 1);
    h.controller.handlePointerEndCapture(h.event(110, 80, { type: "pointerup", buttons: 0 }));
    assert.deepEqual(h.starts, ["terminal:a"]);
    assert.deepEqual(h.commits[0].get("note:b").position, { x: 700, y: 460 });
  } finally { h.close(); }
});

for (const cancel of ["pointercancel", "blur"]) {
  test(`${cancel} discards pending and active group drags without a release commit`, () => {
    for (const active of [false, true]) {
      const h = navigation();
      try {
        h.controller.handlePointerDownCapture(h.event(10, 20));
        if (active) h.controller.handlePointerMoveCapture(h.event(60, 50));
        if (cancel === "blur") h.listeners.get("blur")();
        else h.controller.handlePointerCancel();
        h.controller.handlePointerEndCapture(h.event(110, 80, { type: "pointerup", buttons: 0 }));
        assert.deepEqual(h.commits, []);
        assert.equal(h.controller.groupNudge, null);
      } finally { h.close(); }
    }
  });
}

test("fast group release applies one snapped delta to the whole group", () => {
  const h = navigation({ snapToGrid: true });
  try {
    h.controller.handlePointerDownCapture(h.event(10, 20));
    h.controller.handlePointerEndCapture(h.event(123, 94, { type: "pointerup", buttons: 0 }));
    assert.deepEqual(h.commits[0].get("terminal:a").position, { x: 210, y: 270 });
    assert.deepEqual(h.commits[0].get("note:b").position, { x: 710, y: 470 });
    assert.deepEqual(h.commits[0].get("files:c").position, { x: 910, y: 570 });
  } finally { h.close(); }
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} commits both fast release and moved group gestures`, () => {
    const h = navigation({ platform });
    try {
      h.controller.handlePointerDownCapture(h.event(10, 20));
      const up = h.event(110, 80, { type: "pointerup", buttons: 0 });
      h.controller.handlePointerEndCapture(up);
      assert.equal(up.stopped, true);
      assert.deepEqual(h.starts, ["terminal:a"]);
      assert.equal(h.commits.length, 1);
      h.controller.handlePointerDownCapture(h.event(10, 20));
      h.controller.handlePointerMoveCapture(h.event(60, 50));
      h.controller.handlePointerEndCapture(h.event(110, 80, { type: "pointerup", buttons: 0 }));
      assert.deepEqual(h.starts, ["terminal:a", "terminal:a"]);
      assert.deepEqual(h.commits[0].get("note:b").position, { x: 700, y: 460 });
    } finally { h.close(); }
  });
}
