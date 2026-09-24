import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

function availableRegistry() {
  return {
    get(provider) {
      return Object.freeze({
        state: "available",
        provider,
        executable: `/resolved/${provider}`,
        launcher: "native",
        environment: Object.freeze({ PATH: "/resolved:/usr/bin" }),
        checked: Object.freeze([{ path: `/resolved/${provider}`, result: "selected" }])
      });
    },
    snapshot() {
      return {};
    }
  };
}

function fakeSpawner(calls) {
  return (command, args, options) => {
    let onData = () => undefined;
    let onExit = () => undefined;
    const process = {
      pid: 10_000 + calls.length,
      process: command,
      write() {},
      resize(cols, rows) {
        process.lastResize = { cols, rows };
      },
      kill() {},
      pause() {},
      resume() {},
      onData(listener) {
        onData = listener;
        return { dispose() {} };
      },
      onExit(listener) {
        onExit = listener;
        return { dispose() {} };
      },
      emitData(data) {
        onData(data);
      },
      emitExit(exitCode) {
        onExit({ exitCode, signal: 0 });
      },
      lastResize: null
    };
    calls.push({ command, args, options, process });
    return process;
  };
}

test("Grok PTY starts and restarts only with the renderer-measured grid", () => {
  const calls = [];
  const manager = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner(calls)
  );
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

  calls[0].process.emitExit(0);
  assert.equal(manager.list()[0].exitCode, 0);
  manager.restart(session.id);
  assert.equal(calls.length, 1);
  manager.resize(session.id, 69, 16);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.cols, 69);
  assert.equal(calls[1].options.rows, 16);
  manager.disposeAll();
});

test("other providers retain immediate startup and subsequent PTY resize", () => {
  const calls = [];
  const manager = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner(calls)
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
    fakeSpawner(calls)
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
