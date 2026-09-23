import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "./helpers/delegation-test-manager.mjs";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { ORCHESTRATION_BRIDGE_PROTOCOL_VERSION } from "../src/main/services/agent-browser/orchestration-protocol.ts";

const writes = [];

function fakeSpawner(calls) {
  return (command, args, options) => {
    const process = {
      pid: 20_000 + calls.length,
      write(data) { writes.push(data); },
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
    calls.push({ command, args, options });
    return process;
  };
}

function availableRegistry() {
  return {
    get(provider) {
      return {
        state: "available",
        provider,
        executable: `/resolved/${provider}`,
        launcher: "native",
        environment: { PATH: "/resolved:/usr/bin" },
        checked: [{ path: `/resolved/${provider}`, result: "selected" }]
      };
    },
    snapshot() { return {}; }
  };
}

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.pending = new Map();
    this.notifications = [];
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let index;
      while ((index = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.length === 0) continue;
        const message = JSON.parse(line);
        if (message.type === "response") {
          const resolve = this.pending.get(message.id);
          if (resolve) {
            this.pending.delete(message.id);
            resolve(message);
          }
        } else if (message.type === "authenticated") {
          const resolve = this.pending.get("authenticated");
          if (resolve) {
            this.pending.delete("authenticated");
            resolve(message);
          }
        } else {
          this.notifications.push(message);
        }
      }
    });
  }

  static async connectTo(address) {
    const socket = connect(address);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

}

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-orchestration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  const control = new AgentControlService(terminals);
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(directory, "runtime"),
    handler: handler ?? new ScopedOrchestrationHandler(control)
  });
  await gateway.start();
  t.after(() => gateway.stop());
  return { calls, terminals, control, gateway };
}

function line(client, message) {
  return new Promise((resolve, reject) => {
    const key = message.type === "authenticate" ? "authenticated" : message.id;
    client.pending.set(key, resolve);
    setTimeout(() => reject(new Error(`Timed out waiting for ${key}`)), 5_000);
    client.send(message);
  });
}

async function authExpectingFailure(client, capability, token) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for auth failure")), 5_000);
    const poll = setInterval(() => {
      const notification = client.notifications.find((item) => item.type === "error");
      if (notification) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(notification);
      }
    }, 20);
    setTimeout(() => clearInterval(poll), 5_000);
    client.socket.once("close", () => {
      clearInterval(poll);
      clearTimeout(timer);
      const notification = client.notifications.find((item) => item.type === "error");
      if (notification) resolve(notification);
      else reject(new Error("connection closed without an error notification"));
    });
    client.send({
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type: "authenticate",
      connectionId: capability.connectionId,
      terminalSessionId: capability.terminalSessionId,
      capabilityToken: token
    });
  });
}

async function authenticatedClient(gateway, capability) {
  const client = await TestClient.connectTo(gateway.address);
  const ack = await line(client, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "authenticate",
    connectionId: capability.connectionId,
    terminalSessionId: capability.terminalSessionId,
    capabilityToken: capability.capabilityToken
  });
  assert.equal(ack.type, "authenticated");
  return { client, reconnectToken: ack.reconnectToken };
}

test("spawn_agent over the socket creates a scoped subagent and delivers its prompt", async (t) => {
  const { terminals, gateway, calls } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  const { client } = await authenticatedClient(gateway, capability);

  const spawned = await line(client, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "request",
    id: "spawn-1",
    tool: "spawn_agent",
    arguments: { provider: "cursor", cwd: process.cwd(), prompt: "Fix the Button test", title: "UI worker" }
  });
  assert.equal(spawned.type, "response");
  assert.equal(spawned.result.provider, "cursor");
  assert.equal(spawned.result.title, "UI worker");

  const child = terminals.list().find((session) => session.id === spawned.result.sessionId);
  assert.equal(child.role, "subagent");
  assert.equal(child.parentSessionId, orchestrator.id);
  assert.equal(writes.join(""), "");
  assert.equal(calls[1].args.at(-1), "CanvasTTY task:\nFix the Button test");

  const listed = await line(client, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "request",
    id: "list-1",
    tool: "list_agents",
    arguments: {}
  });
  assert.deepEqual(
    listed.result.agents.map((agent) => agent.sessionId),
    [spawned.result.sessionId]
  );
  client.socket.destroy();
  terminals.disposeAll();
});

test("foreign session ids are protocol errors, not filtered results", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const stranger = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 900, y: 900 }
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  const { client } = await authenticatedClient(gateway, capability);

  const response = await line(client, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "request",
    id: "observe-1",
    tool: "observe_agent",
    arguments: { sessionId: stranger.id }
  });
  assert.equal(response.error.code, "INVALID_REQUEST");
  assert.match(response.error.message, /subtree/u);
  client.socket.destroy();
  terminals.disposeAll();
});

test("unauthenticated commands and replayed bootstrap tokens are rejected", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });

  const eager = await TestClient.connectTo(gateway.address);
  const rejected = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5_000);
    const poll = setInterval(() => {
      const notification = eager.notifications.find((item) => item.type === "error");
      if (notification) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(notification);
      }
    }, 20);
    setTimeout(() => clearInterval(poll), 5_000);
    eager.send({
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type: "request",
      id: "list-1",
      tool: "list_agents",
      arguments: {}
    });
  });
  assert.equal(rejected.error.code, "AUTH_INVALID");
  eager.socket.destroy();

  const { client, reconnectToken } = await authenticatedClient(gateway, capability);
  client.socket.destroy();

  // The one-use bootstrap token cannot authenticate a second connection...
  const replay = await TestClient.connectTo(gateway.address);
  const replayFailure = await authExpectingFailure(replay, capability, capability.capabilityToken);
  assert.equal(replayFailure.error.code, "AUTH_INVALID");
  replay.socket.destroy();

  // ...but the rotated reconnect token can (helper restarts).
  const rejoined = await TestClient.connectTo(gateway.address);
  const rejoinAck = await line(rejoined, {
    v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
    type: "authenticate",
    connectionId: capability.connectionId,
    terminalSessionId: capability.terminalSessionId,
    capabilityToken: reconnectToken
  });
  assert.equal(rejoinAck.type, "authenticated");
  rejoined.socket.destroy();
  terminals.disposeAll();
});

test("revoking the orchestrator session ends its connection and capability", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  const { client } = await authenticatedClient(gateway, capability);

  const closed = new Promise((resolve) => client.socket.once("close", resolve));
  gateway.revokeTerminalSession(orchestrator.id);
  await closed;

  // The lease is gone: even the not-yet-used bootstrap token is dead now.
  const revival = await TestClient.connectTo(gateway.address);
  const revivalFailure = await authExpectingFailure(revival, capability, capability.capabilityToken);
  assert.equal(revivalFailure.error.code, "AUTH_INVALID");
  revival.socket.destroy();
  terminals.disposeAll();
});

test("unknown tools and invalid arguments never reach the handler", async (t) => {
  const { terminals, gateway } = await fixture(t);
  const orchestrator = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  const { client } = await authenticatedClient(gateway, capability);

  // Invalid arguments are a protocol error: the gateway answers with an error
  // notification and closes the connection instead of returning a response.
  const failure = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5_000);
    const onNotification = () => {
      const notification = client.notifications.find((item) => item.type === "error");
      if (!notification) return;
      clearTimeout(timer);
      client.socket.off("close", onNotification);
      resolve(notification);
    };
    client.socket.once("close", onNotification);
    const poll = setInterval(() => {
      const notification = client.notifications.find((item) => item.type === "error");
      if (notification) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(notification);
      }
    }, 20);
    setTimeout(() => clearInterval(poll), 5_000);
    client.socket.write(`${JSON.stringify({
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type: "request",
      id: "bad-1",
      tool: "spawn_agent",
      arguments: { provider: "cursor" }
    })}\n`);
  });
  assert.equal(failure.error.code, "INVALID_REQUEST");
  assert.match(failure.error.message, /cwd/u);
  terminals.disposeAll();
});


test('authenticated cancellation reaches the active operation before it mutates state', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  let receivedSignal;
  const { terminals, gateway } = await fixture(t, { async execute(_session, _request, signal) {
    receivedSignal = signal; started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
    throw new Error('Unreachable write');
  } });
  const parent = terminals.create({ provider: 'codex', cwd: process.cwd(), profile: 'normal', position: { x: 0, y: 0 }, role: 'orchestrator' });
  const { client } = await authenticatedClient(gateway, gateway.registerOrchestrator({ terminalSessionId: parent.id }));
  const response = line(client, { v: 1, type: 'request', id: 'cancel-apply', tool: 'apply_capsule', arguments: { capsuleId: '11111111-1111-4111-8111-111111111111', reviewId: '22222222-2222-4222-8222-222222222222' } });
  await ready;
  client.send({ v: 1, type: 'cancel', id: 'cancel-apply' });
  assert.equal((await response).error.code, 'CANCELED');
  assert.equal(receivedSignal.aborted, true);
  client.socket.destroy(); terminals.disposeAll();
});
