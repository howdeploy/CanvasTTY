import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageHistoryService } from "../src/main/services/UsageHistoryService.ts";
import { exportMacUsageHistory } from "../scripts/export-mac-usage-history.mjs";
import { encodeMacHistorySnapshot, decodeMacHistorySnapshot } from "../src/main/services/macHistorySnapshot.ts";

test("large Mac snapshots round-trip UTF-8 exactly, including expired or changed events", async () => {
  const events = Array.from({ length: 12_000 }, (_, id) => ({ id, text: "Синтетические данные 🙂".repeat(4) }));
  for (const list of [events, [...events.slice(1), { id: 12_000, text: "new" }]]) {
    const original = JSON.stringify({ events: list, collector: { offset: 12_000 } });
    const encoded = await encodeMacHistorySnapshot(original);
    assert.ok(encoded);
    assert.equal(await decodeMacHistorySnapshot(encoded), original);
    assert.ok(Buffer.byteLength(JSON.stringify(encoded)) < Buffer.byteLength(original) / 10);
  }
});

test("small histories keep the v2 write path, and damaged compressed data is rejected", async () => {
  assert.equal(await encodeMacHistorySnapshot("{}"), null);
  await assert.rejects(decodeMacHistorySnapshot({ encoding: "gzip-base64", data: "broken" }));
  await assert.rejects(decodeMacHistorySnapshot({ encoding: "unknown", data: "" }));
});

const now = Date.parse("2026-10-31T12:00:00Z");
const events = Array.from({ length: 6000 }, (_, id) => ({
  id: `synthetic-${id}`, provider: "claude", app: "Claude Code", profile: "", session: "session-1",
  from: now, to: now, input: id, output: 5, cached: 0, timing: "event"
})).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const seed = {
  format: "canvastty-usage-history", version: 2,
  history: { version: 1, startedAt: now, collectedAt: now, events, samples: [], health: [], coverage: [], providerStatus: [], error: null },
  collector: { version: 2, files: { "0123456789abcdef01234567": {
    node: "1:2", head: "abcdef012345abcdef012345", headLength: 100, size: 400, mtime: now, offset: 400, seen: now
  } }, hermes: {} }, notices: []
};
function service(directory, platform, received = []) {
  return new UsageHistoryService({ directory, platform, now: () => now,
    limits: { getProviders: async () => ({ fetchedAt: now, providers: [] }) },
    createCollector(state) {
      received.push(structuredClone(state));
      return { state, collect: async () => ({ complete: true, events: [], coverage: [] }) };
    }
  });
}
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-mac-snapshot-"));
  try { await run(directory, join(directory, "usage-history.json")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("Mac migrates v2 atomically and reloads records with their collector state without duplication", async () => {
  await fixture(async (directory, path) => {
    await writeFile(path, JSON.stringify(seed));
    const first = service(directory, "darwin");
    await first.load();
    assert.deepEqual(first.get().events, events);
    const saved = await first.collect();
    await first.dispose();
    const envelope = JSON.parse(await readFile(path, "utf8"));
    assert.equal(envelope.version, 3);
    const decoded = JSON.parse(await decodeMacHistorySnapshot(envelope));
    assert.deepEqual(decoded.collector, seed.collector);
    const received = [];
    const second = service(directory, "darwin", received);
    await second.load();
    assert.deepEqual(second.get(), saved);
    await second.collect();
    assert.deepEqual(received, [seed.collector]);
    assert.deepEqual(second.get().events, events);
    await second.dispose();
    assert.deepEqual(await readdir(directory), ["usage-history.json"]);
  });
});

test("Linux and Windows still write v2 and preserve unsupported Mac files untouched", async () => {
  for (const platform of ["linux", "win32"]) await fixture(async (directory, path) => {
    await writeFile(path, JSON.stringify(seed));
    const current = service(directory, platform);
    await current.load(); await current.collect(); await current.dispose();
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
    const raw = JSON.stringify({ format: seed.format, version: 3, ...await encodeMacHistorySnapshot(JSON.stringify(seed)) });
    await writeFile(path, raw);
    const blocked = service(directory, platform);
    await blocked.load(); await blocked.collect(); await blocked.dispose();
    assert.match(blocked.get().error, /unsupported format/);
    assert.equal(await readFile(path, "utf8"), raw);
  });
});

test("damaged Mac envelope is preserved before restarting collection", async () => {
  await fixture(async (directory, path) => {
    const raw = JSON.stringify({ format: seed.format, version: 3, encoding: "gzip-base64", data: "broken" });
    await writeFile(path, raw);
    const current = service(directory, "darwin");
    await current.load(); await current.collect(); await current.dispose();
    const preserved = (await readdir(directory)).find(name => name.startsWith("usage-history.corrupt-"));
    assert.ok(preserved);
    assert.equal(await readFile(join(directory, preserved), "utf8"), raw);
    assert.match(current.get().error, /invalid compressed history/);
  });
});

test("rollback export restores exact v2 bytes without modifying or overwriting files", async () => {
  await fixture(async (directory, path) => {
    const original = JSON.stringify(seed);
    const compressed = JSON.stringify({ format: seed.format, version: 3, ...await encodeMacHistorySnapshot(original) });
    await writeFile(path, compressed);
    const output = join(directory, "rollback.json");
    await exportMacUsageHistory(path, output);
    assert.equal(await readFile(output, "utf8"), original);
    await assert.rejects(exportMacUsageHistory(path, output), { code: "EEXIST" });
    assert.equal(await readFile(path, "utf8"), compressed);
    await assert.rejects(exportMacUsageHistory(path, path), { code: "EEXIST" });
  });
});
