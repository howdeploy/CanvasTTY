import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function bundleApp() {
  const outdir = await mkdtemp(join(tmpdir(), "canvastty-bundle-split-"));
  try {
    const { metafile } = await build({
      entryPoints: [appEntry],
      bundle: true,
      splitting: true,
      platform: "browser",
      format: "esm",
      outdir,
      write: true,
      metafile: true,
      logLevel: "silent",
      loader: { ".svg": "text", ".css": "empty", ".png": "empty", ".ttf": "empty", ".woff2": "empty", ".ico": "empty" }
    });
    return metafile;
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
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
  const metafile = await bundleApp();
  const appPath = outputFor(metafile, "App.js");
  assert.ok(appPath, "expected an App.js bundle output");

  const settingsPath = outputFor(metafile, "SettingsPanel.js") ?? Object.keys(metafile.outputs).find((p) => /SettingsPanel-/.test(p));
  const launchDialogPath = Object.keys(metafile.outputs).find((p) => /AgentLaunchDialog-/.test(p));
  const linkDialogPath = Object.keys(metafile.outputs).find((p) => /TerminalLinkDialog-/.test(p));
  assert.ok(settingsPath, "SettingsPanel must be emitted as its own on-demand chunk");
  assert.ok(launchDialogPath, "AgentLaunchDialog must be emitted as its own on-demand chunk");
  assert.ok(linkDialogPath, "TerminalLinkDialog must be emitted as its own on-demand chunk");

  const { paths: eagerPaths, bytes: eagerBytes } = staticallyReachableBytes(metafile, appPath);
  assert.ok(!eagerPaths.has(settingsPath), "SettingsPanel must only be reachable through a dynamic import()");
  assert.ok(!eagerPaths.has(launchDialogPath), "AgentLaunchDialog must only be reachable through a dynamic import()");
  assert.ok(!eagerPaths.has(linkDialogPath), "TerminalLinkDialog must only be reachable through a dynamic import()");

  const settingsBytes = metafile.outputs[settingsPath].bytes;
  assert.ok(settingsBytes > 100_000, `SettingsPanel chunk should carry real weight, got ${settingsBytes} bytes`);

  // Before this change, App.tsx bundled to a single ~1.6 MB chunk with no on-demand chunk for
  // Settings, materials, and Files have on-demand UI, so first-paint code stays bounded.
  assert.ok(
    eagerBytes < 1_700_000,
    `code statically reachable from App.js should stay bounded now that heavy UI loads on demand, got ${eagerBytes} bytes`

  );
});
