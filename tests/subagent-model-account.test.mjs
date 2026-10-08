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

async function setup(t, { delegable = true, router = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctty-sub-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const prepared = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.disposeAll());
  terminals.configureLaunchPipeline(new LaunchPipeline({
    contributors: () => [{ pluginId: ACCOUNTS, pluginName: "Accounts", serviceId: "accounts", secrets: false,
      launch: { fields: [{ key: "account", label: "Model account", kind: "text" }], ...(delegable ? { delegable: true } : {}) } }],
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
  const handler = new ScopedOrchestrationHandler(control, null,
    { cli: () => "available", limits: () => null, models: () => ({ models: ["zai/glm-5.3"], checkedAt: Date.now() }), checkModel: async () => null },
    {});
  const orchestrator = (launchOptions) => terminals.create({ provider: "opencode", profile: "normal", cwd: root, position: at, role: "orchestrator",
    ...(launchOptions ? { launchOptions } : {}) });
  const spawn = (parent, args) => handler.execute(parent.id, { id: `c-${Math.random()}`, tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, prompt: "Small task", ...args } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  return { root, calls, prepared, terminals, control, handler, orchestrator, spawn, settle, routed: () => routed };
}

test("a subagent spawned without an account runs on its orchestrator's model account, never on the CLI default", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [ACCOUNTS]: { account: "glm-flash" } });
  await s.settle();
  const child = await s.spawn(parent, {});
  await s.settle();
  assert.equal(s.routed(), 0, "the router is not asked: the inherited account decides the model");
  assert.deepEqual(child.servedBy, { provider: "opencode", account: "glm-flash", accountSource: "inherited", model: "set by model account glm-flash" });
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
  assert.match(own.servedBy.model, /OpenCode's default model/u);

  // Without a router and without an account the CLI's default serves it: the answer and the card say so.
  const bare = await setup(t, { router: false });
  const plain = bare.orchestrator();
  const child = await bare.spawn(plain, {});
  await bare.settle();
  assert.equal(child.servedBy.account, null);
  assert.equal(child.servedBy.accountSource, "none");
  assert.match(child.servedBy.model, /OpenCode Zen model on opencode\.ai/u);

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
