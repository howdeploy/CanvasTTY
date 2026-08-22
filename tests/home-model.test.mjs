import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLimitDuration,
  formatResetCountdown,
  selectHomeModel
} from "../src/renderer/src/features/home/homeModel.ts";

function limitWindow({
  id,
  minutes,
  percent,
  isDefaultBucket = true
}) {
  const [bucketId, slot = "primary"] = id.split(":");
  return {
    id,
    bucketId,
    slot,
    isDefaultBucket,
    label: null,
    usedPercent: percent,
    used: null,
    limit: null,
    windowMinutes: minutes,
    resetsAt: 1_786_160_179_000
  };
}

function snapshot(windows) {
  return {
    fetchedAt: 1_786_100_000_000,
    providers: [
      { provider: "codex", state: "available", source: "codex-app-server", fetchedAt: 1_786_100_000_000, windows },
      { provider: "claude", state: "unavailable", source: "claude-usage-api", checkedAt: 1_786_100_000_000, reason: "subscription-required" },
      { provider: "kimi", state: "unavailable", source: "kimi-usage-api", checkedAt: 1_786_100_000_000, reason: "not-authenticated" }
    ]
  };
}

function session(id, status, startedAt) {
  return {
    id,
    provider: "terminal",
    profile: "normal",
    title: id,
    cwd: "/tmp",
    position: { x: 0, y: 0 },
    size: { width: 700, height: 430 },
    status,
    startedAt,
    exitCode: status === "done" ? 0 : status === "failed" ? 1 : null,
    failureDetails: null,
    buffer: ""
  };
}

test("prefers the weekly quota window and keeps its matching usage", () => {
  const model = selectHomeModel([], snapshot([
    { ...limitWindow({ id: "codex:secondary", minutes: 10_080, percent: 12 }), resetsAt: 1_786_200_000_000 },
    { ...limitWindow({ id: "codex:primary", minutes: 300, percent: 39 }), resetsAt: 1_786_120_000_000 }
  ]), "ready", 1_786_100_000_000);

  assert.deepEqual(model.limitRows[0].window, {
    id: "codex:secondary",
    windowMinutes: 10_080,
    usedPercent: 12,
    resetsAt: 1_786_200_000_000
  });
});

test("never invents a missing reset window or mixes an additional bucket", () => {
  const model = selectHomeModel([], snapshot([
    limitWindow({ id: "codex:primary", minutes: 10_080, percent: 44 }),
    limitWindow({ id: "codex_spark:primary", minutes: 10_080, percent: 0, isDefaultBucket: false })
  ]), "ready", 1_786_100_000_000);

  assert.equal(model.limitRows[0].window.id, "codex:primary");
  assert.equal(model.limitRows[0].window.windowMinutes, 10_080);
});

test("keeps every session row in newest-first order for the scrollable viewport", () => {
  const model = selectHomeModel([
    session("old", "working", 1),
    session("failed", "failed", 2),
    session("approval", "needs_approval", 3),
    session("done", "done", 4)
  ], null, "loading");

  assert.deepEqual(model.sessionRows.map(({ id, status }) => ({ id, status })), [
    { id: "done", status: "done" },
    { id: "approval", status: "needs_approval" },
    { id: "failed", status: "failed" },
    { id: "old", status: "working" }
  ]);
});

test("shows only the independently selected HOME limit providers", () => {
  const currentSnapshot = snapshot([
    limitWindow({ id: "codex:primary", minutes: 300, percent: 39 })
  ]);
  assert.deepEqual(
    selectHomeModel([], currentSnapshot, "ready", 1_786_100_000_000, ["grok", "kimi", "opencode", "codex"])
      .limitRows.map((row) => row.provider),
    ["codex", "kimi", "opencode", "grok"]
  );
  assert.deepEqual(
    selectHomeModel([], currentSnapshot, "ready", 1_786_100_000_000, []).limitRows,
    []
  );
});

test("formats window metadata and the visible reset countdown separately", () => {
  assert.equal(formatLimitDuration(300, "ru"), "5 ч");
  assert.equal(formatLimitDuration(10_080, "ru"), "7 д");
  const now = 1_786_100_000_000;
  assert.equal(formatResetCountdown(now + (1 * 60 + 42) * 60_000, now, "ru"), "01:42");
  assert.equal(formatResetCountdown(now + (3 * 24 + 8) * 60 * 60_000, now, "ru"), "3д 08ч");
});
