import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { afterNextPaint, loadCriticalSnapshot } from "../src/renderer/src/lib/bootSequence.ts";

// Renderer startup: the canvas mounts once the critical snapshot is in (never under a loader with fallback data), and
// restored surfaces plus optional work start only after that first stable frame was painted.

const appPath = new URL("../src/renderer/src/App.tsx", import.meta.url);
const canvasPath = new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test("the critical snapshot asks for its four parts at once and for nothing optional", async () => {
  const pending = { settings: deferred(), availability: deferred(), sessions: deferred(), plugins: deferred() };
  const calls = [];
  const optional = () => { throw new Error("optional work must not be part of the first frame"); };
  const api = {
    settings: { get: () => { calls.push("settings"); return pending.settings.promise; } },
    agents: { availability: () => { calls.push("availability"); return pending.availability.promise; } },
    terminal: { list: () => { calls.push("sessions"); return pending.sessions.promise; } },
    plugins: { list: () => { calls.push("plugins"); return pending.plugins.promise; } },
    browser: { open: optional, getState: optional },
    media: { read: optional },
    limits: { get: optional }
  };
  const snapshot = loadCriticalSnapshot(api);
  assert.deepEqual(calls, ["settings", "availability", "sessions", "plugins"], "all four are in flight before any answers");
  pending.sessions.resolve([{ id: "s1" }]);
  pending.plugins.resolve([]);
  pending.availability.resolve({ codex: true });
  pending.settings.resolve({ locale: "en" });
  assert.deepEqual(await snapshot, { settings: { locale: "en" }, availability: { codex: true }, sessions: [{ id: "s1" }], plugins: [] });
});

test("afterNextPaint runs after the frame that shows the commit, and cancels cleanly", () => {
  const frames = [];
  let nextHandle = 0;
  const schedule = (callback) => { frames.push(callback); nextHandle += 1; return nextHandle; };
  const cancelled = [];
  const cancel = (handle) => cancelled.push(handle);
  const runFrame = () => frames.shift()();

  let ran = 0;
  afterNextPaint(() => { ran += 1; }, schedule, cancel);
  runFrame();
  assert.equal(ran, 0, "the first animation frame is the one that paints the commit");
  runFrame();
  assert.equal(ran, 1);

  const stop = afterNextPaint(() => { ran += 1; }, schedule, cancel);
  runFrame();
  stop();
  assert.deepEqual(cancelled, [4], "an unmount between the two frames cancels the pending one");
  stop();
  assert.deepEqual(cancelled, [4]);
});

test("App mounts the canvas only with the snapshot and the heavy surfaces only after the first stable frame", async () => {
  const source = await readFile(appPath, "utf8");
  assert.match(source, /\{ready && <WorkspaceCanvas\s+surfacesMounted=\{surfacesMounted\}/, "no canvas under the loader");
  assert.match(source, /loadCriticalSnapshot\(window\.canvasTTY\)[\s\S]*?\.finally\(\(\) => active && setReady\(true\)\)/);
  const stable = source.slice(source.indexOf("return afterNextPaint(() => {"), source.indexOf("}, [ready]);"));
  assert.ok(stable.indexOf('markBootOnce("firstStableFrame")') < stable.indexOf("setSurfacesMounted(true)"));

  // Browser runtime, HOME media and limits wait for the surfaces phase.
  for (const call of ["browserApi.open()", "window.canvasTTY.media.read(mediaPath)", "window.canvasTTY.limits.get()"]) {
    const at = source.indexOf(call);
    assert.notEqual(at, -1, call);
    const effectStart = source.lastIndexOf("useEffect(() => {", at);
    assert.match(source.slice(effectStart, at), /if \(!surfacesMounted\) return;/, `${call} runs only after the first stable frame`);
  }
  assert.equal(source.match(/browserApi\.open\(\)/g).length, 1, "no browser runtime is created during the critical snapshot");
});

test("WorkspaceCanvas holds back xterm, plugin iframes and the browser view until surfaces may mount", async () => {
  const source = await readFile(canvasPath, "utf8");
  assert.match(source, /surfacesMounted = true\r?\n\s*\} = props;/);
  assert.match(source, /\{surfacesMounted && renderedSessions\.filter\(\(session\) => fullscreenSessionId !== session\.id\)\.map/);
  assert.match(source, /\{surfacesMounted && renderedPluginCanvas\.map/);
  assert.match(source, /\{surfacesMounted && renderedBrowserCanvas && \(\s*<Suspense fallback=\{null\}>\s*<BrowserCard/);
  assert.match(source, /\{surfacesMounted && renderedSessions\s*\.filter\(\(session\) => fullscreenSessionId === session\.id\)/);
  // HOME itself is not deferred: it is the first frame.
  const home = source.indexOf("<HomeZone");
  assert.doesNotMatch(source.slice(source.lastIndexOf("\n", home - 20), home), /surfacesMounted/);
});
