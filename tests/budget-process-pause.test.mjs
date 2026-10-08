import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const at = { x: 0, y: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bytes(path) {
  try { return (await readFile(path)).length; } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function waitForAll(paths) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const values = await Promise.all(paths.map(bytes));
    if (values.every((value) => value >= 3)) return values;
    await sleep(20);
  }
  assert.fail("the PTY process and its descendants did not start writing");
}

test("budget pause suspends and resumes the owned PTY process group, including descendants", async (t) => {
  if (process.platform === "win32") return t.skip("Windows process-tree suspension is explicitly unsupported");

  const cwd = await mkdtemp(join(tmpdir(), "ctty-budget-pause-"));
  const descendantFile = join(cwd, "descendant-count");
  const parentFile = join(cwd, "parent-count");
  let child;
  let terminals;
  t.after(async () => {
    try {
      await terminals?.shutdown();
      if (child?.pid && child.exitCode === null) {
        try { process.kill(-child.pid, "SIGCONT"); } catch {}
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        await Promise.race([once(child, "exit").catch(() => undefined), sleep(1_000)]);
      }
    } finally {
      // Remove counters only after their writers and the manager's pending teardown have finished.
      await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });
  let spawnCount = 0;
  const spawner = () => {
    spawnCount += 1;
    child = spawn("/bin/sh", ["-c",
      '(while :; do printf x >> "$1"; sleep 0.02; done) & while :; do printf x >> "$2"; sleep 0.02; done',
      "budget-counter", descendantFile, parentFile], { cwd, detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid;
    assert.ok(Number.isInteger(pid) && pid > 0);
    return {
      pid,
      write() {},
      resize() {},
      onData() { return { dispose() {} }; },
      onExit(callback) { child.once("exit", (exitCode) => callback({ exitCode: exitCode ?? 1 })); },
      kill() {
        try { process.kill(-pid, "SIGCONT"); } catch {}
        try { process.kill(-pid, "SIGTERM"); } catch {}
      }
    };
  };
  terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, spawner);
  const session = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });

  await waitForAll([descendantFile, parentFile]);
  const result = terminals.setBudgetPaused(session.id, true);
  assert.equal(result.supported, true);
  assert.equal(result.failed, undefined);

  // SIGSTOP is delivered asynchronously; allow the kernel to stop every member of the process group before taking
  // the baseline. Then prove both counters remain fixed over a full interval.
  await sleep(150);
  const whilePaused = await Promise.all([bytes(descendantFile), bytes(parentFile)]);
  await sleep(300);
  assert.deepEqual(await Promise.all([bytes(descendantFile), bytes(parentFile)]), whilePaused,
    "neither the PTY shell nor its descendant should execute while paused");
  assert.equal(terminals.inputChecked(session.id, "forbidden input"), false, "ordinary input is blocked while paused");
  assert.equal(terminals.inputChecked(session.id, "\x03"), true, "the person's interrupt remains available");
  assert.throws(() => terminals.create({ provider: "opencode", profile: "normal", cwd, position: at,
    role: "subagent", parentSessionId: session.id }), /usage budget is paused/u);
  assert.equal(spawnCount, 1, "a subagent cannot be launched through a paused root");
  assert.throws(() => terminals.restart(session.id), /usage budget is paused/u);

  const resumed = terminals.setBudgetPaused(session.id, false);
  assert.equal(resumed.supported, true);
  const resumeDeadline = Date.now() + 3_000;
  let afterResume;
  do {
    afterResume = await Promise.all([bytes(descendantFile), bytes(parentFile)]);
    if (afterResume.every((value, index) => value > whilePaused[index])) break;
    await sleep(20);
  } while (Date.now() < resumeDeadline);
  assert.ok(afterResume[0] > whilePaused[0], "the descendant resumes with its parent");
  assert.ok(afterResume[1] > whilePaused[1], "the PTY shell resumes");
});

test("a launch already waiting on a contributor cannot start until its task budget resumes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ctty-budget-launch-"));
  let terminals;
  t.after(async () => {
    await terminals?.shutdown();
    await rm(cwd, { recursive: true, force: true });
  });
  let finishPrepare;
  const pipeline = {
    hasPolicy: () => true,
    normalizeOptions: (_provider, options) => options,
    unavailable: () => [],
    forgetSession: async () => undefined,
    prepare: () => new Promise((resolve) => { finishPrepare = resolve; })
  };
  const calls = [];
  terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  terminals.configureLaunchPipeline(pipeline);
  const session = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  const deadline = Date.now() + 1_000;
  while (!finishPrepare && Date.now() < deadline) await sleep(10);
  assert.equal(typeof finishPrepare, "function", "the launch contributor is holding startup");

  const paused = terminals.setBudgetPaused(session.id, true);
  if (process.platform === "win32") {
    // Windows cannot suspend a process tree and says so, but the host launch gate still closes.
    assert.equal(paused.supported, false);
    assert.match(paused.failed, /cannot safely suspend/u);
  } else {
    assert.equal(paused.supported, true);
  }
  finishPrepare({ ok: true, env: {}, args: [], secrets: [], envSources: {}, thirdPartyModel: false, cleanup: async () => undefined });
  await sleep(100);
  assert.equal(calls.length, 0, "the completed contributor answer must not bypass the task pause");

  assert.equal(terminals.setBudgetPaused(session.id, false).supported, true);
  const launchDeadline = Date.now() + 1_000;
  while (calls.length === 0 && Date.now() < launchDeadline) await sleep(10);
  assert.equal(calls.length, 1, "clearing the budget pause releases the waiting launch");
});

test("budget pause also suspends a descendant that moved to its own session with setsid()", async (t) => {
  if (process.platform === "win32") return t.skip("Windows process-tree suspension is explicitly unsupported");
  const cwd = await mkdtemp(join(tmpdir(), "ctty-budget-setsid-"));
  const detachedFile = join(cwd, "detached-count");
  const parentFile = join(cwd, "parent-count");
  const pidFile = join(cwd, "detached-pid");
  let child;
  let terminals;
  const killDetached = async () => {
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, "SIGCONT"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
  };
  t.after(async () => {
    try {
      await killDetached();
      await terminals?.shutdown();
      if (child?.pid && child.exitCode === null) {
        try { process.kill(-child.pid, "SIGCONT"); } catch {}
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        await Promise.race([once(child, "exit").catch(() => undefined), sleep(1_000)]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });
  const spawner = () => {
    // The detached writer calls setsid(), so it leaves the PTY's process group and session; its parent stays the
    // PTY shell, which is how the host can still attribute it to the task.
    child = spawn("/bin/sh", ["-c",
      'perl -MPOSIX -e \'POSIX::setsid() or die "setsid"; open(my $f, ">", $ARGV[1]); print $f "$$"; close $f; exec "/bin/sh", "-c", "while :; do printf x >> \\"\\$0\\"; sleep 0.02; done", $ARGV[0]\' "$1" "$3" & while :; do printf x >> "$2"; sleep 0.02; done',
      "budget-setsid", detachedFile, parentFile, pidFile], { cwd, detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid;
    return {
      pid,
      write() {},
      resize() {},
      onData() { return { dispose() {} }; },
      onExit(callback) { child.once("exit", (exitCode) => callback({ exitCode: exitCode ?? 1 })); },
      kill() { try { process.kill(-pid, "SIGCONT"); } catch {} try { process.kill(-pid, "SIGTERM"); } catch {} }
    };
  };
  terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, spawner);
  const session = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  await waitForAll([detachedFile, parentFile]);
  const detachedPid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(detachedPid > 1);
  assert.notEqual(detachedPid, child.pid);

  const result = terminals.setBudgetPaused(session.id, true);
  assert.deepEqual(result, { supported: true });
  await sleep(150);
  const whilePaused = await Promise.all([bytes(detachedFile), bytes(parentFile)]);
  await sleep(300);
  assert.deepEqual(await Promise.all([bytes(detachedFile), bytes(parentFile)]), whilePaused,
    "a descendant in its own session must not keep running while the task is paused");

  assert.deepEqual(terminals.setBudgetPaused(session.id, false), { supported: true });
  await sleep(250);
  const afterResume = await Promise.all([bytes(detachedFile), bytes(parentFile)]);
  assert.ok(afterResume[0] > whilePaused[0], "the detached descendant resumes with the task");
  assert.ok(afterResume[1] > whilePaused[1], "the PTY shell resumes");
});
