import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager, PTY_EXIT_WAIT_MS } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

function fixture(t, platform = "darwin") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const manager = new TerminalManager(() => {}, availableRegistry(), undefined, undefined, false, fakeSpawner(calls), platform);
  const create = () => manager.create({ provider: "terminal", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } }).id;
  const ids = [create(), create()];
  const signals = calls.map(() => []);
  for (let i = 0; i < calls.length; i++) calls[i].process.kill = signal => signals[i].push(signal ?? "SIGHUP");
  t.after(() => { for (const call of calls) call.process.emitExit(0); manager.disposeAll(); });
  return { manager, calls, ids, signals };
}

test("closing a card escalates only its own still-live PTY after the grace period", (t) => {
  const { manager, calls, ids, signals } = fixture(t);
  manager.dispose(ids[0]);
  assert.equal(manager.getMetadata(ids[0]), null);
  assert.deepEqual(signals, [["SIGHUP"], []]);
  t.mock.timers.tick(PTY_EXIT_WAIT_MS - 1);
  assert.deepEqual(signals, [["SIGHUP"], []]);
  t.mock.timers.tick(1);
  assert.deepEqual(signals, [["SIGHUP", "SIGKILL"], []]);
  assert.equal(manager.closedProcessTimers.size, 0, "one bounded escalation, no perpetual retry");
  calls[0].process.emitExit(137);
  assert.equal(manager.liveProcesses.size, 1, "the unrelated card remains live");
});

test("an exited closed PTY cancels escalation and cannot be signalled after its PID is reused", (t) => {
  const { manager, calls, ids, signals } = fixture(t);
  manager.dispose(ids[0]);
  calls[0].process.emitExit(0);
  assert.equal(manager.closedProcessTimers.size, 0);
  t.mock.timers.tick(PTY_EXIT_WAIT_MS * 2);
  assert.deepEqual(signals, [["SIGHUP"], []]);
});

for (const platform of ["linux", "win32"]) test(`ordinary close escalates only on POSIX: ${platform}`, (t) => {
  const { manager, ids, signals } = fixture(t, platform);
  manager.dispose(ids[0]);
  t.mock.timers.tick(PTY_EXIT_WAIT_MS * 2);
  assert.deepEqual(signals, [platform === "win32" ? ["SIGHUP"] : ["SIGHUP", "SIGKILL"], []]);
  assert.equal(manager.closedProcessTimers.size, 0);
});
