import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROVIDER_IDS,
  CLIENT_SAFE_AGENT_WAIT_SECONDS,
  DEFAULT_AGENT_WAIT_SECONDS,
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
  assert.ok(DEFAULT_AGENT_WAIT_SECONDS <= CLIENT_SAFE_AGENT_WAIT_SECONDS && CLIENT_SAFE_AGENT_WAIT_SECONDS < 60,
    "a call without timeoutSeconds, and every call from a 60-second MCP client, ends before that client gives up");
  assert.equal(validateOrchestrationArguments("wait_for_agent", { sessionId: "a", timeoutSeconds: 100 }).ok, true);
  assert.match(validateOrchestrationArguments("wait_for_agent", { sessionId: "a", timeoutSeconds: 101 }).error, /above the maximum/u);
  assert.match(definition("wait_for_agent").description, /at most 100; unless this session is Claude Code, a call returns after at most 50 seconds/u);
  assert.match(definition("wait_for_agent").description, /A timeout means it is still running: read output as its progress and call wait_for_agent again/u);
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
  const { availableRegistry, fakeSpawner, openCodeInputReady } = await import("./helpers/terminal.mjs");
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

  const spawning = handler.execute(orchestrator.id, { id: "1", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, prompt: "do part A" } });
  await openCodeInputReady(calls, 2);
  const child = await spawning;
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

test("wait_for_agent returns before the orchestrator's MCP client gives up, as a timeout that says the agent still runs", async () => {
  for (const [provider, requested, expectedMs] of [
    ["opencode", 100, 50_000], ["codex", 100, 50_000], ["opencode", undefined, 50_000], ["opencode", 20, 20_000], ["claude", 100, 100_000]
  ]) {
    const { terminals, control, handler } = setup();
    terminals.sessions.get("orch").provider = provider;
    let received;
    const real = control.waitFor.bind(control);
    control.waitFor = (id, request) => { received = request.timeoutMs; return real(id, { ...request, timeoutMs: 30 }); };
    terminals.sessions.get("child").buffer = "step 3 of 5";
    const result = await call(handler, "wait_for_agent", { sessionId: "child", ...(requested ? { timeoutSeconds: requested } : {}) });
    assert.equal(received, expectedMs, `${provider} asking for ${requested ?? "the default"}`);
    assert.deepEqual([result.reason, result.status, result.output], ["timeout", "working", "step 3 of 5"]);
    assert.match(result.message, /Still running\. Read output for its progress and call wait_for_agent again\./u);
  }
  const { terminals, handler } = setup();
  terminals.sessions.get("child").status = "idle";
  assert.equal((await call(handler, "wait_for_agent", { sessionId: "child" })).message, undefined, "only a timeout says to call again");
});

/** A recorded OpenCode-style session: alternate screen, absolute cursor moves, colors, a spinner and in-place redraws. */
function openCodeRedraws() {
  const e = "\u001b";
  const at = (row, column) => `${e}[${row};${column}H`;
  const parts = [
    `${e}[?1049h${e}[?25l${e}[?2004h${e}]0;opencode${e}\\${e}[2J${e}[H`,
    `${at(1, 1)}${e}[48;2;24;24;37m${e}[38;2;205;214;244m┃ opencode  build  gpt-5.5${e}[K${e}[0m`,
    `${at(3, 3)}${e}[1mYou${e}[22m`,
    `${at(4, 3)}${e}[38;5;252mFix the failing Button test${e}[39m`,
    `${at(6, 3)}${e}[38;5;245mThinking${e}[0m`
  ];
  // The spinner turns in place many times while the model works.
  for (let turn = 0; turn < 120; turn++) parts.push(`${at(6, 12)}${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[turn % 10]}${at(40, 1)}${e}[7m working ${turn}s ${e}[27m${e}[K`);
  parts.push(
    `${at(6, 1)}${e}[2K${at(6, 3)}${e}[38;2;166;227;161mThe Button test passes now.${e}[0m`,
    `${at(7, 3)}Used key sk-secret-value for the request.`,
    `${at(8, 3)}${e}[38;5;111m│${e}[0m src/Button.tsx ${e}[32m+3${e}[0m ${e}[31m-1${e}[0m`,
    `${at(40, 1)}${e}[2K${e}[7m ctrl+p commands ${e}[27m`
  );
  return parts.join("");
}

test("wait_for_agent and get_agent_result return a TUI's screen as plain text, not its escape sequences", async () => {
  const { terminals, handler } = setup();
  const child = terminals.sessions.get("child");
  setTimeout(() => {
    child.buffer = openCodeRedraws();
    child.outputOffset = child.buffer.length;
    child.status = "idle";
  }, 20);
  const waited = await call(handler, "wait_for_agent", { sessionId: "child", timeoutSeconds: 5 });
  const result = await call(handler, "get_agent_result", { sessionId: "child" });
  for (const output of [waited.output, result.output]) {
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(output), false, "no control characters or escape sequences");
    assert.deepEqual(output.split("\n"), [
      "┃ opencode  build  gpt-5.5",
      "",
      "  You",
      "  Fix the failing Button test",
      "",
      "  The Button test passes now.",
      "  Used key [redacted] for the request.",
      "  │ src/Button.tsx +3 -1",
      ...Array.from({ length: 31 }, () => ""),
      " ctrl+p commands"
    ]);
    assert.ok(!output.includes("sk-secret") && !output.includes("Thinking") && !output.includes("working"), "masked; only what the screen shows now");
  }
});

test("the plain-text output stays bounded and masked for a long line-based transcript", async () => {
  const { terminals, control } = setup();
  const child = terminals.sessions.get("child");
  child.buffer = Array.from({ length: 4_000 }, (_value, index) => `\u001b[32mline ${index}\u001b[0m with key sk-secret-value\r\n`).join("");
  child.outputOffset = child.buffer.length;
  child.status = "idle";
  const result = await control.result("child");
  assert.ok(result.output.length <= 8_192);
  assert.ok(result.output.endsWith("line 3999 with key [redacted]"), result.output.slice(-80));
  assert.ok(!result.output.includes("\u001b") && !result.output.includes("sk-secret"));
});

/** Invisible SGR resets that pad a stream to an exact length: any length from 6 up is a sum of 3s and 4s. */
function sgrPadding(length) {
  const e = "\u001b";
  let fours = 0;
  while ((length - 4 * fours) % 3 !== 0) fours++;
  return `${e}[0m`.repeat(fours) + `${e}[m`.repeat((length - 4 * fours) / 3);
}

test("a scrollback window that starts inside an escape sequence leaves no fragment of it on the screen", async () => {
  const { terminals, handler } = setup();
  const child = terminals.sessions.get("child");
  const e = "\u001b";
  const at = (row, column) => `${e}[${row};${column}H`;
  const start = "18;9Hof specialists who had internalized the machine.";
  const redraws = [];
  for (let turn = 0; turn < 900; turn++) redraws.push(`${at(40, 1)}${e}[7m working ${turn}s ${e}[27m${e}[K`);
  const end = `${at(3, 3)}The first response was the assembler.`;
  const body = start + redraws.join("") + end;
  // The last 65,536 characters (the window the screen is rendered from) begin right after the ESC [ of a cursor move.
  child.buffer = `${"earlier output\r\n".repeat(50)}${e}[` + body + sgrPadding(65_536 - body.length);
  child.outputOffset = child.buffer.length;
  child.status = "idle";
  const waited = await call(handler, "wait_for_agent", { sessionId: "child", timeoutSeconds: 5 });
  const result = await call(handler, "get_agent_result", { sessionId: "child" });
  for (const output of [waited.output, result.output]) {
    assert.ok(!output.includes("18;9H"), output.slice(0, 80));
    assert.ok(output.includes("  The first response was the assembler."), output);
  }
});

test("exitLines are the exited TUI's screen as plain text, not its redraws joined together", async () => {
  const { terminals, handler } = setup();
  const child = terminals.sessions.get("child");
  const e = "\u001b";
  const at = (row, column) => `${e}[${row};${column}H`;
  // Drawn once at the start and never again: still on the screen when the CLI exits, more than 16 KiB later.
  const early = `${at(3, 3)}${e}[2mThinking${e}[0m${at(8, 3)}${e}[38;5;111m▣  Build · glm-5.3-flash${e}[0m`;
  const turns = 1_300;
  const progress = [];
  for (let turn = 0; turn < turns; turn++) progress.push(`${at(2, 3)}${e}[38;2;166;227;161m${"■".repeat(turn % 7)}${"⬝".repeat(7 - (turn % 7))}${e}[0m`);
  // A TUI redraws only the cells that changed: here a line written once, then its typos fixed in place.
  const body = early + progress.join("") +
    `${at(4, 3)}As explicit memoy address, and if a single instructon was` +
    `${at(4, 19)}ry address, and if a single instruction was` +
    `${at(6, 3)}${e}[31mError: the model stopped answering.${e}[0m`;
  assert.ok(body.length > 16_384 && body.length < 65_000, String(body.length));
  // The rendered window (the last 65,536 characters) begins with the `m` of a color sequence whose start was cut off.
  child.buffer = `${"x".repeat(100)}${e}[38;2;1;2;3` + "m" + body + sgrPadding(65_536 - 1 - body.length);
  child.outputOffset = child.buffer.length;
  child.exitCode = 1;
  child.status = "failed";
  const waited = await call(handler, "wait_for_agent", { sessionId: "child", timeoutSeconds: 5 });
  const observed = await call(handler, "observe_agent", { sessionId: "child" });
  const result = await call(handler, "get_agent_result", { sessionId: "child" });
  assert.equal(waited.reason, "failed");
  const last = (turns - 1) % 7;
  assert.deepEqual(waited.exitLines.split("\n"), [
    `  ${"■".repeat(last)}${"⬝".repeat(7 - last)}`,
    "  Thinking",
    "  As explicit memory address, and if a single instruction was",
    "  Error: the model stopped answering.",
    "  ▣  Build · glm-5.3-flash"
  ]);
  assert.equal(observed.exitLines, waited.exitLines);
  assert.equal(result.exitLines, waited.exitLines);
});

test("observe_agent returns the screen as plain text too, within its maxChars", async () => {
  const { terminals, handler } = setup();
  const child = terminals.sessions.get("child");
  child.buffer = openCodeRedraws();
  child.outputOffset = child.buffer.length;
  child.status = "working";
  const observed = await call(handler, "observe_agent", { sessionId: "child" });
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(observed.output), false, "no ESC or other control bytes");
  assert.ok(observed.output.includes("  The Button test passes now.") && observed.output.includes("[redacted]"));
  assert.ok(!observed.output.includes("sk-secret") && !observed.output.includes("working"));
  const short = await call(handler, "observe_agent", { sessionId: "child", maxChars: 256 });
  assert.ok(short.output.length <= 256 && short.output.endsWith(" ctrl+p commands"), short.output);
});
