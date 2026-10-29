import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { IPC } from "../src/shared/contracts.ts";
import { AttentionNotifications } from "../src/main/services/AttentionNotifications.ts";

test("approval notifications need one uninterrupted second; duplicate snapshots do not postpone or repeat them", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  const notifications = new AttentionNotifications((id, status) => sent.push([id, status]), () => true);
  t.after(() => notifications.dispose());

  notifications.observe("brief", "needs_approval");
  t.mock.timers.tick(800);
  notifications.observe("brief", "working");
  t.mock.timers.tick(1_000);
  assert.deepEqual(sent, []);

  notifications.observe("brief", "needs_approval");
  t.mock.timers.tick(800);
  notifications.observe("brief", "idle");
  notifications.observe("brief", "needs_approval");
  t.mock.timers.tick(200);
  assert.deepEqual(sent, [], "a new approval request starts its own full waiting interval");
  notifications.observe("brief", "done");

  notifications.observe("real", "needs_approval");
  t.mock.timers.tick(999);
  notifications.observe("real", "needs_approval");
  assert.deepEqual(sent, []);
  t.mock.timers.tick(1);
  notifications.observe("real", "needs_approval");
  t.mock.timers.tick(2_000);
  assert.deepEqual(sent, [["real", "needs_approval"]]);

  notifications.observe("real", "idle");
  notifications.observe("real", "needs_approval");
  t.mock.timers.tick(1_000);
  assert.equal(sent.length, 2, "a new genuine request can notify again");
});

test("closing, disabling notifications, and shutdown cancel pending approval alerts", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let enabled = true;
  const sent = [];
  const notifications = new AttentionNotifications((id) => sent.push(id), () => enabled);
  t.after(() => notifications.dispose());

  notifications.observe("closed", "needs_approval");
  notifications.forget("closed");
  notifications.observe("disabled", "needs_approval");
  enabled = false;
  notifications.observe("already-off", "needs_approval");
  notifications.observe("muted-failure", "failed");
  t.mock.timers.tick(1_000);
  enabled = true;
  notifications.observe("disabled", "needs_approval");
  notifications.observe("shutdown", "needs_approval");
  notifications.dispose();
  t.mock.timers.tick(2_000);
  assert.deepEqual(sent, []);
});

test("failures remain immediate, restore failures stay silent, and user-requested failed restarts notify again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  const notifications = new AttentionNotifications((id, status) => sent.push([id, status]), () => true);
  t.after(() => notifications.dispose());

  notifications.observe("restored", "failed", "restore");
  notifications.observe("restored", "failed");
  notifications.observe("active", "needs_approval");
  notifications.observe("active", "failed");
  notifications.observe("active", "failed");
  assert.deepEqual(sent, [["active", "failed"]]);
  notifications.observe("active", "failed", "user");
  t.mock.timers.tick(2_000);
  assert.deepEqual(sent, [["active", "failed"], ["active", "failed"]]);
});

test("fresh installs enable attention notifications", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-attention-"));
  try {
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    assert.equal(store.get().attentionNotifications, true);
    assert.equal(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).attentionNotifications, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit opt-out survives a reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-attention-"));
  try {
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    await store.update({ attentionNotifications: false });
    assert.equal(store.get().attentionNotifications, false);

    const reloaded = new SettingsStore(dir, "en-US");
    await reloaded.load();
    assert.equal(reloaded.get().attentionNotifications, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a malformed value falls back instead of leaking into settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-attention-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ attentionNotifications: "yes" }), "utf8");
    const store = new SettingsStore(dir, "en-US");
    await store.load();
    assert.equal(store.get().attentionNotifications, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Not every failure is the same event. Notification policy is decided in the
// main process, but "was this failure caused by the user or is it state we
// re-derived?" is knowledge only the terminal manager has, so it announces it
// with the snapshot. The manager tests below pin that signal; the policy tests
// above exercise the same scheduler that main uses for OS notifications.

const PERSISTED_SESSION = {
  id: "restored-session",
  provider: "codex",
  profile: "normal",
  title: "Restored · Codex",
  titleCustomized: false,
  position: { x: 0, y: 0 },
  size: { width: 700, height: 430 }
};

/** CLI registry whose availability can flip mid-test, like a CLI removed under a card. */
function cliRegistry(availability) {
  return {
    get: (provider) => ({
      state: availability.state,
      provider,
      executable: "/resolved/codex",
      launcher: "native",
      environment: {},
      checked: [],
      diagnostic: "codex was not found on PATH."
    })
  };
}

function createManager(t) {
  const availability = { state: "available" };
  const announcements = [];
  const exits = [];
  let manager;
  manager = new TerminalManager((channel, payload) => {
    if (channel !== IPC.terminalSession) return;
    // Read inside the emit, the way the main-process callback does.
    announcements.push({ ...payload.session, failureOrigin: manager.consumeFailureOrigin() });
  }, cliRegistry(availability), undefined, undefined, true, () => ({
    pid: 10000,
    process: "codex",
    kill() {},
    write() {},
    resize() {},
    onData() { return { dispose() {} }; },
    onExit(listener) { exits.push(listener); return { dispose() {} }; }
  }));
  t.after(() => manager.disposeAll());
  return { manager, announcements, exits, availability };
}

async function persistedStore(directory, cwd) {
  const store = new TerminalSessionStore(directory);
  await store.replace([{ ...PERSISTED_SESSION, cwd }]);
  return store;
}

test("a restored session whose folder vanished announces its failure as restore-derived", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-attention-"));
  try {
    const store = await persistedStore(dir, join(dir, "deleted-folder"));
    const { manager, announcements } = createManager(t);
    manager.configureSessionPersistence(store, "continue");

    await manager.restorePersistedSessions();

    assert.equal(announcements.length, 1, "a restored session announces once");
    assert.equal(announcements[0].status, "failed");
    assert.equal(announcements[0].failureOrigin, "restore",
      "state re-derived at launch must not be announced as a fresh failure again and again");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a restored session whose CLI is gone announces its failure as restore-derived too", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-attention-"));
  try {
    const store = await persistedStore(dir, process.cwd());
    const { manager, announcements, availability } = createManager(t);
    availability.state = "unavailable";
    manager.configureSessionPersistence(store, "continue");

    await manager.restorePersistedSessions();

    assert.equal(announcements[0].status, "failed");
    assert.equal(announcements[0].failureOrigin, "restore");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a restored session that still launches announces no failure origin", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "canvastty-attention-"));
  try {
    const store = await persistedStore(dir, process.cwd());
    const { manager, announcements } = createManager(t);
    manager.configureSessionPersistence(store, "continue");

    await manager.restorePersistedSessions();

    assert.notEqual(announcements[0].status, "failed");
    assert.equal(announcements[0].failureOrigin, null,
      "a launch that worked must not mark a later failure of the same session as restore-derived");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failure from a restart the user asked for is announced as user-caused", async (t) => {
  const { manager, announcements, exits, availability } = createManager(t);
  const { id } = manager.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });

  // The session ran and exited non-zero: an ordinary transition into failure,
  // which the policy notices by the status change alone.
  exits[0]({ exitCode: 1, signal: 0 });
  assert.equal(announcements.at(-1).status, "failed");
  assert.equal(announcements.at(-1).failureOrigin, null, "an exit nobody caused carries no origin");

  // The CLI is gone by the time the user clicks Restart, so the announcement
  // repeats a status the card already showed.
  availability.state = "unavailable";
  manager.restart(id);
  assert.equal(announcements.at(-1).status, "failed");
  assert.equal(announcements.at(-1).failureOrigin, "user",
    "a failure the user just caused is news even though the status did not change");
  assert.equal(manager.consumeFailureOrigin(), null, "the origin does not outlive the emit it belongs to");
});
