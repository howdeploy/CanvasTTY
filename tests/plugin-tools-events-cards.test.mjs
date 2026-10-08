import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { PluginAgentTools, checkArguments, pluginToolName } from "../src/main/services/PluginAgentTools.ts";
import { PluginSessions, plainText } from "../src/main/services/PluginSessions.ts";
import { PluginCards } from "../src/main/services/PluginCards.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import { codexMcpArgs, qwenMcpArgs } from "../src/main/services/agent-browser/ProviderLaunch.ts";
import { SecretRedactionRegistry } from "../src/main/services/safety/SecretRedaction.ts";
import { checkBaseProtection } from "../src/main/services/safety/baseProtection.ts";
import { createOrchestrationDispatcher } from "../src/agent-browser/orchestration-helper.mjs";
import { ORCHESTRATION_TOOL_NAMES, isPluginOrchestrationTool } from "../src/agent-browser/orchestration-catalog.mjs";
import { TerminalSessionStore, normalizePersistedTerminalSessions } from "../src/main/services/TerminalSessionStore.ts";
import { cardActionMatches } from "../src/shared/pluginCardActions.ts";

const example = new URL("../examples/plugins/collect-demo/", import.meta.url);
const exampleManifest = JSON.parse(await readFile(new URL("canvastty.plugin.json", example), "utf8"));
const SECRET = "tool-secret-7c1f0e93d2";
const cwd = process.cwd();
const at = { x: 0, y: 0 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

function clis() {
  return {
    get(provider) {
      return { state: "available", provider, executable: `/resolved/${provider}`, launcher: "native",
        environment: { PATH: "/usr/bin" }, checked: [] };
    },
    snapshot() { return {}; }
  };
}

function spawner(calls) {
  return (command, args, options) => {
    const exits = [];
    const data = [];
    const writes = [];
    calls.push({
      command, args, options, writes,
      exit: (code) => exits.forEach((listener) => listener({ exitCode: code })),
      print: (text) => data.forEach((listener) => listener(text))
    });
    return {
      pid: 60_000 + calls.length, process: command, write(text) { writes.push(text); }, resize() {}, kill() {}, pause() {}, resume() {},
      onData(listener) { data.push(listener); return { dispose() {} }; },
      onExit(listener) { exits.push(listener); return { dispose() {} }; }
    };
  };
}

/** A terminal manager whose events feed a PluginSessions, the way the main process wires them. */
function world({ agentBrowser, orchestration, installRecord=()=>null } = {}) {
  const calls = [];
  const notices = [];
  let sessions = null;
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload),
    clis(), agentBrowser, undefined, true, spawner(calls));
  if (orchestration) terminals.configureOrchestration(orchestration);
  const redaction = new SecretRedactionRegistry();
  redaction.add("test", [SECRET]);
  terminals.configureRedaction(redaction);
  sessions = new PluginSessions({
    terminals, installRecord,
    notify: (pluginId, serviceId, method, params) => { notices.push({ pluginId, serviceId, method, params: structuredClone(params) }); return true; }
  });
  return { calls, notices, terminals, sessions, redaction };
}

const toolProvider = (extra = {}) => ({
  pluginId: "collect-demo",
  pluginName: "Collect Demo",
  serviceId: "collect",
  tools: validatePluginManifest(exampleManifest).services[0].tools,
  ...extra
});

test("manifests: tools need tools:agents, card actions need cards:decorate, schemas are checked", () => {
  const service = validatePluginManifest(exampleManifest).services[0];
  assert.equal(service.tools[0].name, "diffstat");
  assert.deepEqual(service.tools[0].roles, ["orchestrator"]);
  assert.deepEqual(service.cardActions[0], { id: "show-changes", title: "Show changes", when: { environmentKinds: ["worktree"] } });
  const without = (permission) => ({ ...exampleManifest, permissions: exampleManifest.permissions.filter((item) => item !== permission) });
  assert.throws(() => validatePluginManifest(without("tools:agents")), /tools:agents/u);
  assert.throws(() => validatePluginManifest(without("cards:decorate")), /cards:decorate/u);
  const withTool = (tool) => ({
    ...exampleManifest,
    services: [{ ...exampleManifest.services[0], tools: [{ ...exampleManifest.services[0].tools[0], ...tool }] }]
  });
  assert.throws(() => validatePluginManifest(withTool({ name: "Diff.Stat" })), /name is invalid/u);
  assert.throws(() => validatePluginManifest(withTool({ inputSchema: { type: "string" } })), /inputSchema/u);
  assert.throws(() => validatePluginManifest(withTool({ inputSchema: { type: "object", description: "x".repeat(9_000) } })), /8 KB/u);
  assert.throws(() => validatePluginManifest(withTool({ roles: ["admin"] })), /roles/u);
  assert.throws(() => validatePluginManifest({
    ...exampleManifest,
    services: [{ ...exampleManifest.services[0], cardActions: [{ id: "x", title: "X", when: { environmentKinds: ["Bad Kind"] } }] }]
  }), /environmentKinds/u);
  const withActions=count=>({...exampleManifest,services:[{...exampleManifest.services[0],
    cardActions:Array.from({length:count},(_,index)=>({id:`action-${index}`,title:`Action ${index}`}))}]});
  assert.equal(validatePluginManifest(withActions(16)).services[0].cardActions.length,16);
  assert.throws(()=>validatePluginManifest(withActions(17)),/between 1 and 16/u);
});

test("tool listing follows the session's role and agent; names are <pluginId>__<tool>", () => {
  const tools = new PluginAgentTools({
    providers: () => [toolProvider(), toolProvider({
      pluginId: "com.example.helper", pluginName: "Helper",
      tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" }, roles: ["agent", "subagent"] }]
    })],
    call: async () => null, caller: () => null, redact: (text) => text
  });
  assert.deepEqual(tools.names("orchestrator"), ["collect-demo__diffstat"]);
  assert.deepEqual(tools.names("agent"), ["com_example_helper__lookup"]);
  assert.deepEqual(tools.names("subagent", "codex"), ["com_example_helper__lookup"]);
  assert.match(tools.list("orchestrator")[0].description, /Collect Demo/u);
  // Kimi and Hermes share one config file between cards: they get no plugin tools.
  assert.deepEqual(tools.names("orchestrator", "kimi"), []);
  assert.deepEqual(tools.names("orchestrator", "hermes"), []);
});

test("plugin tool names fit Anthropic and OpenAI (^[a-zA-Z0-9_-]{1,64}$); long ids are shortened, clashes are dropped", async () => {
  const apiName = /^[a-zA-Z0-9_-]{1,64}$/u;
  const longId = `org.${"very-long-segment.".repeat(4)}plugin`;
  const longTool = `t${"x".repeat(39)}`;
  const names = [pluginToolName("collect-demo", "diffstat"), pluginToolName("com.example.helper", "lookup"),
    pluginToolName(longId, longTool), pluginToolName(`${longId}2`, longTool)];
  assert.deepEqual(names.slice(0, 2), ["collect-demo__diffstat", "com_example_helper__lookup"]);
  for (const name of names) {
    assert.match(name, apiName);
    assert.ok(isPluginOrchestrationTool(name), name);
  }
  assert.equal(names[2].length, 64);
  assert.ok(names[2].endsWith(`__${longTool}`) && names[2].startsWith("org_very-long"));
  assert.notEqual(names[2], names[3], "two long ids stay apart");
  for (const bad of ["collect-demo.diffstat", "spawn_agent", "a__", "__tool", `a__${"x".repeat(62)}`, "A__tool"]) {
    assert.equal(isPluginOrchestrationTool(bad), false, bad);
  }
  // Two tools that would be listed under one name: neither is listed or callable.
  const calls = [];
  const tools = new PluginAgentTools({
    providers: () => [
      toolProvider(),
      { pluginId: longId, pluginName: "A", serviceId: "a", tools: [{ name: longTool, description: "A", inputSchema: { type: "object" }, roles: ["agent"] }] },
      { pluginId: "b.plugin", pluginName: "B", serviceId: "b", tools: [{ name: "same", description: "B", inputSchema: { type: "object" }, roles: ["agent"] }] }
    ],
    call: async (...args) => { calls.push(args); return "ok"; }, caller: () => ({ id: "s1" }), redact: (text) => text
  });
  assert.deepEqual(tools.names("agent"), ["b_plugin__same", names[2]]);
  const clashing = new PluginAgentTools({
    providers: () => [0, 1].map((index) => ({ pluginId: `p${index}.x`, pluginName: `P${index}`, serviceId: "s",
      tools: [{ name: "same", description: "x", inputSchema: { type: "object" }, roles: ["agent"] }] })),
    call: async () => "ok", caller: () => ({ id: "s1" }), redact: (text) => text
  });
  assert.deepEqual(clashing.names("agent"), ["p0_x__same", "p1_x__same"]);
  const forced = new PluginAgentTools({
    providers: () => [0, 1].map((index) => ({ pluginId: "p.x", pluginName: `P${index}`, serviceId: `s${index}`,
      tools: [{ name: "same", description: "x", inputSchema: { type: "object" }, roles: ["agent"] }] })),
    call: async (...args) => { calls.push(args); return "ok"; }, caller: () => ({ id: "s1" }), redact: (text) => text
  });
  assert.deepEqual(forced.names("agent"), []);
  await assert.rejects(forced.call("s1", "agent", "p_x__same", {}), /not available/u);
  assert.equal(calls.length, 0);
});

test("the orchestration handler lists core tools only for orchestrators and routes plugin tools with the caller", async () => {
  const { terminals } = world();
  const orchestrator = terminals.create({ provider: "claude", cwd, profile: "normal", position: at, role: "orchestrator" });
  const agent = terminals.create({ provider: "claude", cwd, profile: "normal", position: at });
  const calls = [];
  const plugin = new PluginAgentTools({
    providers: () => [toolProvider({ tools: [{ ...toolProvider().tools[0], roles: ["orchestrator", "agent"] }] })],
    call: async (pluginId, serviceId, method, params) => {
      calls.push({ pluginId, serviceId, method, params });
      return { content: `stat for ${params.caller.id} key=${SECRET}` };
    },
    caller: (id) => ({ id, role: "x" }),
    redact: (text) => text.replaceAll(SECRET, "[redacted]")
  });
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals), plugin);
  const optionalTools = new Set(["get_execution_strategy", "ask_user", "list_tasks", "claim_task", "update_task", "complete_task", "request_secret", "run_secret_request", "get_task_budget", "list_orchestration_templates", "apply_orchestration_template"]);
  assert.deepEqual(handler.listTools(orchestrator.id).map((tool) => tool.name), [...ORCHESTRATION_TOOL_NAMES.filter(name=>!optionalTools.has(name)), "collect-demo__diffstat"]);
  assert.deepEqual(handler.listTools(agent.id).map((tool) => tool.name), ["collect-demo__diffstat"]);
  // A plain agent never gets the core tools, even by name.
  await assert.rejects(handler.execute(agent.id, { id: "1", tool: "list_agents", arguments: {} }), /Only orchestrator sessions/u);
  const result = await handler.execute(agent.id, { id: "2", tool: "collect-demo__diffstat", arguments: {} });
  assert.deepEqual(result, { pluginTool: true, text: `stat for ${agent.id} key=[redacted]`, isError: false });
  assert.equal(calls[0].method, "canvastty.tools.call");
  assert.equal(calls[0].params.callerSessionId, agent.id);
  assert.equal(calls[0].params.tool, "diffstat");
  await assert.rejects(handler.execute(agent.id, { id: "3", tool: "collect-demo__diffstat", arguments: { sessionId: 7 } }), /sessionId must be a string/u);
  await assert.rejects(handler.execute(agent.id, { id: "4", tool: "collect-demo__diffstat", arguments: { extra: true } }), /Unexpected argument/u);
  await assert.rejects(handler.execute(agent.id, { id: "5", tool: "other-plugin__diffstat", arguments: {} }), /not available/u);
  assert.equal(calls.length, 1);
});

test("plugin tool answers: timeouts and errors are error results, output is redacted and bounded", async () => {
  let answer = async () => ({ content: "x".repeat(200_000) });
  const tools = new PluginAgentTools({
    providers: () => [toolProvider()],
    call: (...args) => answer(...args),
    caller: (id) => ({ id }),
    redact: (text) => text.replaceAll(SECRET, "[redacted]"),
    timeoutMs: 50
  });
  const long = await tools.call("s1", "orchestrator", "collect-demo__diffstat", {});
  assert.equal(long.isError, false);
  assert.ok(long.content.length < 40_000);
  assert.match(long.content, /\[cut: the plugin answer was too long\]$/u);
  answer = async () => ({ files: 2, secret: SECRET });
  assert.equal((await tools.call("s1", "orchestrator", "collect-demo__diffstat", {})).content, '{"files":2,"secret":"[redacted]"}');
  answer = () => new Promise(() => undefined);
  const late = await tools.call("s1", "orchestrator", "collect-demo__diffstat", {});
  assert.deepEqual(late, { content: 'Plugin "Collect Demo": The plugin tool did not answer in time.', isError: true });
  answer = async () => { throw new Error(`failed with ${SECRET}`); };
  assert.equal((await tools.call("s1", "orchestrator", "collect-demo__diffstat", {})).content, 'Plugin "Collect Demo": failed with [redacted]');
  await assert.rejects(tools.call("s1", "agent", "collect-demo__diffstat", {}), /not available/u);
  assert.equal(checkArguments({ type: "object", required: ["a"] }, {}), "Missing required argument: a.");
  // Plugin tools are CanvasTTY's own tools: base protection has nothing to say about them.
  assert.equal(checkBaseProtection({ toolName: "mcp__canvastty_agents__collect-demo__diffstat", toolInput: { sessionId: "x" },
    preview: null, root: cwd, commandCwd: null, home: tmpdir(), agentRoots: [] }), null);
});

test("the bridge lists per-session tools over the socket and the MCP helper returns plugin text as is", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctty-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { terminals } = world();
  const agent = terminals.create({ provider: "codex", cwd, profile: "normal", position: at });
  const plugin = new PluginAgentTools({
    providers: () => [toolProvider({ tools: [{ ...toolProvider().tools[0], roles: ["agent"] }] })],
    call: async () => ({ content: " 1 file changed" }), caller: (id) => ({ id }), redact: (text) => text
  });
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(directory, "rt"),
    windowsHostPath: join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe"),
    handler: new ScopedOrchestrationHandler(new AgentControlService(terminals), plugin)
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const capability = gateway.registerOrchestrator({ terminalSessionId: agent.id });
  const { OrchestrationClient } = await import("../src/agent-browser/orchestration-helper.mjs");
  const client = new OrchestrationClient({
    address: capability.address, connectionId: capability.connectionId,
    terminalSessionId: capability.terminalSessionId, capabilityToken: capability.capabilityToken
  });
  t.after(() => client.close());
  const dispatch = createOrchestrationDispatcher(client);
  const listed = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["collect-demo__diffstat"]);
  const called = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "collect-demo__diffstat", arguments: {} } });
  assert.deepEqual(called.result, { content: [{ type: "text", text: " 1 file changed" }], isError: false });
  const refused = await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_agent", arguments: { provider: "codex", cwd } } });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /Only orchestrator sessions/u);
});

test("a session a plugin tool applies to gets the bridge with exactly its tools at launch", () => {
  const prepared = [];
  const bridges = [];
  const { terminals } = world({
    agentBrowser: { prepareLaunch: (input) => { prepared.push(input); return null; } },
    orchestration: { isEnabled: true, prepareLaunch: (input) => { bridges.push(input); return { environment: {}, cleanup() {} }; } }
  });
  terminals.configureAgentTools((role, provider) => (role === "agent" && provider === "codex" ? ["collect-demo__diffstat"] : []));
  terminals.create({ provider: "codex", cwd, profile: "normal", position: at });
  terminals.create({ provider: "claude", cwd, profile: "normal", position: at });
  terminals.create({ provider: "claude", cwd, profile: "normal", position: at, role: "orchestrator" });
  assert.deepEqual(prepared.map((input) => input.orchestrationTools ?? null), [
    ["collect-demo__diffstat"],
    null,
    [...ORCHESTRATION_TOOL_NAMES]
  ]);
  assert.equal(bridges.length, 2);
  const helper = { command: "/node", args: ["/h.mjs"] };
  assert.match(codexMcpArgs(helper, helper, ["collect-demo__diffstat"]).join(" "), /enabled_tools=\["collect-demo__diffstat"\]/u);
  assert.match(qwenMcpArgs(helper, helper, ["collect-demo__diffstat"]).join(" "), /mcp__canvastty_agents__collect-demo__diffstat/u);
  const orchestrationConfig = codexMcpArgs(helper, helper).at(-1);
  const enabledToolsMatch = orchestrationConfig.match(/enabled_tools=(\[[^\]]*\])/u);
  assert.ok(enabledToolsMatch);
  const enabledTools = JSON.parse(enabledToolsMatch[1]);
  assert.ok(enabledTools.includes("list_providers"));
  assert.ok(enabledTools.includes("spawn_agent"));
});

test("session events carry card metadata, never screen text without sessions:read-screen", async () => {
  const { calls, notices, terminals, sessions } = world();
  assert.throws(() => sessions.handle("p1", "svc", "sessions.subscribe", {}, []), /sessions:events/u);
  const listed = sessions.handle("p1", "svc", "sessions.subscribe", {}, ["sessions:events"]);
  assert.deepEqual(listed, { sessions: [] });
  sessions.handle("p2", "svc", "sessions.subscribe", {}, ["sessions:events", "sessions:read-screen"]);
  const card = terminals.create({ provider: "terminal", cwd, profile: "normal", position: at, title: "Build" });
  await flush();
  calls[0].print(`\u001b[32mcompiling\u001b[0m with ${SECRET}\r\n`);
  terminals.applyProviderSignal?.(card.id, { kind: "lifecycle", state: "working" });
  calls[0].exit(3);
  await flush();
  terminals.dispose(card.id);
  await flush();
  const forPlugin = (pluginId) => notices.filter((notice) => notice.pluginId === pluginId).map((notice) => notice.params);
  const plain = forPlugin("p1");
  assert.deepEqual(plain.map((event) => event.type).filter((type) => type !== "status"), ["created", "exited", "closed"]);
  assert.equal(plain[0].session.id, card.id);
  assert.equal(plain[0].session.title, "Build");
  assert.equal(plain[0].session.workingDirectory, cwd);
  assert.equal(plain[0].owned, false);
  assert.ok(plain.every((event) => !("screen" in event)), "no screen text without the permission");
  assert.equal(notices[0].method, "canvastty.sessions.event");
  const screened = forPlugin("p2").find((event) => event.type === "exited");
  assert.match(screened.screen, /^compiling with \S+\n$/u);
  assert.ok(!screened.screen.includes(SECRET), "screen text is redacted");
  assert.ok(!screened.screen.includes("\u001b"), "screen text is plain");
  // A stopped service subscribes again when it starts.
  sessions.serviceStopped("p1", "svc");
  terminals.create({ provider: "terminal", cwd, profile: "normal", position: at });
  await flush();
  assert.equal(forPlugin("p1").length, plain.length);
  assert.equal(plainText("a\u001b]0;title\u0007b\r\n"), "ab\n");
});

test("completed-tool activity carries one-use host evidence scoped to a live card turn", () => {
  const { notices, terminals, sessions } = world({installRecord:()=>({sourceUrl:"https://github.com/BIackFIame/canvastty-plugin-assistant.git",enabled:true,nativeCodeTrusted:true})});
  sessions.handle("canvastty-assistant", "assistant", "sessions.subscribe", {}, ["sessions:events"]);
  const card = terminals.create({ provider: "claude", cwd, profile: "normal", position: at });
  sessions.activity({
    type: "tool-outcome", sessionId: card.id, at: Date.now(), turnId: "turn:42", turnEpoch: 42, toolName: `Edit ${SECRET}`,
    resultClass: "error", normalizedActionHash: "a".repeat(64), errorHash: "b".repeat(64),
    changedPathHashes: ["c".repeat(64), SECRET], rawToolInput: SECRET, rawError: SECRET
  });
  const activity = notices.find((notice) => notice.method === "canvastty.activity");
  assert.ok(activity);
  const evidenceId = activity.params.evidenceId;
  assert.match(evidenceId, /^[A-Za-z0-9_-]{24}$/u);
  const { evidenceId: _evidenceId, ...safeActivity } = activity.params;
  assert.deepEqual(safeActivity, {
    type: "tool-outcome", sessionId: card.id, at: activity.params.at, turnId: "turn:42", turnEpoch: 42,
    toolName: `Edit <redacted:secret>`, resultClass: "error",
    normalizedActionHash: activity.params.normalizedActionHash, errorHash: activity.params.errorHash, changedPathHashes: activity.params.changedPathHashes
  });
  for(const hash of [activity.params.normalizedActionHash,activity.params.errorHash,...activity.params.changedPathHashes])assert.match(hash,/^[a-f0-9]{64}$/);
  assert.notEqual(activity.params.normalizedActionHash,"a".repeat(64));
  assert.notEqual(activity.params.errorHash,"b".repeat(64));
  assert.notEqual(activity.params.changedPathHashes[0],"c".repeat(64));
  assert.equal(JSON.stringify(activity.params).includes(SECRET), false);
  assert.equal(sessions.consumeLoopEvidence(card.id, evidenceId, 42), true, "current-turn evidence is accepted once");
  assert.equal(sessions.consumeLoopEvidence(card.id, evidenceId, 42), false, "replay cannot reuse consumed evidence");

  sessions.activity({ type: "tool-outcome", sessionId: card.id, at: Date.now(), turnEpoch: 42,
    toolName: "Read", resultClass: "success", changedPathHashes: [] });
  const staleEvidenceId = notices.filter((notice) => notice.method === "canvastty.activity").at(-1).params.evidenceId;
  assert.equal(sessions.consumeLoopEvidence(card.id, staleEvidenceId, 43), false, "evidence from another host turn is rejected and consumed");
  assert.equal(sessions.consumeLoopEvidence(card.id, staleEvidenceId, 42), false);
  assert.equal(sessions.consumeLoopEvidence(card.id, "not-issued", 42), false, "unissued evidence is rejected");

  sessions.activity({
    type: "pretool", sessionId: card.id, at: Date.now(), turnId: "turn:43", turnEpoch: 43,
    toolName: `Bash ${SECRET}`, normalizedActionHash: "f".repeat(64), toolInput: SECRET
  });
  const pretool = notices.find((notice) => notice.method === "canvastty.activity" && notice.params.type === "activity");
  assert.match(pretool.params.evidenceId, /^[A-Za-z0-9_-]{24}$/u);
  const { evidenceId: _pretoolEvidenceId, ...safePretool } = pretool.params;
  assert.deepEqual(safePretool, {
    type: "activity", sessionId: card.id, at: pretool.params.at, turnId: "turn:43", turnEpoch: 43,
    toolName: "Bash <redacted:secret>", normalizedAction: pretool.params.normalizedAction, normalizedActionHash: pretool.params.normalizedActionHash
  });
  assert.match(pretool.params.normalizedAction,/^[a-f0-9]{64}$/);
  assert.equal(pretool.params.normalizedAction,pretool.params.normalizedActionHash);
  assert.notEqual(pretool.params.normalizedAction,"f".repeat(64));
  const foreignSessionId = "not-the-evidence-session";
  assert.equal(sessions.consumeLoopEvidence(foreignSessionId, pretool.params.evidenceId, 43), false);

  sessions.activity({ type: "tool-outcome", sessionId: card.id, at: Date.now(), turnEpoch: 43,
    toolName: "Read", resultClass: "success", changedPathHashes: [] });
  const expiredEvidenceId = notices.filter((notice) => notice.method === "canvastty.activity").at(-1).params.evidenceId;
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 60_001;
    assert.equal(sessions.consumeLoopEvidence(card.id, expiredEvidenceId, 43), false, "evidence expires after its bounded window");
  } finally {
    Date.now = originalNow;
  }

  sessions.activity({ type: "tool-outcome", sessionId: card.id, at: Date.now(), turnEpoch: 43,
    toolName: "Read", resultClass: "success", changedPathHashes: [] });
  const closedEvidenceId = notices.filter((notice) => notice.method === "canvastty.activity").at(-1).params.evidenceId;
  const lastOutcome = () => notices.filter((notice) => notice.params.type === "tool-outcome").at(-1).params;
  sessions.activity({ type: "tool-outcome", sessionId: card.id, at: Date.now(), turnEpoch: 43, toolName: "Bash", resultClass: "success",
    changedPathHashes: [], outputHash: "d".repeat(64) });
  assert.match(lastOutcome().outputHash,/^[a-f0-9]{64}$/);
  assert.notEqual(lastOutcome().outputHash,"d".repeat(64),"output is opaque at the plugin boundary");
  sessions.activity({ type: "tool-outcome", sessionId: card.id, at: Date.now(), turnEpoch: 43, toolName: "Bash", resultClass: "error",
    changedPathHashes: [], outputHash: "e".repeat(64) });
  assert.equal(lastOutcome().resultClass, "error");
  assert.equal("outputHash" in lastOutcome(), false, "an error keeps only its error hash");
  terminals.dispose(card.id);
  assert.equal(sessions.consumeLoopEvidence(card.id, closedEvidenceId, 43), false, "session removal retires outstanding evidence");
  sessions.activity({
    type: "tool-outcome", sessionId: card.id, at: Date.now(), turnId: "x".repeat(161),
    toolName: "Bash", resultClass: "success", changedPathHashes: []
  });
  const bounded = notices.filter((notice) => notice.params.type === "tool-outcome").at(-1).params;
  assert.equal("turnId" in bounded, false, "invalid or overlong turn identifiers are omitted");

});

test("plugins control only the sessions they created (create, send, stop), like agent-control controllers", async () => {
  const { calls, notices, terminals, sessions } = world();
  const launch = ["sessions:launch", "sessions:control", "sessions:events"];
  assert.throws(() => sessions.handle("p1", "svc", "sessions.create", { provider: "terminal", cwd }, ["sessions:events"]), /sessions:launch/u);
  sessions.handle("p1", "svc", "sessions.subscribe", { ownedOnly: true }, launch);
  const { sessionId } = sessions.handle("p1", "svc", "sessions.create", { provider: "terminal", cwd, title: "Mine" }, launch);
  const foreign = terminals.create({ provider: "terminal", cwd, profile: "normal", position: at });
  await flush();
  assert.equal(terminals.listMetadata().find((item) => item.id === sessionId).role, "agent");
  // ownedOnly: only its own card's events, marked owned.
  assert.deepEqual(notices.map((notice) => [notice.params.type, notice.params.session.id, notice.params.owned]), [["created", sessionId, true]]);
  assert.deepEqual(await sessions.handle("p1", "svc", "sessions.send", { sessionId, text: "ls" }, launch), { sessionId, sent: true });
  assert.deepEqual(calls[0].writes, ["ls\r"]);
  for (const id of [foreign.id, "missing"]) {
    assert.throws(() => sessions.handle("p1", "svc", "sessions.send", { sessionId: id, text: "rm -rf ." }, launch), /No session this plugin started/u);
    assert.throws(() => sessions.handle("p1", "svc", "sessions.stop", { sessionId: id }, launch), /No session this plugin started/u);
  }
  // Another plugin cannot touch it either, and control needs its own permission.
  assert.throws(() => sessions.handle("p2", "svc", "sessions.stop", { sessionId }, launch), /No session this plugin started/u);
  assert.throws(() => sessions.handle("p1", "svc", "sessions.send", { sessionId, text: "x" }, ["sessions:launch"]), /sessions:control/u);
  assert.deepEqual(calls[1].writes, [], "the foreign card got nothing");
  assert.deepEqual(sessions.handle("p1", "svc", "sessions.list", { ownedOnly: true }, launch).sessions.map((item) => item.id), [sessionId]);
  assert.deepEqual(sessions.handle("p1", "svc", "sessions.stop", { sessionId }, launch), { sessionId, stopped: true });
  assert.ok(!terminals.listMetadata().some((item) => item.id === sessionId));
  assert.ok(terminals.listMetadata().some((item) => item.id === foreign.id));
  assert.throws(() => sessions.handle("p1", "svc", "sessions.create", { provider: "terminal", cwd, profile: "root" }, launch), /profile/u);
  assert.equal(sessions.handle("p1", "svc", "sessions.delete", {}, launch), undefined, "unknown methods fall through");
});

test("a plugin keeps control of the cards it started after a restore; the owner is saved on the record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launch = ["sessions:launch", "sessions:control", "sessions:events"];
  const start = async () => {
    const calls = [];
    const notices = [];
    let sessions = null;
    const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload),
      clis(), undefined, undefined, true, spawner(calls));
    terminals.configureSessionPersistence(new TerminalSessionStore(directory), "reopen");
    sessions = new PluginSessions({ terminals, notify: (pluginId, serviceId, method, params) => { notices.push(structuredClone(params)); return true; } });
    sessions.handle("owner.plugin", "svc", "sessions.subscribe", { ownedOnly: true }, launch);
    await terminals.restorePersistedSessions();
    return { calls, notices, terminals, sessions };
  };
  const first = await start();
  const { sessionId } = first.sessions.handle("owner.plugin", "svc", "sessions.create", { provider: "terminal", cwd, title: "Mine" }, launch);
  first.terminals.create({ provider: "terminal", cwd, profile: "normal", position: at, title: "Person's" });
  await flush();
  await first.terminals.shutdown();
  const saved = await new TerminalSessionStore(directory).load();
  assert.deepEqual(saved.map((record) => record.ownerPluginId ?? null), ["owner.plugin", null]);
  const second = await start();
  await flush();
  const mine = second.terminals.listMetadata().find((item) => item.title === "Mine");
  const theirs = second.terminals.listMetadata().find((item) => item.title === "Person's");
  assert.equal(mine.id, sessionId);
  assert.deepEqual(second.notices.map((event) => [event.type, event.session.id, event.owned]), [["restored", sessionId, true]]);
  assert.deepEqual(await second.sessions.handle("owner.plugin", "svc", "sessions.send", { sessionId, text: "ls" }, launch), { sessionId, sent: true });
  assert.throws(() => second.sessions.handle("other.plugin", "svc", "sessions.send", { sessionId, text: "ls" }, launch), /No session this plugin started/u);
  assert.throws(() => second.sessions.handle("owner.plugin", "svc", "sessions.stop", { sessionId: theirs.id }, launch), /No session this plugin started/u);
  second.sessions.handle("owner.plugin", "svc", "sessions.stop", { sessionId }, launch);
  await flush();
  assert.deepEqual(second.notices.at(-1), { ...second.notices.at(-1), type: "closed", owned: true });
  await second.terminals.shutdown();
  // An unreadable owner is dropped, never guessed.
  const base = { id: "x", provider: "terminal", profile: "normal", title: "T", titleCustomized: false, cwd,
    position: at, size: { width: 700, height: 430 }, lastState: "running", restore: true };
  assert.equal(normalizePersistedTerminalSessions({ version: 2, sessions: [{ ...base, ownerPluginId: "Bad Id" }] }).sessions[0].ownerPluginId, undefined);
});

test("card badges and actions: plain text, filtered by card, answers redacted, failures are error toasts", async () => {
  const { terminals, sessions } = world();
  const card = terminals.create({ provider: "terminal", cwd, profile: "normal", position: at });
  const published = [];
  let trusted = new Set(["collect-demo"]);
  let answer = async (params) => ({ message: `\u001b[1m 1 file changed\u001b[0m in ${params.session.workingDirectory} ${SECRET}`, tone: "info" });
  const cards = new PluginCards({
    providers: () => (trusted.has("collect-demo") ? [{ pluginId: "collect-demo", pluginName: "Collect Demo", serviceId: "collect",
      actions: validatePluginManifest(exampleManifest).services[0].cardActions }] : []),
    trustedPlugins: () => trusted,
    call: (pluginId, serviceId, method, params) => answer(params, method),
    session: (id) => sessions.summary(id),
    redact: (text) => text.replaceAll(SECRET, "[redacted]"),
    changed: (decorations) => published.push(decorations),
    timeoutMs: 50
  });
  assert.throws(() => cards.setBadge("collect-demo", { sessionId: card.id, badge: { text: "x".repeat(25) } }), /1 to 24/u);
  assert.throws(() => cards.setBadge("collect-demo", { sessionId: card.id, badge: { text: "ok", tone: "pink" } }), /tone/u);
  assert.throws(() => cards.setBadge("collect-demo", { sessionId: "missing", badge: { text: "ok" } }), /No card/u);
  cards.setBadge("collect-demo", { sessionId: card.id, badge: { text: "<b>2\nchanged</b>", tone: "info", tooltip: SECRET } });
  assert.deepEqual(published.at(-1).badges[card.id], [{ pluginId: "collect-demo", text: "<b>2 changed</b>", tone: "info", tooltip: "[redacted]" }]);
  assert.deepEqual(published.at(-1).actions, [{
    pluginId: "collect-demo", pluginName: "Collect Demo", actionId: "show-changes", title: "Show changes", when: { environmentKinds: ["worktree"] }
  }]);
  // The action applies to worktree cards only; the renderer and the host use the same filter.
  const when = { environmentKinds: ["worktree"] };
  assert.equal(cardActionMatches(when, { provider: "terminal", role: "agent" }), false);
  assert.equal(cardActionMatches(when, { provider: "claude", role: "agent", environment: { kind: "worktree" } }), true);
  assert.equal(cardActionMatches({ providers: ["codex"], roles: ["orchestrator"] }, { provider: "codex", role: "agent" }), false);
  await assert.rejects(cards.invoke("collect-demo", "show-changes", card.id), /does not apply/u);
  const worktreeCard = { ...sessions.summary(card.id), environment: { pluginId: "e", kind: "worktree", label: "w", ref: {} } };
  const cardsFor = new PluginCards({ ...cards.deps, session: () => worktreeCard });
  // Escape characters are dropped (plain text only) and secrets masked.
  assert.deepEqual(await cardsFor.invoke("collect-demo", "show-changes", card.id),
    { tone: "info", message: `[1m 1 file changed[0m in ${cwd} [redacted]` });
  answer = () => new Promise(() => undefined);
  assert.deepEqual(await cardsFor.invoke("collect-demo", "show-changes", card.id), { tone: "error", message: "Collect Demo: The plugin did not answer in time." });
  await assert.rejects(cardsFor.invoke("collect-demo", "other", card.id), /not available/u);
  // A plugin may declare actions on several services (one per module): each goes to its own service.
  const called = [];
  const split = new PluginCards({ ...cards.deps, session: () => worktreeCard,
    providers: () => ["a", "b"].map((serviceId) => ({ pluginId: "collect-demo", pluginName: "Collect Demo", serviceId,
      actions: [{ id: `act-${serviceId}`, title: serviceId }] })),
    call: async (pluginId, serviceId) => { called.push(serviceId); return {}; } });
  await split.invoke("collect-demo", "act-b", card.id);
  await split.invoke("collect-demo", "act-a", card.id);
  assert.deepEqual(called, ["b", "a"]);
  // Revoking trust hides the plugin's badges and actions.
  trusted = new Set();
  cards.refresh();
  assert.deepEqual(published.at(-1), { badges: {}, actions: [] });
  trusted = new Set(["collect-demo"]);
  cards.forgetSession(card.id);
  assert.deepEqual(published.at(-1).badges, {});
  cards.setBadge("collect-demo", { sessionId: card.id, badge: null });
});

test("collect-demo through the real supervisor: the action and the tool return git diff --stat of a worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-collect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const tree = join(root, "tree");
  git("worktree", "add", "-q", "-b", "feature", tree);
  await writeFile(join(tree, "a.txt"), "one\ntwo\n");

  const { terminals, sessions } = world();
  const badges = [];
  let cards = null;
  const pluginRoot = fileURLToPath(new URL(".", example));
  const entryPath = join(pluginRoot, "services", "collect.mjs");
  const permissions = validatePluginManifest(exampleManifest).permissions;
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: {
      storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined,
      sessions: (pluginId, serviceId, method, params, granted) => sessions.handle(pluginId, serviceId, method, params, granted),
      setBadge: (pluginId, params) => cards.setBadge(pluginId, params),
      stopped: (pluginId, serviceId) => sessions.serviceStopped(pluginId, serviceId)
    }
  });
  t.after(() => supervisor.dispose());
  // The sessions port now notifies the real service.
  sessions.deps.notify = (pluginId, serviceId, method, params) => supervisor.notify(pluginId, serviceId, method, params);
  cards = new PluginCards({
    providers: () => [{ pluginId: "collect-demo", pluginName: "Collect Demo", serviceId: "collect",
      actions: validatePluginManifest(exampleManifest).services[0].cardActions }],
    trustedPlugins: () => new Set(["collect-demo"]),
    call: (pluginId, serviceId, method, params, budget) => supervisor.hostCall(pluginId, serviceId, method, params, budget),
    session: (id) => {
      const summary = sessions.summary(id);
      // A worktree card: what the env-worktree plugin's wrap does to the launch folder.
      return summary && { ...summary, workingDirectory: tree, environment: { pluginId: "e", kind: "worktree", label: "w", ref: { dir: tree } } };
    },
    redact: (text) => text,
    changed: (decorations) => badges.push(decorations.badges)
  });
  const tools = new PluginAgentTools({
    providers: () => [toolProvider()],
    call: (pluginId, serviceId, method, params, budget) => supervisor.hostCall(pluginId, serviceId, method, params, budget),
    caller: (id) => sessions.summary(id),
    redact: (text) => text
  });
  const orchestrator = terminals.create({ provider: "claude", cwd: repo, profile: "normal", position: at, role: "orchestrator" });
  await supervisor.sync([{ pluginId: "collect-demo", serviceId: "collect", root: pluginRoot, entryPath,
    sha256: createHash("sha256").update(await readFile(entryPath)).digest("hex"), dataDir: join(root, "data"), permissions }]);
  // It subscribes at start; a card created afterwards reaches it as an event.
  await waitFor(() => sessions.subscribers.size === 1);
  const child = terminals.create({ provider: "claude", cwd: tree, profile: "normal", position: at, role: "subagent", parentSessionId: orchestrator.id });

  const shown = await cards.invoke("collect-demo", "show-changes", child.id);
  assert.equal(shown.tone, "info");
  assert.match(shown.message, /a\.txt \| 1 \+\n 1 file changed, 1 insertion\(\+\)/u);
  assert.deepEqual(badges.at(-1)[child.id], [{ pluginId: "collect-demo", text: "1 changed", tone: "info", tooltip: "Files changed in the worktree" }]);

  assert.deepEqual(await tools.call(orchestrator.id, "orchestrator", "collect-demo__diffstat", {}), { content: `No changes in ${repo}.`, isError: false });
  await waitFor(async () => !(await tools.call(orchestrator.id, "orchestrator", "collect-demo__diffstat", { sessionId: child.id })).isError);
  const stat = await tools.call(orchestrator.id, "orchestrator", "collect-demo__diffstat", { sessionId: child.id });
  assert.match(stat.content, /1 file changed/u);
  // The plugin's own rule: only the caller's subagents.
  const other = terminals.create({ provider: "terminal", cwd: repo, profile: "normal", position: at });
  await waitFor(async () => (await tools.call(other.id, "orchestrator", "collect-demo__diffstat", { sessionId: child.id })).isError);
});

test("badges of plugins whose trust was revoked do not use up a card's badge slots", () => {
  let trusted = new Set(["p1", "p2", "p3", "p4", "p5"]);
  const published = [];
  const cards = new PluginCards({
    providers: () => [],
    trustedPlugins: () => trusted,
    call: async () => ({}),
    session: (id) => (id === "card-1" ? { id } : null),
    redact: (text) => text,
    changed: (decorations) => published.push(decorations)
  });
  for (const pluginId of ["p1", "p2", "p3", "p4"]) cards.setBadge(pluginId, { sessionId: "card-1", badge: { text: pluginId } });
  assert.throws(() => cards.setBadge("p5", { sessionId: "card-1", badge: { text: "p5" } }), /most plugin badges/u);
  trusted = new Set(["p5"]);
  cards.refresh();
  assert.deepEqual(published.at(-1).badges, {});
  // Four hidden badges of revoked plugins used to keep p5 out.
  cards.setBadge("p5", { sessionId: "card-1", badge: { text: "p5" } });
  assert.deepEqual(published.at(-1).badges["card-1"].map((badge) => badge.pluginId), ["p5"]);
});
