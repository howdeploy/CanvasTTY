import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformSync } from "esbuild";
import { constrainCanvasRegionBounds, snapCanvasRegionBounds } from "../src/renderer/src/features/workspace/canvasRegions.ts";
import { canvasWorldRect } from "../src/renderer/src/features/workspace/canvasSelectionGesture.ts";
import { snapMove } from "../src/renderer/src/features/workspace/snap.ts";

// Execute the production handlers, including pointer-id, cancellation and snapping paths.
async function terminalHandlers(isMacOS, zoom = 1) {
  const source = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const startDrag =");
  const end = source.indexOf("  const activateSummary =", start);
  const code = transformSync(source.slice(start, end), { loader: "ts", target: "esnext" }).code;
  const initial = { position: { x: 100, y: 200 }, size: { width: 800, height: 500 } };
  const liveBounds = { current: initial };
  const commits = [];
  const handlers = new Function("window", "dragState", "resizeState", "liveBounds", "session", "camera", "snapEnabled", "getSnapTargets", "snapMove", "setPosition", "setSize", "onBoundsChange",
    code + ";return {startDrag, drag, endDrag, cancelDrag, startResize, endResize};")(
      { canvasTTY: { window: { isMacOS } } }, { current: null }, { current: null }, liveBounds,
      { id: "own-test", ...initial }, { get: () => ({ zoom }) }, false, () => [], snapMove,
      () => {}, () => {}, (id, bounds) => commits.push({ id, bounds }));
  return { ...handlers, liveBounds, commits, initial };
}
const event = (x, y, extra = {}) => ({
  pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y,
  target: { closest: () => null }, currentTarget: { setPointerCapture() {} },
  preventDefault() {}, stopPropagation() {}, ...extra
});

test("terminal commits the release position even without a last pointermove", async () => {
  for (const zoom of [0.5, 1, 2]) {
    const h = await terminalHandlers(true, zoom);
    h.startDrag(event(10, 20));
    h.endDrag(event(110, 80, { buttons: 0 }));
    assert.deepEqual(h.commits, [{ id: "own-test", bounds: {
      position: { x: 100 + 100 / zoom, y: 200 + 60 / zoom }, size: h.initial.size
    } }]);
    h.cancelDrag();
    assert.deepEqual(h.liveBounds.current, h.commits[0].bounds, "lost capture after release cannot undo the commit");
  }
});

test("terminal ignores hover/other pointers and cancels an unfinished drag", async () => {
  const h = await terminalHandlers(true);
  h.startDrag(event(0, 0));
  h.drag(event(400, 400, { buttons: 0 }));
  h.endDrag(event(400, 400, { buttons: 0, pointerId: 2 }));
  assert.deepEqual(h.liveBounds.current, h.initial);
  assert.deepEqual(h.commits, []);
  h.drag(event(100, 60));
  h.cancelDrag();
  h.endDrag(event(200, 100, { buttons: 0 }));
  assert.deepEqual(h.liveBounds.current, h.initial);
  assert.deepEqual(h.commits, []);
});

test("release coordinates are authoritative on other platforms too", async () => {
  const h = await terminalHandlers(false);
  h.startDrag(event(0, 0));
  h.drag(event(50, 60));
  h.endDrag(event(100, 120, { buttons: 0 }));
  assert.deepEqual(h.commits[0].bounds.position, { x: 200, y: 320 });
});

test("pointercancel discards a gesture instead of saving its synthetic release coordinates", async () => {
  const drag = await terminalHandlers(true);
  drag.startDrag(event(200, 300));
  drag.drag(event(400, 500));
  drag.endDrag(event(0, 0, { buttons: 0, type: "pointercancel" }));
  assert.deepEqual(drag.liveBounds.current, drag.initial);
  assert.deepEqual(drag.commits, []);
  const resize = await terminalHandlers(true);
  resize.startResize(event(200, 300), "se");
  resize.endResize(event(0, 0, { buttons: 0, type: "pointercancel", pointerId: 2 }));
  assert.deepEqual(resize.commits, [], "another pointer cannot cancel the active resize");
  resize.endResize(event(0, 0, { buttons: 0, type: "pointercancel" }));
  assert.deepEqual(resize.liveBounds.current, resize.initial);
  assert.deepEqual(resize.commits, []);
});

async function regionHandlers(isMacOS, zoom = 1) {
  const source = await readFile(new URL("../src/renderer/src/features/workspace/CanvasRegionCard.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const initialBounds =");
  const end = source.indexOf("  return (", start);
  const code = transformSync(source.slice(start, end), { loader: "ts" }).code;
  const initial = { position: { x: 100, y: 200 }, size: { width: 800, height: 500 } };
  const commits = [];
  const h = new Function("window", "region", "camera", "snapEnabled", "snapTargets", "onBoundsChange", "onMovePreview", "useState", "useRef", "useEffect", "snapMove", "constrainCanvasRegionBounds", "snapCanvasRegionBounds",
    code + ";return { startDrag, drag, endDrag, cancelDrag, startResize, resize, endResize, cancelResize, liveBounds };")(
      { canvasTTY: { window: { isMacOS } } }, { id: "own-region", ...initial }, { get: () => ({ zoom }) }, false, [],
      (id, bounds, interaction) => commits.push({ id, bounds, interaction }), () => {},
      (value) => [value, () => {}], (current) => ({ current }), () => {},
      snapMove, constrainCanvasRegionBounds, snapCanvasRegionBounds);
  return { ...h, initial, commits };
}

test("fast region resize uses release coordinates at every canvas zoom", async () => {
  for (const zoom of [0.5, 1, 2]) {
    const h = await regionHandlers(true, zoom);
    h.startResize(event(10, 20), "se");
    h.endResize(event(210, 120, { buttons: 0 }));
    assert.deepEqual(h.commits, [{ id: "own-region", interaction: "resize", bounds: {
      position: h.initial.position, size: { width: 800 + 200 / zoom, height: 500 + 100 / zoom }
    } }]);
    h.cancelResize(event(210, 120));
    assert.deepEqual(h.liveBounds.current, h.commits[0].bounds);
  }
});

test("region drag, cancellation and legacy platform resize remain distinct", async () => {
  const h = await regionHandlers(true);
  h.startDrag(event(0, 0));
  h.endDrag(event(100, 60, { buttons: 0 }));
  assert.deepEqual(h.commits[0].bounds.position, { x: 200, y: 260 });
  const cancelled = await regionHandlers(true);
  cancelled.startResize(event(0, 0), "se");
  cancelled.resize(event(150, 60));
  cancelled.cancelResize(event(150, 60));
  cancelled.endResize(event(200, 100, { buttons: 0 }));
  assert.deepEqual(cancelled.liveBounds.current, cancelled.initial);
  assert.deepEqual(cancelled.commits, []);
  const legacy = await regionHandlers(false);
  legacy.startResize(event(0, 0), "se");
  legacy.resize(event(50, 60));
  legacy.endResize(event(100, 120, { buttons: 0 }));
  assert.deepEqual(legacy.commits[0].bounds.size, { width: 900, height: 620 });
});

test("marquee includes a note reached only by the release event", async () => {
  const source = await readFile(new URL("../src/renderer/src/features/workspace/useCanvasPointerNavigation.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const finishMarquee =");
  const end = source.indexOf("  const updateGroupDrag =", start);
  const code = transformSync(source.slice(start, end), { loader: "ts" }).code;
  for (const isMacOS of [false, true]) {
    const state = { current: { pointerId: 1, start: { x: 0, y: 0 }, current: { x: 200, y: 200 }, moved: true } };
    const selected = [];
    const update = (event) => { state.current.current = { x: event.clientX, y: event.clientY }; };
    const finish = new Function("window", "useCallback", "marqueeState", "viewport", "setMarquee", "suppressClick", "onMarqueeSelectionRef", "cameraRef", "canvasWorldRect", "updateMarquee",
      code + ";return finishMarquee;")(
        { canvasTTY: { window: { isMacOS } }, setTimeout() {} }, (fn) => fn, state,
        { current: null }, () => {}, { current: false }, { current: (rect) => selected.push(rect) },
        { current: { x: 0, y: 0, zoom: 1 } }, canvasWorldRect, update);
    finish(event(400, 400, { buttons: 0 }));
    const rect = selected[0];
    const note = { position: { x: 350, y: 350 }, size: { width: 40, height: 40 } };
    assert.equal(rect.position.x + rect.size.width >= note.position.x, true);
    assert.equal(state.current, null);
  }
});
