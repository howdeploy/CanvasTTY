import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// wait_for_agent reports each approval request once, with its prompt. CLIs tell a request in different ways: OpenCode's
// permission.asked can come before the prompt is drawn, Qwen's title says needs_approval before its PermissionRequest
// hook for the same prompt, and Grok's permission_prompt Notification is its only request hook.

const at = { x: 0, y: 0 };
const PROMPT = "\x1b[2J\x1b[HPermission required\r\n  $ rm -rf build\r\n> Allow once   Allow always   Reject";

async function fixture(t, provider, timing = { checkMs: 5, settleMs: 20, quietMs: 60_000 }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-approval-signals-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.shutdown());
  const control = new AgentControlService(terminals, { waitTiming: timing });
  const orchestrator = terminals.create({ provider: "claude", profile: "normal", cwd: root, position: at, role: "orchestrator" });
  const child = terminals.create({ provider, profile: "normal", cwd: root, position: at, role: "subagent", parentSessionId: orchestrator.id });
  const pty = calls.at(-1).process;
  const signal = (event, source = "hook") => terminals.applyProviderSignal(child.id, { kind: "lifecycle", state: "needs_approval", event }, source);
  return { terminals, control, child, pty, signal };
}

async function pending(promise, ms = 150) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await delay(ms);
  return !settled;
}

test("an approval signalled before its prompt is drawn is reported with the prompt, and still only once", async (t) => {
  const { control, child, pty, signal } = await fixture(t, "opencode", { checkMs: 5, settleMs: 2_000, quietMs: 60_000 });
  signal("permission.asked");
  const wait = control.waitFor(child.id, { timeoutMs: 5_000 });
  await delay(60);
  pty.emitData(PROMPT);
  const reported = await wait;
  assert.equal(reported.reason, "needs_approval");
  assert.match(reported.output, /rm -rf build/, "the prompt is in the output");
  assert.ok(reported.waitedMs < 1_500, `returned once the prompt was drawn, not at the settle limit (${reported.waitedMs} ms)`);
  assert.equal(await pending(control.waitFor(child.id, { timeoutMs: 5_000 })), true, "the next wait waits for the person");
});

test("an approval whose screen never changes is still reported after the settle time", async (t) => {
  const { control, child, signal } = await fixture(t, "opencode", { checkMs: 5, settleMs: 80, quietMs: 60_000 });
  signal("permission.asked");
  const reported = await control.waitFor(child.id, { timeoutMs: 5_000 });
  assert.equal(reported.reason, "needs_approval");
  assert.ok(reported.waitedMs < 1_000, `no wait until the timeout (${reported.waitedMs} ms)`);
});

test("Qwen's title and its PermissionRequest hook for one prompt are one request; a later hook is a new one", async (t) => {
  const { terminals, control, child, signal } = await fixture(t, "qwen");
  signal(undefined, "title");
  assert.equal((await control.waitFor(child.id, { timeoutMs: 5_000 })).reason, "needs_approval");
  signal("PermissionRequest");
  const same = control.waitFor(child.id, { timeoutMs: 5_000 });
  assert.equal(await pending(same), true, "the same prompt is not reported again");

  terminals.input(child.id, "1");
  signal("PermissionRequest");
  assert.equal((await same).reason, "needs_approval", "the next request is reported");
});

test("an echo Notification before the PermissionRequest hook is the same request", async (t) => {
  const { control, child, signal } = await fixture(t, "claude");
  signal("Notification");
  assert.equal((await control.waitFor(child.id, { timeoutMs: 5_000 })).reason, "needs_approval");
  signal("PermissionRequest");
  signal("Notification");
  assert.equal(await pending(control.waitFor(child.id, { timeoutMs: 5_000 })), true);
});

test("each of Grok's permission_prompt Notifications is a request, one right after another too", async (t) => {
  const { terminals, control, child, signal } = await fixture(t, "grok");
  signal("Notification");
  assert.equal((await control.waitFor(child.id, { timeoutMs: 5_000 })).reason, "needs_approval");
  const same = control.waitFor(child.id, { timeoutMs: 5_000 });
  assert.equal(await pending(same), true, "the reported prompt waits for the person");

  terminals.input(child.id, "1");
  signal("Notification");
  const next = await same;
  assert.equal(next.reason, "needs_approval", "Grok's second prompt is reported");
  assert.ok(next.waitedMs < 2_000, `at once, not at the timeout (${next.waitedMs} ms)`);
  assert.equal(await pending(control.waitFor(child.id, { timeoutMs: 5_000 })), true, "and only once");
});
