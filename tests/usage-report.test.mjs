import test from "node:test";
import assert from "node:assert/strict";
import * as usageReport from "../src/shared/usageReport.ts";

const {
  ATTRIBUTION_LAG_MS,
  HISTORY_STALE_AFTER_MS,
  QUOTA_MAX_GAP_MS,
  USAGE_PERIODS,
  buildUsageReport,
  compareQuotaSamples,
  eventWeight,
  evidenceMaturityMs,
  isUsagePeriod,
  parseUsageHistory,
  resetToleranceMs
} = usageReport;

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const RESET = NOW + 3 * HOUR;
// Inside the +2 interval (11 → 13) of steadyStream().
const PLUS_TWO = NOW - 28 * MIN - 30_000;

function sample(at, percent, patch = {}) {
  return { provider: "codex", scope: "acct-a", windowId: "codex:primary", at, reset: RESET, percent, ...patch };
}
function event(id, at, patch = {}) {
  return {
    id, provider: "codex", app: "Codex CLI", profile: "", session: "s-1",
    from: at, to: at, input: 100, output: 10, cached: 0, timing: "event", ...patch
  };
}
function history(samples, events = [], patch = {}) {
  return {
    version: 1, startedAt: NOW - 40 * 86_400_000, collectedAt: NOW - 10_000,
    samples, events, coverage: [], providerStatus: [], error: null,
    health: [{ at: NOW - 40 * 86_400_000, complete: true }, { at: NOW - 10_000, complete: true }], ...patch
  };
}
function report(h, options = {}) {
  return buildUsageReport(h, { now: NOW, period: "1h", ...options });
}
function windowOf(r, provider = "codex", windowId = "codex:primary") {
  return r.providers.find((p) => p.provider === provider)?.windows.find((w) => w.windowId === windowId);
}
function accountOf(w, scope = "acct-a") {
  return w.accounts.find((a) => a.scope === scope);
}
function close(actual, expected, message) {
  // Relative for large sums: thirty days of floating-point additions differ only in the last digits.
  assert.ok(Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected)), `${message ?? "value"}: expected ${expected}, got ${actual}`);
}
/** Five comparable observations one minute apart: 10 → 11 → 13 → 13 → 16. */
function steadyStream(patch = {}) {
  return [10, 11, 13, 13, 16].map((percent, index) => sample(NOW - 30 * MIN + index * MIN, percent, patch));
}
function points(account) {
  return Object.fromEntries(account.attribution.conditional.sessions.map((s) => [s.session, s.points]));
}
function unestimable(account) {
  return Object.fromEntries(account.attribution.unestimable.map((u) => [u.reason, u.delta]));
}
/** Every measured point is either conditionally estimated or listed as unestimable; the tree sums to the estimate. */
function assertConserved(account, message = "") {
  const a = account.attribution;
  const unestimated = a.unestimable.reduce((sum, u) => sum + u.delta, 0);
  close(a.eligible.delta + unestimated, account.measuredDelta, `${message} eligible + unestimable = measured`);
  const sessions = a.conditional.sessions.reduce((sum, s) => sum + s.points, 0);
  close(sessions, a.eligible.delta, `${message} sessions = eligible`);
  const tree = a.conditional.apps.reduce((sum, app) => sum + app.points, 0);
  close(tree, a.eligible.delta, `${message} tree = eligible`);
  for (const app of a.conditional.apps) {
    close(app.profiles.reduce((sum, p) => sum + p.points, 0), app.points, `${message} ${app.app} profiles`);
    for (const profile of app.profiles) close(profile.sessions.reduce((sum, s) => sum + s.points, 0), profile.points, `${message} profile`);
  }
  close(a.conditional.points, a.eligible.delta, `${message} conditional points`);
  assert.deepEqual(a.externalRange, { min: 0, max: account.measuredDelta }, `${message} external stays 0..measured`);
  close(a.unattributed, account.measuredDelta, `${message} nothing is proven`);
  assert.ok(a.eligible.delta >= -1e-9 && a.eligible.delta <= account.measuredDelta + 1e-9, `${message} bounds`);
}

test("missing per-run health cannot authorize conditional attribution", () => {
  const r = report(history(steadyStream(), [event("missing-health", PLUS_TWO)], { health: undefined }));
  const a = accountOf(windowOf(r));
  assert.equal(a.measuredDelta, 6);
  assert.equal(a.attribution.conditional.points, 0);
  assert.equal(unestimable(a)["coverage-unrecorded"], 2);
});

test("quota comparison rejects unsafe boundaries with literal decisions", () => {
  const a = sample(1_000, 20, { reset: 1_000_000 });
  assert.deepEqual(compareQuotaSamples(a, { ...a, at: 61_000, percent: 25 }), { delta: 5, reason: null });
  const cases = [
    [{ reset: 2_000_000 }, "reset-boundary"], [{ scope: "b" }, "account-changed"],
    [{ scope: null }, "account-unknown"], [{ provider: "claude" }, "account-changed"],
    [{ windowId: "weekly" }, "window-changed"], [{ percent: 19 }, "counter-decreased"],
    [{ percent: NaN }, "invalid-percentage"], [{ percent: -1 }, "invalid-percentage"],
    [{ percent: 101 }, "invalid-percentage"], [{ at: 999 }, "invalid-time"],
    [{ at: 1_000 }, "invalid-time"], [{ at: Infinity }, "invalid-time"],
    [{ at: 301_001 }, "collection-gap"], [{ reset: null }, "reset-unknown"],
    [{ at: 1_000_000 }, "reset-boundary"], [{ reset: 1_000_008 }, "reset-boundary"]
  ];
  for (const [patch, reason] of cases) assert.deepEqual(compareQuotaSamples(a, { ...a, at: 61_000, percent: 25, ...patch }), { delta: null, reason });
  assert.deepEqual(compareQuotaSamples(a, { ...a, at: 301_000, percent: 25 }), { delta: 5, reason: null });
  const stale = { ...a, reset: 30_000 };
  assert.equal(compareQuotaSamples(stale, { ...stale, at: 61_000, percent: 25 }).reason, "reset-boundary");
  const claude = { ...a, provider: "claude" };
  for (const jitter of [-1000, -323, -23, 396, 36, -67, 8, 1000])
    assert.deepEqual(compareQuotaSamples(claude, { ...claude, at: 61_000, percent: 25, reset: a.reset + jitter }), { delta: 5, reason: null });
  for (const jitter of [-1001, 1001, 3_600_000])
    assert.deepEqual(compareQuotaSamples(claude, { ...claude, at: 61_000, percent: 25, reset: a.reset + jitter }), { delta: null, reason: "reset-boundary" });
  assert.equal(compareQuotaSamples(claude, { ...claude, at: 61_000, percent: 19, reset: a.reset + 300 }).reason, "counter-decreased");
  const near = { ...claude, reset: 60_500 };
  for (const patch of [{ at: 60_600, reset: 61_400 }, { at: 60_400, reset: 59_900 }])
    assert.equal(compareQuotaSamples(near, { ...near, percent: 25, ...patch }).reason, "reset-boundary");
});

test("Claude reset identity tolerates sub-second jitter; real resets, decreases and chained drift stay rejected", () => {
  assert.equal(resetToleranceMs("claude"), 1_000);
  assert.equal(resetToleranceMs("codex"), 0);
  const claude = (at, percent, jitter, patch = {}) => sample(at, percent, {
    provider: "claude", windowId: "claude:five_hour", reset: RESET + jitter, ...patch
  });
  const jitters = [-323, -23, 396, 36, -67, 8];
  const samples = jitters.map((jitter, index) => claude(NOW - 20 * MIN + index * MIN, 10 + index, jitter));
  const w = windowOf(report(history(samples)), "claude", "claude:five_hour");
  const a = accountOf(w);
  close(a.measuredDelta, 5, "every jittered pair is comparable");
  assert.equal(a.measuredIntervals, 5);
  assert.equal(w.resetBoundaries, 0);
  assert.equal(a.resetsSeen.length, 1, "jittered resets are one window reset");

  // A real reset (+5 h) and a decrease remain unknown, never consumption.
  const real = [
    claude(NOW - 10 * MIN, 40, 0), claude(NOW - 9 * MIN, 42, 300),
    claude(NOW - 8 * MIN, 1, 5 * HOUR), claude(NOW - 7 * MIN, 3, 5 * HOUR - 200), claude(NOW - 6 * MIN, 2, 5 * HOUR)
  ];
  const rw = windowOf(report(history(real)), "claude", "claude:five_hour");
  close(accountOf(rw).measuredDelta, 4, "40→42 and 1→3 only");
  const reasons = Object.fromEntries(rw.unknownIntervals.map((item) => [item.reason, item.count]));
  assert.equal(reasons["reset-boundary"], 1);
  assert.equal(reasons["counter-decreased"], 1);

  // +600 ms per poll: each pair is within 1 s, but the chain may not drift past the tolerance.
  const drift = [0, 600, 1_200, 1_800].map((jitter, index) => claude(NOW - 5 * MIN + index * MIN, 50 + index, jitter));
  const dw = windowOf(report(history(drift)), "claude", "claude:five_hour");
  assert.equal(accountOf(dw).measuredIntervals, 2, "0→600 measured, 600→1200 exceeds the chain anchor, 1200→1800 starts a new chain");
  assert.equal(Object.fromEntries(dw.unknownIntervals.map((item) => [item.reason, item.count]))["reset-boundary"], 1);

  // Codex resets are exact: sub-second differences are still a boundary.
  const codex = [sample(NOW - 5 * MIN, 10), sample(NOW - 4 * MIN, 12, { reset: RESET + 400 })];
  assert.equal(accountOf(windowOf(report(history(codex)))).measuredIntervals, 0);
});

test("period presets are rolling 1h/24h/7d/30d windows and unknown presets are rejected", () => {
  assert.deepEqual(Object.keys(USAGE_PERIODS), ["1h", "24h", "7d", "30d"]);
  assert.equal(USAGE_PERIODS["1h"], HOUR);
  assert.equal(USAGE_PERIODS["24h"], 24 * HOUR);
  assert.equal(USAGE_PERIODS["7d"], 7 * 24 * HOUR);
  assert.equal(USAGE_PERIODS["30d"], 30 * 24 * HOUR);
  assert.equal(isUsagePeriod("24h"), true);
  assert.equal(isUsagePeriod("2h"), false);
  assert.equal(isUsagePeriod("toString"), false);
  assert.throws(() => report(history([]), { period: "90d" }), /period/);
  const r = report(history([]), { period: "7d" });
  assert.equal(r.to, NOW);
  assert.equal(r.from, NOW - 7 * 24 * HOUR);
});

test("measures only comparable intervals wholly inside the period and accounts for every millisecond", () => {
  const samples = [sample(NOW - 61 * MIN, 5), sample(NOW - 59 * MIN, 8), ...steadyStream()];
  const r = report(history(samples));
  const w = windowOf(r);
  const a = accountOf(w);
  // 8 → 10 spans a 29 minute collection gap; 5 → 8 straddles the period start.
  close(a.measuredDelta, 6, "measured");
  assert.equal(a.measuredIntervals, 4);
  assert.equal(a.measuredMs, 4 * MIN);
  assert.equal(w.coverage.measured, 4 * MIN);
  assert.equal(w.coverage["period-boundary"], MIN);
  assert.equal(w.coverage["collection-gap"], 29 * MIN);
  assert.equal(w.coverage["no-observations"], 26 * MIN);
  const total = Object.values(w.coverage).reduce((sum, ms) => sum + ms, 0);
  assert.equal(total, HOUR);
  assert.ok(w.unknownIntervals.some((item) => item.reason === "collection-gap" && item.count === 1));
  assert.equal(w.boundaryIntervals, 1);
  close(a.attribution.unattributed, 6);
  assertConserved(a);
});

test("reset boundaries, counter decreases and unknown resets are unknown rather than consumption", () => {
  const nextReset = RESET + 5 * HOUR;
  const samples = [
    sample(NOW - 10 * MIN, 90), sample(NOW - 9 * MIN, 95),
    sample(NOW - 8 * MIN, 2, { reset: nextReset }), sample(NOW - 7 * MIN, 4, { reset: nextReset }),
    sample(NOW - 6 * MIN, 3, { reset: nextReset }), sample(NOW - 5 * MIN, 3, { reset: null }),
    sample(NOW - 4 * MIN, 7, { reset: null })
  ];
  const w = windowOf(report(history(samples)));
  const a = accountOf(w);
  close(a.measuredDelta, 7, "only 90→95 and 2→4");
  const reasons = Object.fromEntries(w.unknownIntervals.map((item) => [item.reason, item.count]));
  assert.equal(reasons["reset-boundary"], 1);
  assert.equal(reasons["counter-decreased"], 1);
  assert.equal(reasons["reset-unknown"], 2);
  assert.deepEqual(a.resetsSeen, [RESET, nextReset]);
  assert.equal(w.resetBoundaries, 1);
});

test("observations past their own reset are not compared even if the reset identity is stale", () => {
  const staleReset = NOW - 5 * MIN;
  const w = windowOf(report(history([sample(NOW - 6 * MIN, 10, { reset: staleReset }), sample(NOW - 4 * MIN, 12, { reset: staleReset })])));
  assert.equal(accountOf(w).measuredDelta, 0);
  assert.equal(w.unknownIntervals[0].reason, "reset-boundary");
});

test("account switches and unknown accounts split series and are never compared", () => {
  const samples = [
    sample(NOW - 10 * MIN, 10), sample(NOW - 9 * MIN, 12),
    sample(NOW - 8 * MIN, 50, { scope: "acct-b" }), sample(NOW - 7 * MIN, 51, { scope: "acct-b" }),
    sample(NOW - 6 * MIN, 13), sample(NOW - 5 * MIN, 14),
    sample(NOW - 4 * MIN, 20, { scope: null }), sample(NOW - 3 * MIN, 22, { scope: null })
  ];
  const w = windowOf(report(history(samples)));
  close(accountOf(w, "acct-a").measuredDelta, 3, "acct-a");
  close(accountOf(w, "acct-b").measuredDelta, 1, "acct-b");
  const unknown = accountOf(w, null);
  assert.equal(unknown.measuredDelta, 0);
  assert.equal(unknown.latest.percent, 22);
  const reasons = Object.fromEntries(w.unknownIntervals.map((item) => [item.reason, item.count]));
  assert.equal(reasons["account-changed"], 2);
  assert.equal(reasons["account-unknown"], 2);
  assert.equal("measuredDelta" in w, false, "no cross-account total is produced");
});

test("the conditional estimate is automatic: no share input exists and the manual path is gone", () => {
  assert.equal("parseLocalShare" in usageReport, false);
  const plain = report(history(steadyStream(), [event("e1", PLUS_TWO)]));
  const ignored = report(history(steadyStream(), [event("e1", PLUS_TWO)]), { localSharePercent: 0 });
  assert.deepEqual(ignored, plain, "a legacy share option has no effect");
  assert.equal("scenario" in plain, false);
  assert.equal(plain.attribution.method, "conditional-token-weight");
  const a = accountOf(windowOf(plain));
  close(a.attribution.conditional.points, 2, "the +2 interval with local evidence is estimated immediately");
  close(points(a)["s-1"], 2);
  close(unestimable(a)["no-local-evidence"], 4, "10→11 and 13→16 had no local events and are not invented as 0 or local");
  assertConserved(a);
});

test("primary and weekly windows are separate estimates and are never summed", () => {
  const primary = steadyStream();
  const weekly = steadyStream({ windowId: "codex:secondary", reset: NOW + 4 * 86_400_000 }).map((s) => ({ ...s, percent: s.percent / 2 }));
  const r = report(history([...primary, ...weekly], [event("e1", PLUS_TWO)]));
  const provider = r.providers.find((p) => p.provider === "codex");
  assert.equal(provider.windows.length, 2);
  assert.equal("measuredDelta" in provider, false);
  const p = accountOf(windowOf(r, "codex", "codex:primary"));
  const s = accountOf(windowOf(r, "codex", "codex:secondary"));
  close(p.measuredDelta, 6);
  close(s.measuredDelta, 3);
  close(p.attribution.conditional.points, 2);
  close(s.attribution.conditional.points, 1);
  assertConserved(p, "primary");
  assertConserved(s, "weekly");
});

test("concurrent sessions split an eligible delta by token weight; the tree is app → profile → session", () => {
  const events = [
    event("a", PLUS_TWO, { session: "s-a", input: 250, cached: 100, output: 50 }), // uncached weight 200
    event("b", PLUS_TWO + 1_000, { app: "Hermes", profile: "work", session: "s-b", input: 60, output: 10, cached: 20 }) // 50
  ];
  const a = accountOf(windowOf(report(history(steadyStream(), events))));
  close(points(a)["s-a"], 1.6);
  close(points(a)["s-b"], 0.4);
  const hermes = a.attribution.conditional.apps.find((app) => app.app === "Hermes");
  assert.deepEqual(hermes.profiles.map((profile) => profile.profile), ["work"]);
  close(hermes.points, 0.4);
  assert.equal(a.attribution.conditional.apps[0].app, "Codex CLI", "largest first");
  assert.equal(a.attribution.eligible.clusters, 1);
  assertConserved(a);
});

test("weight basis: uncached excludes cache reads, all includes them; reasoning is never added twice", () => {
  const e = { input: 1_000, cached: 800, output: 50 };
  assert.equal(eventWeight(e, "uncached"), 250);
  assert.equal(eventWeight(e, "all"), 1_050);
  assert.equal(eventWeight({ input: 10, cached: 50, output: 5 }, "uncached"), 5, "never negative");
  const events = [
    event("a", PLUS_TWO, { session: "s-a", input: 1_000, cached: 900, output: 0 }),
    event("b", PLUS_TWO, { session: "s-b", input: 100, cached: 0, output: 0 })
  ];
  const uncached = accountOf(windowOf(report(history(steadyStream(), events))));
  const all = accountOf(windowOf(report(history(steadyStream(), events), { weightBasis: "all" })));
  close(points(uncached)["s-a"], 1);
  close(points(all)["s-a"], 2 * 1_000 / 1_100);
  assert.equal(report(history([]), { weightBasis: "bogus" }).attribution.weightBasis, "uncached");
});

test("poll deltas count only when wholly inside a comparable chain; others make their intervals unestimable", () => {
  const t = (index) => NOW - 30 * MIN + index * MIN;
  const events = [
    event("inside", 0, { timing: "poll-delta", from: t(1), to: t(2), session: "h-inside", app: "Hermes", profile: "work" }),
    event("span", 0, { timing: "poll-delta", from: t(2) + 10_000, to: t(3) + 10_000, session: "h-span", app: "Hermes", profile: "work" }),
    event("edge", 0, { timing: "poll-delta", from: t(0) - 30_000, to: t(0) + 30_000, session: "h-edge", app: "Hermes", profile: "work" })
  ];
  const w = windowOf(report(history(steadyStream(), events)));
  const a = accountOf(w);
  assert.deepEqual(a.attribution.candidateSessions.map((s) => s.session).sort(), ["h-inside", "h-span"]);
  assert.equal(w.ambiguousPollDeltas.events, 1);
  assert.equal(w.ambiguousPollDeltas.tokens, 110);
  close(unestimable(a)["unplaceable-poll-delta"], 1, "the edge delta overlaps t0→t1");
  close(points(a)["h-inside"], 2, "11→13 alone");
  close(points(a)["h-span"], 3, "13→13 and 13→16 merged by the spanning delta");
  assertConserved(a);
});

test("poll deltas crossing an unknown interval never attach to measured change", () => {
  const stream = [sample(NOW - 20 * MIN, 10), sample(NOW - 19 * MIN, 12), sample(NOW - 10 * MIN, 14), sample(NOW - 9 * MIN, 15)];
  const events = [event("gap", 0, { timing: "poll-delta", from: NOW - 19 * MIN - 30_000, to: NOW - 15 * MIN, app: "Hermes" })];
  const a = accountOf(windowOf(report(history(stream, events))));
  assert.equal(a.attribution.candidateSessions.length, 0);
  close(unestimable(a)["unplaceable-poll-delta"], 2);
  close(unestimable(a)["no-local-evidence"], 1);
  close(a.attribution.conditional.points, 0);
  assertConserved(a);
});

test("a poll delta crossing the period start blocks the first measured interval instead of vanishing", () => {
  const stream = [sample(NOW - 60 * MIN, 10), sample(NOW - 59 * MIN, 12), sample(NOW - 58 * MIN, 13)];
  const events = [
    event("pre", 0, { timing: "poll-delta", from: NOW - 61 * MIN, to: NOW - 59 * MIN - 30_000, app: "Hermes", session: "h-pre" }),
    event("in", NOW - 58 * MIN - 1_000, { session: "cx" })
  ];
  const r = report(history(stream, events));
  const w = windowOf(r);
  const a = accountOf(w);
  close(unestimable(a)["unplaceable-poll-delta"], 2);
  assert.equal(w.ambiguousPollDeltas.events, 1);
  assert.equal(r.evidence.outsidePeriod.events, 1);
  close(a.attribution.conditional.points, 1, "only 12 → 13 is estimated");
  assertConserved(a);
});

test("after an account switch, local events are candidates only for the account observed at that time", () => {
  const stream = [
    sample(NOW - 10 * MIN, 10), sample(NOW - 9 * MIN, 12),
    sample(NOW - 8 * MIN, 40, { scope: "acct-b" }), sample(NOW - 7 * MIN, 45, { scope: "acct-b" })
  ];
  const events = [
    event("a", NOW - 9 * MIN - 1_000, { session: "during-a" }),
    event("switch", NOW - 8 * MIN - 1_000, { session: "during-switch" }),
    event("b", NOW - 7 * MIN - 1_000, { session: "during-b" })
  ];
  const w = windowOf(report(history(stream, events)));
  assert.deepEqual(accountOf(w, "acct-a").attribution.candidateSessions.map((s) => s.session), ["during-a"]);
  assert.deepEqual(accountOf(w, "acct-b").attribution.candidateSessions.map((s) => s.session), ["during-b"]);
  close(points(accountOf(w, "acct-a"))["during-a"], 2);
  close(points(accountOf(w, "acct-b"))["during-b"], 5);
  assert.equal(w.unmatchedEvidence.events, 1, "the event during the switch stays unmatched");
});

test("an interval right after local evidence absorbs provider accounting lag; later intervals do not", () => {
  assert.equal(ATTRIBUTION_LAG_MS, 60_000);
  const t1 = NOW - 29 * MIN;
  // Evidence exactly at t1 is owned by 10 → 11 only; 11 → 13 starts within the lag and is merged, 13 → 16 is not.
  const a = accountOf(windowOf(report(history(steadyStream(), [event("at-sample", t1, { session: "boundary" })]))));
  close(points(a).boundary, 3, "10→11 plus the lagging 11→13");
  assert.equal(a.attribution.conditional.sessions[0].events, 1, "the event is counted once");
  close(unestimable(a)["no-local-evidence"], 3);
  assertConserved(a);
});

test("no local logs: the whole measured change stays unestimable and external is 0..measured, never 0", () => {
  const a = accountOf(windowOf(report(history(steadyStream(), []))));
  close(a.attribution.conditional.points, 0);
  assert.deepEqual(a.attribution.conditional.sessions, []);
  close(unestimable(a)["no-local-evidence"], 6);
  assert.deepEqual(a.attribution.externalRange, { min: 0, max: 6 });
  assertConserved(a);
});

test("recent intervals wait for provider-specific log maturity, then become eligible automatically", () => {
  assert.equal(evidenceMaturityMs("codex"), 2 * MIN);
  assert.equal(evidenceMaturityMs("claude"), 7 * MIN, "Claude Code holds the newest message until the transcript idles 5 min");
  const claude = (at, percent) => sample(at, percent, { provider: "claude", windowId: "claude:five_hour" });
  const samples = [claude(NOW - 6 * MIN, 10), claude(NOW - 5 * MIN, 12), sample(NOW - 6 * MIN, 10), sample(NOW - 5 * MIN, 12)];
  const events = [
    event("c", NOW - 5 * MIN - 20_000, { provider: "claude", app: "Claude Code", session: "c-1" }),
    event("x", NOW - 5 * MIN - 20_000, { session: "x-1" })
  ];
  const early = report(history(samples, events));
  const c = accountOf(windowOf(early, "claude", "claude:five_hour"));
  close(unestimable(c)["pending-maturity"], 2, "claude log not yet mature");
  close(c.attribution.conditional.points, 0);
  assertConserved(c);
  close(accountOf(windowOf(early)).attribution.conditional.points, 2, "codex matures after 2 min");

  const later = buildUsageReport(history(samples, events, { collectedAt: NOW + 3 * MIN, health: [{ at: NOW - HOUR, complete: true }, { at: NOW + 3 * MIN, complete: true }] }), { now: NOW + 3 * MIN, period: "1h" });
  close(accountOf(windowOf(later, "claude", "claude:five_hour")).attribution.conditional.points, 2);
});

test("late events arriving after a report change only the split, never the conservation", () => {
  const before = accountOf(windowOf(report(history(steadyStream(), [event("a", PLUS_TWO, { session: "early" })]))));
  const lateEvents = [event("a", PLUS_TWO, { session: "early" }), event("late", NOW - 27 * MIN + 1_000, { session: "late", input: 300 })];
  const after = accountOf(windowOf(report(history(steadyStream(), lateEvents))));
  close(before.attribution.conditional.points, 2);
  close(after.attribution.conditional.points, 5, "13→16 gains evidence when its late event is collected");
  close(points(after).late, 3);
  assertConserved(before, "before");
  assertConserved(after, "after");
});

test("coverage text alone never authorizes conditional estimates", () => {
  const r = report(history(steadyStream(), [event("e1", PLUS_TWO)], {
    health: undefined,
    coverage: ["Hermes work: database is busy; not collected this time.", "Codex ~/.codex/sessions: 3 logs in window, 1 read (0.1 MiB)."]
  }));
  assert.equal(r.attribution.coverage.level, "limited");
  assert.equal(r.attribution.coverage.latestRunComplete, null);
  assert.equal(r.attribution.coverage.completeThrough, null);
  assert.deepEqual(r.attribution.coverage.sourceProblems, ["Hermes work: database is busy; not collected this time."]);
  close(accountOf(windowOf(r)).attribution.conditional.points, 0, "text cannot replace recorded health");
});

test("a reported log backlog or failed local collection makes estimates wait instead of guessing", () => {
  const backlog = report(history(steadyStream(), [event("e1", PLUS_TWO)], {
    health: [{ at: NOW - HOUR, complete: true }, { at: NOW - 10_000, complete: false }],
    coverage: ["Logs: read budget reached; 4 changed logs continue next collection."]
  }));
  assert.equal(backlog.attribution.coverage.backlog, true);
  const a = accountOf(windowOf(backlog));
  close(unestimable(a)["source-backlog"], 2);
  close(a.attribution.conditional.points, 0);
  assertConserved(a);

  const failed = accountOf(windowOf(report(history(steadyStream(), [event("e1", PLUS_TWO)], {
    health: [{ at: NOW - HOUR, complete: true }, { at: NOW - 10_000, complete: false }],
    error: "Local usage collection failed in the last run; its cursors were not advanced and the next run retries."
  }))));
  close(unestimable(failed)["collection-incomplete"], 2);

  const cleared = accountOf(windowOf(report(history(steadyStream(), [event("e1", PLUS_TWO)]))));
  close(cleared.attribution.conditional.points, 2, "the next complete run clears the backlog");
});

test("recorded per-run collection health is used when present", () => {
  const health = [
    { at: NOW - 31 * MIN, complete: false },
    { at: NOW - 20 * MIN, complete: true },
    { at: NOW - MIN, complete: false }
  ];
  const r = report(history([...steadyStream(), sample(NOW - 5 * MIN, 20), sample(NOW - 4 * MIN, 22)], [
    event("e1", PLUS_TWO), event("e2", NOW - 4 * MIN - 10_000, { session: "s-2" })
  ], { health }));
  assert.equal(r.attribution.coverage.level, "recorded");
  assert.equal(r.attribution.coverage.completeThrough, NOW - 20 * MIN);
  assert.equal(r.attribution.coverage.recordedSince, NOW - 31 * MIN);
  assert.equal(r.attribution.coverage.backlog, false, "an incomplete run is a backlog only when its coverage says so");
  const a = accountOf(windowOf(r));
  close(points(a)["s-1"], 2, "covered by the complete run at -20 min");
  close(unestimable(a)["collection-incomplete"], 2, "-5→-4 is after the last complete run and the latest run is incomplete");
  assertConserved(a);
  const backlog = report(history([...steadyStream(), sample(NOW - 5 * MIN, 20), sample(NOW - 4 * MIN, 22)], [
    event("e1", PLUS_TWO), event("e2", NOW - 4 * MIN - 10_000, { session: "s-2" })
  ], { health, coverage: ["Logs: read budget reached; 4 changed logs continue next collection."] }));
  assert.equal(backlog.attribution.coverage.backlog, true);
  close(unestimable(accountOf(windowOf(backlog)))["source-backlog"], 2);
  const parsed = parseUsageHistory(history([], [], { health: [...health, { at: "x" }, null] }));
  assert.equal(parsed.history.health.length, 3, "malformed health entries are dropped");
});

test("recorded health: a drained backlog is covered, unrecorded time and records lost before the covering run are not", () => {
  const run = (health) => {
    const a = accountOf(windowOf(report(history(steadyStream(), [event("e1", PLUS_TWO)], { health }))));
    assertConserved(a);
    return a;
  };
  // The cluster holding PLUS_TWO starts at -29 min and is mature (Codex) by -25 min.
  const drained = run([{ at: NOW - 31 * MIN, complete: true }, { at: NOW - 27 * MIN, complete: false }, { at: NOW - 20 * MIN, complete: true }]);
  close(points(drained)["s-1"], 2, "a backlog drained by a later complete run is not a permanent block");

  const unrecorded = run([{ at: NOW - 20 * MIN, complete: true }]);
  close(unestimable(unrecorded)["coverage-unrecorded"], 2, "a later complete run does not vouch for time before recording began");
  close(unrecorded.attribution.conditional.points, 0);
  const none = run([]);
  close(unestimable(none)["coverage-unrecorded"], 2, "a recording collector before its first run covers nothing (never the legacy fallback)");

  const lost = run([{ at: NOW - 31 * MIN, complete: true }, { at: NOW - 27 * MIN, complete: false, lost: true }, { at: NOW - 20 * MIN, complete: true }]);
  close(unestimable(lost)["records-lost"], 2, "records lost while the cluster was being read are not recovered by a later run");
  const lostPending = run([{ at: NOW - 31 * MIN, complete: true }, { at: NOW - 27 * MIN, complete: false, lost: true }]);
  close(unestimable(lostPending)["records-lost"], 2, "a loss is reported at once instead of waiting for a complete run");

  const lostBefore = run([{ at: NOW - 35 * MIN, complete: false, lost: true }, { at: NOW - 31 * MIN, complete: true }, { at: NOW - 20 * MIN, complete: true }]);
  close(points(lostBefore)["s-1"], 2, "a loss before the cluster started cannot hold its records");
  const lostAfter = run([{ at: NOW - 31 * MIN, complete: true }, { at: NOW - 20 * MIN, complete: true }, { at: NOW - 10 * MIN, complete: false, lost: true }, { at: NOW - MIN, complete: true }]);
  close(points(lostAfter)["s-1"], 2, "a loss after the covering complete run cannot hold its records");

  const parsed = parseUsageHistory(history([], [], { health: [{ at: 1, complete: false, lost: true }, { at: 2, complete: true, lost: "x" }, { at: 3, complete: true, lost: false }] }));
  assert.deepEqual(parsed.history.health, [
    { at: 1, complete: false, lost: true },
    { at: 2, complete: false, lost: true },
    { at: 3, complete: true }
  ], "a malformed loss marker stays a loss");
});

test("a token record excluded for a conflicting id leaves its cluster unestimated with recorded coverage", () => {
  const clash = [event("dup", PLUS_TWO), event("dup", PLUS_TWO, { session: "s-other" }), event("e2", NOW - 26 * MIN - 10_000, { session: "s-2" })];
  for (const patch of [{}, { health: [{ at: NOW - 40 * MIN, complete: true }, { at: NOW - MIN, complete: true }] }]) {
    const r = report(history(steadyStream(), clash, patch));
    const a = accountOf(windowOf(r));
    assert.equal(r.issues.conflictingEvents, 2);
    close(unestimable(a)["evidence-conflict"], 2, `${JSON.stringify(Object.keys(patch))}: incomplete evidence is not split`);
    close(points(a)["s-2"], 3, "other clusters are unaffected");
    assertConserved(a);
  }
});

test("the first minutes after collection start are a baseline warm-up and are not estimated", () => {
  const r = report(history(steadyStream(), [event("e1", PLUS_TWO), event("e2", NOW - 26 * MIN - 10_000, { session: "s-2" })], {
    startedAt: NOW - 30 * MIN - 30_000
  }));
  const a = accountOf(windowOf(r));
  close(unestimable(a)["baseline-warmup"], 2, "11→13 starts within two minutes of the first collection");
  close(points(a)["s-2"], 3);
  assertConserved(a);
});

test("an app restart leaves a collection gap; the downtime poll delta is unplaceable and later intervals are estimated", () => {
  const stream = [
    sample(NOW - 40 * MIN, 10), sample(NOW - 39 * MIN, 12),
    // app closed from -39 to -20 min
    sample(NOW - 20 * MIN, 30), sample(NOW - 19 * MIN, 31), sample(NOW - 18 * MIN, 33)
  ];
  const events = [
    event("downtime", 0, { timing: "poll-delta", from: NOW - 39 * MIN, to: NOW - 19 * MIN - 30_000, app: "Hermes", profile: "p", session: "h" }),
    event("after", NOW - 18 * MIN - 10_000, { session: "after" })
  ];
  const w = windowOf(report(history(stream, events)));
  const a = accountOf(w);
  assert.ok(w.unknownIntervals.some((item) => item.reason === "collection-gap"));
  close(a.measuredDelta, 5);
  close(unestimable(a)["no-local-evidence"], 2, "-40→-39 had no evidence");
  close(unestimable(a)["unplaceable-poll-delta"], 1, "the downtime delta ends inside -20→-19");
  close(points(a).after, 2);
  assertConserved(a);
});

test("unknown-provider local activity overlapping an estimate is disclosed, not silently dropped", () => {
  const events = [
    event("c", PLUS_TWO, { provider: "claude", app: "Claude Code", session: "c-1" }),
    event("u", PLUS_TWO, { provider: "unknown", app: "Hermes", profile: "default", session: "h-1" })
  ];
  const stream = steadyStream({ provider: "claude", windowId: "claude:five_hour" });
  const a = accountOf(windowOf(report(history(stream, events)), "claude", "claude:five_hour"));
  close(a.attribution.conditional.points, 2);
  assert.deepEqual(a.attribution.unknownProviderOverlap, { events: 1, tokens: 110 });
});

test("thirty days of minute samples and dense events stay responsive and conserve every window", () => {
  const samples = [];
  for (let at = NOW - 30 * 86_400_000; at <= NOW; at += MIN) {
    const windowStart = Math.floor(at / (5 * HOUR)) * 5 * HOUR;
    samples.push(sample(at, ((at - windowStart) / (5 * HOUR)) * 80, { reset: windowStart + 5 * HOUR }));
  }
  const events = [];
  for (let index = 0; index < 60_000; index += 1) {
    const at = NOW - index * 43_000;
    events.push(index % 4
      ? event(`e${index}`, at, { session: `s-${index % 37}` })
      : event(`p${index}`, 0, { timing: "poll-delta", from: at - 60_000, to: at, app: "Hermes", profile: "p", session: `h-${index % 11}` }));
  }
  const started = performance.now();
  const r = report(history(samples, events), { period: "30d" });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `report took ${elapsed}ms`);
  const a = accountOf(windowOf(r));
  assert.ok(a.measuredDelta > 0);
  assert.ok(a.attribution.conditional.points > 0);
  assertConserved(a);
});

test("events are matched only to the same provider; unknown providers stay unmatched evidence", () => {
  const events = [
    event("claude", NOW - 28 * MIN + 1_000, { provider: "claude", app: "Claude Code", session: "c-1" }),
    event("hermes-unknown", 0, { provider: "unknown", app: "Hermes", profile: "default", session: "h-1", timing: "poll-delta", from: NOW - 20 * MIN, to: NOW - 19 * MIN })
  ];
  const r = report(history(steadyStream(), events));
  const a = accountOf(windowOf(r));
  assert.equal(a.attribution.candidateSessions.length, 0);
  close(a.attribution.conditional.points, 0);
  close(unestimable(a)["no-local-evidence"], 6);
  const claude = r.providers.find((p) => p.provider === "claude");
  assert.equal(claude.quotaStatus, "no-samples");
  assert.equal(claude.windows.length, 0);
  const unknown = r.providers.find((p) => p.provider === "unknown");
  assert.equal(unknown.quotaStatus, "provider-unknown");
  assert.equal(r.evidence.total.events, 2);
});

test("identical duplicate samples collapse; conflicting observations poison their neighbours", () => {
  const a = sample(NOW - 10 * MIN, 10);
  const samples = [a, { ...a }, sample(NOW - 9 * MIN, 12), sample(NOW - 8 * MIN, 13), sample(NOW - 8 * MIN, 30), sample(NOW - 7 * MIN, 31)];
  const r = report(history(samples));
  const w = windowOf(r);
  close(accountOf(w).measuredDelta, 2, "only 10→12");
  assert.equal(r.issues.duplicateSamples, 1);
  assert.equal(r.issues.conflictingSamples, 2);
  const reasons = Object.fromEntries(w.unknownIntervals.map((item) => [item.reason, item.count]));
  assert.equal(reasons["conflicting-observations"], 2);
});

test("malformed samples and events are excluded and counted, never guessed", () => {
  const samples = [
    ...steadyStream(), null, "x", { ...sample(NOW - 2 * MIN, 1), at: Number.NaN }, { ...sample(NOW - 2 * MIN, 1), provider: "" },
    sample(NOW - 25 * MIN, Number.NaN)
  ];
  const events = [
    event("ok", NOW - 28 * MIN), null, event("neg", NOW - 28 * MIN, { input: -5 }), event("frac", NOW - 28 * MIN, { output: 1.5 }),
    event("rev", NOW - 28 * MIN, { from: NOW, to: NOW - HOUR }), event("timing", NOW - 28 * MIN, { timing: "guess" }),
    event("", NOW - 28 * MIN)
  ];
  const r = report(history(samples, events));
  assert.equal(r.issues.invalidSamples, 4);
  assert.equal(r.issues.invalidEvents, 6);
  assert.equal(r.evidence.total.events, 1);
  const w = windowOf(r);
  assert.ok(w.unknownIntervals.some((item) => item.reason === "invalid-percentage"));
});

test("event ids are deduplicated; streaming updates keep one record and conflicting identities are dropped", () => {
  const events = [
    event("dup", NOW - 28 * MIN), event("dup", NOW - 28 * MIN),
    event("stream", NOW - 27 * MIN, { output: 5 }), event("stream", NOW - 27 * MIN + 1_000, { output: 40 }),
    event("clash", NOW - 26 * MIN, { session: "s-1" }), event("clash", NOW - 26 * MIN, { session: "s-2" })
  ];
  const r = report(history(steadyStream(), events));
  assert.equal(r.issues.duplicateEvents, 1);
  assert.equal(r.issues.mergedEventUpdates, 1);
  assert.equal(r.issues.conflictingEvents, 2);
  assert.equal(r.evidence.total.events, 2);
  assert.equal(r.evidence.total.output, 10 + 40, "streaming updates are not summed");
  const sessions = r.evidence.providers[0].apps[0].profiles[0].sessions;
  assert.deepEqual(sessions.map((s) => s.session), ["s-1"]);
});

test("evidence tree is application → profile → session and carries no conversation content", () => {
  const events = [
    event("h1", 0, { app: "Hermes", profile: "work", session: "h-a", timing: "poll-delta", from: NOW - 50 * MIN, to: NOW - 49 * MIN, title: "PRIVATE TITLE", content: "PRIVATE BODY" }),
    event("h2", 0, { app: "Hermes", profile: "work", session: "h-b", timing: "poll-delta", from: NOW - 49 * MIN, to: NOW - 48 * MIN, input: 400 }),
    event("h3", 0, { app: "Hermes", profile: "default", session: "h-c", timing: "poll-delta", from: NOW - 48 * MIN, to: NOW - 47 * MIN }),
    event("x1", NOW - 10 * MIN, { app: "Codex CLI", session: "cx" }),
    event("c1", NOW - 10 * MIN, { provider: "claude", app: "Claude Code", session: "cc" }),
    event("old", NOW - 2 * HOUR, { session: "too-old" }),
    event("straddle", 0, { app: "Hermes", profile: "work", session: "h-edge", timing: "poll-delta", from: NOW - HOUR - MIN, to: NOW - HOUR + MIN })
  ];
  const r = report(history([], events));
  const text = JSON.stringify(r);
  assert.equal(text.includes("PRIVATE"), false);
  assert.equal(text.includes("too-old"), false);
  const codex = r.evidence.providers.find((p) => p.provider === "codex");
  const hermes = codex.apps.find((a) => a.app === "Hermes");
  assert.deepEqual(hermes.profiles.map((p) => p.profile), ["work", "default"]);
  assert.deepEqual(hermes.profiles[0].sessions.map((s) => s.session), ["h-b", "h-a"]);
  assert.equal(hermes.totals.events, 3);
  assert.ok(codex.apps.some((a) => a.app === "Codex CLI"));
  assert.ok(r.evidence.providers.some((p) => p.provider === "claude" && p.apps[0].app === "Claude Code"));
  assert.equal(r.evidence.outsidePeriod.events, 1);
  assert.equal(r.evidence.outsidePeriod.input, 100);
});

test("staleness, provider status and collection errors are reported as-is", () => {
  const samples = [sample(NOW - 30 * MIN, 10), sample(NOW - 29 * MIN, 12, { reset: NOW - 20 * MIN })];
  const h = history(samples, [], {
    collectedAt: NOW - HISTORY_STALE_AFTER_MS - 1,
    providerStatus: ["codex: stale (rate-limited)", 7], coverage: ["Hermes default: 3 rows", null], error: "sqlite busy"
  });
  const r = report(h);
  assert.equal(r.collection.stale, true);
  assert.equal(r.collection.error, "sqlite busy");
  assert.deepEqual(r.collection.providerStatus, ["codex: stale (rate-limited)"]);
  assert.deepEqual(r.collection.coverage, ["Hermes default: 3 rows"]);
  const w = windowOf(r);
  assert.equal(w.staleness.stale, true);
  assert.equal(w.staleness.ageMs, 29 * MIN);
  assert.equal(w.staleness.resetPassed, true);
  const fresh = report(history(steadyStream().map((s) => ({ ...s, at: s.at + 26 * MIN }))));
  assert.equal(fresh.collection.stale, false);
  assert.equal(windowOf(fresh).staleness.stale, false);
});

test("unknown window identifiers and time before collection started stay explicit", () => {
  const samples = [sample(NOW - 5 * MIN, 1, { windowId: "mystery", reset: null }), sample(NOW - 4 * MIN, 2, { windowId: "mystery", reset: null })];
  const r = report(history(samples, [], { startedAt: NOW - 20 * MIN }));
  const w = windowOf(r, "codex", "mystery");
  assert.equal(accountOf(w).measuredDelta, 0);
  assert.equal(w.coverage["reset-unknown"], MIN);
  assert.equal(w.coverage["before-collection"], 40 * MIN);
  assert.equal(w.coverage["no-observations"], 15 * MIN + 4 * MIN);
});

test("history envelopes are validated before use and inputs are never mutated", () => {
  assert.equal(parseUsageHistory(null).ok, false);
  assert.equal(parseUsageHistory({ version: 2, samples: [], events: [] }).ok, false);
  assert.equal(parseUsageHistory({ version: 1, samples: {}, events: [] }).ok, false);
  const valid = history(steadyStream(), [event("e", NOW - 28 * MIN)]);
  const parsed = parseUsageHistory(valid);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.history.health, valid.health, "per-run health survives parsing");
  const snapshot = structuredClone(valid);
  report(valid);
  assert.deepEqual(valid, snapshot);
});

test("fully missing history yields explicit no-observation coverage and no numbers", () => {
  const r = report(history([], []), { period: "24h" });
  assert.equal(r.providers.length, 0);
  assert.equal(r.evidence.total.events, 0);
  assert.equal(r.attribution.method, "conditional-token-weight");
});
