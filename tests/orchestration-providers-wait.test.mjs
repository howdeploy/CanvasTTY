import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROVIDER_IDS,
  MAX_AGENT_WAIT_SECONDS,
  ORCHESTRATION_TOOL_DEFINITIONS,
  ORCHESTRATION_TOOL_NAMES,
  validateOrchestrationArguments
} from "../src/agent-browser/orchestration-catalog.mjs";
import { createOrchestrationDispatcher } from "../src/agent-browser/orchestration-helper.mjs";
import { AGENT_PROVIDERS } from "../src/shared/contracts.ts";
import { PROVIDER_LABELS } from "../src/shared/providerCatalog.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { listProviderDirectory } from "../src/main/services/providerDirectory.ts";

const definition = (name) => ORCHESTRATION_TOOL_DEFINITIONS.find((tool) => tool.name === name);

test("the catalog lists list_providers first and wait_for_agent with a bounded timeout", () => {
  assert.equal(ORCHESTRATION_TOOL_NAMES[0], "list_providers");
  assert.ok(ORCHESTRATION_TOOL_NAMES.includes("wait_for_agent"));
  assert.deepEqual(definition("list_providers").inputSchema, { type: "object", properties: {}, required: [], additionalProperties: false });
  const wait = definition("wait_for_agent").inputSchema;
  assert.deepEqual(wait.required, ["sessionId"]);
  assert.equal(wait.properties.timeoutSeconds.maximum, 100);
  assert.equal(MAX_AGENT_WAIT_SECONDS, 100);
  assert.equal(validateOrchestrationArguments("wait_for_agent", { sessionId: "a", timeoutSeconds: 100 }).ok, true);
  assert.match(validateOrchestrationArguments("wait_for_agent", { sessionId: "a", timeoutSeconds: 101 }).error, /above the maximum/u);
  assert.equal(validateOrchestrationArguments("list_providers", {}).ok, true);
  assert.match(validateOrchestrationArguments("list_providers", { x: 1 }).error, /Unexpected argument/u);
  assert.match(definition("list_providers").description, /Never search the filesystem/u);
});

test("spawn_agent names every provider id CanvasTTY knows and points to list_providers", () => {
  assert.deepEqual([...AGENT_PROVIDER_IDS], [...AGENT_PROVIDERS]);
  const spawn = definition("spawn_agent");
  assert.deepEqual(spawn.inputSchema.properties.provider.enum, [...AGENT_PROVIDERS]);
  assert.match(spawn.description, /provider must be an id from list_providers/u);
  for (const id of AGENT_PROVIDERS) assert.ok(spawn.description.includes(id), id);
  const refused = validateOrchestrationArguments("spawn_agent", { provider: "glm", cwd: "/tmp" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Unknown provider "glm"\. Call list_providers/u);
  assert.equal(validateOrchestrationArguments("spawn_agent", { provider: "opencode", cwd: "/tmp" }).ok, true);
});

test("the stdio helper answers an unknown provider itself instead of dropping the bridge", async () => {
  const calls = [];
  const dispatch = createOrchestrationDispatcher({ connect: async () => undefined, call: async (...args) => { calls.push(args); return {}; } });
  const answer = await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_agent", arguments: { provider: "zai", cwd: "/tmp" } } });
  assert.equal(answer.result.isError, true);
  const payload = JSON.parse(answer.result.content[0].text);
  assert.equal(payload.error.code, "INVALID_REQUEST");
  assert.match(payload.error.message, /list_providers/u);
  assert.deepEqual(calls, []);
  const initialized = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.match(initialized.result.instructions, /list_providers .*spawn_agent .*wait_for_agent .*get_agent_result/u);
  assert.match(initialized.result.instructions, /Do not explore the filesystem/u);
});

const limits = {
  fetchedAt: 100,
  providers: [
    { provider: "codex", state: "available", source: "codex-app-server", fetchedAt: 10, windows: [] },
    { provider: "claude", state: "unavailable", source: "claude-usage-api", checkedAt: 11, reason: "not-authenticated" },
    { provider: "grok", state: "unavailable", source: "grok-billing-api", checkedAt: 12, reason: "session-expired" },
    { provider: "kimi", state: "stale", source: "kimi-usage-api", fetchedAt: 5, failedAt: 13, reason: "timeout", windows: [] },
    { provider: "qwen", state: "unavailable", source: "qwen-cli", checkedAt: 14, reason: "timeout" }
  ]
};

test("list_providers reads the CLI registry, the cached sign-in state and plugin launch options", () => {
  let limitReads = 0;
  const directory = listProviderDirectory({
    cli: (provider) => (provider === "cursor" ? "unavailable" : "available"),
    limits: () => { limitReads += 1; return limits; },
    launchContributors: () => [
      { pluginId: "canvastty.accounts", pluginName: "Accounts", launch: { appliesTo: ["grok", "codex"], delegable: true, fields: [
        { key: "account", label: "Account", kind: "select", optionsFrom: "service", options: [{ value: "a", label: "A" }] },
        { key: "mode", label: "Mode", kind: "select", options: [{ value: "fast", label: "Fast" }] }
      ] } },
      // Only the person chooses these: an orchestrator does not even see them.
      { pluginId: "p.private", pluginName: "Private", launch: { fields: [{ key: "x", label: "X", kind: "text" }] } }
    ],
    containment: () => true
  }, ["canvastty-accounts__list_routes", "canvastty-accounts__other"]);
  assert.equal(limitReads, 1);
  assert.deepEqual(directory.providers.map((entry) => entry.id), [...AGENT_PROVIDERS]);
  const by = Object.fromEntries(directory.providers.map((entry) => [entry.id, entry]));
  assert.equal(by.opencode.name, PROVIDER_LABELS.opencode);
  assert.deepEqual([by.codex.signIn, by.codex.signInCheckedAt], ["ok", 10]);
  assert.equal(by.claude.signIn, "signed_out");
  assert.equal(by.grok.signIn, "expired");
  assert.equal(by.kimi.signIn, "ok");
  assert.equal(by.qwen.signIn, "unknown");
  assert.equal(by.opencode.signIn, "unknown");
  assert.equal(by.opencode.signInCheckedAt, undefined);
  assert.deepEqual([by.cursor.installed, by.cursor.available], [false, false]);
  assert.deepEqual([by.opencode.installed, by.opencode.available, by.opencode.subagent, by.opencode.orchestrator], [true, true, true, true]);
  assert.equal(by.grok.orchestrator, false);
  assert.deepEqual(by.grok.launchOptions, [{ pluginId: "canvastty.accounts", plugin: "Accounts", fields: [
    { key: "account", kind: "select" }, { key: "mode", kind: "select", choices: ["fast"] }
  ] }]);
  assert.equal(by.claude.launchOptions, undefined, "a plugin that did not declare its options delegable is not listed");
  assert.deepEqual(by.codex.profiles, ["auto", "normal", "acceptEdits", "plan"], "never YOLO for a subagent");
  assert.deepEqual(by.qwen.profiles, ["auto", "normal"], "a contained auto where isolation runs");
  assert.deepEqual(directory.launchOptionTools, ["canvastty-accounts__list_routes"]);
  assert.match(directory.note, /canvastty-accounts__list_routes/u);
  assert.match(directory.note, /Do not search the filesystem/u);
});

test("list_providers without a registry or a limits read says unknown instead of guessing", () => {
  const directory = listProviderDirectory({ cli: () => null, limits: () => { throw new Error("no"); } });
  for (const entry of directory.providers) {
    assert.equal(entry.installed, null);
    assert.equal(entry.available, true);
    assert.equal(entry.signIn, "unknown");
  }
  assert.equal(directory.launchOptionTools, undefined);
});

// A TerminalManager stand-in: sessions by id, a buffer and output offset per session.
function fakeTerminals() {
  const sessions = new Map();
  const add = (id, fields = {}) => {
    sessions.set(id, { id, provider: "opencode", status: "working", exitCode: null, parentSessionId: undefined, role: "subagent",
      startedAt: sessions.size, buffer: "", outputOffset: 0, ...fields });
    return sessions.get(id);
  };
  return {
    sessions,
    add,
    getMetadata: (id) => {
      const session = sessions.get(id);
      if (!session) return null;
      const { buffer: _buffer, outputOffset: _offset, ...metadata } = session;
      return metadata;
    },
    listMetadata: () => [...sessions.values()].map(({ buffer: _buffer, outputOffset: _offset, ...metadata }) => metadata),
    readBuffer: (id) => {
      const session = sessions.get(id);
      if (!session) throw new Error("Terminal session does not exist.");
      return { buffer: session.buffer, outputOffset: session.outputOffset };
    },
    outputOffset: (id) => sessions.get(id)?.outputOffset ?? null,
    redactSecretsTail: (text, max) => text.replaceAll("sk-secret-value", "[redacted]").slice(-max),
    dispose: (id) => sessions.delete(id)
  };
}

const timing = { checkMs: 5, settleMs: 20, quietMs: 60 };

function setup() {
  const terminals = fakeTerminals();
  terminals.add("orch", { role: "orchestrator", provider: "opencode", status: "idle" });
  terminals.add("child", { parentSessionId: "orch" });
  const control = new AgentControlService(terminals, { waitTiming: timing });
  const handler = new ScopedOrchestrationHandler(control, null, {
    cli: () => "available", limits: () => limits
  });
  return { terminals, control, handler };
}

const call = (handler, tool, args, signal) => handler.execute("orch", { id: "r", tool, arguments: args }, signal);

test("wait_for_agent returns once the subagent finished, with its masked tail", async () => {
  const { terminals, handler } = setup();
  const child = terminals.sessions.get("child");
  setTimeout(() => {
    child.buffer = `${"x".repeat(9000)} key sk-secret-value done`;
    child.outputOffset = 9000;
    child.status = "idle";
  }, 30);
  const answer = await call(handler, "wait_for_agent", { sessionId: "child", timeoutSeconds: 5 });
  assert.equal(answer.reason, "idle");
  assert.equal(answer.status, "idle");
  assert.equal(answer.exitCode, null);
  assert.ok(answer.waitedMs >= 30);
  assert.ok(answer.output.endsWith("key [redacted] done"));
  assert.ok(!answer.output.includes("sk-secret"));
  assert.ok(answer.output.length <= 8192);
});

test("wait_for_agent reports an exited subagent as done or failed", async () => {
  const { terminals, handler } = setup();
  terminals.sessions.get("child").exitCode = 0;
  assert.equal((await call(handler, "wait_for_agent", { sessionId: "child" })).reason, "done");
  terminals.sessions.get("child").exitCode = 2;
  const failed = await call(handler, "wait_for_agent", { sessionId: "child" });
  assert.deepEqual([failed.reason, failed.exitCode], ["failed", 2]);
});

test("wait_for_agent returns needs_approval at once and quiet for a subagent without status", async () => {
  const { terminals, handler } = setup();
  const child = terminals.sessions.get("child");
  child.status = "needs_approval";
  assert.equal((await call(handler, "wait_for_agent", { sessionId: "child" })).reason, "needs_approval");
  child.status = "unavailable";
  const quiet = await call(handler, "wait_for_agent", { sessionId: "child" });
  assert.equal(quiet.reason, "quiet");
  assert.ok(quiet.waitedMs >= timing.quietMs);
});

test("wait_for_agent times out while the subagent works, and reports a closed card", async () => {
  const { terminals, control, handler } = setup();
  const started = Date.now();
  const answer = await control.waitFor("child", { timeoutMs: 50 });
  assert.equal(answer.reason, "timeout");
  assert.equal(answer.status, "working");
  assert.ok(Date.now() - started >= 45);
  setTimeout(() => terminals.sessions.delete("child"), 20);
  const closed = await call(handler, "wait_for_agent", { sessionId: "child", timeoutSeconds: 5 });
  assert.deepEqual([closed.reason, closed.output], ["closed", ""]);
});

test("wait_for_agent stops at once when the call is canceled", async () => {
  const { handler } = setup();
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(call(handler, "wait_for_agent", { sessionId: "child", timeoutSeconds: 100 }, controller.signal),
    (error) => error.bridgeError?.code === "CANCELED");
  assert.ok(Date.now() - started < 1_000);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(call(handler, "wait_for_agent", { sessionId: "child" }, aborted.signal),
    (error) => error.bridgeError?.code === "CANCELED");
});

test("wait_for_agent waits only for this orchestrator's own subagents", async () => {
  const { terminals, handler } = setup();
  terminals.add("other-orch", { role: "orchestrator" });
  terminals.add("foreign", { parentSessionId: "other-orch", status: "idle" });
  await assert.rejects(call(handler, "wait_for_agent", { sessionId: "foreign" }),
    (error) => error.bridgeError?.code === "INVALID_REQUEST" && /not part of this orchestrator's subtree/u.test(error.message));
  await assert.rejects(call(handler, "wait_for_agent", { sessionId: "orch" }),
    (error) => error.bridgeError?.code === "INVALID_REQUEST" && /not for this session/u.test(error.message));
});

test("the handler answers list_providers and refuses an unknown provider with a pointer to it", async () => {
  const { handler } = setup();
  const listed = await call(handler, "list_providers", {});
  assert.deepEqual(listed.providers.map((entry) => entry.id), [...AGENT_PROVIDERS]);
  assert.equal(listed.providers.find((entry) => entry.id === "codex").signIn, "ok");
  await assert.rejects(call(handler, "spawn_agent", { provider: "glm-5", cwd: "/tmp" }),
    (error) => error.bridgeError?.code === "INVALID_REQUEST" && error.bridgeError.retryable === false && /list_providers/u.test(error.message));
});

test("the orchestrator skill and docs give the list_providers workflow and forbid filesystem exploration", async () => {
  const { readFile } = await import("node:fs/promises");
  const skill = await readFile(new URL("../agent/orchestrator/SKILL.md", import.meta.url), "utf8");
  const docs = await readFile(new URL("../docs/agent-orchestration.md", import.meta.url), "utf8");
  for (const text of [skill, docs]) {
    for (const tool of ["list_providers", "spawn_agent", "wait_for_agent", "get_agent_result"]) assert.ok(text.includes(`\`${tool}\``), tool);
    assert.match(text, /not explore the filesystem/u);
  }
  assert.match(docs, /`list_providers` → `spawn_agent` \(one per part\) → `wait_for_agent` → `get_agent_result`/u);
});

test("after a prompt, an idle before the turn starts does not end wait_for_agent; the turn's own end does", async (t) => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { TerminalManager } = await import("../src/main/services/TerminalManager.ts");
  const { availableRegistry, fakeSpawner } = await import("./helpers/terminal.mjs");
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-turn-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({ provider: "codex", cwd: root, profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  const control = new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 10, quietMs: 60_000 } });
  const handler = new ScopedOrchestrationHandler(control);
  const wait = (timeoutSeconds = 1) => handler.execute(orchestrator.id, { id: "w", tool: "wait_for_agent", arguments: { sessionId: child.sessionId, timeoutSeconds } });

  // Without any prompt, a startup idle is simply idle.
  const idleChild = await handler.execute(orchestrator.id, { id: "0", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root } });
  terminals.applyProviderSignal(idleChild.sessionId, { kind: "lifecycle", state: "idle" });
  assert.equal((await handler.execute(orchestrator.id, { id: "i", tool: "wait_for_agent", arguments: { sessionId: idleChild.sessionId } })).reason, "idle");

  const child = await handler.execute(orchestrator.id, { id: "1", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, prompt: "do part A" } });
  // The CLI's startup idle arrives after the prompt was typed but before its turn starts.
  terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "idle" });
  const early = await wait(1);
  assert.equal(early.reason, "timeout", "the startup idle is not the prompt's answer");
  assert.equal(early.status, "idle");
  // The turn starts and ends while one wait is running.
  const waiting = wait(10);
  setTimeout(() => terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "working" }), 30);
  setTimeout(() => terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "idle", event: "Stop" }), 60);
  const done = await waiting;
  assert.equal(done.reason, "idle");
  assert.ok(done.waitedMs >= 50);
  // A second prompt: the finished first turn no longer counts until the next one starts.
  await handler.execute(orchestrator.id, { id: "2", tool: "send_to_agent", arguments: { sessionId: child.sessionId, prompt: "now part B" } });
  assert.equal((await wait(1)).reason, "timeout");
  terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "working" });
  terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "idle" });
  assert.equal((await wait(1)).reason, "idle");
});

test("the skill tells the orchestrator to pass a model the person names", async () => {
  const { readFile } = await import("node:fs/promises");
  const skill = await readFile(new URL("../agent/orchestrator/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /If the person names a model, pass it as `model`/u);
});

test("OpenCode waits return within 50 seconds and never block on a separate review", async () => {
  const { control } = setup();
  let received;
  control.waitFor = async (_id, request) => {
    received = request;
    return { sessionId: "child", reason: "timeout", status: "working", output: "progress", exitCode: null, waitedMs: 100000 };
  };
  control.resultWithReview = () => { throw new Error("must not wait beyond the tool deadline"); };
  const handler = new ScopedOrchestrationHandler(control);
  const result = await call(handler, "wait_for_agent", { sessionId: "child", timeoutSeconds: 600 });
  assert.equal(received.timeoutMs, 50000);
  assert.equal(received.deferReview, true);
  assert.equal(result.output, "progress");
  assert.match(result.message, /Call wait_for_agent again/);
});


test("get_agent_result returns pending during a slow review and reuses its final outcome", { timeout: 1000 }, async () => {
  const { terminals, control, handler } = setup();
  terminals.sessions.get("child").status = "idle";
  control.reviewRequested.add("child");
  let finish;
  let reviews = 0;
  control.performReview = () => { reviews++; return new Promise((resolve) => { finish = resolve; }); };
  const pending = await call(handler, "get_agent_result", { sessionId: "child" });
  assert.equal(pending.review.status, "pending");
  assert.equal((await call(handler, "get_agent_result", { sessionId: "child" })).review.status, "pending");
  assert.equal(reviews, 1);
  finish({ status: "accepted", costUsd: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await call(handler, "get_agent_result", { sessionId: "child" })).review.status, "accepted");
  assert.equal(reviews, 1);
});
