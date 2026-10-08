import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { CompanionSessions } from "../src/main/services/companion/CompanionSessions.ts";
import { SessionAccess } from "../src/main/services/companion/SessionAccess.ts";
import { HumanQuestionService } from "../src/main/services/HumanQuestionService.ts";
import { OrchestrationGateway } from "../src/main/services/agent-browser/OrchestrationGateway.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { createOrchestrationDispatcher, OrchestrationClient } from "../src/agent-browser/orchestration-helper.mjs";

const WINDOWS_PIPE_HOST = join(process.cwd(), "build", "windows-agent-pipe-host", "canvastty-windows-agent-pipe-host.exe");
const request = (action, id = "a".repeat(32)) => ({ version: 1, id, sentAt: Date.now(), action });

function fixture() {
  const access = new SessionAccess();
  access.share({ deviceId: "phone", sessionIds: ["shared"], allowInput: true, allowCreate: false, allowClose: false, allowBrowser: false });
  const writes = [];
  const snapshot = { buffer: Array.from({ length: 35_000 }, (_, i) => String.fromCharCode(33 + i % 80)).join(""), outputOffset: 35_000, cols: 90, rows: 25 };
  const host = {
    list: () => [
      { id: "shared", title: "Safe", provider: "codex", status: "working", cwd: "/secret" },
      { id: "private", title: "Secret", provider: "claude", status: "idle", cwd: "/secret" },
    ],
    overview: () => [
      { id: "shared", title: "Safe", provider: "codex", status: "working", startedAt: 123, exitCode: null, revision: 4, cwd: "/secret" },
      { id: "private", title: "Secret", provider: "claude", status: "idle", startedAt: 234, exitCode: 0, revision: 5, cwd: "/secret" },
    ],
    providers: () => ({ codex: true, claude: false, terminal: true }),
    output: () => snapshot,
    input: (id, data) => { writes.push({ id, data }); return true; },
    read: async () => ({ body: "safe", revision: "v1" }),
  };
  return { service: new CompanionSessions(host, access), host, access, snapshot, writes };
}

test("overview exposes only shared safe metadata and current permissions", async () => {
  const f = fixture();
  const result = await f.service.dispatch("phone", request({ type: "sessions.overview" }));
  assert.deepEqual(result.sessions, [{ id: "shared", title: "Safe", provider: "codex", status: "working", startedAt: 123, exitCode: null, revision: 4 }]);
  assert.equal(result.providers.codex, true);
  assert.equal(result.providers.claude, false);
  assert.deepEqual(result.permissions, { allowInput: true, allowCreate: false, allowClose: false });
  assert.equal(JSON.stringify(result).includes("/secret"), false);
});

test("summary-only dispatch denies terminal writes and advertises no launch providers", async () => {
  const f = fixture();
  let sequence = 0;
  const nextRequest = action => request(action, (++sequence).toString(16).padStart(32, "0"));
  const overview = await f.service.dispatch("phone", nextRequest({ type: "sessions.overview" }), { summaryOnly: true });
  assert.deepEqual(overview.permissions, {
    allowInput: false, allowCreate: false, allowClose: false, allowInterrupt: true, allowRename: true,
  });
  assert.equal(Object.values(overview.providers).some(Boolean), false);
  for (const action of [
    { type: "session.input", sessionId: "shared", text: "whoami" },
    { type: "session.key", sessionId: "shared", key: "enter" },
    { type: "session.create", provider: "terminal" },
  ]) {
    await assert.rejects(f.service.dispatch("phone", nextRequest(action), { summaryOnly: true }), { code: "not-permitted" });
  }
  assert.equal(f.writes.length, 0);
  await f.service.dispatch("phone", nextRequest({ type: "session.interrupt", sessionId: "shared" }), { summaryOnly: true });
  assert.deepEqual(f.writes, [{ id: "shared", data: "\x03" }]);
});

test("exited shared session keeps its output but refuses input to a dead PTY", async () => {
  const f = fixture();
  const exited = { id: "shared", title: "Safe", provider: "codex", status: "failed" };
  f.host.list = () => [exited];
  f.host.overview = () => [{ ...exited, startedAt: 123, exitCode: 17, revision: 5 }];
  f.host.input = () => false;

  const overview = await f.service.dispatch("phone", request({ type: "sessions.overview" }));
  assert.deepEqual(overview.sessions, [{ ...exited, startedAt: 123, exitCode: 17, revision: 5 }]);
  const output = await f.service.dispatch("phone", request({ type: "session.output", sessionId: "shared", cursor: null }, "e".repeat(32)));
  assert.equal(output.data, f.snapshot.buffer.slice(-16_000));
  await assert.rejects(f.service.dispatch("phone", request({ type: "session.input", sessionId: "shared", text: "relaunch" }, "f".repeat(32))), { code: "unavailable" });
  assert.equal(f.writes.length, 0);
});

test("raw output catches up in bounded nonoverlapping slices, tail signals omitted history and cursor resets", async () => {
  const f = fixture();
  const output = (cursor) => f.service.dispatch("phone", request({ type: "session.output", sessionId: "shared", cursor }, crypto.randomUUID().replaceAll("-", "")));
  const first = await output(0);
  const second = await output(first.offset);
  const third = await output(second.offset);
  assert.equal(first.data.length, 16_000);
  assert.equal(first.offset, 16_000);
  assert.equal(first.hasMore, true);
  assert.equal(second.offset, 32_000);
  assert.equal(third.offset, 35_000);
  assert.equal(first.data + second.data + third.data, f.snapshot.buffer);
  assert.equal(third.hasMore, false);
  const tail = await output(null);
  assert.deepEqual({ length: tail.data.length, offset: tail.offset, gap: tail.gap, hasMore: tail.hasMore, cols: tail.cols, rows: tail.rows }, { length: 16_000, offset: 35_000, gap: true, hasMore: false, cols: 90, rows: 25 });
  f.snapshot.buffer = f.snapshot.buffer.slice(-2_000);
  const trimmed = await output(31_000);
  assert.equal(trimmed.offset, 35_000);
  assert.equal(trimmed.data.length, 2_000);
  assert.equal(trimmed.gap, true);
  const ahead = await output(40_000);
  assert.equal(ahead.offset, 35_000);
  assert.equal(ahead.gap, true);
});

test("output pages never split a UTF-16 surrogate pair", async () => {
  const f = fixture();
  f.snapshot.buffer = "x".repeat(15_999) + "😀" + "y".repeat(100);
  f.snapshot.outputOffset = f.snapshot.buffer.length;
  const first = await f.service.dispatch("phone", request({ type: "session.output", sessionId: "shared", cursor: 0 }));
  assert.equal(first.offset, 15_999);
  assert.equal(first.data, "x".repeat(15_999));
  const next = await f.service.dispatch("phone", request({ type: "session.output", sessionId: "shared", cursor: first.offset }, "d".repeat(32)));
  assert.equal(next.data.slice(0, 2), "😀");
  assert.equal(first.data + next.data, f.snapshot.buffer);
});

test("fixed keys alone write PTY bytes, invalid input and revocation never act", async () => {
  const f = fixture();
  await assert.rejects(f.service.dispatch("phone", request({ type: "session.key", sessionId: "shared", key: "\u001b[31m" })), { code: "invalid-request" });
  await assert.rejects(f.service.dispatch("phone", request({ type: "session.key", sessionId: "private", key: "enter" })), { code: "not-shared" });
  assert.equal(f.writes.length, 0);
  await f.service.dispatch("phone", request({ type: "session.key", sessionId: "shared", key: "up" }, "b".repeat(32)));
  assert.deepEqual(f.writes, [{ id: "shared", data: "\u001b[A" }]);
  f.access.revoke("phone");
  await assert.rejects(f.service.dispatch("phone", request({ type: "session.key", sessionId: "shared", key: "ctrl-c" }, "c".repeat(32))), { code: "not-paired" });
  assert.equal(f.writes.length, 1);
});

test("ask_user round-trips through an authorized phone reply and ends with the session or request", async (t) => {
  const f = fixture();
  const sessions = new Map([
    ["shared", { role: "agent", provider: "codex", startedAt: 123, exitCode: null, turnEpoch: 1 }],
    ["orchestrator", { role: "orchestrator", provider: "codex", startedAt: 124, exitCode: null, turnEpoch: 1 }],
    ["subagent", { role: "subagent", provider: "claude", startedAt: 125, exitCode: null, turnEpoch: 1 }],
    ["terminal", { role: "agent", provider: "terminal", startedAt: 126, exitCode: null, turnEpoch: 1 }],
    ["reviewer", { role: "agent", provider: "codex", startedAt: 127, exitCode: null, turnEpoch: 1 }],
  ]);
  const control = {
    status: (id) => sessions.get(id),
    isReadOnlyReviewer: (id) => id === "reviewer",
  };
  const questions = new HumanQuestionService({
    getSession: (id) => {
      const { provider, startedAt, exitCode, turnEpoch } = sessions.get(id) ?? {};
      return provider ? { provider, startedAt, exitCode, turnEpoch } : null;
    },
    redact: (text) => text.replaceAll("sk-secret-value", "[redacted]"),
  });
  f.host.question = (id) => questions.pending(id);
  f.host.reply = (id, requestId, answer) => questions.reply(id, requestId, answer);

  const directory = await mkdtemp(join(tmpdir(), "canvastty-phone-question-"));
  const handler = new ScopedOrchestrationHandler(control, null, undefined, { humanQuestions: questions });
  const gateway = new OrchestrationGateway({
    runtimeDirectory: join(directory, "runtime"),
    handler,
    windowsHostPath: WINDOWS_PIPE_HOST,
  });
  let client;
  t.after(async () => {
    client?.close();
    questions.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true });
  });

  await gateway.start();
  const identity = gateway.registerOrchestrator({ terminalSessionId: "shared" });
  client = new OrchestrationClient(identity, { callTimeoutMs: 5_000 });
  const dispatch = createOrchestrationDispatcher(client);
  const tools = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const schema = tools.result.tools.find((tool) => tool.name === "ask_user").inputSchema;
  assert.deepEqual(schema.required, ["question"]);
  assert.deepEqual([schema.properties.question.maxLength, schema.properties.options.maxItems,
    schema.properties.options.items.maxLength, schema.properties.timeoutSeconds.maximum], [1_000, 8, 160, 600]);
  for (const id of ["shared", "orchestrator", "subagent"]) {
    assert.ok(handler.listTools(id).some((tool) => tool.name === "ask_user"), id);
  }
  assert.ok(!handler.listTools("terminal").some((tool) => tool.name === "ask_user"));
  assert.deepEqual(handler.listTools("reviewer"), []);

  let sequence = 0;
  const phone = (deviceId, action) => f.service.dispatch(deviceId, request(action, (++sequence).toString(16).padStart(32, "0")), { summaryOnly: true });
  const ask = (id, args) => dispatch({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask_user", arguments: args } });
  const waitForQuestion = async () => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const pending = questions.pending("shared");
      if (pending) return pending;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The agent question did not reach the phone.");
  };
  const waitForQuestionEnd = async () => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (!questions.pending("shared")) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The agent question remained pending after its request ended.");
  };
  const mcpErrorCode = (result) => JSON.parse(result.result.content[0].text).error.code;

  for (const [index, args] of [
    { question: "Pick", options: Array(9).fill("a") },
    { question: "Pick", timeoutSeconds: 601 },
  ].entries()) {
    const rejected = await ask(8 + index, args);
    assert.equal(rejected.result.isError, true);
    assert.equal(mcpErrorCode(rejected), "INVALID_REQUEST");
  }
  await assert.rejects(
    handler.execute("terminal", { id: "terminal-ask", tool: "ask_user", arguments: { question: "No terminal questions." } }),
    (error) => error.bridgeError?.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    handler.execute("reviewer", { id: "reviewer-ask", tool: "ask_user", arguments: { question: "No reviewer questions." } }),
    (error) => error.bridgeError?.code === "INVALID_REQUEST",
  );

  const overview = await phone("phone", { type: "sessions.overview" });
  assert.equal(overview.permissions.allowReply, true);
  for (const action of [
    { type: "session.input", sessionId: "shared", text: "raw input" },
    { type: "session.key", sessionId: "shared", key: "enter" },
    { type: "session.create", provider: "terminal" },
  ]) {
    await assert.rejects(phone("phone", action), { code: "not-permitted" });
  }

  const firstCall = ask(2, { question: "Which build should I use?", options: ["Stable", "Preview"], timeoutSeconds: 10 });
  const first = await waitForQuestion();
  const summary = await phone("phone", { type: "session.read", sessionId: "shared" });
  assert.deepEqual(summary.question, first);
  await assert.rejects(phone("phone", { type: "session.reply", sessionId: "shared", requestId: first.id, answer: "Preview" }), { code: "INVALID_REQUEST" });
  assert.equal(questions.pending("shared").id, first.id, "a freeform answer cannot consume a choices-only question");
  await assert.rejects(phone("unpaired", { type: "session.reply", sessionId: "shared", requestId: first.id, answer: 1 }), { code: "not-paired" });
  f.access.share({ deviceId: "limited", sessionIds: ["shared"], allowInput: false, allowCreate: false, allowClose: false, allowBrowser: false });
  await assert.rejects(phone("limited", { type: "session.reply", sessionId: "shared", requestId: first.id, answer: 1 }), { code: "not-permitted" });
  f.access.revoke("phone");
  await assert.rejects(phone("phone", { type: "session.reply", sessionId: "shared", requestId: first.id, answer: 1 }), { code: "not-paired" });
  f.access.share({ deviceId: "phone", sessionIds: ["shared"], allowInput: true, allowCreate: false, allowClose: false, allowBrowser: false });
  await phone("phone", { type: "session.reply", sessionId: "shared", requestId: first.id, answer: 1 });
  const answered = await firstCall;
  assert.equal(answered.result.isError, false);
  assert.deepEqual(JSON.parse(answered.result.content[0].text), { answer: "Preview", selectedIndex: 1 });
  assert.equal(f.writes.length, 0, "a phone answer is returned to the waiting tool and never written to the PTY");

  const freeformCall = ask(7, { question: "What should I know about sk-secret-value?", timeoutSeconds: 10 });
  const freeform = await waitForQuestion();
  assert.equal(freeform.question, "What should I know about [redacted]?");
  await phone("phone", { type: "session.reply", sessionId: "shared", requestId: freeform.id, answer: "Keep sk-secret-value in mind." });
  const freeformAnswer = await freeformCall;
  assert.deepEqual(JSON.parse(freeformAnswer.result.content[0].text), { answer: "Keep [redacted] in mind." });

  const staleCall = ask(3, { question: "Continue this turn?", timeoutSeconds: 10 });
  const stale = await waitForQuestion();
  sessions.get("shared").turnEpoch += 1;
  assert.equal((await phone("phone", { type: "session.read", sessionId: "shared" })).question, null);
  assert.equal(mcpErrorCode(await staleCall), "SESSION_EXPIRED");
  await assert.rejects(phone("phone", { type: "session.reply", sessionId: "shared", requestId: stale.id, answer: "yes" }), { code: "SESSION_EXPIRED" });

  const canceledCall = ask(4, { question: "Cancel this request?", timeoutSeconds: 10 });
  const canceled = await waitForQuestion();
  await dispatch({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } });
  assert.equal(mcpErrorCode(await canceledCall), "CANCELED");
  await waitForQuestionEnd();
  assert.equal(questions.pending("shared"), null);
  await assert.rejects(phone("phone", { type: "session.reply", sessionId: "shared", requestId: canceled.id, answer: "too late" }), { code: "SESSION_EXPIRED" });

  const expiredCall = ask(5, { question: "This should expire.", timeoutSeconds: 1 });
  const expired = await waitForQuestion();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(questions.pending("shared"), null);
  assert.equal(mcpErrorCode(await expiredCall), "TIMEOUT");
  assert.ok(expired.expiresAt <= Date.now());

  const closedCall = ask(6, { question: "Close while waiting?", timeoutSeconds: 10 });
  const closed = await waitForQuestion();
  questions.close();
  assert.equal(mcpErrorCode(await closedCall), "SESSION_EXPIRED");
  assert.equal(questions.pending("shared"), null);
  await assert.rejects(phone("phone", { type: "session.reply", sessionId: "shared", requestId: closed.id, answer: "too late" }), { code: "SESSION_EXPIRED" });
  assert.equal(f.writes.length, 0);
});
