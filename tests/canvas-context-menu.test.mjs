import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  chooseCanvasSubmenuSide,
  clampCanvasMenuPosition,
  routeCanvasContextMenu
} from "../src/renderer/src/features/workspace/canvasContextRouting.ts";

const contextMenuComponentPath = new URL(
  "../src/renderer/src/features/workspace/CanvasContextMenu.tsx",
  import.meta.url
);

test("the canvas owns only empty, region, note, and material context menus", () => {
  assert.equal(routeCanvasContextMenu("empty", false), "empty");
  assert.equal(routeCanvasContextMenu("region", false), "region");
  assert.equal(routeCanvasContextMenu("note", false), "note");
  assert.equal(routeCanvasContextMenu("material", false), "material");
  assert.equal(routeCanvasContextMenu("material", true), null);
  assert.equal(routeCanvasContextMenu("native", false), null);
  assert.equal(routeCanvasContextMenu("blocked", false), null);
  assert.equal(routeCanvasContextMenu("empty", true), null);
});

test("launcher submenu chooses its side before it is mounted", async () => {
  const viewport = { left: 0, right: 1_000 };
  assert.equal(chooseCanvasSubmenuSide({ left: 100, right: 350 }, viewport, 247, 8), "right");
  assert.equal(chooseCanvasSubmenuSide({ left: 740, right: 990 }, viewport, 247, 8), "left");
  assert.equal(chooseCanvasSubmenuSide({ left: 480, right: 650 }, { left: 300, right: 720 }, 247, 8), "left");

  const component = await readFile(contextMenuComponentPath, "utf8");
  const sideChoice = component.indexOf("setSubmenuSide(chooseCanvasSubmenuSide(");
  const firstRender = component.indexOf("setLauncherOpen(true)", sideChoice);
  assert.ok(sideChoice >= 0 && firstRender > sideChoice);
  assert.doesNotMatch(component, /requestAnimationFrame/);
});

test("context menus stay inside the canvas viewport", () => {
  assert.deepEqual(
    clampCanvasMenuPosition({ x: 790, y: 590 }, { width: 800, height: 600 }, { width: 300, height: 380 }),
    { x: 488, y: 208 }
  );
  assert.deepEqual(
    clampCanvasMenuPosition({ x: -20, y: -10 }, { width: 800, height: 600 }),
    { x: 12, y: 12 }
  );
});
