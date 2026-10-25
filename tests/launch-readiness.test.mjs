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
import { INPUT_READY_HOOK_GRACE_MS, TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlGateway } from "../src/main/services/agent-control/AgentControlGateway.ts";
import { AGENT_TOOL_DELIVERY_MS, ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";

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


test("plugin Codex sends wait beyond PTY creation and bracket multiline tasks and drafts", async (t) => {
  const f=await fixture(t);f.readiness.auto=false;
  const sessions=new PluginSessions({terminals:f.terminals,notify:()=>true});f.attachSessions(sessions);
  const permissions=["sessions:launch","sessions:control"];
  const {sessionId}=sessions.handle("p.owner","svc","sessions.create",{provider:"codex",cwd},permissions);
  const text="First line\nSecond line";
  const sending=sessions.handle("p.owner","svc","sessions.send",{sessionId,text},permissions);
  await f.answerNext(null);
  for(let i=0;i<50&&f.calls.length<2;i++)await tick();
  const call=f.calls[1];assert.ok(call);
  call.data("Press enter to confirm trust\r\n");
  assert.equal(await state(sending),"pending");assert.deepEqual(call.written,[]);
  call.data("\x1b[2J\x1b[H› \x1b[2mAsk Codex to do anything\x1b[22m\r\n");
  assert.deepEqual(await sending,{sessionId,sent:true});
  assert.deepEqual(call.written,[`\x1b[200~${text}\x1b[201~\r`]);
  await sessions.handle("p.owner","svc","sessions.send",{sessionId,text:"draft",submit:false},permissions);
  assert.equal(call.written.at(-1),"\x1b[200~draft\x1b[201~");
});

// OpenCode drops every key that arrives while its full-screen view starts, so a prompt typed when its PTY exists is
// lost and the agent sits at an empty prompt. Its prompt goes in only once its input field is up: a lifecycle hook,
// or the control sequence that shows its text cursor on the alternate screen (never its human-readable screen text).

const ALT_SCREEN_HIDDEN_CURSOR = "\x1b[?1049h\x1b[?2004h\x1b[?25l";
const CURSOR_SHOWN = "\x1b[1 q\x1b[?25h";

/**
 * A slow-starting OpenCode stand-in: it draws its start-up for `startupMs` with the cursor hidden and drops every key
 * written meanwhile (as OpenCode does), then shows its input field. `accepted` holds what reached that field.
 */
function slowOpenCode({ startupMs = 120, ready = true } = {}) {
  const runs = [];
  const spawn = () => {
    let emit = () => undefined;
    const exits = [];
    const run = { written: [], accepted: [], dropped: [], ready: false, exit: (code) => exits.forEach((listener) => listener({ exitCode: code })) };
    runs.push(run);
    setTimeout(() => emit(ALT_SCREEN_HIDDEN_CURSOR), 5);
    setTimeout(() => emit("  Ask anything… \"Fix broken tests\"   tab agents  ctrl+p commands"), startupMs / 2);
    if (ready) setTimeout(() => { run.ready = true; emit(CURSOR_SHOWN); }, startupMs);
    return {
      pid: 70_000 + runs.length, process: "opencode", resize() {}, kill() {}, pause() {}, resume() {},
      write(text) { run.written.push(text); (run.ready ? run.accepted : run.dropped).push(text); },
      onData(listener) { emit = listener; return { dispose() {} }; },
      onExit(listener) { exits.push(listener); return { dispose() {} }; }
    };
  };
  return { runs, spawn };
}

function slowOpenCodeOrchestration(t, options) {
  const cli = slowOpenCode(options);
  let orchestratorStarted = false;
  const terminals = new TerminalManager(() => {}, clis(), undefined, undefined, true, (...args) => {
    if (!orchestratorStarted) { orchestratorStarted = true; return spawner([], { auto: false })(...args); }
    return cli.spawn(...args);
  });
  t.after(() => terminals.disposeAll());
  const control = new AgentControlService(terminals);
  const handler = new ScopedOrchestrationHandler(control);
  const orchestrator = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  return { cli, terminals, control, execute: (tool, args) => handler.execute(orchestrator.id, { tool, arguments: args }) };
}

test("spawn_agent: a slow-starting OpenCode gets its first prompt once its input field is up, exactly once", async (t) => {
  const f = slowOpenCodeOrchestration(t, { startupMs: 150 });
  const spawned = f.execute("spawn_agent", { provider: "opencode", cwd, prompt: "do part A" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await state(spawned), "pending", "the PTY exists and the home screen text is drawn, but the field is not up");
  assert.deepEqual(f.cli.runs[0].written, []);
  const result = await spawned;
  assert.equal(typeof result.sessionId, "string");
  assert.deepEqual(f.cli.runs[0].accepted, ["do part A\r"], "the prompt reached the input field");
  assert.deepEqual(f.cli.runs[0].dropped, [], "nothing was typed while OpenCode started");

  // send_to_agent to the running card goes in at once.
  assert.deepEqual(await f.execute("send_to_agent", { sessionId: result.sessionId, prompt: "now part B" }), { sessionId: result.sessionId, sent: true });
  assert.deepEqual(f.cli.runs[0].accepted, ["do part A\r", "now part B\r"]);
});

test("spawn_agent: an OpenCode that exits before its input field is up fails the call with the reason", async (t) => {
  const f = slowOpenCodeOrchestration(t, { ready: false });
  const spawned = f.execute("spawn_agent", { provider: "opencode", cwd, prompt: "never typed" });
  await tick();
  f.cli.runs[0].exit(1);
  await assert.rejects(spawned, (error) => {
    assert.match(error.bridgeError?.message ?? "", /was not delivered: The session/u);
    return true;
  });
  assert.deepEqual(f.cli.runs[0].written, []);
});

test("OpenCode that never shows its input field gets no prompt and a bounded reason", async (t) => {
  const cli = slowOpenCode({ ready: false });
  const terminals = new TerminalManager(() => {}, clis(), undefined, undefined, true, cli.spawn);
  t.after(() => terminals.disposeAll());
  const session = terminals.create({ provider: "opencode", profile: "normal", cwd, position: at });
  const started = Date.now();
  const result = await terminals.deliverInput(session.id, "never\r", 200);
  assert.equal(result.delivered, false);
  assert.match(result.reason, /did not show its input field within 200 ms; nothing was typed/u);
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(cli.runs[0].written, [], "its home screen text alone is not readiness");
});

test("OpenCode readiness: a cursor shown before the alternate screen does not count; one cut across chunks does", async (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => {}, clis(), undefined, undefined, true, (command, args, options) => {
    const pty = spawner(calls, { auto: false })(command, args, options);
    return { ...pty, onData(listener) { calls.at(-1).emit = listener; return { dispose() {} }; } };
  });
  t.after(() => terminals.disposeAll());
  const session = terminals.create({ provider: "opencode", profile: "normal", cwd, position: at });
  const pending = terminals.deliverInput(session.id, "split\r", 2_000);
  calls[0].emit("\x1b[?25h");
  calls[0].emit("\x1b[?104");
  calls[0].emit("9h\x1b[?25l drawing");
  await tick();
  assert.deepEqual(calls[0].written, []);
  calls[0].emit("\x1b[?2");
  await tick();
  assert.deepEqual(calls[0].written, []);
  calls[0].emit("5h");
  assert.deepEqual(await pending, { delivered: true });
  assert.deepEqual(calls[0].written, ["split\r"]);
});

test("OpenCode readiness: a lifecycle hook counts only after a grace, and sends made while it starts arrive in order", async (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => {}, clis(), undefined, undefined, true, spawner(calls, { auto: false }));
  t.after(() => terminals.disposeAll());
  const session = terminals.create({ provider: "opencode", profile: "normal", cwd, position: at });
  const first = terminals.deliverInput(session.id, "first\r", INPUT_READY_HOOK_GRACE_MS + 2_000);
  const second = terminals.deliverInput(session.id, "second\r", INPUT_READY_HOOK_GRACE_MS + 2_000);
  await tick();
  assert.deepEqual(calls[0].written, []);
  const hookAt = Date.now();
  terminals.applyProviderSignal(session.id, { kind: "lifecycle", state: "idle", event: "session.created" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(calls[0].written, [], "a hook alone is not the input field");
  assert.deepEqual([await first, await second], [{ delivered: true }, { delivered: true }]);
  assert.ok(Date.now() - hookAt >= INPUT_READY_HOOK_GRACE_MS - 20, "typed only after the grace");
  assert.deepEqual(calls[0].written, ["first\r", "second\r"]);
});

test("OpenCode readiness: a resumed card whose plugin reports before its input field is up gets the text on the cursor signal", async (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => {}, clis(), undefined, undefined, true, (command, args, options) => {
    const pty = spawner(calls, { auto: false })(command, args, options);
    return { ...pty, onData(listener) { calls.at(-1).emit = listener; return { dispose() {} }; } };
  });
  t.after(() => terminals.disposeAll());
  const session = terminals.create({ provider: "opencode", profile: "normal", cwd, position: at });
  calls[0].emit("\x1b[?1049h\x1b[?25l");
  // The plugin reports idle on session.updated about 0.6 s before typed keys reach the prompt.
  terminals.applyProviderSignal(session.id, { kind: "lifecycle", state: "idle", event: "session.updated" });
  const sent = terminals.deliverInput(session.id, "resumed\r", 5_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(calls[0].written, [], "not typed on the hook");
  const shownAt = Date.now();
  calls[0].emit("\x1b[?25h");
  assert.deepEqual(await sent, { delivered: true });
  assert.ok(Date.now() - shownAt < INPUT_READY_HOOK_GRACE_MS / 2, "typed on the cursor signal, not after the grace");
  assert.deepEqual(calls[0].written, ["resumed\r"]);
});

test("OpenCode readiness: a send cancelled while it waits behind another settles at once and is never typed", async (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => {}, clis(), undefined, undefined, true, (command, args, options) => {
    const pty = spawner(calls, { auto: false })(command, args, options);
    return { ...pty, onData(listener) { calls.at(-1).emit = listener; return { dispose() {} }; } };
  });
  t.after(() => terminals.disposeAll());
  const session = terminals.create({ provider: "opencode", profile: "normal", cwd, position: at });
  const first = terminals.deliverInput(session.id, "first\r", 5_000);
  const controller = new AbortController();
  const queued = terminals.deliverInput(session.id, "queued\r", 5_000, controller.signal);
  const third = terminals.deliverInput(session.id, "third\r", 5_000);
  await tick();
  const abortedAt = Date.now();
  controller.abort();
  assert.deepEqual(await queued, { delivered: false, reason: "The delivery was cancelled." });
  assert.ok(Date.now() - abortedAt < 200, "settled without waiting for the send ahead of it");
  calls[0].emit("\x1b[?1049h\x1b[?25h");
  assert.deepEqual([await first, await third], [{ delivered: true }, { delivered: true }]);
  assert.deepEqual(calls[0].written, ["first\r", "third\r"]);
});

test("OpenCode readiness is not awaited on Windows, whose pseudo console may not pass the cursor sequences", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const calls = [];
  const terminals = new TerminalManager(() => {}, clis(), undefined, undefined, true, spawner(calls, { auto: false }));
  t.after(() => terminals.disposeAll());
  const session = terminals.create({ provider: "opencode", profile: "normal", cwd, position: at });
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    assert.deepEqual(await terminals.deliverInput(session.id, "windows\r", 200), { delivered: true });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  assert.deepEqual(calls[0].written, ["windows\r"]);
});

test("spawn_agent and send_to_agent wait for delivery within a budget under the MCP client's deadline", async (t) => {
  assert.ok(AGENT_TOOL_DELIVERY_MS <= 45_000);
  const f = slowOpenCodeOrchestration(t, { ready: false });
  const waits = [];
  const { control } = f;
  const spawn = control.spawn.bind(control);
  control.spawn = (request, signal, promptWaitMs) => { waits.push(["spawn", promptWaitMs]); return spawn(request, signal, 150); };
  const send = control.send.bind(control);
  control.send = (id, text, submit, signal, waitMs) => { waits.push(["send", waitMs]); return send(id, text, submit, signal, 150); };
  await assert.rejects(f.execute("spawn_agent", { provider: "opencode", cwd, prompt: "late" }), (error) => {
    assert.match(error.bridgeError?.message ?? "", /did not show its input field within 150 ms; nothing was typed/u);
    return true;
  });
  const [child] = f.terminals.listMetadata().filter((session) => session.role === "subagent");
  await assert.rejects(f.execute("send_to_agent", { sessionId: child.id, prompt: "again" }));
  assert.equal(waits[0][0], "spawn");
  assert.ok(waits[0][1] > 0 && waits[0][1] <= AGENT_TOOL_DELIVERY_MS, String(waits[0][1]));
  assert.deepEqual(waits[1], ["send", AGENT_TOOL_DELIVERY_MS]);
});

test("OpenCode readiness: cancellation and a restart while it starts never deliver the queued text", async (t) => {
  const cli = slowOpenCode({ startupMs: 80 });
  const terminals = new TerminalManager(() => {}, clis(), undefined, undefined, true, cli.spawn);
  t.after(() => terminals.disposeAll());
  const session = terminals.create({ provider: "opencode", profile: "normal", cwd, position: at });
  const controller = new AbortController();
  const canceled = terminals.deliverInput(session.id, "cancel\r", 2_000, controller.signal);
  const replaced = terminals.deliverInput(session.id, "old launch\r", 2_000);
  controller.abort();
  assert.deepEqual(await canceled, { delivered: false, reason: "The delivery was cancelled." });
  cli.runs[0].exit(0);
  terminals.restart(session.id);
  assert.equal((await replaced).delivered, false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(cli.runs[1].ready, "the new launch became ready");
  assert.ok(cli.runs.every((run) => run.written.length === 0), "neither launch got the text");
});

test("Claude and Codex still get input as soon as their PTY exists", async (t) => {
  const calls = [];
  const terminals = new TerminalManager(() => {}, clis(), undefined, undefined, true, spawner(calls, { auto: false }));
  t.after(() => terminals.disposeAll());
  for (const provider of ["claude", "codex"]) {
    const session = terminals.create({ provider, profile: "normal", cwd, position: at });
    assert.deepEqual(await terminals.deliverInput(session.id, `${provider} task\r`, 200), { delivered: true });
  }
  assert.deepEqual(calls.map((call) => call.written), [["claude task\r"], ["codex task\r"]]);
});
