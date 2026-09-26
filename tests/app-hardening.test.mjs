import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");

test("the default session denies web permissions; the Browser keeps its own partition", () => {
  assert.match(main, /session\.defaultSession\.setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/);
  assert.match(main, /session\.defaultSession\.setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /session\.defaultSession\.setDevicePermissionHandler\(\(\) => false\)/);
});

test("a crashed renderer reloads only the application surface and a clean exit does not", () => {
  const handler = main.slice(main.indexOf('window.webContents.on("render-process-gone"'));
  assert.match(handler, /if \(details\.reason === "clean-exit"\) return;/);
  assert.match(handler, /void loadApplicationSurface\(window\)/);
  const reload = main.slice(main.indexOf("async function loadApplicationSurface"), main.indexOf("async function loadApplication("));
  assert.doesNotMatch(reload, /SMOKE/u, "smoke hooks run once at startup, not on recovery");
  assert.match(main, /app\.on\("child-process-gone"/);
});
