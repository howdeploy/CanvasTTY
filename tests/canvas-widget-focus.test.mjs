import assert from "node:assert/strict";
import test from "node:test";
import {
  browserCanvasWidgetId,
  canvasWidgetFocusAfterClick,
  canvasWidgetInDirection,
  homeCanvasWidgetId,
  pluginCanvasWidgetId,
  terminalCanvasWidgetId
} from "../src/renderer/src/features/workspace/canvasWidgetFocus.ts";

test("canvas widget ids are stable across each focusable input surface", () => {
  assert.equal(terminalCanvasWidgetId("pty-1"), "terminal:pty-1");
  assert.equal(pluginCanvasWidgetId("canvas-1"), "plugin-canvas:canvas-1");
  assert.equal(homeCanvasWidgetId("core.sessions"), "home:core.sessions");
  assert.equal(browserCanvasWidgetId, "browser");
});

test("only a click outside every widget clears logical input focus", () => {
  assert.equal(canvasWidgetFocusAfterClick("terminal:one", {
    isWidget: true,
    focusableWidgetId: "browser"
  }), "browser");
  assert.equal(canvasWidgetFocusAfterClick("terminal:one", {
    isWidget: true,
    focusableWidgetId: null
  }), "terminal:one");
  assert.equal(canvasWidgetFocusAfterClick("terminal:one", {
    isWidget: false,
    focusableWidgetId: null
  }), null);
});

const cards = [
  { id: "terminal:left", bounds: { position: { x: 0, y: 0 }, size: { width: 400, height: 300 } } },
  { id: "terminal:right", bounds: { position: { x: 900, y: 0 }, size: { width: 400, height: 300 } } },
  { id: "plugin-canvas:below", bounds: { position: { x: -900, y: 700 }, size: { width: 400, height: 300 } } },
  { id: browserCanvasWidgetId, bounds: { position: { x: 0, y: -900 }, size: { width: 400, height: 300 } } }
];

test("arrows pick the nearest widget in that direction across mixed card kinds", () => {
  assert.equal(canvasWidgetInDirection(cards, "terminal:left", "right", { x: 0, y: 0 }), "terminal:right");
  assert.equal(canvasWidgetInDirection(cards, "terminal:left", "down", { x: 0, y: 0 }), "plugin-canvas:below");
  assert.equal(canvasWidgetInDirection(cards, "terminal:left", "up", { x: 0, y: 0 }), browserCanvasWidgetId);
  assert.equal(canvasWidgetInDirection(cards, "terminal:right", "left", { x: 0, y: 0 }), "terminal:left");
});

test("a direction with nothing ahead keeps focus where it is", () => {
  assert.equal(canvasWidgetInDirection(cards, "terminal:right", "right", { x: 0, y: 0 }), null);
  assert.equal(canvasWidgetInDirection(cards, browserCanvasWidgetId, "up", { x: 0, y: 0 }), null);
});

test("without a current widget the viewport centre is the origin", () => {
  // Centre sits right of every card, so the closest one to the left is the nearest by distance.
  assert.equal(canvasWidgetInDirection(cards, null, "left", { x: 2_000, y: 150 }), "terminal:right");
  assert.equal(canvasWidgetInDirection([], null, "up", { x: 0, y: 0 }), null);
});

test("an unknown current id falls back to the origin instead of jumping backwards", () => {
  const origin = { x: 0, y: 0 };
  assert.equal(canvasWidgetInDirection(cards, "terminal:gone", "down", origin), "terminal:left");
  assert.equal(canvasWidgetInDirection(cards, "terminal:gone", "down", origin),
    canvasWidgetInDirection(cards, null, "down", origin));
});
