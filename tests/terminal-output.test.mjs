import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { IPC } from "../src/shared/contracts.ts";
import { attachTerminalOutput } from "../src/renderer/src/features/terminal/terminalOutput.ts";

test("snapshot and batched live output join exactly once across startup, trimming and restart", async (t) => {
  const listeners = new Set();
  let data;
  let exit;
  const manager = new TerminalManager((channel, event) => {
    if (channel === IPC.terminalData) for (const listener of listeners) listener(event);
  }, {
    get: (provider) => ({ state: "available", provider, executable: "/resolved/codex", launcher: "native", environment: {}, checked: [] })
  }, undefined, undefined, true, () => ({
    pid: 10000, process: "codex", kill() {}, write() {}, resize() {},
    onData(listener) { data = listener; return { dispose() {} }; },
    onExit(listener) { exit = listener; return { dispose() {} }; }
  }));
  t.after(() => manager.disposeAll());
  const { id } = manager.create({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  const api = {
    onData(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async readBuffer() { return manager.readBuffer(id); }
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  // This output is already flushed before the card subscribes. A stale create/list
  // response cannot recover it; the fresh read after subscribing must do so.
  data("before subscription\r\n");
  manager.flushOutput(id, manager.sessions.get(id));
  data("inside snapshot\r\n");
  const written = [];
  let releaseSnapshot;
  const detach = attachTerminalOutput({
    ...api,
    readBuffer() {
      assert.equal(listeners.size, 1);
      const snapshot = manager.readBuffer(id);
      return new Promise((resolve) => { releaseSnapshot = () => resolve(snapshot); });
    }
  }, id, (chunk) => written.push(chunk), assert.fail);
  t.after(detach);

  // One live batch straddles the snapshot, arriving before its delayed reply.
  data("after snapshot 🐈\r\n");
  manager.flushOutput(id, manager.sessions.get(id));
  assert.equal(written.length, 0);
  releaseSnapshot();
  await tick();
  assert.equal(written.join(""), "before subscription\r\ninside snapshot\r\nafter snapshot 🐈\r\n");

  const beforeRestart = manager.readBuffer(id).outputOffset;
  exit({ exitCode: 0, signal: 0 });
  manager.restart(id);
  data("restarted\r\n");
  manager.flushOutput(id, manager.sessions.get(id));
  assert.equal(manager.readBuffer(id).outputOffset, beforeRestart + "restarted\r\n".length);
  assert.equal(written.join(""), "before subscription\r\ninside snapshot\r\nafter snapshot 🐈\r\nrestarted\r\n");
  detach();

  // The retained suffix is shorter than the absolute offset. A pending batch
  // containing trimmed data must not restore that data or duplicate the suffix.
  data("x".repeat(250_000));
  const snapshot = manager.readBuffer(id);
  assert.equal(snapshot.buffer.length, 240_000);
  assert.ok(snapshot.outputOffset > snapshot.buffer.length);
  const replay = [];
  const detachReplay = attachTerminalOutput(api, id, (chunk) => replay.push(chunk), assert.fail);
  t.after(detachReplay);
  await tick();
  manager.flushOutput(id, manager.sessions.get(id));
  data("tail");
  manager.flushOutput(id, manager.sessions.get(id));
  assert.equal(replay.join(""), snapshot.buffer + "tail");
});

test("unmount or a failed snapshot releases the subscription and never writes a late reply", async () => {
  for (const fail of [false, true]) {
    let listener;
    let unsubscribed = 0;
    let errors = 0;
    const written = [];
    const pending = Promise.withResolvers();
    const dispose = attachTerminalOutput({
      onData(callback) { listener = callback; return () => { unsubscribed++; }; },
      readBuffer: () => pending.promise
    }, "id", (chunk) => written.push(chunk), () => { errors++; });
    listener({ id: "id", data: "pending", outputOffset: 7 });
    if (fail) pending.reject(new Error("snapshot unavailable"));
    else {
      dispose();
      pending.resolve({ buffer: "pending", outputOffset: 7 });
    }
    await new Promise((resolve) => setImmediate(resolve));
    listener({ id: "id", data: "late", outputOffset: 11 });
    assert.deepEqual(written, []);
    assert.equal(unsubscribed, 1);
    assert.equal(errors, fail ? 1 : 0);
  }
});
