import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  boundsEqual,
  boundsOverlap,
  bringCanvasLayerToFront,
  canvasLayerIsOccluded,
  canvasLayerZIndex,
  canvasScreenRect,
  reconcileCanvasLayerOrder
} from "../src/renderer/src/features/workspace/canvasStacking.ts";
import { canvasWorldRect } from "../src/renderer/src/features/workspace/canvasSelectionGesture.ts";

const bounds = (x, y, width = 200, height = 120) => ({
  position: { x, y },
  size: { width, height }
});

test("an ordinary activation moves the selected canvas window to the front", () => {
  const initial = ["terminal:a", "browser", "note:n"];
  const raised = bringCanvasLayerToFront(initial, "terminal:a");
  assert.deepEqual(raised, ["browser", "note:n", "terminal:a"]);
  assert.equal(canvasLayerZIndex(raised, "terminal:a"), 3);
  assert.deepEqual(initial, ["terminal:a", "browser", "note:n"]);
});

test("layer reconciliation keeps user order and appends only new live windows", () => {
  assert.deepEqual(
    reconcileCanvasLayerOrder(["browser", "terminal:a", "stale", "terminal:a"], ["terminal:a", "browser", "note:n"]),
    ["browser", "terminal:a", "note:n"]
  );
});

test("an unchanged layer order reconciles to the same array", () => {
  const order = ["browser", "terminal:a", "note:n"];
  assert.equal(reconcileCanvasLayerOrder(order, ["note:n", "terminal:a", "browser"]), order);
  assert.notEqual(reconcileCanvasLayerOrder(order, ["terminal:a", "browser"]), order);
});

test("the native Browser surface is hidden only under a higher overlapping layer", () => {
  const map = new Map([
    ["browser", bounds(0, 0)],
    ["terminal:a", bounds(150, 40)],
    ["note:n", bounds(500, 500)]
  ]);
  assert.equal(boundsOverlap(map.get("browser"), map.get("terminal:a")), true);
  assert.equal(canvasLayerIsOccluded("browser", ["browser", "terminal:a", "note:n"], map), true);
  assert.equal(canvasLayerIsOccluded("browser", ["terminal:a", "browser", "note:n"], map), false);
});

test("the page is converted to screen space as the exact inverse of the marquee converter", () => {
  const camera = { x: 40, y: -30, zoom: 0.5 };
  const page = bounds(100, 50, 200, 120);
  assert.deepEqual(canvasScreenRect(page, camera), bounds(90, -5, 100, 60));
  assert.deepEqual(canvasWorldRect({ x: 90, y: -5 }, { x: 190, y: 55 }, camera), page);
});

test("an overlay hides the page only where its screen box actually overlaps", () => {
  const camera = { x: 0, y: 0, zoom: 2 };
  const page = canvasScreenRect(bounds(0, 0, 400, 300), camera);
  assert.equal(boundsOverlap(page, bounds(800, 600, 190, 122)), false);
  assert.equal(boundsOverlap(page, bounds(799, 599, 190, 122)), true);
});

test("a re-measure compares equal by value, so the observer cannot re-render itself", () => {
  assert.equal(boundsEqual(bounds(100, 50, 200, 120), bounds(100, 50, 200, 120)), true);
  assert.equal(boundsEqual(bounds(100, 50, 200, 120), bounds(100.5, 50, 200, 120)), false);
});

test("embedded plugin focus participates in ordinary click-to-front activation", async () => {
  const source = await readFile(new URL(
    "../src/renderer/src/features/plugins/PluginFrame.tsx",
    import.meta.url
  ), "utf8");
  assert.match(source, /<iframe[\s\S]*?onFocus=\{onFocus\}/);
});
