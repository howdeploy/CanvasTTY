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
  keepLiveIds,
  pruneToLive,
  snapTargetGetters,
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

test("per-session canvas state forgets closed sessions and keeps its identity while nothing closed", async () => {
  const live = new Set(["a", "b"]);
  const toggles = new Map([["a", () => "a"], ["gone", () => "gone"], ["b", () => "b"]]);
  const a = toggles.get("a");
  pruneToLive(toggles, live);
  assert.deepEqual([...toggles.keys()], ["a", "b"]);
  assert.equal(toggles.get("a"), a, "a live session keeps its callback");
  const master = new Set(["a", "gone"]);
  assert.deepEqual([...keepLiveIds(master, live)], ["a"]);
  const unchanged = new Set(["b"]);
  assert.equal(keepLiveIds(unchanged, live), unchanged, "no state change when nothing closed");
  const source = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  assert.match(source, /pruneToLive\(fullscreenToggles\.current, liveSessionIds\)/u);
  assert.match(source, /setMasterPixelSkinSessionIds\(\(current\) => keepLiveIds\(current, liveSessionIds\)\)/u);
});

test("a drag or resize cancelled by lost pointer capture snaps the card back to its saved bounds", async () => {
  const read = (path) => readFile(new URL(`../src/renderer/src/features/${path}`, import.meta.url), "utf8");
  const card = await read("terminal/TerminalCard.tsx");
  for (const name of ["cancelDrag", "cancelResize"]) {
    const body = card.slice(card.indexOf(`const ${name} = `), card.indexOf("};", card.indexOf(`const ${name} = `)));
    assert.match(body, /applyLiveBounds\(\{ position: session\.position, size: session\.size \}\)/u, name);
    assert.match(body, /if \(!(dragState|resizeState)\.current\) return;/u, `${name}: not after a normal pointerup`);
  }
  const region = await read("workspace/CanvasRegionCard.tsx");
  const cancelDrag = region.slice(region.indexOf("const cancelDrag = "), region.indexOf("};", region.indexOf("const cancelDrag = ")));
  assert.match(cancelDrag, /applyBounds\(\{ position: region\.position, size: region\.size \}\)/u);
});

test("snap targets are built only when a card's drag starts, from the layout of that moment", async () => {
  const home = bounds(0, 0, 1000, 1000);
  const a = bounds(10, 10);
  const b = bounds(300, 10);
  const c = bounds(600, 10);
  let reads = 0;
  let layout = { fixed: [home], windows: [a, b, c], byLayer: new Map([["a", a], ["b", b], ["c", c]]) };
  const getters = snapTargetGetters(() => { reads += 1; return layout; });

  // Rendering hands every card its getter: the same function each render, and no list is built.
  const forB = getters.forLayer("b");
  for (let render = 0; render < 5; render += 1) {
    assert.equal(getters.forLayer("a"), getters.forLayer("a"));
    assert.equal(getters.forLayer("b"), forB);
    getters.forLayer("c");
  }
  assert.equal(reads, 0, "no snap-target list is built while cards only render");

  // A drag of b starts: only b's list, every other window plus the fixed targets.
  assert.deepEqual(forB(), [home, a, c]);
  assert.equal(reads, 1);

  // A neighbour moved since: the next drag sees the new layout through the same getter.
  const movedA = bounds(20, 500);
  layout = { fixed: [home], windows: [movedA, b, c], byLayer: new Map([["a", movedA], ["b", b], ["c", c]]) };
  assert.deepEqual(forB(), [home, movedA, c]);

  getters.prune(new Set(["a", "c"]));
  assert.notEqual(getters.forLayer("b"), forB, "a removed card's getter is dropped");

  const source = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /allWindowBounds\.filter\(/u, "no per-card filter in render");
  for (const card of ["terminal/TerminalCard", "plugins/PluginCanvasCard", "browser/BrowserCard", "notes/StickyNoteCard"]) {
    const text = await readFile(new URL(`../src/renderer/src/features/${card}.tsx`, import.meta.url), "utf8");
    const starts = card === "plugins/PluginCanvasCard" ? 3 : 2;
    assert.equal((text.match(/snapTargets: snapEnabled \? getSnapTargets\(\) : \[\]/gu) ?? []).length, starts,
      `${card} takes its targets only when header/mascot drag or resize starts`);
  }
});
