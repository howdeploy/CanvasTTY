import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { SecretRedactionRegistry } from "../src/main/services/safety/SecretRedaction.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { OrchestrationBridge } from "../src/main/services/agent-browser/OrchestrationBridge.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { AGENT_RUNTIME_ENV, CAPTURE_RESULT_ENV } from "../src/agent-runtime/runtime-protocol.mjs";
import { MAX_ORCHESTRATION_PAYLOAD_BYTES } from "../src/agent-browser/orchestration-catalog.mjs";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";
import { IMPLEMENTATIONS, SKIP_NATIVE, baseEnvironment, startMcp, outputHasId, runOnce } from "./native-helper-harness.mjs";

const WINDOWS_PIPE_HOST = join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe");

for (const implementation of IMPLEMENTATIONS) {
  test(`${implementation.name}: long worker replies reach MCP intact before close, including paginated results`, {
    skip: implementation.name === "native" && SKIP_NATIVE, timeout: 30_000
  }, async t => {
    const root = await mkdtemp(join(tmpdir(), "canvas-full-answer-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const ptys = [];
    const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(ptys));
    t.after(() => terminals.disposeAll());
    const redaction = new SecretRedactionRegistry();
    redaction.add("fixture", ["fixture1"]);
    terminals.configureRedaction(redaction);
    const control = new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 5, quietMs: 60_000 } });
    const handler = new ScopedOrchestrationHandler(control);
    const runtime = new RuntimeGateway({ runtimeDirectory: join(root, "rt"), windowsHostPath: WINDOWS_PIPE_HOST,
      onSignal(id, signal) {
        terminals.applyProviderSignal(id, { kind: "lifecycle", state: signal.state, event: signal.event });
        if (signal.result) terminals.recordAnswer(id, signal.result);
      } });
    await runtime.start();
    t.after(() => runtime.close());
    const gateway = new OrchestrationGateway({ runtimeDirectory: join(root, "mcp"), handler, windowsHostPath: WINDOWS_PIPE_HOST });
    await gateway.start();
    t.after(() => gateway.stop());
    const parent = terminals.create({ provider: "codex", cwd: root, profile: "normal", role: "orchestrator", position: { x: 0, y: 0 } });
    const launch = new OrchestrationBridge(gateway).prepareLaunch({ terminalSessionId: parent.id });
    t.after(() => launch.cleanup());
    const helper = startMcp(implementation.orchestration, baseEnvironment(launch.environment));
    t.after(async () => { helper.kill(); await helper.exited; });
    let serial = 0;
    async function rpc(method, params) {
      const id = ++serial;
      helper.send({ jsonrpc: "2.0", id, method, params });
      await helper.until(outputHasId(id));
      const raw = helper.output.find(line => JSON.parse(line).id === id);
      assert.ok(Buffer.byteLength(raw) < MAX_ORCHESTRATION_PAYLOAD_BYTES, "each MCP frame stays bounded");
      const response = JSON.parse(raw);
      assert.equal(response.error, undefined);
      return response.result;
    }
    async function tool(name, args) {
      const reply = await rpc("tools/call", { name, arguments: args });
      const value = JSON.parse(reply.content[0].text);
      return { reply, value };
    }
    await rpc("initialize", {});
    // Documents, multi-page Unicode, and worst-case JSON escaping exercise different wire sizes.
    for (const document of [
      "Requirements\n" + "Section: behaviour and acceptance.\n".repeat(280) + "END OF DOCUMENT",
      "Начало 🧪\n" + "Требование: проверяемое поведение. 🧪\n".repeat(1100) + "КОНЕЦ",
      "\u0001".repeat(65_536),
      "fixture1 ".repeat(7_000) // Masking expands this reply beyond the source capture's character limit.
    ]) {
      const { value: child } = await tool("spawn_agent", { provider: "codex", cwd: root, profile: "normal" });
      const cap = runtime.registerSession(child.sessionId, "codex", true);
      ptys.at(-1).process.emitData("terminal redraw noise\n".repeat(500));
      const { value: observed } = await tool("observe_agent", { sessionId: child.sessionId });
      assert.ok(observed.output.includes("terminal redraw noise"), "raw diagnostics remain available separately");
      terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "working", event: "UserPromptSubmit" });
      const hook = await runOnce(implementation.hook("idle", "Stop"), {
        env: baseEnvironment({
          [AGENT_RUNTIME_ENV.address]: cap.address, [AGENT_RUNTIME_ENV.terminalSessionId]: cap.terminalSessionId,
          [AGENT_RUNTIME_ENV.provider]: cap.provider, [AGENT_RUNTIME_ENV.capabilityToken]: cap.capabilityToken,
          [CAPTURE_RESULT_ENV]: "1"
        }), input: JSON.stringify({ last_assistant_message: document, turn_id: "completed-turn" })
      });
      assert.equal(hook.code, 0);
      const { value: waited } = await tool("wait_for_agent", { sessionId: child.sessionId, timeoutSeconds: 1 });
      assert.ok(waited.answer, "the Stop result reaches orchestration");
      assert.equal(waited.output, "", "the complete answer is not duplicated with terminal redraws");
      const expected = redaction.redact(document);
      assert.ok(expected.startsWith(waited.answer.text), "the beginning is preserved");
      let combined = waited.answer.text;
      let next = waited.answer.nextOffset;
      if (next !== undefined && next !== null) {
        const { reply } = await tool("cancel_agent", { sessionId: child.sessionId });
        assert.equal(reply.isError, true, "unread final-answer pages must not be discarded");
        assert.ok(terminals.getMetadata(child.sessionId), "the child stays available for reading");
      }
      while (next !== undefined && next !== null) {
        const { reply, value } = await tool("get_agent_result", { sessionId: child.sessionId, answerOffset: next });
        assert.equal(reply.isError, false);
        combined += value.answer.text;
        assert.equal(value.answer.offset, next);
        next = value.answer.nextOffset;
      }
      assert.equal(combined, expected, "all document characters reach the parent exactly once");
      const { value: result } = await tool("get_agent_result", { sessionId: child.sessionId });
      assert.equal(result.answer.sourceTruncated ?? result.answer.truncated, false);
      const { reply, value: canceled } = await tool("cancel_agent", { sessionId: child.sessionId });
      assert.equal(reply.isError, false);
      assert.equal(canceled.canceled, true);
      assert.equal(terminals.getMetadata(child.sessionId), null);
      const { reply: lateReply, value: lateWait } = await tool("wait_for_agent", { sessionId: child.sessionId, timeoutSeconds: 1 });
      assert.equal(lateReply.isError, false);
      assert.equal(lateWait.reason, "closed");
      assert.equal(lateWait.resultReadBeforeClose, true);
      assert.equal(lateWait.output, "");
      assert.equal(lateWait.answer, undefined, "cleanup receipts never retain document text");
    }
  });
}

test("answer pages are masked before splitting, scoped, sequential and reset for a new reply", async t => {
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([]));
  t.after(() => terminals.disposeAll());
  const redaction = new SecretRedactionRegistry();
  const secret = "registered-private-fixture-value";
  redaction.add("fixture", [secret]);
  terminals.configureRedaction(redaction);
  const parent = terminals.create({ provider: "codex", cwd: process.cwd(), profile: "normal", role: "orchestrator", position: { x: 0, y: 0 } });
  const foreign = terminals.create({ provider: "codex", cwd: process.cwd(), profile: "normal", role: "orchestrator", position: { x: 0, y: 0 } });
  const control = new AgentControlService(terminals);
  const handler = new ScopedOrchestrationHandler(control);
  const child = await control.spawn({ parentSessionId: parent.id, provider: "opencode", cwd: process.cwd() });
  const document = "z".repeat(16_380) + secret + " remaining requirements. ".repeat(1000);
  terminals.recordAnswer(child.id, { text: document, truncated: false });
  async function call(tool, args = {}, owner = parent.id) {
    return handler.execute(owner, { id: "read", tool, arguments: { sessionId: child.id, ...args } });
  }
  await assert.rejects(call("get_agent_result", {}, foreign.id), /subtree/u);
  await assert.rejects(call("get_agent_result", { answerOffset: 16_384 }), /answerOffset=0/u);
  const first = await call("get_agent_result");
  assert.equal(first.output, "");
  assert.ok(!first.answer.text.includes(secret));
  await assert.rejects(call("get_agent_result", { answerOffset: first.answer.nextOffset + 1 }), /answerOffset=/u);
  terminals.applyProviderSignal(child.id, { kind: "lifecycle", state: "working" });
  await assert.rejects(call("get_agent_result", { answerOffset: first.answer.nextOffset }), /answerOffset=0/u);
  terminals.recordAnswer(child.id, { text: "New revision\n" + document, truncated: false });
  await assert.rejects(call("get_agent_result", { answerOffset: first.answer.nextOffset }), /answerOffset=0/u);
  const current = await call("get_agent_result");
  let combined = current.answer.text;
  let next = current.answer.nextOffset;
  while (next !== null) {
    const page = await call("get_agent_result", { answerOffset: next });
    combined += page.answer.text;
    next = page.answer.nextOffset;
  }
  assert.equal(combined, redaction.redact("New revision\n" + document));
  assert.ok(!combined.includes(secret));
  assert.equal((await call("cancel_agent")).canceled, true);
});


test("completed short replies require an explicit result read before close; running children remain cancelable", async t => {
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([]));
  t.after(() => terminals.disposeAll());
  const parent = terminals.create({ provider: "codex", cwd: process.cwd(), profile: "normal", role: "orchestrator", position: { x: 0, y: 0 } });
  const control = new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 5, quietMs: 60_000 } });
  const handler = new ScopedOrchestrationHandler(control);
  const child = await control.spawn({ parentSessionId: parent.id, provider: "opencode", cwd: process.cwd() });
  const call = (tool, args = {}) => handler.execute(parent.id, { id: "receipt", tool, arguments: { sessionId: child.id, ...args } });
  terminals.applyProviderSignal(child.id, { kind: "lifecycle", state: "working" });
  terminals.recordAnswer(child.id, { text: "Finished independently.", truncated: false });
  terminals.applyProviderSignal(child.id, { kind: "lifecycle", state: "idle" });
  const waited = await call("wait_for_agent", { timeoutSeconds: 1 });
  assert.equal(waited.answer.text, "Finished independently.");
  await assert.rejects(call("cancel_agent"), /get_agent_result/u);
  assert.ok(terminals.getMetadata(child.id));
  assert.equal((await call("get_agent_result")).answer.text, waited.answer.text);
  assert.equal((await call("cancel_agent")).canceled, true);

  const running = await control.spawn({ parentSessionId: parent.id, provider: "opencode", cwd: process.cwd() });
  terminals.applyProviderSignal(running.id, { kind: "lifecycle", state: "working" });
  assert.equal((await handler.execute(parent.id, { id: "stop", tool: "cancel_agent", arguments: { sessionId: running.id } })).canceled, true);
});

test("sending a new task invalidates the old result receipt even if the next answer is identical", async () => {
  const reply = { sessionId: "child", status: "idle", state: "running", exitCode: null, output: "",
    answer: { text: "Task completed.", truncated: false } };
  let canceled = false;
  const handler = new ScopedOrchestrationHandler({
    status: () => ({ role: "orchestrator", provider: "codex" }),
    isInSubtree: () => true,
    result: () => reply,
    send: async () => undefined,
    cancel: () => { canceled = true; }
  });
  const call = (tool, args = {}) => handler.execute("parent", { id: "turn", tool, arguments: { sessionId: "child", ...args } });
  await call("get_agent_result");
  await call("send_to_agent", { prompt: "Run a separate task." });
  await assert.rejects(call("cancel_agent"), /get_agent_result/u);
  assert.equal(canceled, false);
  await call("get_agent_result");
  assert.equal((await call("cancel_agent")).canceled, true);
});


test("closed-child waits are scoped, immediate and bounded without retaining answers", async () => {
  const live = new Set();
  let waits = 0;
  const handler = new ScopedOrchestrationHandler({
    status: () => ({ role: "orchestrator", provider: "codex" }),
    isInSubtree: (_owner, id) => live.has(id),
    result: id => ({ sessionId: id, status: "working", answer: null }),
    cancel: id => { live.delete(id); },
    waitFor: () => { waits += 1; throw new Error("A disposed child must never reach the controller wait."); }
  });
  const call = (tool, id, owner = "parent") => handler.execute(owner, { id: "cleanup", tool, arguments: { sessionId: id } });
  live.add("closed-first");
  await call("cancel_agent", "closed-first");
  const receipt = await call("wait_for_agent", "closed-first");
  assert.equal(receipt.reason, "closed");
  assert.equal(receipt.waitedMs, 0);
  assert.equal(receipt.resultReadBeforeClose, false, "canceling active work does not claim a read result");
  assert.equal(receipt.answer, undefined);
  await assert.rejects(call("wait_for_agent", "closed-first", "foreign"), /subtree/u);
  await assert.rejects(call("get_agent_result", "closed-first"), /subtree/u);
  await assert.rejects(call("send_to_agent", "closed-first"), /subtree/u);
  await assert.rejects(call("wait_for_agent", "unknown"), /subtree/u);
  for (let index = 0; index < 256; index += 1) {
    const id = `closed-${index}`;
    live.add(id);
    await call("cancel_agent", id);
  }
  await assert.rejects(call("wait_for_agent", "closed-first"), /subtree/u);
  assert.equal((await call("wait_for_agent", "closed-255")).reason, "closed");
  assert.equal(waits, 0);
});
