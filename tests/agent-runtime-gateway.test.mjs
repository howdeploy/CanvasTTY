import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_ANSWER_EXPIRES_AT_ENV,
  RUNTIME_PROTOCOL_VERSION
} from "../src/agent-runtime/runtime-protocol.mjs";
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

for (const [provider, threadId] of [
  ["claude", "5f1c2a90-aa11-4b22-9c33-0d44e55f6677"],
  ["kimi", "session_5f1c2a90-aa11-4b22-9c33-0d44e55f6677"]
]) test(`RuntimeGateway accepts an authenticated ${provider} hook with its native session ID`, POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  const address = await gateway.start();
  t.after(() => gateway.close());
  assert.equal((await stat(address)).mode & 0o777, 0o600);

  const capability = gateway.registerSession("terminal-one", provider);
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
  child.stdin.end(JSON.stringify({ prompt: "must stay local", prompt_id: "turn-one", session_id: threadId }));
  const result = await childResult(child);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(signals, [{
    id: "terminal-one",
    signal: {
      state: "working",
      event: "UserPromptSubmit",
      turnId: "turn-one",
      turnEpoch: 1,
      threadId
    }
  }]);
  assert.equal(JSON.stringify(signals).includes("must stay local"), false);
});

test("a final answer longer than one runtime message still reports its turn and a bounded answer", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  const grantExpiresAt = Date.now() + 60_000;
  const capability = gateway.registerSession("terminal-long", "codex", grantExpiresAt);
  await send(capability.address, message(capability, "working", "UserPromptSubmit", "turn-long"));
  const helper = new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url);
  const child = spawn(process.execPath, [helper.pathname, "idle", "Stop"], {
    env: {
      ...process.env,
      [CAPTURE_ANSWER_ENV]: "1",
      [CAPTURE_ANSWER_EXPIRES_AT_ENV]: String(grantExpiresAt),
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

  // A thread id reaches a provider argv on restore, so a flag-shaped one is refused.
  await send(capability.address, { ...message(capability, "idle", "Stop", "turn-new"), threadId: "--config=evil" });
  assert.deepEqual(signals.map(({ signal }) => signal.state), ["working"]);
});

test("RuntimeGateway: a late revoke carrying an older launch's capability leaves the newer lease alone", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  const older = gateway.registerSession("terminal-reused", "codex");
  await send(older.address, message(older, "working", "UserPromptSubmit", "turn-before-relaunch"));
  const olderEpoch = gateway.currentTurnEpoch("terminal-reused");
  const newer = gateway.registerSession("terminal-reused", "codex");

  // The older launch's cleanup runs late, after the card was relaunched under the same id.
  gateway.revokeTerminalSession("terminal-reused", older.capabilityToken);
  await send(newer.address, message(newer, "working", "UserPromptSubmit", "turn-after-late-cleanup"));
  const newerEpoch = gateway.currentTurnEpoch("terminal-reused");
  assert.ok(olderEpoch !== null && newerEpoch !== null && newerEpoch > olderEpoch, "a relaunch receives a globally fresh turn epoch");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals.map(({ signal }) => signal.state), ["working", "working"]);

  // Its own capability still revokes it.
  gateway.revokeTerminalSession("terminal-reused", newer.capabilityToken);
  await send(newer.address, message(newer, "idle", "Stop", "turn-after-late-cleanup"));
  assert.deepEqual(signals.map(({ signal }) => signal.state), ["working", "working"]);
});

test("RuntimeGateway: a late start of an earlier turn does not take over from the newer turn", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  const capability = gateway.registerSession("terminal-turns", "codex");
  await send(capability.address, message(capability, "working", "UserPromptSubmit", "turn-1"));
  await send(capability.address, message(capability, "idle", "Stop", "turn-1"));
  await send(capability.address, message(capability, "working", "UserPromptSubmit", "turn-2"));
  // Turn 1's start hook arrives late, on its own connection.
  await send(capability.address, message(capability, "working", "UserPromptSubmit", "turn-1"));
  await send(capability.address, message(capability, "idle", "Stop", "turn-2"));
  assert.equal(gateway.currentTurnEpoch("terminal-turns"), null, "idle closes the host turn");
  await send(capability.address, message(capability, "working", "UserPromptSubmit", null));
  const idlessEpoch = gateway.currentTurnEpoch("terminal-turns");
  await send(capability.address, message(capability, "working", "UserPromptSubmit", null));
  assert.equal(gateway.currentTurnEpoch("terminal-turns"), idlessEpoch, "duplicate id-less starts do not create a new generation");
  await send(capability.address, message(capability, "idle", "Stop", null));
  assert.equal(gateway.currentTurnEpoch("terminal-turns"), null);
  await send(capability.address, message(capability, "working", "UserPromptSubmit", null));
  assert.equal(gateway.currentTurnEpoch("terminal-turns"), idlessEpoch + 1, "the next observed start advances the host generation");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals.map(({ signal }) => [signal.state, signal.turnId ?? null, signal.turnEpoch]), [
    ["working", "turn-1", 1], ["idle", "turn-1", 1], ["working", "turn-2", 2], ["idle", "turn-2", 2],
    ["working", null, idlessEpoch], ["working", null, idlessEpoch], ["idle", null, idlessEpoch], ["working", null, idlessEpoch + 1]
  ]);
  assert.equal(gateway.currentStatus("terminal-turns"), "working");
});

test("RuntimeGateway propagates threadId for codex sessions with canonical UUID", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  const capability = gateway.registerSession("terminal-codex-thread", "codex");

  const validUuid = "12345678-1234-1234-1234-123456789abc";
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
  child.stdin.end(JSON.stringify({ turn_id: "turn-codex-1", session_id: validUuid }));
  const result = await childResult(child);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signal.turnId, "turn-codex-1");
  assert.equal(signals[0].signal.threadId, validUuid);
});

test("RuntimeGateway normalizes uppercase UUID to lowercase canonical UUID for codex", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  const capability = gateway.registerSession("terminal-codex-upper", "codex");

  const upperUuid = "A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D";
  const lowerUuid = upperUuid.toLowerCase();
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
  child.stdin.end(JSON.stringify({ turn_id: "turn-codex-upper", session_id: upperUuid }));
  const result = await childResult(child);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signal.threadId, lowerUuid);
});

test("RuntimeGateway keeps Qwen conversation IDs and rejects non-canonical IDs", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());

  // Qwen reports its native UUID so exact history resume can match the live card.
  const qwenCap = gateway.registerSession("terminal-qwen-test", "qwen");
  const validUuid = "12345678-1234-1234-1234-123456789abc";
  const helper = new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url);

  const qwenChild = spawn(process.execPath, [helper.pathname, "working", "UserPromptSubmit"], {
    env: {
      ...process.env,
      [AGENT_RUNTIME_ENV.address]: qwenCap.address,
      [AGENT_RUNTIME_ENV.terminalSessionId]: qwenCap.terminalSessionId,
      [AGENT_RUNTIME_ENV.provider]: qwenCap.provider,
      [AGENT_RUNTIME_ENV.capabilityToken]: qwenCap.capabilityToken
    },
    stdio: ["pipe", "ignore", "pipe"]
  });
  qwenChild.stdin.end(JSON.stringify({ turn_id: "turn-qwen-1", session_id: validUuid }));
  const qwenResult = await childResult(qwenChild);
  assert.equal(qwenResult.code, 0, qwenResult.stderr);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signal.threadId, validUuid);

  // 2. Malformed UUID: not canonical format (e.g. invalid chars, wrong length, path traversal)
  const codexCap = gateway.registerSession("terminal-codex-malformed", "codex");
  const malformedInputs = [
    "not-a-uuid",
    "12345678-1234-1234-1234-123456789abz", // 'z' is not hex
    "12345678123412341234123456789abc", // no hyphens
    "../../../etc/passwd",
    "12345678-1234-1234-1234-123456789abc\n",
    "Bearer token123456"
  ];
  for (const badId of malformedInputs) {
    const childBad = spawn(process.execPath, [helper.pathname, "working", "UserPromptSubmit"], {
      env: {
        ...process.env,
        [AGENT_RUNTIME_ENV.address]: codexCap.address,
        [AGENT_RUNTIME_ENV.terminalSessionId]: codexCap.terminalSessionId,
        [AGENT_RUNTIME_ENV.provider]: codexCap.provider,
        [AGENT_RUNTIME_ENV.capabilityToken]: codexCap.capabilityToken
      },
      stdio: ["pipe", "ignore", "pipe"]
    });
    childBad.stdin.end(JSON.stringify({ turn_id: "turn-bad", session_id: badId }));
    const badRes = await childResult(childBad);
    assert.equal(badRes.code, 0, badRes.stderr);
  }
  // All malformed ones should either be omitted or ignored without threadId
  for (let i = 1; i < signals.length; i++) {
    assert.equal(signals[i].signal.threadId, undefined);
  }

  // Direct protocol injection with an OpenCode id is rejected for Qwen.
  await send(qwenCap.address, {
    ...message(qwenCap, "working", "UserPromptSubmit", "turn-qwen-direct"),
    threadId: "ses_foreign123"
  });
  // Signal should not be delivered or accepted
  assert.equal(signals.filter((s) => s.id === "terminal-qwen-test").length, 1);
});

test("ordinary Codex Stop reports omit answer text without an explicit capture grant", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  const capability = gateway.registerSession("terminal-default-deny", "codex");

  const result = await reportStop(capability, false);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(signals, [{
    id: "terminal-default-deny",
    signal: { state: "idle", event: "Stop", turnId: "turn-answer", turnEpoch: 1 }
  }]);
  assert.equal(gateway.currentStatus("terminal-default-deny"), "idle");
});

test("answer capture requires a live per-session grant and is bound to its runtime generation", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  let now = Date.now();
  const signals = [];
  const revokedAnswers = [];
  const gateway = new RuntimeGateway({
    runtimeDirectory: root,
    now: () => now,
    onSignal: (id, signal) => signals.push({ id, signal }),
    onAnswerCaptureRevoked: (id) => revokedAnswers.push(id)
  });
  await gateway.start();
  t.after(() => gateway.close());

  const grantExpiresAt = now + 60_000;
  const granted = gateway.registerSession("terminal-owned", "codex", grantExpiresAt);
  const result = await reportStop(granted, grantExpiresAt);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(signals[0], {
    id: "terminal-owned",
    signal: {
      state: "idle",
      event: "Stop",
      turnId: "turn-answer",
      turnEpoch: 1,
      lastAssistantMessage: "authorized answer",
      answerCaptureGrantExpiresAt: grantExpiresAt
    }
  });
  assert.equal(gateway.currentStatus("terminal-owned"), "idle");
  assert.equal(JSON.stringify(gateway.currentStatus("terminal-owned")).includes("authorized answer"), false);

  const expiredHook = await reportStop(granted, Date.now() - 1);
  assert.equal(expiredHook.code, 0, expiredHook.stderr);
  assert.equal("lastAssistantMessage" in signals[1].signal, false);

  now = grantExpiresAt;
  await send(granted.address, {
    ...message(granted, "idle", "Stop", "turn-answer"),
    lastAssistantMessage: "expired answer"
  });
  assert.equal(signals.length, 2);
  assert.deepEqual(revokedAnswers, ["terminal-owned"]);

  now = grantExpiresAt + 100;
  const revocable = gateway.registerSession("terminal-owned", "codex", now + 60_000);
  gateway.revokeTerminalSession("terminal-owned");
  assert.deepEqual(revokedAnswers, ["terminal-owned", "terminal-owned"]);
  assert.deepEqual(await sendAndRead(revocable.address, captureCheck(revocable)), {
    v: RUNTIME_PROTOCOL_VERSION,
    type: "ack",
    answerCapture: false
  });
  const stoppedAfterRevoke = await reportStop(revocable, now + 60_000);
  assert.equal(stoppedAfterRevoke.code, 0, stoppedAfterRevoke.stderr);
  assert.equal(signals.length, 2);

  const nextGeneration = gateway.registerSession("terminal-owned", "codex");
  const stoppedWithoutGrant = await reportStop(nextGeneration, now + 60_000);
  assert.equal(stoppedWithoutGrant.code, 0, stoppedWithoutGrant.stderr);
  assert.equal(signals.length, 3);
  assert.equal("lastAssistantMessage" in signals[2].signal, false);
  await send(granted.address, {
    ...message(granted, "idle", "Stop", "turn-answer"),
    lastAssistantMessage: "stale generation answer"
  });
  await send(nextGeneration.address, {
    ...message(nextGeneration, "idle", "Stop", "turn-answer"),
    lastAssistantMessage: "ungranted new generation answer"
  });
  await send(revocable.address, {
    ...message(revocable, "idle", "Stop", "turn-answer"),
    lastAssistantMessage: "revoked grant answer"
  });
  assert.equal(signals.length, 3);
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

test("OpenCode resumed sessions bind from native updates before status events, while child updates remain isolated", POSIX_RUNTIME_GATEWAY_TEST, async t => {
  const root = await fixture(t);
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (_, signal) => signals.push(signal) });
  await gateway.start();
  t.after(() => gateway.close());
  const capability = gateway.registerSession("terminal-resumed-opencode", "opencode");
  const previous = Object.fromEntries(Object.values(AGENT_RUNTIME_ENV).map(key => [key, process.env[key]]));
  const previousEnabled = process.env.CANVASTTY_LIFECYCLE_HOOKS_ENABLED;
  for (const [key, value] of Object.entries(capability)) {
    if (AGENT_RUNTIME_ENV[key]) process.env[AGENT_RUNTIME_ENV[key]] = value;
  }
  process.env.CANVASTTY_LIFECYCLE_HOOKS_ENABLED = "1";
  t.after(() => {
    for (const [key, value] of Object.entries({ ...previous, CANVASTTY_LIFECYCLE_HOOKS_ENABLED: previousEnabled })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { CanvasTTYLifecycle } = await import("../src/agent-runtime/opencode-plugin.mjs?resumed-history-test");
  const plugin = await CanvasTTYLifecycle();
  const id = "ses_resumed123";
  await plugin.event({ event: { type: "session.updated", properties: { info: { id: "ses_child123", parentID: id } } } });
  assert.equal(signals.length, 0);
  await plugin.event({ event: { type: "session.updated", properties: { info: { id } } } });
  await plugin.event({ event: { type: "session.status", properties: { sessionID: id, status: { type: "busy" } } } });
  await plugin.event({ event: { type: "session.updated", properties: { info: { id: "ses_other123" } } } });
  await plugin.event({ event: { type: "session.status", properties: { sessionID: "ses_other123", status: { type: "idle" } } } });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: id } } });
  assert.deepEqual(signals.map(s => [s.state, s.event]), [
    ["idle", "session.updated"], ["working", "session.status:busy"], ["idle", "session.idle"]
  ]);
  assert.equal(signals[0].threadId, id);
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

function captureCheck(capability) {
  return {
    v: RUNTIME_PROTOCOL_VERSION,
    type: "answer-capture-check",
    terminalSessionId: capability.terminalSessionId,
    provider: capability.provider,
    capabilityToken: capability.capabilityToken
  };
}

function reportStop(capability, grantExpiresAt) {
  const helper = new URL("../src/agent-runtime/hook-helper.mjs", import.meta.url);
  const environment = {
    ...process.env,
    [AGENT_RUNTIME_ENV.address]: capability.address,
    [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
    [AGENT_RUNTIME_ENV.provider]: capability.provider,
    [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
  };
  if (grantExpiresAt !== false && Number.isFinite(grantExpiresAt)) {
    environment[CAPTURE_ANSWER_ENV] = "1";
    environment[CAPTURE_ANSWER_EXPIRES_AT_ENV] = String(grantExpiresAt);
  } else {
    delete environment[CAPTURE_ANSWER_ENV];
    delete environment[CAPTURE_ANSWER_EXPIRES_AT_ENV];
  }
  const child = spawn(process.execPath, [helper.pathname, "idle", "Stop"], {
    env: environment,
    stdio: ["pipe", "ignore", "pipe"]
  });
  child.stdin.end(JSON.stringify({ turn_id: "turn-answer", last_assistant_message: "authorized answer" }));
  return childResult(child);
}

function send(address, value) {
  return sendAndRead(address, value).then(() => undefined);
}

function sendAndRead(address, value) {
  return new Promise((resolve) => {
    const socket = createConnection(address);
    let response = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(response.slice(0, newline)));
      } catch {
        resolve(null);
      }
      socket.destroy();
    });
    socket.on("error", () => resolve(null));
    socket.on("close", () => resolve(null));
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

function fakeWindowsTransports({ failFirstStart = false } = {}) {
  const transports = [];
  const factory = () => {
    const transport = new EventEmitter();
    const index = transports.length;
    transport.isRunning = false;
    transport.closed = false;
    transport.start = async () => {
      if (failFirstStart && index === 0) throw new Error("host did not start");
      transport.isRunning = true;
      return `\\\\.\\pipe\\canvastty-agent-${index}`;
    };
    transport.close = async () => { transport.isRunning = false; transport.closed = true; };
    transports.push(transport);
    return transport;
  };
  return { transports, factory };
}

test("RuntimeGateway restarts a Windows pipe host that failed instead of refusing every later launch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { transports, factory } = fakeWindowsTransports();
  const gateway = new RuntimeGateway({ platform: "win32", windowsHostPath: "C:\\fake\\host.exe", windowsPipeHostFactory: factory });
  t.after(() => gateway.close());

  assert.equal(await gateway.start(), "\\\\.\\pipe\\canvastty-agent-0");
  gateway.registerSession("terminal-before", "claude");
  transports[0].isRunning = false;
  transports[0].emit("fatal", new Error("host exited"));
  assert.throws(() => gateway.registerSession("terminal-during", "claude"), /must be started/);

  t.mock.timers.tick(500);
  await new Promise(setImmediate);
  assert.equal(transports.length, 2);
  assert.equal(gateway.address, "\\\\.\\pipe\\canvastty-agent-1");
  assert.ok(gateway.registerSession("terminal-after", "claude"));

  await gateway.close();
  transports[1].emit("fatal", new Error("late"));
  t.mock.timers.tick(10_000);
  assert.equal(transports.length, 2, "a closed gateway does not restart");
});

test("RuntimeGateway drops a Windows transport whose start failed", async (t) => {
  const { transports, factory } = fakeWindowsTransports({ failFirstStart: true });
  const gateway = new RuntimeGateway({ platform: "win32", windowsHostPath: "C:\\fake\\host.exe", windowsPipeHostFactory: factory });
  t.after(() => gateway.close());
  await assert.rejects(gateway.start(), /did not start/);
  assert.equal(transports[0].closed, true);
  assert.equal(await gateway.start(), "\\\\.\\pipe\\canvastty-agent-1");
});

test("RuntimeGateway closes a connection that sends no message, so idle clients cannot hold every slot", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  const gateway = new RuntimeGateway({ runtimeDirectory: root, firstMessageTimeoutMs: 100 });
  const address = await gateway.start();
  t.after(() => gateway.close());
  const idle = createConnection(address);
  await new Promise((resolve, reject) => { idle.once("connect", resolve); idle.once("error", reject); });
  const closed = new Promise((resolve) => idle.once("close", resolve));
  const outcome = await Promise.race([closed.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("open"), 1_500))]);
  idle.destroy();
  assert.equal(outcome, "closed");
});

test("permission requests receive the host's active turn ID, never the packet's claimed ID", POSIX_RUNTIME_GATEWAY_TEST, async (t) => {
  const root = await fixture(t);
  let forwarded;
  const gateway = new RuntimeGateway({
    runtimeDirectory: root,
    onPermissionRequest: (_id, request) => { forwarded = request; return { behavior: "none" }; }
  });
  await gateway.start();
  t.after(() => gateway.close());
  const capability = gateway.registerSession("terminal-permission-turn", "claude", false, undefined, true);
  await send(capability.address, message(capability, "working", "UserPromptSubmit", "trusted-turn-42"));
  const toolInput = { command: "printf safe" };
  const response = await sendAndRead(capability.address, {
    v: RUNTIME_PROTOCOL_VERSION,
    type: "permission_request",
    terminalSessionId: capability.terminalSessionId,
    provider: capability.provider,
    capabilityToken: capability.capabilityToken,
    requestId: "request-0001",
    toolName: "Bash",
    toolInput,
    toolInputPreview: null,
    toolInputSha256: createHash("sha256").update(JSON.stringify(toolInput), "utf8").digest("hex"),
    truncated: false,
    cwd: null,
    turnId: "attacker-chosen-turn"
  });
  assert.equal(response?.type, "permission_decision");
  assert.equal(forwarded?.turnId, "trusted-turn-42");
  assert.equal(forwarded?.turnEpoch, 1);
});
