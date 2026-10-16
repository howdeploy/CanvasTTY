import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";

const FIRST_THREAD = "11111111-1111-4111-8111-111111111111";
const SECOND_THREAD = "22222222-2222-4222-8222-222222222222";
const HERMES_SESSION = "20261001_031347_02c965";

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
  instance.configureSessionPersistence(new TerminalSessionStore(directory), "continue");
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
    initial.applyProviderSignal(first.id, { kind: "lifecycle", state: "idle", threadId: FIRST_THREAD });
    initial.applyProviderSignal(second.id, { kind: "lifecycle", state: "idle", threadId: SECOND_THREAD });
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

test("Hermes hook identity survives restart and resumes that exact conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-hermes-exact-resume-"));
  try {
    const initial = manager(directory, []);
    await initial.restorePersistedSessions();
    const card = initial.create({ provider: "hermes", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
    initial.applyProviderSignal(card.id, { kind: "lifecycle", state: "idle", threadId: HERMES_SESSION });
    await initial.shutdown();
    assert.equal((await new TerminalSessionStore(directory).load())[0]?.threadId, HERMES_SESSION);

    const calls = [];
    const restored = manager(directory, calls);
    await restored.restorePersistedSessions();
    assert.deepEqual(calls[0].args.slice(-2), ["--resume", HERMES_SESSION]);
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
    inst.configureSessionPersistence(store, "continue");
    await inst.restorePersistedSessions();

    const created = inst.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
    inst.applyProviderSignal(created.id, { kind: "lifecycle", state: "idle", threadId: FIRST_THREAD });

    // Verify stored
    assert.equal(store.get()[0]?.threadId, FIRST_THREAD);

    // Simulate exit
    exitHandler?.({ exitCode: 0 });

    // Restart the session
    inst.restart(created.id);

    // Fresh restart: second spawn call shouldn't have "resume" or thread ID
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.includes("resume"), false);
    assert.equal(calls[1].args.includes(FIRST_THREAD), false);

    // Stored session should no longer have the stale thread ID
    assert.equal(store.get()[0]?.threadId, undefined);

    await inst.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conversation identity survives every public metadata update and clears on a fresh restart", async t => {
  const events = [];
  let exit;
  const inst = new TerminalManager((channel, payload) => events.push({ channel, payload }), registry(), undefined, undefined, true,
    (command) => ({ ...spawner([])(command, [], {}), onExit(handler) { exit = handler; return { dispose() {} }; } }));
  t.after(() => inst.shutdown());
  const created = inst.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  inst.applyProviderSignal(created.id, { kind: "lifecycle", state: "idle", threadId: FIRST_THREAD });
  assert.equal(inst.rename(created.id, "Renamed").threadId, FIRST_THREAD);
  assert.equal(inst.setRestore(created.id, false).threadId, FIRST_THREAD);
  assert.equal(inst.getMetadata(created.id).threadId, FIRST_THREAD);
  assert.equal(inst.listMetadata()[0].threadId, FIRST_THREAD);
  assert.equal(inst.pluginContext(created.id).metadata.threadId, FIRST_THREAD);
  assert.equal(events.filter(event => event.payload?.session?.id === created.id).at(-1).payload.session.threadId, FIRST_THREAD);
  exit({ exitCode: 0 });
  inst.restart(created.id);
  assert.equal(inst.getMetadata(created.id).threadId, undefined);
  assert.equal(events.filter(event => event.payload?.session?.id === created.id).at(-1).payload.session.threadId, undefined);
});

test("local history reuses a running card before an exited card with the same conversation", async t => {
  const exits = [];
  const inst = new TerminalManager(() => undefined, registry(), undefined, undefined, true,
    (command) => ({ ...spawner([])(command, [], {}), onExit(handler) { exits.push(handler); return { dispose() {} }; } }));
  t.after(() => inst.shutdown());
  const create = () => inst.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 }, resumeThreadId: FIRST_THREAD });
  create();
  exits[0]({ exitCode: 0 });
  const active = create();
  assert.equal(inst.findLocalConversation("codex", FIRST_THREAD).id, active.id);
  assert.equal(inst.findLocalConversation("hermes", FIRST_THREAD), null);
});


for (const trusted of [true, false]) {
  test(`automatic local Codex restore checks trust before spawning (${trusted ? "trusted" : "missing trust"})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "canvastty-restore-trust-"));
    const initial = manager(directory, []);
    const card = initial.create({ provider: "codex", profile: "auto", cwd: process.cwd(), position: { x: 0, y: 0 } });
    initial.applyProviderSignal(card.id, { kind: "lifecycle", state: "idle", threadId: FIRST_THREAD });
    await initial.shutdown();
    const calls = [];
    const restored = manager(directory, calls);
    t.after(async () => { await restored.shutdown(); await rm(directory, { recursive: true, force: true }); });
    let checked = 0;
    restored.configureCodexRestoreTrust(async cwd => {
      assert.equal(cwd, process.cwd());
      assert.equal(calls.length, 0, "trust is checked before any process starts");
      checked++;
      if (!trusted) throw new Error("trust absent");
    });
    await restored.restorePersistedSessions();
    assert.equal(checked, 1);
    assert.equal(calls.length, trusted ? 1 : 0);
    const session = restored.list().find(s => s.id === card.id);
    if (!trusted) {
      assert.equal(session.status, "failed");
      assert.match(session.failureDetails, /Restart.*trust/);
      assert.equal((await new TerminalSessionStore(directory).load())[0].threadId, FIRST_THREAD);
      assert.equal(restored.localCodexFolderForTrust(card.id), process.cwd());
    }
  });
}


test("holding an untrusted restored parent also holds its descendants but leaves other providers running", async t => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-restore-family-trust-"));
  const calls = [];
  const restored = manager(directory, calls);
  t.after(() => restored.shutdown());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = { provider: "codex", profile: "auto", role: "orchestrator", title: "Saved",
    titleCustomized: false, cwd: process.cwd(), position: { x: 0, y: 0 }, size: { width: 700, height: 430 },
    lastState: "running", restore: true };
  await new TerminalSessionStore(directory).replace([
    { ...base, id: "parent" },
    { ...base, id: "child", role: "subagent", parentSessionId: "parent" },
    { ...base, id: "other-provider", provider: "claude", role: "agent" },
    { ...base, id: "finished", lastState: "exited", exitCode: 0 }
  ]);
  let checks = 0;
  restored.configureCodexRestoreTrust(async () => { checks++; throw new Error("trust absent"); });
  await restored.restorePersistedSessions();
  assert.equal(checks, 1, "children and finished cards do not request new trust");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/resolved/claude");
  for (const id of ["parent", "child"]) {
    const session = restored.list().find(s => s.id === id);
    assert.equal(session.status, "failed");
    assert.match(session.failureDetails, /Restart/);
  }
  assert.equal(restored.list().find(s => s.id === "finished").status, "done");
});
