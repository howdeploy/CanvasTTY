import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";

function availableRegistry() {
  return {
    get(provider) {
      return {
        state: "available",
        provider,
        executable: `/resolved/${provider}`,
        launcher: "native",
        environment: { PATH: "/resolved:/usr/bin" },
        checked: [{ path: `/resolved/${provider}`, result: "selected" }]
      };
    },
    snapshot() { return {}; }
  };
}

function fakeSpawner(calls) {
  return (command, args, options) => {
    const process = {
      pid: 20_000 + calls.length,
      process: command,
      write() {},
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
    calls.push({ command, args, options });
    return process;
  };
}

test("opt-in restore preserves card identity and relaunches the agent in native continue mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-terminal-restore-"));
  try {
    const firstCalls = [];
    const first = new TerminalManager(
      () => undefined,
      availableRegistry(),
      undefined,
      undefined,
      true,
      fakeSpawner(firstCalls)
    );
    first.configureSessionPersistence(new TerminalSessionStore(directory), true);
    await first.restorePersistedSessions();
    const created = first.create({
      provider: "codex",
      profile: "normal",
      cwd: process.cwd(),
      position: { x: 20, y: 30 }
    });
    first.setBounds(created.id, {
      position: { x: 440, y: 180 },
      size: { width: 880, height: 540 }
    });
    first.rename(created.id, "Backend agent");
    await first.shutdown();

    const restoredCalls = [];
    const restored = new TerminalManager(
      () => undefined,
      availableRegistry(),
      undefined,
      undefined,
      true,
      fakeSpawner(restoredCalls)
    );
    restored.configureSessionPersistence(new TerminalSessionStore(directory), true);
    await restored.restorePersistedSessions();

    assert.equal(restoredCalls.length, 1);
    assert.deepEqual(restoredCalls[0].args.slice(-1), ["resume"]);
    assert.equal(restoredCalls[0].args.includes("--last"), false);
    assert.deepEqual(restored.list().map(({ buffer, revision, status, startedAt, exitCode, failureDetails, ...session }) => session), [{
      id: created.id,
      provider: "codex",
      profile: "normal",
      role: "agent",
      title: "Backend agent",
      titleCustomized: true,
      cwd: process.cwd(),
      position: { x: 440, y: 180 },
      size: { width: 880, height: 540 }
    }]);
    await restored.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the default opt-out clears old descriptors instead of restoring them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-terminal-discard-"));
  try {
    const store = new TerminalSessionStore(directory);
    await store.replace([{
      id: "old-session",
      provider: "claude",
      profile: "normal",
      title: "Old agent",
      titleCustomized: true,
      cwd: process.cwd(),
      position: { x: 0, y: 0 },
      size: { width: 700, height: 430 }
    }]);
    const calls = [];
    const manager = new TerminalManager(
      () => undefined,
      availableRegistry(),
      undefined,
      undefined,
      true,
      fakeSpawner(calls)
    );
    manager.configureSessionPersistence(store, false);
    await manager.restorePersistedSessions();
    assert.deepEqual(manager.list(), []);
    assert.deepEqual(store.get(), []);
    assert.equal(calls.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a restored Grok session still waits for the measured grid before continuing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-grok-restore-"));
  try {
    const store = new TerminalSessionStore(directory);
    await store.replace([{
      id: "grok-session",
      provider: "grok",
      profile: "normal",
      title: "Grok",
      titleCustomized: false,
      cwd: process.cwd(),
      position: { x: 0, y: 0 },
      size: { width: 700, height: 430 }
    }]);
    const calls = [];
    const manager = new TerminalManager(
      () => undefined,
      availableRegistry(),
      undefined,
      undefined,
      true,
      fakeSpawner(calls)
    );
    manager.configureSessionPersistence(store, true);
    await manager.restorePersistedSessions();
    assert.equal(calls.length, 0);
    manager.resize("grok-session", 71, 17);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-1), ["--continue"]);
    assert.equal(calls[0].options.cols, 71);
    assert.equal(calls[0].options.rows, 17);
    await manager.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
