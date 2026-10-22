import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import pty from "node-pty";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { persistedTerminalSession } from "../src/main/services/TerminalSessionStore.ts";
import { failureSummary } from "../src/renderer/src/features/home/failureSummary.ts";
import { availableRegistry } from "./helpers/terminal.mjs";

// A subagent whose CLI was killed with SIGKILL showed "done, exit 0", so wait_for_agent reported a crash as success:
// node-pty reports a signal death as { exitCode: 0, signal: 9 }. These tests start real processes (inside sandbox-exec on macOS, as the
// isolation layer wraps an agent there) and kill them.

const at = { x: 0, y: 0 };
const SANDBOX = "/usr/bin/sandbox-exec";
const wrapped = process.platform === "darwin" && existsSync(SANDBOX);
const skip = process.platform === "win32" ? "POSIX signals only" : false;

/** Every launch becomes the given real command tree, wrapped in sandbox-exec where the isolation layer would. */
function realSpawner(argv, spawned) {
  return (_command, _args, options) => {
    const [command, ...args] = wrapped ? [SANDBOX, "-p", "(version 1)(allow default)", ...argv] : argv;
    const child = pty.spawn(command, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: options.cwd, env: { PATH: "/usr/bin:/bin", HOME: options.cwd } });
    spawned.push(child);
    return child;
  };
}

async function setup(t, argv) {
  const root = await mkdtemp(join(tmpdir(), "ctty-signal-exit-"));
  const spawned = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, realSpawner(argv, spawned));
  t.after(async () => {
    terminals.disposeAll();
    for (const child of spawned) { try { process.kill(child.pid, "SIGKILL"); } catch { /* exited */ } }
    await rm(root, { recursive: true, force: true });
  });
  const control = new AgentControlService(terminals);
  const orchestrator = terminals.create({ provider: "opencode", profile: "normal", cwd: root, position: at, role: "orchestrator" });
  return { root, spawned, terminals, control, orchestrator };
}

async function until(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}

const descendants = (pid) => {
  try { return execFileSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); } catch { return []; }
};

test("a subagent whose CLI is killed by SIGKILL is failed (128+9) with the signal named, everywhere its exit is read", { skip }, async (t) => {
  const s = await setup(t, ["/bin/sleep", "30"]);
  const child = await s.control.spawn({ parentSessionId: s.orchestrator.id, provider: "opencode", cwd: s.root });
  const live = s.spawned.at(-1);
  // sandbox-exec execs the CLI: the PTY's own process is the CLI, not a wrapper that could exit 0 after it.
  // (node-pty's spawn-helper and then sandbox-exec exec in place first.)
  // macOS reports an executable path; Linux ps reports only the command name.
  const command = await until(() => { const comm = execFileSync("/bin/ps", ["-o", "comm=", "-p", String(live.pid)], { encoding: "utf8" }).trim(); return basename(comm) === "sleep" ? comm : null; });
  assert.equal(basename(command), "sleep");
  assert.deepEqual(descendants(live.pid), [], "no process below the CLI");
  process.kill(live.pid, "SIGKILL");
  const ended = await until(() => { const m = s.terminals.getMetadata(child.id); return m.exitCode !== null ? m : null; });
  assert.equal(ended.status, "failed");
  assert.equal(ended.exitCode, 137);
  assert.match(ended.failureDetails, /killed by signal SIGKILL \(9\)/u);
  // wait_for_agent and get_agent_result read the same exit.
  const waited = await s.control.waitFor(child.id, { timeoutMs: 1_000 });
  assert.equal(waited.reason, "failed");
  assert.equal(waited.status, "failed");
  assert.equal(waited.exitCode, 137);
  const result = await s.control.result(child.id);
  assert.equal(result.state, "failed");
  assert.equal(result.exitCode, 137);
  // The saved session restores as failed, and HOME's failure summary shows the exit code with the signal line.
  const saved = persistedTerminalSession(ended);
  assert.equal(saved.lastState, "failed");
  assert.equal(saved.exitCode, 137);
  const summary = failureSummary(ended, "en");
  assert.match(summary.headline, /137/u);
  assert.match(summary.diagnostics, /^The process was killed by signal SIGKILL \(9\)\./u);
});

test("a wrapper shell whose CLI child is killed reports the signal as a non-zero exit: the subagent is failed", { skip }, async (t) => {
  const s = await setup(t, ["/bin/sh", "-c", "/bin/sleep 30; exit $?"]);
  const child = await s.control.spawn({ parentSessionId: s.orchestrator.id, provider: "opencode", cwd: s.root });
  const shell = s.spawned.at(-1);
  const cli = await until(() => descendants(shell.pid)[0]);
  process.kill(cli, "SIGKILL");
  const ended = await until(() => { const m = s.terminals.getMetadata(child.id); return m.exitCode !== null ? m : null; });
  assert.equal(ended.status, "failed");
  assert.equal(ended.exitCode, 137);
  // The shell exited normally with 137: no signal reached node-pty, so nothing is named.
  assert.doesNotMatch(ended.failureDetails ?? "", /killed by signal/u);
  assert.equal((await s.control.waitFor(child.id, { timeoutMs: 1_000 })).reason, "failed");
});

test("a clean exit stays done", { skip }, async (t) => {
  const s = await setup(t, ["/usr/bin/true"]);
  const child = await s.control.spawn({ parentSessionId: s.orchestrator.id, provider: "opencode", cwd: s.root });
  const ended = await until(() => { const m = s.terminals.getMetadata(child.id); return m.exitCode !== null ? m : null; });
  assert.equal(ended.status, "done");
  assert.equal(ended.exitCode, 0);
  assert.equal(ended.failureDetails, null);
  assert.equal((await s.control.waitFor(child.id, { timeoutMs: 1_000 })).reason, "done");
  assert.equal((await s.control.result(child.id)).state, "done");
  assert.equal(persistedTerminalSession(ended).lastState, "exited");
});
