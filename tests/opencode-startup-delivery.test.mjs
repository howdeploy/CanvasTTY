import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { OpenCodeStartupReadiness, waitsForOpenCodeStartup } from "../src/main/services/openCodeInput.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const STARTING = "\x1b[?1049h\x1b[?2004h\x1b[?25l";
const READY = `${STARTING}\x1b[?25h`;
const POSIX = { skip: !waitsForOpenCodeStartup("opencode") ? "Native startup cursor gate is macOS/Linux only" : false };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture(t) {
  const calls = [], writes = [];
  const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, true,
    fakeSpawner(calls, { onWrite: data => writes.push(data) }));
  t.after(() => manager.disposeAll());
  const child = manager.create({ provider: "opencode", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } });
  return { manager, child, calls, writes, emit: text => calls.at(-1).process.emitData(text) };
}
const send = (f, text = "TASK\r", wait = 200, signal) => f.manager.deliverInput(f.child.id, text, wait, signal);

test("OpenCode startup parser handles every chunk cut and alternate-screen mode, never plain screen text", () => {
  for (const mode of [1049, 1047, 47]) {
    const output = `\x1b[?${mode}h\x1b[?2004h\x1b[?25lAsk anything\x1b[?25h`;
    for (let cut = 0; cut <= output.length; cut++) {
      const parser = new OpenCodeStartupReadiness();
      parser.push(output.slice(0, cut)); parser.push(output.slice(cut));
      assert.equal(parser.ready, true, `mode ${mode}, cut ${cut}`);
    }
  }
  const parser = new OpenCodeStartupReadiness();
  assert.equal(parser.push("\x1b[?25hAsk anything"), false, "cursor before alternate screen is not readiness");
  assert.equal(parser.push(STARTING), false);
  assert.equal(parser.push("\x1b[?1049l\x1b[?25h"), false, "cursor after leaving alternate screen does not count");
  assert.equal(parser.push("\x1b[?1049;25h"), true);
  const bounded = new OpenCodeStartupReadiness();
  bounded.push(`\x1b[?${"1".repeat(10000)}`);
  assert.equal(bounded.push("049h\x1b[?25h"), false, "an oversized incomplete mode cannot grow carry or release input");
  assert.equal(waitsForOpenCodeStartup("opencode", "win32"), false);
  assert.equal(waitsForOpenCodeStartup("opencode", "darwin"), true);
  assert.equal(waitsForOpenCodeStartup("claude", "linux"), false);
});

test("OpenCode PTY and lifecycle idle are insufficient; ordered sends wait for its native startup cursor", POSIX, async t => {
  const f = fixture(t), first = send(f, "FIRST\r"), second = send(f, "SECOND\r");
  assert.equal(f.manager.startupReady(f.child.id), false);
  f.emit("\x1b[?25hAsk anything"); f.emit(STARTING);
  f.manager.applyProviderSignal(f.child.id, { kind: "lifecycle", state: "idle", event: "session.created" });
  await tick(); assert.deepEqual(f.writes, []);
  f.emit("\x1b[?2"); await tick(); assert.deepEqual(f.writes, []);
  f.emit("5h");
  assert.deepEqual(await Promise.all([first, second]), [{ delivered: true }, { delivered: true }]);
  assert.equal(f.manager.startupReady(f.child.id), true);
  assert.deepEqual(f.writes, ["FIRST\r", "SECOND\r"]);
});

test("OpenCode unsupported cursor output times out without a write or a later replay", POSIX, async t => {
  const f = fixture(t); f.emit("Ask anything\x1b[?25h");
  const result = await send(f, "NEVER\r", 25);
  assert.equal(result.delivered, false); assert.match(result.reason, /startup input cursor.*nothing was written.*unsupported/u);
  f.emit(READY); await tick(); assert.deepEqual(f.writes, []);
});

test("OpenCode zero-wait input fails immediately during startup, then succeeds without waiting once ready", POSIX, async t => {
  const f = fixture(t);
  assert.equal((await send(f, "DO_NOT_QUEUE\r", 0)).delivered, false);
  const waiting = send(f, "FIRST\r");
  assert.equal((await send(f, "DO_NOT_QUEUE_EITHER\r", 0)).delivered, false);
  f.emit(READY); assert.equal((await waiting).delivered, true);
  assert.equal((await send(f, "READY\r", 0)).delivered, true);
  assert.deepEqual(f.writes, ["FIRST\r", "READY\r"]);
});

test("OpenCode queue time and cancellation stay bounded while its first send waits for startup", POSIX, async t => {
  const f = fixture(t), abort = new AbortController();
  const first = send(f, "FIRST\r"), timed = send(f, "TIMED\r", 20), cancelled = send(f, "CANCELLED\r", 200, abort.signal);
  abort.abort(); assert.equal((await cancelled).delivered, false);
  assert.equal((await timed).delivered, false);
  f.emit(READY); assert.equal((await first).delivered, true);
  await tick(); assert.deepEqual(f.writes, ["FIRST\r"]);
});

test("OpenCode startup wait wakes on close or exit and cancellation writes nothing", POSIX, async t => {
  for (const action of [f => f.manager.dispose(f.child.id), f => f.calls.at(-1).process.emitExit(1)]) {
    const f = fixture(t), pending = send(f, "NEVER\r", 2000);
    await tick(); action(f);
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("did not wake"), 200))]);
    assert.notEqual(result, "did not wake"); assert.equal(result.delivered, false); assert.deepEqual(f.writes, []);
  }
  const f = fixture(t), abort = new AbortController(), pending = send(f, "NEVER\r", 200, abort.signal);
  await tick(); abort.abort(); assert.equal((await pending).delivered, false);
  f.emit(READY); await tick(); assert.deepEqual(f.writes, []);
});

test("OpenCode restart resets ready state and cannot deliver an old launch's queued prompt", POSIX, async t => {
  const f = fixture(t); f.emit(READY); assert.equal(f.manager.startupReady(f.child.id), true);
  f.calls.at(-1).process.emitExit(0); f.manager.restart(f.child.id);
  assert.equal(f.manager.startupReady(f.child.id), false);
  const pending = send(f, "OLD\r"); await tick(); assert.deepEqual(f.writes, []);
  f.calls.at(-1).process.emitExit(0); f.manager.restart(f.child.id); f.emit(READY);
  assert.equal((await pending).delivered, false);
  assert.equal((await send(f, "CURRENT\r")).delivered, true);
  assert.deepEqual(f.writes, ["CURRENT\r"]);
});
