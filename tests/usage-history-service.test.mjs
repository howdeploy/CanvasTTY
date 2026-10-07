import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, devNull } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalUsageCollector, discoverSqlite } from "../src/main/services/LocalUsageCollector.ts";
import { UsageHistoryService } from "../src/main/services/UsageHistoryService.ts";

const SQLITE = await discoverSqlite();
let needsSqlite = SQLITE ? false : 'requires sqlite3 on PATH';
if (SQLITE) {
  try { execFileSync(SQLITE, ['-safe', '-init', devNull, '-json', ':memory:', 'SELECT 1'], { env: {}, stdio: 'pipe' }); }
  catch { needsSqlite = 'requires sqlite3 with -safe and -json support'; }
}

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-21T10:00:00Z");
const FILE = "usage-history.json";
const HISTORY_KEYS = ["collectedAt", "coverage", "error", "events", "health", "providerStatus", "samples", "startedAt", "version"];

function window(id, usedPercent, resetsAt = T0 + 3 * 3_600_000) {
  return { id, bucketId: id.split(":")[0], slot: "primary", isDefaultBucket: true, label: "5h", usedPercent, used: null, limit: null, windowMinutes: 300, resetsAt };
}
function available(provider, fetchedAt, accountScope, windows) {
  return { provider, state: "available", source: provider === "codex" ? "codex-app-server" : "claude-usage-api", fetchedAt, windows, accountScope };
}
function snapshot(...providers) {
  return { fetchedAt: T0, providers };
}
function unavailable(provider, reason) {
  return { provider, state: "unavailable", source: provider === "codex" ? "codex-app-server" : "claude-usage-api", checkedAt: T0, reason };
}

/** Limits double: returns queued snapshots; a queued Error rejects. */
function fakeLimits(queue) {
  const calls = [];
  return {
    calls,
    async getProviders(providers) {
      calls.push([...providers]);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return structuredClone(next ?? snapshot());
    }
  };
}
const noLimits = () => fakeLimits([snapshot()]);

/** Collector double: each run may mutate its draft state, emit events, or throw. */
function fakeCollector(runs = []) {
  const created = [];
  return {
    created,
    factory(state) {
      const collector = {
        state,
        received: structuredClone(state),
        async collect(now) {
          const run = runs.shift() ?? {};
          if (run.wait) await run.wait;
          run.mutate?.(state, now);
          if (run.error) throw run.error;
          const health = run.omitHealth ? {} : { complete: run.complete ?? true, lost: run.lost ?? false };
          return { events: structuredClone(run.events ?? []), coverage: run.coverage ?? [`collector ran at ${now}`], ...health };
        }
      };
      created.push(collector);
      return collector;
    }
  };
}

function event(id, patch = {}) {
  return { id, provider: "claude", app: "Claude Code", profile: "", session: "session-1", from: T0, to: T0, input: 100, output: 5, cached: 10, timing: "event", ...patch };
}

/** A collector state v2 log cursor, keyed like the collector (24 hex digits). */
const KEY = "0123456789abcdef01234567";
function cursor(offset) {
  return { node: "1:2", head: "abcdef012345abcdef012345", headLength: 100, size: 400, mtime: T0, offset, seen: T0 };
}

function envelope(history, collector = { version: 2, files: {}, hermes: {} }, extra = {}) {
  return {
    format: "canvastty-usage-history",
    version: 2,
    history: {
      version: 1, startedAt: T0 - 2 * DAY, collectedAt: T0 - DAY, samples: [], events: [], coverage: [], providerStatus: [], error: null, health: [],
      ...history
    },
    collector,
    notices: [],
    ...extra
  };
}

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-usage-history-"));
  try {
    await run(directory);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

function service(directory, options = {}) {
  let clock = options.start ?? T0;
  const collector = options.collector ?? fakeCollector();
  const history = new UsageHistoryService({
    directory,
    limits: options.limits ?? noLimits(),
    createCollector: (state) => collector.factory(state),
    now: () => clock,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.initialDelayMs === undefined ? {} : { initialDelayMs: options.initialDelayMs })
  });
  return { history, collector, advance: (ms) => { clock += ms; }, set: (value) => { clock = value; } };
}

test("first collection creates a private, atomically replaced history file with the fixed contract shape", async () => {
  await withDirectory(async (directory) => {
    const limits = fakeLimits([snapshot(available("codex", T0, "scope-a", [window("codex:primary", 20), window("codex:secondary", null)]))]);
    const { history } = service(directory, { limits });
    await history.load();
    const empty = history.get();
    assert.deepEqual(Object.keys(empty).sort(), HISTORY_KEYS);
    assert.equal(empty.collectedAt, 0, "nothing collected yet is not reported as a collection");
    assert.equal(empty.startedAt, T0);
    assert.match(empty.coverage.join('\n'), /while CanvasTTY runs/);
    assert.doesNotMatch(empty.coverage.join('\n'), /CanvasTTY-Patched/);

    const collected = await history.collect();
    assert.deepEqual(Object.keys(collected).sort(), HISTORY_KEYS);
    assert.equal(collected.version, 1);
    assert.equal(collected.collectedAt, T0);
    assert.equal(collected.error, null);
    assert.deepEqual(collected.samples, [
      { provider: "codex", scope: "scope-a", windowId: "codex:primary", at: T0, reset: T0 + 3 * 3_600_000, percent: 20 }
    ]);
    assert.deepEqual(limits.calls, [["codex", "claude"]]);

    assert.deepEqual(await readdir(directory), [FILE], "no temporary files remain");
    assert.equal((await stat(join(directory, FILE))).mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(join(directory, FILE), "utf8"));
    assert.deepEqual(persisted.history.samples, collected.samples);
    assert.equal(JSON.stringify(history.get()).includes("\"files\""), false, "collector cursors stay private to the main process");
  });
});

test("cached, stale and unavailable limit snapshots never become new observations", async () => {
  await withDirectory(async (directory) => {
    const codexA = available("codex", T0, "scope-a", [window("codex:primary", 20)]);
    const limits = fakeLimits([
      snapshot(codexA, unavailable("claude", "not-authenticated")),
      snapshot(codexA, { ...available("claude", T0 - 5 * 60_000, "epoch-1", [window("claude:five_hour", 40)]), state: "stale", failedAt: T0 + 60_000, reason: "timeout" }),
      snapshot(available("codex", T0 + 120_000, null, [window("codex:primary", 22)]), available("claude", T0 + 120_000, "epoch-1", [window("claude:five_hour", 41)]))
    ]);
    const { history, advance } = service(directory, { limits });
    await history.load();

    const first = await history.collect();
    assert.equal(first.samples.length, 1);
    assert.ok(first.providerStatus.some((line) => /claude/i.test(line) && /unavailable/i.test(line) && /not-authenticated/.test(line)));

    advance(60_000);
    const second = await history.collect();
    assert.equal(second.samples.length, 1, "a repeated (cached) observation is not a new sample");
    assert.ok(second.providerStatus.some((line) => /codex/i.test(line) && /cached|already recorded/i.test(line)));
    assert.ok(second.providerStatus.some((line) => /claude/i.test(line) && /stale/i.test(line) && /timeout/.test(line)));

    advance(60_000);
    const third = await history.collect();
    assert.equal(third.samples.length, 3);
    const unknown = third.samples.find((sample) => sample.provider === "codex" && sample.at === T0 + 120_000);
    assert.equal(unknown.scope, null, "an account-unknown observation is kept but cannot be compared");
    assert.ok(third.providerStatus.some((line) => /codex/i.test(line) && /account/i.test(line) && /unknown/i.test(line)));
  });
});

test("Claude streaming updates upsert one event by ID and keep the maxima", async () => {
  await withDirectory(async (directory) => {
    const collector = fakeCollector([
      { events: [event("message-1", { output: 5 }), event("message-2", { output: 3 })] },
      { events: [event("message-1", { output: 42, to: T0 + 1_000 })] },
      { events: [event("message-1", { output: 7, cached: 12 })] }
    ]);
    const { history, advance } = service(directory, { collector });
    await history.load();
    await history.collect();
    advance(60_000);
    await history.collect();
    advance(60_000);
    const result = await history.collect();

    assert.equal(result.events.length, 2);
    const merged = result.events.find((candidate) => candidate.id === "message-1");
    assert.equal(merged.output, 42);
    assert.equal(merged.cached, 12);
    assert.equal(merged.input, 100);
    assert.equal(merged.from, T0);
    assert.equal(merged.to, T0 + 1_000);
  });
});

test("invalid collector events are rejected instead of persisted", async () => {
  await withDirectory(async (directory) => {
    const collector = fakeCollector([{ events: [event("ok"), event("negative", { input: -1 }), event("nan", { output: Number.NaN }), { id: "partial" }] }]);
    const { history } = service(directory, { collector });
    await history.load();
    const result = await history.collect();
    assert.deepEqual(result.events.map((candidate) => candidate.id), ["ok"]);
    assert.ok(result.coverage.some((line) => /3 invalid/i.test(line)));
  });
});

test("per-run collection health is recorded for every run, including failures, persisted, reloaded and bounded", async () => {
  await withDirectory(async (directory) => {
    const collector = fakeCollector([
      { complete: true },
      { complete: false },
      { error: new Error("secret /private-source/token") },
      { complete: true, lost: true },
      { omitHealth: true },
      { complete: true, events: [event("")] }
    ]);
    const first = service(directory, { collector });
    await first.history.load();
    assert.deepEqual(first.history.get().health, [], "nothing collected yet");
    for (let run = 0; run < 6; run += 1) {
      await first.history.collect();
      first.advance(60_000);
    }
    const expected = [
      { at: T0, complete: true },
      { at: T0 + 60_000, complete: false },
      { at: T0 + 120_000, complete: false },
      { at: T0 + 180_000, complete: false, lost: true },
      { at: T0 + 240_000, complete: false },
      { at: T0 + 300_000, complete: false, lost: true }
    ];
    assert.deepEqual(first.history.get().health, expected, "failed, unreported and lossy runs are never recorded as complete");
    const persisted = JSON.parse(await readFile(join(directory, FILE), "utf8"));
    assert.deepEqual(persisted.history.health, expected);
    assert.deepEqual([...new Set(persisted.history.health.flatMap(Object.keys))].sort(), ["at", "complete", "lost"], "health holds no source detail");
    await first.history.dispose();

    const second = service(directory, { start: T0 + 360_000 });
    await second.history.load();
    assert.deepEqual(second.history.get().health, expected, "reloaded unchanged");
    assert.equal(second.history.get().error, null);
    second.set(T0 + 31 * DAY);
    await second.history.collect();
    assert.deepEqual(second.history.get().health, [{ at: T0 + 31 * DAY, complete: true }], "30-day retention applies to health");
  });
});

test("stored health is validated on load and bounded", async () => {
  await withDirectory(async (directory) => {
    // 60 000 runs 10 s apart are all inside the 30-day retention, so only the count bound applies.
    const many = Array.from({ length: 60_000 }, (_, index) => ({ at: T0 - 10_000 * (60_000 - index), complete: index % 2 === 0 }));
    await writeFile(join(directory, FILE), JSON.stringify(envelope({ collectedAt: T0 - 60_000, health: many })));
    const bounded = service(directory);
    await bounded.history.load();
    const health = bounded.history.get().health;
    assert.ok(health.length <= 50_000, `bounded: ${health.length}`);
    assert.deepEqual(health.at(-1), many.at(-1), "the newest runs are kept");
    assert.equal(bounded.history.get().error, null, "trimming by the bound is not an error");
  });
  await withDirectory(async (directory) => {
    await writeFile(join(directory, FILE), JSON.stringify(envelope({ health: [{ at: T0 - DAY, complete: true }, { at: T0 - DAY + 1, complete: "yes" }, { at: -5, complete: true }] })));
    const invalid = service(directory);
    await invalid.history.load();
    assert.deepEqual(invalid.history.get().health, [{ at: T0 - DAY, complete: true }]);
    assert.match(invalid.history.get().error ?? "", /2 invalid usage history records were ignored/);
  });
});

test("30-day retention prunes old events and samples, including ones loaded from disk", async () => {
  await withDirectory(async (directory) => {
    const oldSample = { provider: "codex", scope: "s", windowId: "codex:primary", at: T0 - 31 * DAY, reset: null, percent: 1 };
    const recentSample = { ...oldSample, at: T0 - DAY, percent: 2 };
    await writeFile(join(directory, FILE), JSON.stringify(envelope({
      samples: [oldSample, recentSample],
      events: [event("old", { from: T0 - 31 * DAY, to: T0 - 31 * DAY }), event("recent", { from: T0 - DAY, to: T0 - DAY })]
    })));
    const collector = fakeCollector([{ events: [event("too-old", { from: T0 - 40 * DAY, to: T0 - 40 * DAY })] }]);
    const { history } = service(directory, { collector });
    await history.load();
    const result = await history.collect();
    assert.deepEqual(result.samples, [recentSample]);
    assert.deepEqual(result.events.map((candidate) => candidate.id), ["recent"]);
    assert.equal(result.startedAt, T0 - 2 * DAY, "the original collection start survives restarts");
  });
});

test("collector cursors persist with the history, and a failed collection never advances them", async () => {
  await withDirectory(async (directory) => {
    const first = service(directory, {
      collector: fakeCollector([{ mutate: (state) => { state.version = 2; state.files[KEY] = cursor(10); }, events: [event("a")] }])
    });
    await first.history.load();
    await first.history.collect();
    await first.history.dispose();

    const collector = fakeCollector([
      { mutate: (state) => { state.files[KEY].offset = 99; }, error: new Error("PRIVATE conversation text from a local log") }
    ]);
    const second = service(directory, { collector, start: T0 + 60_000 });
    await second.history.load();
    const failed = await second.history.collect();
    assert.deepEqual(collector.created[0].received.files, { [KEY]: cursor(10) });
    assert.match(failed.error, /collect/i);
    assert.equal(failed.error.includes("PRIVATE"), false, "raw error text never reaches the renderer");
    assert.deepEqual(failed.events.map((candidate) => candidate.id), ["a"]);
    const persisted = JSON.parse(await readFile(join(directory, FILE), "utf8"));
    assert.deepEqual(persisted.collector.files, { [KEY]: cursor(10) });
  });
});

test("corrupt history is preserved and reported, never silently overwritten", async () => {
  await withDirectory(async (directory) => {
    const corrupt = "{\"format\":\"canvastty-usage-history\",\"version\":1,\"history\":";
    await writeFile(join(directory, FILE), corrupt);
    const { history } = service(directory, { limits: fakeLimits([snapshot(available("codex", T0, "a", [window("codex:primary", 5)]))]) });
    await history.load();
    const loaded = history.get();
    assert.match(loaded.error, /unreadable/i);
    const preserved = (await readdir(directory)).filter((name) => name.startsWith("usage-history.corrupt-"));
    assert.equal(preserved.length, 1);
    assert.match(loaded.error, new RegExp(preserved[0].replaceAll(".", "\\.")));
    assert.equal(await readFile(join(directory, preserved[0]), "utf8"), corrupt);

    const collected = await history.collect();
    assert.equal(collected.samples.length, 1);
    assert.ok(collected.coverage.some((line) => line.includes(preserved[0])), "the restart stays visible in coverage");
    assert.equal(await readFile(join(directory, preserved[0]), "utf8"), corrupt);
    assert.equal(JSON.parse(await readFile(join(directory, FILE), "utf8")).history.samples.length, 1);
  });
});

test("structurally invalid history is quarantined the same way", async () => {
  await withDirectory(async (directory) => {
    const invalid = JSON.stringify({ format: "canvastty-usage-history", version: 2, history: { samples: "nope" }, collector: { version: 2 } });
    await writeFile(join(directory, FILE), invalid);
    const { history } = service(directory);
    await history.load();
    assert.match(history.get().error, /unreadable|invalid/i);
    const preserved = (await readdir(directory)).filter((name) => name.startsWith("usage-history.corrupt-"));
    assert.equal(preserved.length, 1);
    assert.equal(await readFile(join(directory, preserved[0]), "utf8"), invalid);
  });
});

test("partially invalid records are dropped openly and the original file is preserved", async () => {
  await withDirectory(async (directory) => {
    const original = JSON.stringify(envelope(
      { events: [event("good", { from: T0 - DAY, to: T0 - DAY }), event("bad", { input: -5 })] },
      { version: 2, files: { [KEY]: cursor(1), broken: { offset: "x" } }, hermes: {} }
    ));
    await writeFile(join(directory, FILE), original);
    const collector = fakeCollector();
    const { history } = service(directory, { collector });
    await history.load();
    const loaded = history.get();
    assert.deepEqual(loaded.events.map((candidate) => candidate.id), ["good"]);
    assert.match(loaded.error, /2 invalid/i);
    const preserved = (await readdir(directory)).filter((name) => name.startsWith("usage-history.corrupt-"));
    assert.equal(preserved.length, 1);
    assert.equal(await readFile(join(directory, preserved[0]), "utf8"), original);
    await history.collect();
    assert.deepEqual(collector.created[0].received.files, { [KEY]: cursor(1) });
  });
});

test("unknown or secret-bearing collector fields are dropped, counted and never written back", async () => {
  await withDirectory(async (directory) => {
    const secret = ["sk", "live", "secret"].join("-");
    const hermesKey = "fedcba9876543210fedcba98";
    const baseline = { node: "3:4", at: T0 - DAY, rows: { [KEY]: [10, 2, 0, T0 - DAY, T0 - DAY] } };
    const original = JSON.stringify(envelope({}, {
      version: 2,
      apiKey: secret,
      files: { [KEY]: { ...cursor(5), token: secret, claude: { pending: { id: "m", session: "s", from: T0, to: T0, usage: [1, 2, 3, 4] }, raw: secret } } },
      hermes: { [hermesKey]: { ...baseline, password: secret } }
    }));
    await writeFile(join(directory, FILE), original);
    const collector = fakeCollector();
    const { history } = service(directory, { collector });
    await history.load();
    assert.match(history.get().error, /3 invalid/i, "the top-level field, the cursor and the Hermes entry were altered");
    const preserved = (await readdir(directory)).filter((name) => name.startsWith("usage-history.corrupt-"));
    assert.equal(preserved.length, 1);
    await history.collect();
    const received = collector.created[0].received;
    assert.deepEqual(received, {
      version: 2,
      files: { [KEY]: { ...cursor(5), claude: { pending: { id: "m", session: "s", from: T0, to: T0, usage: [1, 2, 3, 4] } } } },
      hermes: { [hermesKey]: baseline }
    }, "offsets, baselines and pending state survive; nothing else does");
    assert.equal((await readFile(join(directory, FILE), "utf8")).includes(secret), false);
  });
});

test("an unsupported history version is left untouched and saving is disabled", async () => {
  await withDirectory(async (directory) => {
    const future = JSON.stringify({ format: "canvastty-usage-history", version: 99, history: {} });
    await writeFile(join(directory, FILE), future);
    const { history } = service(directory, { limits: fakeLimits([snapshot(available("codex", T0, "a", [window("codex:primary", 5)]))]) });
    await history.load();
    const collected = await history.collect();
    assert.equal(collected.samples.length, 1, "collection continues in memory");
    assert.match(collected.error, /not (being )?saved/i);
    assert.equal(await readFile(join(directory, FILE), "utf8"), future);
    assert.deepEqual(await readdir(directory), [FILE]);
  });
});

test("a symlinked history file is neither followed nor replaced", async () => {
  await withDirectory(async (directory) => {
    const outside = join(directory, "outside.json");
    await writeFile(outside, "outside");
    await symlink(outside, join(directory, FILE));
    const { history } = service(directory);
    await history.load();
    const collected = await history.collect();
    assert.match(collected.error, /not (being )?saved/i);
    assert.ok((await lstat(join(directory, FILE))).isSymbolicLink());
    assert.equal(await readFile(outside, "utf8"), "outside");
  });
});

test("save failures are surfaced without losing the in-memory history", { skip: process.getuid?.() === 0 }, async () => {
  await withDirectory(async (directory) => {
    const store = join(directory, "store");
    await mkdir(store);
    const { history, advance } = service(store, {
      limits: fakeLimits([
        snapshot(available("codex", T0, "a", [window("codex:primary", 5)])),
        snapshot(available("codex", T0 + 60_000, "a", [window("codex:primary", 6)]))
      ])
    });
    await history.load();
    await chmod(store, 0o500);
    const failed = await history.collect();
    assert.match(failed.error, /could not be saved/i);
    assert.match(failed.error, /EACCES|EPERM/);
    assert.equal(failed.samples.length, 1);

    await chmod(store, 0o700);
    advance(60_000);
    const recovered = await history.collect();
    assert.equal(recovered.error, null);
    assert.equal(JSON.parse(await readFile(join(store, FILE), "utf8")).history.samples.length, 2);
  });
});

test("limit and collector failures never expose raw error text or secrets", async () => {
  await withDirectory(async (directory) => {
    const secret = ["Bearer", "sk-live-secret"].join(" ");
    const { history } = service(directory, {
      limits: fakeLimits([new Error(secret)]),
      collector: fakeCollector([{ error: new Error(`PRIVATE ${secret}`) }])
    });
    await history.load();
    const result = await history.collect();
    const text = JSON.stringify(result);
    assert.equal(text.includes("sk-live-secret"), false);
    assert.equal(text.includes("PRIVATE"), false);
    assert.ok(result.providerStatus.some((line) => /limits/i.test(line) && /failed/i.test(line)));
    assert.match(result.error, /collect/i);
  });
});

test("collection is serialized, periodic, and disposal stops the timer after a final save", async () => {
  await withDirectory(async (directory) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let active = 0;
    let maximum = 0;
    let runs = 0;
    const collector = {
      created: [],
      factory(state) {
        return {
          state,
          async collect() {
            active += 1;
            runs += 1;
            maximum = Math.max(maximum, active);
            if (runs === 1) await gate;
            active -= 1;
            return { events: [event(`run-${runs}`)], coverage: [] };
          }
        };
      }
    };
    const { history } = service(directory, { collector, intervalMs: 15, initialDelayMs: 0 });
    await history.load();
    const first = history.collect();
    const second = history.collect();
    release();
    assert.deepEqual(await first, await second, "a concurrent request joins the running collection");
    assert.equal(runs, 1);

    history.start();
    const deadline = Date.now() + 2_000;
    while (runs < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(runs >= 4, "the timer keeps collecting without any renderer");
    await history.dispose();
    const settled = runs;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(runs, settled, "no collection after disposal");
    assert.equal(maximum, 1, "collections never overlap");
    const persisted = JSON.parse(await readFile(join(directory, FILE), "utf8"));
    assert.equal(persisted.history.events.length, history.get().events.length);
  });
});

test("the real collector's Claude streaming duplicates become one event with the final usage", async () => {
  await withDirectory(async (directory) => {
    const home = join(directory, "home");
    const project = join(home, ".claude", "projects", "project-a");
    await mkdir(project, { recursive: true });
    const now = Date.now();
    const line = (output) => JSON.stringify({
      type: "assistant", timestamp: new Date(now - 60_000).toISOString(), sessionId: "session-a", requestId: "request-a",
      message: { id: "message-a", content: "PRIVATE assistant text", usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 4 } }
    });
    const transcript = join(project, "session-a.jsonl");
    await writeFile(transcript, `${line(2)}\n${line(30)}\n`);
    let clock = now;
    const history = new UsageHistoryService({
      directory: join(directory, "data"),
      limits: noLimits(),
      createCollector: (state) => new LocalUsageCollector(home, state, {}),
      now: () => clock
    });
    await mkdir(join(directory, "data"));
    await history.load();
    // The newest message may still be streaming, so it is held in the persisted cursor until the transcript idles.
    assert.equal((await history.collect()).events.length, 0);
    await writeFile(transcript, `${line(2)}\n${line(30)}\n${line(30)}\n`);
    clock = now + 10 * 60_000;
    const result = await history.collect();
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].output, 30);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    const saved = await readFile(join(directory, "data", FILE), "utf8");
    assert.equal(saved.includes("PRIVATE"), false);
  });
});

test("the real collector's cursors survive a reload of the history file unchanged", async () => {
  await withDirectory(async (directory) => {
    const home = join(directory, "home");
    const project = join(home, ".claude", "projects", "project-a");
    await mkdir(project, { recursive: true });
    await mkdir(join(directory, "data"));
    const now = Date.now();
    await writeFile(join(project, "session-a.jsonl"), `${JSON.stringify({
      type: "assistant", timestamp: new Date(now - 3_600_000).toISOString(), sessionId: "session-a",
      message: { id: "message-a", usage: { input_tokens: 10, output_tokens: 2 } }
    })}\n`);
    const open = () => new UsageHistoryService({
      directory: join(directory, "data"),
      limits: noLimits(),
      createCollector: (state) => new LocalUsageCollector(home, state, {}),
      now: () => now + 3_600_000
    });
    const first = open();
    await first.load();
    await first.collect();
    const saved = JSON.parse(await readFile(join(directory, "data", FILE), "utf8"));
    assert.equal(Object.keys(saved.collector.files).length, 1);
    const reopened = open();
    await reopened.load();
    await reopened.collect();
    const again = JSON.parse(await readFile(join(directory, "data", FILE), "utf8"));
    assert.deepEqual(again.collector, { ...saved.collector, files: again.collector.files }, "no collector field is lost");
    assert.deepEqual(Object.keys(again.collector.files), Object.keys(saved.collector.files), "cursors are kept, not dropped as invalid");
    assert.equal(reopened.get().coverage.some((line) => /invalid|dropped/i.test(line)), false);
  });
});

test("across restarts the real collector neither duplicates nor loses Codex, Claude or Hermes usage", { skip: needsSqlite }, async () => {
  await withDirectory(async (directory) => {
    const home = join(directory, "home");
    const data = join(directory, "data");
    await mkdir(data);
    const base = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const counts = ([input, cached, output]) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
    const codexCount = (at, total, last) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: counts(total), last_token_usage: counts(last) } } });
    const rollout = join(home, ".codex", "sessions", "2026", "09", "20", "rollout-2026-09-20T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl");
    await mkdir(join(rollout, ".."), { recursive: true });
    await writeFile(rollout, [
      JSON.stringify({ timestamp: iso(base - 40 * 60_000), type: "session_meta", payload: { id: "0199aaaa-bbbb-cccc-dddd-eeeeffff0000", originator: "codex_cli_rs" } }),
      codexCount(base - 39 * 60_000, [100, 10, 5], [100, 10, 5]),
      codexCount(base - 38 * 60_000, [150, 10, 12], [50, 0, 7])
    ].join("\n") + "\n");
    const project = join(home, ".claude", "projects", "project-a");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "session-a.jsonl"), `${JSON.stringify({
      type: "assistant", timestamp: new Date(base - 60_000).toISOString(), sessionId: "session-a",
      message: { id: "message-a", usage: { input_tokens: 10, output_tokens: 2 } }
    })}\n`);
    const database = join(home, ".hermes", "state.db");
    const hermes = (statement) => execFileSync(SQLITE, ["-init", devNull, database, statement], { env: {}, shell: false });
    await mkdir(join(home, ".hermes"), { recursive: true });
    hermes(`CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, input_tokens INTEGER, output_tokens INTEGER, first_seen REAL, last_seen REAL);
      INSERT INTO session_model_usage VALUES ('hermes-a', 'gpt', 'openai-codex', 1000, 100, ${(base - DAY) / 1000}, ${(base - DAY) / 1000});`);

    const open = (clock) => new UsageHistoryService({
      directory: data, limits: noLimits(), createCollector: (state) => new LocalUsageCollector(home, state, {}), now: () => clock
    });
    const saved = async () => JSON.parse(await readFile(join(data, FILE), "utf8"));
    const source = (candidate) => candidate.app === "Hermes" ? `${candidate.provider}:Hermes` : candidate.provider === "codex" ? "codex:Codex" : `${candidate.provider}:${candidate.app}`;
    const totals = (events) => Object.fromEntries(["codex:Codex", "claude:Claude Code", "codex:Hermes"].map((key) => {
      const list = events.filter((candidate) => source(candidate) === key);
      return [key, [list.length, list.reduce((sum, candidate) => sum + candidate.input, 0), list.reduce((sum, candidate) => sum + candidate.output, 0)]];
    }));

    const first = open(base);
    await first.load();
    const initial = await first.collect();
    await first.dispose();
    assert.deepEqual(totals(initial.events), { "codex:Codex": [2, 150, 12], "claude:Claude Code": [0, 0, 0], "codex:Hermes": [0, 0, 0] });
    const firstState = (await saved()).collector;
    assert.ok(Object.values(firstState.files).some((entry) => entry.claude?.pending?.id === "message-a"), "the streaming Claude message is held");
    assert.ok(Object.values(firstState.files).some((entry) => entry.codex?.total), "the Codex cumulative total is kept");

    await appendFile(rollout, `${codexCount(base - 30 * 60_000, [180, 15, 14], [30, 5, 2])}\n`);
    hermes(`UPDATE session_model_usage SET input_tokens = 1300, output_tokens = 140, last_seen = ${(base + 5 * 60_000) / 1000};`);
    const second = open(base + 10 * 60_000);
    await second.load();
    assert.equal(second.get().error, null, "a v2 collector state reloads without invalid records");
    const next = await second.collect();
    await second.dispose();
    assert.deepEqual(totals(next.events), {
      "codex:Codex": [3, 180, 14], "claude:Claude Code": [1, 10, 2], "codex:Hermes": [1, 300, 40]
    });

    const third = open(base + 20 * 60_000);
    await third.load();
    const last = await third.collect();
    assert.deepEqual(last.events, next.events, "a further restart adds nothing");
    assert.equal(last.coverage.some((line) => /invalid|dropped/i.test(line)), false);
  });
});

test("independent Codex sessions with equal counters survive collection, persistence and reload", async () => {
  await withDirectory(async (directory) => {
    const home = join(directory, "home");
    const data = join(directory, "data");
    await mkdir(data);
    const base = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const counts = ([input, cached, output]) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
    const line = (at, total, last) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: counts(total), last_token_usage: counts(last) } } });
    const rollout = async (id, folder, start) => {
      const path = join(home, ".codex", folder, `rollout-2026-09-20T10-00-00-${id}.jsonl`);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, [
        JSON.stringify({ timestamp: iso(start), type: "session_meta", payload: { id, originator: "codex_cli_rs" } }),
        line(start + 1_000, [100, 10, 5], [100, 10, 5]),
        line(start + 2_000, [150, 10, 12], [50, 0, 7])
      ].join("\n") + "\n");
    };
    await rollout("0199aaaa-0000-0000-0000-00000000000a", "sessions", base - 40 * 60_000);
    await rollout("0199aaaa-0000-0000-0000-00000000000b", "sessions", base - 30 * 60_000);
    // A copy of session a in another folder is the same usage.
    await rollout("0199aaaa-0000-0000-0000-00000000000a", "archived_sessions", base - 40 * 60_000);
    const open = (clock) => new UsageHistoryService({
      directory: data, limits: noLimits(), createCollector: (state) => new LocalUsageCollector(home, state, {}), now: () => clock
    });
    const summary = (events) => events.map((candidate) => [candidate.session.slice(-1), candidate.input, candidate.output]);
    const expected = [["a", 100, 5], ["a", 50, 7], ["b", 100, 5], ["b", 50, 7]];

    const first = open(base);
    await first.load();
    assert.deepEqual(summary((await first.collect()).events), expected);
    await first.dispose();
    const stored = JSON.parse(await readFile(join(data, FILE), "utf8"));
    assert.deepEqual(summary(stored.history.events), expected, "both sessions are persisted");

    const reopened = open(base + 10 * 60_000);
    await reopened.load();
    assert.equal(reopened.get().error, null);
    assert.deepEqual(summary(reopened.get().events), expected, "both sessions survive a reload");
    assert.deepEqual(summary((await reopened.collect()).events), expected, "a later collection neither re-adds nor collapses them");
  });
});

test("a reset collector state never re-adds stored Codex usage under new ids; new independent sessions still count", async () => {
  const variants = [{ name: "current history, cursors lost", reset: () => ({ version: 2, files: {}, hermes: {} }) }];
  for (const variant of variants) {
    await withDirectory(async (directory) => {
      const home = join(directory, "home");
      const data = join(directory, "data");
      await mkdir(data);
      const base = Date.now();
      let clock = base;
      const iso = (ms) => new Date(ms).toISOString();
      const counts = ([input, cached, output]) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
      const line = (at, total, last) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: counts(total), last_token_usage: counts(last) } } });
      const rollout = async (id, start) => {
        const path = join(home, ".codex", "sessions", `rollout-2026-09-20T10-00-00-${id}.jsonl`);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, [
          JSON.stringify({ timestamp: iso(start), type: "session_meta", payload: { id, originator: "codex_cli_rs" } }),
          line(start + 1_000, [100, 10, 5], [100, 10, 5]),
          line(start + 2_000, [150, 10, 12], [50, 0, 7])
        ].join("\n") + "\n");
      };
      await rollout("0199aaaa-0000-0000-0000-00000000000a", base - 40 * 60_000);
      const open = () => new UsageHistoryService({
        directory: data, limits: noLimits(), now: () => clock,
        createCollector: (state) => new LocalUsageCollector(home, state, {})
      });
      const summary = (events) => events.map((candidate) => [candidate.session.slice(-1), candidate.input, candidate.output]);

      const first = open();
      await first.load();
      await first.collect();
      await first.dispose();
      const stored = JSON.parse(await readFile(join(data, FILE), "utf8"));
      stored.collector = variant.reset(stored.collector);
      await writeFile(join(data, FILE), JSON.stringify(stored));

      clock = base + 10 * 60_000;
      const reopened = open();
      await reopened.load();
      // Two new, independent sessions after the reload have the same counters as the stored one.
      await rollout("0199aaaa-0000-0000-0000-00000000000c", base + 11 * 60_000);
      await rollout("0199aaaa-0000-0000-0000-00000000000d", base + 12 * 60_000);
      clock = base + 15 * 60_000;
      const expected = [["a", 100, 5], ["a", 50, 7], ["c", 100, 5], ["c", 50, 7], ["d", 100, 5], ["d", 50, 7]];
      const collected = await reopened.collect();
      assert.deepEqual(summary(collected.events), expected, `${variant.name}: stored usage is not re-added; new sessions count`);
      assert.equal(collected.health.at(-1).lost === true, variant.skips === true, `${variant.name}: skipped replays are disclosed as lost`);
      assert.equal(collected.coverage.some((line) => /not added again/.test(line)), variant.skips === true);
      await reopened.dispose();

      // Losing cursors again still replays the same lineage ids.
      const saved = JSON.parse(await readFile(join(data, FILE), "utf8"));
      saved.collector = { version: 2, files: {}, hermes: {} };
      await writeFile(join(data, FILE), JSON.stringify(saved));
      clock = base + 16 * 60_000;
      const again = open();
      await again.load();
      assert.deepEqual(summary((await again.collect()).events), expected, `${variant.name}: stable across a further reload and collection`);
      await again.dispose();
      assert.deepEqual(summary(JSON.parse(await readFile(join(data, FILE), "utf8")).history.events), expected);
    });
  }
});

test("usage history is exposed only to the trusted main renderer and wired into startup and shutdown", async () => {
  const [contracts, preload, ipc, main] = await Promise.all([
    readFile(new URL("../src/shared/contracts.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main/ipc/registerIpc.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main/index.ts", import.meta.url), "utf8")
  ]);
  assert.match(contracts, /usageHistoryGet: "usage-history:get"/);
  assert.match(contracts, /usageHistory: \{\s*get\(\): Promise<UsageHistory>;\s*\}/);
  assert.match(contracts, /accountScope\?: string \| null;/);
  assert.match(preload, /usageHistory: \{\s*get: \(\) => ipcRenderer\.invoke\(IPC\.usageHistoryGet\)\s*\}/);
  assert.match(ipc, /ipcMain\.handle\(IPC\.usageHistoryGet, \(event\) => \{\s*assertMainRenderer\(event, getMainWindow\);\s*return usageHistory\.get\(\);/);
  assert.match(ipc, /method === "limits\.get"[\s\S]{0,200}withoutAccountScope\(await limits\.get\(\)\)/);

  const initialize = main.slice(main.indexOf("async function initializeServices"), main.indexOf("async function loadApplication"));
  assert.match(initialize, /new UsageHistoryService\(\{\s*directory: userDataPath,/);
  const loaded = initialize.indexOf("await usageHistory.load()");
  const registered = initialize.indexOf("registerIpc(ipc,");
  assert.ok(loaded >= 0 && registered > loaded, "history is loaded before trusted IPC registration");
  assert.ok(initialize.indexOf("usageHistory.start()") > loaded);
  assert.match(initialize, /const userDataPath = app\.getPath\("userData"\)/);
  assert.match(initialize, /usageHistory\.start\(\)/);
  assert.match(initialize, /limits: async \(\) => withoutAccountScope\(await limitsService!\.get\(\)\)/);
  const shutdown = main.slice(main.indexOf("async function shutdownServices"), main.indexOf("async function openPluginWindow"));
  assert.ok(shutdown.indexOf("usageHistory?.dispose()") >= 0);
  assert.ok(shutdown.indexOf("usageHistory?.dispose()") < shutdown.indexOf("limitsService?.dispose()"));

  assert.doesNotMatch(main, /preparePatchedData|patchedIsolation/);
  assert.match(main, /app\.whenReady\(\)/);
  assert.match(main, /initializeServices\(ipcReadinessGate\(\)\)/);
  assert.ok(initialize.indexOf('servicesReady = true') > registered, 'service readiness follows history registration');
  assert.match(main, /void shutdownServices\(\)\.finally\(/);
});

for (const version of [undefined, 1, 99]) {
  test(`unsupported collector version ${version} preserves history without migration`, async () => {
    await withDirectory(async (directory) => {
      const raw = JSON.stringify(envelope({ health: [] }, { version, files: {}, hermes: {} }));
      await writeFile(join(directory, FILE), raw);
      const h = service(directory);
      await h.history.load();
      await h.history.collect();
      await h.history.dispose();
      assert.equal(await readFile(join(directory, FILE), "utf8"), raw);
      assert.match(h.history.get().error, /unsupported/i);
    });
  });
}

test("prototype store envelopes are not migrated or overwritten", async () => {
  await withDirectory(async (directory) => {
    const raw = JSON.stringify(envelope({ health: [] }, { version: 2, files: {}, hermes: {} }, { version: 1 }));
    await writeFile(join(directory, FILE), raw);
    const { history } = service(directory);
    await history.load();
    await history.collect();
    await history.dispose();
    assert.equal(await readFile(join(directory, FILE), "utf8"), raw);
    assert.match(history.get().error, /unsupported format/i);
  });
});
