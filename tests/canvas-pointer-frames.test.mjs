import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createRafAccumulator } from "../src/renderer/src/features/workspace/rafAccumulator.ts";

const source = await readFile(new URL("../src/renderer/src/features/workspace/useCanvasPointerNavigation.ts", import.meta.url), "utf8");
const hook = source.slice(source.indexOf("export function useCanvasPointerNavigation"), source.indexOf("\nfunction isCanvasWidgetTarget"));

function fixture({ native = false } = {}) {
  const frames = new Map();
  let next = 0;
  const commits = [];
  const effects = [];
  let nativeListener;
  const cameraRef = { current: { x: 0, y: 0, zoom: 1 } };
  const viewport = { current: { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} } };
  const useNavigation = runInNewContext(stripTypeScriptTypes(hook.replace("export function", "function") + "\nuseCanvasPointerNavigation;"), {
    useRef: (current) => ({ current }), useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useCallback: (callback) => callback, useEffect: (effect) => effects.push(effect),
    createRafAccumulator: (merge, commit) => createRafAccumulator(merge, commit,
      (callback) => { frames.set(++next, callback); return next; }, (id) => frames.delete(id)),
    createEdgePanLoop: () => ({ stop() {}, move() {}, leave() {} }),
    canvasNavigationMouseButtonFromDomButton: () => null,
    window: { setTimeout() {}, canvasTTY: {
      canvasNavigation: { setPointerGestureActive() {} },
      browser: { onCanvasNavigationPointer: (listener) => { nativeListener = listener; return () => {}; } }
    } }
  });
  const navigation = useNavigation({
    viewport, cameraRef, settings: { edgePan: false }, canvasOverrideActiveRef: { current: false },
    selectedLayerIds: new Set(), onMarqueeSelection() {}, onGroupDragStart() {}, onGroupDrag() {},
    commitCamera: (camera) => { commits.push({ ...camera }); cameraRef.current = camera; }
  });
  const event = (x = 0, y = 0) => ({ button: 1, pointerId: 1, clientX: x, clientY: y,
    currentTarget: viewport.current, preventDefault() {}, stopPropagation() {} });
  effects.at(-1)();
  if (!native) navigation.handlePointerDown(event());
  return { navigation, commits, frames, cameraRef, event,
    native: (type, clientX = 0, clientY = 0) => nativeListener({ type, tabId: "tab", clientX, clientY }),
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()); } };
}

test("a pointer burst commits the latest camera once per frame and flushes its last move on release", () => {
  const h = fixture();
  for (let i = 1; i <= 100; i++) h.navigation.handlePointerMove(h.event(i, i * 2));
  assert.equal(h.commits.length, 0);
  assert.equal(h.frames.size, 1);
  h.frame();
  assert.deepEqual(h.commits, [{ x: 100, y: 200, zoom: 1 }]);
  h.navigation.handlePointerMove(h.event(120, 240));
  h.navigation.handlePointerEnd(h.event(120, 240));
  assert.equal(h.frames.size, 0);
  assert.deepEqual(h.commits.at(-1), { x: 120, y: 240, zoom: 1 });
});

test("native browser pan coalesces moves, flushes release and discards cancellation", () => {
  const h = fixture({ native: true });
  h.native("down");
  h.native("move", 50, 75);
  h.native("move", 100, 150);
  assert.equal(h.frames.size, 1);
  h.native("up", 100, 150);
  assert.deepEqual(h.commits, [{ x: 100, y: 150, zoom: 1 }]);
  assert.equal(h.frames.size, 0);
  h.native("down", 100, 150);
  h.native("move", 200, 300);
  h.native("cancel");
  h.frame();
  assert.equal(h.commits.length, 1);
  const transferred = fixture();
  transferred.navigation.handlePointerMove(transferred.event(100));
  transferred.native("cancel");
  transferred.frame();
  assert.equal(transferred.commits.length, 0);
});

test("cancellation and a newer direct navigation discard an unpainted pan", () => {
  const cancelled = fixture();
  cancelled.navigation.handlePointerMove(cancelled.event(100));
  cancelled.navigation.handlePointerCancel();
  cancelled.frame();
  assert.equal(cancelled.commits.length, 0);
  const superseded = fixture();
  superseded.navigation.handlePointerMove(superseded.event(100));
  superseded.cameraRef.current = { x: 500, y: 200, zoom: 0.5 };
  superseded.frame();
  assert.equal(superseded.commits.length, 0, "Home, focus or another navigation owns the newer camera");
});
