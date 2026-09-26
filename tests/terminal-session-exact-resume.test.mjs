import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";

const FIRST_THREAD = "11111111-1111-4111-8111-111111111111";
const SECOND_THREAD = "22222222-2222-4222-8222-222222222222";

function registry() {
  return {
    get(provider) {
      return {
        state: "available",
        provider,
        executable: `/resolved/${provider}`,
        launcher: "native",
        environment: {},
        checked: []
      };
    },
    snapshot() { return {}; }
  };
}

function spawner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return {
      pid: 10_000 + calls.length,
      process: command,
      write() {},
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
  };
}

function manager(directory, calls) {
  const instance = new TerminalManager(
    () => undefined,
    registry(),
    undefined,
    undefined,
    true,
    spawner(calls)
  );
  instance.configureSessionPersistence(new TerminalSessionStore(directory), true);
  return instance;
}

test("restoring two Codex cards in one cwd resumes their own conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-exact-resume-"));
  try {
    const initial = manager(directory, []);
    await initial.restorePersistedSessions();
    const first = initial.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
    const second = initial.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 20, y: 20 } });
    // SessionStart is idle while a new card is already idle. The ID must still persist.
    initial.applyProviderSignal(first.id, { kind: "lifecycle", state: "idle", codexThreadId: FIRST_THREAD });
    initial.applyProviderSignal(second.id, { kind: "lifecycle", state: "idle", codexThreadId: SECOND_THREAD });
    await initial.shutdown();

    const calls = [];
    const restored = manager(directory, calls);
    await restored.restorePersistedSessions();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.args.slice(-2)), [
      ["resume", FIRST_THREAD],
      ["resume", SECOND_THREAD]
    ]);
    assert.deepEqual(restored.list().map((session) => session.id), [first.id, second.id]);
    await restored.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy Codex card without an ID opens the resume picker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-legacy-resume-"));
  try {
    const store = new TerminalSessionStore(directory);
    await store.replace([{
      id: "legacy-codex-card",
      provider: "codex",
      profile: "normal",
      role: "agent",
      title: "Legacy card",
      titleCustomized: true,
      cwd: process.cwd(),
      position: { x: 0, y: 0 },
      size: { width: 700, height: 430 }
    }]);
    const calls = [];
    const restored = manager(directory, calls);
    await restored.restorePersistedSessions();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.at(-1), "resume");
    assert.equal(calls[0].args.includes("--last"), false);
    await restored.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restarting a Codex card after an exit clears stale thread ID and launches fresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-restart-codex-"));
  try {
    const calls = [];
    let exitHandler = null;
    const customSpawner = (command, args, options) => {
      calls.push({ command, args, options });
      return {
        pid: 30_000 + calls.length,
        process: command,
        write() {},
        resize() {},
        kill() {},
        pause() {},
        resume() {},
        onData() { return { dispose() {} }; },
        onExit(handler) {
          exitHandler = handler;
          return { dispose() {} };
        }
      };
    };

    const inst = new TerminalManager(
      () => undefined,
      registry(),
      undefined,
      undefined,
      true,
      customSpawner
    );
    const store = new TerminalSessionStore(directory);
    inst.configureSessionPersistence(store, true);
    await inst.restorePersistedSessions();

    const created = inst.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
    inst.applyProviderSignal(created.id, { kind: "lifecycle", state: "idle", codexThreadId: FIRST_THREAD });

    // Verify stored
    assert.equal(store.get()[0]?.codexThreadId, FIRST_THREAD);

    // Simulate exit
    exitHandler?.({ exitCode: 0 });

    // Restart the session
    inst.restart(created.id);

    // Fresh restart: second spawn call shouldn't have "resume" or thread ID
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.includes("resume"), false);
    assert.equal(calls[1].args.includes(FIRST_THREAD), false);

    // Stored session should no longer have the stale thread ID
    assert.equal(store.get()[0]?.codexThreadId, undefined);

    await inst.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
