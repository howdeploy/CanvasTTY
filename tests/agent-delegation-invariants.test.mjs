import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { controlRequest, runCli } from "../scripts/canvastty-control.mjs";
import { ORCHESTRATION_TOOL_NAMES } from "../src/agent-browser/orchestration-catalog.mjs";
import { AgentControlService, subagentFolder } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { AgentControlGateway } from "../src/main/services/agent-control/AgentControlGateway.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { PixelSkinPackRegistry } from "../src/main/services/PixelSkinPackRegistry.ts";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const localSocket = { skip: process.platform === "win32" ? "Unix socket tests" : false };
const at = { x: 0, y: 0 };

async function folders(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctty-delegation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A Cyrillic project folder stored in NFD, as Finder makes it.
  const project = join(root, "Проект-й".normalize("NFD"));
  const inner = join(project, "src");
  const other = join(root, "other-project");
  await Promise.all([mkdir(inner, { recursive: true }), mkdir(other)]);
  return { root, project, inner, other };
}

function managerWith(t, options = {}) {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.shutdown());
  if (options.isolation) terminals.configureIsolation(options.isolation);
  if (options.acknowledged) terminals.configureYoloAcknowledgement((provider) => options.acknowledged.includes(provider));
  return { terminals, calls };
}

test("a subagent's folder is its orchestrator's project or inside it: /, HOME and other projects are refused", async (t) => {
  const { project, inner, other } = await folders(t);
  const nfc = project.normalize("NFC");
  assert.deepEqual(subagentFolder(project, project, inner), { cwd: inner });
  assert.deepEqual(subagentFolder(project, project, "src"), { cwd: inner }, "relative to the orchestrator's folder");
  assert.equal(subagentFolder(project, project, join(nfc, "src")).cwd, inner, "the NFC spelling names the same NFD folder");
  assert.equal(subagentFolder(nfc, nfc, inner).cwd, inner, "and the other way round");
  for (const outside of ["/", homedir(), other, join(project, ".."), join(inner, "..", "..")]) {
    const refused = subagentFolder(project, project, outside);
    assert.match(refused.error, /only inside this project's folder .* Only the person can start an agent in another folder/u, outside);
  }
  assert.match(subagentFolder(project, project, join(project, "missing")).error, /does not exist/u);
  // Unless the person launched the orchestrator there: then that folder is the project. The file system root of the
  // temporary folder: "/" on macOS and Linux, its drive (C:\) on Windows, where "/" means the current drive.
  const fsRoot = parse(tmpdir()).root;
  assert.deepEqual(subagentFolder(fsRoot, fsRoot, tmpdir()).cwd, await realpath(tmpdir()));
});

test("spawn_agent: folder, depth and live-count limits refuse with a reason the orchestrator can act on", async (t) => {
  const { project, inner, other } = await folders(t);
  const { terminals } = managerWith(t);
  let limits = { maxDepth: 2, maxSubagents: 3 };
  const control = new AgentControlService(terminals, { limits: () => limits });
  const handler = new ScopedOrchestrationHandler(control);
  const orchestrator = terminals.create({ provider: "codex", profile: "auto", cwd: project, position: at, role: "orchestrator" });
  const spawn = (args) => handler.execute(orchestrator.id, { id: randomUUID(), tool: "spawn_agent", arguments: { provider: "opencode", cwd: inner, ...args } });
  const refused = (pattern) => (error) => error.bridgeError?.code === "INVALID_REQUEST" && error.bridgeError.retryable === false && pattern.test(error.message);
  await assert.rejects(spawn({ cwd: "/" }), refused(/only inside this project's folder/u));
  await assert.rejects(spawn({ cwd: homedir() }), refused(/only inside this project's folder/u));
  await assert.rejects(spawn({ cwd: other }), refused(/only inside this project's folder/u));
  const first = await spawn({});
  assert.equal(terminals.getMetadata(first.sessionId).cwd, inner);
  // Depth: the orchestrator's children are level 1, theirs level 2; level 3 is over the default limit.
  const level2 = await control.spawn({ parentSessionId: first.sessionId, provider: "opencode", cwd: inner });
  await assert.rejects(Promise.resolve().then(() => control.spawn({ parentSessionId: level2.id, provider: "opencode", cwd: inner })),
    /nest at most 2 levels deep .* would be level 3/u);
  limits = { maxDepth: 1, maxSubagents: 3 };
  await assert.rejects(Promise.resolve().then(() => control.spawn({ parentSessionId: first.sessionId, provider: "opencode", cwd: inner })),
    /nest at most 1 level deep/u);
  // Live count: all levels together, exited ones do not count.
  limits = { maxDepth: 2, maxSubagents: 3 };
  await spawn({});
  await assert.rejects(spawn({}), refused(/already runs 3 live subagents, its limit \(Settings → Agents, set by the person\)/u));
  terminals.dispose(level2.id);
  await spawn({});
});

test("spawn_agent cancelled before or while the subagent starts leaves no card and no launch behind", async (t) => {
  const { project, inner } = await folders(t);
  // A launch policy that has not answered yet: the new agent is still starting meanwhile.
  const answers = [];
  const pipeline = {
    hasPolicy: () => true,
    normalizeOptions: (_provider, options) => options,
    unavailable: () => [],
    forgetSession: async () => undefined,
    prepare: () => new Promise((resolve) => answers.push(resolve))
  };
  const { terminals, calls } = managerWith(t);
  const control = new AgentControlService(terminals);
  const handler = new ScopedOrchestrationHandler(control);
  const orchestrator = terminals.create({ provider: "codex", profile: "auto", cwd: project, position: at, role: "orchestrator" });
  terminals.configureLaunchPipeline(pipeline);
  const launches = calls.length;
  const children = () => terminals.list().filter((session) => session.parentSessionId === orchestrator.id);
  const spawn = (signal) => handler.execute(orchestrator.id, { id: randomUUID(), tool: "spawn_agent", arguments: { provider: "opencode", cwd: inner, prompt: "go" } }, signal);
  const canceled = (error) => error.bridgeError?.code === "CANCELED";
  await assert.rejects(spawn(AbortSignal.abort()), canceled);
  assert.equal(calls.length, launches, "nothing launched for a call already cancelled");
  assert.deepEqual(children(), []);
  // Cancelled while its prompt waits for the new agent to start: the card is closed, not left running.
  const controller = new AbortController();
  const pending = spawn(controller.signal);
  for (let i = 0; i < 200 && answers.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(children().length, 1, "starting");
  controller.abort();
  await assert.rejects(pending, canceled);
  assert.deepEqual(children(), [], "its card was closed");
});

test("concurrent environment resolutions cannot exceed the live subagent limit", async (t) => {
  const { project } = await folders(t);
  const { terminals } = managerWith(t);
  const pending = [];
  const control = new AgentControlService(terminals, {
    limits: () => ({ maxDepth: 2, maxSubagents: 1 }),
    resolveSubagentEnvironment: () => new Promise(resolve => pending.push(resolve))
  });
  const parent = terminals.create({ provider: "codex", profile: "normal", cwd: project, position: at, role: "orchestrator" });
  const request = { parentSessionId: parent.id, provider: "codex", cwd: project };
  const first = control.spawn(request);
  const second = control.spawn(request);
  const results = Promise.allSettled([first, second]);
  assert.equal(pending.length, 2);
  for (const resolve of pending) resolve(null);
  const settled = await results;
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  assert.match(settled.find(result => result.status === "rejected").reason.message, /already runs 1 live subagent/u);
  assert.equal(control.children(parent.id).length, 1);
});

test("a budget reached while an environment resolves blocks the pending spawn", async (t) => {
  const { project } = await folders(t);
  const { terminals, calls } = managerWith(t);
  let paused = false;
  let resolveEnvironment;
  const control = new AgentControlService(terminals, {
    budget: { snapshot: () => ({ paused, reason: "Budget reached during environment selection" }) },
    resolveSubagentEnvironment: () => new Promise(resolve => { resolveEnvironment = resolve; })
  });
  const parent = terminals.create({ provider: "codex", profile: "normal", cwd: project, position: at, role: "orchestrator" });
  const launchCount = calls.length;
  const pending = control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: project });
  paused = true;
  resolveEnvironment(null);
  await assert.rejects(pending, /Budget reached during environment selection/u);
  assert.equal(control.children(parent.id).length, 0);
  assert.equal(calls.length, launchCount);
});

test("YOLO is enforced in the main process: acknowledged by the person, never for a subagent", async (t) => {
  const { project } = await folders(t);
  const { terminals } = managerWith(t, { acknowledged: ["claude"] });
  assert.throws(() => terminals.create({ provider: "codex", profile: "yolo", cwd: project, position: at }), /YOLO for codex was not acknowledged by the person/u);
  assert.throws(() => terminals.create({ provider: "codex", profile: "yolo", cwd: project, position: at }, { origin: "plugin" }), /a plugin cannot start it/u);
  assert.throws(() => terminals.create({ provider: "codex", profile: "yolo", cwd: project, position: at }, { origin: "control" }), /the control endpoint cannot start it/u);
  assert.equal(terminals.create({ provider: "claude", profile: "yolo", cwd: project, position: at }).profile, "yolo");
  const parent = terminals.create({ provider: "claude", profile: "yolo", cwd: project, position: at, role: "orchestrator" });
  assert.throws(() => terminals.create({ provider: "claude", profile: "yolo", cwd: project, position: at, role: "subagent", parentSessionId: parent.id }),
    /never given to a subagent/u);
  // A plugin with sessions:launch goes through the same check.
  const sessions = new PluginSessions({ terminals, notify: () => true });
  assert.throws(() => sessions.handle("p.x", "svc", "sessions.create", { provider: "codex", cwd: project, profile: "yolo" }, ["sessions:launch"]),
    /not acknowledged/u);
});

test("an orchestrator picks plugin launch options for a subagent only where the plugin declared them delegable", async (t) => {
  const { project } = await folders(t);
  const runsRoot = await mkdtemp(join(tmpdir(), "ctty-delegable-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  let delegable = false;
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: "p.accounts", pluginName: "Accounts", serviceId: "svc", secrets: false,
      launch: { fields: [{ key: "account", label: "Account", kind: "text" }], ...(delegable ? { delegable: true } : {}) } }],
    call: async () => null, secret: async () => null, runsRoot, timeoutMs: 500
  });
  const { terminals } = managerWith(t);
  terminals.configureLaunchPipeline(pipeline);
  const control = new AgentControlService(terminals);
  const orchestrator = terminals.create({ provider: "codex", profile: "auto", cwd: project, position: at, role: "orchestrator" });
  const options = { "p.accounts": { account: "work" } };
  assert.throws(() => control.spawn({ parentSessionId: orchestrator.id, provider: "codex", cwd: project, launchOptions: options }),
    /Accounts has not declared its launch options safe for an orchestrator to choose/u);
  // The person's own launch takes them either way.
  assert.ok(terminals.create({ provider: "codex", profile: "auto", cwd: project, position: at, launchOptions: options }).id);
  delegable = true;
  assert.ok((await control.spawn({ parentSessionId: orchestrator.id, provider: "codex", cwd: project, launchOptions: options })).id);
});

test("a restored subagent never comes back with more than its orchestrator allows", async (t) => {
  const { project } = await folders(t);
  const { terminals, calls } = managerWith(t);
  const orchestrator = terminals.create({ provider: "claude", profile: "normal", cwd: project, position: at, role: "orchestrator" });
  const restore = terminals.restorePersistedSession.bind(terminals);
  const record = { id: randomUUID(), provider: "claude", profile: "yolo", title: "w", titleCustomized: false, cwd: project, position: at,
    size: { width: 700, height: 430 }, role: "subagent", parentSessionId: orchestrator.id, lastState: "running" };
  restore({ record, launch: { fresh: true }, threadId: undefined, note: undefined });
  assert.equal(terminals.getMetadata(record.id).profile, "normal", "capped at the orchestrator's profile");
  assert.ok(!calls.at(-1).args.includes("--dangerously-skip-permissions"));
});

test("no agent-facing tool changes CanvasTTY's settings, protection, profiles or isolation", async () => {
  // The orchestration tools an agent can call: agents only, no settings, no profile or trust changes.
  assert.deepEqual([...ORCHESTRATION_TOOL_NAMES].sort(),
    ["apply_orchestration_template", "ask_user", "cancel_agent", "claim_task", "complete_task", "get_agent_result", "get_execution_strategy", "get_task_budget", "list_agents", "list_execution_targets", "list_orchestration_templates", "list_providers", "list_tasks", "observe_agent", "request_secret", "retry_agent", "run_secret_request", "send_to_agent", "spawn_agent", "update_task", "wait_for_agent"]);
  // The control gateway writes only the pixel theme to settings, and only for the person's own connection.
  const gateway = await readFile(new URL("../src/main/services/agent-control/AgentControlGateway.ts", import.meta.url), "utf8");
  const updates = [...gateway.matchAll(/settings\.update\(\{\s*([a-zA-Z]+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(updates)], ["terminalBorderSkin"]);
  assert.match(gateway, /if \(agent\) throw new ControlError\("NOT_ALLOWED"/u);
  // Plugin services have no settings host API.
  const index = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const host = index.slice(index.indexOf("pluginServices = new PluginServiceSupervisor"), index.indexOf("// Base protection runs first"));
  assert.doesNotMatch(host, /settings\.(update|set)/u);
});

async function gatewayFixture(t, options = {}) {
  const { root, project, inner, other } = await folders(t);
  const userData = await realpath(await mkdtemp(join("/tmp", "ctty-grant-")));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const calls = [];
  let gateway;
  const terminals = new TerminalManager((channel, payload) => gateway?.observe(channel, payload), availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  if (options.executionPolicy) terminals.configureExecutionPolicy(options.executionPolicy);
  const control = new AgentControlService(terminals);
  const pixelSkinPacks = new PixelSkinPackRegistry(userData);
  await pixelSkinPacks.initialize();
  const settings = new SettingsStore(userData, "en");
  await settings.load();
  gateway = new AgentControlGateway({ userDataPath: userData, terminals, pixelSkinPacks, settings, lifecycleEnabled: () => true,
    executionTargets: (sessionId) => control.executionTargets(sessionId),
    spawnSubagent: options.spawnSubagent ? (request) => options.spawnSubagent(request, terminals) : (request) => control.spawn(request) });
  const appConnection = await gateway.start();
  terminals.setControlConnection({ connectionPath: appConnection, cliPath: "/cli.mjs", grant: (id) => gateway.grantSession(id) });
  t.after(async () => { await gateway.close(); await terminals.shutdown(); });
  return { root, project, inner, other, userData, terminals, calls, gateway, appConnection, settings };
}

test("concurrent subagent creates never exceed the 32 controlled sessions", localSocket, async (t) => {
  let open;
  let hold = false;
  const gate = new Promise((resolve) => { open = resolve; });
  let started = 0;
  const f = await gatewayFixture(t, {
    // Slow to start, like a real launch: the held requests are all past the cap check before any finishes.
    spawnSubagent: async (request, terminals) => {
      started += 1;
      if (hold) await gate;
      return terminals.create({ provider: request.provider, profile: "normal", cwd: request.cwd, position: at });
    }
  });
  f.terminals.create({ provider: "codex", profile: "auto", cwd: f.project, position: at, role: "orchestrator" });
  const connectionPath = f.calls.at(-1).options.env.CANVASTTY_CONTROL_CONNECTION;
  const clientPath = join(dirname(connectionPath), "controller.json");
  const create = () => controlRequest({ connectionPath, clientPath, method: "create",
    params: { provider: "opencode", cwd: f.inner }, requestId: randomUUID(), timeoutMs: 20_000 }).then(() => "ok", (error) => error.code ?? error.message);
  for (let i = 0; i < 28; i++) assert.equal(await create(), "ok");
  hold = true;
  const results = Array.from({ length: 10 }, create);
  await new Promise((resolve) => setTimeout(resolve, 300));
  open();
  const outcomes = await Promise.all(results);
  assert.deepEqual(outcomes.sort(), [...Array(6).fill("LIMIT_REACHED"), ...Array(4).fill("ok")], `started ${started}`);
  assert.equal(started, 32, "no launch past the cap");
});

test("an orchestrator's own control connection: never the app-wide one, subagents only, under every rule", localSocket, async (t) => {
  const f = await gatewayFixture(t);
  const orchestrator = f.terminals.create({ provider: "codex", profile: "auto", cwd: f.project, position: at, role: "orchestrator" });
  const env = f.calls.at(-1).options.env;
  const connectionPath = env.CANVASTTY_CONTROL_CONNECTION;
  assert.ok(connectionPath && connectionPath !== f.appConnection, "a connection of its own");
  assert.equal(dirname(dirname(connectionPath)), join(f.userData, "agent-control", "sessions"));
  const descriptor = JSON.parse(await readFile(connectionPath, "utf8"));
  assert.equal(descriptor.scope, "session");
  assert.notEqual(descriptor.tokenFile, JSON.parse(await readFile(f.appConnection, "utf8")).tokenFile);
  const clientPath = join(dirname(connectionPath), "controller.json");
  const request = (method, params = {}) => controlRequest({ connectionPath, clientPath, method, params, requestId: randomUUID() });

  // create makes a subagent of this orchestrator, in its profile at most.
  const created = await request("create", { provider: "opencode", cwd: f.inner });
  const child = f.terminals.getMetadata(created.session.id);
  assert.deepEqual([child.role, child.parentSessionId, child.profile], ["subagent", orchestrator.id, "auto"]);
  for (const [params, pattern] of [
    [{ provider: "codex", cwd: f.inner, profile: "yolo" }, /never given to a subagent/u],
    [{ provider: "codex", cwd: "/" }, /only inside this project's folder/u],
    [{ provider: "codex", cwd: homedir() }, /only inside this project's folder/u],
    [{ provider: "codex", cwd: f.other }, /only inside this project's folder/u]
  ]) {
    await assert.rejects(request("create", params), (error) => error.code === "REFUSED" && pattern.test(error.message), JSON.stringify(params));
  }
  // Nothing of CanvasTTY's own: settings and themes are the person's.
  await assert.rejects(request("skin-select", { skinId: "matrix" }), (error) => error.code === "NOT_ALLOWED");
  await assert.rejects(request("skin-list"), (error) => error.code === "NOT_ALLOWED");
  assert.equal((await f.settings.load()).terminalBorderSkin, "classic");
  // The CLI without --profile asks for no profile on such a connection (the orchestrator's applies).
  const viaCli = await runCli(["create", "--connection", connectionPath, "--client-file", clientPath, "--provider", "opencode", "--cwd", f.inner]);
  assert.equal(f.terminals.getMetadata(viaCli.result.session.id).profile, "auto");
  // Closing the orchestrator withdraws its connection.
  f.terminals.dispose(orchestrator.id);
  assert.equal(existsSync(dirname(connectionPath)), false);
  await assert.rejects(request("list"), /./u);
  // Ordinary agents get no connection at all.
  f.terminals.create({ provider: "codex", profile: "auto", cwd: f.project, position: at });
  assert.equal(f.calls.at(-1).options.env.CANVASTTY_CONTROL_CONNECTION, undefined);
});

test("scoped control discovers permitted execution targets and requires an explicit allowed id", localSocket, async (t) => {
  const target = { id: "local", label: "Approved local CLI", provider: "codex", accountId: "default", maxDataClass: "D3" };
  const publicTarget = { ...target, id: "public", maxDataClass: "D1" };
  const otherProvider = { ...target, id: "claude", provider: "claude" };
  let policy = { enabled: true, defaultDataClass: "D2", targets: [target, publicTarget, otherProvider] };
  const f = await gatewayFixture(t, { executionPolicy: () => policy });
  const parent = f.terminals.create({ provider: "codex", profile: "normal", cwd: f.project, position: at, role: "orchestrator" });
  const connectionPath = f.calls.at(-1).options.env.CANVASTTY_CONTROL_CONNECTION;
  const clientPath = join(dirname(connectionPath), "controller.json");
  const request = (method, params = {}) => controlRequest({ connectionPath, clientPath, method, params, requestId: randomUUID() });
  const cli = (...args) => runCli([...args, "--connection", connectionPath, "--client-file", clientPath]);
  const beforeSettings = structuredClone(f.settings.get());
  assert.deepEqual((await cli("execution-targets")).result, { enabled: true, targets: [target, otherProvider] });
  // A caller cannot choose another session's scope or supply its own policy.
  await assert.rejects(request("execution-targets", { sessionId: "another-root" }), (e) => e.code === "INVALID_PARAMS");
  await assert.rejects(request("execution-targets", { targets: [publicTarget] }), (e) => e.code === "INVALID_PARAMS");
  const base = { provider: "codex", cwd: f.inner };
  const count = f.calls.length;
  for (const executionTargetId of [undefined, "missing", "public", "claude"]) {
    await assert.rejects(request("create", { ...base, ...(executionTargetId === undefined ? {} : { executionTargetId }) }),
      (e) => e.code === "REFUSED" && /execution target/i.test(e.message));
  }
  for (const executionTargetId of ["", "x".repeat(81), "has spaces", "../local", 1, null]) {
    await assert.rejects(request("create", { ...base, executionTargetId }), (e) => e.code === "INVALID_PARAMS");
  }
  assert.equal(f.calls.length, count, "every denied selection stops before a PTY starts");
  const created = await cli("create", "--provider", "codex", "--cwd", f.inner, "--execution-target", "local");
  const child = f.terminals.getMetadata(created.result.session.id);
  assert.deepEqual([child.parentSessionId, child.role, child.profile], [parent.id, "subagent", "normal"]);
  assert.equal(f.calls.length, count + 1);
  assert.equal(f.calls.at(-1).options.env.CANVASTTY_CONTROL_CONNECTION, undefined, "a worker gets no orchestrator grant");
  await assert.rejects(request("skin-select", { skinId: "matrix" }), (e) => e.code === "NOT_ALLOWED");
  assert.deepEqual(f.settings.get(), beforeSettings, "discovery and selection cannot edit the person's settings");
  // Discovery is live; an ID revoked after discovery is still refused at creation.
  policy = { ...policy, targets: [otherProvider] };
  assert.deepEqual((await request("execution-targets")).targets, [otherProvider]);
  await assert.rejects(request("create", { ...base, executionTargetId: "local" }), (e) => e.code === "REFUSED");
  assert.equal(f.calls.length, count + 1);
  await assert.rejects(controlRequest({ connectionPath: f.appConnection, clientPath: join(f.userData, "person.json"),
    method: "execution-targets", requestId: randomUUID() }), (e) => e.code === "NOT_ALLOWED");
  f.terminals.dispose(parent.id);
  await assert.rejects(request("execution-targets"), /./u, "a closed root loses discovery access with its grant");
});

test("scoped target discovery uses the grant's task class and preserves disabled-policy behavior", localSocket, async (t) => {
  const target = { id: "local", label: "Approved local CLI", provider: "codex", accountId: "default", maxDataClass: "D3" };
  const publicTarget = { ...target, id: "public", maxDataClass: "D1" };
  let policy = { enabled: true, defaultDataClass: "D1", targets: [target, publicTarget] };
  const f = await gatewayFixture(t, { executionPolicy: () => policy });
  const requestForRoot = () => {
    f.terminals.create({ provider: "codex", profile: "normal", cwd: f.project, position: at, role: "orchestrator" });
    const connectionPath = f.calls.at(-1).options.env.CANVASTTY_CONTROL_CONNECTION;
    const clientPath = join(dirname(connectionPath), "controller.json");
    return (method, params = {}) => controlRequest({ connectionPath, clientPath, method, params, requestId: randomUUID() });
  };
  const publicRequest = requestForRoot();
  policy = { ...policy, defaultDataClass: "D3" };
  const privateRequest = requestForRoot();
  assert.deepEqual((await publicRequest("execution-targets")).targets.map(t => t.id), ["local", "public"]);
  assert.deepEqual((await privateRequest("execution-targets")).targets.map(t => t.id), ["local"]);
  policy = { ...policy, enabled: false };
  assert.deepEqual(await privateRequest("execution-targets"), { enabled: false, targets: [] });
  assert.ok((await privateRequest("create", { provider: "codex", cwd: f.inner })).session.id);
  await assert.rejects(privateRequest("create", { provider: "codex", cwd: f.inner, executionTargetId: "local" }),
    (e) => e.code === "REFUSED", "policy-off does not make a supplied id an authorization bypass");
});
