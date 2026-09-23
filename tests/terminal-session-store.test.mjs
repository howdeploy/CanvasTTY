import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TerminalSessionStore,
  normalizePersistedTerminalSessions
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
  size: { width: 700, height: 430 }
};

test("terminal window descriptors persist atomically without scrollback or environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-terminal-state-"));
  try {
    const store = new TerminalSessionStore(directory);
    await store.replace([descriptor]);
    const raw = await readFile(store.filePath, "utf8");
    assert.doesNotMatch(raw, /buffer|environment|capability|token/u);

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

test("records written before roles existed restore as agents; only an explicit orchestrator survives", async () => {
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
    ["bogus-role", "agent"],
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
