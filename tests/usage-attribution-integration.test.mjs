/**
 * End-to-end: real LocalUsageCollector over synthetic Codex/Claude logs in a temporary home,
 * real UsageHistoryService persistence (save → dispose → load in a new instance), and the
 * pure report. Nothing outside the temporary directories is read or written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalUsageCollector } from "../src/main/services/LocalUsageCollector.ts";
import { UsageHistoryService } from "../src/main/services/UsageHistoryService.ts";
import { buildUsageReport } from "../src/shared/usageReport.ts";

const MIN = 60_000;
const REAL_NOW = Math.floor(Date.now() / 1000) * 1000;
const BASE = REAL_NOW - 40 * MIN;
const RESET = BASE + 4 * 60 * MIN;
const CODEX_SCOPE = "scope-codex-integration";
const CLAUDE_SCOPE = "scope-claude-integration";
const iso = (ms) => new Date(ms).toISOString();

async function temporary(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function write(path, lines) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n") + "\n");
}

// Log fixtures in the shipped formats (see tests/usage-collector.test.mjs); no conversation content is needed.
const tokens = ([input, cached, output]) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const codexMeta = (id, at) => JSON.stringify({ timestamp: iso(at), type: "session_meta", payload: { id, timestamp: iso(at), cwd: "/tmp/fixture", originator: "codex_cli_rs", cli_version: "0.50.0", source: "cli", model_provider: "openai" } });
const codexCount = (at, total, last) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: tokens(total), last_token_usage: tokens(last), model_context_window: 258_400 }, rate_limits: null } });
const rollout = (home, id) => join(home, ".codex", "sessions", "2026", "09", "20", `rollout-2026-09-20T10-00-00-${id}.jsonl`);
const assistant = (session, id, at, [input, read, write, output]) => JSON.stringify({
  parentUuid: null, isSidechain: false, userType: "external", cwd: "/tmp/fixture", sessionId: session, version: "2.1.0",
  type: "assistant", uuid: randomUUID(), timestamp: iso(at), requestId: `req_${id}`,
  message: { id, type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null,
    usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output, service_tier: "standard" } }
});

function limitsWindow(id, usedPercent, resetsAt) {
  return { id, bucketId: id.split(":")[0], slot: "primary", isDefaultBucket: true, label: "5h", usedPercent, used: null, limit: null, windowMinutes: 300, resetsAt };
}
function snapshot(at, codexPercent, claudePercent, claudeJitter) {
  return {
    fetchedAt: at,
    providers: [
      { provider: "codex", state: "available", source: "codex-app-server", fetchedAt: at, accountScope: CODEX_SCOPE, windows: [limitsWindow("codex:primary", codexPercent, RESET)] },
      { provider: "claude", state: "available", source: "claude-usage-api", fetchedAt: at, accountScope: CLAUDE_SCOPE, windows: [limitsWindow("claude:five_hour", claudePercent, RESET + claudeJitter)] }
    ]
  };
}

/** Service over a real collector; the clock and the next limits snapshot are driven by the test. */
function harness(directory, home, options = {}) {
  // Collection starts well before the first sample, so the Hermes baseline warm-up is over.
  let clock = options.start ?? BASE - 5 * MIN;
  let next = snapshot(BASE, 0, 0, 0);
  let byteBudget = options.byteBudget;
  const service = new UsageHistoryService({
    directory,
    limits: { getProviders: async () => structuredClone(next) },
    createCollector: (state) => new LocalUsageCollector(home, state, {}, byteBudget === undefined ? {} : { byteBudget }),
    now: () => clock,
    initialDelayMs: 3_600_000
  });
  return {
    service,
    async run(at, limits, budget = byteBudget) {
      clock = at;
      if (limits) next = limits;
      byteBudget = budget;
      return service.collect();
    }
  };
}

const codexWindow = (report) => report.providers.find((p) => p.provider === "codex")?.windows.find((w) => w.windowId === "codex:primary");
const claudeWindow = (report) => report.providers.find((p) => p.provider === "claude")?.windows.find((w) => w.windowId === "claude:five_hour");
const account = (window, scope) => window.accounts.find((a) => a.scope === scope);
const byReason = (a) => Object.fromEntries(a.attribution.unestimable.map((u) => [u.reason, u.delta]));
const pointsOf = (a) => Object.fromEntries(a.attribution.conditional.sessions.map((s) => [s.session, s.points]));
function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? "value"}: expected ${expected}, got ${actual}`);
}
function conserved(a, message) {
  const unestimated = a.attribution.unestimable.reduce((sum, u) => sum + u.delta, 0);
  close(a.attribution.eligible.delta + unestimated, a.measuredDelta, `${message}: eligible + unestimable = measured`);
  close(a.attribution.conditional.sessions.reduce((sum, s) => sum + s.points, 0), a.attribution.eligible.delta, `${message}: sessions = eligible`);
  assert.deepEqual(a.attribution.externalRange, { min: 0, max: a.measuredDelta }, `${message}: external 0..measured`);
}

/**
 * Agents append log lines as they work; `feed(now)` writes every line whose time has come,
 * so the collector never sees a line from its future.
 */
async function writeLogs(home) {
  const codexA = randomUUID();
  const codexB = randomUUID();
  const claude = randomUUID();
  const transcript = join(home, ".claude", "projects", "-tmp-fixture", `${claude}.jsonl`);
  await write(rollout(home, codexA), [codexMeta(codexA, BASE - 5 * MIN)]);
  await write(rollout(home, codexB), [codexMeta(codexB, BASE - 5 * MIN)]);
  await mkdir(dirname(transcript), { recursive: true });
  const pending = [
    [rollout(home, codexA), BASE + 1.5 * MIN, codexCount(BASE + 1.5 * MIN, [3_000, 0, 300], [3_000, 0, 300])],
    [transcript, BASE + 1.6 * MIN, assistant(claude, "msg_1", BASE + 1.6 * MIN, [100, 0, 0, 10])],
    [rollout(home, codexB), BASE + 1.7 * MIN, codexCount(BASE + 1.7 * MIN, [1_000, 0, 100], [1_000, 0, 100])],
    [rollout(home, codexA), BASE + 2.5 * MIN, codexCount(BASE + 2.5 * MIN, [5_000, 0, 500], [2_000, 0, 200])],
    [transcript, BASE + 2.6 * MIN, assistant(claude, "msg_2", BASE + 2.6 * MIN, [300, 0, 0, 30])]
  ];
  const feed = async (now) => {
    while (pending.length && pending[0][1] <= now) {
      const [path, , line] = pending.shift();
      await appendFile(path, line + "\n");
    }
  };
  return { codexA, codexB, claude, feed };
}

async function collectFiveMinutes(h, feed = async () => undefined) {
  const jitters = [0, -323, 396, 36, -67];
  const codex = [10, 12, 15, 15, 15];
  const claude = [20, 21, 24, 24, 24];
  for (let index = 0; index < 5; index += 1) {
    const at = BASE + (index + 1) * MIN;
    await feed(at);
    await h.run(at, snapshot(at, codex[index], claude[index], jitters[index]));
  }
}

test("collector → persisted history → reload → report: automatic conditional estimates with maturity, jitter and restart", async (t) => {
  const home = await temporary(t, "usage-int-home-");
  const directory = await temporary(t, "usage-int-data-");
  const ids = await writeLogs(home);

  const first = harness(directory, home);
  await first.service.load();
  await collectFiveMinutes(first, ids.feed);
  await first.run(BASE + 6 * MIN, snapshot(BASE + 6 * MIN, 15, 24, 8));

  // Two minutes on, Codex logs are mature while the Claude transcript is still being held.
  const early = buildUsageReport(first.service.get(), { now: BASE + 6 * MIN, period: "1h" });
  assert.equal(early.attribution.coverage.level, "recorded");
  assert.equal(early.attribution.coverage.recordedSince, BASE + MIN);
  assert.equal(first.service.get().health.length, 6);
  assert.ok(first.service.get().health.every((entry) => entry.complete), "every run read all present logs");
  const codexEarly = account(codexWindow(early), CODEX_SCOPE);
  close(codexEarly.measuredDelta, 5);
  close(codexEarly.attribution.conditional.points, 5, "Codex change is estimated without any manual input");
  // (BASE+1, BASE+2]: A 3300 vs B 1100 uncached tokens → 1.5 : 0.5; (BASE+2, BASE+3]: A only → 3.
  close(pointsOf(codexEarly)[ids.codexA], 4.5);
  close(pointsOf(codexEarly)[ids.codexB], 0.5);
  assert.deepEqual(codexEarly.attribution.conditional.apps.map((app) => app.app), ["Codex CLI"]);
  conserved(codexEarly, "codex early");

  const claudeEarly = account(claudeWindow(early), CLAUDE_SCOPE);
  close(claudeEarly.measuredDelta, 4, "sub-second Claude reset jitter does not break the series");
  assert.equal(claudeWindow(early).resetBoundaries, 0);
  close(claudeEarly.attribution.conditional.points, 0);
  close(byReason(claudeEarly)["pending-maturity"], 4, "not yet 7 minutes after the interval");
  conserved(claudeEarly, "claude early");

  // Much later the transcript idles: its held message is collected late and the estimate appears.
  const later = REAL_NOW + 6 * MIN;
  await first.run(later);
  const mature = buildUsageReport(first.service.get(), { now: later, period: "1h" });
  const claudeMature = account(claudeWindow(mature), CLAUDE_SCOPE);
  close(claudeMature.attribution.conditional.points, 4);
  close(pointsOf(claudeMature)[ids.claude], 4);
  conserved(claudeMature, "claude mature");
  assert.equal(JSON.stringify(mature).includes("/tmp/fixture"), false, "no working directory leaves the collector");

  // Persist and reload in a fresh service: the same history yields the same report.
  const eventsBefore = first.service.get().events.length;
  await first.service.dispose();
  const second = harness(directory, home, { start: later });
  await second.service.load();
  const reloaded = buildUsageReport(second.service.get(), { now: later, period: "1h" });
  assert.deepEqual(reloaded.providers, mature.providers);
  assert.deepEqual(reloaded.attribution, mature.attribution);

  // Restart after downtime: the gap is unknown, cursors do not re-read old logs, new change without logs is unestimable.
  const restartAt = REAL_NOW + 20 * MIN;
  await second.run(restartAt, snapshot(restartAt, 18, 24, 8));
  await second.run(restartAt + MIN, snapshot(restartAt + MIN, 19, 24, 8));
  const history = second.service.get();
  assert.equal(history.events.length, eventsBefore, "no duplicated events after restart");
  const afterRestart = buildUsageReport(history, { now: restartAt + 5 * MIN, period: "24h" });
  const codexAfter = account(codexWindow(afterRestart), CODEX_SCOPE);
  assert.ok(codexWindow(afterRestart).unknownIntervals.some((item) => item.reason === "collection-gap"));
  close(codexAfter.measuredDelta, 6, "5 before + 1 after, never the 3 across the gap");
  close(byReason(codexAfter)["no-local-evidence"], 1);
  close(codexAfter.attribution.conditional.points, 5);
  conserved(codexAfter, "codex after restart");
  await second.service.dispose();
});

test("a read backlog defers estimates; the next complete run supplies the late events", async (t) => {
  const home = await temporary(t, "usage-int-home-");
  const directory = await temporary(t, "usage-int-data-");
  const ids = await writeLogs(home);
  const h = harness(directory, home, { byteBudget: 1 });
  await h.service.load();
  // Other busy transcripts change on every run, so a one-byte budget always leaves logs unread.
  let busy = 0;
  const feed = async (now) => {
    await ids.feed(now);
    for (let index = 0; index < 3; index += 1) {
      busy += 1;
      const session = randomUUID();
      await write(join(home, ".claude", "projects", "-tmp-busy", `${session}.jsonl`), [assistant(session, `busy_${busy}`, now - 1_000, [1, 0, 0, 1])]);
    }
  };
  await collectFiveMinutes(h, feed);
  await feed(BASE + 6 * MIN);
  await h.run(BASE + 6 * MIN, snapshot(BASE + 6 * MIN, 15, 24, 8));

  const backlog = buildUsageReport(h.service.get(), { now: BASE + 6 * MIN, period: "1h" });
  assert.equal(backlog.attribution.coverage.backlog, true, "the collector reported a read budget backlog");
  const codex = account(codexWindow(backlog), CODEX_SCOPE);
  close(codex.attribution.conditional.points, 0, "nothing is estimated while logs are unread");
  // Which logs a one-byte budget reaches first is not fixed: read evidence waits, unread evidence is absent.
  assert.ok(codex.attribution.unestimable.every((u) => ["source-backlog", "no-local-evidence"].includes(u.reason)));
  conserved(codex, "codex backlog");

  await h.run(BASE + 7 * MIN, snapshot(BASE + 7 * MIN, 15, 24, 8), 128 * 1024 * 1024);
  const complete = buildUsageReport(h.service.get(), { now: BASE + 7 * MIN, period: "1h" });
  assert.equal(complete.attribution.coverage.backlog, false);
  const codexComplete = account(codexWindow(complete), CODEX_SCOPE);
  close(codexComplete.attribution.conditional.points, 5);
  close(pointsOf(codexComplete)[ids.codexA], 4.5);
  conserved(codexComplete, "codex complete");
  await h.service.dispose();
});

test("recorded health: an unreadable log blocks estimates until read; a lost record blocks only clusters it may have held", { skip: process.getuid?.() === 0 }, async (t) => {
  const home = await temporary(t, "usage-int-home-");
  const directory = await temporary(t, "usage-int-data-");
  const ids = await writeLogs(home);
  // A discovered rollout without accounting that cannot be opened: nothing in it is known.
  const locked = rollout(home, randomUUID());
  await write(locked, [codexMeta("locked", BASE - 5 * MIN)]);
  await chmod(locked, 0);
  t.after(() => chmod(locked, 0o644).catch(() => undefined));
  const h = harness(directory, home);
  await h.service.load();
  await collectFiveMinutes(h, ids.feed);
  await h.run(BASE + 6 * MIN, snapshot(BASE + 6 * MIN, 15, 24, 8));

  const blocked = buildUsageReport(h.service.get(), { now: BASE + 6 * MIN, period: "1h" });
  assert.equal(blocked.attribution.coverage.latestRunComplete, false);
  assert.equal(blocked.attribution.coverage.backlog, false, "an unreadable log is not reported as a read backlog");
  assert.ok(blocked.collection.coverage.some((line) => /1 entries unreadable/.test(line)), "the reason is in the coverage");
  const codexBlocked = account(codexWindow(blocked), CODEX_SCOPE);
  close(codexBlocked.attribution.conditional.points, 0);
  close(byReason(codexBlocked)["collection-incomplete"], 5);
  conserved(codexBlocked, "codex unreadable");

  await chmod(locked, 0o644);
  await h.run(BASE + 7 * MIN, snapshot(BASE + 7 * MIN, 15, 24, 8));
  const readable = account(codexWindow(buildUsageReport(h.service.get(), { now: BASE + 7 * MIN, period: "1h" })), CODEX_SCOPE);
  close(readable.attribution.conditional.points, 5, "the first complete run covers the earlier incomplete runs");

  // A consumed unparsable accounting line: the run is lossy, and no later run recovers it.
  await appendFile(rollout(home, ids.codexA), '{"type":"event_msg","payload":{"type":"token_count",\n');
  await h.run(BASE + 8 * MIN, snapshot(BASE + 8 * MIN, 15, 24, 8));
  await appendFile(rollout(home, ids.codexA), codexCount(BASE + 8.5 * MIN, [6_000, 0, 600], [1_000, 0, 100]) + "\n");
  await h.run(BASE + 9 * MIN, snapshot(BASE + 9 * MIN, 17, 24, 8));
  await h.run(BASE + 11 * MIN, snapshot(BASE + 11 * MIN, 17, 24, 8));
  const health = h.service.get().health;
  assert.deepEqual(health.find((entry) => entry.at === BASE + 8 * MIN), { at: BASE + 8 * MIN, complete: false, lost: true });
  assert.equal(health.at(-1).complete, true);
  await h.service.dispose();

  const reloaded = harness(directory, home, { start: BASE + 11 * MIN });
  await reloaded.service.load();
  assert.deepEqual(reloaded.service.get().health, health, "health survives persistence");
  const after = account(codexWindow(buildUsageReport(reloaded.service.get(), { now: BASE + 11 * MIN, period: "1h" })), CODEX_SCOPE);
  close(after.measuredDelta, 7);
  close(after.attribution.conditional.points, 5, "clusters covered before the loss stay estimated");
  close(byReason(after)["records-lost"], 2, "the cluster read by the lossy run stays unestimated after later complete runs");
  conserved(after, "codex after loss");
  assert.equal(JSON.stringify(health).includes(home), false);
  await reloaded.service.dispose();
});

test("no local logs at all: measured change is reported, nothing is estimated and external stays 0..measured", async (t) => {
  const home = await temporary(t, "usage-int-home-");
  const directory = await temporary(t, "usage-int-data-");
  const h = harness(directory, home);
  await h.service.load();
  await collectFiveMinutes(h);
  const report = buildUsageReport(h.service.get(), { now: BASE + 5 * MIN, period: "1h" });
  const codex = account(codexWindow(report), CODEX_SCOPE);
  close(codex.measuredDelta, 5);
  close(byReason(codex)["no-local-evidence"], 5);
  assert.deepEqual(codex.attribution.conditional.sessions, []);
  conserved(codex, "no logs");
  assert.ok(report.collection.coverage.some((line) => /Hermes: no state\.db found/.test(line)));
  await h.service.dispose();
});

test("an account switch between polls splits the series; logs are never moved across accounts", async (t) => {
  const home = await temporary(t, "usage-int-home-");
  const directory = await temporary(t, "usage-int-data-");
  const ids = await writeLogs(home);
  const h = harness(directory, home);
  await h.service.load();
  const other = "scope-codex-other";
  const switched = (at, percent, scope) => {
    const value = snapshot(at, percent, 20, 0);
    value.providers[0].accountScope = scope;
    return value;
  };
  for (const [minutes, percent, scope] of [[1, 10, CODEX_SCOPE], [2, 12, CODEX_SCOPE], [3, 40, other], [4, 41, other], [6, 41, other]]) {
    await ids.feed(BASE + minutes * MIN);
    await h.run(BASE + minutes * MIN, switched(BASE + minutes * MIN, percent, scope));
  }
  const report = buildUsageReport(h.service.get(), { now: BASE + 6 * MIN, period: "1h" });
  const window = codexWindow(report);
  const a = account(window, CODEX_SCOPE);
  const b = account(window, other);
  close(a.attribution.conditional.points, 2);
  assert.deepEqual(Object.keys(pointsOf(a)).sort(), [ids.codexA, ids.codexB].sort());
  close(b.measuredDelta, 1);
  close(byReason(b)["no-local-evidence"], 1, "the event during the switch is not moved to the new account");
  assert.ok(window.unknownIntervals.some((item) => item.reason === "account-changed"));
  await h.service.dispose();
});
