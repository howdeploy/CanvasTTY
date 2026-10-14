import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The context menu and the command palette are kept out of the startup bundle (renderer-bundle-splitting), but a
// lazy() behind <Suspense> made their first open wait about 300 ms (React holds a suspended boundary's reveal that
// long). They are preloaded once the canvas is idle and rendered directly: once loaded, the very first render of an
// open menu or palette already contains it. Rendered here with the real React and react-dom/server, through the real
// dynamic imports of canvasOverlaySurfaces.
const root = fileURLToPath(new URL("..", import.meta.url));

async function loadBundle(t) {
  const outdir = await mkdtemp(join(tmpdir(), "canvastty-surfaces-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await build({
    stdin: {
      contents: [
        'export { canvasContextMenuSurface, canvasCommandPaletteSurface } from "./src/renderer/src/features/workspace/canvasOverlaySurfaces";',
        'export { preloadedSurface, preloadWhenIdle, usePreloadedSurface } from "./src/renderer/src/lib/preloadedSurface";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server";'
      ].join("\n"),
      resolveDir: root,
      loader: "ts"
    },
    jsx: "automatic",
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(outdir, "surfaces.cjs"),
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".svg": "text", ".css": "empty", ".png": "empty", ".ttf": "empty", ".woff2": "empty", ".ico": "empty" }
  });
  return createRequire(import.meta.url)(join(outdir, "surfaces.cjs"));
}

const noop = () => undefined;
const menuProps = {
  kind: "empty", position: { x: 40, y: 40 }, locale: "en", launcherItems: [], currentRegionColor: null,
  materialHasLocation: false, onSendMaterial: null, onSendRemarks: null,
  ...Object.fromEntries([
    "onCreateRegion", "onCreateNote", "onLaunch", "onOpenBrowser", "onOpenFiles", "onOpenSettings", "onRenameRegion",
    "onChangeRegionColor", "onDeleteRegion", "onEditNote", "onBringNoteToFront", "onDeleteNote", "onAddFiles",
    "onPasteFiles", "onPinMaterial", "onRevealMaterial", "onCopyMaterialPath", "onBringMaterialToFront",
    "onRemoveMaterial", "onClose"
  ].map((name) => [name, noop]))
};
const paletteProps = {
  locale: "en", sessions: [], launcherItems: [],
  ...Object.fromEntries([
    "onFocusSession", "onLaunch", "onCreateRegion", "onCreateNote", "onAddFiles", "onPasteFiles", "onFitCanvas",
    "onOpenBrowser", "onOpenFiles", "onOpenSettings", "onClose"
  ].map((name) => [name, noop]))
};

test("a preloaded context menu and command palette render on their first open, with no Suspense wait", async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { canvasTTY: { window: { isMacOS: false } } };
  t.after(() => { globalThis.window = previousWindow; });
  const bundle = await loadBundle(t);
  const { createElement, renderToStaticMarkup, usePreloadedSurface, canvasContextMenuSurface, canvasCommandPaletteSurface } = bundle;
  // The canvas's own pattern: `{open && Surface && <Surface ... />}`.
  const Host = ({ surface, open, props }) => {
    const Surface = usePreloadedSurface(surface, open);
    return open && Surface ? createElement(Surface, props) : null;
  };
  const render = (surface, open, props) => renderToStaticMarkup(createElement(Host, { surface, open, props }));

  assert.equal(canvasContextMenuSurface.loaded(), null, "nothing is loaded at startup");
  assert.equal(render(canvasContextMenuSurface, true, menuProps), "", "an open before the preload renders nothing until its chunk arrives");

  const [menuLoad, paletteLoad] = [canvasContextMenuSurface.load(), canvasCommandPaletteSurface.load()];
  assert.equal(canvasContextMenuSurface.load(), menuLoad, "one load per surface");
  await Promise.all([menuLoad, paletteLoad]);

  const menu = render(canvasContextMenuSurface, true, menuProps);
  assert.match(menu, /^<div[^>]*class="canvas-menu"/u, "the first render of the open menu contains the menu");
  assert.match(menu, /role="menuitem"/u);
  const palette = render(canvasCommandPaletteSurface, true, paletteProps);
  assert.match(palette, /canvas-command-palette/u, "the first render of the open palette contains the palette");
  assert.equal(render(canvasContextMenuSurface, false, menuProps), "", "a closed menu renders nothing");
});

test("preloadWhenIdle loads after the first paint when the app is idle; a failed load is tried again", async (t) => {
  const bundle = await loadBundle(t);
  const { preloadedSurface, preloadWhenIdle } = bundle;
  let calls = 0, fail = true;
  const surface = preloadedSurface(async () => {
    calls++;
    if (fail) throw new Error("chunk failed");
    return "loaded";
  });
  const idle = [];
  const previousWindow = globalThis.window;
  globalThis.window = { requestIdleCallback: (callback, options) => { idle.push({ callback, options }); return idle.length; }, cancelIdleCallback: noop };
  t.after(() => { globalThis.window = previousWindow; });
  preloadWhenIdle([surface]);
  assert.equal(calls, 0, "nothing loads before the browser is idle");
  assert.equal(idle.length, 1);
  assert.ok(idle[0].options.timeout > 0, "bounded: it still loads on a busy start");
  idle[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(surface.loaded(), null, "a failed preload leaves nothing loaded");
  fail = false;
  assert.equal(await surface.load(), "loaded", "the next open loads it again");
  assert.equal(calls, 2);
  assert.equal(surface.loaded(), "loaded");
});

test("the canvas renders the menu and the palette through the preloaded surfaces, not lazy() and Suspense", async () => {
  const source = await readFile(join(root, "src/renderer/src/features/workspace/WorkspaceCanvas.tsx"), "utf8");
  assert.doesNotMatch(source, /lazy\(\(\) => import\("\.\/Canvas(ContextMenu|CommandPalette)"\)/u);
  assert.doesNotMatch(source, /import \{ Canvas(ContextMenu|CommandPalette) \} from/u, "no static import either");
  assert.match(source, /usePreloadedSurface\(canvasContextMenuSurface, contextMenu !== null\)/u);
  assert.match(source, /usePreloadedSurface\(canvasCommandPaletteSurface, commandPaletteOpen\)/u);
  assert.match(source, /preloadWhenIdle\(\[canvasContextMenuSurface, canvasCommandPaletteSurface\]\)/u);
  assert.match(source, /\{contextMenu && CanvasContextMenu && \(\n\s*<CanvasContextMenu\n/u);
  assert.match(source, /\{commandPaletteOpen && CanvasCommandPalette && \(\n\s*<CanvasCommandPalette\n/u);
});
