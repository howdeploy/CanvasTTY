import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/renderer/src/App.tsx", import.meta.url);
const stylesPath = new URL("../src/renderer/src/styles/app.css", import.meta.url);

test("plugin canvas apps open and refocus at native scale", async () => {
  const source = await readFile(appPath, "utf8");
  const nativeScaleFocusCalls = source.match(
    /focusCamera\([^)]*PLUGIN_CANVAS_FOCUS_ZOOM\)/g
  ) ?? [];

  assert.match(source, /const DEFAULT_FOCUS_ZOOM = 0\.92;/);
  assert.match(source, /const PLUGIN_CANVAS_FOCUS_ZOOM = 1;/);
  assert.equal(nativeScaleFocusCalls.length, 3);
  assert.match(source, /zoom = DEFAULT_FOCUS_ZOOM/);
});

test("plugin canvas iframe does not paint a bright host seam", async () => {
  const source = await readFile(stylesPath, "utf8");
  const frameRule = source.match(/\.plugin-canvas-card__frame\s*\{[^}]+\}/)?.[0] ?? "";

  assert.match(frameRule, /background:\s*transparent/);
  assert.doesNotMatch(frameRule, /background:\s*white/);
});

test("host image policy admits owned plugin icons without opening external or script sources", async () => {
  const html = await readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  const directives = new Map(policy.split(";").filter(part => part.trim()).map(part => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));
  assert.ok(directives.get("img-src").includes("canvastty-plugin:"));
  for (const source of directives.get("img-src")) assert.ok(["'self'", "data:", "blob:", "canvastty-plugin:"].includes(source));
  assert.deepEqual(directives.get("script-src"), ["'self'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'", "ws:"]);
});
