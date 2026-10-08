import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { SecretRedactionRegistry } from "../src/main/services/safety/SecretRedaction.ts";
import { collectTerminalHistoryRecoverySnapshots, TerminalOutputHistory } from "../src/main/services/TerminalOutputHistory.ts";

function historyFor(t, snapshot = () => ({ revision: 0, values: [] }), recover) {
  const history = new TerminalOutputHistory(snapshot, recover);
  t.after(() => history.close());
  return history;
}

test("dense matches on one long line are searched once within the response target", { timeout: 3_000 }, async t => {
  const history = historyFor(t);
  const data = "a".repeat(500_000) + "\nsecond line a\n";
  await history.append("dense", data, data.length);
  const began = performance.now();
  const result = await history.search("a", ["dense"]);
  const elapsed = performance.now() - began;
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches.map(row => [row.line, row.offset]), [[0, 0], [1, 500_001]]);
  assert.ok(elapsed < 300, `dense single-line search took ${elapsed.toFixed(1)} ms`);
  t.diagnostic(`500K dense matches: ${elapsed.toFixed(1)} ms`);
});

test("Unicode case expansion preserves source lines and context offsets", async t => {
  const history = historyFor(t);
  const first = "İ".repeat(50) + " marker\n";
  const data = first + "untouched\nsecond marker\n";
  await history.append("unicode", data, data.length);
  const result = await history.search("MARKER", ["unicode"]);
  assert.deepEqual(result.matches.map(row => [row.line, row.offset, row.text]), [
    [0, 0, first.trimEnd()], [2, first.length + "untouched\n".length, "second marker"]
  ]);
  const context = await history.readContext("unicode", result.matches[1].offset);
  assert.equal(context.targetLine, 2);
  assert.equal(context.firstLine, 0);
  assert.match(context.text, /second marker/u);
});

test("the match limit still reports lost history in later sessions within the search scope", async t => {
  const history = historyFor(t);
  const rows = "match\n".repeat(101);
  await history.append("full", rows, rows.length);
  await history.append("late-gap", "match\n", 1_000);
  const result = await history.search("match", ["full", "late-gap"]);
  assert.equal(result.matches.length, 100);
  assert.deepEqual(result.prunedSessionIds, ["late-gap"]);
  assert.deepEqual((await history.search("match", ["full"])).prunedSessionIds, []);
});

test("recovery reads only tails that fit the aggregate budget and marks omitted sessions", async t => {
  const reads = [];
  const tails = { oldest: "oldest", removed: "gone", middle: "middle", latest: "latest" };
  const snapshots = collectTerminalHistoryRecoverySnapshots(Object.keys(tails), (sessionId, maxChars) => {
    reads.push([sessionId, maxChars]);
    if (sessionId === "removed") throw new Error("card removed");
    return { buffer: maxChars ? tails[sessionId].slice(-maxChars) : "", outputOffset: 100 };
  }, 8);
  assert.deepEqual(reads, [["latest", 8], ["middle", 2], ["removed", 0], ["oldest", 0]]);
  assert.deepEqual(snapshots.map(row => [row.sessionId, row.buffer, row.outputOffset]), [
    ["oldest", "", 100], ["middle", "le", 100], ["latest", "latest", 100]
  ]);
  const history = historyFor(t, () => ({ revision: 0, values: [] }), () => snapshots);
  await history.append("latest", "before crash\n", 13);
  await new Promise(resolve => {
    history.worker.once("exit", resolve);
    history.worker.kill();
  });
  const recovered = await history.search("latest");
  assert.deepEqual(recovered.prunedSessionIds, ["oldest", "middle", "latest"]);
  assert.equal(recovered.matches[0].text, "latest");
  assert.equal((await history.readContext("oldest", 0)).historyTruncated, true);

  const sharedTail = "x".repeat(240_000);
  const bounded = collectTerminalHistoryRecoverySnapshots(Array.from({ length: 300 }, (_, i) => String(i)), (_, limit) =>
    ({ buffer: limit ? sharedTail.slice(-limit) : "", outputOffset: sharedTail.length }));
  assert.equal(bounded.length, 300);
  assert.equal(bounded.reduce((sum, row) => sum + row.buffer.length, 0), 16_000_000);
  assert.equal(bounded[0].buffer, "");
  assert.equal(bounded.at(-1).buffer, sharedTail);
});

test("full-session output history masks secrets across PTY chunks and strips split ANSI controls", async (t) => {
  const redaction = new SecretRedactionRegistry();
  const secret = "CROSS_CHUNK_PRIVATE_TOKEN_987654321";
  redaction.add("vault", [secret]);
  const history = historyFor(t, () => redaction.snapshotForWorker());

  const first = `prefix ${secret.slice(0, 13)}\u001b[31`;
  const second = `m${secret.slice(13)}\u001b[0m suffix\nordinary tail match-target\n`;
  await Promise.all([
    history.append("session-secret", first, first.length),
    history.append("session-secret", second, first.length + second.length)
  ]);

  const masked = await history.search("prefix", ["session-secret"]);
  assert.equal(masked.matches.length, 1);
  assert.equal(masked.matches[0].text, "prefix <redacted:secret> suffix");
  assert.doesNotMatch(JSON.stringify(masked), new RegExp(secret));

  const target = await history.search("match-target", ["session-secret"]);
  const context = await history.readContext("session-secret", target.matches[0].offset);
  assert.match(context.text, /match-target/u);
  assert.doesNotMatch(context.text, new RegExp(secret));
});

test("an unfinished OSC sequence keeps decoder state without retaining its growing payload", async (t) => {
  const history = historyFor(t);
  let offset = 0;
  const prefix = `visible prefix\n\u001b]0;`;
  await history.append("long-osc", prefix, offset += prefix.length);
  const payload = "x".repeat(900_000);
  for (let index = 0; index < 8; index++) await history.append("long-osc", payload, offset += payload.length);
  const suffix = "\u0007visible marker\n";
  await history.append("long-osc", suffix, offset += suffix.length);

  const visible = await history.search("visible marker", ["long-osc"]);
  assert.equal(visible.matches.length, 1);
  assert.equal((await history.search("visible prefix", ["long-osc"])).matches.length, 1);
  assert.equal((await history.search("xxxxxxxx", ["long-osc"])).matches.length, 0);
});

test("full history stays resident while a session is live and is discarded after its last removal", async (t) => {
  let recoveries = 0;
  const history = historyFor(t, () => ({ revision: 0, values: [] }), () => {
    recoveries += 1;
    return [];
  });
  const text = "still-searchable after the worker has been quiescent";
  await history.append("other-session", "remaining session first\n", 24);
  await history.append("live-session", `${text}\n`, text.length + 1);
  await history.append("live-session", "second block\n", text.length + 14);
  await history.append("other-session", "remaining session last\n", 47);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await history.search("searchable")).matches.length, 1);
  assert.equal(recoveries, 0, "a quiescent worker keeps the full live-session history resident");

  await history.remove("live-session");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await history.search("searchable")).matches.length, 0);
  await history.append("other-session", "remaining session after removal\n", 79);
  assert.deepEqual((await history.search("remaining session")).matches.map(row => [row.line, row.offset]), [[0, 0], [1, 24], [2, 47]]);
  assert.equal(recoveries, 0, "removing interleaved blocks preserves the other live session");

  const discarded = "discarded same-turn output\n";
  const retained = "retained same-turn output\n";
  await Promise.all([
    history.append("replacement-session", discarded, discarded.length),
    history.remove("replacement-session"),
    history.append("replacement-session", retained, retained.length)
  ]);
  assert.equal((await history.search("discarded same-turn", ["replacement-session"])).matches.length, 0);
  const replacement = await history.search("retained same-turn", ["replacement-session"]);
  assert.equal(replacement.matches.length, 1);
  assert.equal((await history.readContext("replacement-session", replacement.matches[0].offset)).text, retained);
  await history.remove("replacement-session");
  assert.equal((await history.search("retained same-turn", ["replacement-session"])).matches.length, 0);

  await history.remove("other-session");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await history.search("remaining session")).matches.length, 0);
  assert.equal(recoveries, 1, "the empty worker was released and the next request recovered an empty history");

  const closingHistory = historyFor(t);
  const queuedAppend = closingHistory.append("closing-session", "queued output\n", 14);
  const rejectedAppend = assert.rejects(queuedAppend, /shutting down/u);
  await closingHistory.close();
  await rejectedAppend;
});

test("a newly registered secret invalidates the worker's previously masked history cache", async (t) => {
  const redaction = new SecretRedactionRegistry();
  const history = historyFor(t, () => redaction.snapshotForWorker());
  const secret = "LATE_REGISTERED_PRIVATE_SECRET_123456789";
  const data = `prefix ${secret} suffix\n`;
  await history.append("late-secret", data, data.length);

  const before = await history.search("prefix", ["late-secret"]);
  assert.match(before.matches[0].text, new RegExp(secret));
  redaction.add("vault", [secret]);
  const after = await history.search("prefix", ["late-secret"]);
  assert.doesNotMatch(JSON.stringify(after), new RegExp(secret));
  assert.match(after.matches[0].text, /<redacted:secret>/u);
});

test("a crashed output worker recovers recent PTY tails with fresh masking and a lost-history marker", async t => {
  const redaction = new SecretRedactionRegistry();
  const old = "only-in-old-history\n" + "old output\n".repeat(30_000);
  const secret = "RECOVERY_PRIVATE_SECRET_987654321";
  const tail = `recent recovered ${secret}\n`;
  const history = historyFor(t, () => redaction.snapshotForWorker(), () => [
    { sessionId: "recover", buffer: tail, outputOffset: old.length + tail.length }
  ]);
  await history.append("recover", old, old.length);
  assert.equal((await history.search("only-in-old-history")).matches.length, 1);
  const oldWorker = history.worker;
  await new Promise(resolve => {
    oldWorker.once("exit", resolve);
    oldWorker.kill();
  });
  redaction.add("vault", [secret]);
  const recovered = await history.search("recent recovered", ["recover"]);
  assert.equal(recovered.matches.length, 1);
  assert.deepEqual(recovered.prunedSessionIds, ["recover"]);
  assert.doesNotMatch(JSON.stringify(recovered), new RegExp(secret));
  const context = await history.readContext("recover", recovered.matches[0].offset);
  assert.equal(context.historyTruncated, true);
  assert.match(context.text, /<redacted:secret>/u);
  assert.equal((await history.search("only-in-old-history")).matches.length, 0);
  const fresh = "new live output\n";
  await history.append("recover", fresh, old.length + tail.length + fresh.length);
  assert.equal((await history.search("new live output")).matches.length, 1);
  assert.notEqual(history.worker, oldWorker);
});

test("worker recovery retains history-gap metadata for more than 256 live sessions", async t => {
  const ids = Array.from({ length: 300 }, (_, index) => `recover-${index.toString().padStart(3, "0")}`);
  const history = historyFor(t, () => ({ revision: 0, values: [] }), () =>
    collectTerminalHistoryRecoverySnapshots(ids, (id, maximum) => ({ buffer: `recent-${id}\n`.slice(-maximum), outputOffset: 10_000 })));
  await history.append(ids[0], "previously searchable output\n", 30);
  assert.equal((await history.search("previously searchable", [ids[0]])).matches.length, 1);
  await new Promise(resolve => {
    history.worker.once("exit", resolve);
    history.worker.kill();
  });
  const recovered = await history.search(`recent-${ids[0]}`, [ids[0]]);
  assert.equal(recovered.matches.length, 1, "the older supported card is reseeded rather than silently omitted");
  assert.deepEqual(recovered.prunedSessionIds, [ids[0]], "its lost history is reported after recovery");
  assert.equal((await history.readContext(ids[0], recovered.matches[0].offset)).historyTruncated, true);
  assert.equal((await history.search("recent-")).prunedSessionIds.length, ids.length);
  const unsupported = historyFor(t, () => ({ revision: 0, values: [] }), () =>
    Array.from({ length: 1_025 }, (_, index) => ({ sessionId: `unsupported-${index}`, buffer: "", outputOffset: 1 })));
  await unsupported.append("seed", "seed\n", 5);
  const unsupportedWorker = unsupported.worker;
  await new Promise(resolve => {
    unsupportedWorker.once("exit", resolve);
    unsupportedWorker.kill();
  });
  await assert.rejects(unsupported.search("recent"), /recovery snapshots are invalid/u);
});

test("ten full terminal histories keep late output searchable under the 300 ms repeated-search target", async (t) => {
  const redaction = new SecretRedactionRegistry();
  const history = historyFor(t, () => redaction.snapshotForWorker());

  const ids = Array.from({ length: 10 }, (_, index) => `session-${index}`);
  const row = "output line with a stable body that stays in history\n";
  // 300K UTF-16 code units per terminal, each larger than the former 240K ring.
  const bulk = row.repeat(Math.ceil(300_000 / row.length));
  for (let index = 0; index < ids.length; index++) {
    const prefix = index === 0 ? "early_history_unique_marker\n" : "";
    const suffix = index === ids.length - 1 ? "late_history_unique_match\n" : "";
    const contents = prefix + bulk + suffix;
    for (let start = 0; start < contents.length; start += 1_000_000) {
      const batch = contents.slice(start, start + 1_000_000);
      await history.append(ids[index], batch, start + batch.length);
    }
  }

  const timedSearch = async () => {
    const began = performance.now();
    const result = await history.search("late_history_unique_match", ids);
    return { elapsedMs: performance.now() - began, result };
  };
  const first = await timedSearch();
  const repeat = await timedSearch();
  assert.equal(first.result.matches.length, 1);
  assert.equal(first.result.matches[0].sessionId, ids.at(-1));
  assert.ok(first.result.matches[0].offset > 240_000);
  assert.deepEqual(first.result.prunedSessionIds, []);
  assert.equal(repeat.result.matches.length, 1);
  const context = await history.readContext(ids.at(-1), first.result.matches[0].offset);
  assert.match(context.text, /late_history_unique_match/u);
  assert.equal(context.historyTruncated, false);
  const early = await history.search("early_history_unique_marker", ids);
  assert.equal(early.matches[0].sessionId, ids[0]);
  assert.equal(early.matches[0].offset, 0);
  assert.match((await history.readContext(ids[0], early.matches[0].offset)).text, /early_history_unique_marker/u);
  // The 300 ms target is for repeated searches; the first one also masks 3M characters in the worker, so it only gets a cold bound.
  assert.ok(first.elapsedMs < 1_000, `first full-history search took ${first.elapsedMs.toFixed(1)} ms`);
  assert.ok(repeat.elapsedMs < 300, `cached full-history search took ${repeat.elapsedMs.toFixed(1)} ms`);
  t.diagnostic(`10 × ${bulk.length.toLocaleString()} chars: first search ${first.elapsedMs.toFixed(1)} ms; cached search ${repeat.elapsedMs.toFixed(1)} ms`);
});

test("large two-byte history remains searchable after a busy-session append", { timeout: 15_000 }, async t => {
  const redaction = new SecretRedactionRegistry();
  for (let index = 0; index < 16; index++) {
    redaction.add(`bench:${index}`, [`BENCH_SECRET_VALUE_${index.toString().padStart(2, "0")}_${"q7A9".repeat(30)}`]);
  }
  const history = historyFor(t, () => redaction.snapshotForWorker());
  const ids = ["wide-history"];
  let offset = 0;
  const preamble = "hit;\n".repeat(100);
  await history.append(ids[0], preamble, offset += preamble.length);
  const row = "界".repeat(100) + "\n";
  const bulk = row.repeat(9_900);
  for (let index = 0; index < 14; index++) {
    await history.append("interleaved", "other-session output;\n", (index + 1) * 22);
    await history.append(ids[0], bulk, offset += bulk.length);
  }
  const final = row.repeat(9_899) + "unique-sentinel;\n";
  await history.append(ids[0], final, offset += final.length);

  const timedSearch = async (query) => {
    const began = performance.now();
    const result = await history.search(query, ids);
    return { elapsedMs: performance.now() - began, result };
  };
  const beforeAppend = await timedSearch("hit");
  assert.equal(beforeAppend.result.matches.length, 100);
  const stableRepeat = await timedSearch("hit");
  await history.append(ids[0], "tail output;\n", offset + "tail output;\n".length);
  const afterAppend = await timedSearch("hit");
  assert.equal(afterAppend.result.matches.length, 100);
  assert.equal(afterAppend.result.matches[0].sessionId, ids[0]);
  assert.ok(afterAppend.elapsedMs < beforeAppend.elapsedMs * 0.75,
    `post-append search should reuse the stable masked prefix (${beforeAppend.elapsedMs.toFixed(1)} ms → ${afterAppend.elapsedMs.toFixed(1)} ms; stable repeat ${stableRepeat.elapsedMs.toFixed(1)} ms)`);
  const late = await history.search("unique-sentinel", ids);
  assert.equal(late.matches.length, 1);
  assert.equal(late.matches[0].line, 148_599);
  t.diagnostic(`15M two-byte chars: first search ${beforeAppend.elapsedMs.toFixed(1)} ms; cached repeat ${stableRepeat.elapsedMs.toFixed(1)} ms; search after append ${afterAppend.elapsedMs.toFixed(1)} ms`);

  const trim = "trim;\n".repeat(166_666);
  await history.append("prune-trigger", trim, trim.length);
  await history.append("prune-trigger", trim, trim.length * 2);
  const afterPrune = await history.search("unique-sentinel", ids);
  assert.deepEqual(afterPrune.prunedSessionIds, ids);
  assert.equal(afterPrune.matches.length, 1);
  assert.deepEqual([afterPrune.matches[0].line, afterPrune.matches[0].text], [148_599, "unique-sentinel;"]);
  assert.equal(afterPrune.matches[0].offset + (await history.readContext(ids[0], afterPrune.matches[0].offset)).historyBaseOffset, late.matches[0].offset);
  // The masked view keeps whole segments, each starting at a line start, so its first line is complete.
  const retained = await history.readContext(ids[0], 0);
  assert.match(retained.text.slice(0, retained.text.indexOf("\n")), /^(?:hit;|界{100})$/u);
  assert.deepEqual((await history.search("other-session", ["interleaved"])).prunedSessionIds, ["interleaved"]);
});

test("a registered PEM footer cannot let the segmented history cache expose the masked block's suffix", async t => {
  const redaction=new SecretRedactionRegistry();
  const header=["-----BEGIN","RSA","PRIVATE","KEY-----"].join(" ");
  const footer=["-----END","RSA","PRIVATE","KEY-----"].join(" ");
  redaction.add("fixture",[footer]);
  const text=`safe start;\n${header}\nMIIE-FIXTURE\n`+"private body fixture.\n".repeat(500)+`${footer}\nordinary later line.\n`;
  const history=historyFor(t,()=>redaction.snapshotForWorker());
  await history.append("armour",text,text.length);
  assert.equal((await history.search("private body fixture",["armour"])).matches.length,0);
  assert.equal((await history.search("ordinary later",["armour"])).matches.length,1,"text after the actual PEM footer is public");
  const appended="further public line.\n";await history.append("armour",appended,text.length+appended.length);
  assert.equal((await history.search("private body fixture",["armour"])).matches.length,0);
  assert.equal((await history.search("further public",["armour"])).matches.length,1);
});

test("the whole-line fallback masks secrets in a 16M two-byte adversarial history", { timeout: 30_000 }, async t => {
  const redaction = new SecretRedactionRegistry();
  const secret = "ADVERSARIAL_PRIVATE_VALUE_987654321";
  redaction.add("vault", [secret]);
  const history = historyFor(t, () => redaction.snapshotForWorker());
  let offset = 0;
  const prefix = `prefix ${secret}`;
  await history.append("wide-line", prefix, offset += prefix.length);
  while (offset < 16_000_000) {
    const count = Math.min(1_000_000, 16_000_000 - offset);
    const batch = "界".repeat(count);
    await history.append("wide-line", batch, offset += batch.length);
  }
  const result = await history.search("prefix", ["wide-line"]);
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].text, /^prefix <redacted:secret>/u);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("public history keeps wrapped, incomplete, and registered secrets masked across stable-cache appends", { timeout: 30_000 }, async t => {
  const redaction = new SecretRedactionRegistry();
  const secret = "APPENDED_PRIVATE_VALUE_CROSSES_A_SAFE_BOUNDARY_123456789";
  redaction.add("vault", [secret]);
  const history = historyFor(t, () => redaction.snapshotForWorker());
  const offsets = new Map();
  const append = async (sessionId, data) => {
    let offset = offsets.get(sessionId) ?? 0;
    for (let start = 0; start < data.length; start += 1_000_000) {
      const chunk = data.slice(start, start + 1_000_000);
      offset += chunk.length;
      await history.append(sessionId, chunk, offset);
    }
    offsets.set(sessionId, offset);
  };

  const prelude = "visible safe;\n" + "ordinary output;\n".repeat(50_000);
  await append("append-secret", prelude);
  assert.equal((await history.search("visible", ["append-secret"])).matches.length, 1);

  const first = `joined ${secret.slice(0, 23)}`;
  await append("append-secret", first);
  const second = `\n  ${secret.slice(23)} suffix;\n`;
  await append("append-secret", second);
  const result = await history.search("joined", ["append-secret"]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].text, "joined <redacted:secret> suffix;");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  const anthropicPrefix = ["sk", "ant", ""].join("-");
  const genericCases = [
    ["authorization", "Authorization: Bearer ", "super-secret-value-abcdefgh\n", "super-secret-value-abcdefgh"],
    ["bearer", "Bearer ", "thisisalongbearersecretvalue123456\n", "thisisalongbearersecretvalue123456"],
    ["json", '{"token": "', 'thisisasecretvalue"}\n', "thisisasecretvalue"],
    ["key", "key: ", `${anthropicPrefix}123456789012345678901234\n`, `${anthropicPrefix}123456789012345678901234`],
    ["pem", ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ") + "\npart one\n", "part two\n" + ["-----END", "RSA", "PRIVATE", "KEY-----"].join(" ") + "\n", "part one\npart two"],
    ["overlap", `${anthropicPrefix}123456789012345678\n  `, "abCDef012345678901234\n", `${anthropicPrefix}123456789012345678\n  abCDef012345678901234`],
    ["query", "?token=", "super-secret-value-abcdefgh&next=x\n", "super-secret-value-abcdefgh"]
  ];
  for (const [name, before, after, privateText] of genericCases) {
    const sessionId = `generic-${name}`;
    const initial = "ordinary terminal output;\n".repeat(300) + `focus ${before}`;
    await append(sessionId, initial);
    await history.search("focus", [sessionId]); // Materialize the stable masked prefix before completing the value.
    await append(sessionId, after);
    const found = await history.search("focus", [sessionId]);
    assert.equal(found.matches.length, 1, name);
    assert.equal(JSON.stringify(found).includes(privateText), false, `${name} secret leaked through public history`);
    const context = await history.readContext(sessionId, found.matches[0].offset);
    assert.ok(context.text.endsWith(redaction.redact(`focus ${before}${after}`)),
      `${name} cached context must preserve the complete masked suffix across append boundaries`);
  }
  const longSecret = "界aB9_".repeat(13_000);
  redaction.add("long-unicode", [longSecret]);
  assert.equal(longSecret.length, 65_000);
  const longSession = "long-unicode";
  await append(longSession, "界\n".repeat(2_200_000) + `focus ${longSecret}\n`);
  await history.search("界", [longSession]);
  const longResult = await history.search("focus", [longSession]);
  assert.equal(longResult.matches.length, 1);
  assert.equal(longResult.matches[0].text, "focus <redacted:secret>");
  assert.equal(JSON.stringify(longResult).includes(longSecret), false);

  const escapedSecret = 'JSON_"_\\_Unicode_界_SECRET_987654321';
  redaction.add("escaped-json", [escapedSecret]);
  const escaped = JSON.stringify(escapedSecret).slice(1, -1);
  const escapedSession = "escaped-json";
  await append(escapedSession, "ordinary;\n".repeat(500) + `focus ${escaped.slice(0, 12)}`);
  await history.search("focus", [escapedSession]);
  await append(escapedSession, `\n  ${escaped.slice(12)} suffix;\n`);
  const escapedResult = await history.search("focus", [escapedSession]);
  assert.equal(escapedResult.matches.length, 1);
  assert.equal(escapedResult.matches[0].text, "focus <redacted:secret> suffix;");
  assert.equal(JSON.stringify(escapedResult).includes(escaped), false);

  const overlap = "PREFIXTRANSITIVEOVERLAP_ABCDEFGHIJ_1234567890_TAILSUFFIX";
  redaction.add("overlap", [overlap.slice(0, 25), overlap.slice(18, 43), overlap.slice(36)]);
  const overlapSession = "overlap";
  await append(overlapSession, "ordinary output;\n".repeat(500) + `focus ${overlap}\n`);
  const overlapResult = await history.search("focus", [overlapSession]);
  assert.equal(overlapResult.matches.length, 1);
  assert.equal(overlapResult.matches[0].text, "focus <redacted:secret>");
  assert.equal(JSON.stringify(overlapResult).includes(overlap), false);

  const openPemSession = "open-pem";
  const openPem = `safe;\n${["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ")}\n${"MIIE".repeat(20_000)}\n`;
  await append(openPemSession, openPem);
  const openPemResult = await history.search("safe", [openPemSession]);
  assert.equal(openPemResult.matches.length, 1);
  assert.equal((await history.readContext(openPemSession, openPemResult.matches[0].offset)).text, "safe;\n<redacted:private-key>");
  assert.equal(JSON.stringify(openPemResult).includes("MIIE"), false);
});

test("searching a busy session at the history cap masks only what arrived since the previous query", { timeout: 120_000 }, async t => {
  const redaction = new SecretRedactionRegistry();
  const secret = "BUSY_SESSION_PRIVATE_VALUE_123456789";
  redaction.add("vault", [secret]);
  const history = historyFor(t, () => redaction.snapshotForWorker());
  let offset = 0;
  let row = 0;
  const appendRows = async (chars) => {
    for (let written = 0; written < chars;) {
      let batch = "";
      while (batch.length < 200_000) batch += `\u001b[36m${String(row++).padStart(8, "0")}\u001b[0m build output ${row % 997} value=${(row * 7919) % 100003}\r\n`;
      offset += batch.length;
      written += batch.length;
      await history.append("busy", batch, offset);
    }
  };
  await appendRows(20_000_000); // past the 16M cap: every later append prunes the oldest output
  const marker = `needle-zz ${secret}\n`;
  await history.append("busy", marker, offset += marker.length);
  const first = await history.search("needle-zz", ["busy"]);
  assert.equal(first.matches.length, 1);
  assert.equal(first.matches[0].text, "needle-zz <redacted:secret>");
  const elapsed = [];
  for (let round = 0; round < 8; round++) {
    await appendRows(64_000);
    const began = performance.now();
    const result = await history.search("needle-zz", ["busy"]);
    elapsed.push(performance.now() - began);
    assert.equal(result.matches.length, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
  elapsed.sort((a, b) => a - b);
  t.diagnostic(`searches after appends: median ${elapsed[4].toFixed(1)} ms, max ${elapsed[7].toFixed(1)} ms`);
  assert.ok(elapsed[4] < 300, `a search after an append re-masked the history (${elapsed.map(ms => ms.toFixed(0)).join(", ")} ms)`);
});

test("ANSI controls are removed exactly, including nested and unfinished sequences", async t => {
  const history = historyFor(t);
  const cases = [
    ["colours", "\u001b[36m00000001\u001b[0m bench \u001b[1mflood\u001b[0m x\n", "00000001 bench flood x\n"],
    ["nested CSI", "\u009b\u009bmP[]a\n", "P[]a\n"],
    ["CSI inside OSC", "a\u001b]0;title\u001b[31m\u0007b\n", "ab\n"],
    ["unfinished CSI", "c\u001b[3", "c"]
  ];
  for (const [name, raw, visible] of cases) {
    await history.append(name, raw, raw.length);
    assert.equal((await history.readContext(name, 0)).text, visible, name);
  }
  await history.append("unfinished CSI", "1mtail\n", "c\u001b[3".length + "1mtail\n".length);
  assert.equal((await history.readContext("unfinished CSI", 0)).text, "ctail\n");
});

test("a crashed worker recovers older history from its encrypted spill and marks lost output", async t => {
  const { mkdtemp, readdir, readFile, rm, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "ctty-history-spill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spillDirectory = join(root, "spill");
  await mkdir(join(spillDirectory, "0".repeat(32)), { recursive: true });
  await writeFile(join(spillDirectory, "0".repeat(32), "0.bin"), "stale spill from an earlier run");
  const redaction = new SecretRedactionRegistry();
  const secret = "SPILLED_PRIVATE_VALUE_987654321";
  const old = "only-in-old-history\n" + "old output\n".repeat(30_000) + `old secret ${secret}\n`;
  const tail = "recent recovered output\n";
  let snapshots = [];
  const history = new TerminalOutputHistory(() => redaction.snapshotForWorker(), () => snapshots, { spillDirectory });
  t.after(() => history.close());
  await history.append("recover", old, old.length);
  assert.equal((await history.search("only-in-old-history")).matches.length, 1);
  const files = [];
  for (const owner of await readdir(spillDirectory)) for (const name of await readdir(join(spillDirectory, owner))) files.push(join(spillDirectory, owner, name));
  assert.ok(files.length >= 1, "the history was spilled");
  for (const file of files) {
    const bytes = await readFile(file);
    assert.equal(bytes.includes("only-in-old-history"), false, "spilled output is encrypted");
    assert.equal(bytes.includes("stale spill"), false, "a fresh start wiped the earlier run's spill");
  }

  // The host still has the newest output in its ring; the worker dies before seeing it.
  snapshots = [{ sessionId: "recover", buffer: tail, outputOffset: old.length + tail.length }];
  const crashed = history.worker;
  await new Promise(resolve => { crashed.once("exit", resolve); crashed.kill("SIGKILL"); });
  redaction.add("vault", [secret]); // registered after the output was spilled
  const recovered = await history.search("only-in-old-history", ["recover"]);
  assert.equal(recovered.matches.length, 1, "older history survives the crash");
  assert.deepEqual(recovered.prunedSessionIds, [], "nothing was lost between the spill and the host's ring");
  assert.equal((await history.search("recent recovered", ["recover"])).matches.length, 1);
  const masked = await history.search("old secret", ["recover"]);
  assert.equal(masked.matches[0].text, "old secret <redacted:secret>", "recovered output is masked with the current secrets");
  assert.equal((await history.search("old output", ["recover"])).matches.length, 100);

  // Output the host no longer holds is reported, and marked where it went missing.
  snapshots = [{ sessionId: "recover", buffer: "after the gap\n", outputOffset: old.length + tail.length + 50_000 }];
  const again = history.worker;
  await new Promise(resolve => { again.once("exit", resolve); again.kill("SIGKILL"); });
  const gap = await history.search("after the gap", ["recover"]);
  assert.deepEqual(gap.prunedSessionIds, ["recover"]);
  const context = await history.readContext("recover", gap.matches[0].offset);
  assert.match(context.text, /output is missing here\]\nafter the gap/u);
  assert.equal((await history.search("only-in-old-history", ["recover"])).matches.length, 1);

  await history.close();
  assert.equal(await readdir(spillDirectory).then(() => true, () => false), false, "closing deletes the spill");
});
