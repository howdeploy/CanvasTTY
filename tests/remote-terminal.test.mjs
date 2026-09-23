import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import {
  TerminalSessionStore,
  normalizePersistedTerminalSessions,
  persistedTerminalSession
} from "../src/main/services/TerminalSessionStore.ts";
import { remoteTerminalLaunch } from "../src/main/services/remoteTerminalLaunch.ts";

const HOSTS = {
  "gpu-box": { id: "gpu-box", label: "GPU box", sshHost: "gpu.internal.example" },
  "build-farm": {
    id: "build-farm",
    label: "Build farm",
    sshHost: "192.168.1.40",
    sshUser: "deploy",
    sshPort: 2222
  }
};

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
    let exitHandler = null;
    const process = {
      pid: 20_000 + calls.length,
      write() {},
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      onData() { return { dispose() {} }; },
      onExit(handler) { exitHandler = handler; return { dispose() {} }; }
    };
    calls.push({ command, args, options, exit: (code) => exitHandler?.({ exitCode: code }) });
    return process;
  };
}

function manager(calls, hostsById = null) {
  const terminal = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  if (hostsById) {
    terminal.configureRemoteHosts((hostId) => hostsById[hostId] ?? null);
  }
  return terminal;
}

test("remoteTerminalLaunch composes ssh with no port and no user and runs the remote login shell", () => {
  assert.deepEqual(
    remoteTerminalLaunch(HOSTS["gpu-box"]),
    { command: "ssh", args: ["-tt", "gpu.internal.example"] }
  );
});

test("remoteTerminalLaunch adds -p for a port and user@ for a user", () => {
  assert.deepEqual(
    remoteTerminalLaunch(HOSTS["build-farm"], null),
    { command: "ssh", args: ["-tt", "-p", "2222", "deploy@192.168.1.40"] }
  );
});

test("remoteTerminalLaunch starts inside a mapped folder with the server's own shell, never the local one", () => {
  assert.deepEqual(
    remoteTerminalLaunch(HOSTS["gpu-box"], "/srv/it's here"),
    { command: "ssh", args: ["-tt", "gpu.internal.example", `cd '/srv/it'\\''s here' && exec "\${SHELL:-/bin/sh}" -l`] }
  );
  assert.throws(() => remoteTerminalLaunch(HOSTS["gpu-box"], "/srv/a\nrm -rf ~"), /quoted/);
});

test("a terminal session with a valid hostId spawns ssh through the PTY", () => {
  const calls = [];
  const terminal = manager(calls, HOSTS);
  const session = terminal.create({
    provider: "terminal",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    hostId: "build-farm"
  });
  assert.equal(session.hostId, "build-farm");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.deepEqual(
    calls[0].args,
    remoteTerminalLaunch(HOSTS["build-farm"]).args
  );
  // TERM/COLORTERM stay identical to what a local terminal PTY receives.
  assert.equal(calls[0].options.env.TERM, "xterm-256color");
  assert.equal(calls[0].options.env.COLORTERM, "truecolor");
  terminal.disposeAll();
});

test("a terminal session without hostId still spawns the local shell", () => {
  const calls = [];
  const terminal = manager(calls, HOSTS);
  const session = terminal.create({
    provider: "terminal",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  assert.equal("hostId" in session, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, calls[0].options.env.SHELL || "/bin/bash");
  assert.deepEqual(calls[0].args, ["-l"]);
  assert.equal(calls[0].options.env.TERM, "xterm-256color");
  assert.equal(calls[0].options.env.COLORTERM, "truecolor");
  terminal.disposeAll();
});

test("an unknown hostId throws on create without spawning or leaving a session", () => {
  const calls = [];
  const terminal = manager(calls, HOSTS);
  assert.throws(
    () => terminal.create({
      provider: "terminal",
      cwd: process.cwd(),
      profile: "normal",
      position: { x: 0, y: 0 },
      hostId: "gone"
    }),
    /Remote host gone is not configured/u
  );
  assert.equal(calls.length, 0);
  assert.equal(terminal.list().length, 0);
  terminal.disposeAll();
});

test("a hostId without any configured remote-host resolver throws on create", () => {
  const calls = [];
  const terminal = manager(calls);
  assert.throws(
    () => terminal.create({
      provider: "terminal",
      cwd: process.cwd(),
      profile: "normal",
      position: { x: 0, y: 0 },
      hostId: "gpu-box"
    }),
    /Remote host gpu-box is not configured/u
  );
  assert.equal(calls.length, 0);
  terminal.disposeAll();
});

test("a non-string hostId is rejected as an invalid create request", () => {
  const calls = [];
  const terminal = manager(calls, HOSTS);
  assert.throws(
    () => terminal.create({
      provider: "terminal",
      cwd: process.cwd(),
      profile: "normal",
      position: { x: 0, y: 0 },
      hostId: 42
    }),
    /Session host id must be a string/u
  );
  assert.equal(calls.length, 0);
  terminal.disposeAll();
});

// Remote agent launches (roadmap C3): an agent session with a hostId runs its
// provider CLI over ssh, and that requires the project folder to be mapped on
// the host — gpu-box carries no workspace table, so the create fails loudly
// before any session exists.
test("an agent session with a hostId requires a mapped workspace on the host", () => {
  const calls = [];
  const terminal = manager(calls, HOSTS);
  assert.throws(
    () => terminal.create({
      provider: "codex",
      cwd: process.cwd(),
      profile: "normal",
      position: { x: 0, y: 0 },
      hostId: "gpu-box"
    }),
    /is not mapped on host gpu-box/u
  );
  assert.equal(calls.length, 0);
  terminal.disposeAll();
});

test("restart re-spawns ssh for a remote terminal session", () => {
  const calls = [];
  const terminal = manager(calls, HOSTS);
  terminal.create({
    provider: "terminal",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    hostId: "gpu-box"
  });
  calls[0].exit(0);
  terminal.restart(terminal.list()[0].id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, "ssh");
  assert.deepEqual(
    calls[1].args,
    remoteTerminalLaunch(HOSTS["gpu-box"]).args
  );
  terminal.disposeAll();
});

test("persistedTerminalSession carries hostId only when present", () => {
  const base = {
    id: "s1",
    revision: 0,
    provider: "terminal",
    profile: "normal",
    title: "Terminal",
    titleCustomized: false,
    cwd: "/tmp",
    position: { x: 0, y: 0 },
    size: { width: 700, height: 430 },
    role: "interactive",
    status: "idle",
    startedAt: 0,
    exitCode: null,
    failureDetails: null
  };
  assert.equal(persistedTerminalSession({ ...base, hostId: "gpu-box" }).hostId, "gpu-box");
  assert.equal("hostId" in persistedTerminalSession(base), false);
});

test("persisted sessions with an unknown-format hostId are dropped", () => {
  const entry = (id, hostId) => ({
    id,
    provider: "terminal",
    profile: "normal",
    title: `Terminal ${id}`,
    titleCustomized: false,
    cwd: "/tmp",
    position: { x: 0, y: 0 },
    size: { width: 700, height: 430 },
    ...(hostId !== undefined ? { hostId } : {})
  });
  const normalized = normalizePersistedTerminalSessions({
    version: 1,
    sessions: [
      entry("remote-1", "gpu-box"),
      entry("bad-number", 42),
      entry("bad-empty", ""),
      entry("bad-long", "x".repeat(65)),
      entry("local-1")
    ]
  });
  assert.deepEqual(
    normalized.sessions.map((session) => [session.id, session.hostId ?? null]).sort(),
    [["local-1", null], ["remote-1", "gpu-box"]]
  );
});

test("remote terminal descriptors persist hostId and restoring re-spawns ssh", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-remote-terminal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const calls = [];
  const first = manager(calls, HOSTS);
  first.configureSessionPersistence(new TerminalSessionStore(directory), true);
  first.create({
    provider: "terminal",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    hostId: "gpu-box"
  });
  await first.shutdown();

  const raw = JSON.parse(await readFile(join(directory, "terminal-sessions.json"), "utf8"));
  assert.equal(raw.sessions.length, 1);
  assert.equal(raw.sessions[0].hostId, "gpu-box");

  const restoredCalls = [];
  const second = manager(restoredCalls, HOSTS);
  second.configureSessionPersistence(new TerminalSessionStore(directory), true);
  await second.restorePersistedSessions();
  assert.equal(restoredCalls.length, 1);
  assert.equal(restoredCalls[0].command, "ssh");
  assert.deepEqual(
    restoredCalls[0].args,
    remoteTerminalLaunch(HOSTS["gpu-box"]).args
  );
  const restored = second.list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].hostId, "gpu-box");
  await second.shutdown();
});

test("restoring a remote session whose host was removed restores it as failed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-remote-terminal-unknown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const calls = [];
  const first = manager(calls, HOSTS);
  first.configureSessionPersistence(new TerminalSessionStore(directory), true);
  first.create({
    provider: "terminal",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    hostId: "gpu-box"
  });
  await first.shutdown();

  // No configureRemoteHosts on the second manager: the host registry is empty,
  // so the descriptor still restores (as a failed session) instead of aborting
  // the whole restore loop.
  const restoredCalls = [];
  const second = manager(restoredCalls);
  second.configureSessionPersistence(new TerminalSessionStore(directory), true);
  await second.restorePersistedSessions();
  assert.equal(restoredCalls.length, 0);
  const restored = second.list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, "failed");
  assert.match(restored[0].failureDetails, /Remote host gpu-box is not configured/u);
  await second.shutdown();
});
