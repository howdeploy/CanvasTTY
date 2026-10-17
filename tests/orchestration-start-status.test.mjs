import assert from "node:assert/strict";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { LaunchRefusal } from "../src/main/services/launchRefusal.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const READY = "\x1b[2J\x1b[H>_ OpenAI Codex\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m\r\n";

for (const lifecycleBeforeReturn of [false, true]) {
  test(`Codex spawn with delivered input reports ${lifecycleBeforeReturn ? "observed working" : "starting before hooks"} and remains waitable`, async t => {
    const calls = [], writes = [];
    let childId;
    const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true,
      fakeSpawner(calls, { onWrite(text) {
        writes.push(text);
        if (lifecycleBeforeReturn && text.endsWith("\r")) {
          terminals.applyProviderSignal(childId, { kind: "lifecycle", state: "working" });
        }
      } }));
    t.after(() => terminals.disposeAll());
    const control = new AgentControlService(terminals, { waitTiming: { checkMs: 2, settleMs: 2, quietMs: 1000 } });
    const handler = new ScopedOrchestrationHandler(control);
    const parent = terminals.create({ provider: "codex", cwd: process.cwd(), profile: "auto",
      role: "orchestrator", position: { x: 0, y: 0 } });
    const creating = handler.execute(parent.id, { id: "spawn", tool: "spawn_agent", arguments: {
      provider: "codex", cwd: process.cwd(), profile: "auto", prompt: "Return a diagnostic result." } });
    childId = control.children(parent.id)[0].id;
    calls.at(-1).process.emitData(READY);
    const spawned = await creating;
    assert.equal(spawned.sessionId, childId);
    assert.equal(spawned.status, lifecycleBeforeReturn ? "working" : "starting");
    assert.equal(terminals.getMetadata(childId).status, lifecycleBeforeReturn ? "working" : "unavailable",
      "the spawn receipt must not invent a lifecycle signal");
    if (!lifecycleBeforeReturn) assert.match(spawned.note, /created.*wait_for_agent/u);
    assert.doesNotMatch(spawned.note ?? "", /then get_agent_result/u);
    assert.ok(writes.some(text => text.includes("Return a diagnostic result.")));
    terminals.applyProviderSignal(childId, { kind: "lifecycle", state: "working" });
    terminals.recordAnswer(childId, { text: "diagnostic completed", truncated: false });
    terminals.applyProviderSignal(childId, { kind: "lifecycle", state: "idle" });
    const waited = await handler.execute(parent.id, { id: "wait", tool: "wait_for_agent",
      arguments: { sessionId: childId, timeoutSeconds: 1 } });
    assert.equal(waited.reason, "idle");
    assert.equal(waited.answer.text, "diagnostic completed");
    const result = await handler.execute(parent.id, { id: "result", tool: "get_agent_result", arguments: { sessionId: childId } });
    assert.equal(result.answer.text, "diagnostic completed");
  });
}

test("spawn preserves observed lifecycle states and real launch refusals", async () => {
  for (const [status, exitCode] of [["idle", null], ["needs_approval", null], ["failed", 1], ["done", 0], ["unavailable", 1]]) {
    const handler = new ScopedOrchestrationHandler({
      status: () => ({ role: "orchestrator", provider: "codex" }),
      profileFor: () => ({ profile: "auto", inherited: false }),
      spawn: async () => ({ id: "fixture-child", provider: "codex", profile: "auto", status, exitCode, title: "worker" })
    });
    const result = await handler.execute("fixture-parent", { id: "spawn", tool: "spawn_agent", arguments: { provider: "codex", cwd: process.cwd() } });
    assert.equal(result.status, status);
    assert.equal(result.note, undefined);
  }
  const handler = new ScopedOrchestrationHandler({
    status: () => ({ role: "orchestrator", provider: "codex" }),
    profileFor: () => ({ profile: "auto", inherited: false }),
    spawn: async () => { throw new LaunchRefusal("Fixture launch refused"); }
  });
  await assert.rejects(handler.execute("fixture-parent", { id: "spawn", tool: "spawn_agent",
    arguments: { provider: "codex", cwd: process.cwd() } }), error => error.bridgeError?.code === "INVALID_REQUEST");
});
