import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrchestrationClient } from "../src/agent-browser/orchestration-helper.mjs";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { HostPlacementService } from "../src/main/services/HostPlacement.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { ORCHESTRATION_BRIDGE_PROTOCOL_VERSION } from "../src/main/services/agent-browser/orchestration-protocol.ts";
import { isValidRemoteHost } from "../src/shared/contracts.ts";

// Regression coverage for the stage1-provider-expansion audit. Each test names
// the defect (or the verified invariant) it pins down.

// ---------------------------------------------------------------------------
// Gateway: one live connection per orchestration lease
// ---------------------------------------------------------------------------

function fakeSpawner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return {
      pid: 21_000 + calls.length,
      write() {},
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
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

function unavailableRegistry() {
  return {
    get() {
      return {
        state: "unavailable",
        provider: "codex",
        diagnostic: "codex is not installed locally.",
        checked: []
      };
    },
    snapshot() { return {}; }
  };
}

class ReconnectClient {
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
    return new ReconnectClient(socket);
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  request(id, tool, args) {
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`Timed out waiting for ${id}`)), 5_000);
      this.send({ v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION, type: "request", id, tool, arguments: args });
    });
  }

  authenticate(capability, token) {
    return new Promise((resolve, reject) => {
      this.pending.set("authenticated", resolve);
      setTimeout(() => reject(new Error("Timed out waiting for authenticated")), 5_000);
      this.send({
        v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
        type: "authenticate",
        connectionId: capability.connectionId,
        terminalSessionId: capability.terminalSessionId,
        capabilityToken: token
      });
    });
  }
}

async function gatewayFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-audit-orch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  const control = new AgentControlService(terminals);
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(directory, "runtime"),
    handler: new ScopedOrchestrationHandler(control)
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const orchestrator = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 },
    role: "orchestrator"
  });
  const capability = gateway.registerOrchestrator({ terminalSessionId: orchestrator.id });
  return { calls, terminals, control, gateway, orchestrator, capability };
}

test("a reconnect-token authentication supersedes the connection still holding the lease", async (t) => {
  const { terminals, gateway, capability } = await gatewayFixture(t);
  const first = await ReconnectClient.connectTo(gateway.address);
  const firstAck = await first.authenticate(capability, capability.capabilityToken);
  assert.equal(firstAck.type, "authenticated");

  // While the first connection is STILL LIVE, a second connection presenting
  // the rotated reconnect token must take over the lease and close the first:
  // one lease never backs two concurrent dispatching connections.
  const second = await ReconnectClient.connectTo(gateway.address);
  const secondAck = await second.authenticate(capability, firstAck.reconnectToken);
  assert.equal(secondAck.type, "authenticated");

  await Promise.race([
    new Promise((resolve) => first.socket.once("close", resolve)),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("the superseded connection stayed open")), 2_000))
  ]);

  // The surviving connection still dispatches as the session.
  const listed = await second.request("list-1", "list_agents", {});
  assert.equal(listed.type, "response");
  assert.deepEqual(listed.result.agents, []);
  assert.equal(first.socket.destroyed, true);
  second.socket.destroy();
  first.socket.destroy();
  terminals.disposeAll();
});

test("a legitimate reconnect after a dropped socket still works", async (t) => {
  const { terminals, gateway, capability } = await gatewayFixture(t);
  const first = await ReconnectClient.connectTo(gateway.address);
  const firstAck = await first.authenticate(capability, capability.capabilityToken);
  first.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const second = await ReconnectClient.connectTo(gateway.address);
  const secondAck = await second.authenticate(capability, firstAck.reconnectToken);
  assert.equal(secondAck.type, "authenticated");
  const listed = await second.request("list-2", "list_agents", {});
  assert.equal(listed.type, "response");
  second.socket.destroy();
  terminals.disposeAll();
});

// ---------------------------------------------------------------------------
// Helper client: close() must settle a pending authentication
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
  }

  write(data) {
    this.written.push(data);
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

test("close() during a pending authentication rejects the connect promise instead of hanging", async () => {
  const client = new OrchestrationClient(
    { address: "/tmp/nowhere.sock", capabilityToken: "tok", terminalSessionId: "s1", connectionId: "c1" },
    { createConnection: () => new FakeSocket(), connectTimeoutMs: 60_000 }
  );
  const pending = client.connect();
  let settled = false;
  const outcome = pending.then(
    () => "resolved",
    () => "rejected"
  ).then((state) => {
    settled = true;
    return state;
  });
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, true);
  assert.equal(await outcome, "rejected");
  assert.equal(client.closed, true);
});

test("connect() while a connection is pending opens exactly one socket", async () => {
  let attempts = 0;
  const client = new OrchestrationClient(
    { address: "/tmp/nowhere.sock", capabilityToken: "tok", terminalSessionId: "s1", connectionId: "c1" },
    {
      createConnection: () => {
        attempts += 1;
        return new FakeSocket();
      },
      connectTimeoutMs: 60_000
    }
  );
  const first = client.connect();
  const second = client.connect();
  assert.equal(first, second);
  assert.equal(attempts, 1);
  client.close();
  await assert.rejects(first, /unavailable/u);
});

test("a disconnect after authentication swaps in the reconnect token and restarts exactly one socket", async () => {
  const sockets = [];
  const client = new OrchestrationClient(
    { address: "/tmp/nowhere.sock", capabilityToken: "bootstrap", terminalSessionId: "s1", connectionId: "c1" },
    {
      createConnection: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      connectTimeoutMs: 60_000
    }
  );
  const pending = client.connect();
  const first = sockets[0];
  await new Promise((resolve) => setImmediate(resolve));
  first.emit("connect");
  first.emit("data", Buffer.from(`${JSON.stringify({
    v: 1,
    type: "authenticated",
    heartbeatIntervalMs: 5_000,
    heartbeatExpiryMs: 15_000,
    reconnectToken: "rotated"
  })}\n`));
  await pending;
  assert.equal(client.identity.capabilityToken, "bootstrap");

  first.destroy();
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(sockets.length, 2);
  assert.equal(client.identity.capabilityToken, "rotated");
  sockets[1].emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(String(sockets[1].written[0] ?? ""), /rotated/u);
  client.close();
});

// ---------------------------------------------------------------------------
// Remote host validation: ssh destinations must not smuggle ssh options
// ---------------------------------------------------------------------------

test("sshHost and sshUser cannot start with a dash (ssh option injection)", () => {
  assert.equal(isValidRemoteHost({ id: "gpu", label: "GPU", sshHost: "gpu.internal.example" }), true);
  assert.equal(isValidRemoteHost({ id: "gpu", label: "GPU", sshHost: "gpu.internal.example", sshUser: "deploy" }), true);
  assert.equal(
    isValidRemoteHost({ id: "gpu", label: "GPU", sshHost: "-oProxyCommand=evil" }),
    false
  );
  assert.equal(
    isValidRemoteHost({ id: "gpu", label: "GPU", sshHost: "gpu.internal.example", sshUser: "-oProxyCommand=evil" }),
    false
  );
});

// ---------------------------------------------------------------------------
// TerminalManager: remote agents skip the local CLI entirely
// ---------------------------------------------------------------------------

const localWorkspace = process.cwd();

test("a remote agent session spawns over ssh even when the local CLI is unavailable", (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, unavailableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  terminals.configureRemoteHosts(() => ({
    id: "build-1",
    label: "Build host",
    sshHost: "build.example.com",
    sshUser: "deploy",
    workspaces: [{ localPath: localWorkspace, remotePath: "/srv/proj" }]
  }));
  t.after(() => terminals.disposeAll());
  const session = terminals.create({
    provider: "codex",
    cwd: localWorkspace,
    profile: "normal",
    position: { x: 0, y: 0 },
    hostId: "build-1"
  });
  // The session launched: it is not marked failed with the local CLI's
  // "unavailable" diagnostic, and no exit code was recorded.
  assert.equal(session.status, "unavailable");
  assert.equal(session.exitCode, null);
  assert.equal(session.failureDetails, null);
  const spawn = calls[calls.length - 1];
  assert.equal(spawn.command, "ssh");
  assert.deepEqual(
    spawn.args,
    ["-tt", "deploy@build.example.com", "cd '/srv/proj' && exec codex"]
  );
});

test("restarting a remote agent re-resolves the host and workspace from live settings", () => {
  const calls = [];
  const exitDrivers = [];
  const spawner = (command, args, options) => {
    calls.push({ command, args, options });
    const exitHandlers = [];
    exitDrivers.push((code) => {
      for (const handler of exitHandlers) handler({ exitCode: code });
    });
    return {
      pid: 21_000 + calls.length,
      write() {},
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      onData() { return { dispose() {} }; },
      onExit(handler) {
        exitHandlers.push(handler);
        return { dispose() {} };
      }
    };
  };
  const host = (sshHost, remotePath) => ({
    id: "build-1",
    label: "Build host",
    sshHost,
    workspaces: [{ localPath: localWorkspace, remotePath }]
  });
  let current = host("first.example.com", "/srv/proj");
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, spawner);
  terminals.configureRemoteHosts((hostId) => (hostId === "build-1" ? current : null));
  const session = terminals.create({
    provider: "codex",
    cwd: localWorkspace,
    profile: "normal",
    position: { x: 0, y: 0 },
    hostId: "build-1"
  });
  assert.deepEqual(
    calls[calls.length - 1].args,
    ["-tt", "first.example.com", "cd '/srv/proj' && exec codex"]
  );

  // The operator re-aims the host id at a different machine and remaps the
  // workspace while the session ran; restart must pick both up.
  current = host("second.example.com", "/srv/relocated");
  exitDrivers[0](0);
  terminals.restart(session.id);
  assert.deepEqual(
    calls[calls.length - 1].args,
    ["-tt", "second.example.com", "cd '/srv/relocated' && exec codex"]
  );
  terminals.disposeAll();
});

// ---------------------------------------------------------------------------
// Settings: remote host optionals survive an update + reload round-trip
// ---------------------------------------------------------------------------

test("remote host workspaces, providerAccess, and maxDataClass survive a settings round-trip", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-audit-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en");
  await store.load();
  const host = {
    id: "gpu-box",
    label: "GPU box",
    sshHost: "gpu.internal.example",
    sshUser: "deploy",
    sshPort: 2222,
    priority: 10,
    maxSessions: 8,
    workspaces: [{ localPath: localWorkspace, remotePath: "/srv/proj" }],
    providerAccess: { mode: "allowlist", providers: ["codex", "claude"] },
    maxDataClass: "D2"
  };
  const updated = await store.update({ remoteHosts: [host] });
  assert.deepEqual(updated.remoteHosts, [host]);

  // A second update (any field) re-normalizes the already-normalized value,
  // and a fresh load re-normalizes the persisted document.
  await store.update({ lastDirectory: "/tmp" });
  const reloaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(reloaded.remoteHosts, [host]);
});

// ---------------------------------------------------------------------------
// Placement: data-class flow
// ---------------------------------------------------------------------------

test("a D3 devin spawn with host \"auto\" fails at the provider gate before placement probes anything", async (t) => {
  const { terminals, orchestrator } = await gatewayFixture(t);
  let placed = 0;
  const scoped = new AgentControlService(terminals, {
    async place() {
      placed += 1;
      return { kind: "local", reason: "should not be reached" };
    }
  });
  // The provider gate throws synchronously, before the async placement branch
  // could probe any host.
  assert.throws(
    () => scoped.spawn({
      parentSessionId: orchestrator.id,
      provider: "devin",
      cwd: process.cwd(),
      host: "auto",
      dataClass: "D3"
    }),
    /Provider devin handles at most D2; this task is D3\./u
  );
  assert.equal(placed, 0);
  terminals.disposeAll();
});

function reachableHost(overrides = {}) {
  return {
    id: "only-host",
    label: "Only host",
    sshHost: "only.example.com",
    maxDataClass: "D1",
    workspaces: [{ localPath: localWorkspace, remotePath: "/srv/proj" }],
    ...overrides
  };
}

test("placement filters class-capped hosts and names the data-class stage in the fallback reason", async () => {
  const discovery = () => Promise.resolve({
    hostId: "only-host",
    reachable: true,
    providers: [{ provider: "codex", installed: true, command: "codex", path: "/usr/bin/codex" }]
  });
  const metrics = () => Promise.resolve({
    hostId: "only-host",
    collectedAt: Date.now(),
    reachable: true,
    load1: 0.5,
    cores: 8,
    memoryTotalMb: 16_384,
    memoryAvailableMb: 8_192,
    gpuVramTotalMb: null,
    gpuVramUsedMb: null
  });
  const placement = new HostPlacementService({
    metrics,
    discovery,
    activeSessions: () => 0
  });
  const d1Only = await placement.place([reachableHost()], {
    provider: "codex",
    localWorkspace: localWorkspace,
    dataClass: "D2"
  });
  assert.deepEqual(d1Only, { kind: "local", reason: "no eligible host handles data class D2" });

  // The same host serves a task its ceiling covers.
  const d1Task = await placement.place([reachableHost()], {
    provider: "codex",
    localWorkspace: localWorkspace,
    dataClass: "D1"
  });
  assert.equal(d1Task.kind, "remote");
  assert.equal(d1Task.host.id, "only-host");
  assert.equal(d1Task.remoteWorkspace, "/srv/proj");

  // Without a dataClass the ceiling never filters (backward compatibility).
  const unclassified = await placement.place([reachableHost()], {
    provider: "codex",
    localWorkspace: localWorkspace
  });
  assert.equal(unclassified.kind, "remote");
});
