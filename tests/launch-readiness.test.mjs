/**
 * Input for an agent whose launch is still being prepared (launch options, a launch policy, an environment): the
 * initial prompt of spawn_agent, send_to_agent, plugin sessions.send and the control CLI. Text reaches the PTY
 * exactly once, only after that launch started; a refused, cancelled or superseded launch is never reported as a
 * delivery, and queued text never reaches a later restart. No real CLI runs; HOME is the runner's fake one.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { controlRequest } from "../scripts/canvastty-control.mjs";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlGateway } from "../src/main/services/agent-control/AgentControlGateway.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";

const at = { x: 0, y: 0 };
const cwd = process.cwd();
const localSocket = { skip: process.platform === "win32" ? "Unix socket test" : false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function clis() {
  return {
    get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native",
      environment: { PATH: "/usr/bin" }, checked: [] }),
    snapshot: () => ({})
  };
}

function spawner(calls, readiness) {
  return (command, args, options) => {
    const exits = [];
    const call = { command, args, options, written: [], exit: (code) => exits.forEach((listener) => listener({ exitCode: code })) };
    calls.push(call);
    return {
      pid: 60_000 + calls.length, process: command, write(text) { call.written.push(text); }, resize() {}, kill() {}, pause() {}, resume() {},
      onData(listener) {
        call.data = listener;
        if (command === "/resolved/codex" && readiness.auto) queueMicrotask(() => listener("\x1b[2J\x1b[H>_ OpenAI Codex\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m\r\n"));
        return { dispose() {} };
      },
      onExit(listener) { exits.push(listener); return { dispose() {} }; }
    };
  };
}

/**
 * A launch pipeline whose answers the test releases: `p.accounts` is a launch option, `p.policy` a launch policy for
 * Codex only. Each prepare call waits on a deferred answer in `pending`.
 */
async function fixture(t) {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-readiness-runs-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const pending = [];
  const pipeline = new LaunchPipeline({
    contributors: () => [
      { pluginId: "p.accounts", pluginName: "Accounts", serviceId: "svc", secrets: false,
        launch: { fields: [{ key: "on", label: "On", kind: "boolean", default: true }], delegable: true } },
      { pluginId: "p.policy", pluginName: "Policy", serviceId: "svc", secrets: false, launch: { policy: true, appliesTo: ["codex"], fields: [] } }
    ],
    call: (pluginId, _serviceId, _method, params) => new Promise((resolve) => pending.push({ pluginId, params, answer: resolve })),
    secret: async () => null,
    runsRoot,
    timeoutMs: 5_000
  });
  const calls = [];
  const readiness = { auto: true };
  let sessions;
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload), clis(), undefined, undefined, true, spawner(calls, readiness));
  t.after(() => terminals.shutdown());
  terminals.configureLaunchPipeline(pipeline);
  const control = new AgentControlService(terminals);
  const handler = new ScopedOrchestrationHandler(control);
  const orchestrator = terminals.create({ provider: "claude", profile: "normal", cwd, position: at, role: "orchestrator" });
  assert.equal(calls.length, 1, "the orchestrator itself starts at once");
  const execute = (tool, args) => handler.execute(orchestrator.id, { tool, arguments: args });
  const answerNext = async (answer) => {
    for (let i = 0; i < 100 && pending.length === 0; i++) await tick();
    const next = pending.shift();
    assert.ok(next, "a prepare request is waiting");
    next.answer(answer);
    return next;
  };
  return {
    terminals, control, handler, calls, pending, orchestrator, execute, answerNext, readiness,
    attachSessions: (value) => { sessions = value; }
  };
}

/** A promise's state without waiting for it. */
async function state(promise) {
  const marker = Symbol("pending");
  const settled = await Promise.race([promise.then(() => "resolved", () => "rejected"), new Promise((resolve) => setTimeout(() => resolve(marker), 30))]);
  return settled === marker ? "pending" : settled;
}

test("spawn_agent with launchOptions and a prompt: the prompt reaches the PTY once, after the plugin prepared the launch", async (t) => {
  const f = await fixture(t);
  const spawned = f.execute("spawn_agent", { provider: "claude", cwd, prompt: "Fix the Button test", launchOptions: { "p.accounts": { on: true } } });
  assert.equal(await state(spawned), "pending", "no answer before the launch is ready");
  const children = () => f.control.children(f.orchestrator.id);
  assert.equal(children().length, 1);
  const childId = children()[0].id;
  assert.equal(f.calls.length, 1, "nothing spawned while the plugin prepares");
  await f.answerNext(null);
  const result = await spawned;
  assert.equal(result.sessionId, childId);
  const child = f.calls[1];
  assert.deepEqual(child.written, ["Fix the Button test\r"], "exactly once");

  // A later restart of the same card gets nothing queued from the first launch.
  child.exit(0);
  f.terminals.restart(childId);
  await f.answerNext(null);
  for (let i = 0; i < 50 && f.calls.length < 3; i++) await tick();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[2].written, []);
  assert.deepEqual(child.written, ["Fix the Button test\r"]);
});

test("a launch policy alone (no launch options) also delays delivery; send_to_agent waits the same way", async (t) => {
  const f = await fixture(t);
  const spawned = f.execute("spawn_agent", { provider: "codex", cwd, prompt: "Review the diff" });
  const childId = f.control.children(f.orchestrator.id)[0].id;
  assert.equal(await state(spawned), "pending");
  // send_to_agent while the same launch is still pending: queued behind the first prompt, delivered in order.
  const sent = f.execute("send_to_agent", { sessionId: childId, prompt: "and the tests" });
  assert.equal(await state(sent), "pending");
  const policy = await f.answerNext(null);
  assert.equal(policy.pluginId, "p.policy");
  assert.equal(policy.params.chosen, false);
  await spawned;
  assert.deepEqual(await sent, { sessionId: childId, sent: true });
  assert.deepEqual(f.calls[1].written, ["\x1b[200~Review the diff\x1b[201~\r", "\x1b[200~and the tests\x1b[201~\r"]);
});

test("a refused launch is not a delivery: spawn_agent and send_to_agent fail with the reason and nothing is written later", async (t) => {
  const f = await fixture(t);
  const spawned = f.execute("spawn_agent", { provider: "claude", cwd, prompt: "Secret plan", launchOptions: { "p.accounts": { on: true } } });
  const childId = f.control.children(f.orchestrator.id)[0].id;
  await f.answerNext({ refuse: { reason: "account locked" } });
  await assert.rejects(spawned, (error) => {
    assert.equal(error.bridgeError?.code, "INVALID_REQUEST");
    assert.match(error.bridgeError.message, /was not delivered/u);
    assert.match(error.bridgeError.message, /account locked/u);
    assert.ok(error.bridgeError.message.includes(childId), "the caller learns which card it was");
    return true;
  });
  assert.equal(f.calls.length, 1, "nothing spawned");
  await assert.rejects(f.execute("send_to_agent", { sessionId: childId, prompt: "again" }), /exited/u);

  // The person restarts it and the plugin now agrees: the new process gets nothing from the refused launch.
  f.terminals.restart(childId);
  await f.answerNext(null);
  for (let i = 0; i < 50 && f.calls.length < 2; i++) await tick();
  assert.equal(f.calls.length, 2);
  await tick();
  assert.deepEqual(f.calls[1].written, []);
});

test("cancelled before it was ready: the prompt is dropped, never written to a late launch", async (t) => {
  const f = await fixture(t);
  const spawned = f.execute("spawn_agent", { provider: "claude", cwd, prompt: "Never", launchOptions: { "p.accounts": { on: true } } });
  const childId = f.control.children(f.orchestrator.id)[0].id;
  for (let i = 0; i < 50 && f.pending.length === 0; i++) await tick();
  assert.deepEqual(await f.execute("cancel_agent", { sessionId: childId }), { sessionId: childId, canceled: true });
  await assert.rejects(spawned, /not delivered: The session was closed before it started/u);
  await f.answerNext(null);
  await tick();
  assert.equal(f.calls.length, 1, "the late answer starts nothing");
});

test("plugin sessions.send waits for the prepared launch and reports a refused one as not sent", async (t) => {
  const f = await fixture(t);
  const sessions = new PluginSessions({ terminals: f.terminals, notify: () => true });
  f.attachSessions(sessions);
  const permissions = ["sessions:launch", "sessions:control"];
  const { sessionId } = sessions.handle("p.owner", "svc", "sessions.create",
    { provider: "claude", cwd, launchOptions: { "p.accounts": { on: true } } }, permissions);
  const sent = sessions.handle("p.owner", "svc", "sessions.send", { sessionId, text: "hello" }, permissions);
  assert.equal(await state(Promise.resolve(sent)), "pending");
  await f.answerNext(null);
  assert.deepEqual(await sent, { sessionId, sent: true });
  assert.deepEqual(f.calls[1].written, ["hello\r"]);

  const second = sessions.handle("p.owner", "svc", "sessions.create",
    { provider: "claude", cwd, launchOptions: { "p.accounts": { on: true } } }, permissions);
  const refused = sessions.handle("p.owner", "svc", "sessions.send", { sessionId: second.sessionId, text: "hello" }, permissions);
  await f.answerNext({ refuse: { reason: "no" } });
  assert.deepEqual(await refused, { sessionId: second.sessionId, sent: false });
});

test("the control CLI says a starting session is not ready instead of claiming the terminal exited", localSocket, async (t) => {
  const f = await fixture(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-readiness-control-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = new AgentControlGateway({ userDataPath: root, terminals: f.terminals, lifecycleEnabled: () => true });
  const connectionPath = await gateway.start();
  t.after(() => gateway.close());
  const request = (method, params = {}) => controlRequest({ connectionPath, clientPath: join(root, "client.json"), method, params, requestId: randomUUID() });
  // Codex has a launch policy here, so its card waits for the policy's answer.
  const { session } = await request("create", { provider: "codex", profile: "normal", cwd: root, title: "Worker" });
  await assert.rejects(request("send", { sessionId: session.id, text: "task" }), (error) => {
    assert.equal(error.code, "NOT_READY");
    assert.match(error.message, /still starting/u);
    return true;
  });
  await f.answerNext(null);
  for (let i = 0; i < 50 && f.calls.length < 2; i++) await tick();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].written, [], "the refused send was not queued");
});


test("a prompt queued during a prepared restart cannot use the previous Codex composer's readiness", async (t) => {
  const f = await fixture(t);
  const spawned = f.execute("spawn_agent", { provider: "codex", cwd, prompt: "first task" });
  await f.answerNext(null);
  const child = await spawned;
  f.calls.at(-1).exit(0);
  f.readiness.auto = false;
  f.terminals.restart(child.sessionId);
  const sent = f.execute("send_to_agent", { sessionId: child.sessionId, prompt: "next task" });
  await f.answerNext(null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.calls.at(-1).written, [], "a ready screen from the old process cannot release new input");
  f.calls.at(-1).data("\x1b[2J\x1b[H>_ OpenAI Codex\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m\r\n");
  await sent;
  assert.deepEqual(f.calls.at(-1).written, ["\x1b[200~next task\x1b[201~\r"]);
});
