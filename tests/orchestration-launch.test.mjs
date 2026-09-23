import assert from "node:assert/strict";
import test from "node:test";
import { claudeMcpArgs, codexMcpArgs, qwenMcpArgs } from "../src/main/services/agent-browser/ProviderLaunch.ts";
import { createOrchestrationDispatcher } from "../src/agent-browser/orchestration-helper.mjs";

const helper = { command: "/app/electron", args: ["agent/browser-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
const orchestrationHelper = { command: "/app/electron", args: ["agent/orchestration-helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };

test("claude and qwen configs gain the orchestration server only when provided", () => {
  const plain = JSON.parse(claudeMcpArgs(helper)[1]);
  assert.deepEqual(Object.keys(plain.mcpServers), ["canvastty_browser"]);

  const withOrchestration = JSON.parse(claudeMcpArgs(helper, orchestrationHelper)[1]);
  assert.deepEqual(Object.keys(withOrchestration.mcpServers).sort(), ["canvastty_agents", "canvastty_browser"]);
  assert.equal(withOrchestration.mcpServers.canvastty_agents.command, "/app/electron");

  const qwenPlain = JSON.parse(qwenMcpArgs(helper)[1]);
  assert.equal("canvastty_agents" in qwenPlain.mcpServers, false);
  const qwenFull = JSON.parse(qwenMcpArgs(helper, orchestrationHelper)[1]);
  assert.ok(qwenFull.mcpServers.canvastty_agents);
  const allowed = qwenMcpArgs(helper, orchestrationHelper).at(-1);
  assert.match(allowed, /mcp__canvastty_agents__spawn_agent/u);
});

test("codex gains a second orchestration -c table only when provided", () => {
  const plain = codexMcpArgs(helper);
  assert.equal(plain.length, 2);
  assert.equal(plain[1].includes("canvastty_agents"), false);

  const full = codexMcpArgs(helper, orchestrationHelper);
  assert.equal(full.length, 4);
  assert.match(full[1], /mcp_servers\.canvastty_browser/u);
  assert.match(full[3], /mcp_servers\.canvastty_agents/u);
  assert.match(full[3], /enabled_tools=\[.?"spawn_agent/u);
});

test("the stdio helper advertises orchestration tools and forwards calls", async () => {
  const calls = [];
  const client = {
    connect: async () => undefined,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return { agents: [] };
    }
  };
  const dispatch = createOrchestrationDispatcher(client);

  const initialized = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(initialized.result.serverInfo.name, "canvastty_agents");

  const listed = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.result.tools.length, 6);

  const spawned = await dispatch({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_agents", arguments: {} }
  });
  assert.equal(spawned.result.isError, false);
  assert.match(spawned.result.content[0].text, /agents/u);
  assert.deepEqual(calls, [{ tool: "list_agents", args: {} }]);

  // The helper is a thin adapter: argument validation happens gateway-side,
  // so a bridge error surfaces as an isError tool result.
  client.call = async () => {
    throw Object.assign(new Error("rejected"), { payload: { code: "INVALID_REQUEST", message: "rejected", retryable: false } });
  };
  const failed = await dispatch({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "spawn_agent", arguments: {} }
  });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /BRIDGE_UNAVAILABLE/u);
});
