import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { controlRequest, parseArguments, runCli } from "../scripts/canvastty-control.mjs";
import { AgentControlGateway, codexComposerReady } from "../src/main/services/agent-control/AgentControlGateway.ts";
import { TerminalManager, terminalEnvironment } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import {
  AGENT_RUNTIME_ENV,
  CAPTURE_ANSWER_ENV,
  CAPTURE_RESULT_ENV,
  MAX_ANSWER_CHARS,
  MAX_RESULT_CHARS,
  MAX_RUNTIME_MESSAGE_BYTES
} from "../src/agent-runtime/runtime-protocol.mjs";

const localSocket = { skip: process.platform === "win32" ? "Unix socket tests; native Windows pipe relay has its own suite." : false };
const PROMPT = "\x1b[2J\x1b[H>_ OpenAI Codex\r\nmodel: test\r\npermissions: YOLO mode\r\n\r\n› Ask Codex to do anything";

function registry() {
  return { get: (provider) => ({ state: "available", provider, executable: "/resolved/codex", launcher: "native",
    environment: {}, checked: [] }), snapshot: () => ({}) };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-control-test-")));
  const calls = [];
  let gateway;
  const terminals = new TerminalManager((channel, payload) => gateway?.observe(channel, payload), registry(), undefined, undefined, true,
    (command, args, options) => {
      let onData = () => {};
      let onExit = () => {};
      const pty = { write(text) { this.writes.push(text); }, writes: [], resize() {}, kill() {},
        onData(fn) { onData = fn; }, onExit(fn) { onExit = fn; },
        data(text) { onData(text); }, exit(code) { onExit({ exitCode: code }); } };
      calls.push({ command, args, options, pty });
      return pty;
    });
  let lifecycleEnabled = true;
  gateway = new AgentControlGateway({ userDataPath: root, terminals, lifecycleEnabled: () => lifecycleEnabled });
  const connectionPath = await gateway.start();
  const clientPath = join(root, "client-a.json");
  t.after(async () => { await gateway.close(); await terminals.shutdown(); });
  const request = (method, params = {}, requestId = randomUUID(), client = clientPath) =>
    controlRequest({ connectionPath, clientPath: client, method, params, requestId });
  const create = (requestId) => request("create", { provider: "codex", profile: "yolo", cwd: root, title: "Owned worker" }, requestId);
  const signal = (id, state, turnId = "provider-turn", result) => {
    terminals.applyProviderSignal(id, { kind: "lifecycle", state });
    gateway.onSignal(id, { state, event: state === "working" ? "UserPromptSubmit" : "Stop", turnId,
      ...(result === undefined ? {} : { result }) });
  };
  const ready = async (id, pty = calls.at(-1).pty) => {
    pty.data(PROMPT);
    for (let i = 0; i < 30; i++) {
      if (codexComposerReady((await request("screen", { sessionId: id })).text)) return;
      await delay(5);
    }
    assert.fail("fixture composer not ready");
  };
  return { root, gateway, terminals, calls, connectionPath, clientPath, request, create, signal, ready,
    disableLifecycle() { lifecycleEnabled = false; } };
}

test("CLI creates native YOLO with requested directory/title, including concurrent replay", localSocket, async (t) => {
  const f = await fixture(t);
  const args = ["--connection", f.connectionPath, "--client-file", f.clientPath, "--request-id", "same-create",
    "create", "--cwd", f.root, "--title", "API worker", "--yolo"];
  const [a, b] = await Promise.all([runCli(args), runCli(args)]);
  assert.equal(a.result.session.id, b.result.session.id);
  assert.equal(f.calls.length, 1);
  assert.equal(a.result.session.provider, "codex");
  assert.equal(a.result.session.profile, "yolo");
  assert.equal(a.result.session.cwd, f.root);
  assert.equal(a.result.session.title, "API worker");
  assert.ok(f.calls[0].args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!f.calls[0].args.includes("read-only"));
  assert.equal(f.calls[0].options.cwd, f.root);
  const descriptor = JSON.parse(await readFile(f.connectionPath, "utf8"));
  assert.equal((await stat(descriptor.endpoint)).mode & 0o777, 0o600);
  assert.equal((await stat(descriptor.tokenFile)).mode & 0o777, 0o600);
  await assert.rejects(runCli([...args.slice(0, 6), "create", "--cwd", f.root, "--title", "Different"]),
    (e) => e.code === "REQUEST_CONFLICT");
  assert.equal(f.calls.length, 1);
});

test("controller cannot list, read, interrupt or send to other controllers or UI sessions", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  const clientB = join(f.root, "client-b.json");
  assert.deepEqual((await f.request("list", {}, undefined, clientB)).sessions, []);
  for (const method of ["status", "screen", "result", "interrupt", "send", "choose", "dismiss"]) {
    await assert.rejects(f.request(method, { sessionId: session.id, ...(method === "send" ? { text: "task" } : {}) }, undefined, clientB),
      (e) => e.code === "SESSION_NOT_FOUND");
  }
  const ui = f.terminals.create({ provider: "codex", profile: "normal", cwd: f.root, position: { x: 0, y: 0 } });
  await assert.rejects(f.request("status", { sessionId: ui.id }), (e) => e.code === "SESSION_NOT_FOUND");
});

test("literal prompt delivery, busy guard, result revisions and stale-result separation", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await f.ready(session.id);
  const text = 'Check "$1" and $(literal text)\nsecond line';
  const first = await f.request("send", { sessionId: session.id, text }, "send-one");
  await f.request("send", { sessionId: session.id, text }, "send-one");
  assert.deepEqual(f.calls[0].pty.writes, [`\x1b[200~${text}\x1b[201~\r`]);
  assert.equal(first.resultRevisionBefore, 0);
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "idle", "old-turn", { text: "stale", truncated: false });
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "working", "native-one");
  await assert.rejects(f.request("send", { sessionId: session.id, text: "another" }), (e) => e.code === "BUSY");
  f.signal(session.id, "idle", "old-turn", { text: "stale", truncated: false });
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "idle", "native-one", { text: "done-one", truncated: false });
  const result = await f.request("result", { sessionId: session.id, after: 0 });
  assert.equal(result.resultRevision, 1);
  assert.equal(result.turn.result.text, "done-one");
  assert.equal((await f.request("result", { sessionId: session.id, after: 1 })).fresh, false);
  await f.request("send", { sessionId: session.id, text: "next" }, "send-two");
  const old = await f.request("result", { sessionId: session.id, after: 0 });
  assert.equal(old.turn.id, "send-one");
  assert.equal(old.turn.state, "completed");
  assert.equal((await f.request("result", { sessionId: session.id, after: 1 })).fresh, false);
});

test("interrupt affects one owned turn and reports completion only after lifecycle confirmation", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await f.ready(session.id);
  await f.request("send", { sessionId: session.id, text: "work" });
  f.signal(session.id, "working");
  const result = await f.request("interrupt", { sessionId: session.id }, "interrupt-one");
  await f.request("interrupt", { sessionId: session.id }, "interrupt-one");
  assert.equal(result.stopped, false);
  assert.equal(f.calls[0].pty.writes.filter((x) => x === "\x03").length, 1);
  assert.equal((await f.request("result", { sessionId: session.id })).fresh, false);
  f.signal(session.id, "idle");
  assert.equal((await f.request("result", { sessionId: session.id })).turn.state, "interrupted");
});

test("startup/trust/permission menus, slash commands and terminal escape input are not task submission", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  await assert.rejects(f.request("send", { sessionId: session.id, text: "task" }), (e) => e.code === "NOT_READY");
  await f.ready(session.id);
  for (const text of ["/permissions", "\x1b[2J", "abc\rdef", "\0", "x".repeat(16001)]) {
    await assert.rejects(f.request("send", { sessionId: session.id, text }), (e) => e.code === "INVALID_PARAMS");
  }
  assert.equal(f.calls[0].pty.writes.length, 0);
  assert.equal(codexComposerReady("Do you trust the contents\n› Ask Codex to do anything"), false);
  assert.equal(codexComposerReady("model: loading\n› Ask Codex to do anything"), false);
  assert.equal(codexComposerReady("› 1. Yes, continue\nPress enter to confirm"), false);
  assert.equal(codexComposerReady("› partially typed human text"), false);
});

test("explicit menu choices use the observed revision and deduplicate PTY input", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.create();
  const pty = f.calls[0].pty;
  const observe = async (text, expected) => {
    pty.data(text);
    for (let i = 0; i < 30; i++) {
      const current = await f.request("screen", { sessionId: session.id });
      if (current.text.includes(expected)) return current;
      await delay(5);
    }
    assert.fail("batched PTY output did not arrive");
  };
  const screen = await observe("\x1b[2J\x1b[HHooks need review\r\n› 1. Review hooks\r\n  2. Trust all and continue\r\n  3. Continue without hooks\r\nPress enter to confirm or esc to cancel", "Press enter");
  assert.equal(screen.interaction.selected, 1);
  assert.equal(screen.interaction.options[1].label, "Trust all and continue");
  await assert.rejects(f.request("send", { sessionId: session.id, text: "task" }), (e) => e.code === "NOT_READY");
  await assert.rejects(f.request("choose", { sessionId: session.id, choice: 2, revision: "old" }), (e) => e.code === "STALE_MENU");
  await assert.rejects(f.request("choose", { sessionId: session.id, choice: 4, revision: screen.revision }), (e) => e.code === "INVALID_PARAMS");
  const params = { sessionId: session.id, choice: 2, revision: screen.revision };
  await f.request("choose", params, "choose-once");
  await f.request("choose", params, "choose-once");
  assert.deepEqual(pty.writes, ["\x1b[B\r"]);
  const detail = await observe("\x1b[2J\x1b[HHooks\r\n6 hooks reviewed\r\nPress esc to close", "Press esc");
  await assert.rejects(f.request("dismiss", { sessionId: session.id, revision: screen.revision }), (e) => e.code === "STALE_MENU");
  await f.request("dismiss", { sessionId: session.id, revision: detail.revision }, "dismiss-once");
  await f.request("dismiss", { sessionId: session.id, revision: detail.revision }, "dismiss-once");
  assert.deepEqual(pty.writes, ["\x1b[B\r", "\x1b"]);
  await f.ready(session.id);
  const ready = await f.request("screen", { sessionId: session.id });
  await assert.rejects(f.request("dismiss", { sessionId: session.id, revision: ready.revision }), (e) => e.code === "NOT_MENU");
  await assert.rejects(f.request("choose", { sessionId: session.id, choice: 1, revision: ready.revision }), (e) => e.code === "STALE_MENU");
  assert.equal(pty.writes.length, 2);
});

test("invalid socket credentials cannot launch a native session", localSocket, async (t) => {
  const f = await fixture(t);
  const descriptor = JSON.parse(await readFile(f.connectionPath, "utf8"));
  const reply = await new Promise((resolveReply, reject) => {
    const socket = createConnection(descriptor.endpoint);
    socket.on("error", reject);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("missing rejection")); });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) { socket.destroy(); resolveReply(JSON.parse(buffer.trim())); }
    });
    socket.on("connect", () => socket.write(JSON.stringify({ v: 1, id: "unauthorized-create", instanceId: descriptor.instanceId,
      token: "0".repeat(64), controller: "1".repeat(64), method: "create",
      params: { provider: "codex", profile: "yolo", cwd: f.root } }) + "\n"));
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "INVALID_REQUEST");
  assert.equal(f.calls.length, 0);
});

test("YOLO persists across native restart/restore while stale control grants fail", localSocket, async (t) => {
  const f = await fixture(t);
  f.terminals.configureSessionPersistence(new TerminalSessionStore(f.root), true);
  const { session } = await f.create();
  f.calls[0].pty.exit(1);
  await delay(2);
  f.terminals.restart(session.id);
  assert.ok(f.calls[1].args.includes("--dangerously-bypass-approvals-and-sandbox"));
  await assert.rejects(f.request("status", { sessionId: session.id }), (e) => e.code === "STALE_SESSION");
  await f.terminals.shutdown();
  const restoredCalls = [];
  const restored = new TerminalManager(() => {}, registry(), undefined, undefined, true,
    (_command, args) => { restoredCalls.push(args); return { onData() {}, onExit() {}, kill() {}, write() {}, resize() {} }; });
  restored.configureSessionPersistence(new TerminalSessionStore(f.root), true);
  await restored.restorePersistedSessions();
  t.after(() => restored.shutdown());
  assert.ok(restoredCalls[0].includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(restored.listMetadata()[0].profile, "yolo");
});

test("disabled lifecycle and invalid parameters fail before launching a process", localSocket, async (t) => {
  const f = await fixture(t);
  for (const extra of [{ provider: "terminal" }, { profile: "read-only" }, { cwd: "relative" }, { title: "x".repeat(81) }, { unexpected: true }]) {
    await assert.rejects(f.request("create", { provider: "codex", profile: "yolo", cwd: f.root, ...extra }), (e) => e.code === "INVALID_PARAMS");
  }
  f.disableLifecycle();
  await assert.rejects(f.create(), (e) => e.code === "LIFECYCLE_DISABLED");
  assert.equal(f.calls.length, 0);
});

test("CLI rejects inapplicable flags and never sends malformed result revisions", async () => {
  assert.deepEqual(parseArguments(["create", "--cwd", "folder with spaces", "--yolo"]).options, { cwd: "folder with spaces", yolo: true });
  await assert.rejects(runCli(["status", "session", "--profile", "yolo"]), /does not apply/);
  await assert.rejects(runCli(["result", "session", "--after", "NaN"]), /non-negative integer/);
  await assert.rejects(runCli(["create", "--cwd", ".", "--profile", "normal", "--yolo"]), /Conflicting/);
  await assert.rejects(runCli(["send", "session", "--text", "one", "--prompt-file", "two"]), /exactly one/);
});

test("opt-in hook result capture is authenticated, bounded and absent for ordinary sessions", localSocket, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-control-result-"));
  const signals = [];
  const gateway = new RuntimeGateway({ runtimeDirectory: root, onSignal: (id, signal) => signals.push({ id, signal }) });
  await gateway.start();
  t.after(() => gateway.close());
  async function hook(id, capture, leaseCapture, text, answer = false, leaseAnswer = false) {
    const cap = gateway.registerSession(id, "codex", leaseCapture, leaseAnswer);
    const env = { ...process.env, [AGENT_RUNTIME_ENV.address]: cap.address,
      [AGENT_RUNTIME_ENV.terminalSessionId]: cap.terminalSessionId, [AGENT_RUNTIME_ENV.provider]: cap.provider,
      [AGENT_RUNTIME_ENV.capabilityToken]: cap.capabilityToken, [CAPTURE_RESULT_ENV]: capture ? "1" : "0",
      [CAPTURE_ANSWER_ENV]: answer ? "1" : "0" };
    const child = spawn(process.execPath, [resolve("src/agent-runtime/hook-helper.mjs"), "idle", "Stop"], { env, stdio: ["pipe", "ignore", "pipe"] });
    child.stdin.end(JSON.stringify({ turn_id: "turn", last_assistant_message: text }));
    await new Promise((done, reject) => { child.on("error", reject); child.on("exit", (code) => code === 0 ? done() : reject(new Error("Hook failed"))); });
  }
  await hook("normal", false, false, "private ordinary response");
  assert.equal(signals[0].signal.result, undefined);
  assert.equal(signals[0].signal.lastAssistantMessage, undefined);
  assert.equal(JSON.stringify(signals).includes("private ordinary response"), false);
  await hook("controlled", true, true, "x".repeat(MAX_RESULT_CHARS + 100));
  assert.equal(signals[1].signal.result.text.length, MAX_RESULT_CHARS);
  assert.equal(signals[1].signal.result.truncated, true);
  await hook("not-authorized", true, false, "must not arrive");
  assert.equal(signals.length, 2);
  assert.equal(terminalEnvironment({ [CAPTURE_RESULT_ENV]: "1", PATH: "/bin" })[CAPTURE_RESULT_ENV], undefined);
  assert.equal(terminalEnvironment({ [CAPTURE_ANSWER_ENV]: "1", PATH: "/bin" })[CAPTURE_ANSWER_ENV], undefined);

  // A Stop payload larger than the wire cap still reports the turn for an ordinary session.
  await hook("large", false, false, "z".repeat(MAX_RUNTIME_MESSAGE_BYTES + 1024));
  assert.equal(signals[2].signal.turnId, "turn");
  assert.equal(signals[2].signal.result, undefined);
  assert.equal(signals[2].signal.lastAssistantMessage, undefined);

  // Companion answer capture is a separate opt-in: bounded, and refused without its lease grant.
  await hook("companion", false, false, "y".repeat(MAX_ANSWER_CHARS + 5), true, true);
  assert.equal(signals[3].signal.result, undefined);
  assert.equal(signals[3].signal.lastAssistantMessage.length, MAX_ANSWER_CHARS);
  assert.equal(gateway.currentStatus("companion"), "idle");
  await hook("companion-unauthorized", false, false, "must not arrive either", true, false);
  assert.equal(signals.length, 4);
});
