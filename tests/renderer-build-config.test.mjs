import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// electron-vite leaves bundles unminified by default; the renderer is parsed on every window load.
test("the renderer production bundle is minified, and source maps stay off", async () => {
  const config = await readFile(new URL("../electron.vite.config.ts", import.meta.url), "utf8");
  const renderer = config.slice(config.indexOf("renderer: {"));
  assert.match(renderer, /build: \{\s*minify: "esbuild"(?:,|\s*\})/u);
  assert.doesNotMatch(config, /sourcemap/u);
});
