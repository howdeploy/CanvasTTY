import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// A subagent spawned without an account option once ran on OpenCode's default free model (OpenCode Zen), sending the
// task to opencode.ai while its orchestrator ran on the person's GLM account. It now inherits the orchestrator's
// account; "none" is an explicit choice, another account needs the plugin's delegable declaration, and the answer
// (and the card) says which provider, account and model serve it.

const at = { x: 0, y: 0 };
const ACCOUNTS = "canvastty-accounts";

async function setup(t, { delegable = true, router = true, accountCandidates, route, executionGoal, reviewFields = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctty-sub-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const prepared = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  terminals.configureLaunchPipeline(new LaunchPipeline({
    contributors: () => [{ pluginId: ACCOUNTS, pluginName: "Accounts", serviceId: "accounts", secrets: false,
      launch: { fields: [{ key: "account", label: "Model account", kind: "text" }, ...(reviewFields ? [{ key: "task", label: "Task", kind: "text" }, { key: "dataClass", label: "Data class", kind: "text" }] : [])], ...(delegable ? { delegable: true } : {}) } }],
    call: async (_plugin, _service, method, params) => {
      if (method !== "canvastty.launch.prepare") return null;
      prepared.push({ sessionId: params.sessionId, chosen: params.chosen, options: params.options });
      return params.chosen && params.options.account && params.options.account !== "none"
        ? { env: {}, secretEnv: {}, args: ["--model", `canvastty_${params.options.account}/glm-5.3-flash`], files: [] }
        : { env: {}, secretEnv: {}, args: [], files: [] };
    },
    secret: async () => null, runsRoot: join(root, "runs"), timeoutMs: 2000
  }));
  const control = new AgentControlService(terminals);
  let routed = 0;
  const requests = [];
  const handler = new ScopedOrchestrationHandler(control, null,
    { cli: () => "available", limits: () => null, models: () => ({ models: ["zai/glm-5.3"], checkedAt: Date.now() }), checkModel: async () => null },
    {
      ...(router ? { router: { async route(request) { routed += 1; requests.push(request); return route ? route(request) : { candidateId: request.candidates.find((item) => item.model)?.id, reason: "listed" }; } } } : {}),
      ...(accountCandidates ? { accountCandidates, routeTimeoutMs: 200 } : {}),
      onRouting: (id, route) => terminals.setTaskMetadata(id, { modelRoute: route })
    });
  const orchestrator = (launchOptions) => terminals.create({ provider: "opencode", profile: "normal", cwd: root, position: at, role: "orchestrator",
    ...(launchOptions ? { launchOptions } : {}), ...(executionGoal ? {executionGoal} : {}) });
  const spawn = (parent, args) => handler.execute(parent.id, { id: `c-${Math.random()}`, tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, prompt: "Small task", ...args } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  return { root, calls, prepared, terminals, control, handler, orchestrator, spawn, settle, routed: () => routed, requests };
}

test("a subagent spawned without an account runs on its orchestrator's model account, never on the CLI default", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await s.settle();
  const child = await s.spawn(parent, {});
  await s.settle();
  assert.equal(s.routed(), 0, "the router is not asked: the inherited account decides the model");
  assert.deepEqual(child.servedBy, { provider: "opencode", account: "glm-flash", accountSource: "inherited", model: "set by model account glm-flash" });
  assert.match(child.routing.reason, /Model account glm-flash \(inherited from the orchestrator\) decides the model/u);
  const childPrepare = s.prepared.find((entry) => entry.sessionId === child.sessionId);
  assert.deepEqual(childPrepare, { sessionId: child.sessionId, chosen: true, options: { account: "glm-flash" } });
  const launched = s.calls.at(-1).args;
  assert.ok(launched.includes("canvastty_glm-flash/glm-5.3-flash"), launched.join(" "));
  assert.equal(launched.filter((arg) => arg === "--model").length, 1);
  assert.equal(s.terminals.modelAccountOf(child.sessionId), "glm-flash");
});

test("no account is an explicit choice; an orchestrator without an account says which provider and model serve the subagent", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await s.settle();
  const own = await s.spawn(parent, { launchOptions: { [ACCOUNTS]: { account: "none" } } });
  await s.settle();
  assert.equal(own.servedBy.account, null);
  assert.equal(own.servedBy.accountSource, "none");
  assert.equal(s.terminals.modelAccountOf(own.sessionId), undefined);
  assert.ok(!s.calls.at(-1).args.some((arg) => arg.startsWith("canvastty_")), "explicit none: no account model");
  assert.equal(own.servedBy.model, own.model, "the installed router chose its model; the answer names it");

  // Without a router and without an account the CLI's default serves it: the answer and the card say so.
  const bare = await setup(t, { router: false });
  const plain = bare.orchestrator();
  const child = await bare.spawn(plain, {});
  await bare.settle();
  assert.equal(child.servedBy.account, null);
  assert.equal(child.servedBy.accountSource, "none");
  assert.match(child.servedBy.model, /OpenCode Zen model on opencode\.ai/u);
  assert.match(bare.terminals.getMetadata(child.sessionId).modelRoute.reason, /No model account: served by opencode's own sign-in and OpenCode's default model/u,
    "the card shows it too");
});

test("another account needs the plugin's delegable declaration; the orchestrator's own account does not", async (t) => {
  const s = await setup(t, { delegable: false });
  const parent = s.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await s.settle();
  const inherited = await s.spawn(parent, {});
  assert.equal(inherited.servedBy.account, "glm-flash");
  const same = await s.spawn(parent, { launchOptions: { [ACCOUNTS]: { account: "glm-flash" } } });
  assert.equal(same.servedBy.accountSource, "explicit");
  await assert.rejects(s.spawn(parent, { launchOptions: { [ACCOUNTS]: { account: "other-paid" } } }),
    /Accounts has not declared its launch options safe for an orchestrator to choose/u);
});

test("a subagent of another CLI cannot silently drop the orchestrator's account", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await s.settle();
  await assert.rejects(s.spawn(parent, { provider: "codex" }), /runs on model account glm-flash for opencode; a codex subagent cannot inherit it/u);
  assert.throws(() => s.control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: s.root }), /cannot inherit it/u);
  const explicit = await s.spawn(parent, { provider: "codex", launchOptions: { [ACCOUNTS]: { account: "none" } } });
  assert.equal(explicit.servedBy.account, null);
});

test("AgentControlService.spawn applies the same inheritance for every caller", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await s.settle();
  const child = await s.control.spawn({ parentSessionId: parent.id, provider: "opencode", cwd: s.root });
  await s.settle();
  assert.equal(s.terminals.modelAccountOf(child.id), "glm-flash");
});

const GLM_ACCOUNTS = async (provider) => provider === "opencode"
  ? [{ id: "glm-flash", label: "GLM 5.3 Flash · Z.AI Coding Plan · glm-5.3-flash" }, { id: "glm-53", label: "GLM 5.3 · Z.AI Coding Plan · glm-5.3" }]
  : [];
const pick = (model) => (request) => ({ candidateId: request.candidates.find((item) => item.model === model).id, reason: `picked ${model}` });

test("with delegable accounts the router chooses the inherited subagent's ACCOUNT; the account sets the only --model", async (t) => {
  const s = await setup(t, { accountCandidates: GLM_ACCOUNTS, route: pick("glm-5.3") });
  const parent = s.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await s.settle();
  const child = await s.spawn(parent, { model: "auto", prompt: "Design a migration for the public API" });
  await s.settle();
  assert.equal(s.routed(), 1);
  const request = s.requests[0];
  assert.deepEqual(request.candidates.map((item) => [item.model, item.default === true]), [["glm-5.3-flash", true], ["glm-5.3", false]],
    "the candidates are the accounts (their model only labels them); the inherited account is the default");
  assert.equal(request.task, "Design a migration for the public API");
  assert.equal(child.model, undefined, "no model is added next to the account's own");
  assert.equal(child.routing.source, "router");
  assert.match(child.routing.reason, /Model account glm-53 sets the model/u);
  assert.deepEqual(child.servedBy, { provider: "opencode", account: "glm-53", accountSource: "routed", model: "set by model account glm-53" });
  assert.deepEqual(s.prepared.find((entry) => entry.sessionId === child.sessionId).options, { account: "glm-53" });
  const launched = s.calls.at(-1).args;
  assert.ok(launched.includes("canvastty_glm-53/glm-5.3-flash"), launched.join(" "));
  assert.equal(launched.filter((arg) => arg === "--model").length, 1, launched.join(" "));
  assert.equal(s.terminals.modelAccountOf(child.sessionId), "glm-53");
});

test("account routing keeps the inherited account when the router keeps it, fails, times out or invents an id", async (t) => {
  for (const [name, route] of [
    ["keeps", pick("glm-5.3-flash")],
    ["fails", () => { throw new Error("router down"); }],
    ["times out", () => new Promise(() => {})],
    ["invents", () => ({ candidateId: "glm-53", reason: "raw id" })]
  ]) {
    const s = await setup(t, { accountCandidates: GLM_ACCOUNTS, route });
    const parent = s.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
    await s.settle();
    const child = await s.spawn(parent, {});
    await s.settle();
    assert.equal(child.servedBy.account, "glm-flash", name);
    assert.equal(s.terminals.modelAccountOf(child.sessionId), "glm-flash", name);
    assert.equal(s.calls.at(-1).args.filter((arg) => arg === "--model").length, 1, name);
    if (name !== "keeps") assert.equal(child.routing.source, "default", name);
  }
});

test("account routing never overrides an explicit account or model, and needs two delegable accounts", async (t) => {
  const s = await setup(t, { accountCandidates: GLM_ACCOUNTS, route: pick("glm-5.3") });
  const parent = s.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await s.settle();
  const explicit = await s.spawn(parent, { launchOptions: { [ACCOUNTS]: { account: "glm-flash" } } });
  assert.equal(explicit.servedBy.account, "glm-flash");
  assert.equal(s.routed(), 0, "an explicit account is a choice, not a routing question");
  const one = await setup(t, { accountCandidates: async () => [{ id: "glm-flash", label: "GLM · glm-5.3-flash" }], route: pick("glm-5.3") });
  const p1 = one.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await one.settle();
  const single = await one.spawn(p1, {});
  assert.equal(single.servedBy.account, "glm-flash");
  assert.equal(one.routed(), 0);
  const none = await setup(t, { accountCandidates: async () => [], route: pick("glm-5.3") });
  const p2 = none.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await none.settle();
  assert.equal((await none.spawn(p2, {})).servedBy.account, "glm-flash", "not delegable (no candidates): unchanged");
});

test("account routing receives the same manual root strategy and retains the account-owned model",async t=>{
 const s=await setup(t,{executionGoal:"economical",accountCandidates:GLM_ACCOUNTS,route:pick("glm-5.3")});
 const parent=s.orchestrator({[ACCOUNTS]:{account:"glm-flash"}});await s.settle();
 const child=await s.spawn(parent,{});await s.settle();
 assert.equal(s.requests[0].executionStrategy.resolved,"economical");assert.equal(child.executionStrategy.source,"person");
 assert.equal(s.calls.at(-1).args.filter(arg=>arg==="--model").length,1);
 await assert.rejects(s.spawn(parent,{}),/strategy/);
 s.handler.forgetSession(child.sessionId);
});


test("automatic account routing uses ready routes, never an unconfigured dropdown account", async () => {
  const { readyAccountCandidates } = await import("../src/main/services/readyAccountCandidates.ts");
  const rows = [
    {provider:"opencode", accountId:"flash", account:"Fast", model:"glm-5.3-flash", state:"ready"},
    {provider:"opencode", accountId:"missing", account:"MiniMax", model:"m3", state:"no-key"},
    {provider:"opencode", accountId:"wrong-key", account:"Wrong origin", model:"m3", state:"key-for-other-address"},
    {provider:"opencode", accountId:"down", account:"Local", model:"local", state:"ollama-down"},
    {provider:"codex", accountId:"other", account:"Other CLI", model:"other", state:"ready"}
  ];
  const calls=[];
  const tools={call:async(...args)=>{calls.push(args);return {content:JSON.stringify({routes:rows}),isError:false};}};
  assert.deepEqual(await readyAccountCandidates(tools,"root","opencode"),[{id:"flash",label:"Fast · glm-5.3-flash"}]);
  assert.deepEqual(calls[0],["root","orchestrator","canvastty-accounts__list_routes",{provider:"opencode"}]);
  for(const reply of [{isError:true,content:JSON.stringify({routes:rows})},{isError:false,content:"cut json"}])
    assert.deepEqual(await readyAccountCandidates({call:async()=>reply},"root","opencode"),[]);
});

test("command review inherits only its own plugin's person-authored root task and privacy", async t => {
  const s=await setup(t,{reviewFields:true});
  // This fixture's Accounts fields stand in for arbitrary plugin launch values.
  const parent=s.orchestrator({[ACCOUNTS]:{account:"glm-flash",task:"Write src/format.js",dataClass:"D3"}});
  const child=await s.spawn(parent,{launchOptions:{[ACCOUNTS]:{account:"glm-flash",task:"forged",dataClass:"D0"}}});
  assert.deepEqual(s.terminals.decisionLaunchOptions(child.sessionId,ACCOUNTS),{task:"Write src/format.js",dataClass:"D3"});
  assert.deepEqual(s.terminals.decisionLaunchOptions(child.sessionId,"assistant"),{});
  assert.equal(s.terminals.decisionLaunchOptions("missing","assistant"),undefined);
});


test("plugin-authored root tasks never become person authority, including after continuation", async t => {
  const s=await setup(t,{reviewFields:true});
  const root=s.terminals.create({provider:"opencode",profile:"normal",cwd:s.root,position:at,role:"orchestrator",
    launchOptions:{[ACCOUNTS]:{account:"glm-flash",task:"Plugin-authored task",dataClass:"D3"}}},
    {ownerPluginId:"fixture.plugin",origin:"plugin"});
  assert.deepEqual(s.terminals.decisionLaunchOptions(root.id,ACCOUNTS),{dataClass:"D3"});
  const child=await s.spawn(root,{});
  assert.deepEqual(s.terminals.decisionLaunchOptions(child.sessionId,ACCOUNTS),{dataClass:"D3"});
  const replacement=s.terminals.create({provider:"opencode",profile:"normal",cwd:s.root,position:at,role:"orchestrator"},{continueTaskFrom:root.id});
  s.terminals.inheritTaskScope(root.id,replacement.id);
  s.terminals.completeTaskContinuation(root.id,replacement.id);
  assert.deepEqual(s.terminals.decisionLaunchOptions(replacement.id,ACCOUNTS),{dataClass:"D3"});
  assert.deepEqual(s.terminals.decisionLaunchOptions(child.sessionId,ACCOUNTS),{dataClass:"D3"});
});
