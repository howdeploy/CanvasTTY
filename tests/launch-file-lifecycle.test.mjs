import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { EnvironmentRegistry } from "../src/main/services/EnvironmentRegistry.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { persistedTerminalSession } from "../src/main/services/TerminalSessionStore.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { spawnFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctty-launch-files-"));
  const runs = join(root, "runs");
  const calls = [];
  const pipelines = [];
  const gates = [];
  const disposals = [];
  const fake = fakeSpawner(calls);
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, (...args) => {
    if (spawnFailure) throw new Error("fixture PTY spawn failure");
    return fake(...args);
  });
  // Closing a card starts its run-file cleanup in the background; the tests await that same promise.
  const forget = terminals.forgetLaunchFiles.bind(terminals);
  terminals.forgetLaunchFiles = (session) => {
    const pending = forget(session);
    disposals.push(pending);
    return pending;
  };
  const gate = () => {
    const result = deferred();
    gates.push(result);
    return result;
  };

  function pipeline({ holdPrepare = false, holdForget = false, failCleanup = false } = {}) {
    const started = deferred();
    const release = gate();
    const forgetStarted = deferred();
    const forgetRelease = gate();
    const events = [];
    const rows = [];
    if (!holdPrepare) release.resolve();
    if (!holdForget) forgetRelease.resolve();
    const value = new LaunchPipeline({
      contributors: () => [{
        pluginId: "fixture.files",
        pluginName: "Files",
        serviceId: "launch",
        secrets: false,
        launch: { fields: [{ key: "enabled", label: "Enabled", kind: "boolean" }] }
      }],
      call: async () => {
        started.resolve();
        await release.promise;
        return { env: { FIXTURE_FILE: "{launchFiles}/run.txt" }, files: [{ relPath: "run.txt", content: "temporary" }] };
      },
      secret: async () => null,
      runsRoot: runs,
      timeoutMs: 4000
    });
    const prepare = value.prepare.bind(value);
    const remove = value.forgetSession.bind(value);
    value.prepare = async (context) => {
      const result = await prepare(context);
      assert.equal(result.ok, true);
      const row = { file: result.env.FIXTURE_FILE, runDirectory: result.runDirectory, cleanupCalls: 0 };
      const cleanup = result.cleanup;
      rows.push(row);
      result.cleanup = async () => {
        row.cleanupCalls++;
        events.push("child");
        if (failCleanup) throw new Error("fixture cleanup failure");
        await cleanup();
      };
      return result;
    };
    value.forgetSession = async (id, runDirectories) => {
      events.push("parent:start");
      forgetStarted.resolve();
      await forgetRelease.promise;
      await remove(id, runDirectories);
      events.push("parent:done");
    };
    const result = { value, started, release, forgetStarted, forgetRelease, events, rows };
    pipelines.push(result);
    return result;
  }

  const create = (extra = {}) => terminals.create({
    provider: "codex",
    profile: "normal",
    cwd: root,
    position: { x: 0, y: 0 },
    launchOptions: { "fixture.files": { enabled: true } },
    ...extra
  });
  const drain = async () => { await Promise.allSettled(disposals); };
  t.after(async () => {
    for (const item of gates) item.resolve();
    terminals.disposeAll();
    await drain();
    await rm(root, { recursive: true, force: true });
  });
  return { root, runs, calls, terminals, pipeline, create, gate, drain, disposals };
}

for (const failCleanup of [false, true]) {
  test(`closing during preparation drains its late files before parent deletion (${failCleanup ? "failed" : "successful"} child cleanup)`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    const p = f.pipeline({ holdPrepare: true, failCleanup });
    f.terminals.configureLaunchPipeline(p.value);
    const session = f.create();
    await p.started.promise;
    f.terminals.dispose(session.id);
    assert.deepEqual(p.events, []);

    p.release.resolve();
    await f.drain();
    assert.deepEqual(p.events, ["child", "parent:start", "parent:done"]);
    assert.equal(p.rows[0].cleanupCalls, 1);
    assert.equal(f.calls.length, 0);
    // A failed child cleanup is retried by the parent step, which still removes only this card's own run folder.
    await assert.rejects(stat(join(f.runs, session.id)), { code: "ENOENT" });
  });
}

test("restart tracks both pending preparations and sequentially forgets their original pipelines after reconfiguration", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const a = f.pipeline({ holdPrepare: true, holdForget: true });
  const b = f.pipeline({ holdPrepare: true });
  const c = f.pipeline();
  f.terminals.configureLaunchPipeline(a.value);
  const session = f.create();
  await a.started.promise;
  // Force a restart while its original plugin response is still in flight, as restoration can do.
  const internal = f.terminals.sessions.get(session.id);
  internal.metadata.status = "failed";
  internal.metadata.exitCode = 1;
  f.terminals.configureLaunchPipeline(b.value);
  f.terminals.restart(session.id);
  await b.started.promise;
  f.terminals.configureLaunchPipeline(c.value);
  f.terminals.dispose(session.id);

  a.release.resolve();
  await Promise.resolve();
  assert.deepEqual(a.events, [], "parent cannot precede pending preparation");
  b.release.resolve();
  await a.forgetStarted.promise;
  assert.deepEqual(a.events, ["child", "parent:start"]);
  assert.deepEqual(b.events, ["child"], "same parent cannot be removed concurrently by another pipeline");
  assert.deepEqual(c.events, [], "current configuration is not the owner");

  a.forgetRelease.resolve();
  await f.drain();
  assert.deepEqual(b.events, ["child", "parent:start", "parent:done"]);
  assert.deepEqual([a.rows[0].cleanupCalls, b.rows[0].cleanupCalls], [1, 1]);
  assert.equal(f.calls.length, 0);
  await assert.rejects(stat(join(f.runs, session.id)), { code: "ENOENT" });
});

for (const outcome of ["success", "refusal", "throw"]) {
  test(`close while environment wrapping ${outcome} releases planned capability and files once`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    const p = f.pipeline();
    f.terminals.configureLaunchPipeline(p.value);
    const wrapping = deferred();
    const release = f.gate();
    let plannedCleanups = 0;
    const plan = f.terminals.planSpawn.bind(f.terminals);
    f.terminals.planSpawn = (...args) => {
      const result = plan(...args);
      assert.ok(!("failure" in result));
      const cleanup = result.cleanup;
      result.cleanup = () => {
        plannedCleanups++;
        cleanup();
      };
      return result;
    };
    const registry = new EnvironmentRegistry({
      providers: () => [{
        pluginId: "fixture.env",
        pluginName: "Environment",
        serviceId: "env",
        secrets: false,
        kinds: [{ kind: "test", label: "Test", fields: [] }]
      }],
      call: async (_plugin, _service, method) => method.endsWith(".prepare") ? { ref: { id: "one" }, label: "Test" } : {},
      secret: async () => null
    });
    registry.wrap = async (_environment, input) => {
      wrapping.resolve();
      await release.promise;
      if (outcome === "throw") throw new Error("fixture wrapper threw");
      if (outcome === "refusal") return { ok: false, reason: "fixture refused" };
      return { ok: true, ...input.launch, secrets: [] };
    };
    f.terminals.configureEnvironments(registry);
    const session = f.create({ environment: { pluginId: "fixture.env", kind: "test" } });
    await wrapping.promise;
    await stat(p.rows[0].file);
    f.terminals.dispose(session.id);
    assert.deepEqual(p.events, []);

    release.resolve();
    await f.drain();
    assert.equal(plannedCleanups, 1);
    assert.equal(p.rows[0].cleanupCalls, 1);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(p.events, ["child", "parent:start", "parent:done"]);
    await assert.rejects(stat(join(f.runs, session.id)), { code: "ENOENT" });
  });
}

test("spawn refusal releases unadopted files and capabilities before eventual parent cleanup", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { spawnFailure: true });
  const p = f.pipeline();
  f.terminals.configureLaunchPipeline(p.value);
  let cleanups = 0;
  const plan = f.terminals.planSpawn.bind(f.terminals);
  f.terminals.planSpawn = (...args) => {
    const result = plan(...args);
    const cleanup = result.cleanup;
    result.cleanup = () => {
      cleanups++;
      cleanup();
    };
    return result;
  };
  const session = f.create();
  const internal = f.terminals.sessions.get(session.id);
  await Promise.all([...internal.launchTasks]);
  assert.equal(internal.metadata.status, "failed");
  assert.equal(cleanups, 1);
  assert.equal(p.rows[0].cleanupCalls, 1);
  assert.deepEqual(p.events, ["child"]);

  f.terminals.dispose(session.id);
  await f.drain();
  assert.deepEqual(p.events, ["child", "parent:start", "parent:done"]);
  await assert.rejects(stat(join(f.runs, session.id)), { code: "ENOENT" });
});

test("a delayed close keeps the run files of a card brought back under the same id", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const p = f.pipeline({ holdForget: true });
  f.terminals.configureLaunchPipeline(p.value);
  const session = f.create();
  const first = f.terminals.sessions.get(session.id);
  await Promise.all([...first.launchTasks]);
  assert.equal(f.calls.length, 1);
  const record = persistedTerminalSession(first.metadata, first.threadId, first.extras);
  const firstRun = p.rows[0].runDirectory;

  // Close the card; its folder removal is held, as a slow disk or a busy Windows file would hold it.
  f.terminals.dispose(session.id);
  await p.forgetStarted.promise;

  // The same card comes back (restore under its saved id) and prepares a new run before the old removal finishes.
  await f.terminals.restoreSessionRecords([{ ...record, lastState: "running" }], "continue");
  const second = f.terminals.sessions.get(session.id);
  assert.ok(second && second !== first);
  await Promise.all([...(second.launchTasks ?? [])]);
  assert.equal(p.rows.length, 2);
  const secondRun = p.rows[1].runDirectory;
  assert.notEqual(secondRun, firstRun);

  p.forgetRelease.resolve();
  await f.drain();
  await assert.rejects(stat(firstRun), { code: "ENOENT" }, "the closed card's own run folder is removed");
  await stat(p.rows[1].file);
  assert.deepEqual(await readdir(join(f.runs, session.id)), [basename(secondRun)], "the newer card's run folder is kept");
});
