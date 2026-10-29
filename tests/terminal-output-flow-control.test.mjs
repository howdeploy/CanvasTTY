import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager, MAX_UNPARSED_OUTPUT_CHARS, reachesRenderer } from "../src/main/services/TerminalManager.ts";
import { TerminalRendererOutbox } from "../src/main/services/TerminalRendererOutbox.ts";
import { TerminalDataRouter } from "../src/shared/terminalDataRouter.ts";
import { IPC } from "../src/shared/contracts.ts";
import { attachTerminalOutput } from "../src/renderer/src/features/terminal/terminalOutput.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));

for (const hidden of [false, true]) test(`bounds the entire output pipeline until xterm parses it (card hidden=${hidden})`, async (t) => {
  const calls = [];
  const router = new TerminalDataRouter();
  const outbox = new TerminalRendererOutbox((channel, payload) => {
    if (channel === IPC.terminalDataBatch) for (const event of payload) router.dispatch(event);
  });
  const manager = new TerminalManager((channel, payload) => {
    if (reachesRenderer(payload)) outbox.push(channel, payload);
  }, availableRegistry(), undefined, undefined, false, fakeSpawner(calls), "darwin");
  t.after(() => manager.disposeAll());
  const { id } = manager.create({ provider: "terminal", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const terminalPty = calls[0].process;
  let paused = false;
  let pauses = 0;
  terminalPty.pause = () => { paused = true; pauses++; };
  terminalPty.resume = () => { paused = false; };
  const pendingParses = [];
  let received = 0;
  let parsed = 0;
  let maxPending = 0;
  const detach = attachTerminalOutput({
    onData: (listener, sessionId) => router.subscribe(listener, sessionId),
    readBuffer: async () => manager.readBuffer(id),
    acknowledgeOutput: (sessionId, offset) => manager.acknowledgeOutput(sessionId, offset)
  }, id, (data, done) => {
    received += data.length;
    maxPending = Math.max(maxPending, received - parsed);
    pendingParses.push(() => { parsed += data.length; done?.(); });
  }, assert.fail, () => { throw new Error("output must have no gap"); });
  t.after(detach);
  await tick();
  if (hidden) manager.setVisible(id, false);
  const chunk = "x".repeat(65_536);
  const total = 4 * MAX_UNPARSED_OUTPUT_CHARS;
  let produced = 0;
  while (produced < total) {
    while (!paused && produced < total) { terminalPty.emitData(chunk); produced += chunk.length; }
    outbox.flush();
    assert.ok(produced - parsed <= MAX_UNPARSED_OUTPUT_CHARS, "IPC plus xterm plus manager remain bounded together");
    assert.ok(pendingParses.length > 0, "a paused producer has output that can grant credit");
    for (const parse of pendingParses.splice(0)) parse();
  }
  if (hidden) manager.setVisible(id, true);
  manager.flushOutput(id, manager.sessions.get(id));
  outbox.flush();
  for (const parse of pendingParses.splice(0)) parse();
  assert.equal(received, total, "no dropping or ring trimming in the renderer stream");
  assert.equal(parsed, total);
  assert.ok(pauses >= 4, "backpressure repeatedly reaches the producer");
  assert.ok(maxPending <= MAX_UNPARSED_OUTPUT_CHARS);
});

test("only a valid parsed offset can resume its PTY; all platforms share the same flow control", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const calls = [];
    const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, false, fakeSpawner(calls), platform);
    const { id } = manager.create({ provider: "terminal", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
    let paused = 0;
    let resumed = 0;
    calls[0].process.pause = () => { paused++; };
    calls[0].process.resume = () => { resumed++; };
    calls[0].process.emitData("x".repeat(MAX_UNPARSED_OUTPUT_CHARS));
    assert.equal(paused, 1);
    for (const offset of [-1, NaN, Infinity, 1.5, MAX_UNPARSED_OUTPUT_CHARS + 1]) manager.acknowledgeOutput(id, offset);
    manager.acknowledgeOutput("different-card", MAX_UNPARSED_OUTPUT_CHARS);
    manager.acknowledgeOutput(id, 1);
    assert.equal(resumed, 0);
    manager.acknowledgeOutput(id, MAX_UNPARSED_OUTPUT_CHARS);
    assert.equal(resumed, 1);
    manager.disposeAll();
  }
});

test("snapshot and live credit wait for parser callbacks, and disposed callbacks grant no credit", async () => {
  const writes = [];
  const credits = [];
  let live;
  const detach = attachTerminalOutput({
    onData(listener) { live = listener; return () => {}; },
    readBuffer: async () => ({ restorePrefix: "prefix", buffer: "history", outputOffset: 100 }),
    acknowledgeOutput: (id, offset) => credits.push([id, offset])
  }, "id", (data, done) => writes.push({ data, done }), assert.fail);
  await tick();
  live({ id: "id", data: "live", outputOffset: 104 });
  assert.deepEqual(credits, []);
  assert.equal(writes[0].done, undefined, "synthetic parser state cannot grant output credit");
  writes[1].done();
  assert.deepEqual(credits, [["id", 100]]);
  detach();
  writes[2].done();
  assert.deepEqual(credits, [["id", 100]]);
});
