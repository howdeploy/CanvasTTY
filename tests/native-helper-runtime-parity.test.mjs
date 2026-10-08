/**
 * Contract parity of the decision hook and the lifecycle hook: permission-gate.mjs and hook-helper.mjs against
 * `canvastty-helper permission-gate` and `canvastty-helper hook`. Every case runs through both implementations with
 * the same input, environment and gateway behavior, and what each prints, how it exits and every byte it sends the
 * gateway must be equal (the request id is random: it is checked for its shape, then masked). The real RuntimeGateway
 * must accept both. No agent CLI runs; HOME is the runner's fake one.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_RUNTIME_ENV, CAPTURE_ANSWER_ENV, CAPTURE_ANSWER_EXPIRES_AT_ENV, CAPTURE_RESULT_ENV, DECISION_BUDGET_ENV,
  DECISION_FAIL_CLOSED_ENV, RUNTIME_PROTOCOL_VERSION
} from "../src/agent-runtime/runtime-protocol.mjs";
import { FAIL_CLOSED_MESSAGE } from "../src/agent-runtime/permission-gate.mjs";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import {
  IMPLEMENTATIONS, SKIP_NATIVE, baseEnvironment, limited, lineServer, root, runOnce, socketPath
} from "./native-helper-harness.mjs";

const OPTIONS = { skip: SKIP_NATIVE, timeout: 120_000 };
const PROVIDERS = ["claude", "codex", "qwen", "opencode"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// Windows CI builds this current-user-only named-pipe host before running gateway integration tests.
const WINDOWS_PIPE_HOST = join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe");

function runtimeEnvironment(address, provider, extra = {}) {
  return baseEnvironment({
    [AGENT_RUNTIME_ENV.address]: address,
    [AGENT_RUNTIME_ENV.terminalSessionId]: "term-1",
    [AGENT_RUNTIME_ENV.provider]: provider,
    [AGENT_RUNTIME_ENV.capabilityToken]: "c".repeat(43),
    ...extra
  });
}

/** Masks the random request id after checking it is a v4 UUID. */
function masked(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  if (typeof parsed.requestId !== "string") return raw;
  assert.match(parsed.requestId, UUID_V4);
  return raw.replace(parsed.requestId, "<request-id>");
}

/** Runs one gate call through every implementation against a fresh fake gateway answering with `answer`. */
async function gateCase({ provider = "claude", failClosed = true, input, answer = null, env = {}, address = null }) {
  const results = [];
  for (const implementation of IMPLEMENTATIONS) {
    const gateway = address === null ? await lineServer((connection, message, raw) => {
      if (typeof answer === "function") answer(connection, message, raw);
    }) : null;
    const result = await runOnce(implementation.gate, {
      env: runtimeEnvironment(gateway?.path ?? address, provider, { ...(failClosed ? { [DECISION_FAIL_CLOSED_ENV]: "1" } : {}), ...env }),
      input
    });
    const received = gateway ? gateway.connections.flatMap((connection) => connection.lines).map(masked) : [];
    await gateway?.close();
    results.push({ implementation: implementation.name, code: result.code, stdout: result.stdout, received });
  }
  return results;
}

function assertSame(results, label) {
  const [reference, ...others] = results;
  for (const other of others) {
    assert.deepEqual(
      { code: other.code, stdout: other.stdout, received: other.received },
      { code: reference.code, stdout: reference.stdout, received: reference.received },
      `${label}: ${other.implementation} differs from ${reference.implementation}`
    );
  }
  return reference;
}

const decision = (request, extra) => `${JSON.stringify({ v: RUNTIME_PROTOCOL_VERSION, type: "permission_decision", requestId: request?.requestId, ...extra })}\n`;
const answering = (reply) => (connection, message) => connection.send(reply(message));

const bashInput = (toolInput, extra = {}) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: toolInput, cwd: "/work", ...extra });

/** Tool inputs whose JSON the gateway re-serializes and hashes: V8 key order, numbers, strings, bytes. */
const INPUTS = {
  "plain command": bashInput({ command: "ls -la" }),
  "integer keys first, duplicate keys keep their first place": '{"tool_name":"Bash","tool_input":{"b":1,"10":2,"a":3,"2":4,"01":5,"4294967295":6,"4294967294":7,"-1":8,"b":9,"__proto__":{"x":1},"constructor":0}}',
  "numbers as JavaScript prints them": '{"tool_name":"Write","tool_input":{"n":[1.0,-0,1e21,1e20,1e-7,1e-6,123456789012345678901234,0.1,5e-324,1.7976931348623157e308,1e400,-1e400,1E+2,0.000001234,2.5e-8,100,1.5e300,9007199254740993]}}',
  "escapes, surrogates and separators": '{"tool_name":"Edit","tool_input":{"s":["\\u2028\\u2029","\\ud83d\\ude00","\\ud800","x\\udc00y","\\u0000\\u001f\\u007f","\\/","é😀","\\"\\\\\\b\\f\\n\\r\\t","\\uD83D\\uDE00"]}}',
  "invalid UTF-8 bytes": Buffer.concat([Buffer.from('{"tool_name":"Bash","tool_input":{"command":"a'), Buffer.from([0xff, 0xc3, 0x28, 0xe2, 0x82, 0xf0, 0x9f, 0x98, 0xed, 0xa0, 0x80]), Buffer.from('b"}}')]),
  "surrounding whitespace": ` \n\t${bashInput({ command: "x" })}\r\n `,
  "no tool input": '{"tool_name":"Bash"}',
  "tool input null": '{"tool_name":"Bash","tool_input":null}',
  "tool input is a string": '{"tool_name":"Bash","tool_input":"just text"}',
  "tool name over 200 units, cut inside a surrogate pair": JSON.stringify({ tool_name: `${"n".repeat(199)}😀tail`, tool_input: {} }),
  "cwd too long": bashInput({}, { cwd: "/".repeat(4097) }),
  "cwd empty": bashInput({}, { cwd: "" }),
  "cwd not text": bashInput({}, { cwd: 5 }),
  "large input sends a preview": bashInput({ command: "x".repeat(50 * 1024) }),
  "large multibyte input, preview cut inside a surrogate pair": bashInput({ command: `${"a".repeat(8189)}😀${"é".repeat(30000)}` }),
  "wire overflow falls back to the short preview": JSON.stringify({ tool_name: "\u0001".repeat(200), tool_input: { c: "\u0001".repeat(6000), d: "x".repeat(3000) }, cwd: "\u0001".repeat(4096) }),
  "input over 512 KB": bashInput({ command: "x".repeat(600 * 1024) }),
  "not JSON": "{nope",
  "BOM before JSON": `﻿${bashInput({ command: "x" })}`,
  "only whitespace": "   \n",
  "empty": "",
  "an array": "[1,2]",
  "null": "null",
  "no tool name": '{"tool_input":{}}',
  "empty tool name": '{"tool_name":"","tool_input":{}}',
  "tool name not text": '{"tool_name":7,"tool_input":{}}',
  "trailing garbage": `${bashInput({ command: "x" })} x`,
  // The outer hook object counts as one container, so 255 nested tool_input arrays reach the 256 limit.
  "deep nesting at the portable limit": `{"tool_name":"Bash","tool_input":${"[".repeat(255)}0${"]".repeat(255)}}`,
  "deep nesting just beyond the portable limit": `{"tool_name":"Bash","tool_input":${"[".repeat(256)}0${"]".repeat(256)}}`,
  "quoted braces and escaped quotes are not containers": bashInput({ command: ('[{' + String.fromCharCode(34, 92)).repeat(300) }),
  "deep nesting": `{"tool_name":"Bash","tool_input":${"[".repeat(3000)}${"]".repeat(3000)}}`
};

test("permission gate: the request each implementation sends is byte-identical, for every kind of tool input", OPTIONS, async () => {
  const jobs = Object.entries(INPUTS).map(([label, input]) => async () => ({
    label,
    results: await gateCase({ input, answer: answering((request) => decision(request, { behavior: "deny", message: "no" })) })
  }));
  for (const { label, results } of await limited(jobs, 3)) {
    const reference = assertSame(results, label);
    if (["plain command", "deep nesting at the portable limit", "quoted braces and escaped quotes are not containers"].includes(label)) {
      assert.equal(reference.received.length, 1, `${label}: the request reached the gateway`);
    }
    if (["deep nesting just beyond the portable limit", "deep nesting"].includes(label)) {
      assert.equal(reference.received.length, 0, `${label}: rejected before contacting the gateway`);
      assert.equal(JSON.parse(reference.stdout).hookSpecificOutput.permissionDecisionReason, FAIL_CLOSED_MESSAGE, label);
    }
    for (const raw of reference.received) {
      // What RuntimeGateway checks: the hash of JSON.stringify(JSON.parse(toolInput)).
      const request = JSON.parse(raw);
      if (!request.truncated) {
        assert.equal(createHash("sha256").update(JSON.stringify(request.toolInput), "utf8").digest("hex"), request.toolInputSha256, label);
      }
      assert.ok(Buffer.byteLength(`${raw}\n`) <= 64 * 1024, `${label}: within the wire cap`);
    }
  }
});

test("permission gate: excessive nesting preserves legacy mode without contacting the gateway", OPTIONS, async () => {
  for (const provider of PROVIDERS) {
    const results = await gateCase({ provider, failClosed: false, input: INPUTS["deep nesting just beyond the portable limit"] });
    const reference = assertSame(results, provider);
    assert.equal(reference.stdout, "");
    assert.equal(reference.received.length, 0);
    assert.equal(reference.code, 0);
  }
});

test("permission gate: every answer and every failure prints the same thing for Claude, Codex, Qwen and OpenCode", OPTIONS, async () => {
  const input = bashInput({ command: "sudo rm -rf /" });
  const longMessage = `${"m".repeat(999)}😀 and more\u0001\u0007\t\n\u007f`;
  const answers = {
    allow: answering((r) => decision(r, { behavior: "allow" })),
    "allow with a reason": answering((r) => decision(r, { behavior: "allow", message: "trusted" })),
    deny: answering((r) => decision(r, { behavior: "deny", message: "Blocked: sudo." })),
    "deny without a reason": answering((r) => decision(r, { behavior: "deny" })),
    ask: answering((r) => decision(r, { behavior: "ask", message: "Check this." })),
    "ask without a reason": answering((r) => decision(r, { behavior: "ask" })),
    "ask because the gateway failed": answering((r) => decision(r, { behavior: "ask", message: "Timed out.", unavailable: true })),
    none: answering((r) => decision(r, { behavior: "none" })),
    "a long reason with control characters": answering((r) => decision(r, { behavior: "deny", message: longMessage })),
    "a reason that is not text": answering((r) => decision(r, { behavior: "deny", message: 5 })),
    "another request's answer": answering(() => decision({ requestId: "someone-else" }, { behavior: "allow" })),
    "an unknown behavior": answering((r) => decision(r, { behavior: "maybe" })),
    "a wrong protocol version": answering((r) => `${JSON.stringify({ v: 2, type: "permission_decision", requestId: r.requestId, behavior: "allow" })}\n`),
    "not JSON": answering(() => "garbage\n"),
    "an empty line": answering(() => "\n"),
    "an array": answering(() => "[]\n"),
    "null": answering(() => "null\n"),
    "two lines at once, the first counts": answering((r) => `${decision(r, { behavior: "deny", message: "first" }).trim()}\n${decision(r, { behavior: "allow" })}`),
    "the answer in pieces": (connection, request) => {
      const line = decision(request, { behavior: "deny", message: "pieces" });
      connection.send(line.slice(0, 10));
      setTimeout(() => connection.send(line.slice(10)), 30);
    },
    "closed without an answer": (connection) => connection.socket.destroy(),
    "over the size bound without a newline": answering(() => "x".repeat(70 * 1024)),
    "a complete line, then an oversized one in the same chunk": answering((r) => `${decision(r, { behavior: "deny", message: "x" })}${"y".repeat(70 * 1024)}`)
  };
  const jobs = [];
  for (const [label, answer] of Object.entries(answers)) {
    for (const provider of PROVIDERS) {
      for (const failClosed of label === "allow" || label === "deny" || label.startsWith("ask") || label === "not JSON" || label === "closed without an answer" ? [true, false] : [true]) {
        jobs.push(async () => ({ label: `${label} / ${provider} / ${failClosed ? "on" : "off"}`, results: await gateCase({ provider, failClosed, input, answer }) }));
      }
    }
  }
  for (const { label, results } of await limited(jobs, 3)) {
    const reference = assertSame(results, label);
    if (label.startsWith("not JSON / ") && label.endsWith("/ on")) {
      assert.equal(JSON.parse(reference.stdout).hookSpecificOutput.permissionDecisionReason, FAIL_CLOSED_MESSAGE, label);
    }
  }
});

test("permission gate: no socket, a refused socket, no identity and an ignored argument behave the same", OPTIONS, async () => {
  const stale = socketPath();
  const listener = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(stale)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => listener.stdout.once("data", resolve));
  listener.kill("SIGKILL");
  await new Promise((resolve) => listener.once("exit", resolve));
  const input = bashInput({ command: "ls" });
  for (const provider of PROVIDERS) {
    for (const failClosed of [true, false]) {
      for (const [label, address] of [["missing", socketPath()], ["refused", stale]]) {
        assertSame(await gateCase({ provider, failClosed, input, address }), `${label} / ${provider} / ${failClosed}`);
      }
    }
  }
  for (const failClosed of [true, false]) {
    const results = [];
    for (const implementation of IMPLEMENTATIONS) {
      const result = await runOnce(implementation.gate, { env: baseEnvironment(failClosed ? { [DECISION_FAIL_CLOSED_ENV]: "1" } : {}), input });
      results.push({ implementation: implementation.name, code: result.code, stdout: result.stdout, received: [] });
    }
    assertSame(results, `no identity / ${failClosed}`);
  }
  // Without the `pretool` argument the gate does nothing at all.
  const results = [];
  for (const implementation of IMPLEMENTATIONS) {
    const result = await runOnce(implementation.gate.slice(0, -1), { env: runtimeEnvironment(socketPath(), "claude", { [DECISION_FAIL_CLOSED_ENV]: "1" }), input });
    results.push({ implementation: implementation.name, code: result.code, stdout: result.stdout, received: [] });
  }
  assert.equal(assertSame(results, "no pretool argument").stdout, "");
});

test("permission gate: a gateway that never answers is a deny at the same deadline; a bad budget keeps the default", { ...OPTIONS, timeout: 60_000 }, async () => {
  const runs = IMPLEMENTATIONS.map(async (implementation) => {
    const gateway = await lineServer();
    const started = Date.now();
    const result = await runOnce(implementation.gate, {
      env: runtimeEnvironment(gateway.path, "codex", { [DECISION_FAIL_CLOSED_ENV]: "1", [DECISION_BUDGET_ENV]: "12x" }),
      input: bashInput({ command: "ls" })
    });
    await gateway.close();
    return { implementation: implementation.name, ms: Date.now() - started, code: result.code, stdout: result.stdout, received: [] };
  });
  const results = await Promise.all(runs);
  assertSame(results, "never answers");
  for (const result of results) {
    assert.ok(result.ms >= 11_900 && result.ms < 14_000, `${result.implementation} waited ${result.ms} ms`);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, FAIL_CLOSED_MESSAGE);
  }
});

test("permission gate: the real RuntimeGateway accepts both implementations' requests and hands the same tool input on", { ...OPTIONS, timeout: 60_000 }, async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "canvastty-native-gw-"));
  const seen = [];
  const gateway = new RuntimeGateway({
    runtimeDirectory: runtime,
    windowsHostPath: WINDOWS_PIPE_HOST,
    onPermissionRequest: async (_id, request) => {
      seen.push(request);
      return { behavior: "deny", message: `saw ${request.toolName}` };
    }
  });
  await gateway.start();
  t.after(async () => { await gateway.close(); await rm(runtime, { recursive: true, force: true }); });
  for (const [label, input] of Object.entries(INPUTS)) {
    const outputs = [];
    for (const implementation of IMPLEMENTATIONS) {
      const session = gateway.registerSession("real-1", "claude", false, undefined, true);
      seen.length = 0;
      const result = await runOnce(implementation.gate, {
        env: baseEnvironment({
          [AGENT_RUNTIME_ENV.address]: session.address,
          [AGENT_RUNTIME_ENV.terminalSessionId]: session.terminalSessionId,
          [AGENT_RUNTIME_ENV.provider]: "claude",
          [AGENT_RUNTIME_ENV.capabilityToken]: session.capabilityToken,
          [DECISION_FAIL_CLOSED_ENV]: "1"
        }),
        input
      });
      // Compared as text: the deep-nesting case is deeper than a structural comparison recurses.
      outputs.push(JSON.stringify({ stdout: result.stdout, requests: seen.map(({ requestId: _ignored, turnEpoch: _hostEpoch, ...rest }) => rest) }));
    }
    assert.equal(outputs[1], outputs[0], label);
    if (label === "plain command") assert.match(outputs[0], /saw Bash/u);
  }
});

// ---- lifecycle hook ----

const LONG_ANSWER = `${"a".repeat(3999)}😀${"b".repeat(200)}`;
const HOOK_CASES = [
  { label: "Stop with the result captured", state: "idle", event: "Stop", env: { [CAPTURE_RESULT_ENV]: "1" }, input: { session_id: "0F8FAD5B-D9CB-469F-A165-70867728950E", turn_id: "t1", last_assistant_message: LONG_ANSWER } },
  { label: "Stop without capture", state: "idle", event: "Stop", input: { sessionId: "x", turnId: "", promptId: "p", last_assistant_message: "done" } },
  { label: "working with an OpenCode session", provider: "opencode", state: "working", event: "UserPromptSubmit", input: { thread_id: "ses_abcXYZ09", prompt_id: "p".repeat(160) } },
  { label: "an OpenCode id of the wrong shape", provider: "opencode", state: "working", event: "UserPromptSubmit", input: { thread_id: "ses_a-b", turn_id: "t".repeat(161) } },
  { label: "needs approval", state: "needs_approval", event: "PermissionRequest", input: { conversation_id: "not-a-uuid" } },
  { label: "completed Claude file write has hashes only", state: "working", event: "PostToolUse", input: {
    turn_id: "tool-turn", tool_name: "Write", tool_input: { file_path: "/private/work/secret.txt", content: "secret file contents" },
    tool_response: { filePath: "/private/work/secret.txt", type: "create" }
  } },
  { label: "failed Claude tool has a hash-only error", state: "working", event: "PostToolUseFailure", input: {
    turn_id: "tool-turn", tool_name: "Bash", tool_input: { command: "npm test -- secret" }, error: "Exit code 1\nsecret output", is_interrupt: false
  } },
  { label: "interrupted Claude tool is not called an error", state: "working", event: "PostToolUseFailure", input: {
    tool_name: "Bash", tool_input: { command: "npm test" }, error: "secret cancellation message", is_interrupt: true
  } },
  { label: "Codex structured nonzero output is an error", provider: "codex", state: "working", event: "PostToolUse", input: {
    tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 2, stderr: "secret test output" }
  } },
  { label: "an explicit tool denial is not an error", provider: "codex", state: "working", event: "PostToolUse", input: {
    tool_name: "Bash", tool_input: { command: "restricted action" }, tool_response: { status: "denied", error: "secret denial text" }
  } },
  { label: "Codex permission request has no outcome summary", provider: "codex", state: "needs_approval", event: "PermissionRequest", input: {
    tool_name: "Bash", tool_input: { command: "sudo something" }
  } },
  { label: "Codex unstructured output remains unknown", provider: "codex", state: "working", event: "PostToolUse", input: {
    tool_name: "Bash", tool_input: { command: "echo secret" }, tool_response: { stdout: "secret output" }
  } },
  { label: "event of 80 characters", state: "idle", event: "E".repeat(80), input: {} },
  { label: "event of 81 characters", state: "idle", event: "E".repeat(81), input: {} },
  { label: "an unknown state", state: "sleeping", event: "Stop", input: {} },
  { label: "input that is not JSON", state: "idle", event: "Stop", raw: "{nope" },
  { label: "input over 512 KB", state: "idle", event: "Stop", env: { [CAPTURE_RESULT_ENV]: "1" }, input: { last_assistant_message: "x".repeat(600 * 1024) } },
  { label: "input of invalid bytes near the bound", state: "idle", event: "Stop", raw: Buffer.concat([Buffer.from('{"last_assistant_message":"'), Buffer.alloc(200 * 1024, 0xff), Buffer.from('"}')]) },
  { label: "an array", state: "idle", event: "Stop", raw: "[1]" },
  { label: "Codex answer capture, granted", provider: "codex", state: "idle", event: "Stop", grant: true, env: { [CAPTURE_ANSWER_ENV]: "1", [CAPTURE_ANSWER_EXPIRES_AT_ENV]: ` ${Date.now() + 600_000} ` }, input: { thread_id: "0f8fad5b-d9cb-469f-a165-70867728950e", last_assistant_message: LONG_ANSWER } },
  { label: "Codex answer capture, refused by the gateway", provider: "codex", state: "idle", event: "Stop", grant: false, env: { [CAPTURE_ANSWER_ENV]: "1", [CAPTURE_ANSWER_EXPIRES_AT_ENV]: String(Date.now() + 600_000) }, input: { last_assistant_message: "answer" } },
  { label: "Codex answer capture, expired", provider: "codex", state: "idle", event: "Stop", grant: true, env: { [CAPTURE_ANSWER_ENV]: "1", [CAPTURE_ANSWER_EXPIRES_AT_ENV]: "1000" }, input: { last_assistant_message: "answer" } },
  { label: "Codex answer capture, a hexadecimal expiry", provider: "codex", state: "idle", event: "Stop", grant: true, env: { [CAPTURE_ANSWER_ENV]: "1", [CAPTURE_ANSWER_EXPIRES_AT_ENV]: "0x1fffffffffffff" }, input: { last_assistant_message: "answer" } },
  { label: "Claude never asks for the answer grant", provider: "claude", state: "idle", event: "Stop", grant: true, env: { [CAPTURE_ANSWER_ENV]: "1", [CAPTURE_ANSWER_EXPIRES_AT_ENV]: String(Date.now() + 600_000) }, input: { last_assistant_message: "answer" } },
  { label: "a gateway that never acknowledges", state: "idle", event: "Stop", silent: true, input: {} },
  { label: "no identity", state: "idle", event: "Stop", noIdentity: true, input: {} }
];

test("lifecycle hook: both implementations send the same lines and exit the same way", OPTIONS, async () => {
  const jobs = HOOK_CASES.map((entry) => async () => {
    const results = [];
    for (const implementation of IMPLEMENTATIONS) {
      const gateway = await lineServer((connection, message) => {
        if (entry.silent) return;
        if (message?.type === "answer-capture-check") connection.send({ v: 1, type: "ack", answerCapture: entry.grant === true });
        else connection.send({ v: 1, type: "ack" });
      });
      const provider = entry.provider ?? "claude";
      const env = entry.noIdentity ? baseEnvironment(entry.env) : runtimeEnvironment(gateway.path, provider, entry.env ?? {});
      const result = await runOnce(implementation.hook(entry.state, entry.event), { env, input: entry.raw ?? JSON.stringify(entry.input) });
      results.push({
        implementation: implementation.name,
        code: result.code,
        stdout: result.stdout,
        received: gateway.connections.map((connection) => connection.lines)
      });
      await gateway.close();
    }
    return { label: entry.label, results };
  });
  for (const { label, results } of await limited(jobs, 3)) {
    const reference = assertSame(results, label);
    assert.equal(reference.code, 0, label);
    assert.equal(reference.stdout, "", label);
  }
});

test("lifecycle hook: the real RuntimeGateway turns both implementations' reports into the same signal", OPTIONS, async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "canvastty-native-life-"));
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: runtime, windowsHostPath: WINDOWS_PIPE_HOST, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(async () => { await gateway.close(); await rm(runtime, { recursive: true, force: true }); });
  const collected = [];
  for (const implementation of IMPLEMENTATIONS) {
    const session = gateway.registerSession("life-1", "claude", true);
    signals.length = 0;
    await runOnce(implementation.hook("idle", "Stop"), {
      env: baseEnvironment({
        [AGENT_RUNTIME_ENV.address]: session.address,
        [AGENT_RUNTIME_ENV.terminalSessionId]: session.terminalSessionId,
        [AGENT_RUNTIME_ENV.provider]: "claude",
        [AGENT_RUNTIME_ENV.capabilityToken]: session.capabilityToken,
        [CAPTURE_RESULT_ENV]: "1"
      }),
      input: JSON.stringify({ session_id: "0F8FAD5B-D9CB-469F-A165-70867728950E", turn_id: "turn-9", last_assistant_message: LONG_ANSWER })
    });
    collected.push(signals.map(({ id, signal }) => {
      const { turnEpoch: _hostEpoch, ...implementationSignal } = signal;
      return { id, signal: implementationSignal };
    }));
  }
  assert.equal(collected[0].length, 1);
  assert.equal(collected[0][0].signal.threadId, "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.deepEqual(collected[1], collected[0]);
});
