import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { LaunchPipeline, envKey } from "../src/main/services/LaunchPipeline.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";

const example = new URL("../examples/plugins/launch-env/", import.meta.url);
const exampleManifest = JSON.parse(await readFile(new URL("canvastty.plugin.json", example), "utf8"));
const SECRET = "plugin-secret-value-7f3a9c11";
const cwd = process.cwd();
const at = { x: 0, y: 0 };

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

function registry() {
  return {
    get(provider) {
      return { state: "available", provider, executable: `/resolved/${provider}`, launcher: "native",
        environment: { PATH: "/usr/bin" }, checked: [] };
    },
    snapshot() { return {}; }
  };
}

function spawner(calls) {
  return (command, args, options) => {
    const exits = [];
    const data = [];
    calls.push({
      command, args, options,
      exit: (code) => exits.forEach((listener) => listener({ exitCode: code })),
      print: (text) => data.forEach((listener) => listener(text))
    });
    return {
      pid: 40_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData(listener) { data.push(listener); return { dispose() {} }; },
      onExit(listener) { exits.push(listener); return { dispose() {} }; }
    };
  };
}

const contributor = (pluginId, extra = {}) => ({
  pluginId,
  pluginName: `Plugin ${pluginId}`,
  serviceId: "launcher",
  launch: { fields: [{ key: "on", label: "On", kind: "boolean", default: true }] },
  secrets: false,
  ...extra
});

/** A pipeline over scripted service answers; `answers[pluginId]` is a value or (context) => value/promise. */
async function pipelineFixture(t, { contributors, answers, secrets = {}, timeoutMs = 300 }) {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-launch-runs-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const requests = [];
  const pipeline = new LaunchPipeline({
    contributors: () => contributors,
    call: async (pluginId, serviceId, method, params, budget) => {
      requests.push({ pluginId, serviceId, method, params, budget });
      const answer = answers[pluginId];
      return typeof answer === "function" ? answer(params) : answer;
    },
    secret: async (pluginId, key) => secrets[`${pluginId}/${key}`] ?? null,
    runsRoot,
    timeoutMs
  });
  return { pipeline, requests, runsRoot };
}

async function managerFixture(t, pipeline, { mode = "continue", directory } = {}) {
  const storeDirectory = directory ?? await mkdtemp(join(tmpdir(), "canvastty-launch-store-"));
  const calls = [];
  const events = [];
  const manager = new TerminalManager((channel, payload) => events.push({ channel, payload }), registry(),
    undefined, undefined, true, spawner(calls));
  // Hooks run in order: stop the manager and its writes before removing the folder.
  t.after(() => manager.shutdown());
  if (!directory) t.after(() => rm(storeDirectory, { recursive: true, force: true }));
  manager.configureLaunchPipeline(pipeline);
  manager.configureSessionPersistence(new TerminalSessionStore(storeDirectory), mode);
  await manager.restorePersistedSessions();
  return { manager, calls, events, storeDirectory };
}

const card = (manager, id) => manager.list().find((session) => session.id === id);

test("only the trusted Accounts contributor attributes usage to the selected account",async(t)=>{
  const context={sessionId:"attributed",provider:"codex",profile:"normal",role:"agent",cwd,restoring:false,resume:false,options:{"canvastty-accounts":{account:"alternate"}}};
  const {pipeline}=await pipelineFixture(t,{contributors:[contributor("canvastty-accounts")],answers:{"canvastty-accounts":{accountId:"alternate"}}});
  const accepted=await pipeline.prepare(context);
  assert.equal(accepted.ok,true);assert.equal(accepted.accountId,"alternate");await accepted.cleanup();
  const mismatched=await pipeline.prepare({...context,options:{"canvastty-accounts":{account:"none"}}});
  assert.equal(mismatched.ok,false);assert.match(mismatched.reason,/differs from the selected account/u);
  const {pipeline:untrusted}=await pipelineFixture(t,{contributors:[contributor("other")],answers:{other:{accountId:"alternate"}}});
  const refused=await untrusted.prepare({...context,options:{other:{}}});
  assert.equal(refused.ok,false);assert.match(refused.reason,/cannot attribute/u);
});

test("Accounts attribution treats an empty selection as the default account", async (t) => {
  const { pipeline } = await pipelineFixture(t, {
    contributors: [contributor("canvastty-accounts")],
    answers: { "canvastty-accounts": { accountId: "default" } }
  });
  for (const account of ["", "none", undefined]) {
    const prepared = await pipeline.prepare({
      sessionId: "default-attribution", provider: "codex", profile: "normal", role: "agent", cwd,
      restoring: false, resume: false, options: { "canvastty-accounts": { account } }
    });
    assert.equal(prepared.ok, true, `default attribution must accept ${JSON.stringify(account)}`);
    assert.equal(prepared.accountId, "default");
    await prepared.cleanup();
  }
});

test("an empty Accounts selection without attribution is billed to the provider's default sign-in", async (t) => {
  const { pipeline } = await pipelineFixture(t, {
    contributors: [contributor("canvastty-accounts", { launch: { fields: [{ key: "account", label: "Account", kind: "text", default: "" }] } })],
    answers: { "canvastty-accounts": {} }
  });
  const { manager, calls } = await managerFixture(t, pipeline);
  for (const account of ["", "none"]) {
    const started = manager.create({ provider: "codex", profile: "normal", cwd, position: at,
      launchOptions: { "canvastty-accounts": { account } } });
    await waitFor(() => calls.length > 0 && card(manager, started.id).status !== "starting");
    assert.equal(manager.usageAccount(started.id).id, "default", `selection ${JSON.stringify(account)}`);
    calls.length = 0;
  }
});

test("manifests declare launch options on one service and need launch:contribute", () => {
  const manifest = validatePluginManifest(exampleManifest);
  assert.deepEqual(manifest.services[0].launch.appliesTo, ["claude"]);
  assert.deepEqual(manifest.services[0].launch.fields.map((field) => field.kind), ["boolean", "text", "select", "select"]);
  const withLaunch = (launch, permissions = ["launch:contribute"]) => validatePluginManifest({
    ...exampleManifest, permissions, services: [{ ...exampleManifest.services[0], launch }]
  });
  assert.throws(() => withLaunch(exampleManifest.services[0].launch, []), /launch:contribute/u);
  assert.throws(() => withLaunch({ fields: [{ key: "x", label: "X", kind: "color" }] }), /boolean, select or text/u);
  assert.throws(() => withLaunch({ fields: [{ key: "x", label: "X", kind: "select", options: [] }] }), /1 to 16 options/u);
  assert.throws(() => withLaunch({ fields: [{ key: "x", label: "X", kind: "text", maxLength: 999 }] }), /maxLength/u);
  assert.throws(() => withLaunch({ appliesTo: ["terminal"], fields: [] }), /agent providers/u);
  assert.throws(() => withLaunch({ fields: Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, label: "K", kind: "boolean" })) }), /at most 8/u);
  assert.throws(() => validatePluginManifest({
    ...exampleManifest,
    services: [exampleManifest.services[0], { ...exampleManifest.services[0], id: "second" }]
  }), /At most one plugin service/u);
});

test("launcher values are checked against the declared fields, defaults filled, 4 KB per plugin", async (t) => {
  const example = { pluginId: "com.example.launch-env", pluginName: "Launch Env", serviceId: "launcher",
    launch: validatePluginManifest(exampleManifest).services[0].launch, secrets: false };
  const { pipeline } = await pipelineFixture(t, { contributors: [example], answers: {} });
  assert.deepEqual(pipeline.normalizeOptions("claude", { "com.example.launch-env": { mode: "loud" } }),
    { "com.example.launch-env": { enabled: true, greeting: "hello", mode: "loud", profile: "none" } });
  assert.equal(pipeline.normalizeOptions("claude", undefined), undefined);
  assert.equal(pipeline.normalizeOptions("claude", {}), undefined);
  assert.throws(() => pipeline.normalizeOptions("codex", { "com.example.launch-env": {} }), /do not apply to codex/u);
  assert.throws(() => pipeline.normalizeOptions("claude", { "com.example.launch-env": { mode: "quiet" } }), /Mode is invalid/u);
  assert.throws(() => pipeline.normalizeOptions("claude", { "com.example.launch-env": { extra: 1 } }), /no launch option extra/u);
  assert.throws(() => pipeline.normalizeOptions("claude", { "com.example.launch-env": { greeting: "x".repeat(61) } }), /Value is invalid/u);
  assert.throws(() => pipeline.normalizeOptions("claude", { "other.plugin": {} }), /Needs plugin other\.plugin/u);
  const wide = { ...example, launch: { fields: Array.from({ length: 8 }, (_, index) => ({ key: `t${index}`, label: "T", kind: "text" })) } };
  const { pipeline: widePipeline } = await pipelineFixture(t, { contributors: [wide], answers: {} });
  const big = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`t${index}`, "y".repeat(200)]));
  assert.equal(Object.keys(widePipeline.normalizeOptions("claude", { "com.example.launch-env": {} })["com.example.launch-env"]).length, 8);
  assert.doesNotThrow(() => widePipeline.normalizeOptions("claude", { "com.example.launch-env": big }));
});

test("contributors answer side by side but merge in plugin-id order, with files and the files token", async (t) => {
  const { pipeline, requests, runsRoot } = await pipelineFixture(t, {
    contributors: [contributor("b.second"), contributor("a.first")],
    answers: {
      // The later plugin id answers first; order must still follow the id.
      "a.first": () => new Promise((resolve) => setTimeout(() => resolve({
        env: { A_VALUE: "{launchFiles}/a.json" }, args: ["--from-a"], files: [{ relPath: "a.json", content: "{}" }]
      }), 40)),
      "b.second": { env: { B_VALUE: "b" }, args: ["--from-b"] }
    }
  });
  const prepared = await pipeline.prepare({ sessionId: "s1", provider: "claude", profile: "normal", role: "agent", cwd,
    restoring: false, resume: false, options: { "b.second": { on: true }, "a.first": { on: false } } });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.args, ["--from-a", "--from-b"]);
  assert.equal(prepared.env.B_VALUE, "b");
  assert.equal(await readFile(prepared.env.A_VALUE, "utf8"), "{}");
  assert.ok(prepared.env.A_VALUE.startsWith(join(runsRoot, "s1")));
  // Each plugin sees only its own options, with the host's method name and time budget.
  assert.deepEqual(requests.map((request) => [request.pluginId, request.method, request.params.options, request.budget]).sort(),
    [["a.first", "canvastty.launch.prepare", { on: false }, 300], ["b.second", "canvastty.launch.prepare", { on: true }, 300]]);
  await prepared.cleanup();
  await assert.rejects(stat(prepared.env.A_VALUE), /ENOENT/u);
});

test("refusals, timeouts, errors, bad answers, conflicts and core-owned values refuse the launch", async (t) => {
  const context = (options) => ({ sessionId: "s", provider: "claude", profile: "normal", role: "agent", cwd,
    restoring: false, resume: false, options });
  const refusal = async (answers, options, contributors = Object.keys(options).map((id) => contributor(id))) => {
    const { pipeline, runsRoot } = await pipelineFixture(t, { contributors, answers, timeoutMs: 100 });
    const prepared = await pipeline.prepare(context(options));
    assert.equal(prepared.ok, false);
    assert.deepEqual(await readdir(join(runsRoot, "s")).catch(() => []), []);
    return prepared.reason;
  };
  assert.match(await refusal({ "p.one": { refuse: { reason: "no quota left" } } }, { "p.one": {} }),
    /Plugin p\.one: no quota left/u);
  assert.match(await refusal({ "p.one": () => new Promise(() => undefined) }, { "p.one": {} }),
    /did not prepare the launch within 0\.1 s, so it was not started/u);
  assert.match(await refusal({ "p.one": () => { throw new Error("Plugin service is not running."); } }, { "p.one": {} }),
    /could not prepare the launch: Plugin service is not running/u);
  assert.match(await refusal({ "p.one": { env: { OK: 1 } } }, { "p.one": {} }), /invalid launch contribution: env OK must be text/u);
  assert.match(await refusal({ "p.one": { surprise: true } }, { "p.one": {} }), /unknown key surprise/u);
  assert.match(await refusal({ "p.one": { env: { CANVASTTY_AGENT_BRIDGE: "x" } } }, { "p.one": {} }), /reserved for CanvasTTY/u);
  assert.match(await refusal({ "p.one": { env: { PATH: "/tmp" } } }, { "p.one": {} }), /reserved for CanvasTTY/u);
  assert.match(await refusal({ "p.one": { args: ["ok\nnext"] } }, { "p.one": {} }), /without control characters/u);
  assert.match(await refusal({ "p.one": { files: [{ relPath: "../escape", content: "" }] } }, { "p.one": {} }), /not a plain relative path/u);
  for (const argument of ["--dangerously-skip-permissions", "--yolo", "--resume", "-c", "--permission-mode=bypassPermissions"]) {
    assert.match(await refusal({ "p.one": { args: [argument] } }, { "p.one": {} }), /which only CanvasTTY may pass/u);
  }
  assert.match(await refusal({ "p.one": { env: { SHARED: "1" } }, "p.two": { env: { SHARED: "2" } } },
    { "p.one": {}, "p.two": {} }), /Plugin p\.one and Plugin p\.two both set SHARED/u);
  assert.match(await refusal({ "p.one": { secretEnv: { TOKEN: "token" } } }, { "p.one": {} }), /without the secrets permission/u);
  assert.match(await refusal({ "p.one": { secretEnv: { TOKEN: "token" } } }, { "p.one": {} },
    [contributor("p.one", { secrets: true })]), /secret token is not set/u);
  assert.match(await refusal({}, { "gone.plugin": {} }, []), /Needs plugin gone\.plugin/u);
  assert.match(await refusal({ "p.one": { env: JSON.parse("{\"__proto__\":\"x\"}") } }, { "p.one": {} }), /env name __proto__ is invalid/u);
});

test("a plugin's instruction text that mentions permission words launches; the permission setting itself is refused", async (t) => {
  const rule = "developer_instructions=\"Never use --dangerously-bypass-approvals-and-sandbox or change approval_policy.\"";
  const prepare = async (args) => {
    const { pipeline } = await pipelineFixture(t, { contributors: [contributor("p.one")], answers: { "p.one": { args } } });
    return pipeline.prepare({ sessionId: "s", provider: "codex", profile: "normal", role: "agent", cwd, restoring: false, resume: false, options: { "p.one": {} } });
  };
  const allowed = await prepare(["-c", rule]);
  assert.equal(allowed.ok, true, allowed.reason);
  assert.deepEqual(allowed.args, ["-c", rule]);
  const refused = await prepare(["-c", "approval_policy=\"never\""]);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /which only CanvasTTY may pass/u);
});

test("env names: an inherited-looking name is an ordinary one, and Windows compares names without case", async (t) => {
  const { pipeline } = await pipelineFixture(t, {
    contributors: [contributor("p.one"), contributor("p.two")],
    answers: { "p.one": { env: { constructor: "a" } }, "p.two": { env: { toString: "b" } } }
  });
  const prepared = await pipeline.prepare({ sessionId: "s", provider: "claude", profile: "normal", role: "agent", cwd,
    restoring: false, resume: false, options: { "p.one": {}, "p.two": {} } });
  assert.equal(prepared.ok, true, prepared.reason);
  assert.equal(prepared.env.constructor, "a");
  assert.equal(prepared.env.toString, "b");
  assert.equal(envKey("Path", "win32"), envKey("PATH", "win32"));
  assert.notEqual(envKey("Path", "linux"), envKey("PATH", "linux"));
});

test("a card with options waits for its plugins; a refusal is shown on the card and nothing runs", async (t) => {
  const { pipeline } = await pipelineFixture(t, {
    contributors: [contributor("p.one")],
    answers: { "p.one": (context) => context.options.on
      ? { env: { EXTRA: "yes", EXTRA_FILE: "{launchFiles}/run.txt" }, args: ["--verbose"], files: [{ relPath: "run.txt", content: "x" }] }
      : { refuse: { reason: "turned off" } } }
  });
  const { manager, calls } = await managerFixture(t, pipeline);
  const started = manager.create({ provider: "claude", profile: "normal", cwd, position: at, launchOptions: { "p.one": {} } });
  assert.equal(calls.length, 0);
  assert.equal(started.exitCode, null);
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].options.env.EXTRA, "yes");
  assert.deepEqual(calls[0].args, ["--verbose"]);
  assert.equal(await readFile(calls[0].options.env.EXTRA_FILE, "utf8"), "x");
  calls[0].exit(0);
  await waitFor(() => stat(calls[0].options.env.EXTRA_FILE).then(() => false, () => true));

  const refused = manager.create({ provider: "claude", profile: "normal", cwd, position: at, launchOptions: { "p.one": { on: false } } });
  await waitFor(() => card(manager, refused.id).status === "failed");
  assert.equal(calls.length, 1);
  assert.match(card(manager, refused.id).failureDetails, /^Launch refused: Plugin p\.one: turned off/u);

  assert.throws(() => manager.create({ provider: "terminal", profile: "normal", cwd, position: at, launchOptions: { "p.one": {} } }),
    /plain terminal takes no launch options/u);
  const plain = manager.create({ provider: "claude", profile: "normal", cwd, position: at });
  assert.equal(calls.length, 2, "a launch without options is synchronous and unchanged");
  assert.equal(calls[1].options.env.EXTRA, undefined);
  assert.equal(plain.exitCode, null);
});

test("a timeout refuses the launch instead of starting it without the plugin", async (t) => {
  const { pipeline } = await pipelineFixture(t, {
    contributors: [contributor("slow.plugin")],
    answers: { "slow.plugin": () => new Promise(() => undefined) },
    timeoutMs: 60
  });
  const { manager, calls } = await managerFixture(t, pipeline);
  const created = manager.create({ provider: "claude", profile: "normal", cwd, position: at, launchOptions: { "slow.plugin": {} } });
  await waitFor(() => card(manager, created.id).status === "failed");
  assert.equal(calls.length, 0);
  assert.match(card(manager, created.id).failureDetails, /^Launch refused: Plugin slow\.plugin did not prepare the launch .* so it was not started/u);
});

test("a plugin variable that the core sets for the launch is refused", async (t) => {
  const { pipeline } = await pipelineFixture(t, {
    contributors: [contributor("p.one")],
    answers: { "p.one": { env: { TERM_PROGRAM_OVERRIDE: "x" } } }
  });
  // The provider CLI resolution sets PATH; a plugin may not replace the core's launch variables.
  const { manager, calls } = await managerFixture(t, {
    ...pipeline,
    normalizeOptions: pipeline.normalizeOptions.bind(pipeline),
    unavailable: pipeline.unavailable.bind(pipeline),
    forgetSession: pipeline.forgetSession.bind(pipeline),
    prepare: async (context) => {
      const prepared = await pipeline.prepare(context);
      return prepared.ok ? { ...prepared, env: { ...prepared.env, PATH: "/evil" }, envSources: { ...prepared.envSources, PATH: "Plugin p.one" } } : prepared;
    }
  });
  const created = manager.create({ provider: "claude", profile: "normal", cwd, position: at, launchOptions: { "p.one": {} } });
  await waitFor(() => card(manager, created.id).status === "failed");
  assert.equal(calls.length, 0);
  assert.match(card(manager, created.id).failureDetails, /Plugin p\.one sets PATH, which CanvasTTY sets for this launch/u);
});

test("secret env comes from the plugin's own secrets, reaches the child, and is masked everywhere else", async (t) => {
  const logged = [];
  for (const method of ["log", "info", "warn", "error"]) {
    const original = console[method];
    console[method] = (...args) => { logged.push(args.map(String).join(" ")); };
    t.after(() => { console[method] = original; });
  }
  const { pipeline, requests } = await pipelineFixture(t, {
    contributors: [contributor("p.keys", { secrets: true })],
    answers: { "p.keys": { secretEnv: { PROVIDER_API_KEY: "api-key" }, env: { PLAIN: "visible" } } },
    secrets: { "p.keys/api-key": SECRET }
  });
  const { manager, calls, events, storeDirectory } = await managerFixture(t, pipeline);
  const created = manager.create({ provider: "claude", profile: "normal", cwd, position: at, launchOptions: { "p.keys": {} } });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].options.env.PROVIDER_API_KEY, SECRET);
  calls[0].print(`env: PROVIDER_API_KEY=${SECRET} PLAIN=visible\n`);

  const control = new AgentControlService(manager);
  const observed = control.observe(created.id).output;
  // The combined source-range mask can also consume a high-entropy assignment label. Its kind and label retention
  // are presentation details; the secret, its fragments, and unrelated public output are the integration contract.
  assert.match(observed, /<redacted:(?:secret|assignment|high-entropy)> PLAIN=visible/u);
  assert.doesNotMatch(observed, new RegExp(SECRET, "u"));
  for (const fragment of [SECRET.slice(0, 13), SECRET.slice(-12)]) {
    assert.equal(observed.includes(fragment), false, "partial secret fragments must also remain masked");
  }
  calls[0].exit(1);
  assert.doesNotMatch(control.result(created.id).output, new RegExp(SECRET, "u"));
  assert.doesNotMatch(card(manager, created.id).failureDetails ?? "", new RegExp(SECRET, "u"));

  await manager.shutdown();
  const saved = await readFile(join(storeDirectory, "terminal-sessions.json"), "utf8");
  assert.doesNotMatch(saved, new RegExp(SECRET, "u"));
  assert.match(saved, /"p\.keys"/u);
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(SECRET, "u"), "the service never receives the value");
  assert.doesNotMatch(JSON.stringify(events.filter((event) => event.channel !== "terminal:data")), new RegExp(SECRET, "u"));
  assert.doesNotMatch(logged.join("\n"), new RegExp(SECRET, "u"));
});

test("options persist with the session, restart reuses them, and restore asks the plugin again", async (t) => {
  const { pipeline, requests } = await pipelineFixture(t, {
    contributors: [contributor("p.one", { launch: { fields: [{ key: "value", label: "V", kind: "text", default: "a" }] } })],
    answers: { "p.one": (context) => ({ env: { EXAMPLE_VALUE: context.options.value } }) }
  });
  const directory = await mkdtemp(join(tmpdir(), "canvastty-launch-persist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await managerFixture(t, pipeline, { directory });
  const created = first.manager.create({ provider: "claude", profile: "normal", cwd, position: at, launchOptions: { "p.one": { value: "kept" } } });
  await waitFor(() => first.calls.length === 1);
  first.calls[0].exit(0);
  first.manager.restart(created.id);
  await waitFor(() => first.calls.length === 2);
  assert.equal(first.calls[1].options.env.EXAMPLE_VALUE, "kept");
  await first.manager.shutdown();
  const [saved] = await new TerminalSessionStore(directory).load();
  assert.deepEqual(saved.options, { "p.one": { value: "kept" } });
  assert.equal(saved.lastState, "running");

  const second = await managerFixture(t, pipeline, { directory });
  await waitFor(() => second.calls.length === 1);
  assert.equal(second.calls[0].options.env.EXAMPLE_VALUE, "kept");
  assert.deepEqual(requests.map((request) => request.params.restoring), [false, false, true]);
  await second.manager.shutdown();
});

test("Reopen with a launch plugin starts fresh and forgets the old conversation", async (t) => {
  const conversation = "5f1c2a90-aa11-4b22-9c33-0d44e55f6677";
  const directory = await mkdtemp(join(tmpdir(), "canvastty-launch-reopen-"));
  await new TerminalSessionStore(directory).replace([{
    id: "reopened", provider: "claude", profile: "normal", role: "agent", title: "Agent", titleCustomized: false,
    cwd, position: at, size: { width: 700, height: 430 }, lastState: "running", restore: true,
    threadId: conversation, options: { "p.one": { on: true } }
  }]);
  const { pipeline } = await pipelineFixture(t, { contributors: [contributor("p.one")], answers: { "p.one": {} } });
  const { manager, calls } = await managerFixture(t, pipeline, { mode: "reopen", directory });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].args.includes(conversation), false);
  await manager.setSessionRestoreMode("continue");
  const [saved] = await new TerminalSessionStore(directory).load();
  assert.equal(saved.threadId, undefined);
  calls[0].exit(0);
  manager.restart("reopened", { resume: true });
  await waitFor(() => calls.length === 2);
  assert.equal(calls[1].args.includes(conversation), false);
});

test("restore without the plugin holds the card stopped with its reason and keeps the record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-launch-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await new TerminalSessionStore(directory).replace([{
    id: "needs-plugin", provider: "claude", profile: "normal", role: "agent", title: "Agent", titleCustomized: false,
    cwd, position: at, size: { width: 700, height: 430 }, lastState: "running", restore: true,
    threadId: "5f1c2a90-aa11-4b22-9c33-0d44e55f6677", options: { "gone.plugin": { on: true } }
  }]);
  const { pipeline } = await pipelineFixture(t, { contributors: [], answers: {} });
  const { manager, calls } = await managerFixture(t, pipeline, { directory });
  const restored = card(manager, "needs-plugin");
  assert.equal(calls.length, 0);
  assert.equal(restored.status, "failed");
  assert.equal(restored.restoreNote, "plugin-unavailable");
  assert.match(restored.failureDetails, /^Launch refused: needs plugin gone\.plugin/u);
  assert.throws(() => manager.restart("needs-plugin"), /needs plugin gone\.plugin/u);
  await manager.shutdown();
  const [kept] = await new TerminalSessionStore(directory).load();
  assert.equal(kept.lastState, "running");
  assert.deepEqual(kept.options, { "gone.plugin": { on: true } });
  assert.equal(kept.threadId, "5f1c2a90-aa11-4b22-9c33-0d44e55f6677");
});

test("end to end: the example service prepares a launch over JSON-RPC", async (t) => {
  const root = fileURLToPath(new URL(".", example));
  const entryPath = join(root, "services", "launcher.mjs");
  const dataDir = await mkdtemp(join(tmpdir(), "canvastty-launch-e2e-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined }
  });
  t.after(() => supervisor.dispose());
  const pluginId = exampleManifest.id;
  await supervisor.sync([{ pluginId, serviceId: "launcher", root, entryPath,
    sha256: createHash("sha256").update(await readFile(entryPath)).digest("hex"), dataDir, permissions: ["launch:contribute"] }]);
  await assert.rejects(supervisor.request(pluginId, "launcher", "canvastty.launch.prepare", {}), /method is invalid/u);
  const launch = validatePluginManifest(exampleManifest).services[0].launch;
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId, pluginName: "Launch Env", serviceId: "launcher", launch, secrets: false }],
    call: (id, serviceId, method, params, budget) => supervisor.hostCall(id, serviceId, method, params, budget),
    secret: async () => null,
    runsRoot: join(dataDir, "runs")
  });
  const context = (values) => ({ sessionId: "e2e", provider: "claude", profile: "normal", role: "agent", cwd,
    restoring: true, resume: false, options: pipeline.normalizeOptions("claude", { [pluginId]: values }) });
  const on = await pipeline.prepare(context({ mode: "loud" }));
  assert.equal(on.ok, true);
  assert.equal(on.env.CTTY_LAUNCH_EXAMPLE, "HELLO");
  assert.deepEqual(on.args, ["--verbose"]);
  assert.equal(await readFile(on.env.CTTY_LAUNCH_EXAMPLE_FILE, "utf8"), "claude restored\n");
  const off = await pipeline.prepare(context({ enabled: false }));
  assert.deepEqual(off.ok && [off.env, off.args], [{}, []]);
  const empty = await pipeline.prepare(context({ greeting: "" }));
  assert.match(empty.reason, /Launch Env: Value is empty/u);
});
