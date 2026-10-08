import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import {
  TerminalSessionStore,
  normalizePersistedTerminalSessions
} from "../src/main/services/TerminalSessionStore.ts";
import { planSessionRestore } from "../src/main/services/sessionRestorePlan.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";

const CONVERSATION = "5f1c2a90-aa11-4b22-9c33-0d44e55f6677";
const HERMES_CONVERSATION = "20261001_031347_02c965";
const base = {
  provider: "claude",
  profile: "normal",
  role: "agent",
  title: "Agent",
  titleCustomized: false,
  cwd: process.cwd(),
  position: { x: 0, y: 0 },
  size: { width: 700, height: 430 }
};
const record = (id, extra = {}) => ({ ...base, id, lastState: "running", restore: true, ...extra });
const noEnvironment = { isLiveSession: () => false, environmentAvailable: () => false };

function registry() {
  return {
    get(provider) {
      return { state: "available", provider, executable: `/resolved/${provider}`, launcher: "native",
        environment: { PATH: "/usr/bin" }, checked: [] };
    },
    snapshot() { return {}; }
  };
}

function spawner(calls) {
  return (command, args, options) => {
    const exits = [];
    calls.push({ command, args, options, exit: (code) => exits.forEach((listener) => listener({ exitCode: code })) });
    return {
      pid: 30_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; },
      onExit(listener) { exits.push(listener); return { dispose() {} }; }
    };
  };
}

async function withManagers(t) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-restore-v2-"));
  const managers = [];
  // Hooks run in order: stop every manager (and its pending writes) before removing the folder.
  t.after(() => Promise.all(managers.map((manager) => manager.shutdown())));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    async start(mode, calls = []) {
      const manager = new TerminalManager(() => undefined, registry(), undefined, undefined, true, spawner(calls));
      managers.push(manager);
      manager.configureSessionPersistence(new TerminalSessionStore(directory), mode);
      await manager.restorePersistedSessions();
      return { manager, calls };
    }
  };
}

test("a v1 store is read as v2 with no environment and running state; a v1 Codex thread id is kept", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-store-v1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TerminalSessionStore(directory);
  await writeFile(store.filePath, JSON.stringify({ version: 1, sessions: [
    { ...base, id: "legacy" },
    { ...base, id: "legacy-codex", provider: "codex", codexThreadId: CONVERSATION }
  ] }));
  assert.deepEqual(await store.load(), [record("legacy"), record("legacy-codex", { provider: "codex", threadId: CONVERSATION })]);
  await store.flush();
  const written = JSON.parse(await readFile(store.filePath, "utf8"));
  assert.equal(written.version, 2);
  assert.deepEqual(normalizePersistedTerminalSessions({ version: 3, sessions: [record("future")] }).sessions, []);
});

test("v2 slots are validated: thread ids, 4 KB plugin options and environment refs", () => {
  const environment = { pluginId: "canvastty.environments", kind: "container", ref: { id: "c-1" }, label: "Container" };
  const { sessions } = normalizePersistedTerminalSessions({
    version: 2,
    sessions: [
      record("kept", {
        lastState: "failed", exitCode: 2,
        threadId: CONVERSATION,
        options: { "good.plugin": { a: 1 }, "Bad Id": {}, "big.plugin": "x".repeat(5_000) },
        environment
      }),
      record("flag-id", { threadId: "--resume-evil", restore: false }),
      record("hermes-id", { provider: "hermes", threadId: HERMES_CONVERSATION }),
      record("bad-hermes-id", { provider: "hermes", threadId: "../../config.yaml" }),
      record("bad-environment", { environment: { ...environment, ref: "x".repeat(5_000) } })
    ]
  });
  assert.deepEqual(sessions, [
    record("kept", { lastState: "failed", exitCode: 2, threadId: CONVERSATION,
      options: { "good.plugin": { a: 1 } }, environment, isolatedEnvironmentScopes: { roots: [], ambiguous: true } }),
    record("flag-id", { restore: false }),
    record("hermes-id", { provider: "hermes", threadId: HERMES_CONVERSATION }),
    record("bad-hermes-id", { provider: "hermes" })
  ]);
});

test("the restore plan orders parents first and applies the per-card and shared-folder rules", () => {
  const records = [
    record("child", { role: "subagent", parentSessionId: "parent" }),
    record("parent", { role: "orchestrator", threadId: CONVERSATION }),
    record("skipped", { restore: false }),
    record("orphan", { role: "subagent", parentSessionId: "skipped" }),
    record("finished", { provider: "codex", cwd: "/elsewhere", lastState: "exited", exitCode: 0, threadId: CONVERSATION }),
    record("solo", { provider: "codex", cwd: "/solo" }),
    record("shared-codex", { provider: "codex", cwd: "/solo" }),
    record("placed", { provider: "codex", cwd: "/placed", threadId: CONVERSATION,
      environment: { pluginId: "canvastty.environments", kind: "container", ref: {}, label: "Container" } })
  ];
  const steps = planSessionRestore(records, "continue", noEnvironment);
  assert.deepEqual(steps.map((step) => [step.record.id, step.launch, step.note]), [
    ["parent", { threadId: CONVERSATION }, undefined],
    ["finished", "stopped", undefined],
    // Without an id Codex opens its resume picker, even beside another Codex card.
    ["solo", "latest", undefined],
    ["shared-codex", "latest", undefined],
    ["placed", "stopped", "environment-unavailable"],
    ["child", null, "fresh-shared-folder"]
  ]);
  // Stopped and held cards keep their id for Continue; only an exact resume carries it into a start.
  assert.deepEqual(steps.map((step) => step.threadId),
    [CONVERSATION, CONVERSATION, undefined, undefined, CONVERSATION, undefined]);
  const reopen = planSessionRestore(records, "reopen", noEnvironment);
  assert.deepEqual(reopen.map((step) => step.launch), [null, "stopped", null, null, "stopped", null]);
  assert.deepEqual(reopen.map((step) => step.threadId),
    [undefined, CONVERSATION, undefined, undefined, CONVERSATION, undefined]);
  assert.deepEqual(planSessionRestore(records, "off", noEnvironment), []);
  // Subagents whose parents point back at each other have no owner: none of that loop comes back.
  const loop = planSessionRestore([
    record("a", { role: "subagent", parentSessionId: "b" }), record("b", { role: "subagent", parentSessionId: "a" }),
    record("c", { role: "subagent", parentSessionId: "a" }), record("self", { role: "subagent", parentSessionId: "self" }),
    record("root", { role: "orchestrator" }), record("deep", { role: "subagent", parentSessionId: "mid" }),
    record("mid", { role: "subagent", parentSessionId: "root" })
  ], "continue", noEnvironment);
  assert.deepEqual(loop.map((step) => step.record.id), ["root", "mid", "deep"]);
});

test("Continue resumes each card's own conversation and never shares the folder's latest one", async (t) => {
  const fixture = await withManagers(t);
  const { manager } = await fixture.start("continue");
  const first = manager.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  manager.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  manager.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  const opencode = manager.create({ provider: "opencode", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  manager.applyProviderSignal(first.id, { kind: "lifecycle", state: "idle", threadId: CONVERSATION });
  manager.applyProviderSignal(opencode.id, { kind: "lifecycle", state: "idle", threadId: "ses_7a1b2c3d4ffeAbCdEfGhIjKlMn" });
  await manager.shutdown();

  const { manager: restored, calls } = await fixture.start("continue");
  const [claudeById, claudeShared, codexSolo, opencodeById] = calls.map((call) => call.args);
  assert.deepEqual(opencodeById.slice(-2), ["--session", "ses_7a1b2c3d4ffeAbCdEfGhIjKlMn"]);
  assert.deepEqual(claudeById.slice(-2), ["--resume", CONVERSATION]);
  assert.equal(claudeShared.includes("--continue"), false);
  assert.equal(codexSolo.at(-1), "resume");
  assert.deepEqual(restored.list().map((session) => session.restoreNote), [undefined, "fresh-shared-folder", undefined, undefined]);
  const saved = JSON.parse(await readFile(join(fixture.directory, "terminal-sessions.json"), "utf8"));
  assert.equal(saved.sessions[0].threadId, CONVERSATION);
  assert.doesNotMatch(JSON.stringify(saved), /buffer|prompt|token|capability/u);
});

test("Hermes restores exact sessions by id and legacy same-folder cards open pickers", async (t) => {
  const fixture = await withManagers(t);
  await new TerminalSessionStore(fixture.directory).replace([
    record("exact-hermes", { provider: "hermes", threadId: HERMES_CONVERSATION }),
    record("legacy-hermes-a", { provider: "hermes" }),
    record("legacy-hermes-b", { provider: "hermes" })
  ]);

  const { manager, calls } = await fixture.start("continue");
  assert.deepEqual(calls[0].args.slice(-2), ["--resume", HERMES_CONVERSATION]);
  assert.deepEqual(calls[1].args.slice(-2), ["sessions", "browse"]);
  assert.deepEqual(calls[2].args.slice(-2), ["sessions", "browse"]);
  assert.deepEqual(manager.list().map((session) => session.restoreNote), [undefined, undefined, undefined]);
});

test("Reopen windows starts every agent fresh and forgets the old conversation; Don't save clears the store", async (t) => {
  const fixture = await withManagers(t);
  const savedThreadIds = async () => JSON.parse(await readFile(join(fixture.directory, "terminal-sessions.json"), "utf8"))
    .sessions.map((session) => session.threadId);
  // 1. A running card is saved with conversation A.
  const { manager } = await fixture.start("continue");
  const card = manager.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  manager.applyProviderSignal(card.id, { kind: "lifecycle", state: "idle", threadId: CONVERSATION });
  await manager.shutdown();
  assert.deepEqual(await savedThreadIds(), [CONVERSATION]);

  // 2. Reopen starts it fresh and no lifecycle hook reports a new id.
  const { manager: reopened, calls } = await fixture.start("reopen");
  // 3. Neither the launch nor the saved record is tied to A, also after switching to Continue conversations.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes("--resume"), false);
  assert.equal(calls[0].args.includes(CONVERSATION), false);
  assert.deepEqual(await savedThreadIds(), [undefined]);
  await reopened.setSessionRestoreMode("continue");
  assert.deepEqual(await savedThreadIds(), [undefined]);
  // 4. After the fresh process exits, Continue does not resume A.
  calls[0].exit(0);
  reopened.restart(card.id, { resume: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes("--resume"), false);
  assert.equal(calls[1].args.includes(CONVERSATION), false);
  await reopened.setSessionRestoreMode("off");
  assert.deepEqual(new TerminalSessionStore(fixture.directory).get(), []);
  assert.deepEqual(await new TerminalSessionStore(fixture.directory).load(), []);
});

test("finished cards come back stopped with Restart and Continue; skipped cards stay gone", async (t) => {
  const fixture = await withManagers(t);
  const { manager, calls: firstCalls } = await fixture.start("continue");
  const finished = manager.create({ provider: "claude", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  const skipped = manager.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  manager.applyProviderSignal(finished.id, { kind: "lifecycle", state: "idle", threadId: CONVERSATION });
  firstCalls[0].exit(0);
  assert.equal(manager.setRestore(skipped.id, false).skipRestore, true);
  await manager.shutdown();

  const { manager: restored, calls } = await fixture.start("continue");
  assert.equal(calls.length, 0);
  assert.deepEqual(restored.list().map(({ id, status, exitCode }) => ({ id, status, exitCode })),
    [{ id: finished.id, status: "done", exitCode: 0 }]);
  restored.restart(finished.id, { resume: true });
  assert.deepEqual(calls[0].args.slice(-2), ["--resume", CONVERSATION]);
  // A plain Restart is a new conversation: the id is forgotten, so Continue later cannot pick the old one.
  calls[0].exit(0);
  restored.restart(finished.id);
  assert.equal(calls[1].args.includes("--resume"), false);
  assert.equal(restored.list()[0].exitCode, null);
  calls[1].exit(0);
  restored.restart(finished.id, { resume: true });
  assert.deepEqual(calls[2].args.slice(-1), ["--continue"]);
});

test("a placed card whose environment is unavailable stays stopped and never runs locally", async (t) => {
  const fixture = await withManagers(t);
  const environment = { pluginId: "canvastty.environments", kind: "container", ref: { id: "c-1" }, label: "Container" };
  await new TerminalSessionStore(fixture.directory).replace([record("placed", { environment, threadId: CONVERSATION })]);
  const { manager, calls } = await fixture.start("continue");
  assert.equal(calls.length, 0);
  const [card] = manager.list();
  assert.equal(card.restoreNote, "environment-unavailable");
  assert.match(card.failureDetails, /canvastty\.environments/u);
  assert.throws(() => manager.restart("placed"), /not started locally/u);
  assert.equal(calls.length, 0);
  await manager.shutdown();
  const [kept] = await new TerminalSessionStore(fixture.directory).load();
  assert.equal(kept.lastState, "running");
  assert.equal(kept.threadId, CONVERSATION);
  assert.deepEqual(kept.environment, environment);
});

test("settings migrate the old switch: true continues conversations, false saves nothing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-restore-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [legacy, expected] of [[true, "continue"], [false, "off"]]) {
    await writeFile(join(directory, "settings.json"), JSON.stringify({ settingsVersion: 20, restoreTerminalSessions: legacy }));
    const settings = await new SettingsStore(directory, "en").load();
    assert.equal(settings.sessionRestoreMode, expected);
    const written = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
    assert.equal(written.sessionRestoreMode, expected);
    assert.equal("restoreTerminalSessions" in written, false);
  }
});
