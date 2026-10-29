import assert from "node:assert/strict";
import test from "node:test";
import { resolveObjectURL } from "node:buffer";
import { createReleasingCache } from "../src/renderer/src/features/skins/releasingCache.ts";

function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    setTimeout(callback) { const timer = { callback }; pending.add(timer); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    runAll() { for (const timer of [...pending]) { pending.delete(timer); timer.callback(); } }
  };
}

test("a failed load's late release never evicts the fresh entry loaded after it", async () => {
  const timers = fakeTimers();
  const disposed = [];
  let attempt = 0;
  const cache = createReleasingCache({
    load: async (key) => { attempt += 1; if (attempt === 1) throw new Error("read failed"); return `${key}-urls-${attempt}`; },
    dispose: (value) => disposed.push(value),
    delayMs: 30_000,
    timers
  });
  const first = cache.acquire("pack");
  await assert.rejects(first.value, /read failed/u);
  const second = cache.acquire("pack");
  assert.equal(await second.value, "pack-urls-2");
  first.release();
  timers.runAll();
  assert.equal(cache.size(), 1, "the entry in use stays");
  const third = cache.acquire("pack");
  assert.equal(await third.value, "pack-urls-2", "and is shared, not loaded again");
  assert.equal(attempt, 2);
  second.release();
  third.release();
  timers.runAll();
  assert.equal(cache.size(), 0);
  assert.deepEqual(disposed, ["pack-urls-2"]);
});

test("a release then a new acquire within the delay keeps the entry", async () => {
  const timers = fakeTimers();
  const cache = createReleasingCache({ load: async (key) => key, dispose: () => undefined, delayMs: 30_000, timers });
  const one = cache.acquire("k");
  await one.value;
  one.release();
  one.release();
  const two = cache.acquire("k");
  timers.runAll();
  assert.equal(cache.size(), 1);
  two.release();
  timers.runAll();
  assert.equal(cache.size(), 0);
});

test("cache releases real Blob URLs when a load completes after eviction", async () => {
  const timers = fakeTimers();
  let finish;
  let disposed = 0;
  const cache = createReleasingCache({
    load: () => new Promise((resolve) => { finish = resolve; }),
    dispose: (url) => { disposed++; URL.revokeObjectURL(url); },
    delayMs: 30_000, timers
  });
  const handle = cache.acquire("pack");
  handle.release();
  timers.runAll();
  assert.equal(cache.size(), 0);
  const url = URL.createObjectURL(new Blob(["skin image"]));
  try {
    finish(url);
    assert.equal(await handle.value, url);
    assert.equal(disposed, 1);
    assert.equal(resolveObjectURL(url), undefined);
    handle.release();
    timers.runAll();
    assert.equal(disposed, 1);
  } finally { URL.revokeObjectURL(url); }
});

test("a late old load cannot dispose or evict a replacement cache entry", async () => {
  const timers = fakeTimers();
  const finish = [];
  const disposed = [];
  const cache = createReleasingCache({
    load: () => new Promise((resolve) => finish.push(resolve)),
    dispose: (value) => disposed.push(value),
    delayMs: 30_000, timers
  });
  const old = cache.acquire("pack");
  old.release(); timers.runAll();
  const fresh = cache.acquire("pack");
  finish[1]("fresh"); await fresh.value;
  finish[0]("old"); await old.value;
  assert.deepEqual(disposed, ["old"]);
  assert.equal(cache.size(), 1);
  fresh.release(); timers.runAll();
  assert.deepEqual(disposed, ["old", "fresh"]);
});

test("reacquiring a pending load before expiry keeps its value alive", async () => {
  const timers = fakeTimers();
  let finish;
  const disposed = [];
  const cache = createReleasingCache({
    load: () => new Promise((resolve) => { finish = resolve; }),
    dispose: (value) => disposed.push(value),
    delayMs: 30_000, timers
  });
  const first = cache.acquire("pack"); first.release();
  const second = cache.acquire("pack"); timers.runAll();
  finish("shared"); await second.value;
  assert.deepEqual(disposed, []);
  second.release(); timers.runAll();
  assert.deepEqual(disposed, ["shared"]);
});
