import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import { OrchestrationBridge } from "../src/main/services/agent-browser/OrchestrationBridge.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-orch-role-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const browserInputs = [];
  const agentBrowser = {
    prepareLaunch(input) {
      browserInputs.push(input);
      return { agentId: "agent", connectionId: "conn", args: [], environment: {}, cleanup() {} };
    }
  };
  const terminals = new TerminalManager(() => undefined, availableRegistry(), agentBrowser, undefined, true, fakeSpawner(calls));
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(directory, "runtime"),
    windowsHostPath: join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe"),
    handler: new ScopedOrchestrationHandler(new AgentControlService(terminals))
  });
  await gateway.start();
  t.after(() => gateway.stop());
  terminals.configureOrchestration(new OrchestrationBridge(gateway));
  return { calls, browserInputs, terminals, gateway };
}

test("only orchestrator sessions receive the orchestration capability environment", async (t) => {
  const { calls, browserInputs, terminals } = await fixture(t);

  const orchestrator = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const interactive = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 400, y: 400 }
  });

  // Spawn order matches creation order: orchestrator first, interactive second.
  const orchestratorEnv = calls[0]?.options?.env;
  assert.ok(orchestratorEnv, "orchestrator session spawned");
  assert.ok(orchestratorEnv.CANVASTTY_ORCHESTRATION_ADDRESS);
  assert.ok(orchestratorEnv.CANVASTTY_ORCHESTRATION_CAPABILITY);
  // The helper authenticates with the connection id the capability was issued for.
  assert.ok(orchestratorEnv.CANVASTTY_ORCHESTRATION_CONNECTION_ID);

  const interactiveEnv = calls[1]?.options?.env;
  assert.ok(interactiveEnv, "interactive session spawned");
  assert.equal("CANVASTTY_ORCHESTRATION_ADDRESS" in interactiveEnv, false);

  assert.deepEqual(
    browserInputs.map((input) => input.includeOrchestration === true),
    [true, false]
  );
  terminals.disposeAll();
});

test("disposing an orchestrator session revokes its capability", { timeout: 15_000 }, async (t) => {
  const { terminals, calls } = await fixture(t);
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const env = calls[0].options.env;
  const authenticate = async (token) => {
    const socket = createConnection(env.CANVASTTY_ORCHESTRATION_ADDRESS);
    t.after(() => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy(new Error("orchestration authentication timed out")));
    const lines = createInterface({ input: socket });
    t.after(() => lines.close());
    const replies = lines[Symbol.asyncIterator]();
    await once(socket, "connect");
    const next = replies.next();
    socket.write(JSON.stringify({
      v: 1, type: "authenticate", connectionId: env.CANVASTTY_ORCHESTRATION_CONNECTION_ID,
      terminalSessionId: orchestrator.id, capabilityToken: token
    }) + "\n");
    const reply = await next;
    assert.equal(reply.done, false, "authentication produces a protocol response");
    return { socket, reply: JSON.parse(reply.value) };
  };
  const connected = await authenticate(env.CANVASTTY_ORCHESTRATION_CAPABILITY);
  assert.equal(connected.reply.type, "authenticated", "the original launch capability works before disposal");
  assert.equal(typeof connected.reply.reconnectToken, "string");
  const closed = once(connected.socket, "close");
  terminals.dispose(orchestrator.id);
  await closed;
  // Re-registering would itself revoke the old lease and hide a missing dispose cleanup.
  const refused = await authenticate(connected.reply.reconnectToken);
  assert.equal(refused.reply.type, "error");
  assert.equal(refused.reply.error.code, "AUTH_INVALID");
});

test("browser capabilities are retained only after PTY spawn and released on exit", (t) => {
  const events = [];
  const calls = [];
  const spawn = fakeSpawner(calls);
  let failSpawn = false;
  const agentBrowser = {
    prepareLaunch() {
      return {
        agentId: "agent",
        connectionId: "conn",
        args: [],
        environment: {},
        retainUntilExit() { events.push("retain"); },
        cleanup() { events.push("cleanup"); }
      };
    }
  };
  const terminals = new TerminalManager(
    () => undefined,
    availableRegistry(),
    agentBrowser,
    undefined,
    true,
    (command, args, options) => {
      events.push("spawn");
      if (failSpawn) throw new Error("PTY spawn failed");
      return spawn(command, args, options);
    }
  );
  t.after(() => terminals.disposeAll());
  const request = {
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  };

  const session = terminals.create(request);
  assert.deepEqual(events, ["spawn", "retain"]);
  calls[0].process.emitExit(0);
  assert.deepEqual(events, ["spawn", "retain", "cleanup"]);

  terminals.restart(session.id);
  assert.deepEqual(events, ["spawn", "retain", "cleanup", "spawn", "retain"]);
  calls[1].process.emitExit(0);
  assert.deepEqual(events, ["spawn", "retain", "cleanup", "spawn", "retain", "cleanup"]);

  failSpawn = true;
  assert.throws(() => terminals.create(request), /PTY spawn failed/);
  assert.equal(calls.length, 2);
  assert.deepEqual(events, [
    "spawn", "retain", "cleanup",
    "spawn", "retain", "cleanup",
    "spawn", "cleanup"
  ]);
});
