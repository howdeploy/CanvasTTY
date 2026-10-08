import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  isBrowserSmokeWheelReady,
  waitForBrowserSmokeWheelReady,
  runBrowserSmokeCleanup,
  requireBrowserSmokeScrollBaseline,
  freezeEndedBeforeIdle
} from "../src/main/services/browser/BrowserSmokeReadiness.ts";

const page = {
  readyState: "complete",
  visibilityState: "visible",
  focused: true,
  width: 820,
  height: 620,
  scrollY: 400,
  maxScrollY: 628
};
const ready = { ownerVisible: true, ownerFocused: true, page };
const point = { x: 700, y: 300 };

test("freeze smoke distinguishes a transition end from normal wheel idle", () => {
  const active = { active: true, dataUrlLength: 42, observedAt: 1_000 };
  assert.equal(freezeEndedBeforeIdle([active, { active: false, observedAt: 1_180 }], 1_000, 250), true);
  assert.equal(freezeEndedBeforeIdle([active, { active: false, observedAt: 1_249 }], 1_000, 250), true);
  assert.equal(freezeEndedBeforeIdle([active, { active: false, observedAt: 1_250 }], 1_000, 250), false);
  assert.equal(freezeEndedBeforeIdle([active, { active: false, observedAt: 1_260 }], 1_000, 250), false);
  assert.equal(freezeEndedBeforeIdle([{ active: false, observedAt: 900 }, active], 1_000, 250), false);
});

test("physical wheel smoke requires native window and document focus on a visible loaded page", () => {
  assert.equal(isBrowserSmokeWheelReady(ready), true);
  // The observed locked-display case has usable geometry but no actual window/document focus.
  assert.equal(isBrowserSmokeWheelReady({
    ...ready,
    ownerFocused: false,
    page: { ...page, visibilityState: "hidden", focused: false }
  }), false);
  assert.equal(isBrowserSmokeWheelReady({ ...ready, ownerVisible: false }), false);
  assert.equal(isBrowserSmokeWheelReady({ ...ready, page: { ...page, focused: false } }), false);
  assert.equal(isBrowserSmokeWheelReady({ ...ready, page: { ...page, visibilityState: "hidden" } }), false);
  // A navigation can be marked ready before its document has completed loading.
  assert.equal(isBrowserSmokeWheelReady({ ...ready, page: { ...page, readyState: "loading" } }), false);
});

test("physical wheel smoke establishes a real scroll baseline before accepting movement", () => {
  assert.equal(requireBrowserSmokeScrollBaseline(page, point, 400), 400);
  // The old comparison against 400 accepted the clamped position as movement without any wheel.
  assert.throws(() => requireBrowserSmokeScrollBaseline({
    ...page, height: 876, maxScrollY: 372, scrollY: 372
  }, point, 400), /could not establish scroll baseline 400/);
  assert.throws(() => requireBrowserSmokeScrollBaseline({ ...page, scrollY: 0 }, point, 400),
    /could not establish scroll baseline 400/);
});

test("physical wheel smoke rejects a target outside the actual page viewport", () => {
  assert.throws(() => requireBrowserSmokeScrollBaseline({ ...page, width: 410 }, point, 400),
    /outside the page viewport/);
  assert.throws(() => requireBrowserSmokeScrollBaseline(page, { x: 700, y: 620 }, 400),
    /outside the page viewport/);
  assert.throws(() => requireBrowserSmokeScrollBaseline({ ...page, width: NaN }, point, 400),
    /outside the page viewport/);
});

function fakeScheduler() {
  let now = 0;
  let nextId = 0;
  const scheduled = new Map();
  const schedule = (callback, delayMs) => {
    const id = ++nextId;
    scheduled.set(id, { callback, at: now + delayMs });
    return () => scheduled.delete(id);
  };
  const advance = async (delayMs) => {
    const target = now + delayMs;
    await Promise.resolve();
    for (;;) {
      const next = [...scheduled.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at;
      scheduled.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };
  return { schedule, advance, pending: () => scheduled.size };
}

test("physical wheel readiness waits for delayed native focus and cancels its deadline", async () => {
  const clock = fakeScheduler();
  let focused = false;
  let attempts = 0;
  const waiting = waitForBrowserSmokeWheelReady(async () => {
    attempts += 1;
    return { ...ready, ownerFocused: focused, page: { ...page, focused } };
  }, 120, clock.schedule);
  await clock.advance(50);
  assert.equal(attempts, 2);
  focused = true;
  await clock.advance(50);
  await waiting;
  assert.equal(attempts, 3);
  assert.equal(clock.pending(), 0);
});

test("physical wheel readiness times out a stalled page probe without further checks", async () => {
  const clock = fakeScheduler();
  let release;
  let attempts = 0;
  const waiting = waitForBrowserSmokeWheelReady(() => {
    attempts += 1;
    return new Promise((resolve) => { release = resolve; });
  }, 120, clock.schedule);
  const rejected = assert.rejects(waiting, /timed out after 120 ms/);
  await clock.advance(120);
  await rejected;
  release(ready);
  await clock.advance(1_000);
  assert.equal(attempts, 1);
  assert.equal(clock.pending(), 0);
});

test("physical wheel readiness immediately propagates a destroyed owner or tab", async () => {
  const clock = fakeScheduler();
  const waiting = waitForBrowserSmokeWheelReady(async () => {
    throw new Error("window or tab was destroyed while preparing input");
  }, 120, clock.schedule);
  await assert.rejects(waiting, /destroyed while preparing input/);
  assert.equal(clock.pending(), 0);
});

test("physical wheel readiness waits for loading and hidden documents", async () => {
  const clock = fakeScheduler();
  const states = [
    { ...ready, page: { ...page, readyState: "loading" } },
    { ...ready, page: { ...page, visibilityState: "hidden" } },
    ready
  ];
  let attempts = 0;
  const waiting = waitForBrowserSmokeWheelReady(async () => states[attempts++], 120, clock.schedule);
  await clock.advance(100);
  await waiting;
  assert.equal(attempts, 3);
  assert.equal(clock.pending(), 0);
});


test("physical wheel cleanup cancels its timer after success", async () => {
  const clock = fakeScheduler();
  let calls = 0;
  await runBrowserSmokeCleanup(async () => { calls += 1; }, 120, clock.schedule);
  assert.equal(calls, 1);
  assert.equal(clock.pending(), 0);
});

test("physical wheel cleanup swallows a renderer error and cancels its timer", async () => {
  const clock = fakeScheduler();
  await runBrowserSmokeCleanup(() => { throw new Error("renderer was destroyed"); }, 120, clock.schedule);
  assert.equal(clock.pending(), 0);
});

test("physical wheel cleanup times out a stalled renderer and tolerates its late rejection", async () => {
  const clock = fakeScheduler();
  let rejectRenderer;
  const cleanup = runBrowserSmokeCleanup(() => new Promise((resolve, reject) => {
    rejectRenderer = reject;
  }), 120, clock.schedule);
  await clock.advance(120);
  await cleanup;
  assert.equal(clock.pending(), 0);
  rejectRenderer(new Error("renderer eventually closed"));
  await clock.advance(1_000);
  assert.equal(clock.pending(), 0);
});


async function physicalWheelAssertionWith(context) {
  const source = await readFile(new URL("../src/main/services/browser/BrowserElectronSmoke.ts", import.meta.url), "utf8");
  const assertion = source.slice(source.indexOf("async function assertFocusAwarePhysicalWheel"),
    source.indexOf("async function assertBrowserOriginPanCrossesBoundary"));
  const helpers = source.slice(source.indexOf("async function browserSmokePageState"),
    source.indexOf("async function waitUntil"));
  return runInNewContext(`${stripTypeScriptTypes(assertion + helpers)}; assertFocusAwarePhysicalWheel`, {
    Error,
    process: { platform: "linux" },
    setTimeout,
    READY_TIMEOUT_MS: 20,
    CLEANUP_TIMEOUT_MS: 5,
    WHEEL_IDLE_SETTLE_MS: 1,
    waitForBrowserSmokeWheelReady,
    runBrowserSmokeCleanup,
    requireBrowserSmokeScrollBaseline,
    ...context
  });
}

async function withHarnessDeadline(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("outer harness timeout hid the readiness error")), 250);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("the actual physical wheel assertion preserves its readiness failure when both renderer cleanups hang", async () => {
  const requests = [];
  const stalled = () => new Promise(() => {});
  const contents = {
    getURL: () => "http://127.0.0.1/",
    isDestroyed: () => false,
    focus: () => undefined,
    executeJavaScript(source) {
      requests.push(source === "window.scrollTo(0, 0)" ? "fixture cleanup" : "fixture ready probe");
      return stalled();
    },
    sendInputEvent() { throw new Error("physical input was sent without a ready page"); }
  };
  const owner = {
    getParentWindow: () => null,
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    show: () => undefined,
    focus: () => undefined,
    webContents: {
      executeJavaScript(source) {
        if (!source.includes("delete globalThis.__canvasttyWheelRelays")) return Promise.resolve();
        requests.push("owner relay cleanup");
        return stalled();
      }
    }
  };
  const service = {
    setInputFocused: () => undefined,
    setCanvasWheelCaptureMode: () => undefined,
    setViewport: () => undefined
  };
  const assertion = await physicalWheelAssertionWith({
    webContents: { getAllWebContents: () => [contents] },
    BrowserWindow: { getAllWindows: () => [owner] }
  });
  await assert.rejects(withHarnessDeadline(assertion(service, contents.getURL())), (error) => {
    assert.match(error.message, /prerequisites were not met within 20 ms/);
    assert.match(error.cause.message, /readiness timed out after 20 ms/);
    return true;
  });
  assert.deepEqual(requests, ["fixture ready probe", "fixture cleanup", "owner relay cleanup"]);
});
