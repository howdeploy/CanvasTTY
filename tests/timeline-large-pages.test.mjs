import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTimelineService } from "../src/main/services/SessionTimelineService.ts";

async function loadSmallImportedTimeline(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-timeline-growing-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "session-timeline");
  await mkdir(directory);
  const name = "0000000000000001-growing-import.ndjson";
  const rows = Array.from({ length: 3 }, (_, index) => JSON.stringify({
    id: `initial-${index}`, sessionId: "agent", at: index, type: "command", summary: `initial ${index}`
  }));
  await writeFile(join(directory, name), `${rows.join("\n")}\n`);
  const timeline = new SessionTimelineService(root, value => value);
  await timeline.load();
  return { root, name, timeline };
}

async function growImportedSegment(root, name) {
  const rows = Array.from({ length: 26_000 }, (_, index) => JSON.stringify({
    id: `grown-${index}`, sessionId: "agent", at: 100 + index, type: "command", summary: `grown ${index}`
  }));
  await appendFile(join(root, "session-timeline", name), `${rows.join("\n")}\n`);
  assert.ok((await stat(join(root, "session-timeline", name))).size > 2 * 1024 * 1024);
}

function rejectWholeSegmentRead(timeline, name) {
  const read = timeline.read.bind(timeline);
  timeline.read = async segment => {
    if (segment === name) assert.fail(`grown large segment must stream: ${segment}`);
    return read(segment);
  };
}

test("a loaded small journal that grows before its first page is classified by fresh size", async t => {
  const { root, name, timeline } = await loadSmallImportedTimeline(t);
  await growImportedSegment(root, name);
  rejectWholeSegmentRead(timeline, name);

  const page = await timeline.page("agent", undefined, 3, { types: ["command"], sessionIds: ["agent"] });
  assert.deepEqual(page.items.map(event => event.id), ["grown-25999", "grown-25998", "grown-25997"]);
});

test("a newly appended journal is checked for growth before its first page", async t => {
  const { root, timeline } = await loadSmallImportedTimeline(t);
  await timeline.append("agent", "command", "initial local append");
  const name = (await readdir(join(root, "session-timeline"))).sort().at(-1);
  await growImportedSegment(root, name);
  rejectWholeSegmentRead(timeline, name);
  const page = await timeline.page("agent", undefined, 3);
  assert.deepEqual(page.items.map(event => event.id), ["grown-25999", "grown-25998", "grown-25997"]);
});

test("journal growth invalidates stale session, type, and query indexes before filtering", async t => {
  const { root, name, timeline } = await loadSmallImportedTimeline(t);
  const rows = Array.from({ length: 26_000 }, (_, index) => JSON.stringify({
    id: `newly-indexed-${index}`, sessionId: "new-agent", at: 100 + index, type: "new-type", summary: `fresh-query marker ${index}`
  }));
  await appendFile(join(root, "session-timeline", name), `${rows.join("\n")}\n`);
  assert.ok((await stat(join(root, "session-timeline", name))).size > 2 * 1024 * 1024);
  rejectWholeSegmentRead(timeline, name);

  const page = await timeline.page("ignored", undefined, 3, {
    query: "fresh-query", types: ["new-type"], sessionIds: ["new-agent"]
  });
  assert.deepEqual(page.items.map(event => event.id), ["newly-indexed-25999", "newly-indexed-25998", "newly-indexed-25997"]);
});

test("a small cached page is bypassed after its journal grows past the segment limit", async t => {
  const { root, name, timeline } = await loadSmallImportedTimeline(t);
  const beforeGrowth = await timeline.page("agent", undefined, 2, { types: ["command"], sessionIds: ["agent"] });
  assert.deepEqual(beforeGrowth.items.map(event => event.id), ["initial-2", "initial-1"]);

  await growImportedSegment(root, name);
  rejectWholeSegmentRead(timeline, name);
  const afterGrowth = await timeline.page("agent", undefined, 3, { types: ["command"], sessionIds: ["agent"] });
  assert.deepEqual(afterGrowth.items.map(event => event.id), ["grown-25999", "grown-25998", "grown-25997"]);
});

test("large imported timeline pages stream valid rows and preserve cursor semantics", async t => {
  const root = await mkdtemp(join(tmpdir(), "canvastty-timeline-large-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "session-timeline");
  await mkdir(directory);

  const name = "0000000000000001-large-import.ndjson";
  const validRows = [];
  const lines = [];
  for (let index = 0; index < 26_000; index++) {
    const isLegacyCursor = index === 24_000 || index === 24_012;
    const oversized = index === 12_000;
    const event = {
      id: isLegacyCursor ? "duplicate-legacy-cursor" : oversized ? "oversized-page-event" : `event-${index}`,
      sessionId: index % 17 === 0 ? "foreign" : "agent",
      at: index,
      type: isLegacyCursor ? "cursor" : index % 2 === 0 ? "command" : "status",
      summary: isLegacyCursor ? "legacy cursor excluded by filter" : oversized ? "oversized-marker" : `page-search ${index}`,
      ...(oversized ? { detail: `oversized-marker ${"x".repeat(80_000)}` } : {})
    };
    validRows.push(event);
    lines.push(JSON.stringify(event));
    if (index === 251) lines.push("{malformed imported line}");
  }
  await writeFile(join(directory, name), `${lines.join("\n")}\n`);
  assert.ok((await stat(join(directory, name))).size > 2 * 1024 * 1024, "fixture exercises a segment larger than the normal cache limit");
  const olderName = "0000000000000000-older-import.ndjson";
  await writeFile(join(directory, olderName), [
    JSON.stringify({ id: "older-before-cursor", sessionId: "agent", at: -2, type: "command", summary: "page-search older" }),
    JSON.stringify({ id: "older-cross-cursor", sessionId: "agent", at: -1, type: "cursor", summary: "legacy cursor excluded by filter" }),
    JSON.stringify({ id: "older-after-cursor", sessionId: "agent", at: 0, type: "command", summary: "page-search newer" })
  ].join("\n") + "\n");

  const timeline = new SessionTimelineService(root, value => value);
  await timeline.load();
  const originalRead = timeline.read.bind(timeline);
  let wholeSegmentReads = 0;
  timeline.read = async segment => {
    if (segment === name) {
      wholeSegmentReads++;
      assert.fail(`large page must stream ${segment}`);
    }
    return originalRead(segment);
  };

  const filter = { query: "page-search", types: ["command"], sessionIds: ["agent"] };
  const matchesFilter = event => event.sessionId === "agent" && event.type === "command" && event.summary.includes("page-search");
  const expected = validRows.filter(matchesFilter).reverse();
  const first = await timeline.page("agent", undefined, 7, filter);
  assert.deepEqual(first.items.map(event => event.id), expected.slice(0, 7).map(event => event.id));
  assert.equal(first.nextCursor, `v1:${name}:${validRows.indexOf(expected[6])}`, "cursor ordinals count valid events, not malformed lines");
  const second = await timeline.page("agent", first.nextCursor, 7, filter);
  assert.deepEqual(second.items.map(event => event.id), expected.slice(7, 14).map(event => event.id));
  assert.equal(second.nextCursor, `v1:${name}:${validRows.indexOf(expected[13])}`);

  const latestLegacyIndex = validRows.map(event => event.id).lastIndexOf("duplicate-legacy-cursor");
  const legacyExpected = validRows.slice(0, latestLegacyIndex).filter(matchesFilter).reverse();
  const legacy = await timeline.page("agent", "duplicate-legacy-cursor", 5, {
    query: "page-search", types: ["command"], sessionIds: ["agent"]
  });
  assert.deepEqual(legacy.items.map(event => event.id), legacyExpected.slice(0, 5).map(event => event.id),
    "legacy IDs resolve to the latest occurrence, even when that event is excluded by the filter");
  assert.equal(legacy.nextCursor, `v1:${name}:${validRows.indexOf(legacyExpected[4])}`);
  const crossSegmentLegacy = await timeline.page("agent", "older-cross-cursor", 5, {
    query: "page-search", types: ["command"], sessionIds: ["agent"]
  });
  assert.deepEqual(crossSegmentLegacy.items.map(event => event.id), ["older-before-cursor"],
    "a newer segment without the legacy cursor contributes no candidates before an older segment finds it");
  assert.equal(crossSegmentLegacy.nextCursor, null);

  const oversized = await timeline.page("agent", undefined, 5, {
    query: "oversized-marker", types: ["command"], sessionIds: ["agent"]
  });
  assert.deepEqual(oversized.items.map(event => event.id), ["oversized-page-event"]);
  assert.ok(oversized.items[0].detail.length > 80_000 && oversized.items[0].detail.startsWith("oversized-marker "),
    "valid oversized imported records remain available to pages");
  assert.equal(oversized.nextCursor, null);

  await assert.rejects(timeline.page("agent", `v1:${name}:${validRows.length}`, 5), /Invalid timeline cursor/u);
  const zero = await timeline.page("agent", `v1:${name}:0`, 5);
  assert.deepEqual(zero.items.map(event => event.id), ["older-after-cursor", "older-cross-cursor", "older-before-cursor"],
    "index zero skips its segment without rejecting and continues into older segments");
  assert.equal(zero.nextCursor, null);
  assert.equal(wholeSegmentReads, 0, "large page requests never materialize a segment with readFile/split");
  timeline.read = originalRead;
});
