import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionTimelineService } from "../src/main/services/SessionTimelineService.ts";
import { forEachTimelineEvent } from "../src/main/services/TimelineJournalReader.ts";

test("large journal breakdown and report stream records, preserve ordering, and yield during the scan", async t => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-timeline-responsive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "session-timeline");
  await mkdir(directory);

  const lines = [];
  for (let index = 0; index < 10_005; index++) {
    lines.push(JSON.stringify({
      id: "ordered-" + index,
      sessionId: "report-agent",
      at: 1_800_000_000_000 + index,
      type: "tool",
      summary: "ordered-event-" + index,
      detail: index === 8 ? "oversized-marker " + "x".repeat(80_000) : "detail-" + index
    }));
  }
  lines.splice(500, 0, "{malformed journal record}");
  lines.push(JSON.stringify({
    id: "usage-first", sessionId: "report-agent", at: 1_800_000_020_000, type: "usage", summary: "usage",
    detail: JSON.stringify({ input: 10, output: 5, total: 15, cost: 0.25, source: "codex", cumulative: true,
      counterId: "thread-1", provider: "codex", model: "model-a" })
  }));
  lines.push(JSON.stringify({
    id: "usage-latest", sessionId: "report-agent", at: 1_800_000_020_001, type: "usage", summary: "usage",
    detail: JSON.stringify({ input: 20, output: 4, total: 24, cost: 0.75, source: "codex", cumulative: true,
      counterId: "thread-1", provider: "codex", model: "model-a" })
  }));
  const journal = join(directory, "0000000000000001-fixture.ndjson");
  await writeFile(journal, lines.join("\n")); // Imported journals may end without a newline.

  const timeline = new SessionTimelineService(root, value => value);
  await timeline.load();
  const breakdown = await timeline.breakdown("all", "report-agent");
  assert.equal(breakdown.length, 1);
  assert.deepEqual(breakdown[0].tokens, { input: 20, output: 4, total: 24 });
  assert.equal(breakdown[0].costUsd, 0.75);
  assert.equal(breakdown[0].costSource, "reported");

  const report = await timeline.report("report-agent");
  assert.match(report, /Report limited to the latest 10,000 events\./u);
  assert.doesNotMatch(report, /ordered-event-6\b/u, "the report retains the latest 10,000 session events");
  assert.match(report, /ordered-event-7\b/u);
  assert.match(report, /ordered-event-10004\b/u);
  assert.match(report, /oversized-marker/u, "valid oversized records remain available to reports");
  assert.ok(report.indexOf("ordered-event-7") < report.indexOf("ordered-event-10004"), "report rows remain chronological");

  let visited = 0;
  let timerObservedAt = null;
  const yields = await forEachTimelineEvent(journal, () => {
    visited++;
    if (visited === 1) setTimeout(() => { timerObservedAt = visited; }, 0);
  });
  assert.ok(yields >= 5, "expected bounded event-loop yields while scanning, saw " + yields);
  assert.ok(timerObservedAt !== null, "a scheduled timer ran while journal records were still being scanned");
  assert.ok(timerObservedAt > 0 && timerObservedAt < visited, "the timer ran before the scan completed");
  assert.equal(visited, 10_007, "malformed journal lines remain ignored");
});

test("scoped usage reads only selected indexes and preserves order across reload and append", async t => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-timeline-scoped-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timeline = new SessionTimelineService(root, value => value);
  await timeline.load();
  await timeline.recordUsage("alpha", 1, 1, "alpha-first", 1);
  await timeline.recordUsage("beta", 1, 1, "beta", 1);
  await timeline.recordUsage("alpha", 1, 1, "alpha-last", 1e16);

  const usageMap = timeline.usageBySession;
  const iterate = usageMap[Symbol.iterator].bind(usageMap);
  let wholeMapIterations = 0;
  usageMap[Symbol.iterator] = function* () {
    wholeMapIterations++;
    yield* iterate();
  };
  const first = timeline.usage(["beta", "alpha"]);
  const reversed = timeline.usage(["alpha", "beta"]);
  assert.deepEqual(first, reversed);
  assert.equal(first.source, "alpha-first, beta, alpha-last");
  assert.equal(first.cost, 10_000_000_000_000_002);
  assert.deepEqual(timeline.usage(["alpha", "beta", "alpha"]), reversed,
    "duplicate or reversed scopes do not reorder or double-count counters");
  assert.equal(timeline.usageCounters("alpha").length, 2);

  assert.equal(wholeMapIterations, 0, "scoped aggregation should use per-session keys instead of scanning all counters");

  const restored = new SessionTimelineService(root, value => value);
  await restored.load();
  assert.deepEqual(restored.usage(["beta", "alpha"]), first,
    "load rebuilds the per-session key index in journal order");
  await restored.recordUsage("beta", 2, 1, "beta-next", 0.5);
  assert.deepEqual(restored.usageCounters("beta").map(row => row.legacyId), ["beta", "beta"]);
  assert.equal(restored.usage(["beta"]).source, "beta, beta-next",
    "appends update the reloaded per-session index");
});
