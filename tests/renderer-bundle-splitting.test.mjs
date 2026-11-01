import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// App.tsx used to statically import SettingsPanel and the launch/link dialogs, so their code (and
// everything they alone pull in, such as the plugin browser and shortcut editors) was parsed and
// evaluated as part of the single startup bundle before the canvas could paint. They are now behind
// React.lazy/import(), which esbuild's own bundler (also used, the same way, by uncaught-error-recovery
// and the fake-react test helper) can prove by code-splitting the real dependency graph: an on-demand
// chunk must exist for each, and the code reachable from App.js through ordinary (non-dynamic) imports
// must shrink accordingly.
const appEntry = fileURLToPath(new URL("../src/renderer/src/App.tsx", import.meta.url));

let bundled;

function bundleApp() {
  bundled ??= bundleAppOnce();
  return bundled;
}

async function bundleAppOnce() {
  // Only the dependency graph, byte counts and chunk text are inspected; esbuild can produce
  // them in memory without writing and deleting an entire renderer bundle.
  const { metafile, outputFiles } = await build({
    entryPoints: [appEntry],
    bundle: true,
    splitting: true,
    platform: "browser",
    format: "esm",
    // Match the production React branch and electron-vite 5's fallback renderer target.
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    target: "chrome142",
    charset: "utf8",
    outdir: "canvastty-bundle-split",
    write: false,
    metafile: true,
    logLevel: "silent",
    loader: { ".svg": "text", ".css": "empty", ".png": "empty", ".webp": "empty", ".ttf": "empty", ".woff2": "empty", ".ico": "empty" }
  });
  return { metafile, outputFiles };
}

function outputFor(metafile, suffix) {
  const [path] = Object.keys(metafile.outputs).filter((candidate) => candidate.endsWith(suffix));
  return path;
}

// Every chunk reachable from `entry` by a static `import` statement (not `import()`), i.e. the code
// that must be downloaded and evaluated before the entry module can run at all.
function staticallyReachableBytes(metafile, entry) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const imp of metafile.outputs[path].imports) {
      if (imp.kind === "import-statement") visit(imp.path);
    }
  };
  visit(entry);
  return { paths: seen, bytes: [...seen].reduce((sum, path) => sum + metafile.outputs[path].bytes, 0) };
}

test("Settings and the launch/link dialogs are split out of the app's static import graph", async () => {
  const { metafile } = await bundleApp();
  const appPath = outputFor(metafile, "App.js");
  assert.ok(appPath, "expected an App.js bundle output");

  const settingsPath = outputFor(metafile, "SettingsPanel.js") ?? Object.keys(metafile.outputs).find((p) => /SettingsPanel-/.test(p));
  const launchDialogPath = Object.keys(metafile.outputs).find((p) => /AgentLaunchDialog-/.test(p));
  const linkDialogPath = Object.keys(metafile.outputs).find((p) => /TerminalLinkDialog-/.test(p));
  assert.ok(settingsPath, "SettingsPanel must be emitted as its own on-demand chunk");
  assert.ok(launchDialogPath, "AgentLaunchDialog must be emitted as its own on-demand chunk");
  assert.ok(linkDialogPath, "TerminalLinkDialog must be emitted as its own on-demand chunk");
  const paletteChunk = Object.keys(metafile.outputs).find((p) => /CanvasCommandPalette-/.test(p));
  assert.ok(paletteChunk, "the canvas command palette must be emitted as its own on-demand chunk");
  const contextMenuChunk = Object.keys(metafile.outputs).find((p) => /CanvasContextMenu-/.test(p));
  assert.ok(contextMenuChunk, "the canvas context menu must be emitted as its own on-demand chunk");

  const { paths: eagerPaths, bytes: eagerBytes } = staticallyReachableBytes(metafile, appPath);
  assert.ok(!eagerPaths.has(settingsPath), "SettingsPanel must only be reachable through a dynamic import()");
  assert.ok(!eagerPaths.has(launchDialogPath), "AgentLaunchDialog must only be reachable through a dynamic import()");
  assert.ok(!eagerPaths.has(linkDialogPath), "TerminalLinkDialog must only be reachable through a dynamic import()");
  assert.ok(!eagerPaths.has(paletteChunk), "the command palette must only be reachable through a dynamic import()");
  assert.ok(!eagerPaths.has(contextMenuChunk), "the canvas context menu must only be reachable through a dynamic import()");

  const settingsInputs = new Set([...staticallyReachableBytes(metafile, settingsPath).paths]
    .flatMap((path) => Object.keys(metafile.outputs[path].inputs)));
  for (const module of ["SettingsPanel", "UpdateSettings"]) {
    assert.ok([...settingsInputs].some((path) => path.endsWith(`/features/settings/${module}.tsx`)),
      `${module} must belong to the lazy settings graph`);
  }

  // Keep the PR's production first-paint budget; development React code is not shipped.
  assert.ok(
    eagerBytes < 1_100_000,
    `code statically reachable from App.js should stay bounded now that heavy UI loads on demand, got ${eagerBytes} bytes`
  );
});

// Text that only Settings shows is kept next to it (not in the startup string table), so it loads with the Settings
// chunk. Each entry: a module that must not be statically reachable from App.js, and an English string from it that
// must not appear in any chunk App.js loads at startup.
const SETTINGS_ONLY_TEXT = [
  ["src/renderer/src/features/plugins/PluginSettingsSection.tsx", "GitHub sign-in could not be cancelled"]
];

test("text that only Settings shows stays out of the startup bundle", async () => {
  const { metafile, outputFiles } = await bundleApp();
  const { paths: eagerPaths } = staticallyReachableBytes(metafile, outputFor(metafile, "App.js"));
  const textOf = (path) => outputFiles.find((file) => file.path.replaceAll("\\", "/").endsWith(`/${path}`))?.text ?? "";
  const eagerText = [...eagerPaths].map(textOf).join("\n");
  assert.ok(eagerText.length > 0, "the startup chunks must be readable");
  for (const [module, text] of SETTINGS_ONLY_TEXT) {
    const holders = Object.entries(metafile.outputs).filter(([, output]) => Object.keys(output.inputs).some((input) => input.endsWith(module)));
    assert.ok(holders.length > 0, `${module} is bundled`);
    for (const [path] of holders) {
      assert.ok(!eagerPaths.has(path), `${module} must only load with Settings`);
      assert.ok(textOf(path).includes(text), `"${text}" must be bundled with ${module}`);
    }
    assert.ok(!eagerText.includes(text), `"${text}" must not be in the startup bundle`);
  }
});
