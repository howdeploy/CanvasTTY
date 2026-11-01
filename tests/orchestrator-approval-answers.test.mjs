import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { controlRequest } from "../scripts/canvastty-control.mjs";
import { AgentControlService, APPROVAL_REFUSAL, DelegationRefusal } from "../src/main/services/AgentControlService.ts";
import { AgentControlGateway, PERSON_ANSWERS_REFUSAL, UNKNOWN_MENU_REFUSAL, codexApprovalPrompt, codexOrchestratorMenu } from "../src/main/services/agent-control/AgentControlGateway.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { OPENCODE_STARTUP_READY, availableRegistry, echoPromptInput, fakeSpawner } from "./helpers/terminal.mjs";

// An orchestrator never answers a subagent's approval or permission prompt: not with send_to_agent (MCP), and not with
// choose, dismiss or send on its own control connection. Those prompts are the person's (or a decision service's the
// person allowed, which answers before the CLI asks). Non-approval menus stay the orchestrator's, the person's own
// connection and the card's own input are unchanged.

const localSocket = { skip: process.platform === "win32" ? "Unix socket tests" : false };
const at = { x: 0, y: 0 };
const COMPOSER = "\x1b[2J\x1b[H>_ OpenAI Codex\r\nmodel: test\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[22m";
const APPROVAL = "\x1b[2J\x1b[HWould you like to run the following command?\r\n\r\n  $ rm -rf build\r\n\r\n"
  + "› 1. Yes, proceed (y)\r\n  2. Yes, and don't ask again for this command (p)\r\n"
  + "  3. No, and tell Codex what to do differently (esc)\r\n\r\nPress enter to confirm or esc to cancel";
const EDITS = "\x1b[2J\x1b[HWould you like to make the following edits?\r\n\r\n  src/a.ts (+1 -0)\r\n\r\n"
  + "› 1. Yes, proceed (y)\r\n  2. Yes, and don't ask again for these files (a)\r\n"
  + "  3. No, and tell Codex what to do differently (esc)\r\n\r\nPress enter to confirm or esc to cancel";
const HOOKS = "\x1b[2J\x1b[HHooks need review\r\n› 1. Review hooks\r\n  2. Trust all and continue\r\n  3. Continue without hooks\r\n"
  + "Press enter to confirm or esc to cancel";
// An approval worded in a way codexApprovalPrompt does not know (a newer Codex, another kind of request).
const UNKNOWN_APPROVAL = "\x1b[2J\x1b[HAllow Codex to open the browser on example.com?\r\n\r\n"
  + "› 1. Allow\r\n  2. Allow for this session\r\n  3. Deny\r\n\r\nPress enter to confirm or esc to cancel";
const TRUST = "\x1b[2J\x1b[HDo you trust the contents of this directory?\r\n› 1. Yes, continue\r\n  2. No, quit\r\nPress enter to continue";
const PERMISSIONS = "\x1b[2J\x1b[HUpdate Model Permissions\r\n› 1. Allow full access\r\n  2. Keep current permissions\r\nPress enter to confirm or esc to cancel";
const UPDATE = "\x1b[2J\x1b[HUpdate available! 0.200.0 -> 0.201.0\r\n› 1. Update now\r\n  2. Skip\r\n  3. Skip until next version\r\nPress enter to continue";
// The empty composers Claude Code and Kimi 2.x show, for a follow-up task's paste-then-submit delivery.
const CLAUDE_COMPOSER = "\x1b[2J\x1b[H❯ ";
const KIMI_COMPOSER = "\x1b[2J\x1b[HKimi Code 2.4.0\r\n╭──────────────────────╮\r\n│ >                    │\r\n╰──────────────────────╯\r\n\x1b[3;6H";
const MODEL = "\x1b[2J\x1b[HApproaching rate limits\r\nSwitch to a smaller model for lower credit usage?\r\n"
  + "› 1. Switch model\r\n  2. Keep current model\r\n  3. Keep current model (never show again)\r\nPress enter to confirm or esc to go back";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-no-approve-")));
  const userData = await realpath(await mkdtemp(join("/tmp", "ctty-no-approve-grant-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]));
  const project = join(root, "project");
  const inner = join(project, "src");
  await mkdir(inner, { recursive: true });
  const calls = [];
  const writes = new Map();
  let gateway;
  const terminals = new TerminalManager((channel, payload) => gateway?.observe(channel, payload), availableRegistry(), undefined, undefined, true,
    fakeSpawner(calls, { onWrite: (data, options) => {
      const call = calls.find((entry) => entry.options === options);
      if (call) writes.set(call, [...(writes.get(call) ?? []), data]);
    } }));
  const control = new AgentControlService(terminals, { waitTiming: { checkMs: 10, settleMs: 20, quietMs: 200 } });
  gateway = new AgentControlGateway({ userDataPath: userData, terminals, lifecycleEnabled: () => true,
    spawnSubagent: (request) => control.spawn(request) });
  const appConnection = await gateway.start();
  terminals.setControlConnection({ connectionPath: appConnection, cliPath: "/cli.mjs", grant: (id) => gateway.grantSession(id) });
  t.after(async () => { await gateway.close(); await terminals.shutdown(); });
  const orchestrator = terminals.create({ provider: "codex", profile: "auto", cwd: project, position: at, role: "orchestrator" });
  const connectionPath = calls.at(-1).options.env.CANVASTTY_CONTROL_CONNECTION;
  assert.ok(connectionPath && connectionPath !== appConnection, "the orchestrator has its own connection");
  const agentClient = join(dirname(connectionPath), "controller.json");
  const agent = (method, params = {}, requestId = randomUUID()) =>
    controlRequest({ connectionPath, clientPath: agentClient, method, params, requestId, timeoutMs: 10_000 });
  const person = (method, params = {}, requestId = randomUUID()) =>
    controlRequest({ connectionPath: appConnection, clientPath: join(userData, "person-client.json"), method, params, requestId, timeoutMs: 10_000 });
  // The card a create just launched (each launch spawns one PTY).
  const callOf = (id) => {
    const call = calls.at(-1);
    assert.equal(terminals.getMetadata(id)?.exitCode, null);
    return call;
  };
  const written = (call) => writes.get(call) ?? [];
  return { root, project, inner, terminals, control, gateway, orchestrator, calls, agent, person, callOf, written };
}

/** Prints a screen into the card and waits until its controller's view shows it. */
async function show(request, id, call, data, expected) {
  call.process.emitData(data);
  for (let i = 0; i < 60; i++) {
    const screen = await request("screen", { sessionId: id });
    if (screen.text.includes(expected)) return screen;
    await delay(5);
  }
  assert.fail(`the screen did not show ${expected}`);
}

const needsPerson = (error) => error.code === "NEEDS_PERSON" && error.message === PERSON_ANSWERS_REFUSAL;
const unknownMenu = (error) => error.code === "NEEDS_PERSON" && error.message === UNKNOWN_MENU_REFUSAL;

test("Codex's approval prompts are told apart from its other menus", () => {
  for (const screen of [APPROVAL, EDITS, "Would you like to grant these permissions?\n› 1. Yes\n  2. No",
    "Do you want to approve network access to \"example.com\"?\n› 1. Yes, just this once\n  2. No",
    "docs needs your approval.\n› 1. Yes, provide the requested info\n  2. No, but continue without it",
    "› 1. Yes, proceed (y)\n  2. No (esc)"]) {
    assert.equal(codexApprovalPrompt(screen), true, screen);
  }
  for (const screen of [HOOKS, MODEL, COMPOSER, "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit",
    "Update available!\n› 1. Update now\n  2. Skip\n  3. Skip until next version"]) {
    assert.equal(codexApprovalPrompt(screen), false, screen);
  }
  // What an orchestrator may resolve is a short list of known menus; anything else (recognised or not) is the person's.
  // The gateway passes the rendered screen, without control sequences.
  const plain = (screen) => screen.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "").replace(/\r/gu, "");
  for (const screen of [HOOKS, MODEL, UPDATE, "Hooks\n6 hooks reviewed\nPress esc to close"]) assert.equal(codexOrchestratorMenu(plain(screen)), true, screen);
  for (const screen of [APPROVAL, EDITS, UNKNOWN_APPROVAL, TRUST, PERMISSIONS, COMPOSER,
    "Hooks need review\n› 1. Yes, proceed (y)\n  2. No (esc)"]) {
    assert.equal(codexOrchestratorMenu(plain(screen)), false, screen);
  }
});

test("an orchestrator's control connection cannot choose, dismiss or type into a subagent's approval prompt; the person still answers it", localSocket, async (t) => {
  const f = await fixture(t);
  const created = await f.agent("create", { provider: "codex", cwd: f.inner });
  const id = created.session.id;
  assert.equal(f.terminals.getMetadata(id).parentSessionId, f.orchestrator.id);
  assert.equal(created.capabilities.menus, true);
  const call = f.callOf(id);
  echoPromptInput(call.process, "codex", COMPOSER);

  // A task the orchestrator legitimately sends, at an empty composer: its paste, then its submit key.
  f.terminals.applyProviderSignal(id, { kind: "lifecycle", state: "idle" });
  await show(f.agent, id, call, COMPOSER, "Ask Codex");
  await f.agent("send", { sessionId: id, text: "clean the build" });
  assert.deepEqual(f.written(call), ["\x1b[200~clean the build\x1b[201~", "\r"]);
  f.terminals.applyProviderSignal(id, { kind: "lifecycle", state: "working" });

  // Codex shows its approval prompt before its PermissionRequest hook's report arrived: the screen alone refuses.
  const early = await show(f.agent, id, call, APPROVAL, "Yes, proceed");
  assert.equal(early.interaction.options.length, 3, "the menu is still shown to the orchestrator");
  await assert.rejects(f.agent("choose", { sessionId: id, choice: 1, revision: early.interaction.revision }), needsPerson);
  await assert.rejects(f.agent("dismiss", { sessionId: id, revision: early.revision }), needsPerson);
  await assert.rejects(f.agent("send", { sessionId: id, text: "y" }), needsPerson, "text (and its Enter) would answer it too");
  // The hook's report: the card is needs_approval.
  f.terminals.applyProviderSignal(id, { kind: "lifecycle", state: "needs_approval" });
  const screen = await f.agent("screen", { sessionId: id });
  for (const choice of [1, 2, 3]) {
    await assert.rejects(f.agent("choose", { sessionId: id, choice, revision: screen.interaction.revision }), needsPerson, `choice ${choice}`);
  }
  await assert.rejects(f.agent("dismiss", { sessionId: id, revision: screen.revision }), needsPerson, "Escape is an answer too");
  await assert.rejects(f.agent("send", { sessionId: id, text: "y" }), needsPerson);
  // Not retryable: the same request id replays the refusal instead of writing.
  const again = randomUUID();
  await assert.rejects(f.agent("choose", { sessionId: id, choice: 1, revision: screen.interaction.revision }, again), needsPerson);
  await assert.rejects(f.agent("choose", { sessionId: id, choice: 1, revision: screen.interaction.revision }, again), needsPerson);
  assert.equal(f.written(call).length, 2, "nothing reached the prompt");
  // Reading stays open, and stopping its own turn is not an answer: the asked command does not run.
  assert.equal((await f.agent("status", { sessionId: id })).session.status, "needs_approval");
  await f.agent("interrupt", { sessionId: id });
  assert.deepEqual(f.written(call).slice(2), ["\x03"]);

  // The person answers in the card (its own input path), whatever the orchestrator was refused.
  f.terminals.input(id, "y");
  assert.deepEqual(f.written(call).slice(3), ["y"]);
  f.terminals.applyProviderSignal(id, { kind: "lifecycle", state: "working" });
  f.terminals.applyProviderSignal(id, { kind: "lifecycle", state: "idle", event: "Stop" });
  // Edits ask the same way.
  const edits = await show(f.agent, id, call, EDITS, "make the following edits");
  await assert.rejects(f.agent("choose", { sessionId: id, choice: 1, revision: edits.interaction.revision }), needsPerson);

  // An approval CanvasTTY does not recognise by its text: before the hook's report the screen is not a menu the
  // orchestrator may resolve, so it is refused anyway; after the report the status refuses it as well.
  const unknown = await show(f.agent, id, call, UNKNOWN_APPROVAL, "open the browser");
  await assert.rejects(f.agent("choose", { sessionId: id, choice: 1, revision: unknown.interaction.revision }), unknownMenu);
  await assert.rejects(f.agent("dismiss", { sessionId: id, revision: unknown.revision }), unknownMenu);
  f.terminals.applyProviderSignal(id, { kind: "lifecycle", state: "needs_approval" });
  for (const choice of [1, 2, 3]) {
    await assert.rejects(f.agent("choose", { sessionId: id, choice, revision: unknown.interaction.revision }), needsPerson, `choice ${choice}`);
  }
  await assert.rejects(f.agent("dismiss", { sessionId: id, revision: unknown.revision }), needsPerson);
  await assert.rejects(f.agent("send", { sessionId: id, text: "1" }), needsPerson);
  f.terminals.input(id, "3");
  f.terminals.applyProviderSignal(id, { kind: "lifecycle", state: "idle", event: "Stop" });
  // A permissions change and folder trust are the person's too.
  for (const [screen, expected] of [[PERMISSIONS, "Update Model Permissions"], [TRUST, "trust the contents"]]) {
    const menu = await show(f.agent, id, call, screen, expected);
    await assert.rejects(f.agent("choose", { sessionId: id, choice: 1, revision: menu.interaction.revision }),
      (error) => error.code === "NEEDS_PERSON", expected);
  }
  assert.deepEqual(f.written(call).slice(3), ["y", "3"], "only the person's answers reached the card");
});

test("an orchestrator still resolves menus that are not approvals, and the person's own connection still chooses approvals", localSocket, async (t) => {
  const f = await fixture(t);
  const { session } = await f.agent("create", { provider: "codex", cwd: f.inner });
  const call = f.callOf(session.id);
  echoPromptInput(call.process, "codex", COMPOSER);
  f.terminals.applyProviderSignal(session.id, { kind: "lifecycle", state: "idle" });
  const hooks = await show(f.agent, session.id, call, HOOKS, "Hooks need review");
  await f.agent("choose", { sessionId: session.id, choice: 3, revision: hooks.interaction.revision });
  const model = await show(f.agent, session.id, call, MODEL, "Approaching rate limits");
  await f.agent("choose", { sessionId: session.id, choice: 2, revision: model.interaction.revision });
  const notice = await show(f.agent, session.id, call, "\x1b[2J\x1b[HHooks\r\n6 hooks reviewed\r\nPress esc to close", "Press esc");
  await f.agent("dismiss", { sessionId: session.id, revision: notice.revision });
  const update = await show(f.agent, session.id, call, UPDATE, "Update available");
  await f.agent("choose", { sessionId: session.id, choice: 2, revision: update.interaction.revision });
  assert.deepEqual(f.written(call), ["\x1b[B\x1b[B\r", "\x1b[B\r", "\x1b", "\x1b[B\r"]);
  // A worker with no approval pending takes the orchestrator's task as before.
  await show(f.agent, session.id, call, COMPOSER, "Ask Codex");
  await f.agent("send", { sessionId: session.id, text: "next task" });
  assert.deepEqual(f.written(call).slice(4), ["\x1b[200~next task\x1b[201~", "\r"]);

  // The person's own automation (the app-wide connection) is the person: its worker's approval prompt is its to choose.
  const own = await f.person("create", { provider: "codex", profile: "normal", cwd: f.inner, title: "Person's worker" });
  const ownCall = f.callOf(own.session.id);
  f.terminals.applyProviderSignal(own.session.id, { kind: "lifecycle", state: "needs_approval" });
  const approval = await show(f.person, own.session.id, ownCall, APPROVAL, "Yes, proceed");
  await f.person("choose", { sessionId: own.session.id, choice: 3, revision: approval.interaction.revision });
  assert.deepEqual(f.written(ownCall), ["\x1b[B\x1b[B\r"]);
  // And the orchestrator cannot reach the person's worker at all.
  await assert.rejects(f.agent("choose", { sessionId: own.session.id, choice: 1, revision: approval.interaction.revision }),
    (error) => error.code === "SESSION_NOT_FOUND");
});

test("send_to_agent is refused at every CLI's approval or permission prompt and allowed once the person answered", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-no-approve-send-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const writes = new Map();
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls, {
    onWrite: (data, options) => writes.set(options, [...(writes.get(options) ?? []), data])
  }));
  t.after(() => terminals.shutdown());
  const control = new AgentControlService(terminals);
  const orchestrator = terminals.create({ provider: "claude", profile: "normal", cwd: root, position: at, role: "orchestrator" });
  calls.forEach((entry) => { entry.claimed = true; });
  // Each maps its CLI's own approval signal to needs_approval: Claude Code, Codex, Qwen and Kimi PermissionRequest,
  // Grok's permission_prompt notification, Hermes pre_approval_request, OpenCode permission.asked and question.asked.
  for (const provider of ["claude", "codex", "grok", "kimi", "qwen", "hermes", "opencode"]) {
    const child = terminals.create({ provider, profile: "normal", cwd: root, position: at, role: "subagent", parentSessionId: orchestrator.id });
    if (provider === "grok") terminals.resize(child.id, 80, 24); // Grok starts with the renderer-measured grid.
    let call;
    for (let i = 0; i < 100 && !call; i++) {
      call = calls.find((entry) => entry.options.cwd === root && JSON.stringify([entry.command, entry.args]).includes(`/resolved/${provider}`) && !entry.claimed);
      if (!call) await delay(5);
    }
    assert.ok(call, `${provider}: launched`);
    call.claimed = true;
    terminals.applyProviderSignal(child.id, { kind: "lifecycle", state: "needs_approval" });
    for (const prompt of ["y", "1", "allow", "yes, and don't ask again"]) {
      assert.throws(() => control.send(child.id, prompt), (error) => error instanceof DelegationRefusal && error.message === APPROVAL_REFUSAL, `${provider}: ${prompt}`);
      assert.throws(() => control.send(child.id, prompt, false), DelegationRefusal, `${provider}: ${prompt} without Enter`);
    }
    assert.deepEqual(writes.get(call.options) ?? [], [], `${provider}: nothing reached its prompt`);
    // The person answers in the card; the subagent works and finishes its turn.
    terminals.input(child.id, "1");
    terminals.applyProviderSignal(child.id, { kind: "lifecycle", state: "working" });
    terminals.applyProviderSignal(child.id, { kind: "lifecycle", state: "idle", event: "Stop" });
    // Codex, Claude and Kimi take a pasted task and a separate submit key once their composer shows it.
    const composer = { codex: COMPOSER, claude: CLAUDE_COMPOSER, kimi: KIMI_COMPOSER }[provider];
    if (composer) {
      echoPromptInput(call.process, provider, composer);
      call.process.emitData(composer);
    }
    if (provider === "opencode") call.process.emitData(OPENCODE_STARTUP_READY);
    await control.send(child.id, "next task");
    const sent = writes.get(call.options);
    assert.equal(sent?.[0], "1", `${provider}: the person's answer`);
    assert.deepEqual(sent.slice(1), composer ? ["\x1b[200~next task\x1b[201~", "\r"] : ["next task\r"],
      `${provider}: the orchestrator's next task once the person answered`);
  }
});
