import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager, reachesRenderer } from "../src/main/services/TerminalManager.ts";
import { IPC } from "../src/shared/contracts.ts";
import { attachTerminalOutput } from "../src/renderer/src/features/terminal/terminalOutput.ts";

const availableRegistry = {
  get: (provider) => ({ state: "available", provider, executable: "/resolved/codex", launcher: "native", environment: {}, checked: [] })
};

// `emitted` is what the renderer receives: the emit callback applies the same
// routing as src/main/index.ts, where output produced while the card is hidden
// is addressed to the in-process observers only (tests/terminal-hidden-output.test.mjs
// covers that side).
function createManager(t) {
  const emitted = [];
  let emitData;
  let exit;
  const manager = new TerminalManager((channel, event) => {
    if (channel === IPC.terminalData && reachesRenderer(event)) emitted.push(event);
  }, availableRegistry, undefined, undefined, true, () => ({
    pid: 10000, process: "codex", kill() {}, write() {}, resize() {},
    onData(listener) { emitData = listener; return { dispose() {} }; },
    onExit(listener) { exit = listener; return { dispose() {} }; }
  }));
  t.after(() => manager.disposeAll());
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const flush = () => manager.flushOutput(id, manager.sessions.get(id));
  return { manager, id, emitted, data: (chunk) => emitData(chunk), exit, flush };
}

test("a hidden session keeps history but stops streaming, then replays exactly the missed suffix", (t) => {
  const { manager, id, emitted, data, flush } = createManager(t);

  data("visible\r\n");
  flush();
  assert.deepEqual(emitted.map((event) => event.data), ["visible\r\n"]);
  const visibleOffset = emitted[0].outputOffset;
  assert.equal(visibleOffset, "visible\r\n".length);

  manager.setVisible(id, false);
  assert.equal(emitted.length, 1, "hiding must not emit on its own");

  data("hidden\r\n");
  flush();
  assert.equal(emitted.length, 1, "hidden output must not reach the renderer");
  const snapshot = manager.readBuffer(id);
  assert.equal(snapshot.buffer, "visible\r\nhidden\r\n", "history stays canonical while hidden");
  assert.equal(snapshot.outputOffset, visibleOffset + "hidden\r\n".length);

  manager.setVisible(id, true);
  assert.equal(emitted.length, 2, "becoming visible replays the current buffer once");
  const replay = emitted[1];
  assert.equal(replay.data, "visible\r\nhidden\r\n");
  assert.equal(replay.outputOffset, snapshot.outputOffset, "the replay carries the current absolute offset");
  // The renderer slices from its own offset, so the event must cover the whole
  // hidden stretch and start at or before everything the card already wrote.
  assert.ok(replay.outputOffset - replay.data.length <= visibleOffset);
});

test("hiding a session flushes the pending batch instead of dropping it", (t) => {
  const { manager, id, emitted, data, flush } = createManager(t);

  // queueOutput batches for OUTPUT_BATCH_MS; this chunk is queued and unflushed
  // when visibility flips.
  data("queued\r\n");
  assert.equal(emitted.length, 0);

  manager.setVisible(id, false);
  assert.deepEqual(emitted.map((event) => event.data), ["queued\r\n"], "the pending batch is delivered, not stranded");
  assert.equal(emitted[0].outputOffset, "queued\r\n".length);

  // The timer that would have flushed the same batch must not fire a duplicate.
  flush();
  assert.equal(emitted.length, 1);
});

test("becoming visible with no new output emits nothing", (t) => {
  const { manager, id, emitted, data, flush } = createManager(t);

  data("seen\r\n");
  flush();
  manager.setVisible(id, false);
  manager.setVisible(id, true);
  assert.equal(emitted.length, 1);

  // Repeated reports are idempotent, and a removal clears the visibility.
  manager.setVisible(id, true);
  assert.equal(emitted.length, 1);
  manager.dispose(id);
  manager.setVisible(id, true);
  assert.equal(emitted.length, 1, "a disposed session cannot be replayed");
});

test("an exit while hidden sends the renderer no terminalData for the hidden stretch", (t) => {
  const { manager, id, emitted, data, exit } = createManager(t);

  manager.setVisible(id, false);
  data("last words\r\n");
  exit({ exitCode: 0, signal: 0 });
  assert.equal(emitted.length, 0);
  assert.equal(manager.readBuffer(id).buffer, "last words\r\n");
});

test("the real renderer dedup writes the hidden stretch exactly once", async (t) => {
  const listeners = new Set();
  let emitData;
  const manager = new TerminalManager((channel, event) => {
    if (channel === IPC.terminalData && reachesRenderer(event)) for (const listener of listeners) listener(event);
  }, availableRegistry, undefined, undefined, true, () => ({
    pid: 10000, process: "codex", kill() {}, write() {}, resize() {},
    onData(listener) { emitData = listener; return { dispose() {} }; },
    onExit() { return { dispose() {} }; }
  }));
  t.after(() => manager.disposeAll());
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const flush = () => manager.flushOutput(id, manager.sessions.get(id));
  const written = [];
  const detach = attachTerminalOutput({
    onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    readBuffer() { return Promise.resolve(manager.readBuffer(id)); }
  }, id, (chunk) => written.push(chunk), assert.fail, () => {
    // This stretch fits the ring, so a gap here means the dedup invented one.
    throw new Error("unexpected replay gap in a sub-limit stretch");
  });
  t.after(detach);

  emitData("first\r\n");
  flush();
  manager.setVisible(id, false);
  emitData("hidden one\r\n");
  flush();
  manager.setVisible(id, true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.join(""), "first\r\nhidden one\r\n", "no gap and no duplicate across the hidden window");
});

// The scrollback ring is a memory bound and stays one. A hidden stretch longer
// than it can therefore only be replayed as a window that starts after the
// card's last offset; that hole has to be marked, because a trimmed replay
// stitched straight onto older output reads as gapless and silently invents
// continuity the session never had.
const MAX_SCROLLBACK_CHARS = 240_000;

test("a replay longer than the scrollback ring is marked as truncated, never stitched as contiguous", async (t) => {
  const listeners = new Set();
  let emitData;
  const manager = new TerminalManager((channel, event) => {
    if (channel === IPC.terminalData && reachesRenderer(event)) for (const listener of listeners) listener(event);
  }, availableRegistry, undefined, undefined, true, () => ({
    pid: 10000, process: "codex", kill() {}, write() {}, resize() {},
    onData(listener) { emitData = listener; return { dispose() {} }; },
    onExit() { return { dispose() {} }; }
  }));
  t.after(() => manager.disposeAll());
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const flush = () => manager.flushOutput(id, manager.sessions.get(id));
  const written = [];
  const detach = attachTerminalOutput({
    onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    readBuffer() { return Promise.resolve(manager.readBuffer(id)); }
  }, id, (chunk) => written.push(chunk), assert.fail,
  // The caller owns the wording so the notice follows the app locale (the card passes
  // the localized string); the test passes the same shape and checks it is used verbatim.
  (missing) => `[CanvasTTY] ${missing} characters of output produced while this window was hidden are no longer available`);
  t.after(detach);
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const visible = "V".repeat(1_000);
  emitData(visible);
  flush();
  await settle();
  assert.deepEqual(written, [visible], "the card starts with the visible batch");

  manager.setVisible(id, false);
  // 300 011 code units while hidden: 60 011 more than the ring retains.
  const dropped = "D".repeat(60_011);
  const retained = "R".repeat(MAX_SCROLLBACK_CHARS);
  emitData(dropped + retained);
  flush();
  assert.deepEqual(written, [visible], "hidden output is not streamed");
  const buffered = manager.readBuffer(id);
  assert.equal(buffered.outputOffset, visible.length + dropped.length + retained.length);
  assert.equal(buffered.buffer, retained, "the ring holds the tail and only the tail");

  manager.setVisible(id, true);
  await settle();

  assert.equal(written.length, 3, "the replay is one bounded notice plus the retained window");
  const [notice, replay] = written.slice(1);
  assert.equal(replay, retained, "the tail survives the replay intact");
  assert.equal(notice.includes(dropped), false, "the notice never carries the dropped output");
  assert.equal(written.join("").includes("D"), false, "the dropped head is never written as if it had arrived");
  assert.equal(notice.split("\r\n").filter(Boolean).length, 1, "the notice is one line, not an output dump");
  assert.ok(notice.length < 200, "the notice stays bounded");
  assert.ok(notice.includes("60011"), "the notice states exactly how much output is missing");
  assert.ok(notice.startsWith("\r\n") && notice.endsWith("\r\n"), "the notice owns its own line");
});
