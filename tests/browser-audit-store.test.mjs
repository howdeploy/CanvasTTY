import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  BrowserAuditStore,
  redactAuditValue
} from "../src/main/services/browser/BrowserAuditStore.ts";

async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function auditInput(requestId, overrides = {}) {
  return {
    timestamp: 1_700_000_000_000,
    requestId,
    actorKind: "agent",
    actorId: "agent-test",
    operation: "browser_click",
    phase: "result",
    tabId: "tab-1",
    ok: true,
    details: { targetHash: `hash-${requestId}` },
    ...overrides
  };
}

async function auditFiles(store) {
  const directory = dirname(store.filePath);
  const names = await readdir(directory);
  return names.filter((name) => /^browser-audit(?:-.+)?\.jsonl$/.test(name)).sort();
}

test("redactAuditValue removes typed values, tokens, credentials, and URL query/fragment", () => {
  const sentinel = ["fixture", "sensitive", "value"].join("-");
  const redacted = redactAuditValue({
    text: sentinel,
    promptText: sentinel,
    value: sentinel,
    values: ["one", "two"],
    accessToken: sentinel,
    nested: {
      password: sentinel,
      authorization: `Basic ${sentinel}`,
      safeLabel: "visible",
      url: `https://user:pass@example.com/private/path?token=${sentinel}#${sentinel}`,
      bearerHeader: `Bearer ${sentinel}`
    }
  });

  assert.deepEqual(redacted, {
    text: "[REDACTED]",
    promptText: "[REDACTED]",
    value: "[REDACTED]",
    values: "[REDACTED]",
    accessToken: "[REDACTED]",
    nested: {
      password: "[REDACTED]",
      authorization: "[REDACTED]",
      safeLabel: "visible",
      url: "https://example.com/private/path",
      bearerHeader: "[REDACTED]"
    }
  });
  assert.equal(redactAuditValue(`https://example.com/path?q=${sentinel}#${sentinel}`), "https://example.com/path");
  assert.equal(redactAuditValue(`Bearer ${sentinel}`), "[REDACTED]");
  assert.equal(redactAuditValue(["password", sentinel].join("=")), "[REDACTED]");
});

test("BrowserAuditStore serializes concurrent appends into a verifiable hash chain", async (t) => {
  const root = await fixture(t, "canvastty-audit-chain-");
  const store = new BrowserAuditStore(root);

  const records = await Promise.all(
    Array.from({ length: 12 }, (_, index) => store.append(auditInput(`request-${index}`)))
  );

  assert.deepEqual(records.map((record) => record.sequence), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(records[0].previousHash, null);
  for (let index = 1; index < records.length; index += 1) {
    assert.equal(records[index].previousHash, records[index - 1].hash);
  }
  assert.deepEqual(await store.verify(), {
    valid: true,
    records: 12,
    lastHash: records.at(-1).hash
  });

  const lines = (await readFile(store.filePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 12);
  assert.equal(lines[0].details.targetHash, "hash-request-0");
});

test("BrowserAuditStore detects tampering and a reopened store fails closed", async (t) => {
  const root = await fixture(t, "canvastty-audit-tamper-");
  const store = new BrowserAuditStore(root);
  await store.append(auditInput("request-1"));
  await store.append(auditInput("request-2"));

  const records = (await readFile(store.filePath, "utf8")).trim().split("\n").map(JSON.parse);
  records[0].operation = "browser_type";
  await writeFile(store.filePath, `${records.map(JSON.stringify).join("\n")}\n`);
  assert.deepEqual(await store.verify(), { valid: false, records: 0, lastHash: null });

  const reopened = new BrowserAuditStore(root);
  await assert.rejects(reopened.append(auditInput("request-3")), /hash chain is invalid/i);
});

test("BrowserAuditStore rotates without breaking the cross-file hash chain", async (t) => {
  const root = await fixture(t, "canvastty-audit-rotate-");
  let now = 1_700_000_000_000;
  const store = new BrowserAuditStore(root, { maxBytes: 1_024, now: () => now });
  const records = [];
  for (let index = 0; index < 5; index += 1) {
    now += 1_000;
    records.push(await store.append(auditInput(`rotate-${index}`, {
      timestamp: now,
      details: { note: `${index}-${"x".repeat(700)}` }
    })));
  }

  const files = await auditFiles(store);
  assert.equal(files.includes("browser-audit.jsonl"), true);
  assert.equal(files.filter((name) => name.startsWith("browser-audit-")).length >= 1, true);
  assert.deepEqual(await store.verify(), {
    valid: true,
    records: records.length,
    lastHash: records.at(-1).hash
  });
});

test("BrowserAuditStore prunes expired rotations while retaining a verifiable chain anchor", async (t) => {
  const root = await fixture(t, "canvastty-audit-retention-");
  const retentionMs = 5_000;
  let now = 1_700_000_000_000;
  const store = new BrowserAuditStore(root, { maxBytes: 1_024, retentionMs, now: () => now });
  for (let index = 0; index < 3; index += 1) {
    now += 1_000;
    await store.append(auditInput(`retention-${index}`, {
      timestamp: now,
      details: { note: "x".repeat(700) }
    }));
  }

  const directory = dirname(store.filePath);
  const rotatedBefore = (await auditFiles(store)).filter((name) => name.startsWith("browser-audit-"));
  assert.equal(rotatedBefore.length >= 1, true);
  const expiredSeconds = (now - retentionMs - 1_000) / 1_000;
  for (const name of rotatedBefore) await utimes(join(directory, name), expiredSeconds, expiredSeconds);

  now += retentionMs + 2_000;
  const reopened = new BrowserAuditStore(root, { maxBytes: 1_024, retentionMs, now: () => now });
  const verification = await reopened.verify();
  assert.equal(verification.valid, true);
  assert.equal((await auditFiles(reopened)).some((name) => name.startsWith("browser-audit-")), false);

  const firstSurviving = JSON.parse((await readFile(reopened.filePath, "utf8")).trim().split("\n")[0]);
  assert.equal(typeof firstSurviving.previousHash, "string");
  assert.equal(firstSurviving.previousHash.length, 64);
});

test("deleting an initial rotated segment outside retention pruning fails verification", async (t) => {
  const root = await fixture(t, "canvastty-audit-deleted-segment-");
  let now = 1_700_000_000_000;
  const store = new BrowserAuditStore(root, { maxBytes: 1_024, now: () => now });
  for (let index = 0; index < 5; index += 1) {
    now += 1_000;
    await store.append(auditInput(`segment-${index}`, {
      timestamp: now,
      details: { note: `${index}-${"x".repeat(700)}` }
    }));
  }

  const directory = dirname(store.filePath);
  const rotated = (await auditFiles(store)).filter((name) => name.startsWith("browser-audit-")).sort();
  assert.ok(rotated.length >= 1, "the fixture must actually rotate at least once");

  // Remove the earliest rotated segment directly, the way a bug or an external
  // actor could - never through pruneExpired(), so no anchor was ever recorded
  // for what remains.
  await rm(join(directory, rotated[0]));

  const reopened = new BrowserAuditStore(root, { maxBytes: 1_024, now: () => now });
  const verification = await reopened.verify();
  assert.equal(verification.valid, false, "verification must not accept the truncated chain as a fresh genesis");
});

test("BrowserAuditStore propagates storage failures instead of pretending to audit", async (t) => {
  const root = await fixture(t, "canvastty-audit-failure-");
  await writeFile(join(root, "browser"), "directory blocker");
  const store = new BrowserAuditStore(root);

  await assert.rejects(store.append(auditInput("blocked")), (error) => {
    assert.equal(["EEXIST", "ENOTDIR"].includes(error?.code), true);
    return true;
  });
  await assert.rejects(store.verify());
});

test("BrowserAuditStore repairs a line torn by a crash instead of refusing every later action", async (t) => {
  const root = await fixture(t, "canvastty-audit-torn-");
  const store = new BrowserAuditStore(root);
  await store.append(auditInput("torn-1"));
  await store.append(auditInput("torn-2"));
  const complete = await readFile(store.filePath, "utf8");
  // A crash or ENOSPC during the append left half a record and no newline.
  const third = JSON.stringify({ ...JSON.parse(complete.trim().split("\n")[1]), sequence: 3 });
  await writeFile(store.filePath, complete + third.slice(0, 40));

  const reopened = new BrowserAuditStore(root);
  const warn = console.warn;
  console.warn = () => undefined;
  let appended;
  try {
    appended = await reopened.append(auditInput("after-crash"));
    assert.equal(appended.sequence, 3);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(await reopened.verify(), { valid: true, records: 3, lastHash: appended.hash });
  assert.equal((await readFile(reopened.filePath, "utf8")).split("\n").filter(Boolean).length, 3);

  // A complete last record that only lost its newline is kept, not dropped.
  const whole = await readFile(reopened.filePath, "utf8");
  await writeFile(reopened.filePath, whole.slice(0, -1));
  const again = new BrowserAuditStore(root);
  assert.equal((await again.append(auditInput("after-newline"))).sequence, 4);
  assert.equal((await again.verify()).valid, true);
});

function runInLocale(locale, root, action) {
  const script = `
    const { BrowserAuditStore } = await import(${JSON.stringify(new URL("../src/main/services/browser/BrowserAuditStore.ts", import.meta.url).href)});
    const store = new BrowserAuditStore(${JSON.stringify(root)});
    if (${JSON.stringify(action)} === "append") {
      await store.append({ timestamp: 1, requestId: "r-" + ${JSON.stringify(locale)}, actorKind: "agent", actorId: "a", operation: "browser_click",
        phase: "result", ok: true, details: { "z": 1, "ä": 2, "Zeta": 3, "alpha": 4 } });
    }
    process.stdout.write(JSON.stringify(await store.verify()));`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
    env: { ...process.env, LC_ALL: locale, LANG: locale },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("the audit hash does not depend on the system locale", async (t) => {
  const root = await fixture(t, "canvastty-audit-locale-");
  assert.equal(runInLocale("sv_SE.UTF-8", root, "append").valid, true);
  // The same log read by a process with another collation.
  const other = runInLocale("en_US.UTF-8", root, "verify");
  assert.equal(other.valid, true);
  assert.equal(other.records, 1);
  assert.equal(runInLocale("en_US.UTF-8", root, "append").records, 2);
  assert.equal(runInLocale("sv_SE.UTF-8", root, "verify").valid, true);
});

test("BrowserAuditStore enforces an aggregate quota across retained segments, oldest first, keeping the chain anchor consistent", async (t) => {
  const root = await fixture(t, "canvastty-audit-aggregate-");
  let now = 1_700_000_000_000;
  // Each record is ~1.2 KB; maxBytes=1024 rotates roughly every record, maxTotalBytes=3000 should
  // keep only the last couple of rotated segments plus the active file once enough accumulate.
  // (Quota, like the existing per-file maxBytes rotation, is enforced going into the next write -
  // not by reaching back into the file currently being appended to - so the resting total can
  // run at most one record over quota until the next append or reopen re-checks it.)
  const store = new BrowserAuditStore(root, { maxBytes: 1_024, maxTotalBytes: 3_000, now: () => now });
  const records = [];
  for (let index = 0; index < 30; index += 1) {
    now += 1_000;
    records.push(await store.append(auditInput(`aggregate-${index}`, {
      timestamp: now,
      details: { note: `${index}-${"x".repeat(700)}` }
    })));
  }

  const directory = dirname(store.filePath);
  const sizeOf = async (names) => {
    let total = 0;
    for (const name of names) total += (await stat(join(directory, name))).size;
    return total;
  };
  const oneRecordBytes = (await stat(store.filePath)).size;
  const totalBytesAfterAppends = await sizeOf(await auditFiles(store));
  assert.ok(
    totalBytesAfterAppends <= 3_000 + oneRecordBytes,
    `aggregate retained size ${totalBytesAfterAppends} must stay bounded near the quota across 30 appends, not grow with every rotation`
  );

  const verification = await store.verify();
  assert.equal(verification.valid, true);
  assert.equal(verification.records < records.length, true, "older records must actually have been dropped, not merely closed over");

  // Reopening re-checks the quota (the same lag as the existing per-file rotation check) and must
  // land at or under it, while the chain it trusts stays valid and keeps extending forward.
  const reopened = new BrowserAuditStore(root, { maxBytes: 1_024, maxTotalBytes: 3_000, now: () => now });
  const reopenedVerification = await reopened.verify();
  assert.equal(reopenedVerification.valid, true);
  assert.equal(reopenedVerification.lastHash, records.at(-1).hash);
  const totalBytesAfterReopen = await sizeOf(await auditFiles(reopened));
  assert.ok(totalBytesAfterReopen <= 3_000, `reopening must enforce the quota exactly: got ${totalBytesAfterReopen}`);

  const appended = await reopened.append(auditInput("aggregate-after-reopen", { timestamp: now + 1 }));
  assert.equal(appended.sequence, records.length + 1);
  assert.equal(appended.previousHash, records.at(-1).hash);
  assert.equal((await reopened.verify()).valid, true);
});

test("BrowserAuditStore never deletes the active file to satisfy the aggregate quota", async (t) => {
  const root = await fixture(t, "canvastty-audit-aggregate-active-");
  const store = new BrowserAuditStore(root, { maxBytes: 1_024, maxTotalBytes: 1, now: () => 1_700_000_000_000 });
  const record = await store.append(auditInput("solo"));
  assert.deepEqual(await store.verify(), { valid: true, records: 1, lastHash: record.hash });
  const directory = dirname(store.filePath);
  assert.ok((await readdir(directory)).includes("browser-audit.jsonl"));
});

test("BrowserAuditStore.verify and reopening a store both stay correct over a large multi-segment log", async (t) => {
  const root = await fixture(t, "canvastty-audit-stream-");
  const store = new BrowserAuditStore(root, { maxBytes: 8 * 1024 });
  const records = [];
  for (let index = 0; index < 400; index += 1) {
    records.push(await store.append(auditInput(`stream-${index}`, { details: { note: "y".repeat(2_000) } })));
  }
  const rotatedCount = (await auditFiles(store)).filter((name) => name.startsWith("browser-audit-")).length;
  assert.ok(rotatedCount >= 2, "the fixture must actually span several rotated segments");

  const verification = await store.verify();
  assert.deepEqual(verification, { valid: true, records: 400, lastHash: records.at(-1).hash });

  // A freshly opened store re-derives the same sequence/hash state from disk (this is exactly
  // the read path `initialize()` streams instead of loading every segment into memory at once).
  const reopened = new BrowserAuditStore(root, { maxBytes: 8 * 1024 });
  const next = await reopened.append(auditInput("stream-400"));
  assert.equal(next.sequence, 401);
  assert.equal(next.previousHash, records.at(-1).hash);
});

test("records hashed with the earlier locale-ordered keys still verify and extend the chain", async (t) => {
  const root = await fixture(t, "canvastty-audit-legacy-");
  const legacyJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(legacyJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${legacyJson(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const store = new BrowserAuditStore(root);
  const first = await store.append(auditInput("legacy-1", { details: { Zeta: 1, alpha: 2 } }));
  const { hash: _hash, ...base } = first;
  const legacy = { ...base, hash: createHash("sha256").update(legacyJson(base)).digest("hex") };
  assert.notEqual(legacy.hash, first.hash, "the fixture differs between the two orderings");
  await writeFile(store.filePath, `${JSON.stringify(legacy)}\n`);
  const reopened = new BrowserAuditStore(root);
  const next = await reopened.append(auditInput("new-2"));
  assert.equal(next.previousHash, legacy.hash);
  assert.deepEqual((await reopened.verify()).valid, true);
});
