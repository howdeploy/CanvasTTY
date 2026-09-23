import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AGENT_RUNTIME_ENV, RUNTIME_PROTOCOL_VERSION } from "../src/agent-runtime/runtime-protocol.mjs";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";

const POSIX_RUNTIME_GATEWAY_TEST = {
  skip: process.platform === "win32"
    ? "POSIX socket behavior is covered on Unix; Windows named pipes have dedicated transport tests."
    : false
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-runtime-gateway-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("RuntimeGateway accepts one authenticated hook event over a mode-0600 local socket", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  const address = await gateway.start();
  t.after(() => gateway.close());
  assert.equal((await stat(address)).mode & 0o777, 0o600);

  const capability = gateway.registerSession("terminal-one", "claude");
  const helper = new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url);
  const child = spawn(process.execPath, [helper.pathname, "working", "UserPromptSubmit"], {
    env: {
      ...process.env,
      [AGENT_RUNTIME_ENV.address]: capability.address,
      [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
      [AGENT_RUNTIME_ENV.provider]: capability.provider,
      [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
    },
    stdio: ["pipe", "ignore", "pipe"]
  });
  child.stdin.end(JSON.stringify({ prompt: "must stay local", prompt_id: "turn-one" }));
  const result = await childResult(child);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(signals, [{
    id: "terminal-one",
    signal: { state: "working", event: "UserPromptSubmit", turnId: "turn-one" }
  }]);
  assert.equal(JSON.stringify(signals).includes("must stay local"), false);
});

test("a final answer longer than one runtime message still reports its turn and a bounded answer", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  const capability = gateway.registerSession("terminal-long", "codex");
  await send(capability.address, message(capability, "working", "UserPromptSubmit", "turn-long"));
  const helper = new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url);
  const child = spawn(process.execPath, [helper.pathname, "idle", "Stop"], {
    env: {
      ...process.env,
      [AGENT_RUNTIME_ENV.address]: capability.address,
      [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
      [AGENT_RUNTIME_ENV.provider]: capability.provider,
      [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
    },
    stdio: ["pipe", "ignore", "pipe"]
  });
  // 40 KB of text with an astral character straddling the 4000-character cut.
  const answer = "a".repeat(3999) + "\u{1F600}" + "b".repeat(40_000);
  child.stdin.end(JSON.stringify({ turn_id: "turn-long", last_assistant_message: answer }));
  const result = await childResult(child);
  assert.equal(result.code, 0, result.stderr);
  const stop = signals.find(({ signal }) => signal.event === "Stop");
  assert.equal(stop?.signal.turnId, "turn-long");
  assert.equal(stop.signal.lastAssistantMessage, "a".repeat(3999));
});

test("RuntimeGateway rejects a wrong capability and ignores a stale turn completion", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  const capability = gateway.registerSession("terminal-two", "codex");

  await send(capability.address, { ...message(capability, "working", "UserPromptSubmit", "turn-new") });
  await send(capability.address, { ...message(capability, "idle", "Stop", "turn-old") });
  await send(capability.address, {
    ...message(capability, "needs_approval", "PermissionRequest", "turn-new"),
    capabilityToken: "x".repeat(43)
  });

  assert.deepEqual(signals.map(({ signal }) => signal.state), ["working"]);
  assert.equal(gateway.currentStatus("terminal-two"), "working");
});

test("OpenCode question dialogs report needs-input and resume working afterward", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (_id, signal) => signals.push(signal) });
  await gateway.start();
  t.after(() => gateway.close());
  const capability = gateway.registerSession("terminal-opencode", "opencode");
  const lifecycleEnvironment = [
    "CANVASTTY_LIFECYCLE_HOOKS_ENABLED",
    "CANVASTTY_PLUGIN_HOOK_REGISTRY",
    "CANVASTTY_PLUGIN_HOOK_RUNNER_COMMAND",
    "CANVASTTY_PLUGIN_HOOK_RUNNER",
    "CANVASTTY_PLUGIN_HOOK_TERMINAL_SESSION_ID",
    "CANVASTTY_PLUGIN_HOOK_SESSION"
  ];
  const previousEnvironment = Object.fromEntries(
    [...Object.values(AGENT_RUNTIME_ENV), ...lifecycleEnvironment].map((name) => [name, process.env[name]])
  );
  Object.assign(process.env, {
    [AGENT_RUNTIME_ENV.address]: capability.address,
    [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
    [AGENT_RUNTIME_ENV.provider]: capability.provider,
    [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken,
    CANVASTTY_LIFECYCLE_HOOKS_ENABLED: "1"
  });
  for (const name of lifecycleEnvironment.slice(1)) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const { CanvasTTYLifecycle } = await import("../src/agent-runtime/opencode-plugin.mjs?question-dialog-test");
  const plugin = await CanvasTTYLifecycle();
  await plugin.event({ event: { type: "session.created", properties: { info: { id: "opencode-root" } } } });
  await plugin.event({
    event: {
      type: "session.deleted",
      properties: { info: { id: "opencode-child", parentID: "opencode-root" } }
    }
  });
  await plugin.event({ event: { type: "question.asked", properties: { sessionID: "opencode-root" } } });
  await plugin.event({ event: { type: "question.replied", properties: { sessionID: "opencode-root" } } });
  await plugin.event({ event: { type: "session.deleted", properties: { info: { id: "opencode-root" } } } });

  assert.deepEqual(signals.map(({ state, event }) => ({ state, event })), [
    { state: "idle", event: "session.created" },
    { state: "needs_approval", event: "question.asked" },
    { state: "working", event: "question.replied" }
  ]);
});

function message(capability, state, event, turnId) {
  return {
    v: RUNTIME_PROTOCOL_VERSION,
    type: "lifecycle",
    terminalSessionId: capability.terminalSessionId,
    provider: capability.provider,
    capabilityToken: capability.capabilityToken,
    state,
    event,
    turnId
  };
}

function send(address, value) {
  return new Promise((resolve) => {
    const socket = createConnection(address);
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", () => socket.destroy());
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}
