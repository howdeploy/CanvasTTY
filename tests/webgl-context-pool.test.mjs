import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WEBGL_ACTIVITY_REPLAN_MS,
  WEBGL_CONTEXT_BUDGET,
  WEBGL_IDLE_MS,
  WEBGL_LOSS_BACKOFF_MS,
  WEBGL_MIN_HOLD_MS,
  WEBGL_SETTLE_MS,
  WebglContextPool,
  rankWebglCandidates,
  visibleArea
} from "../src/renderer/src/features/terminal/webglContextPool.ts";

// Terminal cards on screen draw with WebGL from a bounded pool of contexts; the rest keep xterm's DOM
// renderer. These tests drive the pool with a fake clock and fake cards.

function harness({ budget = 3, viewport = { width: 1000, height: 1000 } } = {}) {
  let now = 0;
  let timers = [];
  const log = [];
  const pool = new WebglContextPool({
    budget,
    now: () => now,
    viewport: () => viewport,
    schedule: (callback, ms) => {
      const timer = { at: now + ms, callback, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    }
  });
  const cards = new Map();
  const card = (id, rect, { eligible = true, focused = false, attachable = true, parkable = false } = {}) => {
    const state = { rect, attachable, attached: false, active: false, attaches: 0, detaches: 0, tries: 0 };
    state.unregister = pool.register(id, {
      measure: () => state.rect,
      attach: () => {
        state.tries += 1;
        if (!state.attachable) return false;
        state.attached = true; state.active = true; state.attaches += 1; log.push(`+${id}`);
        return true;
      },
      detach: () => { state.attached = false; state.active = false; state.detaches += 1; log.push(`-${id}`); },
      ...(parkable ? { setActive: (active) => { state.active = active; log.push(`${active ? "resume" : "park"}:${id}`); } } : {})
    });
    pool.update(id, { eligible, focused });
    cards.set(id, state);
    return state;
  };
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      now = next.at;
      next.callback();
    }
    now = until;
    timers = timers.filter((t) => t.live);
  };
  const attached = () => [...cards].filter(([, c]) => c.attached).map(([id]) => id).sort();
  return { pool, card, cards, advance, attached, log, viewport, setNow: (t) => { now = t; } };
}

const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });

test("zoom switches a warm card to DOM immediately and reuses its bounded context after settling", () => {
  const h = harness({ budget: 1 });
  const a = h.card("a", rect(0, 0, 100, 100), { parkable: true });
  h.advance(WEBGL_SETTLE_MS);
  for (let i = 0; i < 5; i++) {
    h.pool.viewportChanged();
    h.pool.update("a", { eligible: false, focused: false });
    assert.equal(a.active, false, "the upscaled raster stops drawing immediately");
    h.advance(WEBGL_SETTLE_MS);
    assert.deepEqual(h.pool.holders(), ["a"], "the parked context still counts against the budget");
    h.pool.update("a", { eligible: true, focused: false });
    h.advance(WEBGL_SETTLE_MS);
    assert.equal(a.active, true);
  }
  assert.equal(a.attaches, 1, "crossing zoom thresholds does not recompile shaders");
  assert.equal(a.detaches, 0);
  a.unregister();
  assert.equal(a.detaches, 1, "unmount really frees the parked or active context");
});

test("a parked context yields to another visible card before a new context is attached", () => {
  const h = harness({ budget: 1 });
  const a = h.card("a", rect(0, 0, 100, 100), { parkable: true });
  h.advance(WEBGL_SETTLE_MS);
  h.pool.update("a", { eligible: false, focused: false });
  h.card("b", rect(0, 0, 100, 100), { parkable: true });
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.pool.holders(), ["b"]);
  assert.equal(a.detaches, 1);
  assert.deepEqual(h.log.slice(-2), ["-a", "+b"]);
});

test("a plan measures all cards before detaching and tells off-screen cards to skip snapshots", () => {
  const events = [];
  let outside = false;
  const pool = new WebglContextPool({
    now: () => 0, viewport: () => ({ width: 100, height: 100 }),
    schedule: () => () => {}
  });
  for (const id of ["a", "b"]) {
    pool.register(id, {
      measure: () => {
        events.push(`measure:${id}`);
        return rect(outside && id === "a" ? 200 : 0, 0, 50, 50);
      },
      attach: () => true,
      detach: (visible) => events.push(`detach:${id}:${visible}`)
    });
    pool.update(id, { eligible: true, focused: false });
  }
  pool.plan();
  events.length = 0;
  outside = true;
  pool.plan();
  assert.deepEqual(events, ["measure:a", "measure:b", "detach:a:false"]);
  assert.deepEqual(pool.holders(), ["b"]);
  events.length = 0;
  pool.update("b", { eligible: false, focused: false });
  assert.deepEqual(events, ["measure:b", "detach:b:true"], "an on-screen transition can still preserve its last frame");
});

test("a zoom threshold checks current visibility rather than the pool's pre-pan area", () => {
  let outside = false;
  const snapshots = [];
  const pool = new WebglContextPool({
    now: () => 0, viewport: () => ({ width: 100, height: 100 }), schedule: () => () => {}
  });
  pool.register("a", {
    measure: () => rect(outside ? 200 : 0, 0, 50, 50),
    attach: () => true, detach: (visible) => snapshots.push(visible)
  });
  pool.update("a", { eligible: true, focused: false });
  pool.plan();
  outside = true;
  pool.viewportChanged();
  pool.update("a", { eligible: false, focused: false });
  assert.deepEqual(snapshots, [false]);
});

test("the budget stays below Chromium's 16 active WebGL contexts per renderer", () => {
  assert.ok(WEBGL_CONTEXT_BUDGET >= 8 && WEBGL_CONTEXT_BUDGET <= 12);
});

test("visible area is the part of the card inside the viewport", () => {
  const viewport = { width: 100, height: 100 };
  assert.equal(visibleArea(rect(0, 0, 50, 50), viewport), 2500);
  assert.equal(visibleArea(rect(80, 80, 50, 50), viewport), 400);
  assert.equal(visibleArea(rect(100, 0, 50, 50), viewport), 0);
  assert.equal(visibleArea(rect(-60, 0, 50, 50), viewport), 0);
  assert.equal(visibleArea(null, viewport), 0);
});

test("ranking: focused card first, then by on-screen area, then most recently used", () => {
  const c = (id, area, extra = {}) => ({ id, area, focused: false, holding: false, idle: false, pinned: false, lastUsed: 0, ...extra });
  assert.deepEqual(rankWebglCandidates([c("a", 100), c("b", 300), c("f", 10, { focused: true }), c("d", 200)], 3), ["f", "b", "d"]);
  // Off-screen cards never compete, even when focused.
  assert.deepEqual(rankWebglCandidates([c("a", 0, { focused: true }), c("b", 5)], 3), ["b"]);
  // Equal area: the most recently used wins.
  assert.deepEqual(rankWebglCandidates([c("old", 100, { lastUsed: 1 }), c("new", 100, { lastUsed: 9 })], 1), ["new"]);
});

test("nothing moves until the camera settles; then the focused and largest cards get contexts", () => {
  const h = harness({ budget: 2 });
  h.card("small", rect(0, 0, 100, 100));
  h.card("big", rect(200, 0, 400, 400));
  h.card("focus", rect(0, 500, 50, 50), { focused: true });
  assert.deepEqual(h.attached(), []);
  h.advance(WEBGL_SETTLE_MS - 1);
  assert.deepEqual(h.attached(), []);
  h.advance(1);
  assert.deepEqual(h.attached(), ["big", "focus"]);
});

test("a pan restarts the settle timer instead of reshuffling on every frame", () => {
  const h = harness({ budget: 1 });
  const a = h.card("a", rect(0, 0, 300, 300));
  const b = h.card("b", rect(2000, 0, 300, 300));
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a"]);
  // Forty frames of panning a out and b in, one viewport change per frame.
  for (let frame = 0; frame < 40; frame++) {
    a.rect = rect(-frame * 40, 0, 300, 300);
    b.rect = rect(2000 - frame * 40, 0, 300, 300);
    h.pool.viewportChanged();
    h.advance(16);
  }
  assert.equal(a.detaches + b.attaches, 0, "no context moved mid-pan");
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["b"]);
  assert.deepEqual(h.log, ["+a", "-a", "+b"]);
});

test("output replanning waits for the camera too: no context moves mid-pan, the swap comes once it is quiet", () => {
  const h = harness({ budget: 2 });
  h.card("a", rect(0, 0, 100, 100), { focused: true });
  h.card("b", rect(200, 0, 100, 100));
  h.card("c", rect(400, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a", "b"], "the pool is full and c waits");
  // b prints nothing and becomes idle; then output reaches c, which schedules an activity replan.
  h.advance(WEBGL_IDLE_MS);
  h.pool.touch("c");
  const before = h.log.length;
  // The camera moves every frame for longer than the activity replan delay, never quiet for the settle time.
  let panned = 0;
  for (; panned <= WEBGL_ACTIVITY_REPLAN_MS + 500; panned += 16) {
    h.pool.viewportChanged();
    h.pool.touch("c");
    h.advance(16);
  }
  assert.ok(panned > WEBGL_ACTIVITY_REPLAN_MS);
  assert.deepEqual(h.log.slice(before), [], "no context attached or detached while the camera moves");
  h.advance(WEBGL_SETTLE_MS - 17);
  assert.deepEqual(h.log.slice(before), [], "still inside the quiet interval after the last move");
  h.advance(1);
  assert.deepEqual(h.attached(), ["a", "c"], "the idle holder's slot goes to the busy card once the camera is still");
  assert.deepEqual(h.log.slice(before), ["-b", "+c"]);
});

test("an activity replan with the camera still also defers to a later move, and loss of eligibility stays immediate", () => {
  const h = harness({ budget: 1 });
  h.card("a", rect(0, 0, 100, 100));
  h.card("b", rect(200, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a"]);
  h.advance(WEBGL_IDLE_MS);
  h.pool.touch("b");
  // One camera move just before the activity replan is due pushes the swap to the end of the settle time.
  h.advance(WEBGL_ACTIVITY_REPLAN_MS - 50);
  h.pool.viewportChanged();
  h.advance(50);
  assert.deepEqual(h.attached(), ["a"]);
  h.advance(WEBGL_SETTLE_MS - 50);
  assert.deepEqual(h.attached(), ["b"]);
  // Mid-pan, a card losing eligibility still gives its context back at once.
  h.pool.viewportChanged();
  h.pool.update("b", { eligible: false, focused: false });
  assert.deepEqual(h.attached(), []);
});

test("a card leaving the screen or losing eligibility releases its context", () => {
  const h = harness({ budget: 3 });
  const a = h.card("a", rect(0, 0, 100, 100));
  h.card("b", rect(200, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a", "b"]);
  a.rect = rect(5000, 0, 100, 100);
  h.pool.viewportChanged();
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["b"]);
  // Zooming above the raster limit (or into summary mode) releases at once, without waiting.
  h.pool.update("b", { eligible: false, focused: false });
  assert.deepEqual(h.attached(), []);
  // Not rendered at all (hidden layer): measure() reports null.
  h.pool.update("b", { eligible: true, focused: false });
  h.cards.get("b").rect = null;
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), []);
});

test("over budget, the least recently used card gives way; equal cards do not trade places", () => {
  const h = harness({ budget: 2 });
  h.card("a", rect(0, 0, 100, 100));
  h.card("b", rect(200, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a", "b"]);
  h.advance(5_000);
  h.pool.touch("a");
  h.card("c", rect(400, 0, 100, 100));
  h.pool.touch("c");
  h.advance(WEBGL_SETTLE_MS);
  // c is as large as the holders, and holders win ties: nothing moves.
  assert.deepEqual(h.attached(), ["a", "b"]);
  // Focus on c takes the slot of the least recently used holder, b.
  h.pool.update("c", { eligible: true, focused: true });
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a", "c"]);
  // Focus moves back and forth: each change costs at most one swap, never a cascade.
  const before = h.log.length;
  h.pool.update("c", { eligible: true, focused: false });
  h.pool.update("b", { eligible: true, focused: true });
  h.advance(WEBGL_SETTLE_MS);
  assert.ok(h.log.length - before <= 2);
});

test("an idle holder yields to a busy card of the same size; busy equal cards never swap", () => {
  const h = harness({ budget: 2 });
  for (const id of ["a", "b", "c"]) h.card(id, rect(0, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  const [first, second] = h.attached();
  const loser = ["a", "b", "c"].find((id) => !h.attached().includes(id));
  // Everyone prints for a minute: the holders keep their contexts, no replans move anything.
  const before = h.log.length;
  for (let t = 0; t < 60_000; t += 100) { for (const id of ["a", "b", "c"]) h.pool.touch(id); h.advance(100); }
  assert.equal(h.log.length, before, "no swaps between equally busy cards");
  // Now only the card without a context prints; after the idle time it takes one holder's slot.
  for (let t = 0; t < WEBGL_IDLE_MS + 2 * WEBGL_ACTIVITY_REPLAN_MS; t += 100) { h.pool.touch(loser); h.pool.touch(first); h.advance(100); }
  assert.deepEqual(h.attached(), [first, loser].sort());
  assert.equal(h.cards.get(second).attached, false);
});

test("output on an off-screen card never triggers a plan", () => {
  const h = harness({ budget: 1 });
  h.card("on", rect(0, 0, 100, 100));
  h.card("off", rect(5000, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS + WEBGL_IDLE_MS);
  let plans = 0;
  const original = h.pool.plan.bind(h.pool);
  h.pool.plan = () => { plans += 1; original(); };
  for (let t = 0; t < 30_000; t += 50) { h.pool.touch("off"); h.advance(50); }
  assert.equal(plans, 0);
  assert.deepEqual(h.attached(), ["on"]);
});

test("a clearly larger card displaces a holder; a slightly larger one does not", () => {
  const h = harness({ budget: 1 });
  const a = h.card("a", rect(0, 0, 100, 100));
  const b = h.card("b", rect(200, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  const holder = h.attached()[0];
  const other = holder === "a" ? b : a;
  h.advance(WEBGL_MIN_HOLD_MS);
  other.rect = { ...other.rect, right: other.rect.left + 110 };
  h.pool.viewportChanged();
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), [holder]);
  other.rect = { ...other.rect, right: other.rect.left + 200 };
  h.pool.viewportChanged();
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), [holder === "a" ? "b" : "a"]);
});

test("a card that just got a context keeps it for the minimum hold time", () => {
  const h = harness({ budget: 1 });
  h.card("a", rect(0, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a"]);
  h.card("b", rect(200, 0, 500, 500));
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a"], "pinned right after the grant");
  h.advance(WEBGL_MIN_HOLD_MS);
  assert.deepEqual(h.attached(), ["b"], "the pool looked again when the pin ran out");
});

test("the context count never goes over the budget, releases happen before attaches", () => {
  const h = harness({ budget: 3 });
  let live = 0; let peak = 0;
  for (let i = 0; i < 8; i++) h.card(`c${i}`, rect(i * 110, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  for (let round = 0; round < 20; round++) {
    const focused = `c${(round * 3) % 8}`;
    for (let i = 0; i < 8; i++) h.pool.update(`c${i}`, { eligible: true, focused: `c${i}` === focused });
    h.advance(WEBGL_SETTLE_MS + WEBGL_MIN_HOLD_MS);
  }
  for (const entry of h.log) { live += entry.startsWith("+") ? 1 : -1; peak = Math.max(peak, live); }
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.equal(live, h.attached().length);
});

test("context loss: the card falls back to DOM, its slot goes to the next card, and it backs off", () => {
  const h = harness({ budget: 1 });
  h.card("a", rect(0, 0, 400, 400), { focused: true });
  h.card("b", rect(500, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a"]);
  // The card already disposed its addon (xterm keeps the buffer) before telling the pool.
  h.cards.get("a").attached = false;
  h.pool.contextLost("a");
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["b"]);
  // Camera moves during the backoff do not bring a back.
  h.pool.viewportChanged();
  h.advance(WEBGL_LOSS_BACKOFF_MS - WEBGL_SETTLE_MS - 1);
  assert.deepEqual(h.attached(), ["b"]);
  h.advance(WEBGL_SETTLE_MS + 1);
  assert.deepEqual(h.attached(), ["a"]);
  // A second loss backs off twice as long.
  h.cards.get("a").attached = false;
  h.pool.contextLost("a");
  h.advance(WEBGL_LOSS_BACKOFF_MS + WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["b"]);
  h.advance(WEBGL_LOSS_BACKOFF_MS);
  assert.deepEqual(h.attached(), ["a"]);
});

test("no WebGL2 at all: attach fails, cards stay on DOM and are not retried on every camera move", () => {
  const h = harness({ budget: 2 });
  const a = h.card("a", rect(0, 0, 100, 100), { attachable: false });
  h.advance(WEBGL_SETTLE_MS);
  assert.equal(a.tries, 1);
  for (let i = 0; i < 50; i++) { h.pool.viewportChanged(); h.advance(WEBGL_SETTLE_MS); }
  assert.deepEqual(h.attached(), []);
  assert.equal(a.tries, 1, "backing off, like a lost context");
  h.advance(WEBGL_LOSS_BACKOFF_MS);
  assert.equal(a.tries, 2);
});

test("unregistering releases the context and hands the slot on; a stale unregister is ignored", () => {
  const h = harness({ budget: 1 });
  const a = h.card("a", rect(0, 0, 400, 400));
  h.card("b", rect(500, 0, 100, 100));
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["a"]);
  a.unregister();
  assert.equal(a.attached, false);
  h.advance(WEBGL_SETTLE_MS);
  assert.deepEqual(h.attached(), ["b"]);
  // The same session remounted (fullscreen toggle): the old card's cleanup must not drop the new one.
  const first = h.card("x", rect(0, 0, 400, 400), { focused: true });
  const second = h.card("x", rect(0, 0, 400, 400), { focused: true });
  first.unregister();
  h.advance(WEBGL_SETTLE_MS);
  assert.equal(second.attached, true);
});

test("ASCII backgrounds release an existing GPU renderer immediately and restore it when disabled", async () => {
  const source = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(source, /eligible: !hasAsciiBackground && !summaryMode && webglScaleAllowed/);
  assert.match(source, /\[session\.id, focused, summaryMode, webglScaleAllowed, hasAsciiBackground\]/);
  const h = harness({ budget: 1 });
  const terminal = h.card("terminal", rect(0, 0, 400, 400), { focused: true });
  h.advance(WEBGL_SETTLE_MS);
  assert.equal(terminal.attached, true);
  h.pool.update("terminal", { eligible: false, focused: true });
  assert.equal(terminal.attached, false, "old GPU pixels must disappear before another animation frame");
  h.advance(WEBGL_SETTLE_MS);
  assert.equal(terminal.attached, false);
  h.pool.update("terminal", { eligible: true, focused: true });
  h.advance(WEBGL_SETTLE_MS);
  assert.equal(terminal.attached, true, "ordinary terminals retain GPU acceleration");
});

test("TerminalCard routes its renderer through the pool and frees the context on release", async () => {
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(card, /pool\.register\(session\.id,/);
  assert.match(card, /webglContextPool\(\)\.contextLost\(session\.id\)/);
  assert.match(card, /WEBGL_lose_context/);
  assert.match(card, /data-renderer-transition/);
  assert.match(card, /requestAnimationFrame\(/);
  assert.doesNotMatch(card, /if \(focused && !summaryMode && zoom <= WEBGL_MAX_SCALE\) enableWebgl/);
  const canvas = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  // Every camera move (the store's listener, no React render) and every layout change tells the pool.
  assert.match(canvas, /return camera\.subscribe\(\(\) => \{[\s\S]*?webglContextPool\(\)\.viewportChanged\(\);/);
  assert.match(canvas, /webglContextPool\(\)\.viewportChanged\(\);\r?\n  \}, \[homeEditing, fullscreenSessionId\]\);/);
});
