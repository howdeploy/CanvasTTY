import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

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
    first.configureSessionPersistence(new TerminalSessionStore(directory), "continue");
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
    restored.configureSessionPersistence(new TerminalSessionStore(directory), "continue");
    await restored.restorePersistedSessions();

    assert.equal(restoredCalls.length, 1);
    assert.deepEqual(restoredCalls[0].args.slice(-1), ["resume"]);
    assert.equal(restoredCalls[0].args.includes("--last"), false);
    assert.deepEqual(restored.list().map(({ buffer, revision, status, startedAt, exitCode, failureDetails, ...session }) => session), [{
      id: created.id,
      provider: "codex",
      profile: "normal",
      role: "agent",
      nativeEditor: created.nativeEditor,
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
    manager.configureSessionPersistence(store, "off");
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
    manager.configureSessionPersistence(store, "continue");
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

test("saved cards this build cannot read are never written over, by the store or by the manager's restore", async () => {
  const cases = {
    newer: JSON.stringify({ version: 3, sessions: [{ id: "from-a-later-build" }] }),
    corrupt: "{\"version\": 2, \"sessions\": [",
    "not a card list": JSON.stringify({ hello: "world" })
  };
  for (const [name, text] of Object.entries(cases)) {
    const directory = await mkdtemp(join(tmpdir(), "canvastty-terminal-unreadable-"));
    try {
      const store = new TerminalSessionStore(directory);
      await writeFile(store.filePath, text);
      const manager = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([]));
      manager.configureSessionPersistence(store, "continue");
      await manager.restorePersistedSessions();
      manager.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
      await manager.shutdown();
      const problem = store.loadProblem;
      if (name === "newer") {
        assert.equal(problem?.kind, "newer", name);
        assert.equal(await readFile(store.filePath, "utf8"), text, `${name}: the file is left as it is`);
      } else {
        // An unparsable file is kept beside a fresh one, byte for byte.
        assert.equal(problem?.kind, "corrupt", name);
        assert.equal(await readFile(problem.backupPath, "utf8"), text, `${name}: the old file is kept`);
        assert.equal(JSON.parse(await readFile(store.filePath, "utf8")).sessions.length, 1, `${name}: new cards are saved`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("a store file that cannot be read at all is not replaced", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-terminal-noread-"));
  try {
    const store = new TerminalSessionStore(directory);
    const text = JSON.stringify({ version: 2, sessions: [] });
    await writeFile(store.filePath, text, { mode: 0o200 });
    await store.load();
    assert.equal(store.loadProblem?.kind, "unreadable");
    await store.replace([]);
    await chmod(store.filePath, 0o600);
    assert.equal(await readFile(store.filePath, "utf8"), text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed update installation restores sessions and keeps persistence active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-update-rollback-"));
  try {
    const store = new TerminalSessionStore(directory);
    const calls = [];
    const manager = new TerminalManager(
      () => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls)
    );
    manager.configureSessionPersistence(store, "continue");
    const first = manager.create({ provider: "terminal", profile: "normal", cwd: process.cwd(), position: { x: 1, y: 2 } });
    const restore = await manager.shutdownForUpdate();
    assert.deepEqual(manager.list(), []);
    await restore();
    assert.equal(manager.list().length, 1);
    assert.equal(manager.list()[0].id, first.id);
    const second = manager.create({ provider: "terminal", profile: "normal", cwd: process.cwd(), position: { x: 3, y: 4 } });
    await manager.shutdown();
    assert.deepEqual(new Set(store.get().map(session => session.id)), new Set([first.id, second.id]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
