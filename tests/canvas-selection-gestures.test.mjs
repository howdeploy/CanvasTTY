import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CANVAS_CARD_CONTROL_SELECTOR,
  CANVAS_DRAG_THRESHOLD,
  advanceCanvasGroupDrag,
  beginCanvasGroupDrag,
  browserLayerId,
  canvasGroupDragDelta,
  canvasMarqueeRect,
  canvasPressIntent,
  canvasWorldRect,
  noteLayerId,
  parseCanvasLayerId,
  pastCanvasDragThreshold,
  pluginLayerId,
  terminalLayerId
} from "../src/renderer/src/features/workspace/canvasSelectionGesture.ts";

const pointerNavigationPath = new URL("../src/renderer/src/features/workspace/useCanvasPointerNavigation.ts", import.meta.url);
const workspacePath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);

/** Every window kind, each named the way its own card root names it. */
const everyLayerId = [terminalLayerId("a"), pluginLayerId("p"), browserLayerId, "browser:first", "browser:second", noteLayerId("n")];

/** A primary press on empty canvas, overridden per test. */
function press(overrides = {}) {
  return {
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    cardLayerId: null,
    onCardControl: false,
    onCanvasWidget: false,
    selection: new Set(),
    ...overrides
  };
}

/** Does the exported control selector cover this element? Simple tag and class parts only. */
function selectorCovers({ tag, className = "" }) {
  return CANVAS_CARD_CONTROL_SELECTOR.split(",").some((part) => {
    const selector = part.trim();
    return selector.startsWith(".") ? className === selector.slice(1) : tag === selector;
  });
}

/** The source of one `const name = useCallback(...)` up to the next declaration in the hook. */
function hookBody(source, name) {
  const start = source.indexOf(`const ${name} = useCallback`);
  assert.notEqual(start, -1, `${name} is not declared as a useCallback`);
  const rest = source.slice(start + 1);
  const end = Math.min(...["\n  const ", "\n  useEffect", "\n  return {"]
    .map((marker) => {
      const index = rest.indexOf(marker);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }));
  return rest.slice(0, end);
}

test("shift on empty canvas starts a marquee and every other modifier combination does not", () => {
  assert.deepEqual(canvasPressIntent(press({ shiftKey: true })), { kind: "marquee" });
  assert.deepEqual(canvasPressIntent(press()), { kind: "clear-selection" });
  assert.deepEqual(canvasPressIntent(press({ shiftKey: true, altKey: true })), { kind: "clear-selection" });
  assert.deepEqual(canvasPressIntent(press({ shiftKey: true, ctrlKey: true })), { kind: "clear-selection" });
  assert.deepEqual(canvasPressIntent(press({ shiftKey: true, metaKey: true })), { kind: "clear-selection" });
  assert.deepEqual(canvasPressIntent(press({ shiftKey: true, onCanvasWidget: true })), { kind: "none" });
  assert.deepEqual(canvasPressIntent(press({ button: 2 })), { kind: "none" });
});

test("a press on a card is a group drag only when the card is one of several selected", () => {
  const selection = new Set(everyLayerId);
  for (const layerId of everyLayerId) {
    assert.deepEqual(
      canvasPressIntent(press({ cardLayerId: layerId, selection })),
      { kind: "group-drag", layerId },
      `a selected ${layerId} must anchor a group drag`
    );
  }
  const [terminal, plugin] = everyLayerId;
  assert.deepEqual(canvasPressIntent(press({ cardLayerId: terminal, selection: new Set([terminal]) })), { kind: "none" });
  assert.deepEqual(canvasPressIntent(press({ cardLayerId: "terminal:elsewhere", selection })), { kind: "none" });
  assert.deepEqual(canvasPressIntent(press({ cardLayerId: terminal })), { kind: "none" });
  assert.deepEqual(canvasPressIntent(press({ cardLayerId: plugin, selection: new Set([terminal, "terminal:x"]) })), { kind: "none" });
});

test("a press on a card control, the search input, or a resize handle reaches that surface", () => {
  const selection = new Set(everyLayerId);
  for (const cardLayerId of everyLayerId) {
    assert.deepEqual(
      canvasPressIntent(press({ cardLayerId, selection, onCardControl: true })),
      { kind: "none" },
      `control press on ${cardLayerId} must not start a group drag`
    );
    assert.deepEqual(canvasPressIntent(press({ cardLayerId, selection, altKey: true })), { kind: "none" });
  }
});

test("the note editor is a control, so a textarea press never anchors a group drag", () => {
  const note = noteLayerId("n");
  const selection = new Set([note, terminalLayerId("a")]);
  // The note editor is a textarea: the widened selector must own that press.
  assert.equal(selectorCovers({ tag: "textarea" }), true);
  assert.equal(selectorCovers({ tag: "div" }), false, "a plain card body is not a control");
  for (const control of [{ tag: "button" }, { tag: "input" }, { className: "terminal-card__resize-handle" }]) {
    assert.equal(selectorCovers(control), true, `${control.tag ?? control.className} must stay a control`);
  }
  assert.deepEqual(
    canvasPressIntent(press({ cardLayerId: note, selection, onCardControl: true })),
    { kind: "none" }
  );
  assert.deepEqual(
    canvasPressIntent(press({ cardLayerId: note, selection })),
    { kind: "group-drag", layerId: note }
  );
});

test("a layer id round-trips every window kind and nothing else parses", () => {
  const cases = [
    [terminalLayerId("s-1"), { kind: "terminal", targetId: "s-1" }],
    [pluginLayerId("p-1"), { kind: "plugin", targetId: "p-1" }],
    [browserLayerId, { kind: "browser", targetId: null }],
    ["browser:first", { kind: "browser", targetId: "first" }],
    ["browser:second", { kind: "browser", targetId: "second" }],
    [noteLayerId("n-1"), { kind: "note", targetId: "n-1" }]
  ];
  for (const [layerId, expected] of cases) {
    assert.deepEqual(parseCanvasLayerId(layerId), expected, `${layerId} must resolve to its own kind`);
  }
  assert.deepEqual(parseCanvasLayerId(terminalLayerId("s:1")), { kind: "terminal", targetId: "s:1" });
  for (const junk of ["", "terminal", "terminal:", "plugin:", "note:", ":a", "session:a", "browser:", "Browser"]) {
    assert.equal(parseCanvasLayerId(junk), null, `"${junk}" is not a layer id`);
  }
});

test("the shared drag threshold is a travel gate, not a direction test", () => {
  const start = { x: 100, y: 100 };
  assert.equal(CANVAS_DRAG_THRESHOLD, 3);
  assert.equal(pastCanvasDragThreshold(start, { x: 100, y: 100 }), false);
  assert.equal(pastCanvasDragThreshold(start, { x: 102, y: 103 }), false);
  assert.equal(pastCanvasDragThreshold(start, { x: 104, y: 100 }), true);
  assert.equal(pastCanvasDragThreshold(start, { x: 96, y: 100 }), true);
  assert.equal(pastCanvasDragThreshold(start, { x: 100, y: 104 }), true);
  assert.equal(pastCanvasDragThreshold(start, { x: 104, y: 104 }), true);
});

test("a group drag stays inactive under the threshold and commits nothing on release", () => {
  const drag = beginCanvasGroupDrag(7, terminalLayerId("b"), { x: 200, y: 200 });
  assert.equal(drag.active, false);

  const jitter = advanceCanvasGroupDrag(drag, { pointerId: 7, clientX: 202, clientY: 201 });
  assert.equal(jitter.active, false, "a jitter press must not become a drag");
  assert.equal(canvasGroupDragDelta(jitter, { x: 202, y: 201 }, 0.2), null, "a jitter press must not move the group");

  const travelled = advanceCanvasGroupDrag(jitter, { pointerId: 7, clientX: 260, clientY: 200 });
  assert.equal(travelled.active, true);
  assert.deepEqual(canvasGroupDragDelta(travelled, { x: 260, y: 200 }, 0.2), { x: 300, y: 0 });

  // Pointer identity is part of the state: another pointer cannot advance or finish it.
  assert.equal(advanceCanvasGroupDrag(drag, { pointerId: 9, clientX: 900, clientY: 900 }), drag);
});

test("an active group drag previews a fresh world delta on every move, not only the first", () => {
  const drag = beginCanvasGroupDrag(5, terminalLayerId("a"), { x: 400, y: 300 });
  assert.equal(canvasGroupDragDelta(drag, { x: 460, y: 300 }, 1), null, "an untravelled press has no delta");

  const travelled = advanceCanvasGroupDrag(drag, { pointerId: 5, clientX: 460, clientY: 300 });
  assert.equal(travelled.active, true);
  const first = canvasGroupDragDelta(travelled, { x: 460, y: 300 }, 1);
  const second = canvasGroupDragDelta(travelled, { x: 520, y: 340 }, 1);
  assert.deepEqual(first, { x: 60, y: 0 });
  assert.deepEqual(second, { x: 120, y: 40 });
  assert.notDeepEqual(second, first, "a later move must advance the preview, not repeat the first delta");
});

test("the marquee rectangle is viewport-local and direction-agnostic", () => {
  assert.deepEqual(canvasMarqueeRect({ x: 30, y: 40 }, { x: 10, y: 90 }), {
    left: 10,
    top: 40,
    width: 20,
    height: 50
  });
});

test("the marquee rectangle converts to world space through the camera", () => {
  const camera = { x: 100, y: 50, zoom: 2 };
  assert.deepEqual(canvasWorldRect({ x: 120, y: 70 }, { x: 320, y: 170 }, camera), {
    position: { x: 10, y: 10 },
    size: { width: 100, height: 50 }
  });
});

test("the marquee selection never moves logical input focus or the active session", async () => {
  const workspace = await readFile(workspacePath, "utf8");
  const body = hookBody(workspace, "selectMarquee");
  assert.match(body, /setMarqueeSelection/);
  assert.doesNotMatch(body, /onSelectSession/);
  assert.doesNotMatch(body, /onClearCanvasSelection/);
});

test("a group drag press does not preempt the card and only claims the gesture past the threshold", async () => {
  const pointerNavigation = await readFile(pointerNavigationPath, "utf8");
  const start = hookBody(pointerNavigation, "startGroupDrag");
  assert.doesNotMatch(start, /preventDefault|stopPropagation|setPointerCapture/);
  assert.match(start, /beginCanvasGroupDrag\(/);
  assert.match(pointerNavigation, /advanceCanvasGroupDrag\(state, event\)/);
});

test("a travelled group drag commits one delta once and suppresses exactly one follow-up click", async () => {
  const pointerNavigation = await readFile(pointerNavigationPath, "utf8");
  const finish = hookBody(pointerNavigation, "finishGroupDrag");
  assert.equal(finish.match(/onGroupDragRef\.current\(/g)?.length, 1);
  assert.equal(finish.match(/suppressClick\.current = true/g)?.length, 1);
  assert.equal(finish.match(/suppressClick\.current = false/g)?.length, 1);
  const bail = finish.indexOf("if (!state.active) return;");
  assert.notEqual(bail, -1, "only a travelled drag may commit");
  assert.ok(bail < finish.indexOf("suppressClick.current = true"), "a jitter press must not suppress the click");
});
