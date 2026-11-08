/**
 * An OpenCode subagent on a launch contributor's model keeps `bash` on "ask" (the rule of 566cb4f7: a third-party
 * model's own judgement is not a safety boundary). Its ask must reach someone who may answer it:
 * - a decision service's deny fails the call before OpenCode asks; an allow answers OpenCode's prompt once;
 * - with no verdict, OpenCode's own prompt stays and the card turns needs_approval: Needs attention lists it, the
 *   orchestrator's wait_for_agent returns it with the prompt, the orchestrator cannot answer it, and the person's
 *   answer resumes the subagent and the orchestrator's next wait.
 * The real OpenCode plugin module, runtime gateway, decision hooks, TerminalManager and orchestration tools run here;
 * no OpenCode, no model. HOME is whatever the test runner's fake HOME is.
 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_RUNTIME_ENV, OPENCODE_DECISIONS_ENV } from "../src/agent-runtime/runtime-protocol.mjs";
import { AgentControlService, APPROVAL_REFUSAL } from "../src/main/services/AgentControlService.ts";
import { DecisionHooks } from "../src/main/services/DecisionHooks.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { attentionSessions } from "../src/renderer/src/features/home/attentionQueue.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const POSIX = { skip: process.platform === "win32" ? "Unix sockets." : false };
const until = async (check, what, ms = 4_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function runtime(decisions) {
  return {
    prepareLaunch: () => ({ args: [], environment: decisions ? { CANVASTTY_RUNTIME_DECISIONS: "1" } : {}, decisions, cleanup() {} }),
    currentStatus: () => null
  };
}

/** A launch contributor that puts OpenCode on its own model, as the Assistant's Auto router does. */
async function modelContributor(t) {
  const runsRoot = await mkdtemp(join(tmpdir(), "ctty-oc-ask-runs-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  return new LaunchPipeline({
    contributors: () => [{ pluginId: "p.router", pluginName: "Router", serviceId: "svc", secrets: false,
      launch: { fields: [{ key: "on", label: "On", kind: "boolean", default: true }], delegable: true } }],
    call: async () => ({ thirdPartyModel: true }),
    secret: async () => null,
    runsRoot,
    timeoutMs: 500
  });
}

async function cards(t, { thirdPartyModel }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-oc-ask-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const writes = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, runtime(true), true,
    fakeSpawner(calls, { onWrite: (data, options) => writes.push({ data, options }) }));
  terminals.configureBaseProtection(() => true);
  t.after(() => terminals.disposeAll());
  if (thirdPartyModel) terminals.configureLaunchPipeline(await modelContributor(t));
  const options = thirdPartyModel ? { launchOptions: { "p.router": { on: true } } } : {};
  const launch = async (request) => {
    const before = calls.length;
    const created = terminals.create({ provider: "opencode", cwd: root, profile: "auto", position: { x: 0, y: 0 }, ...options, ...request });
    await until(() => calls.length > before, "the launch");
    const inline = calls.at(-1).options.env.OPENCODE_CONFIG_CONTENT;
    return { id: created.id, env: calls.at(-1).options.env, bash: JSON.parse(inline).agent.build.permission.bash,
      metadata: () => terminals.getMetadata(created.id) };
  };
  const person = await launch({});
  const orchestrator = await launch({ role: "orchestrator" });
  const subagent = await launch({ role: "subagent", parentSessionId: orchestrator.id });
  return { root, terminals, writes, person, orchestrator, subagent };
}

test("a subagent on a launch contributor's model keeps bash asking; person cards and an own-model OpenCode are unchanged", async (t) => {
  const routed = await cards(t, { thirdPartyModel: true });
  for (const card of [routed.person, routed.orchestrator, routed.subagent]) {
    assert.equal(card.bash, "ask", "a third-party model's shell commands ask, in every card");
    assert.equal(card.metadata().autoDowngraded, true, "and the card says auto runs as edits only");
  }
  assert.equal(routed.subagent.metadata().role, "subagent");
  const own = await cards(t, { thirdPartyModel: false });
  for (const card of [own.person, own.orchestrator, own.subagent]) {
    assert.equal(card.bash, "allow", "OpenCode on its own model under base protection: the guard is the gate, as before");
    assert.equal(card.metadata().autoDowngraded, undefined);
  }
});

test("the subagent's shell ask: decisions answer OpenCode's prompt, otherwise it reaches the person, not the orchestrator", POSIX, async (t) => {
  const { terminals, writes, orchestrator, subagent, root } = await cards(t, { thirdPartyModel: true });
  // What the decision service answers for each command; null is no opinion.
  const verdicts = { "npm test": { verdict: "allow", reason: "tests" }, "rm -rf build": { verdict: "deny", reason: "not that" }, ls: null };
  const decide = new DecisionHooks({
    baseProtection: () => true,
    services: () => [{ pluginId: "p.review", pluginName: "Review", serviceId: "decide", mayAllow: true }],
    call: async (_plugin, _service, _method, params) => verdicts[params.tool.command] ?? null,
    session: (id) => id === subagent.id ? { provider: "opencode", role: "subagent", cwd: root, configDirs: [], profile: "auto" } : null
  });
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "ctty-oc-ask-rt-"));
  const gateway = new RuntimeGateway({
    runtimeDirectory,
    onPermissionRequest: (id, request, signal) => decide.decide(id, request, signal),
    // As src/main/index.ts applies it.
    onSignal: (id, signal) => terminals.applyProviderSignal(id, { kind: "lifecycle", state: signal.state, event: signal.event,
      ...(signal.turnId ? { requestId: signal.turnId } : {}), ...(signal.threadId ? { threadId: signal.threadId } : {}) })
  });
  await gateway.start();
  t.after(async () => { await gateway.close(); await rm(runtimeDirectory, { recursive: true, force: true }); });
  const capability = gateway.registerSession(subagent.id, "opencode", false, undefined, true);

  // The subagent's OpenCode loads CanvasTTY's plugin with the environment its launch gives it.
  assert.equal(subagent.env[OPENCODE_DECISIONS_ENV], "1", "the launch installs the guard");
  Object.assign(process.env, {
    [OPENCODE_DECISIONS_ENV]: "1",
    [AGENT_RUNTIME_ENV.address]: capability.address,
    [AGENT_RUNTIME_ENV.terminalSessionId]: subagent.id,
    [AGENT_RUNTIME_ENV.provider]: "opencode",
    [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
  });
  const { CanvasTTYLifecycle } = await import("../src/agent-runtime/opencode-plugin.mjs");
  const replies = [];
  const plugin = await CanvasTTYLifecycle({ client: { permission: { reply: async (body) => { replies.push(body); return { response: { ok: true } }; } } } });
  const root_ = "ses_root01";
  const event = (type, properties) => plugin.event({ event: { type, properties } });
  await event("session.created", { info: { id: root_ } });
  await event("session.status", { sessionID: root_, status: { type: "busy" } });
  await until(() => subagent.metadata().status === "working", "the subagent working");
  const bash = async (callID, command) => {
    await plugin["tool.execute.before"]({ tool: "bash", sessionID: root_, callID }, { args: { command } });
    // The guard let the call go on: OpenCode now checks bash, which asks.
    await event("permission.asked", { id: `per_${callID}`, sessionID: root_, permission: "bash", patterns: [command], tool: { messageID: "msg_1", callID } });
  };

  // A decision service's allow answers OpenCode's prompt once; nobody else is asked.
  await bash("c1", "npm test");
  assert.deepEqual(replies, [{ requestID: "per_c1", reply: "once" }]);
  assert.equal(subagent.metadata().status, "working", "no needs_approval for an answered prompt");
  // Its deny fails the call with the reason before OpenCode asks anything.
  await assert.rejects(plugin["tool.execute.before"]({ tool: "bash", sessionID: root_, callID: "c2" }, { args: { command: "rm -rf build" } }),
    /Review.*not that/u);
  assert.equal(replies.length, 1);

  // No verdict: OpenCode's own prompt stays, for the person. CanvasTTY never answers it.
  await bash("c3", "ls");
  assert.equal(replies.length, 1, "no verdict is never turned into an allow");
  await until(() => subagent.metadata().status === "needs_approval", "needs_approval");
  assert.deepEqual(attentionSessions(terminals.list()).map((session) => session.id), [subagent.id], "Needs attention lists the subagent");

  // The orchestrator learns at once, with the prompt; it cannot answer it.
  const control = new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 20, quietMs: 60_000 } });
  const handler = new ScopedOrchestrationHandler(control, null, { cli: () => "available", limits: () => ({ maxDepth: 2, maxSubagents: 8 }) });
  const call = (tool, args) => handler.execute(orchestrator.id, { id: "r", tool, arguments: args });
  const first = await call("wait_for_agent", { sessionId: subagent.id, timeoutSeconds: 5 });
  assert.equal(first.reason, "needs_approval");
  assert.ok(first.waitedMs < 1_000);
  const typed = writes.length;
  for (const prompt of ["y", "allow"]) {
    await assert.rejects(call("send_to_agent", { sessionId: subagent.id, prompt }), (error) => {
      assert.equal(error.bridgeError?.code ?? error.code, "INVALID_REQUEST");
      assert.equal(error.message, APPROVAL_REFUSAL);
      return true;
    });
  }
  assert.equal(writes.length, typed, "nothing reached the subagent's terminal");

  // The next wait waits for the person instead of returning the same prompt again.
  const again = call("wait_for_agent", { sessionId: subagent.id, timeoutSeconds: 5 });
  let settled = false;
  void again.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false, "still waiting while the prompt waits for the person");
  // The person answers OpenCode's prompt in the card; OpenCode replies, runs `ls` and ends the turn.
  await event("permission.replied", { sessionID: root_, requestID: "per_c3", reply: "once" });
  await until(() => subagent.metadata().status === "working", "the subagent working again");
  assert.deepEqual(attentionSessions(terminals.list()), [], "the answered card leaves Needs attention");
  await event("session.status", { sessionID: root_, status: { type: "idle" } });
  const done = await again;
  assert.equal(done.reason, "idle");
  assert.equal(replies.length, 1, "the person answered, not CanvasTTY");

  // A new prompt after that is reported at once again.
  await event("session.status", { sessionID: root_, status: { type: "busy" } });
  await bash("c4", "ls");
  await until(() => subagent.metadata().status === "needs_approval", "the second prompt");
  assert.equal((await call("wait_for_agent", { sessionId: subagent.id, timeoutSeconds: 5 })).reason, "needs_approval");
});
