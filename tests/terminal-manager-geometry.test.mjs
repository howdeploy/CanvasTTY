import assert from "node:assert/strict";
import test from "node:test";
import { ProcessTreePause } from "../src/main/services/ProcessTreePause.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

test("Grok PTY starts and restarts only with the renderer-measured grid and releases completed PTYs", (t) => {
  const calls = [];
  const signals = [];
  const manager = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner(calls, { pidBase: 10_000 }),
    new ProcessTreePause("darwin", (pid, signal) => signals.push([pid, signal]))
  );
  t.after(() => manager.disposeAll());
  const session = manager.create({
    provider: "grok",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });

  assert.equal(calls.length, 0);
  manager.resize(session.id, 73, 18);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cols, 73);
  assert.equal(calls[0].options.rows, 18);

  calls[0].process.emitData("kept scrollback\r\n");
  calls[0].process.emitExit(0);
  assert.equal(manager.list()[0].exitCode, 0);
  const exitedBuffer = manager.readBuffer(session.id);
  assert.equal(exitedBuffer.buffer, "kept scrollback\r\n");
  manager.setBudgetPaused(session.id, true);
  assert.deepEqual(signals, [], "budget changes must not signal a completed PTY");
  manager.setBudgetPaused(session.id, false);
  assert.deepEqual(signals, [], "clearing a budget must not signal a completed PTY");

  manager.restart(session.id);
  assert.equal(calls.length, 1);
  manager.resize(session.id, 69, 16);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.cols, 69);
  assert.equal(calls[1].options.rows, 16);
  calls[1].process.emitData("restarted\r\n");
  calls[1].process.emitExit(0);
  assert.equal(manager.readBuffer(session.id).buffer, "kept scrollback\r\nrestarted\r\n");
  let staleKills = 0;
  calls[1].process.kill = () => { staleKills += 1; };
  manager.dispose(session.id);
  assert.equal(staleKills, 0, "closing a completed card must not kill its old PTY");
});

test("other providers retain immediate startup and subsequent PTY resize", () => {
  const calls = [];
  const manager = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner(calls, { pidBase: 10_000 })
  );
  const session = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cols, 80);
  assert.equal(calls[0].options.rows, 24);
  manager.resize(session.id, 92, 27);
  assert.deepEqual(calls[0].process.lastResize, { cols: 92, rows: 27 });
  manager.disposeAll();
});

test("only explicit stop signals mark a provider turn complete", () => {
  const manager = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner([])
  );
  const session = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const signal = (state, event) => manager.applyProviderSignal(session.id, { kind: "lifecycle", state, event });

  signal("working", "UserPromptSubmit");
  signal("idle", "Notification");
  assert.equal(manager.list()[0].turnCompleted, false);
  signal("working", "UserPromptSubmit");
  signal("idle", "Stop");
  assert.equal(manager.list()[0].turnCompleted, true);
  signal("idle", "Notification");
  assert.equal(manager.list()[0].turnCompleted, true);
  signal("working", "UserPromptSubmit");
  assert.equal(manager.list()[0].turnCompleted, false);
  manager.disposeAll();
});

test("answer-capture grants are passed only to the explicitly granted session generation", () => {
  const calls = [];
  const grants = [];
  const runtime = {
    prepareLaunch(input) {
      grants.push(input.answerCaptureGrantExpiresAt);
      return { args: [], environment: {}, cleanup() {} };
    },
    currentStatus() { return null; }
  };
  const manager = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    runtime,
    true,
    fakeSpawner(calls, { pidBase: 10_000 })
  );
  const expiresAt = Date.now() + 60_000;
  const session = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  }, { answerCaptureGrantExpiresAt: expiresAt });
  assert.deepEqual(grants, [expiresAt]);

  calls[0].process.emitExit(0);
  manager.restart(session.id);
  assert.deepEqual(grants, [expiresAt, undefined]);
  manager.disposeAll();
});
