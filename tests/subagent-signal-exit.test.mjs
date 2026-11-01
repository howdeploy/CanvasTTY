import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pty from "node-pty";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { persistedTerminalSession } from "../src/main/services/TerminalSessionStore.ts";
import { failureSummary } from "../src/renderer/src/features/home/failureSummary.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// node-pty reports a process killed by a signal as { exitCode: 0, signal }. The signal was dropped, so a subagent
// whose CLI was killed (OOM, kill -9) read as "done, exit 0" in wait_for_agent, get_agent_result and the saved session.

const at = { x: 0, y: 0 };
const posix = { skip: process.platform === "win32" ? "POSIX signals only" : false };

async function until(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}

function fakeFixture(t) {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const control = new AgentControlService(terminals);
  const session = terminals.create({ provider: "opencode", profile: "normal", cwd: process.cwd(), position: at });
  return { calls, terminals, control, session };
}

test("an agent whose process a signal ended is failed with 128+signal and the signal named, everywhere its exit is read", async (t) => {
  const f = fakeFixture(t);
  f.calls.at(-1).process.emitExit(0, 15);
  const ended = f.terminals.getMetadata(f.session.id);
  assert.equal(ended.status, "failed");
  assert.equal(ended.exitCode, 143);
  assert.match(ended.failureDetails, /^The process was killed by signal SIGTERM \(15\)\./u);
  const waited = await f.control.waitFor(f.session.id, { timeoutMs: 1_000 });
  assert.equal(waited.reason, "failed");
  assert.equal(waited.exitCode, 143);
  const result = await f.control.result(f.session.id);
  assert.equal(result.state, "failed");
  assert.equal(result.exitCode, 143);
  const saved = persistedTerminalSession(ended);
  assert.equal(saved.lastState, "failed");
  assert.equal(saved.exitCode, 143);
  const summary = failureSummary(ended, "en");
  assert.match(summary.headline, /143/u);
  assert.match(summary.diagnostics, /^The process was killed by signal SIGTERM \(15\)\./u);
});

test("an exit without a signal keeps its own code", async (t) => {
  for (const code of [0, 2]) {
    const f = fakeFixture(t);
    f.calls.at(-1).process.emitExit(code, 0);
    const ended = f.terminals.getMetadata(f.session.id);
    assert.equal(ended.exitCode, code);
    assert.equal(ended.status, code === 0 ? "done" : "failed");
    assert.doesNotMatch(ended.failureDetails ?? "", /killed by signal/u);
  }
});

test("a real agent process killed with SIGKILL is failed (137); one that exits cleanly stays done", posix, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-signal-exit-"));
  const spawned = [];
  let argv = ["/bin/sleep", "30"];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, (_command, _args, options) => {
    const child = pty.spawn(argv[0], argv.slice(1), { name: "xterm-256color", cols: 80, rows: 24, cwd: options.cwd, env: { PATH: "/usr/bin:/bin", HOME: options.cwd } });
    spawned.push(child);
    return child;
  });
  t.after(async () => {
    terminals.disposeAll();
    // Only the processes this test started.
    for (const child of spawned) { try { process.kill(child.pid, "SIGKILL"); } catch { /* exited */ } }
    await rm(root, { recursive: true, force: true });
  });
  const control = new AgentControlService(terminals);
  const killed = terminals.create({ provider: "opencode", profile: "normal", cwd: root, position: at });
  process.kill(spawned.at(-1).pid, "SIGKILL");
  const ended = await until(() => { const m = terminals.getMetadata(killed.id); return m.exitCode !== null ? m : null; });
  assert.equal(ended.status, "failed");
  assert.equal(ended.exitCode, 137);
  assert.match(ended.failureDetails, /killed by signal SIGKILL \(9\)/u);
  assert.equal((await control.waitFor(killed.id, { timeoutMs: 1_000 })).reason, "failed");

  argv = ["/usr/bin/true"];
  const clean = terminals.create({ provider: "opencode", profile: "normal", cwd: root, position: at });
  const done = await until(() => { const m = terminals.getMetadata(clean.id); return m.exitCode !== null ? m : null; });
  assert.equal(done.status, "done");
  assert.equal(done.exitCode, 0);
  assert.equal(done.failureDetails, null);
  assert.equal((await control.result(clean.id)).state, "done");
});
