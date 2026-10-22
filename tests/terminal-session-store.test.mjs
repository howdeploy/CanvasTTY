import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TerminalSessionStore,
  normalizePersistedTerminalSessions,
  persistedTerminalSession
} from "../src/main/services/TerminalSessionStore.ts";

const descriptor = {
  id: "7a511f56-89b8-4d62-9bf6-bd762bd73488",
  provider: "codex",
  profile: "normal",
  role: "agent",
  title: "Canvas work",
  titleCustomized: true,
  cwd: process.cwd(),
  position: { x: 120, y: 40 },
  size: { width: 700, height: 430 },
  lastState: "running",
  restore: true
};

test("terminal window descriptors persist atomically without scrollback or environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-terminal-state-"));
  try {
    const store = new TerminalSessionStore(directory);
    await store.replace([descriptor]);
    const raw = await readFile(store.filePath, "utf8");
    // The checkout folder is the descriptor's cwd; leave it out so a path like ~/environment/... cannot match.
    assert.doesNotMatch(raw.split(JSON.stringify(descriptor.cwd)).join('""'), /buffer|environment|capability|token/u);

    const reloaded = new TerminalSessionStore(directory);
    assert.deepEqual(await reloaded.load(), [descriptor]);
    await reloaded.clear();
    assert.deepEqual(await new TerminalSessionStore(directory).load(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cursor agent sessions persist like every other provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-terminal-state-cursor-"));
  try {
    const cursorSession = { ...descriptor, id: "0f9e8d7c-6b5a-4c3b-2a19-f8e7d6c5b4a3", provider: "cursor" };
    const store = new TerminalSessionStore(directory);
    await store.replace([cursorSession]);
    const restored = await new TerminalSessionStore(directory).load();
    assert.deepEqual(restored.map((session) => session.provider), ["cursor"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid descriptors are removed and geometry is bounded", () => {
  const normalized = normalizePersistedTerminalSessions({
    version: 1,
    sessions: [
      { ...descriptor, size: { width: 1, height: 9_000 } },
      { ...descriptor, id: "duplicate" },
      { ...descriptor, id: "bad/id" },
      { ...descriptor, id: "bad-provider", provider: "unknown" }
    ]
  });
  assert.equal(normalized.sessions.length, 2);
  assert.deepEqual(normalized.sessions[0].size, { width: 420, height: 1_100 });
});

test("legacy roles restore as agents while unknown roles are dropped", async () => {
  const { role: _role, ...legacy } = descriptor;
  const normalized = normalizePersistedTerminalSessions({
    version: 1,
    sessions: [
      legacy,
      { ...descriptor, id: "orchestrator", role: "orchestrator" },
      { ...descriptor, id: "bogus-role", role: "worker" },
      { ...descriptor, id: "terminal", provider: "terminal", role: "orchestrator" }
    ]
  });
  assert.deepEqual(normalized.sessions.map((session) => [session.id, session.role]), [
    [descriptor.id, "agent"],
    ["orchestrator", "orchestrator"],
    ["terminal", "agent"]
  ]);

  const directory = await mkdtemp(join(tmpdir(), "canvastty-terminal-state-roles-"));
  try {
    const store = new TerminalSessionStore(directory);
    await store.replace([legacy, { ...descriptor, id: "orchestrator", role: "orchestrator" }]);
    const reloaded = await new TerminalSessionStore(directory).load();
    assert.deepEqual(reloaded.map((session) => session.role), ["agent", "orchestrator"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("threadId persists and normalizes to canonical lower-case UUID for codex provider", async () => {
  const threadIdUpper = "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D";
  const threadIdCanonical = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

  const sessionMetadata = {
    ...descriptor,
    revision: 1,
    status: "idle",
    startedAt: Date.now(),
    exitCode: null,
    failureDetails: null
  };

  // persistedTerminalSession helper round-trips a valid thread id
  const persisted = persistedTerminalSession(sessionMetadata, `  ${threadIdUpper}  `);
  assert.equal(persisted.threadId, threadIdCanonical);

  // Providers with exact UUID resume keep their canonical session id.
  const qwenPersisted = persistedTerminalSession({ ...sessionMetadata, provider: "qwen" }, threadIdUpper);
  assert.equal(qwenPersisted.threadId, threadIdCanonical);
  assert.equal(persistedTerminalSession({ ...sessionMetadata, provider: "claude" }, threadIdUpper).threadId, threadIdCanonical);

  // Malformed thread IDs are ignored in persistedTerminalSession helper
  assert.equal(persistedTerminalSession(sessionMetadata, "not-a-uuid").threadId, undefined);
  assert.equal(persistedTerminalSession(sessionMetadata, 12345).threadId, undefined);

  // Store persistence and load round-trip
  const directory = await mkdtemp(join(tmpdir(), "canvastty-terminal-state-codex-thread-"));
  try {
    const store = new TerminalSessionStore(directory);
    await store.replace([persisted]);
    const reloaded = await store.load();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].threadId, threadIdCanonical);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizePersistedTerminalSessions preserves cards with malformed or foreign thread IDs", () => {
  const validUuid = "11111111-2222-3333-4444-555555555555";
  const normalized = normalizePersistedTerminalSessions({
    version: 1,
    sessions: [
      // Valid codex thread ID, under its v1 name
      { ...descriptor, id: "valid-codex", provider: "codex", codexThreadId: validUuid },
      // Valid codex session without codexThreadId (backward compatibility)
      { ...descriptor, id: "valid-codex-no-thread", provider: "codex" },
      // Malformed thread ID on codex session -> card survives without that ID
      { ...descriptor, id: "bad-uuid", provider: "codex", codexThreadId: "invalid-uuid" },
      // Non-string thread ID on codex session -> card survives without that ID
      { ...descriptor, id: "bad-type-uuid", provider: "codex", codexThreadId: 12345 },
      // codexThreadId attached to non-codex provider -> ignored
      { ...descriptor, id: "claude-with-thread", provider: "claude", codexThreadId: validUuid },
      { ...descriptor, id: "terminal-with-thread", provider: "terminal", codexThreadId: validUuid }
    ]
  });

  assert.deepEqual(normalized.sessions.map((s) => s.id), [
    "valid-codex", "valid-codex-no-thread", "bad-uuid", "bad-type-uuid",
    "claude-with-thread", "terminal-with-thread"
  ]);
  assert.equal(normalized.sessions[0].threadId, validUuid);
  assert.equal(normalized.sessions[1].threadId, undefined);
  assert.ok(normalized.sessions.slice(2).every((session) => session.threadId === undefined));
});

test("a save survives Windows refusing the rename while another handle has the file open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-store-locked-"));
  try {
    let refusals = 3;
    const attempts = [];
    const lockedRename = async (from, to) => {
      attempts.push(to);
      if (refusals > 0) {
        refusals -= 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM" });
      }
      await rename(from, to);
    };
    const store = new TerminalSessionStore(directory, "terminal-sessions.json", { rename: lockedRename, platform: "win32" });
    await store.replace([descriptor]);
    assert.equal(attempts.length, 4, "three refusals, then the rename goes through");
    const saved = JSON.parse(await readFile(join(directory, "terminal-sessions.json"), "utf8"));
    assert.deepEqual(saved.sessions.map((session) => session.id), [descriptor.id]);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);

    // Elsewhere the same error is not a transient lock: it fails at once and leaves no temp file.
    refusals = 1;
    attempts.length = 0;
    const posix = new TerminalSessionStore(directory, "terminal-sessions.json", { rename: lockedRename, platform: "linux" });
    await assert.rejects(posix.replace([descriptor]), /EPERM/u);
    assert.equal(attempts.length, 1);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
