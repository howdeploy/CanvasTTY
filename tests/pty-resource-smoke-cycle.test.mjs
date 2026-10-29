import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Execute only the actual smoke's cycle against pipe-backed/fake terminals.
// The CI-only driver and native addon are never imported; no PTYs are opened.
const source = await readFile(new URL("../scripts/smoke-pty-resources.mjs", import.meta.url), "utf8");
const start = source.indexOf("    async function cycle(stop = false) {");
const end = source.indexOf("\n    // Warm libuv", start);
assert.ok(start >= 0 && end > start);
const cycleSource = source.slice(start, end);

function harness(spawnPty, { budgetMs = 5000 } = {}) {
  const report = { normalExits: 0, stopped: 0 };
  const context = {
    pty: { spawn: spawnPty }, report, process, assert, config: { stdioMask: 0 },
    delay, activeTerminal: undefined,
    setTimeout: (callback, ms) => setTimeout(callback, ms === 5000 ? budgetMs : ms), clearTimeout,
    verifyClosedStdio() {}
  };
  const cycle = runInNewContext(`(${cycleSource})`, context, { timeout: 1000 });
  return { cycle, report, context };
}

test("a normal cycle confirms real command output before exit even when the reader is delayed past the exit-drain budget", {
  skip: process.platform === "win32" ? "The macOS smoke uses a POSIX shell; this fixture opens pipes only." : false
}, async () => {
  const children = [];
  const writes = [];
  const output = [];
  const { cycle, report, context } = harness((command, args, options) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const dataListeners = new Set(), exitListeners = new Set();
    let exit, closed = false, forcedClose;
    // Model node-pty's bounded post-exit drain. The real command runs through
    // ordinary pipes, so the unit test does not allocate the shared PTY pool.
    child.stdout.pause();
    const readerDelay = setTimeout(() => child.stdout.resume(), 120);
    child.stdout.on("data", chunk => { output.push(String(chunk)); for (const listener of dataListeners) listener(String(chunk)); });
    const notifyExit = () => { if (exit && closed) for (const listener of exitListeners) listener(exit); };
    child.stdout.on("close", () => { closed = true; clearTimeout(forcedClose); clearTimeout(readerDelay); notifyExit(); });
    child.once("exit", (code, signal) => {
      exit = { exitCode: code ?? 0, signal };
      if (!closed) forcedClose = setTimeout(() => child.stdout.destroy(), 40);
      notifyExit();
    });
    child.once("error", error => { throw error; });
    return {
      onData(listener) { dataListeners.add(listener); return { dispose() { dataListeners.delete(listener); } }; },
      onExit(listener) { exitListeners.add(listener); return { dispose() { exitListeners.delete(listener); } }; },
      write(text) { writes.push(text); child.stdin.write(text); },
      kill(signal) { child.kill(signal); }
    };
  });
  try {
    await cycle();
    assert.ok(output.join("").includes("PTY_CYCLE_OK"), "read from the actual child stdout");
    assert.deepEqual(writes, ["PTY_CYCLE_ACK\n"], "the child exits only after the marker was read and acknowledged");
    assert.equal(report.normalExits, 1);
    assert.equal(context.activeTerminal, undefined);
  } finally { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); }
});

test("missing command output cannot be replaced by successful exit or echoed ACK text", async () => {
  const writes = [];
  const { cycle, report } = harness(() => ({
    onData(listener) { queueMicrotask(() => listener("PTY_CYCLE_ACK\r\n")); return { dispose() {} }; },
    onExit(listener) { queueMicrotask(() => listener({ exitCode: 0, signal: 0 })); return { dispose() {} }; },
    write(text) { writes.push(text); }, kill() {}
  }));
  await assert.rejects(cycle(), /a completed process must produce the actual command output/u);
  assert.deepEqual(writes, []);
  assert.equal(report.normalExits, 0);
});

test("a child that never produces the marker fails within the existing deadline and cleans up its subscriptions", async () => {
  const signals = [];
  let onExit, disposed = 0;
  const { cycle, report, context } = harness(() => ({
    onData() { return { dispose() { disposed++; } }; },
    onExit(listener) { onExit = listener; return { dispose() { disposed++; } }; },
    write() { assert.fail("no ACK without actual output"); },
    kill(signal) { signals.push(signal); onExit({ exitCode: 137, signal: 9 }); }
  }), { budgetMs: 20 });
  await assert.rejects(cycle(), /one PTY exceeded its five-second budget/u);
  assert.deepEqual(signals, ["SIGKILL"]);
  assert.equal(disposed, 2);
  assert.equal(report.normalExits, 0);
  assert.equal(context.activeTerminal, undefined);
});
