import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CANVAS_DRAG_THRESHOLD,
  advanceCanvasGroupDrag,
  beginCanvasGroupDrag,
  canvasMarqueeRect,
  canvasPressIntent,
  canvasWorldRect,
  endCanvasGroupDrag,
  pastCanvasDragThreshold
} from "../src/renderer/src/features/workspace/canvasSelectionGesture.ts";

const pointerNavigationPath = new URL("../src/renderer/src/features/workspace/useCanvasPointerNavigation.ts", import.meta.url);
const workspacePath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);
const terminalCardPath = new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url);

/** A primary press on empty canvas, overridden per test. */
function press(overrides = {}) {
  return {
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    cardSessionId: null,
    onCardControl: false,
    onCanvasWidget: false,
    selection: new Set(),
    ...overrides
  };
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
  const selection = new Set(["a", "b", "c"]);
  assert.deepEqual(
    canvasPressIntent(press({ cardSessionId: "b", selection })),
    { kind: "group-drag", sessionId: "b" }
  );
  assert.deepEqual(canvasPressIntent(press({ cardSessionId: "b", selection: new Set(["b"]) })), { kind: "none" });
  assert.deepEqual(canvasPressIntent(press({ cardSessionId: "d", selection })), { kind: "none" });
  assert.deepEqual(canvasPressIntent(press({ cardSessionId: "b" })), { kind: "none" });
});

test("a press on a card control, the search input, or a resize handle reaches that surface", () => {
  const selection = new Set(["a", "b"]);
  for (const cardSessionId of ["a", "b"]) {
    assert.deepEqual(
      canvasPressIntent(press({ cardSessionId, selection, onCardControl: true })),
      { kind: "none" },
      `control press on ${cardSessionId} must not start a group drag`
    );
  }
  assert.deepEqual(canvasPressIntent(press({ cardSessionId: "b", selection, altKey: true })), { kind: "none" });
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
  const drag = beginCanvasGroupDrag(7, "b", { x: 200, y: 200 });
  assert.equal(drag.active, false);

  const jitter = advanceCanvasGroupDrag(drag, { pointerId: 7, clientX: 202, clientY: 201 });
  assert.equal(jitter.active, false, "a jitter press must not become a drag");
  assert.equal(endCanvasGroupDrag(jitter, { x: 202, y: 201 }, 0.2), null, "a jitter press must not move the group");

  const travelled = advanceCanvasGroupDrag(jitter, { pointerId: 7, clientX: 260, clientY: 200 });
  assert.equal(travelled.active, true);
  assert.deepEqual(endCanvasGroupDrag(travelled, { x: 260, y: 200 }, 0.2), { x: 300, y: 0 });

  // Pointer identity is part of the state: another pointer cannot advance or finish it.
  assert.equal(advanceCanvasGroupDrag(drag, { pointerId: 9, clientX: 900, clientY: 900 }), drag);
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

test("the terminal card publishes the session id the group-drag guard reads", async () => {
  const [card, pointerNavigation] = await Promise.all([
    readFile(terminalCardPath, "utf8"),
    readFile(pointerNavigationPath, "utf8")
  ]);
  assert.match(card, /data-session-id=\{session\.id\}/);
  assert.match(pointerNavigation, /\.closest<HTMLElement>\("\.terminal-card"\)/);
  assert.match(pointerNavigation, /card\?\.dataset\.sessionId \?\? null/);
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
  assert.match(pointerNavigation, /endCanvasGroupDrag\(state, /);
  assert.match(pointerNavigation, /onCardControl: target\.closest\(TERMINAL_CARD_CONTROL_SELECTOR\) !== null/);
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
