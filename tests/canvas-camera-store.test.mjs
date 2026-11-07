import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  createCameraStore,
  fixedCameraStore,
  sceneTransform,
  summaryScaleForZoom
} from "../src/renderer/src/features/workspace/cameraStore.ts";

// The camera moves on every pan or zoom event. It lives in a store, not in React state, so a move renders
// nothing but the parts that subscribe to it; this pins the store and where the app reads it.

const source = (path) => readFile(new URL(`../src/renderer/src/${path}`, import.meta.url), "utf8");

test("the store notifies synchronously, in order, and only on a real change", () => {
  const store = createCameraStore({ x: 0, y: 0, zoom: 1 });
  const seen = [];
  const stopA = store.subscribe(() => seen.push(["a", store.get()]));
  store.subscribe(() => seen.push(["b", store.get().zoom]));
  store.set({ x: 5, y: 0, zoom: 1 });
  assert.deepEqual(seen, [["a", { x: 5, y: 0, zoom: 1 }], ["b", 1]]);
  store.set({ x: 5, y: 0, zoom: 1 }); // same values: nothing to render
  store.set(store.get());
  assert.equal(seen.length, 2);
  stopA();
  store.set({ x: 5, y: 0, zoom: 0.5 });
  assert.deepEqual(seen.slice(2), [["b", 0.5]]);
});

test("a fixed camera never changes and never notifies", () => {
  const store = fixedCameraStore({ x: 0, y: 0, zoom: 1 });
  let calls = 0;
  store.subscribe(() => calls++);
  store.set({ x: 9, y: 9, zoom: 2 });
  assert.deepEqual(store.get(), { x: 0, y: 0, zoom: 1 });
  assert.equal(calls, 0);
});

test("scene transform and summary scale keep their previous formulas", () => {
  assert.equal(sceneTransform({ x: 12.5, y: -3, zoom: 0.8 }), "translate(12.5px, -3px) scale(0.8)");
  assert.equal(summaryScaleForZoom(1), 1);
  assert.equal(summaryScaleForZoom(0.5), 1);
  assert.ok(summaryScaleForZoom(0.49) > 1);
  assert.equal(summaryScaleForZoom(0.25), 2);
  assert.equal(summaryScaleForZoom(0.1), 2.5);
});

test("App keeps the camera out of state and the workspace writes the scene transform directly", async () => {
  const app = await source("App.tsx");
  assert.doesNotMatch(app, /useState<CameraState>/u);
  assert.match(app, /createCameraStore\(homeCamera\(DEFAULT_HOME_GRID_SIZE\)\)/u);
  const workspace = await source("features/workspace/WorkspaceCanvas.tsx");
  assert.match(workspace, /<div ref=\{scene\} className="workspace__scene">/u);
  assert.doesNotMatch(workspace, /camera\.zoom\}/u, "no card gets a zoom number that changes per event");
  assert.match(workspace, /scene\.current\.style\.transform = sceneTransform\(camera\.get\(\)\)/u);
});

test("cards read the zoom from the store: drags when they move, rendering only derived values", async () => {
  for (const path of ["features/terminal/TerminalCard.tsx", "features/plugins/PluginCanvasCard.tsx",
    "features/notes/StickyNoteCard.tsx", "features/workspace/CanvasRegionCard.tsx", "features/browser/BrowserCard.tsx"]) {
    const card = await source(path);
    assert.doesNotMatch(card, /\bzoom: number;/u, path);
    assert.doesNotMatch(card, /\) \/ zoom\b/u, `${path}: drag math reads the live zoom`);
  }
  const terminal = await source("features/terminal/TerminalCard.tsx");
  assert.match(terminal, /useCameraSelector\(camera, \(current\) => current\.zoom < SUMMARY_ZOOM\)/u);
  assert.doesNotMatch(terminal, /useCameraSelector\(camera, \(current\) => summaryScaleForZoom/u);
  assert.match(terminal, /"--summary-scale": "var\(--terminal-summary-scale, 1\)"/u);
  assert.match(terminal, /useCameraSelector\(camera, \(current\) => current\.zoom <= WEBGL_MAX_SCALE\)/u);
});

test("the scene scales six terminal summaries without changing their React snapshots", async () => {
  const camera = createCameraStore({ x: 0, y: 0, zoom: 0.4 });
  const writes = [];
  const scene = { current: { style: { setProperty: (...args) => writes.push(args) } } };
  const workspace = await source("features/workspace/WorkspaceCanvas.tsx");
  const body = workspace.slice(workspace.indexOf("    let summaryScale = -1;"), workspace.indexOf("\n  }, [camera]);"));
  const unsubscribe = runInNewContext(stripTypeScriptTypes(`(function () { ${body} })()`), {
    camera, scene, sceneTransform, summaryScaleForZoom,
    webglContextPool: () => ({ viewportChanged() {} })
  });
  let cardUpdates = 0;
  const cards = Array.from({ length: 6 }, () => {
    let snapshot = camera.get().zoom < 0.5;
    return camera.subscribe(() => {
      const next = camera.get().zoom < 0.5;
      if (next !== snapshot) { cardUpdates++; snapshot = next; }
    });
  });
  for (const zoom of [0.41, 0.42, 0.45, 0.49]) camera.set({ x: 0, y: 0, zoom });
  assert.equal(cardUpdates, 0);
  assert.deepEqual(writes.at(-1), ["--terminal-summary-scale", String(0.5 / 0.49)]);
  const count = writes.length;
  camera.set({ ...camera.get(), x: 50 });
  assert.equal(writes.length, count, "pan leaves summary scale alone");
  camera.set({ ...camera.get(), zoom: 0.5 });
  assert.equal(cardUpdates, 6, "each card changes mode once at the boundary");
  assert.deepEqual(writes.at(-1), ["--terminal-summary-scale", "1"]);
  unsubscribe();
  cards.forEach((dispose) => dispose());
});
