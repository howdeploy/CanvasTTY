import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The card dialogs are kept out of the startup bundle, but a lazy() behind <Suspense> made their first open wait
// about 300 ms (React holds a suspended boundary's reveal that long). App preloads them once it is idle and renders
// them directly: once loaded, the very first render of an open dialog already contains it. Rendered here with the
// real React and react-dom/server, through the real dynamic imports of cardDialogSurfaces.
const root = fileURLToPath(new URL("..", import.meta.url));
const LOADERS = { ".svg": "text", ".css": "empty", ".png": "empty", ".ttf": "empty", ".woff2": "empty", ".ico": "empty" };
const SURFACES = [
  { name: "change review", surface: "pluginReviewHostSurface", chunk: /PluginChangesReviewDialog-/u, props: {
    locale: "en", setRequest: () => undefined, showToast: () => undefined,
    request: { pluginId: "plugin", actionId: "review", sessionId: "card", cardTitle: "Card", review: {
      acceptActionId: "accept", rejectActionId: "reject", groups: [{ sessionId: "worker", title: "Worker", files: [{ path: "a.txt", diff: "+a", page: 0 }] }]
    } }
  } },
  { name: "rollback points", surface: "checkpointsHostSurface", chunk: /CheckpointsDialog-/u, props: {
    locale: "en", onClose: () => undefined, request: { sessionId: "card", cardTitle: "Card" }
  } }
];

async function loadBundle(t) {
  const outdir = await mkdtemp(join(tmpdir(), "canvastty-dialogs-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await build({
    stdin: {
      contents: [
        'export * from "./src/renderer/src/features/terminal/cardDialogSurfaces";',
        'export { usePreloadedSurface } from "./src/renderer/src/lib/preloadedSurface";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server";'
      ].join("\n"),
      resolveDir: root,
      loader: "ts"
    },
    jsx: "automatic", bundle: true, platform: "node", format: "cjs", outfile: join(outdir, "dialogs.cjs"), logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' }, loader: LOADERS
  });
  return createRequire(import.meta.url)(join(outdir, "dialogs.cjs"));
}

for (const entry of SURFACES) test(`a preloaded ${entry.name} dialog renders on its first open, with no Suspense wait`, async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout, requestAnimationFrame: () => 0, canvasTTY: { window: { isMacOS: false } } };
  t.after(() => { globalThis.window = previousWindow; });
  const bundle = await loadBundle(t);
  const surface = bundle[entry.surface];
  const { createElement, renderToStaticMarkup, usePreloadedSurface } = bundle;
  // App's own pattern: `{request && Host && <Host ... />}`.
  const Host = ({ open }) => {
    const Dialog = usePreloadedSurface(surface, open);
    return open && Dialog ? createElement(Dialog, entry.props) : null;
  };
  assert.equal(surface.loaded(), null, "nothing is loaded at startup");
  assert.equal(renderToStaticMarkup(createElement(Host, { open: true })), "", "an open before the preload renders nothing until its chunk arrives");
  await surface.load();
  assert.match(renderToStaticMarkup(createElement(Host, { open: true })), /<dialog[^>]*class="card-dialog /u,
    "the first render of the open dialog contains the dialog");
});

test("App renders the card dialogs through preloaded surfaces, and their code stays out of the startup bundle", async (t) => {
  const app = await readFile(join(root, "src/renderer/src/App.tsx"), "utf8");
  for (const entry of SURFACES) {
    const host = entry.surface.replace(/Surface$/u, "").replace(/^./u, (first) => first.toUpperCase());
    assert.doesNotMatch(app, new RegExp(`const ${host} = lazy\\(`, "u"), `${host} is not a lazy() behind Suspense`);
    assert.match(app, new RegExp(`const ${host} = usePreloadedSurface\\(${entry.surface}, `, "u"));
    assert.match(app, new RegExp(`preloadWhenIdle\\(\\[[^\\]]*${entry.surface}`, "u"), `${host} is preloaded once the app is idle`);
  }
  const outdir = await mkdtemp(join(tmpdir(), "canvastty-dialogs-split-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  const { metafile } = await build({
    entryPoints: [join(root, "src/renderer/src/App.tsx")], bundle: true, splitting: true, platform: "browser", format: "esm",
    outdir, write: true, metafile: true, logLevel: "silent", loader: LOADERS
  });
  const appPath = Object.keys(metafile.outputs).find((path) => path.endsWith("App.js"));
  const eager = new Set();
  const visit = (path) => {
    if (eager.has(path)) return;
    eager.add(path);
    for (const imported of metafile.outputs[path].imports) if (imported.kind === "import-statement") visit(imported.path);
  };
  visit(appPath);
  for (const entry of SURFACES) {
    const chunk = Object.keys(metafile.outputs).find((path) => entry.chunk.test(path));
    assert.ok(chunk, `the ${entry.name} dialog is its own chunk`);
    assert.ok(!eager.has(chunk), `the ${entry.name} dialog is reachable only through a dynamic import()`);
  }
});

test("preloadWhenIdle loads once the app is idle (bounded); a failed load is tried again by the next open", async (t) => {
  const { preloadedSurface, preloadWhenIdle } = await import("../src/renderer/src/lib/preloadedSurface.ts");
  let calls = 0, fail = true;
  const surface = preloadedSurface(async () => { calls++; if (fail) throw new Error("chunk failed"); return "loaded"; });
  const idle = [];
  const previousWindow = globalThis.window;
  globalThis.window = { requestIdleCallback: (callback, options) => idle.push({ callback, options }), cancelIdleCallback: () => undefined };
  t.after(() => { globalThis.window = previousWindow; });
  preloadWhenIdle([surface]);
  assert.equal(calls, 0, "nothing loads before the browser is idle");
  assert.ok(idle[0].options.timeout > 0);
  idle[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(surface.loaded(), null);
  fail = false;
  assert.equal(await surface.load(), "loaded");
  assert.equal(surface.load(), surface.load(), "one load once it succeeded");
  assert.equal(calls, 2);
});
