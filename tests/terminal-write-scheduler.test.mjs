import assert from "node:assert/strict";
import test from "node:test";
import { TerminalWriteScheduler } from "../src/renderer/src/features/terminal/terminalWriteScheduler.ts";

function fixture() {
  const tasks = [];
  const queue = new TerminalWriteScheduler((task) => tasks.push(task));
  const step = () => { assert.equal(tasks.length, 1); tasks.shift()(); };
  return { queue, tasks, step };
}

test("six flooding terminals take turns in bounded slices and acknowledge only fully parsed output", () => {
  const f = fixture();
  const writes = [];
  const credits = [];
  const output = Array.from({ length: 6 }, () => "");
  const text = "x".repeat(8_191) + "🐈\x1b[31m" + "z".repeat(20_000);
  const writers = output.map((_, id) => f.queue.create((data, parsed) => writes.push({ id, data, parsed }), assert.fail));
  writers.forEach((writer, id) => writer.write(text, () => credits.push(id)));
  for (let i = 0; f.tasks.length; i++) {
    assert.ok(i < 100, "all output completes");
    f.step();
    const write = writes.at(-1);
    assert.ok(write.data.length <= 8_192);
    assert.doesNotMatch(write.data, /[\uD800-\uDBFF]$/u, "no UTF-16 pair is split");
    output[write.id] += write.data;
    assert.ok(output[write.id].length <= text.length);
    assert.equal(credits.includes(write.id), false, "credit waits for the parser callback");
    write.parsed();
  }
  assert.deepEqual(writes.slice(0, 6).map(({ id }) => id), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(output, Array(6).fill(text));
  assert.deepEqual(credits, [0, 1, 2, 3, 4, 5]);
});

test("a small reply is delivered before a flood finishes, and one card keeps FIFO callback order", () => {
  const f = fixture();
  const writes = [];
  const credits = [];
  const flood = f.queue.create((data, parsed) => writes.push({ id: "flood", data, parsed }), assert.fail);
  const reply = f.queue.create((data, parsed) => writes.push({ id: "reply", data, parsed }), assert.fail);
  flood.write("x".repeat(30_000), () => credits.push("flood"));
  f.step();
  reply.write("first", () => credits.push("first"));
  reply.write(" second", () => credits.push("second"));
  writes[0].parsed();
  f.step();
  assert.equal(writes[1].id, "reply");
  assert.equal(writes[1].data, "first second");
  assert.deepEqual(credits, []);
  writes[1].parsed();
  assert.deepEqual(credits, ["first", "second"]);
});

test("an unfinished parser blocks only its own next slice, including newly arriving output", () => {
  const f = fixture();
  const writes = [];
  const credits = [];
  const slow = f.queue.create((data, parsed) => writes.push({ data, parsed }), assert.fail);
  const live = f.queue.create((data, parsed) => { credits.push(data); parsed(); }, assert.fail);
  slow.write("x".repeat(9_000), () => credits.push("slow"));
  live.write("live");
  f.step();
  slow.write("tail", () => credits.push("tail"));
  f.step();
  assert.deepEqual(credits, ["live"], "the other card finishes while the slow parser is still pending");
  assert.equal(writes.length, 1, "one card never has two outstanding slices");
  assert.equal(f.tasks.length, 0, "waiting for a parser does not spin the task queue");
  writes[0].parsed();
  writes[0].parsed();
  f.step();
  assert.equal(writes[1].data, "x".repeat(808) + "tail");
  writes[1].parsed();
  assert.deepEqual(credits, ["live", "slow", "tail"]);
  assert.equal(f.tasks.length, 0);
});

test("disposing a card releases an outstanding parse and ignores its late callback", () => {
  const f = fixture();
  let late;
  const writes = [];
  const credits = [];
  const closed = f.queue.create((_, parsed) => { late = parsed; }, assert.fail);
  const live = f.queue.create((data, parsed) => { writes.push(data); parsed(); }, assert.fail);
  closed.write("x".repeat(20_000), () => credits.push("closed"));
  live.write("live", () => credits.push("live"));
  f.step();
  closed.dispose();
  f.step();
  late();
  closed.write("late");
  assert.deepEqual(writes, ["live"]);
  assert.deepEqual(credits, ["live"]);
  assert.equal(f.tasks.length, 0);
});

test("a failed writer neither grants credit for lost output nor stops other cards", () => {
  const f = fixture();
  const errors = [];
  const credits = [];
  const failed = f.queue.create(() => { throw new Error("parser unavailable"); }, (error) => errors.push(error.message));
  const live = f.queue.create((_, parsed) => parsed(), assert.fail);
  failed.write("failed", () => credits.push("failed"));
  live.write("live", () => credits.push("live"));
  f.step();
  f.step();
  assert.deepEqual(errors, ["parser unavailable"]);
  assert.deepEqual(credits, ["live"]);
  assert.equal(f.tasks.length, 0);
});
