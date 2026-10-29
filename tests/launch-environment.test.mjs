import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectedLaunchEnvironment } from "../src/agent-runtime/launch-environment.mjs";
import { providerChildProcessLaunch } from "../src/main/services/providerCliRegistry.ts";
import { TerminalManager, terminalEnvironment } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { fakeSpawner } from "./helpers/terminal.mjs";

const disconnected = (code) => { throw Object.assign(new Error(code), { code }); };

test("disconnected search directories are removed without mutating cached environment or changing precedence", () => {
  const source = Object.freeze({ PATH: "/custom:/old:/missing::relative:/denied:/usr/bin", KEEP: "unchanged" });
  const inspect = (directory) => {
    if (directory === "/old") disconnected("ENOTCONN");
    if (directory === "/missing") disconnected("ENOENT");
    if (directory === "/denied") disconnected("EACCES");
  };
  const result = connectedLaunchEnvironment(source, "linux", inspect);
  assert.equal(result.PATH, "/custom:/missing::relative:/denied:/usr/bin");
  assert.equal(result.KEEP, "unchanged");
  assert.equal(source.PATH, "/custom:/old:/missing::relative:/denied:/usr/bin");
  assert.equal(connectedLaunchEnvironment(source, "linux", () => {}), source);
});

test("a search path is checked again after a previously healthy mount disconnects", () => {
  const source = Object.freeze({ PATH: "/mounted:/tools:/usr/bin" });
  let connected = true;
  const inspect = (directory) => { if (directory === "/mounted" && !connected) disconnected("ENOTCONN"); };
  assert.equal(connectedLaunchEnvironment(source, "linux", inspect), source);
  connected = false;
  assert.equal(connectedLaunchEnvironment(source, "linux", inspect).PATH, "/tools:/usr/bin");
  connected = true;
  assert.equal(connectedLaunchEnvironment(source, "linux", inspect), source);
});

test("stale and detached filesystems do not abort a later executable search", () => {
  for (const code of ["ENOTCONN", "ESTALE", "ENODEV", "EIO"]) {
    const result = connectedLaunchEnvironment({ PATH: "/bad:/good" }, "darwin", (p) => {
      if (p === "/bad") disconnected(code);
    });
    assert.equal(result.PATH, "/good", code);
  }
});

test("Windows keeps Path spelling, quoting and ordering; POSIX does not treat Path as PATH", () => {
  const result = connectedLaunchEnvironment({ Path: '"C:\\old mount";C:\\tools;;C:\\Windows', KEEP: "yes" }, "win32", (p) => {
    if (p === "C:\\old mount") disconnected("ENOTCONN");
  });
  assert.deepEqual(result, { Path: "C:\\tools;;C:\\Windows", KEEP: "yes" });
  const posix = { Path: "/not-the-search-path" };
  assert.equal(connectedLaunchEnvironment(posix, "linux", () => disconnected("ENOTCONN")), posix);
  const empty = {};
  assert.equal(connectedLaunchEnvironment(empty), empty);
});

const dead = process.env.CANVASTTY_TEST_DEAD_PATH;
test("real disconnected AppImage: new, restarted and restored orchestrators launch without killing existing cards", {
  skip: !dead || process.platform !== "linux" ? "Requires an existing disconnected Linux mount supplied by the operator" : false
}, async (t) => {
  const search = `${dead}:/usr/bin:/bin`;
  const old = spawnSync("/usr/bin/env", ["node", "--version"], { env: { PATH: search }, encoding: "utf8" });
  assert.equal(old.status, 126);
  assert.match(old.stderr, /Transport endpoint is not connected/);
  const cached = Object.freeze({ PATH: search });
  const resolution = (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`,
    launcher: "native", environment: cached, checked: [] });
  const probe = (environment) => {
    assert.equal(environment.PATH.includes(dead), false);
    const result = spawnSync("/usr/bin/env", ["node", "--version"], { env: environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^v\d+/);
  };
  probe(providerChildProcessLaunch(resolution("codex"), []).environment);
  probe(terminalEnvironment({ PATH: search, CANVASTTY_ORCHESTRATION_CAPABILITY: "must-not-leak" }));
  const root = await mkdtemp(join(tmpdir(), "ctty-launch-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = (calls) => {
    const spawner = fakeSpawner(calls);
    const manager = new TerminalManager(() => {}, { get: resolution }, undefined, undefined, true,
      (command, args, options) => { probe(options.env); return spawner(command, args, options); });
    manager.setControlConnection({ connectionPath: "/person/connection.json", cliPath: "/app/control.mjs",
      grant: (id) => `/private/${id}/connection.json` });
    manager.configureSessionPersistence(new TerminalSessionStore(root), "continue");
    return manager;
  };
  const calls = [];
  const manager = make(calls);
  t.after(() => manager.shutdown());
  const oldCard = manager.create({ provider: "codex", profile: "normal", role: "orchestrator", cwd: root, position: { x: 0, y: 0 } });
  const originalPty = calls[0].process;
  const next = manager.create({ provider: "codex", profile: "normal", role: "orchestrator", cwd: root, position: { x: 0, y: 0 } });
  assert.equal(calls[0].process, originalPty);
  assert.equal(manager.getMetadata(oldCard.id).exitCode, null);
  for (const call of calls) assert.match(call.options.env.CANVASTTY_CONTROL_CONNECTION, /^\/private\//);
  assert.notEqual(calls[0].options.env.CANVASTTY_CONTROL_CONNECTION, calls[1].options.env.CANVASTTY_CONTROL_CONNECTION);
  calls[1].process.emitExit(126);
  manager.restart(next.id);
  assert.equal(manager.getMetadata(oldCard.id).exitCode, null);
  assert.equal(manager.getMetadata(next.id).exitCode, null);
  await manager.shutdown();
  const restoredCalls = [];
  const restored = make(restoredCalls);
  t.after(() => restored.shutdown());
  await restored.restorePersistedSessions();
  assert.equal(restoredCalls.length, 2);
  for (const call of restoredCalls) {
    assert.match(call.options.env.CANVASTTY_CONTROL_CONNECTION, /^\/private\//);
    assert.equal(call.args.at(-1), "resume");
  }
  assert.equal(cached.PATH, search);
});
