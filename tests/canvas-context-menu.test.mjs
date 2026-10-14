import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  clampCanvasMenuPosition,
  routeCanvasContextMenu
} from "../src/renderer/src/features/workspace/canvasContextRouting.ts";
import {
  canvasMenuPlacementClearOfPanels,
  canvasMenuTopClearOfPanels,
  chooseCanvasSubmenuPlacement,
  chooseCanvasSubmenuSide
} from "../src/renderer/src/features/workspace/canvasMenuPlacement.ts";

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

test("a context menu opened near a corner panel moves up off it, and its submenu chevrons point where they open", async () => {
  // Home/zoom controls in the bottom-left corner; the menu was clamped to the bottom of a 856 px canvas.
  const controls = { left: 18, top: 838, right: 170, bottom: 882 };
  const hints = { left: 1100, top: 615, right: 1420, bottom: 882 };
  const menu = { left: 60, top: 531, right: 272, bottom: 856 };
  assert.equal(canvasMenuTopClearOfPanels(menu, [controls, hints], 12, 8), 838 - 8 - 325);
  assert.equal(canvasMenuTopClearOfPanels({ ...menu, left: 300, right: 512 }, [controls, hints], 12, 8), 531, "clear of every panel: unchanged");
  assert.equal(canvasMenuTopClearOfPanels(menu, [controls], 600, 8), 531, "no room above: it keeps its place (drawn above the panel)");
  // Up off one panel and then above a second one where it fits; when it cannot clear both it keeps its place.
  assert.equal(canvasMenuTopClearOfPanels(menu, [controls, { left: 18, top: 480, right: 170, bottom: 520 }], 12, 8), 480 - 8 - 325);
  assert.equal(canvasMenuTopClearOfPanels(menu, [controls, { left: 18, top: 300, right: 170, bottom: 520 }], 12, 8), 531);

  const component = await readFile(contextMenuComponentPath, "utf8");
  assert.match(component, /useLayoutEffect\(\(\) => \{[\s\S]*canvasMenuPlacementClearOfPanels\([\s\S]*\}, \[kind, position\.x, position\.y\]\);/);
  assert.match(component, /useLayoutEffect\(\(\) => \{\n    chooseSubmenuSide\(\);\n  \}, \[kind, place\.left, place\.top\]\);/);
  assert.match(component, /style=\{\{ left: place\.left, top: place\.top \}\}/);
  assert.equal(component.match(/right=\{<CanvasMenuChevron side=\{submenuSide\} \/>\}/g)?.length, 2, "Launch agent and Tools");
  const styles = await readFile(new URL("../src/renderer/src/styles/app.css", import.meta.url), "utf8");
  assert.match(styles, /\.canvas-menu__chevron--right \{ transform: rotate\(-90deg\); \}/);
  assert.match(styles, /\.canvas-menu__chevron--left \{ transform: rotate\(90deg\); \}/);
  // Menus (and their submenus, inside them) are drawn above the passive corner panels.
  const z = (selector) => Number(styles.match(new RegExp(`\\n${selector.replace(".", "\\.")} \\{[^}]*z-index: (\\d+)`))?.[1]);
  assert.ok(z(".canvas-menu") > z(".canvas-overlays"));
});

test("at a large UI scale a menu that cannot move up off the corner panels moves sideways instead", () => {
  // 1.25: minimap top right, shortcut hints bottom right; the menu is too tall to fit between them.
  const minimap = { left: 1232, top: 62, right: 1422, bottom: 184 };
  const hints = { left: 1100, top: 615, right: 1420, bottom: 882 };
  const menu = { left: 1055, top: 365, right: 1365, bottom: 845 };
  const bounds = { minTop: 12, minLeft: 12, maxRight: 1428 };
  assert.equal(canvasMenuTopClearOfPanels(menu, [minimap, hints], 12, 8), 365, "up is not possible");
  assert.deepEqual(canvasMenuPlacementClearOfPanels(menu, [minimap, hints], bounds, 8), { left: 1100 - 8 - 310, top: 365 });
  // Up still comes first when it works, and a menu clear of every panel stays put.
  const low = { left: 60, top: 531, right: 272, bottom: 856 };
  const controls = { left: 18, top: 838, right: 170, bottom: 882 };
  assert.deepEqual(canvasMenuPlacementClearOfPanels(low, [controls, hints], bounds, 8), { left: 60, top: 838 - 8 - 325 });
  assert.deepEqual(canvasMenuPlacementClearOfPanels({ ...low, left: 300, right: 512 }, [controls, hints], bounds, 8), { left: 300, top: 531 });
  // No room on either side: it keeps its place.
  assert.deepEqual(canvasMenuPlacementClearOfPanels(menu, [minimap, { ...hints, left: 20 }], bounds, 8), { left: 1055, top: 365 });
});

test("a submenu opens where it covers no corner panel, wherever Settings put the panels", async () => {
  // UI scale 1.25 (16.25 px font) in a 1440 x 900 window: the menu was opened near the right edge, its Tools row is
  // low, and the shortcut hints sit in the bottom-right corner, the minimap top right, Home/zoom bottom left.
  const area = { left: 0, top: 44, right: 1440, bottom: 900 };
  const hints = { left: 1035, top: 615, right: 1422, bottom: 882 };
  const minimap = { left: 1232, top: 62, right: 1422, bottom: 184 };
  const controls = { left: 18, top: 840, right: 168, bottom: 882 };
  const tools = { left: 722, top: 722, right: 1014, bottom: 770 };
  const size = { width: 309, height: 263 };
  const metrics = { gap: 9, offset: 7, clearance: 10 };
  // Room on the right, so the side rule alone opened it there, upward, over the hints panel.
  assert.equal(chooseCanvasSubmenuSide(tools, area, size.width, metrics.gap), "right");
  assert.deepEqual(chooseCanvasSubmenuPlacement(tools, size, area, [hints, minimap, controls], metrics, true),
    { side: "left", up: true });
  // Without panels in the way it keeps the side with room and goes up only when down runs off the canvas.
  assert.deepEqual(chooseCanvasSubmenuPlacement(tools, size, area, [], metrics, true), { side: "right", up: true });
  assert.deepEqual(chooseCanvasSubmenuPlacement({ ...tools, top: 300, bottom: 348 }, size, area, [hints], metrics, true),
    { side: "right", up: false });
  // Hints moved to the bottom-left corner: the right side is clear again.
  const hintsLeft = { left: 18, top: 615, right: 405, bottom: 882 };
  assert.deepEqual(chooseCanvasSubmenuPlacement(tools, size, area, [hintsLeft, minimap], metrics, true),
    { side: "right", up: true });
  // Up blocked by the panel but down fits: it opens down on the same side.
  const tall = { left: 1035, top: 120, right: 1422, bottom: 420 };
  assert.deepEqual(chooseCanvasSubmenuPlacement({ ...tools, top: 380, bottom: 428 }, size, area, [tall], metrics, true),
    { side: "left", up: false });
  // The launcher submenu never opens up; with no clear place at all the preferred place stays.
  assert.deepEqual(chooseCanvasSubmenuPlacement(tools, size, area, [hints], metrics, false), { side: "right", up: false });
  const everywhere = { left: 0, top: 44, right: 1440, bottom: 900 };
  assert.deepEqual(chooseCanvasSubmenuPlacement(tools, size, area, [everywhere], metrics, true), { side: "right", up: true });

  const component = await readFile(contextMenuComponentPath, "utf8");
  assert.match(component, /chooseCanvasSubmenuPlacement\(anchor\.getBoundingClientRect\(\),[\s\S]*cornerPanelRects\(workspace\)[\s\S]*toolsOpen\);\n    setSubmenuSide\(placement\.side\);\n    if \(toolsOpen\) setToolsUp\(placement\.up\);\n  \}, \[launcherOpen, toolsOpen, ToolsMenu, place\.left, place\.top\]\);/);
});
