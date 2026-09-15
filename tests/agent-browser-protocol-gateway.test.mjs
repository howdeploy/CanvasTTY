import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_BRIDGE_PAYLOAD_BYTES } from "../src/agent-browser/tool-catalog.mjs";
import {
  AgentGateway,
  supportsAgentGatewayPlatform
} from "../src/main/services/agent-browser/AgentGateway.ts";
import {
  AGENT_BRIDGE_PROTOCOL_VERSION,
  HEARTBEAT_EXPIRY_MS,
  MAX_INFLIGHT_COMMANDS,
  NdjsonDecoder,
  asBridgeError,
  commandFromRequest,
  encodeServerMessage,
  parseClientMessage
} from "../src/main/services/agent-browser/protocol.ts";

const POSIX_GATEWAY_TEST = {
  skip: process.platform === "win32"
    ? "POSIX socket behavior is covered on Unix; Windows named pipes have dedicated transport tests."
    : false
};

async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function bridgeCode(error) {
  return asBridgeError(error).code;
}

function assertBridgeError(code) {
  return (error) => {
    assert.equal(bridgeCode(error), code);
    return true;
  };
}

async function waitForCondition(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for gateway test condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function authMessage(capability, overrides = {}) {
  return {
    v: AGENT_BRIDGE_PROTOCOL_VERSION,
    type: "authenticate",
    agentId: capability.agentId,
    connectionId: capability.connectionId,
    terminalSessionId: capability.terminalSessionId,
    provider: capability.provider,
    capabilityToken: capability.capabilityToken,
    ...overrides
  };
}

function core(overrides = {}) {
  return {
    execute: async (_actor, command) => ({
      ok: true,
      requestId: command.requestId,
      tabId: command.tabId ?? null,
      commandSequence: 1,
      revisionBefore: null,
      revisionAfter: null,
      data: { tabs: [] }
    }),
    subscribe: () => () => undefined,
    ...overrides
  };
}

async function connectClient(address) {
  const socket = createConnection(address);
  socket.on("error", () => undefined);
  await once(socket, "connect");
  let remainder = "";
  const messages = [];
  const waiters = [];
  let closed = false;
  const closedPromise = new Promise((resolve) => socket.once("close", resolve));

  const deliver = (message) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) {
      messages.push(message);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  };
  socket.on("data", (chunk) => {
    remainder += chunk.toString("utf8");
    for (;;) {
      const newline = remainder.indexOf("\n");
      if (newline < 0) break;
      const line = remainder.slice(0, newline);
      remainder = remainder.slice(newline + 1);
      if (line) deliver(JSON.parse(line));
    }
  });
  socket.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Agent gateway socket closed before the expected message."));
    }
  });

  return {
    socket,
    send(value) {
      socket.write(`${JSON.stringify(value)}\n`);
    },
    next(predicate = () => true, timeoutMs = 2_000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      if (closed) return Promise.reject(new Error("Agent gateway socket is closed."));
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error("Timed out waiting for an agent gateway message."));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timeout });
      });
    },
    closed: closedPromise,
    destroy() {
      socket.destroy();
    }
  };
}

async function startedGateway(t, browser, options = {}) {
  const runtimeDirectory = options.runtimeDirectory ?? await fixture(t, "canvastty-gateway-");
  const gateway = new AgentGateway(browser, { runtimeDirectory, ...options });
  await gateway.start();
  t.after(() => gateway.close());
  return gateway;
}

async function authenticateClient(t, gateway, registration = {}) {
  const capability = gateway.registerAgent({
    terminalSessionId: "terminal-test",
    provider: "codex",
    cwd: "/tmp/test-project",
    ...registration
  });
  const client = await connectClient(capability.address);
  t.after(() => client.destroy());
  client.send(authMessage(capability));
  await capability.authenticated;
  const response = await client.next((message) => message.type === "authenticated");
  assert.equal(response.v, AGENT_BRIDGE_PROTOCOL_VERSION);
  assert.equal(typeof response.reconnectToken, "string");
  assert.equal(response.reconnectToken.length > 0, true);
  return { capability, client, response };
}

test("agent bridge parser requires exact outer and nested schema keys", () => {
  const capability = {
    agentId: "agent",
    connectionId: "connection",
    terminalSessionId: "terminal",
    provider: "codex",
    capabilityToken: "token"
  };
  const validAuth = authMessage(capability);
  assert.deepEqual(parseClientMessage(validAuth, false), validAuth);
  const openCodeAuth = authMessage({ ...capability, provider: "opencode" });
  assert.deepEqual(parseClientMessage(openCodeAuth, false), openCodeAuth);
  const hermesAuth = authMessage({ ...capability, provider: "hermes" });
  assert.deepEqual(parseClientMessage(hermesAuth, false), hermesAuth);
  const qwenAuth = authMessage({ ...capability, provider: "qwen" });
  assert.deepEqual(parseClientMessage(qwenAuth, false), qwenAuth);
  assert.throws(
    () => parseClientMessage({ ...validAuth, unexpected: true }, false),
    assertBridgeError("INVALID_REQUEST")
  );
  assert.throws(() => parseClientMessage(validAuth, true), assertBridgeError("AUTH_REPLAYED"));

  const request = {
    v: AGENT_BRIDGE_PROTOCOL_VERSION,
    type: "request",
    id: "request-1",
    tool: "browser_click",
    arguments: {
      tabId: "tab-1",
      ref: {
        ref: "ref-1",
        tabId: "tab-1",
        frameId: "main",
        documentRevision: 4,
        backendNodeId: 10
      }
    }
  };
  const parsed = parseClientMessage(request, true);
  assert.deepEqual(parsed, request);
  assert.deepEqual(commandFromRequest(parsed), {
    type: "browser_click",
    requestId: "request-1",
    ...request.arguments
  });
  assert.throws(
    () => parseClientMessage({ ...request, extra: "forbidden" }, true),
    assertBridgeError("INVALID_REQUEST")
  );
  assert.throws(
    () => parseClientMessage({ ...request, arguments: { ...request.arguments, cookie: "secret" } }, true),
    assertBridgeError("INVALID_REQUEST")
  );
  assert.throws(
    () => parseClientMessage({
      ...request,
      arguments: { ...request.arguments, ref: { ...request.arguments.ref, extra: true } }
    }, true),
    assertBridgeError("INVALID_REQUEST")
  );
  assert.throws(
    () => parseClientMessage({ v: 1, type: "heartbeat", timestamp: 1, extra: true }, true),
    assertBridgeError("INVALID_REQUEST")
  );
  assert.throws(
    () => parseClientMessage({ v: 1, type: "cursor", tabId: "tab", x: 1, y: 2, z: 3 }, true),
    assertBridgeError("INVALID_REQUEST")
  );
});

test("agent bridge enforces the 512 KB cap by UTF-8 bytes for requests and responses", () => {
  const decoder = new NdjsonDecoder();
  assert.deepEqual(decoder.push(Buffer.from('{"v":1,"type":"heartbeat",', "utf8")), []);
  assert.deepEqual(decoder.push(Buffer.from('"timestamp":5}\n', "utf8")), [
    { v: 1, type: "heartbeat", timestamp: 5 }
  ]);

  const oversizedLine = Buffer.from(`{"payload":"${"🦊".repeat(MAX_BRIDGE_PAYLOAD_BYTES / 2)}"}\n`, "utf8");
  assert.equal(oversizedLine.length > MAX_BRIDGE_PAYLOAD_BYTES, true);
  assert.throws(() => new NdjsonDecoder().push(oversizedLine), assertBridgeError("PAYLOAD_TOO_LARGE"));

  const small = encodeServerMessage({
    v: 1,
    type: "heartbeat_ack",
    timestamp: 5
  });
  assert.equal(small.at(-1), 0x0a);
  assert.throws(() => encodeServerMessage({
    v: 1,
    type: "response",
    id: "large",
    result: {
      ok: true,
      requestId: "large",
      tabId: null,
      commandSequence: 1,
      revisionBefore: null,
      revisionAfter: null,
      data: { text: "x".repeat(MAX_BRIDGE_PAYLOAD_BYTES) }
    }
  }), assertBridgeError("PAYLOAD_TOO_LARGE"));
});

test("AgentGateway uses a mode-0600 local socket instead of a TCP listener", POSIX_GATEWAY_TEST, async (t) => {
  const runtimeDirectory = await fixture(t, "canvastty-gateway-mode-");
  const gateway = await startedGateway(t, core(), { runtimeDirectory });

  assert.equal(gateway.address.startsWith(runtimeDirectory), true);
  assert.equal(gateway.address.includes("://"), false);
  assert.equal((await stat(gateway.address)).mode & 0o777, 0o600);
  assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
});

test("AgentGateway supports Windows only when the secure native pipe host is supplied", async () => {
  assert.equal(supportsAgentGatewayPlatform("win32"), true);
  const gateway = new AgentGateway(core(), { platform: "win32" });

  await assert.rejects(gateway.start(), /current-user-only named-pipe host/i);
  assert.throws(() => gateway.address, /has not started/i);
});

test("AgentGateway restarts a failed Windows host and cancels recovery when disabled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transports = [];
  const gateway = new AgentGateway(core(), {
    platform: "win32",
    windowsHostPath: "/fake/host.exe",
    windowsPipeHostFactory: () => {
      const transport = new EventEmitter();
      const address = `pipe-${transports.length}`;
      transport.isRunning = false;
      transport.start = async () => {
        transport.isRunning = true;
        return address;
      };
      transport.close = async () => { transport.isRunning = false; };
      transports.push(transport);
      return transport;
    }
  });
  t.after(() => gateway.close());

  assert.equal(await gateway.start(), "pipe-0");
  transports[0].isRunning = false;
  transports[0].emit("fatal", new Error("host exited"));
  t.mock.timers.tick(499);
  assert.equal(transports.length, 1);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.equal(gateway.address, "pipe-1");

  transports[1].isRunning = false;
  transports[1].emit("fatal", new Error("host exited again"));
  gateway.setEnabled(false);
  t.mock.timers.tick(10_000);
  assert.equal(transports.length, 2);
});

test("AgentGateway idempotently authenticates live helpers and rotates reconnect capability", POSIX_GATEWAY_TEST, async (t) => {
  let connected = 0;
  const disconnects = [];
  const gateway = await startedGateway(t, core({
    agentConnected: () => { connected += 1; },
    agentDisconnected: (_actor, reason) => disconnects.push(reason)
  }));
  const first = await authenticateClient(t, gateway);

  const duplicate = await connectClient(first.capability.address);
  t.after(() => duplicate.destroy());
  duplicate.send(authMessage(first.capability));
  const duplicateAuth = await duplicate.next((message) => message.type === "authenticated");
  assert.equal(duplicateAuth.reconnectToken, first.response.reconnectToken);
  assert.equal(connected, 1);

  first.client.destroy();
  await first.client.closed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(disconnects, []);

  duplicate.send({
    v: 1,
    type: "request",
    id: "duplicate-request",
    tool: "browser_list_tabs",
    arguments: {}
  });
  const duplicateResponse = await duplicate.next(
    (message) => message.type === "response" && message.id === "duplicate-request"
  );
  assert.equal(duplicateResponse.result.ok, true);

  duplicate.destroy();
  await duplicate.closed;
  await waitForCondition(() => disconnects.length === 1);
  assert.deepEqual(disconnects, ["closed"]);

  const replay = await connectClient(first.capability.address);
  t.after(() => replay.destroy());
  replay.send(authMessage(first.capability));
  const replayResponse = await replay.next((message) => message.type === "error");
  assert.equal(replayResponse.error.code, "AUTH_REPLAYED");
  assert.equal(replayResponse.error.retryable, false);

  const reconnect = await connectClient(first.capability.address);
  t.after(() => reconnect.destroy());
  reconnect.send(authMessage(first.capability, {
    capabilityToken: first.response.reconnectToken
  }));
  const reconnectAuth = await reconnect.next((message) => message.type === "authenticated");
  assert.equal(reconnectAuth.reconnectToken, first.response.reconnectToken);
  assert.equal(connected, 2);
});

test("AgentGateway rejects expired and identity-mismatched capabilities", POSIX_GATEWAY_TEST, async (t) => {
  let now = 1_000;
  const gateway = await startedGateway(t, core(), { capabilityTtlMs: 100, now: () => now });

  const wrongProvider = gateway.registerAgent({
    terminalSessionId: "terminal-wrong-provider",
    provider: "claude",
    cwd: "/tmp/project"
  });
  const wrongClient = await connectClient(wrongProvider.address);
  t.after(() => wrongClient.destroy());
  wrongClient.send(authMessage(wrongProvider, { provider: "codex" }));
  const wrongResponse = await wrongClient.next((message) => message.type === "error");
  assert.equal(wrongResponse.error.code, "AUTH_INVALID");

  const expired = gateway.registerAgent({
    terminalSessionId: "terminal-expired",
    provider: "kimi",
    cwd: "/tmp/project"
  });
  now += 101;
  const expiredClient = await connectClient(expired.address);
  t.after(() => expiredClient.destroy());
  expiredClient.send(authMessage(expired));
  const expiredResponse = await expiredClient.next((message) => message.type === "error");
  assert.equal(expiredResponse.error.code, "SESSION_EXPIRED");
  await assert.rejects(expired.authenticated, /expired/i);
});

test("AgentGateway heartbeat uses server time and expires silent authenticated clients", POSIX_GATEWAY_TEST, async (t) => {
  let now = 10_000;
  const heartbeats = [];
  const disconnects = [];
  const gateway = await startedGateway(t, core({
    agentHeartbeat: (actor, timestamp) => heartbeats.push({ actor, timestamp }),
    agentDisconnected: (actor, reason) => disconnects.push({ actor, reason })
  }), { now: () => now });
  const { client } = await authenticateClient(t, gateway);

  client.send({ v: 1, type: "heartbeat", timestamp: -123_456 });
  const ack = await client.next((message) => message.type === "heartbeat_ack");
  assert.equal(ack.timestamp, now);
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].timestamp, now);

  now += HEARTBEAT_EXPIRY_MS + 1;
  gateway.expireConnections();
  await client.closed;
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0].reason, "expired");
});

test("AgentGateway allows eight inflight commands and rejects the ninth", POSIX_GATEWAY_TEST, async (t) => {
  const pending = [];
  const gateway = await startedGateway(t, core({
    execute: async (_actor, command) => {
      const gate = deferred();
      pending.push({ command, gate });
      return gate.promise;
    }
  }));
  const { client } = await authenticateClient(t, gateway);

  for (let index = 0; index < MAX_INFLIGHT_COMMANDS + 1; index += 1) {
    client.send({
      v: 1,
      type: "request",
      id: `request-${index}`,
      tool: "browser_list_tabs",
      arguments: {}
    });
  }
  const busy = await client.next((message) => message.type === "response" && message.id === "request-8");
  assert.equal(pending.length, MAX_INFLIGHT_COMMANDS);
  assert.equal(busy.error.code, "BRIDGE_BUSY");
  assert.equal(busy.error.retryable, true);

  for (let index = 0; index < pending.length; index += 1) {
    const { command, gate } = pending[index];
    gate.resolve({
      ok: true,
      requestId: command.requestId,
      tabId: null,
      commandSequence: index + 1,
      revisionBefore: null,
      revisionAfter: null,
      data: { tabs: [] }
    });
  }
  for (let index = 0; index < MAX_INFLIGHT_COMMANDS; index += 1) {
    const response = await client.next((message) => message.type === "response" && message.id === `request-${index}`);
    assert.equal(response.result.ok, true);
  }
});

test("AgentGateway cancellation aborts the original in-flight request id", POSIX_GATEWAY_TEST, async (t) => {
  const started = deferred();
  const gateway = await startedGateway(t, core({
    execute: async (_actor, command, signal) => {
      started.resolve({ command, signal });
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  }));
  const { client } = await authenticateClient(t, gateway);

  client.send({
    v: 1,
    type: "request",
    id: "request-cancel",
    tool: "browser_list_tabs",
    arguments: {}
  });
  const active = await started.promise;
  client.send({ v: 1, type: "cancel", id: "request-cancel" });

  const response = await client.next(
    (message) => message.type === "response" && message.id === "request-cancel"
  );
  assert.equal(active.command.requestId, "request-cancel");
  assert.equal(active.signal.aborted, true);
  assert.equal(response.error.code, "CANCELED");
});

test("AgentGateway kill switch closes every socket even when a host callback throws", POSIX_GATEWAY_TEST, async (t) => {
  let disconnectCalls = 0;
  const gateway = await startedGateway(t, core({
    agentDisconnected: () => {
      disconnectCalls += 1;
      if (disconnectCalls === 1) throw new Error("host teardown failed");
    }
  }));
  const first = await authenticateClient(t, gateway, {
    terminalSessionId: "terminal-first"
  });
  const second = await authenticateClient(t, gateway, {
    terminalSessionId: "terminal-second"
  });

  assert.doesNotThrow(() => gateway.setEnabled(false));
  await Promise.all([first.client.closed, second.client.closed]);
  assert.equal(disconnectCalls, 2);
});
