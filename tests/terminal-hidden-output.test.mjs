import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager, reachesObservers, reachesRenderer } from "../src/main/services/TerminalManager.ts";
import { IPC } from "../src/shared/contracts.ts";
import { attachTerminalOutput } from "../src/renderer/src/features/terminal/terminalOutput.ts";

// A card hidden by the renderer (semantic summary mode) stops rendering, but
// the main process also feeds every manager event to in-process observers:
// the agent-control gateway and the Even G2 presentation keep a headless
// screen per session. Those must follow the PTY while the card is hidden, or
// the CLI screen, composer readiness and menu selection go stale until the
// card is shown again. Only the renderer's delivery is gated, and it still
// gets exactly one replay when the card comes back.

const MAX_SCROLLBACK_CHARS = 240_000;
const availableRegistry = {
  get: (provider) => ({ state: "available", provider, executable: "/resolved/codex", launcher: "native", environment: {}, checked: [] })
};

const APPROVAL_MENU = "\x1b[2J\x1b[HHooks need review\r\n› 1. Review hooks\r\n  2. Trust all and continue\r\nPress enter to confirm or esc to cancel";

/**
 * Mirrors the emit callback in src/main/index.ts: every event is offered to
 * the observers and to the renderer, and the payload says who gets it.
 */
function createManager(t) {
  const emitted = [];
  const observed = [];
  const rendered = [];
  const rendererListeners = new Set();
  let emitData;
  let exit;
  const manager = new TerminalManager((channel, event) => {
    if (channel !== IPC.terminalData) return;
    emitted.push(event);
    if (reachesObservers(event)) observed.push(event);
    if (reachesRenderer(event)) {
      rendered.push(event);
      for (const listener of rendererListeners) listener(event);
    }
  }, availableRegistry, undefined, undefined, true, () => ({
    pid: 10000, process: "codex", kill() {}, write() {}, resize() {},
    onData(listener) { emitData = listener; return { dispose() {} }; },
    onExit(listener) { exit = listener; return { dispose() {} }; }
  }));
  t.after(() => manager.disposeAll());
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const flush = () => manager.flushOutput(id, manager.sessions.get(id));
  const rendererApi = {
    onData(listener) { rendererListeners.add(listener); return () => rendererListeners.delete(listener); },
    readBuffer() { return Promise.resolve(manager.readBuffer(id)); }
  };
  return { manager, id, emitted, observed, rendered, rendererApi, data: (chunk) => emitData(chunk), exit: (code) => exit(code), flush };
}

/**
 * What an observer's headless terminal would have written: the same absolute
 * offset dedup AgentControlGateway.observe and TerminalPresentation.observe
 * apply to the stream they are handed.
 */
function observerScreen(events) {
  let offset = 0;
  let screen = "";
  for (const event of events) {
    const overlap = Math.max(0, offset - (event.outputOffset - event.data.length));
    screen += event.data.slice(overlap);
    offset = Math.max(offset, event.outputOffset);
  }
  return screen;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("output produced while hidden reaches the observers at once, and history matches", (t) => {
  const { manager, id, observed, rendered, data, flush } = createManager(t);

  data("initial screen\r\n");
  flush();
  assert.deepEqual(observed.map((event) => event.data), ["initial screen\r\n"]);
  assert.deepEqual(rendered.map((event) => event.data), ["initial screen\r\n"]);

  manager.setVisible(id, false);
  data(APPROVAL_MENU);
  flush();

  assert.equal(observed.length, 2, "the hidden chunk reaches the observer stream");
  assert.equal(observed[1].data, APPROVAL_MENU, "with the new screen, not the stale one");
  assert.equal(observed[1].audience, "observers", "and is addressed to the observers alone");
  assert.equal(observed[1].outputOffset, "initial screen\r\n".length + APPROVAL_MENU.length);
  assert.equal(manager.readBuffer(id).buffer, "initial screen\r\n" + APPROVAL_MENU, "history stays canonical");
  assert.equal(observerScreen(observed), manager.readBuffer(id).buffer, "an observer's screen equals the history");
  assert.equal(rendered.length, 1, "the renderer is not streamed while hidden");
});

test("hidden output reaches the observers on the batch timer without any visibility change", async (t) => {
  const { manager, id, observed, rendered, data } = createManager(t);

  manager.setVisible(id, false);
  data(APPROVAL_MENU);
  assert.equal(observed.length, 0, "the batch is still pending");
  // OUTPUT_BATCH_MS is 16; the ordinary flush timer delivers to the observers.
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(observed.map((event) => event.data), [APPROVAL_MENU]);
  assert.equal(rendered.length, 0);
});

test("the renderer gets nothing while hidden, then exactly one replay, and writes each byte once", async (t) => {
  const { manager, id, observed, rendered, rendererApi, data, flush } = createManager(t);
  const written = [];
  const detach = attachTerminalOutput(rendererApi, id, (chunk) => written.push(chunk), assert.fail, () => {
    throw new Error("unexpected replay gap in a sub-limit stretch");
  });
  t.after(detach);

  data("first\r\n");
  flush();
  await settle();
  manager.setVisible(id, false);
  data("hidden one\r\n");
  flush();
  data("hidden two\r\n");
  flush();
  assert.equal(rendered.length, 1, "no renderer delivery while hidden");
  assert.equal(observed.length, 3, "every hidden batch reached the observers");

  manager.setVisible(id, true);
  await settle();

  assert.equal(rendered.length, 2, "becoming visible delivers exactly one replay to the renderer");
  const replay = rendered[1];
  assert.equal(replay.audience, "renderer");
  assert.equal(replay.data, "first\r\nhidden one\r\nhidden two\r\n", "the replay is the current buffer, not stale content");
  assert.equal(replay.outputOffset, manager.readBuffer(id).outputOffset, "the replay carries the current absolute offset");
  assert.equal(written.join(""), "first\r\nhidden one\r\nhidden two\r\n", "the real renderer dedup writes the hidden stretch once");

  // Steady state afterwards: live output reaches everyone again, once.
  data("after\r\n");
  flush();
  assert.equal(rendered.at(-1).data, "after\r\n");
  assert.equal(rendered.at(-1).audience, undefined);
  assert.equal(observed.at(-1).data, "after\r\n");
  await settle();
  assert.equal(written.join(""), "first\r\nhidden one\r\nhidden two\r\nafter\r\n");
});

test("the observers receive no duplicate of the replayed chunk", (t) => {
  const { manager, id, emitted, observed, data, flush } = createManager(t);

  data("first\r\n");
  flush();
  manager.setVisible(id, false);
  data("hidden\r\n");
  flush();
  const observedBeforeReplay = observed.length;

  manager.setVisible(id, true);

  assert.equal(emitted.length, observedBeforeReplay + 1, "the replay was emitted");
  assert.equal(observed.length, observedBeforeReplay, "but not to the observers");
  assert.ok(observed.every((event) => event.audience !== "renderer"));
  assert.equal(observerScreen(observed), "first\r\nhidden\r\n", "the observers saw the whole stream exactly once");
});

test("a batch still pending when the card is shown goes to the observers before the renderer replay", (t) => {
  const { manager, id, emitted, observed, rendered, data, flush } = createManager(t);

  data("first\r\n");
  flush();
  manager.setVisible(id, false);
  data("pending\r\n");
  assert.equal(emitted.length, 1, "the hidden batch is still on its timer");

  manager.setVisible(id, true);

  assert.deepEqual(emitted.slice(1).map((event) => [event.audience, event.data]), [
    ["observers", "pending\r\n"],
    ["renderer", "first\r\npending\r\n"]
  ], "the observers get the batch, the renderer gets the replay, in that order");
  assert.equal(observerScreen(observed), "first\r\npending\r\n");
  assert.equal(rendered.length, 2);
  // The timer that would have flushed the same batch must not fire a duplicate.
  flush();
  assert.equal(emitted.length, 3);
});

test("an exit while hidden still hands the observers the last output", (t) => {
  const { manager, id, observed, rendered, data, exit } = createManager(t);

  manager.setVisible(id, false);
  data("last words\r\n");
  exit({ exitCode: 0, signal: 0 });

  assert.deepEqual(observed.map((event) => event.data), ["last words\r\n"]);
  assert.equal(observed[0].audience, "observers");
  assert.equal(rendered.length, 0);
  assert.equal(manager.readBuffer(id).buffer, "last words\r\n");
});

test("a hidden stretch longer than the ring reaches the observers whole while the renderer replay stays marked as truncated", async (t) => {
  const { manager, id, observed, rendered, rendererApi, data, flush } = createManager(t);
  const written = [];
  const detach = attachTerminalOutput(rendererApi, id, (chunk) => written.push(chunk), assert.fail,
    (missing) => `[CanvasTTY] ${missing} characters of output produced while this window was hidden are no longer available`);
  t.after(detach);

  const visible = "V".repeat(1_000);
  data(visible);
  flush();
  await settle();
  assert.deepEqual(written, [visible]);

  manager.setVisible(id, false);
  // 300 011 code units while hidden: 60 011 more than the ring retains.
  const dropped = "D".repeat(60_011);
  const retained = "R".repeat(MAX_SCROLLBACK_CHARS);
  data(dropped + retained);
  flush();

  assert.equal(observerScreen(observed), visible + dropped + retained, "the observers received the full stream, including what the ring dropped");
  assert.deepEqual(written, [visible], "hidden output is not streamed to the renderer");
  assert.equal(manager.readBuffer(id).buffer, retained, "the ring holds the tail and only the tail");

  manager.setVisible(id, true);
  await settle();

  assert.equal(rendered.length, 2, "one replay");
  assert.equal(rendered[1].audience, "renderer");
  assert.equal(rendered[1].data, retained);
  assert.equal(written.length, 3, "the replay is one bounded notice plus the retained window");
  const [notice, replay] = written.slice(1);
  assert.equal(replay, retained);
  assert.ok(notice.includes("60011"), "the notice states exactly how much output is missing");
  assert.equal(written.join("").includes("D"), false, "the dropped head is never written as if it had arrived");
  assert.equal(observerScreen(observed), visible + dropped + retained, "the replay added nothing to the observers");
});

test("session and removal events reach both the observers and the renderer", () => {
  const session = { session: { id: "s" } };
  const removed = { id: "s" };
  const live = { id: "s", data: "x", outputOffset: 1 };
  for (const payload of [session, removed, live]) {
    assert.equal(reachesObservers(payload), true);
    assert.equal(reachesRenderer(payload), true);
  }
  assert.equal(reachesObservers({ ...live, audience: "renderer" }), false);
  assert.equal(reachesRenderer({ ...live, audience: "renderer" }), true);
  assert.equal(reachesObservers({ ...live, audience: "observers" }), true);
  assert.equal(reachesRenderer({ ...live, audience: "observers" }), false);
});
