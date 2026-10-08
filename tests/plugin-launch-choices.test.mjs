import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateOrchestrationArguments } from "../src/agent-browser/orchestration-catalog.mjs";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { withServiceOptions } from "../src/renderer/src/features/launcher/launchFieldOptions.ts";

const example = new URL("../examples/plugins/launch-env/", import.meta.url);
const exampleManifest = JSON.parse(await readFile(new URL("canvastty.plugin.json", example), "utf8"));

const accountField = {
  key: "account", label: "Account", kind: "select", optionsFrom: "service", default: "none",
  options: [{ value: "none", label: "Own sign-in" }]
};
const contributor = (extra = {}) => ({
  pluginId: "accounts", pluginName: "Accounts", serviceId: "svc",
  launch: { appliesTo: ["claude", "codex"], fields: [accountField, { key: "fast", label: "Fast", kind: "boolean" }] },
  secrets: false, ...extra
});

async function pipeline(t, answer, contributors = [contributor()]) {
  const runsRoot = await mkdtemp(join(tmpdir(), "canvastty-launch-choices-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const calls = [];
  return {
    calls,
    pipeline: new LaunchPipeline({
      contributors: () => contributors,
      call: async (pluginId, serviceId, method, params, timeoutMs) => {
        calls.push({ pluginId, serviceId, method, params, timeoutMs });
        return typeof answer === "function" ? answer(params) : answer;
      },
      secret: async () => null,
      runsRoot
    })
  };
}

test("a select may take its choices from the service; other kinds and values are refused", () => {
  const manifest = (field) => ({
    apiVersion: 2, id: "com.example.choices", name: "Choices", version: "1.0.0", description: "d", author: "a",
    permissions: ["launch:contribute"], contributions: [],
    services: [{ id: "svc", title: "S", entry: "services/s.mjs", launch: { fields: [field] } }]
  });
  const checked = validatePluginManifest(manifest(accountField));
  assert.equal(checked.services[0].launch.fields[0].optionsFrom, "service");
  assert.throws(() => validatePluginManifest(manifest({ key: "t", label: "T", kind: "text", optionsFrom: "service" })), /optionsFrom must be "service" on a select/);
  assert.throws(() => validatePluginManifest(manifest({ ...accountField, optionsFrom: "storage" })), /optionsFrom/);
  // The declared list stays required: it is what the launcher shows when the service does not answer.
  assert.throws(() => validatePluginManifest(manifest({ ...accountField, options: [] })), /1 to 16 options/);
  const exampleField = validatePluginManifest(exampleManifest).services[0].launch.fields.find((field) => field.key === "profile");
  assert.equal(exampleField.optionsFrom, "service");
});

test("the launcher's extra choices come from canvastty.launch.options, cleaned and bounded", async (t) => {
  const { pipeline: choices, calls } = await pipeline(t, {
    account: [
      { value: "glm", label: "Claude Code · GLM" },
      { value: "none", label: "duplicate of the declared choice" },
      { value: "glm", label: "duplicate" },
      { value: "bad\nvalue", label: "control characters" },
      { value: "x".repeat(201), label: "too long" },
      { value: "blank", label: "   " },
      { value: "ollama", label: "Ollama\u0007 qwen" },
      "not an object",
      ...Array.from({ length: 70 }, (_unused, index) => ({ value: `a${index}`, label: `A${index}` }))
    ],
    fast: [{ value: "x", label: "not a service select" }]
  });
  const offered = await choices.fieldOptions("accounts", "claude");
  assert.deepEqual(calls.map(({ method, params, timeoutMs }) => ({ method, params, timeoutMs })),
    [{ method: "canvastty.launch.options", params: { provider: "claude", fields: ["account"] }, timeoutMs: 3_000 }]);
  assert.deepEqual(Object.keys(offered), ["account"]);
  assert.deepEqual(offered.account.slice(0, 2), [{ value: "glm", label: "Claude Code · GLM" }, { value: "ollama", label: "Ollama  qwen" }]);
  // At most 64 entries are read from the answer, invalid ones are dropped.
  assert.equal(offered.account.length, 2 + 64 - 8);
  // Not for this agent, unknown plugin, terminal: nothing asked.
  assert.deepEqual(await choices.fieldOptions("accounts", "opencode"), {});
  assert.deepEqual(await choices.fieldOptions("missing", "claude"), {});
  assert.deepEqual(await choices.fieldOptions("accounts", "terminal"), {});
  assert.equal(calls.length, 1);
});

test("a failing, silent or odd service leaves the declared choices only", async (t) => {
  for (const answer of [() => { throw new Error("boom"); }, null, [], { account: "glm" }]) {
    const { pipeline: choices } = await pipeline(t, answer);
    assert.deepEqual(await choices.fieldOptions("accounts", "codex"), {});
  }
  const fields = contributor().launch.fields;
  assert.deepEqual(withServiceOptions(fields, undefined), fields);
  const merged = withServiceOptions(fields, { account: [{ value: "none", label: "again" }, { value: "glm", label: "GLM" }], fast: [{ value: "no", label: "No" }] });
  assert.deepEqual(merged[0].options, [{ value: "none", label: "Own sign-in" }, { value: "glm", label: "GLM" }]);
  assert.equal(merged[1].options, undefined);
});

test("a service select saves any short text; the service checks it when it prepares", async (t) => {
  const { pipeline: choices } = await pipeline(t, null, [contributor({
    launch: { fields: [accountField, { key: "mode", label: "Mode", kind: "select", options: [{ value: "a", label: "A" }] }] }
  })]);
  assert.deepEqual(choices.normalizeOptions("claude", { accounts: { account: "since-deleted" } }), { accounts: { account: "since-deleted", mode: "a" } });
  assert.throws(() => choices.normalizeOptions("claude", { accounts: { account: "bad\u0000" } }), /Account is invalid/);
  assert.throws(() => choices.normalizeOptions("claude", { accounts: { account: "x".repeat(201) } }), /Account is invalid/);
  assert.throws(() => choices.normalizeOptions("claude", { accounts: { mode: "b" } }), /Mode is invalid/);
});

test("the example service offers its profiles and refuses one that is gone", async (t) => {
  const root = fileURLToPath(example);
  const entryPath = join(root, "services", "launcher.mjs");
  const dataDir = await mkdtemp(join(tmpdir(), "canvastty-choices-data-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined }
  });
  t.after(() => supervisor.dispose());
  const checked = validatePluginManifest(exampleManifest);
  await supervisor.sync([{ pluginId: checked.id, serviceId: "launcher", root, entryPath,
    sha256: createHash("sha256").update(await readFile(entryPath)).digest("hex"), dataDir, permissions: ["launch:contribute"] }]);
  const runsRoot = join(dataDir, "runs");
  const choices = new LaunchPipeline({
    contributors: () => [{ pluginId: checked.id, pluginName: checked.name, serviceId: "launcher", launch: checked.services[0].launch, secrets: false }],
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    secret: async () => null,
    runsRoot
  });
  assert.deepEqual(await choices.fieldOptions(checked.id, "claude"), { profile: [{ value: "work", label: "Work" }, { value: "home", label: "Home" }, { value: "local", label: "Local model" }] });
  const context = { sessionId: "s1", provider: "claude", profile: "normal", role: "agent", cwd: process.cwd(), restoring: false, resume: false, environment: null };
  const work = await choices.prepare({ ...context, options: choices.normalizeOptions("claude", { [checked.id]: { profile: "work" } }) });
  assert.equal(work.ok, true);
  assert.equal(work.env.CTTY_LAUNCH_PROFILE, "work");
  assert.equal(work.thirdPartyModel, false);
  await work.cleanup();
  const local = await choices.prepare({ ...context, profile: "auto", options: choices.normalizeOptions("claude", { [checked.id]: { profile: "local" } }) });
  assert.equal(local.thirdPartyModel, true, "the example marks its local-model profile");
  await local.cleanup();
  const gone = await choices.prepare({ ...context, options: choices.normalizeOptions("claude", { [checked.id]: { profile: "office" } }) });
  assert.deepEqual(gone, { ok: false, reason: "Launch Env: Profile office no longer exists; choose another one." });
});

test("spawn_agent takes plugin launch options and hands them to the launch", () => {
  const base = { provider: "claude", cwd: "/work" };
  const ok = validateOrchestrationArguments("spawn_agent", { ...base, launchOptions: { "canvastty-accounts": { account: "glm", trustFolder: false } } });
  assert.deepEqual(ok, { ok: true, value: { ...base, launchOptions: { "canvastty-accounts": { account: "glm", trustFolder: false } } } });
  for (const launchOptions of [[], "glm", { a: [] }, { a: { n: 1 } }, { a: { nested: { x: "y" } } }, { a: null },
    Object.fromEntries(Array.from({ length: 17 }, (_unused, index) => [`p${index}`, {}])), { a: { big: "x".repeat(17_000) } }]) {
    assert.equal(validateOrchestrationArguments("spawn_agent", { ...base, launchOptions }).ok, false, JSON.stringify(launchOptions).slice(0, 60));
  }
  const created = [];
  const parent = { id: "orch", provider: "claude", role: "orchestrator", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 }, exitCode: null };
  const terminals = {
    allowedExecutionTargets: () => null,
    get: (id) => (id === "orch" ? parent : undefined),
    getMetadata: (id) => (id === "orch" ? parent : null),
    listMetadata: () => [parent],
    create: (request) => { created.push(request); return { id: "child", ...request, status: "starting", title: "c" }; }
  };
  const control = new AgentControlService(terminals);
  control.spawn({ parentSessionId: "orch", provider: "codex", cwd: process.cwd(), launchOptions: { "canvastty-accounts": { account: "ollama" } } });
  control.spawn({ parentSessionId: "orch", provider: "codex", cwd: process.cwd() });
  assert.deepEqual(created[0].launchOptions, { "canvastty-accounts": { account: "ollama" } });
  assert.equal("launchOptions" in created[1], false);
  assert.equal(created[0].role, "subagent");
});

test("Claude gets one --settings: a plugin's env joins the hooks' JSON; approval and hook keys stay the core's", async () => {
  const { coreOwnedLaunchArgument, mergeClaudeInlineSettings, resolveTerminalLaunch } = await import("../src/main/services/terminalLaunch.ts");
  const hooks = ["--settings", JSON.stringify({ showStatusInTerminalTab: true, hooks: { Stop: [{ hooks: [{ type: "command", command: "a" }] }] } })];
  const plugin = ["--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" } }), "--disallowedTools", "WebSearch"];
  const merged = mergeClaudeInlineSettings([...hooks, "--mcp-config", "{}", ...plugin]);
  assert.equal(merged.filter((arg) => arg === "--settings").length, 1);
  assert.deepEqual(JSON.parse(merged[1]), { showStatusInTerminalTab: true, hooks: { Stop: [{ hooks: [{ type: "command", command: "a" }] }] }, env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" } });
  assert.deepEqual(merged.slice(2), ["--mcp-config", "{}", "--disallowedTools", "WebSearch"]);
  assert.deepEqual(mergeClaudeInlineSettings(["--settings", "/work/settings.json", ...plugin]), ["--settings", "/work/settings.json", ...plugin]);
  const cli = { state: "available", provider: "claude", executable: "/resolved/claude", launcher: "native", environment: {}, checked: [] };
  const launch = resolveTerminalLaunch("claude", "normal", [...hooks, ...plugin], { providerCli: cli });
  assert.equal(launch.args.filter((arg) => arg === "--settings").length, 1);
  // Other agents' arguments are left as they are.
  const codex = resolveTerminalLaunch("codex", "normal", ["--settings", "{}", "--settings", "{}"], { providerCli: { ...cli, provider: "codex" } });
  assert.equal(codex.args.filter((arg) => arg === "--settings").length, 2);
  assert.equal(coreOwnedLaunchArgument("claude", JSON.stringify({ env: { A: "1" } })), false);
  for (const key of ["permissions", "hooks", "disableAllHooks", "sandbox", "defaultMode", "apiKeyHelper"]) {
    assert.equal(coreOwnedLaunchArgument("claude", JSON.stringify({ env: {}, [key]: {} })), true, key);
  }
  assert.equal(coreOwnedLaunchArgument("codex", JSON.stringify({ hooks: {} })), false);
});
