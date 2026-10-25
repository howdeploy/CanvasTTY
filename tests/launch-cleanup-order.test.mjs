import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function cleanupPipeline(runs, serviceCalls = []) {
  return new LaunchPipeline({
    contributors: () => [{
      pluginId: "fixture.cleanup",
      pluginName: "Cleanup fixture",
      serviceId: "launch",
      secrets: false,
      launch: { fields: [{ key: "enabled", label: "Enabled", kind: "boolean", default: true }] }
    }],
    call: async (...args) => {
      serviceCalls.push(args);
      return { env: { FIXTURE_FILE: "{launchFiles}/run.txt" }, files: [{ relPath: "run.txt", content: "temporary launch data" }] };
    },
    secret: async () => null,
    runsRoot: runs,
    timeoutMs: 2000
  });
}

const createCard = (terminals, cwd) => terminals.create({
  provider: "codex",
  profile: "normal",
  cwd,
  position: { x: 0, y: 0 },
  launchOptions: { "fixture.cleanup": { enabled: true } }
});

/**
 * One card with a launch plugin. Each run's cleanup is held until the test releases it, and every step of the
 * child (run folder) and parent (card folder) removals is recorded in `events`.
 */
async function fixture(t, { rejectChild = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctty-cleanup-order-"));
  const runs = join(root, "runs");
  const rows = [];
  const calls = [];
  const events = [];
  const spawned = [deferred(), deferred()];
  const forgotten = deferred();
  const pipeline = cleanupPipeline(runs);
  const prepare = pipeline.prepare.bind(pipeline);
  const forget = pipeline.forgetSession.bind(pipeline);
  pipeline.prepare = async (context) => {
    const contribution = await prepare(context);
    assert.equal(contribution.ok, true);
    const cleanup = contribution.cleanup;
    const index = rows.length;
    const row = { started: deferred(), release: deferred(), calls: 0 };
    rows.push(row);
    contribution.cleanup = async () => {
      row.calls++;
      events.push(`child${index}:start`);
      row.started.resolve();
      try {
        await row.release.promise;
        if (rejectChild) throw new Error("fixture child cleanup failure");
        await cleanup();
      } finally {
        events.push(`child${index}:settled`);
      }
    };
    return contribution;
  };
  let forgetCalls = 0;
  pipeline.forgetSession = (id, runDirectories) => {
    forgetCalls++;
    events.push("parent:start");
    const pending = forget(id, runDirectories).then(() => { events.push("parent:done"); });
    forgotten.resolve(pending);
    return pending;
  };
  const fake = fakeSpawner(calls);
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, (...args) => {
    const pty = fake(...args);
    spawned[calls.length - 1]?.resolve();
    return pty;
  });
  terminals.configureLaunchPipeline(pipeline);
  t.after(async () => {
    for (const row of rows) row.release.resolve();
    terminals.disposeAll();
    await forgotten.promise;
    await rm(root, { recursive: true, force: true });
  });
  const session = createCard(terminals, root);
  await spawned[0].promise;
  return { root, runs, rows, calls, events, spawned, forgotten, terminals, session, forgetCalls: () => forgetCalls };
}

for (const exited of [false, true]) {
  for (const rejectChild of [false, true]) {
    test(`parent launch cleanup waits for ${exited ? "previous exit" : "active disposal"} cleanup (${rejectChild ? "rejection" : "success"})`, { timeout: 5000 }, async (t) => {
      const f = await fixture(t, { rejectChild });
      if (exited) f.calls[0].process.emitExit(1);
      f.terminals.dispose(f.session.id);
      f.terminals.dispose(f.session.id);
      await f.rows[0].started.promise;
      assert.equal(f.forgetCalls(), 0, "parent removal must not overlap a held child removal");
      assert.deepEqual(f.events, ["child0:start"]);

      f.rows[0].release.resolve();
      await f.forgotten.promise;
      assert.deepEqual(f.events, ["child0:start", "child0:settled", "parent:start", "parent:done"]);
      assert.equal(f.rows[0].calls, 1);
      assert.equal(f.forgetCalls(), 1, "disposal remains idempotent");
      await assert.rejects(stat(join(f.runs, f.session.id)), { code: "ENOENT" }, "parent still cleaned after child failure");
    });
  }
}

test("restart retains every pending run cleanup and invokes each captured callback once before forgetting the card", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.calls[0].process.emitExit(1);
  await f.rows[0].started.promise;
  f.terminals.restart(f.session.id);
  await f.spawned[1].promise;
  assert.equal(f.rows.length, 2);

  f.terminals.dispose(f.session.id);
  assert.equal(f.rows[1].calls, 0, "the newer cleanup queues behind the old launch callback");
  assert.equal(f.forgetCalls(), 0);
  // A late notification from the old PTY must neither consume nor overwrite the new launch cleanup.
  f.calls[0].process.emitExit(1);
  f.rows[0].release.resolve();
  await f.rows[1].started.promise;
  assert.equal(f.forgetCalls(), 0, "parent waits for both run directories");

  f.rows[1].release.resolve();
  await f.forgotten.promise;
  assert.deepEqual(f.events, ["child0:start", "child0:settled", "child1:start", "child1:settled", "parent:start", "parent:done"]);
  assert.deepEqual(f.rows.map((row) => row.calls), [1, 1]);
  assert.equal(f.forgetCalls(), 1);
  await assert.rejects(stat(join(f.runs, f.session.id)), { code: "ENOENT" });
});

test("a launch for a card closed in the same tick never asks its plugins or spawns", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-cleanup-order-"));
  const serviceCalls = [];
  const calls = [];
  const pipeline = cleanupPipeline(join(root, "runs"), serviceCalls);
  const forgotten = [];
  const forget = pipeline.forgetSession.bind(pipeline);
  pipeline.forgetSession = (...args) => {
    const pending = forget(...args);
    forgotten.push(pending);
    return pending;
  };
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  terminals.configureLaunchPipeline(pipeline);
  t.after(async () => {
    terminals.disposeAll();
    await rm(root, { recursive: true, force: true });
  });

  const session = createCard(terminals, root);
  const internal = terminals.sessions.get(session.id);
  const tasks = [...internal.launchTasks];
  terminals.dispose(session.id);
  await Promise.allSettled(tasks);
  await Promise.allSettled(forgotten);

  assert.equal(serviceCalls.length, 0, "no plugin prepares a launch for a card that is already closed");
  assert.equal(calls.length, 0);
  await assert.rejects(stat(join(root, "runs", session.id)), { code: "ENOENT" });
});

test("a failed launch-file removal at close is reported with the card id", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-cleanup-order-"));
  const calls = [];
  const pipeline = cleanupPipeline(join(root, "runs"));
  const failure = new Error("fixture forget failure");
  const forgotten = deferred();
  pipeline.forgetSession = async () => {
    forgotten.resolve();
    throw failure;
  };
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args); });
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  terminals.configureLaunchPipeline(pipeline);
  t.after(async () => {
    terminals.disposeAll();
    await rm(root, { recursive: true, force: true });
  });

  const session = createCard(terminals, root);
  await Promise.allSettled([...terminals.sessions.get(session.id).launchTasks]);
  terminals.dispose(session.id);
  await forgotten.promise;
  for (let i = 0; i < 20 && !warnings.length; i++) await new Promise((done) => setImmediate(done));

  const warning = warnings.find(([message]) => String(message).includes(session.id));
  assert.ok(warning, "the close reports which card's launch files stayed behind");
  assert.ok(warning[1] instanceof AggregateError);
  assert.deepEqual(warning[1].errors, [failure]);
});
