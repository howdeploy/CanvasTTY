/**
 * The real canvastty_agents helper must authenticate with the environment an orchestrator card gets. The gateway
 * issues each capability for one connection id and refuses any other, so the helper has to use that id instead of
 * making one up.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";
import { IMPLEMENTATIONS, SKIP_NATIVE, baseEnvironment, startMcp, outputHasId } from "./native-helper-harness.mjs";
import { OrchestrationBridge } from "../src/main/services/agent-browser/OrchestrationBridge.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";

const HELPER = fileURLToPath(new URL("../src/agent-browser/orchestration-helper.mjs", import.meta.url));

function startHelper(environment) {
  const child = spawn(process.execPath, [HELPER], {
    env: { PATH: process.env.PATH, ...environment },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const waiting = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer to ${method}.`)), 5_000);
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });
  return { child, request };
}

test("the orchestration helper authenticates with the card's own capability and reaches the tools", async (t) => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "canvastty-orch-helper-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const calls = [];
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(runtimeDirectory, "runtime"),
    windowsHostPath: join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe"),
    handler: {
      async execute(sessionId, request) {
        calls.push({ sessionId, tool: request.tool });
        return { agents: [] };
      }
    }
  });
  await gateway.start();
  t.after(() => gateway.stop());

  const launch = new OrchestrationBridge(gateway).prepareLaunch({ terminalSessionId: "orchestrator-1" });
  assert.ok(launch, "the bridge is enabled");
  t.after(() => launch.cleanup());
  const { child, request } = startHelper(launch.environment);
  t.after(() => child.kill());

  const initialized = await request(1, "initialize", {});
  assert.equal(initialized.error, undefined, `initialize failed: ${JSON.stringify(initialized.error)}`);
  assert.equal(initialized.result.serverInfo.name, "canvastty_agents");

  const listed = await request(2, "tools/call", { name: "list_agents", arguments: {} });
  assert.equal(listed.result.isError, false, listed.result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(listed.result.content[0].text), { agents: [] });
  assert.deepEqual(calls, [{ sessionId: "orchestrator-1", tool: "list_agents" }]);
});

// A CLI may start a fresh thread and a second MCP process without restarting its PTY.
for (const implementation of IMPLEMENTATIONS) {
  test(`${implementation.name}: new threads in one live PTY discover tools and spawn scoped workers`, {
    skip: implementation.name === "native" && SKIP_NATIVE, timeout: 15_000
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "canvastty-orch-threads-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const writes = [];
    const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true,
      fakeSpawner([], { onWrite: data => writes.push(data) }));
    t.after(() => terminals.disposeAll());
    const parent = terminals.create({ provider: "codex", cwd: directory, profile: "yolo",
      position: { x: 0, y: 0 }, role: "orchestrator" });
    let now = Date.now();
    const gateway = new OrchestrationGateway({ runtimeDirectory: join(directory, "runtime"),
      handler: new ScopedOrchestrationHandler(new AgentControlService(terminals)), now: () => now, capabilityTtlMs: 10,
      windowsHostPath: join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe") });
    await gateway.start();
    t.after(() => gateway.stop());
    const launch = new OrchestrationBridge(gateway).prepareLaunch({ terminalSessionId: parent.id });
    t.after(() => launch.cleanup());
    async function helper() {
      const mcp = startMcp(implementation.orchestration, baseEnvironment(launch.environment));
      t.after(async () => { mcp.kill(); await mcp.exited; });
      return async (id, method, params) => {
        mcp.send({ jsonrpc: "2.0", id, method, params });
        await mcp.until(outputHasId(id));
        return mcp.output.map(JSON.parse).find(item => item.id === id);
      };
    }
    const first = await helper();
    assert.equal((await first(1, "initialize", {})).error, undefined);
    // The launch is already authenticated: its bootstrap TTL must not break a new thread.
    now += 1_000;
    const second = await helper();
    const initialized = await second(1, "initialize", {});
    assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
    const tools = await second(2, "tools/list", {});
    assert.ok(tools.result.tools.some(tool => tool.name === "spawn_agent"));
    const children = [];
    for (const [index, request] of [first, second].entries()) {
      const prompt = `Complete independent task ${index}.`;
      const reply = await request(3, "tools/call", { name: "spawn_agent", arguments: {
        provider: "cursor", cwd: directory, prompt, profile: "normal"
      } });
      assert.equal(reply.result.isError, false, reply.result.content?.[0]?.text);
      const child = JSON.parse(reply.result.content[0].text);
      children.push(child.sessionId);
      assert.equal(terminals.list().find(session => session.id === child.sessionId).parentSessionId, parent.id);
      assert.ok(writes.some(data => data.includes(prompt)));
    }
    assert.equal(new Set(children).size, 2);
    launch.cleanup();
    for (const request of [first, second]) {
      const reply = await request(4, "tools/call", { name: "list_agents", arguments: {} });
      assert.equal(reply.result.isError, true, "PTY cleanup must revoke every helper");
    }
  });
}
