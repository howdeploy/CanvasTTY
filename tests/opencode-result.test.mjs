import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_RUNTIME_ENV, CAPTURE_RESULT_ENV, MAX_RESULT_CHARS } from "../src/agent-runtime/runtime-protocol.mjs";
import { finalAnswer } from "../src/agent-runtime/opencode-final-answer.mjs";
import { RuntimeGateway } from "../src/main/services/agent-runtime/RuntimeGateway.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const POSIX = { skip: process.platform === "win32" ? "Unix socket test; the Windows pipe transport has its own suite." : false };

// Built at run time so the repository holds no key-shaped literal.
const FAKE_KEY = ["sk", "ant", "api03", "Zq7".repeat(14)].join("-");
const reply = (role, ...parts) => ({ info: { role }, parts });
const text = (value, extra = {}) => ({ type: "text", text: value, ...extra });

test("the plugin reads the session's last assistant reply, not a tool call or a synthetic part", async () => {
  const messages = [
    reply("user", text("fix the parser")),
    reply("assistant", text("Looking."), { type: "tool", tool: "bash" }),
    reply("assistant", { type: "reasoning", text: "hidden" }, text("Fixed the parser; tests pass."), text("<system>", { synthetic: true })),
    reply("user", text("thanks"))
  ];
  const v2 = { session: { messages: async (input) => (input.sessionID === "ses_1" ? { data: messages } : { data: [] }) } };
  assert.deepEqual(await finalAnswer(v2, "ses_1"), { text: "Fixed the parser; tests pass.", truncated: false });
  // The v1 SDK takes { path: { id } } and answers without the v2 shape first.
  const v1 = { session: { messages: async (input) => (input.path?.id === "ses_1" ? { data: messages } : { error: "bad request" }) } };
  assert.deepEqual(await finalAnswer(v1, "ses_1"), { text: "Fixed the parser; tests pass.", truncated: false });
  const long = `${"a".repeat(MAX_RESULT_CHARS)}THE END`;
  const cut = await finalAnswer({ session: { messages: async () => ({ data: [reply("assistant", text(long))] }) } }, "ses_1");
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, MAX_RESULT_CHARS);
  assert.ok(cut.text.endsWith("THE END"), "the end of a long answer is kept");
  assert.equal(await finalAnswer({ session: { messages: () => new Promise(() => {}) } }, "ses_1", 20), undefined, "a hung read gives up");
  assert.equal(await finalAnswer({ session: { messages: async () => { throw new Error("down"); } } }, "ses_1"), undefined);
  assert.equal(await finalAnswer(undefined, "ses_1"), undefined);
});

// A stand-in OpenCode process: CanvasTTY's plugin loaded the way OpenCode loads it, with a fake SDK client, fed
// the events OpenCode emits for one turn.
const FAKE_OPENCODE = `
const { CanvasTTYLifecycle } = await import(process.env.PLUGIN_URL);
const answer = JSON.parse(process.env.FAKE_ANSWER);
const client = { session: { messages: async ({ sessionID }) => ({ data: sessionID === "ses_root"
  ? [{ info: { role: "user" }, parts: [{ type: "text", text: "task" }] }, { info: { role: "assistant" }, parts: [{ type: "text", text: answer }] }]
  : [] }) } };
const hooks = await CanvasTTYLifecycle({ client });
await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_root" } } } });
await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_root", status: { type: "busy" } } } });
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } });
`;

function runFakeOpenCode(capability, answer, captureResult) {
  const env = {
    ...process.env,
    PLUGIN_URL: new URL("../src/agent-runtime/opencode-plugin.mjs", import.meta.url).href,
    FAKE_ANSWER: JSON.stringify(answer),
    [AGENT_RUNTIME_ENV.address]: capability.address,
    [AGENT_RUNTIME_ENV.terminalSessionId]: capability.terminalSessionId,
    [AGENT_RUNTIME_ENV.provider]: capability.provider,
    [AGENT_RUNTIME_ENV.capabilityToken]: capability.capabilityToken
  };
  if (captureResult) env[CAPTURE_RESULT_ENV] = "1";
  else delete env[CAPTURE_RESULT_ENV];
  const child = spawn(process.execPath, ["--input-type=module", "-e", FAKE_OPENCODE], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr })));
}

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-ocr-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "ctty-rt-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  // What main/index.ts does with each runtime signal.
  const gateway = new RuntimeGateway({
    runtimeDirectory,
    onSignal: (id, signal) => {
      terminals.applyProviderSignal(id, { kind: "lifecycle", state: signal.state });
      if (signal.result) terminals.recordAnswer(id, signal.result);
    }
  });
  await gateway.start();
  t.after(() => gateway.close());
  const orchestrator = terminals.create({ provider: "codex", cwd: root, profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  const control = new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 300, quietMs: 2_000 } });
  const handler = new ScopedOrchestrationHandler(control);
  const child = await handler.execute(orchestrator.id, { id: "1", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root } });
  return { root, calls, terminals, gateway, handler, orchestrator, childId: child.sessionId };
}

test("an OpenCode subagent's final reply reaches wait_for_agent and get_agent_result, masked", POSIX, async (t) => {
  const { calls, terminals, gateway, handler, orchestrator, childId } = await setup(t);
  assert.equal(calls.at(-1).options.env[CAPTURE_RESULT_ENV], undefined, "no runtime here: the fake process gets it below");
  // The spawn asked the launch to capture this subagent's answer.
  const capability = gateway.registerSession(childId, "opencode", true);
  // The screen of a full-screen TUI is redraw noise; the answer is not in it.
  calls.at(-1).process.emitData("\u001b[2J\u001b[H\u001b[38;5;245m┃ working…\u001b[0m");
  terminals.applyProviderSignal(childId, { kind: "lifecycle", state: "working" });
  const waiting = handler.execute(orchestrator.id, { id: "w", tool: "wait_for_agent", arguments: { sessionId: childId, timeoutSeconds: 10 } });
  const run = await runFakeOpenCode(capability, `Parser fixed in src/parse.ts; npm test passes. Key ${FAKE_KEY}`, true);
  assert.equal(run.code, 0, run.stderr);
  const waited = await waiting;
  assert.equal(waited.reason, "idle");
  assert.match(waited.answer.text, /^Parser fixed in src\/parse\.ts; npm test passes\./u);
  assert.ok(!waited.answer.text.includes(FAKE_KEY), "the answer is masked");
  const result = await handler.execute(orchestrator.id, { id: "r", tool: "get_agent_result", arguments: { sessionId: childId } });
  assert.deepEqual([result.state, result.status], ["running", "idle"]);
  assert.equal(result.answer.text, waited.answer.text);
  assert.equal(result.answer.truncated, false);
  // A new turn clears the previous answer until that turn reports its own.
  terminals.applyProviderSignal(childId, { kind: "lifecycle", state: "working" });
  const next = await handler.execute(orchestrator.id, { id: "r2", tool: "get_agent_result", arguments: { sessionId: childId } });
  assert.equal(next.answer, undefined);
});

test("without result capture the plugin sends no answer and the gateway accepts none", POSIX, async (t) => {
  const { gateway, handler, orchestrator, childId } = await setup(t);
  const capability = gateway.registerSession(childId, "opencode", false);
  const run = await runFakeOpenCode(capability, "private reply", false);
  assert.equal(run.code, 0, run.stderr);
  const result = await handler.execute(orchestrator.id, { id: "r", tool: "get_agent_result", arguments: { sessionId: childId } });
  assert.equal(result.answer, undefined);
});

test("an ordinary OpenCode card (not a subagent) never keeps an answer", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-opencode-plain-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([]));
  t.after(() => terminals.disposeAll());
  const card = terminals.create({ provider: "opencode", cwd: root, profile: "normal", position: { x: 0, y: 0 } });
  terminals.recordAnswer(card.id, { text: "reply", truncated: false });
  assert.equal(terminals.answer(card.id), null);
  assert.throws(() => terminals.create({ provider: "claude", cwd: root, profile: "normal", position: { x: 0, y: 0 } }, { captureResult: true }),
    /Codex or OpenCode/u);
});

test("wait_for_agent ignores an idle before the prompt's turn and returns that turn's answer", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-ocr-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner([]));
  t.after(() => terminals.disposeAll());
  const orchestrator = terminals.create({ provider: "codex", cwd: root, profile: "normal", position: { x: 0, y: 0 }, role: "orchestrator" });
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals, { waitTiming: { checkMs: 5, settleMs: 10, quietMs: 60_000 } }));
  const child = await handler.execute(orchestrator.id, { id: "1", tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, prompt: "do part A" } });
  const wait = (timeoutSeconds) => handler.execute(orchestrator.id, { id: "w", tool: "wait_for_agent", arguments: { sessionId: child.sessionId, timeoutSeconds } });
  // OpenCode's session.created reports idle before the prompt's turn starts.
  terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "idle", event: "session.created" });
  const early = await wait(1);
  assert.deepEqual([early.reason, early.answer], ["timeout", undefined]);
  const waiting = wait(10);
  setTimeout(() => terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "working", event: "session.status:busy" }), 20);
  setTimeout(() => {
    terminals.applyProviderSignal(child.sessionId, { kind: "lifecycle", state: "idle", event: "session.idle" });
    terminals.recordAnswer(child.sessionId, { text: "part A done", truncated: false });
  }, 40);
  const done = await waiting;
  assert.equal(done.reason, "idle");
  assert.deepEqual(done.answer, { text: "part A done", truncated: false });
});
