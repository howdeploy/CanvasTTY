import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { LaunchPipeline, modelSettingArgument } from "../src/main/services/LaunchPipeline.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { availableRegistry, inputReadySpawner } from "./helpers/terminal.mjs";

// A subagent spawned without launch options once ran on its CLI's own default model (for OpenCode the hosted OpenCode
// Zen model), while its orchestrator ran on a model the person picked through a plugin (a model account). It now keeps
// the orchestrator's options for every plugin the spawn does not name; naming a plugin is an explicit choice, and a
// second model flag next to a plugin's own is refused instead of starting a CLI that crashes.

const at = { x: 0, y: 0 };
// Any plugin id: the core knows no plugin by name.
const MODELS = "example-model-accounts";
const EXTRAS = "example-extras";
const OTHER = "example-other-models";
const BARE = "example-no-fields";

async function setup(t, { delegable = true, extrasDelegable = false, store } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctty-sub-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const prepared = [];
  // What the person can change while the orchestrator runs: turn a plugin off, or a plugin update changes its fields.
  const state = { gone: new Set(), extrasFields: [{ key: "flavor", label: "Flavor", kind: "text" }] };
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, inputReadySpawner(calls));
  t.after(() => store ? terminals.shutdown() : terminals.disposeAll());
  terminals.configureLaunchPipeline(new LaunchPipeline({
    contributors: () => [
      { pluginId: MODELS, pluginName: "Model accounts", serviceId: "accounts", secrets: false,
        launch: { fields: [{ key: "account", label: "Model account", kind: "text" }], ...(delegable ? { delegable: true } : {}) } },
      // Options that do not decide the model.
      { pluginId: EXTRAS, pluginName: "Extras", serviceId: "extras", secrets: false,
        launch: { fields: state.extrasFields, ...(extrasDelegable ? { delegable: true } : {}) } },
      // A plugin without fields: choosing it in the launcher stores {}.
      { pluginId: BARE, pluginName: "No fields", serviceId: "bare", secrets: false, launch: { fields: [] } },
      // A second plugin that also sets the model.
      { pluginId: OTHER, pluginName: "Other models", serviceId: "other", secrets: false,
        launch: { fields: [{ key: "pick", label: "Model", kind: "text" }], delegable: true } }
    ].filter((contributor) => !state.gone.has(contributor.pluginId)),
    call: async (pluginId, _service, method, params) => {
      if (method !== "canvastty.launch.prepare") return null;
      prepared.push({ pluginId, sessionId: params.sessionId, chosen: params.chosen, options: params.options });
      if (pluginId === OTHER && params.chosen) return { env: {}, secretEnv: {}, args: [`--model=other/${params.options.pick}`], files: [] };
      // An endpoint plugin: it routes the CLI to another vendor's service but passes no model argument.
      if (pluginId === EXTRAS && params.chosen && params.options.flavor === "endpoint") return { env: {}, secretEnv: {}, args: [], files: [], thirdPartyModel: true };
      return pluginId === MODELS && params.chosen && params.options.account && params.options.account !== "none"
        ? { env: {}, secretEnv: {}, args: ["--model", `acct_${params.options.account}/glm-5.3-flash`], files: [] }
        : { env: {}, secretEnv: {}, args: [], files: [] };
    },
    secret: async () => null, runsRoot: join(root, "runs"), timeoutMs: 2000
  }));
  if (store) {
    terminals.configureSessionPersistence(new TerminalSessionStore(store), "continue");
    await terminals.restorePersistedSessions();
  }
  const control = new AgentControlService(terminals);
  const handler = new ScopedOrchestrationHandler(control, null,
    { cli: () => "available", limits: () => null, models: () => ({ models: ["zai/glm-5.3"], checkedAt: Date.now() }), checkModel: async () => null },
    {});
  const orchestrator = (launchOptions, provider = "opencode") => terminals.create({ provider, profile: "normal", cwd: root, position: at, role: "orchestrator",
    ...(launchOptions ? { launchOptions } : {}) });
  const spawn = (parent, args) => handler.execute(parent.id, { id: `c-${Math.random()}`, tool: "spawn_agent", arguments: { provider: "opencode", cwd: root, prompt: "Small task", ...args } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  return { root, calls, prepared, state, terminals, control, handler, orchestrator, spawn, settle };
}

test("a subagent spawned without launch options runs on its orchestrator's model account, never on the CLI default", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [MODELS]: { account: "glm-flash" } });
  await s.settle();
  assert.deepEqual(s.terminals.modelSetByOf(parent.id), [MODELS]);
  const child = await s.spawn(parent, {});
  await s.settle();
  assert.deepEqual(child.servedBy, { provider: "opencode", model: null, launchOptions: { [MODELS]: "inherited" } });
  const childPrepare = s.prepared.find((entry) => entry.sessionId === child.sessionId);
  assert.deepEqual(childPrepare, { pluginId: MODELS, sessionId: child.sessionId, chosen: true, options: { account: "glm-flash" } });
  const launched = s.calls.at(-1).args;
  assert.ok(launched.includes("acct_glm-flash/glm-5.3-flash"), launched.join(" "));
  assert.equal(launched.filter((arg) => arg === "--model").length, 1);
  assert.deepEqual(s.terminals.launchOptionsOf(child.sessionId), { [MODELS]: { account: "glm-flash" } });
});

test("naming the plugin is an explicit choice; without any options the CLI's default serves the subagent", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [MODELS]: { account: "glm-flash" } });
  await s.settle();
  const own = await s.spawn(parent, { launchOptions: { [MODELS]: { account: "none" } } });
  await s.settle();
  assert.deepEqual(own.servedBy.launchOptions, { [MODELS]: "explicit" });
  assert.deepEqual(s.terminals.launchOptionsOf(own.sessionId), { [MODELS]: { account: "none" } });
  assert.ok(!s.calls.at(-1).args.some((arg) => arg.startsWith("acct_")), "explicit none: no account model");
  assert.deepEqual(s.terminals.modelSetByOf(own.sessionId), []);

  const bare = await setup(t);
  const plain = bare.orchestrator();
  const child = await bare.spawn(plain, {});
  await bare.settle();
  assert.deepEqual(child.servedBy, { provider: "opencode", model: null, launchOptions: {} });
  assert.equal(bare.terminals.launchOptionsOf(child.sessionId), undefined);
});

test("another value needs the plugin's delegable declaration; the orchestrator's own values do not", async (t) => {
  const s = await setup(t, { delegable: false });
  const parent = s.orchestrator({ [MODELS]: { account: "glm-flash" }, [EXTRAS]: { flavor: "mild" } });
  await s.settle();
  const inherited = await s.spawn(parent, {});
  assert.deepEqual(inherited.servedBy.launchOptions, { [MODELS]: "inherited", [EXTRAS]: "inherited" });
  assert.deepEqual(s.terminals.launchOptionsOf(inherited.sessionId), { [MODELS]: { account: "glm-flash" }, [EXTRAS]: { flavor: "mild" } });
  const same = await s.spawn(parent, { launchOptions: { [MODELS]: { account: "glm-flash" } } });
  assert.deepEqual(same.servedBy.launchOptions, { [MODELS]: "explicit", [EXTRAS]: "inherited" });
  await assert.rejects(s.spawn(parent, { launchOptions: { [MODELS]: { account: "other-paid" } } }),
    /Model accounts has not declared its launch options safe for an orchestrator to choose/u);
});

test("a subagent of another CLI cannot silently drop the options that set the orchestrator's model", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [MODELS]: { account: "glm-flash" }, [EXTRAS]: { flavor: "mild" } });
  await s.settle();
  const refused = new RegExp(`model is set by its ${MODELS} launch options, which the person chose for opencode; a codex subagent would not get that model\\. Spawn a opencode subagent instead\\.`, "u");
  await assert.rejects(s.spawn(parent, { provider: "codex" }), refused);
  assert.throws(() => s.control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: s.root }), refused);
  // Naming the plugin for the other CLI is explicit; options that do not decide the model stay with their CLI.
  const explicit = await s.spawn(parent, { provider: "codex", launchOptions: { [MODELS]: { account: "none" } } });
  assert.deepEqual(explicit.servedBy.launchOptions, { [MODELS]: "explicit" });
  assert.deepEqual(s.terminals.launchOptionsOf(explicit.sessionId), { [MODELS]: { account: "none" } });
});

test("AgentControlService.spawn applies the same inheritance for every caller", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [MODELS]: { account: "glm-flash" } });
  await s.settle();
  const child = await s.control.spawn({ parentSessionId: parent.id, provider: "opencode", cwd: s.root });
  await s.settle();
  assert.deepEqual(s.terminals.launchOptionsOf(child.id), { [MODELS]: { account: "glm-flash" } });
  assert.deepEqual(s.terminals.modelSetByOf(child.id), [MODELS]);
});

test("a subagent with an explicit model next to launch options that set the model is refused instead of a crashing double --model", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator({ [EXTRAS]: { flavor: "mild" } });
  await s.settle();
  const spawned = s.calls.length;
  const child = await s.control.spawn({ parentSessionId: parent.id, provider: "opencode", cwd: s.root, model: "zai/glm-5.3",
    launchOptions: { [MODELS]: { account: "glm-flash" } } });
  await s.settle();
  const failed = s.terminals.getMetadata(child.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.failureDetails, /Model accounts sets the model of this launch, and the launch also asks for model zai\/glm-5\.3/u);
  assert.equal(s.calls.length, spawned, "no CLI was started with two --model flags");

  // Options that do not set the model take an explicit model as before.
  const plain = await s.control.spawn({ parentSessionId: parent.id, provider: "opencode", cwd: s.root, model: "zai/glm-5.3" });
  await s.settle();
  assert.notEqual(s.terminals.getMetadata(plain.id).status, "failed");
  assert.equal(s.calls.at(-1).args.filter((arg) => arg === "--model").length, 1);

  // A subagent that would inherit them is refused before anything starts.
  const accounts = s.orchestrator({ [MODELS]: { account: "glm-flash" } });
  await s.settle();
  await assert.rejects(s.spawn(accounts, { model: "zai/glm-5.3" }),
    new RegExp(`inherits its orchestrator's ${MODELS} launch options, which set its model; it cannot also take model zai/glm-5\\.3`, "u"));
});

test("a subagent whose launch options come from two plugins that both set the model is refused", async (t) => {
  const s = await setup(t);
  const parent = s.orchestrator();
  await s.settle();
  const spawned = s.calls.length;
  const child = await s.control.spawn({ parentSessionId: parent.id, provider: "opencode", cwd: s.root,
    launchOptions: { [MODELS]: { account: "glm-flash" }, [OTHER]: { pick: "x" } } });
  await s.settle();
  const failed = s.terminals.getMetadata(child.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.failureDetails, /Model accounts and Other models both set the model of this launch/u);
  assert.equal(s.calls.length, spawned);
});

test("a person's own card keeps starting with a model and a plugin that sets the model, also when it is restored", async (t) => {
  const s = await setup(t);
  const card = s.terminals.create({ provider: "opencode", profile: "normal", cwd: s.root, position: at, model: "zai/glm-5.3",
    launchOptions: { [MODELS]: { account: "glm-flash" } } });
  await s.settle();
  assert.notEqual(s.terminals.getMetadata(card.id).status, "failed");
  assert.ok(s.calls.at(-1).args.includes("acct_glm-flash/glm-5.3-flash"));

  const store = await mkdtemp(join(tmpdir(), "ctty-sub-account-store-"));
  t.after(() => rm(store, { recursive: true, force: true }));
  await new TerminalSessionStore(store).replace([{
    id: "person-card", provider: "opencode", profile: "normal", role: "agent", title: "Agent", titleCustomized: false,
    cwd: s.root, position: at, size: { width: 700, height: 430 }, lastState: "running", restore: true,
    model: "zai/glm-5.3", options: { [MODELS]: { account: "glm-flash" } }
  }]);
  const restored = await setup(t, { store });
  await restored.settle();
  const metadata = restored.terminals.getMetadata("person-card");
  assert.notEqual(metadata.status, "failed", metadata.failureDetails ?? "");
  assert.equal(restored.calls.length, 1);
  assert.ok(restored.calls[0].args.includes("acct_glm-flash/glm-5.3-flash"));
  assert.deepEqual(restored.terminals.modelSetByOf("person-card"), [MODELS]);
});

test("a subagent of another CLI is never checked against options the person chose for its orchestrator's CLI", async (t) => {
  const s = await setup(t, { delegable: false });
  // EXTRAS is not delegable and does not set the model: an opencode orchestrator's choice is not a codex subagent's.
  const parent = s.orchestrator({ [EXTRAS]: { flavor: "mild" } });
  await s.settle();
  const child = await s.spawn(parent, { provider: "codex" });
  assert.deepEqual(child.servedBy.launchOptions, {});
  assert.equal(s.terminals.launchOptionsOf(child.sessionId), undefined);
  // Naming it for codex is the orchestrator's own choice, which this plugin does not allow.
  await assert.rejects(s.spawn(parent, { provider: "codex", launchOptions: { [EXTRAS]: { flavor: "mild" } } }),
    /Extras has not declared its launch options safe for an orchestrator to choose/u);
});

test("model-setting arguments are recognised in every form each CLI takes", () => {
  const sets = (provider, ...args) => modelSettingArgument(provider, args);
  for (const provider of ["opencode", "codex", "qwen", "kimi", "grok", "claude", "cursor"]) {
    assert.equal(sets(provider, "--model", "x"), "--model", provider);
    assert.equal(sets(provider, "--model=x"), "--model=x", provider);
  }
  for (const provider of ["opencode", "codex", "qwen", "kimi", "grok"]) {
    assert.equal(sets(provider, "-m", "x"), "-m", provider);
    assert.equal(sets(provider, "-mx"), "-mx", provider);
  }
  // Claude has no -m.
  assert.equal(sets("claude", "-m", "x"), undefined);
  // Codex: a profile, and configuration keys that pick the model or its provider.
  assert.equal(sets("codex", "--profile", "work"), "--profile");
  assert.equal(sets("codex", "--profile=work"), "--profile=work");
  assert.equal(sets("codex", "-p", "work"), "-p");
  assert.equal(sets("codex", "-pwork"), "-pwork");
  assert.equal(sets("codex", "-c", "model=\"o3\""), "-c model=\"o3\"");
  assert.equal(sets("codex", "-c", " model = o3"), "-c  model = o3");
  assert.equal(sets("codex", "--config", "model_provider=acct"), "--config model_provider=acct");
  assert.equal(sets("codex", "--config=profile=work"), "--config=profile=work");
  assert.equal(sets("codex", "-cmodel=o3"), "-cmodel=o3");
  assert.equal(sets("codex", "-c", "\"model\"=o3"), "-c \"model\"=o3");
  // Other configuration keys and flags do not choose the model.
  assert.equal(sets("codex", "-c", "model_reasoning_effort=high"), undefined);
  assert.equal(sets("codex", "-c", "model"), undefined);
  assert.equal(sets("codex", "--search", "-c", "tools.web_search=true"), undefined);
  assert.equal(sets("opencode", "--profile", "x", "-p", "y"), undefined);
  assert.equal(sets("opencode", "--models"), undefined);
});

test("without the delegable declaration a subagent gets exactly the inherited values, never the plugin's defaults", () => {
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: EXTRAS, pluginName: "Extras", serviceId: "extras", secrets: false,
      launch: { fields: [{ key: "a", label: "A", kind: "text", default: "da" }, { key: "b", label: "B", kind: "text", default: "db" },
        { key: "c", label: "C", kind: "text" }] } }],
    call: async () => null, secret: async () => null, runsRoot: join(tmpdir(), "ctty-unused-runs")
  });
  const inherited = { [EXTRAS]: { a: "1", b: "2", c: "" } };
  const delegated = { delegated: true, inherited };
  // A subset is completed from the orchestrator's values, not from the defaults.
  assert.deepEqual(pipeline.normalizeOptions("opencode", { [EXTRAS]: { a: "1" } }, delegated), { [EXTRAS]: { a: "1", b: "2", c: "" } });
  assert.deepEqual(pipeline.normalizeOptions("opencode", { [EXTRAS]: { a: "1", b: "2", c: "" } }, delegated), inherited);
  const refused = /Extras has not declared its launch options safe for an orchestrator to choose/u;
  assert.throws(() => pipeline.normalizeOptions("opencode", { [EXTRAS]: { a: "1", b: "x" } }, delegated), refused);
  assert.throws(() => pipeline.normalizeOptions("opencode", { [EXTRAS]: { c: "set" } }, delegated), refused);
  assert.throws(() => pipeline.normalizeOptions("opencode", { [EXTRAS]: { a: "1", extra: "1" } }, delegated), refused);
  assert.throws(() => pipeline.normalizeOptions("opencode", { [EXTRAS]: {} }, delegated), refused);
  // An orchestrator whose own values the plugin no longer accepts as they were is refused, not given defaults.
  assert.throws(() => pipeline.normalizeOptions("opencode", { [EXTRAS]: { a: "1" } }, { delegated: true, inherited: { [EXTRAS]: { a: "1", b: "2" } } }),
    /Extras launch options changed since this orchestrator started/u);
  assert.throws(() => pipeline.normalizeOptions("opencode", { [EXTRAS]: { a: "1" } }, { delegated: true }), refused);
});

test("a plugin without fields chosen for the orchestrator is inherited as chosen, not refused", async (t) => {
  const s = await setup(t, { delegable: false });
  const parent = s.orchestrator({ [BARE]: {} });
  await s.settle();
  assert.notEqual(s.terminals.getMetadata(parent.id).status, "failed");
  const child = await s.spawn(parent, {});
  await s.settle();
  assert.deepEqual(child.servedBy.launchOptions, { [BARE]: "inherited" });
  assert.deepEqual(s.terminals.launchOptionsOf(child.sessionId), { [BARE]: {} });
  assert.notEqual(s.terminals.getMetadata(child.sessionId).status, "failed");
});

test("a plugin turned off after the orchestrator started: left out unless it set the model, then refused", async (t) => {
  const s = await setup(t, { delegable: false });
  const parent = s.orchestrator({ [MODELS]: { account: "glm-flash" }, [EXTRAS]: { flavor: "mild" } });
  await s.settle();
  // Options that do not decide the model: the subagent starts without them.
  s.state.gone.add(EXTRAS);
  const child = await s.spawn(parent, {});
  await s.settle();
  assert.deepEqual(child.servedBy.launchOptions, { [MODELS]: "inherited" });
  assert.deepEqual(s.terminals.launchOptionsOf(child.sessionId), { [MODELS]: { account: "glm-flash" } });
  // The plugin that set the model: never a silent fall back to the CLI's default model.
  s.state.gone.add(MODELS);
  const spawned = s.calls.length;
  await assert.rejects(s.spawn(parent, {}),
    new RegExp(`model is set by its ${MODELS} launch options, and ${MODELS} is now disabled, removed or not trusted; a subagent would run on its CLI's own default model instead`, "u"));
  assert.equal(s.calls.length, spawned);
});

test("a plugin whose fields changed after the orchestrator started refuses its subagents with that reason", async (t) => {
  const s = await setup(t, { delegable: false });
  const parent = s.orchestrator({ [EXTRAS]: { flavor: "mild" } });
  await s.settle();
  s.state.extrasFields.splice(0, 1, { key: "taste", label: "Taste", kind: "text" });
  await assert.rejects(s.spawn(parent, {}), /Extras launch options changed since this orchestrator started, so its subagents cannot repeat the person's choice/u);
  s.state.extrasFields.splice(0, 1, { key: "flavor", label: "Flavor", kind: "text" }, { key: "extra", label: "Extra", kind: "text", default: "on" });
  await assert.rejects(s.spawn(parent, {}), /Extras launch options changed since this orchestrator started/u);
});

test("a subagent inherits a person's model plugin next to an endpoint plugin that passes no model argument", async (t) => {
  const s = await setup(t, { delegable: false });
  const parent = s.orchestrator({ [MODELS]: { account: "glm-flash" }, [EXTRAS]: { flavor: "endpoint" } });
  await s.settle();
  assert.notEqual(s.terminals.getMetadata(parent.id).status, "failed", "the person's own orchestrator starts");
  const child = await s.spawn(parent, {});
  await s.settle();
  const metadata = s.terminals.getMetadata(child.sessionId);
  assert.notEqual(metadata.status, "failed", metadata.failureDetails ?? "");
  assert.equal(s.calls.at(-1).args.filter((arg) => arg === "--model").length, 1);
});

test("an endpoint plugin and a model plugin the orchestrator picks itself are still refused as two models", async (t) => {
  // The person chose only the endpoint; the orchestrator adds a model account next to it.
  const s = await setup(t);
  const parent = s.orchestrator({ [EXTRAS]: { flavor: "endpoint" } });
  await s.settle();
  const spawned = s.calls.length;
  await assert.rejects(s.spawn(parent, { launchOptions: { [MODELS]: { account: "glm-flash" } } }),
    /Extras and Model accounts both set the model of this launch|Model accounts and Extras both set the model of this launch/u);
  assert.equal(s.calls.length, spawned, "nothing started");

  // The person chose only the model account; the orchestrator adds an endpoint next to it.
  const e = await setup(t, { extrasDelegable: true });
  const accounts = e.orchestrator({ [MODELS]: { account: "glm-flash" } });
  await e.settle();
  const before = e.calls.length;
  await assert.rejects(e.spawn(accounts, { launchOptions: { [EXTRAS]: { flavor: "endpoint" } } }),
    /Extras and Model accounts both set the model of this launch|Model accounts and Extras both set the model of this launch/u);
  assert.equal(e.calls.length, before, "nothing started");
});
