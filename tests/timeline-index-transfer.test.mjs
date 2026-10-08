import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTimelineService } from "../src/main/services/SessionTimelineService.ts";

test("a segment whose oversized line could not be indexed stays searchable after the worker hands its index over", async t => {
  const root = await mkdtemp(join(tmpdir(), "ctty-timeline-transfer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "session-timeline");
  await mkdir(directory);
  const rows = [
    { id: "small", sessionId: "other", at: 1, type: "status", summary: "ordinary" },
    // Longer than the index scanner's line limit: the bloom filter never sees its words.
    { id: "big", sessionId: "agent", at: 2, type: "command", summary: "needle-in-oversized-row", detail: "y".repeat(70_000) }
  ];
  await writeFile(join(directory, "0000000000000001-import.ndjson"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const timeline = new SessionTimelineService(root, value => value);
  await timeline.load();
  const page = await timeline.page("agent", undefined, 10, { query: "needle-in-oversized", types: ["command"], sessionIds: ["agent"] });
  assert.deepEqual(page.items.map(event => event.id), ["big"]);
});

test("startup continues with a degraded, empty timeline when neither scanner can read the journal", async t => {
  const root = await mkdtemp(join(tmpdir(), "ctty-timeline-degraded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "session-timeline");
  // A directory with a journal's name makes every read of it fail.
  await mkdir(join(directory, "0000000000000001-broken.ndjson"), { recursive: true });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => { console.warn = warn; });
  const timeline = new SessionTimelineService(root, value => value);
  await timeline.load();
  assert.ok(warnings.some(line => /timeline/iu.test(line) && /degraded|unavailable/iu.test(line)), warnings.join("\n"));
  assert.equal(timeline.usage(["agent"]).tokens.total, null);
  await timeline.append("agent", "status", "still recording after a failed scan");
  await rm(join(directory, "0000000000000001-broken.ndjson"), { recursive: true });
  const page = await timeline.page("agent", undefined, 10);
  assert.deepEqual(page.items.map(event => event.summary), ["still recording after a failed scan"]);
});
