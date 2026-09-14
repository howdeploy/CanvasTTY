import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startupPageUrl } from "../src/main/startupPage.ts";

const mainPath = new URL("../src/main/index.ts", import.meta.url);

test("main process acquires the single-instance lock before readiness", async () => {
  const source = await readFile(mainPath, "utf8");
  const lock = source.indexOf("app.requestSingleInstanceLock()");
  const ready = source.indexOf("app.whenReady()");

  assert.notEqual(lock, -1);
  assert.notEqual(ready, -1);
  assert.ok(lock < ready);
  // R4: a rejected second launch raises the window of the running instance
  // instead of exiting silently.
  const handlerStart = source.indexOf('app.on("second-instance"');
  assert.notEqual(handlerStart, -1);
  const secondInstance = source.slice(handlerStart, source.indexOf('app.on("before-quit"'));
  assert.match(secondInstance, /\.restore\(\)/);
  assert.match(secondInstance, /\.show\(\)/);
  assert.match(secondInstance, /\.focus\(\)/);
});

test("background plugin requests never activate the desktop window", async () => {
  const source = await readFile(mainPath, "utf8");
  const launcher = source.slice(
    source.indexOf("function requestPluginLauncher"),
    source.indexOf("function requestPluginCanvas")
  );
  const canvas = source.slice(
    source.indexOf("function requestPluginCanvas"),
    source.indexOf("function broadcastPluginStorageChange")
  );

  for (const route of [launcher, canvas]) {
    assert.match(route, /webContents\.send/);
    assert.doesNotMatch(route, /\.focus\(\)|\.show\(\)|\.restore\(\)/);
  }
});

test("startup window is visible immediately and failures remain visible", async () => {
  const source = await readFile(mainPath, "utf8");

  assert.match(source, /show: true/);
  assert.match(source, /startupPageUrl\(\{ locale: app\.getLocale\(\), isMacOS: process\.platform === "darwin" \}\)/);
  assert.match(source, /showStartupFailure/);
  assert.doesNotMatch(source, /ready-to-show/);
});

test("startup failure page escapes diagnostic text", () => {
  const url = startupPageUrl({ locale: "ru", isMacOS: false, error: '<script>alert("x")</script>' });
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));

  assert.match(html, /CanvasTTY не удалось запустить/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("macOS startup page reserves space for native traffic lights", () => {
  const url = startupPageUrl({ locale: "en", isMacOS: true });
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));

  assert.match(html, /--titlebar-height: 32px;/);
  assert.match(html, /grid-template-rows: var\(--titlebar-height\) 1fr/);
  assert.match(html, /padding-left: 78px/);
  assert.doesNotMatch(html, /traffic-light/);
});
