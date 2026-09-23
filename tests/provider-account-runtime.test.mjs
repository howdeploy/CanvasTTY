import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { resolveTerminalLaunch } from "../src/main/services/terminalLaunch.ts";
import { createProviderCliRegistry } from "../src/main/services/providerCliRegistry.ts";
import { normalizeApiProfiles } from "../src/main/services/SettingsStore.ts";

const resolution = (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: {}, checked: [] });
test("a requested model reaches the actual PTY argv", () => {
  const calls = [];
  const manager = new TerminalManager(() => {}, { get: resolution }, undefined, undefined, false, (command, args, options) => {
    calls.push({ command, args, options });
    return { onData() {}, onExit() {}, kill() {} };
  });
  manager.create({ provider: "codex", model: "chosen-model", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 } });
  assert.deepEqual(calls[0].args, ["--model", "chosen-model"]);
  manager.disposeAll();
});

test("Cursor uses its measured permission flag and unique executable across PATH", () => {
  const registry = createProviderCliRegistry({ platform: "linux", homeDirectory: "/home/runner", environment: { PATH: "/grok/bin:/cursor/bin" }, directoryExists: () => true,
    inspectCandidate: (path) => ["/grok/bin/agent", "/cursor/bin/cursor-agent"].includes(path) ? null : "missing" });
  assert.equal(registry.get("cursor").executable, "/cursor/bin/cursor-agent");
  assert.deepEqual(resolveTerminalLaunch("cursor", "yolo", [], { providerCli: resolution("cursor") }).args, ["--force"]);
});

test("settings retain two hundred distinct API profile references", () => {
  const profiles = Array.from({ length: 200 }, (_, n) => ({ id: `profile-${n}`, name: `Profile ${n}`, protocol: "openai-compatible", secretRef: "OPENAI_API_KEY", baseUrl: "https://api.example/v1" }));
  assert.equal(normalizeApiProfiles(profiles, []).length, 200);
});

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderAccountLaunchService } from "../src/main/services/ProviderAccountLaunchService.ts";
import { SessionLaunchPolicy, selectLaunchAccount } from "../src/main/services/SessionLaunchPolicy.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { accountRouteBinding, accountRouteMaxDataClass, canonicalApiUrl } from "../src/shared/providerAccountPolicy.ts";
import { normalizeProviderAccounts } from "../src/main/services/SettingsStore.ts";

async function runtimeFixture(t, patch = {}, extra = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "canvastty-account-runtime-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let settings = { providerAccounts: [], apiProfiles: [], remoteHosts: [], pathPolicies: [], defaultDataClass: "D0", maxAccountsPerProviderPerHost: 1,
    agentBudgets: { maxLocalAgents: 4, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 }, ...patch };
  const calls = [], exits = [], writes = [];
  let generation = 0;
  const secrets = { get: async () => "unit-test-key", get generation() { return generation; }, ...extra.secrets };
  const service = new ProviderAccountLaunchService(() => settings, secrets, { temporaryRoot: directory, ...extra.options });
  const manager = new TerminalManager(() => {}, { get: resolution }, extra.browser, extra.runtime, false, (command, args, options) => {
    calls.push({ command, args, options });
    if (extra.failSpawn) throw new Error("fake PTY spawn failed");
    return { onData() {}, onExit(callback) { exits.push(callback); }, write(data) { writes.push(data); }, kill() {}, resize() {} };
  });
  manager.configureLaunchPolicy(new SessionLaunchPolicy(() => settings));
  manager.configureRemoteHosts((id) => settings.remoteHosts.find((h) => h.id === id));
  manager.configureProviderLaunch(service);
  t.after(() => manager.disposeAll());
  const create = (request = {}) => manager.create({ provider: "codex", profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 }, ...request });
  return { directory, calls, exits, writes, manager, service, secrets, create, settings: () => settings, update: (value) => { settings = { ...settings, ...value }; }, bumpSecret: () => generation++ };
}
const api = (protocol = "openai-compatible") => ({ id: "backend", name: "Backend", protocol, baseUrl: "https://api.example/v1", secretRef: "OPENAI_API_KEY", defaultModel: "chosen-model" });
const apiAccount = (provider = "opencode", extra = {}) => ({ id: "account", label: "Account", provider, binding: { kind: "api-profile", profileId: "backend" }, ...extra });
function assess(account, profiles = [], patch = {}) {
  return { profile: { training: "none", retention: "bounded", thirdPartyProcessing: "no", contractualMode: "api", ...patch },
    evidence: { kind: "user-attested", reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: "Explicit administrator route assessment", binding: accountRouteBinding(account, profiles), models: ["chosen-model"] } };
}

test("API route evidence replaces the unrelated CLI consumer cap and binds model and endpoint", () => {
  const profile = api(), account = apiAccount();
  account.assessment = assess(account, [profile]);
  const settings = { providerAccounts: [account], apiProfiles: [profile], remoteHosts: [], pathPolicies: [], defaultDataClass: "D2", maxAccountsPerProviderPerHost: 1 };
  const policy = new SessionLaunchPolicy(() => settings);
  const request = { provider: "opencode", cwd: process.cwd(), profile: "normal" };
  assert.equal(policy.classify(request).model, "chosen-model");
  assert.equal(policy.classify(request).accountId, account.id);
  assert.equal(accountRouteMaxDataClass(account, [profile]), "D2");
  assert.throws(() => policy.classify({ ...request, model: "unreviewed" }), /selected model/);
  profile.baseUrl = "https://different.example/v1";
  assert.throws(() => policy.classify(request), /stale/);
  delete account.assessment;
  assert.equal(accountRouteMaxDataClass(account, [profile]), "D0");
  assert.throws(() => policy.classify(request), /at most D0/);
});

test("invalid evidence stays a launch denial after normalization and cannot become provider defaults", () => {
  const normalized = normalizeProviderAccounts([{ id: "private", label: "Private", provider: "devin", assessment: { profile: { training: "none" } } }], []);
  assert.equal(normalized[0].assessmentInvalid, true);
  assert.throws(() => accountRouteMaxDataClass(normalized[0]), /invalid/);
});

test("trusted self-hosting is explicit; plain loopback URL does not raise trust", () => {
  const profile = { ...api(), baseUrl: "http://127.0.0.1:8000/v1" }, account = apiAccount();
  assert.equal(canonicalApiUrl(profile.baseUrl), profile.baseUrl);
  assert.equal(canonicalApiUrl("http://[::1]:8000/v1"), "http://[::1]:8000/v1");
  assert.throws(() => canonicalApiUrl("http://remote.example/v1"), /HTTPS/);
  assert.equal(accountRouteMaxDataClass(account, [profile]), "D0");
  account.assessment = assess(account, [profile], { contractualMode: "self-hosted", training: "unknown", retention: "unknown" });
  assert.equal(accountRouteMaxDataClass(account, [profile]), "D0");
  account.assessment.trustedSelfHosted = true;
  assert.equal(accountRouteMaxDataClass(account, [profile]), "D3");
  account.shared = true;
  assert.equal(accountRouteMaxDataClass(account, [profile]), "D1");
});

test("unsupported configured account cannot disappear into ambient credentials", () => {
  assert.throws(() => selectLaunchAccount([apiAccount()], "minimax", undefined, undefined, "D0", undefined, [api("google")]), /account|binding|runtime/i);
  const constrained = { id: "small", provider: "codex", label: "Small", models: ["allowed-mini"], binding: { kind: "cli-home", directory: "/home/runner/codex" } };
  assert.throws(() => selectLaunchAccount([constrained], "codex", undefined, undefined, "D0"), /model/);
});

test("both Kimi CLI families use the selected home and cannot inherit backend/auth overrides", async (t) => {
  const names = ["KIMI_SHARE_DIR", "KIMI_CODE_CUSTOM_HEADERS", "KIMI_CODE_BASE_URL", "KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL"];
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }));
  for (const name of names) process.env[name] = "fixture-inherited-override";
  const f = await runtimeFixture(t);
  f.update({ providerAccounts: [{ id: "kimi-home", provider: "kimi", label: "Kimi", binding: { kind: "cli-home", directory: f.directory } }] });
  const session = f.create({ provider: "kimi" }); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 1, f.manager.list()[0].failureDetails);
  assert.equal(f.calls[0].options.env.KIMI_SHARE_DIR, f.directory);
  assert.equal(f.calls[0].options.env.KIMI_CODE_HOME, f.directory);
  for (const name of names.slice(1)) assert.equal(f.calls[0].options.env[name], undefined, name);
});

test("remote Kimi quotes both home selectors and clears inherited auth overrides", async (t) => {
  const directory = "/home/runner/accounts/kimi' selected";
  const host = { id: "remote", label: "Remote", sshHost: "remote.invalid", maxDataClass: "D1", workspaces: [{ localPath: process.cwd(), remotePath: "/work" }] };
  const account = { id: "kimi-home", label: "Kimi", provider: "kimi", hostId: "remote", binding: { kind: "cli-home", directory } };
  const f = await runtimeFixture(t, { remoteHosts: [host], providerAccounts: [account] }, { options: { discovery: { discover: async () => ({ reachable: true, providers: [{ provider: "kimi", installed: true, path: "/fake/kimi" }] }) } } });
  const session = f.create({ provider: "kimi", hostId: "remote" }); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 1, f.manager.list()[0].failureDetails);
  const remote = f.calls[0].args.at(-1);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const name of ["KIMI_CODE_HOME", "KIMI_SHARE_DIR"]) assert.ok(remote.includes(quote(`${name}=${directory}`)));
  assert.ok(remote.includes("'-u' 'KIMI_CODE_CUSTOM_HEADERS'"));
});

for (const [baseUrl, expected] of [
  ["https://api.anthropic.com", "https://api.anthropic.com/v1"],
  ["https://api.anthropic.com/", "https://api.anthropic.com/v1"],
  ["https://api.anthropic.com/v1", "https://api.anthropic.com/v1"],
  ["https://api.anthropic.com/proxy", "https://api.anthropic.com/proxy"],
  ["https://api.anthropic.com:8443", "https://api.anthropic.com:8443"],
  ["https://relay.example", "https://relay.example"]
]) test(`OpenCode Anthropic prefix preserves the configured endpoint contract: ${baseUrl}`, async (t) => {
  const f = await runtimeFixture(t, { apiProfiles: [{ ...api("anthropic-compatible"), baseUrl }], providerAccounts: [apiAccount()] });
  const session = f.create({ provider: "opencode" }); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 1, f.manager.list()[0].failureDetails);
  const config = Object.values(JSON.parse(f.calls[0].options.env.OPENCODE_CONFIG_CONTENT).provider)[0];
  assert.equal(config.options.baseURL, expected);
});

test("MiniMax preserves the unversioned Anthropic root for its own SDK", async (t) => {
  const f = await runtimeFixture(t, { apiProfiles: [{ ...api("anthropic-compatible"), baseUrl: "https://api.anthropic.com" }], providerAccounts: [apiAccount("minimax")] });
  const session = f.create({ provider: "minimax" }); await f.manager.waitForLaunch(session.id);
  const config = JSON.parse(await readFile(join(f.calls[0].options.env.MINIMAX_DATA_DIR, "config.yaml"), "utf8"));
  assert.equal(Object.values(config.custom_provider)[0].options.baseURL, "https://api.anthropic.com");
});

test("Google profile selects the bundled OpenCode SDK and passes its scoped key only in the child environment", async (t) => {
  const profile = { ...api("google"), baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
  assert.equal(selectLaunchAccount([apiAccount()], "opencode", undefined, undefined, "D0", undefined, [profile]).id, "account");
  for (const runtime of ["minimax", "omp"]) assert.throws(() => selectLaunchAccount([apiAccount()], runtime, undefined, undefined, "D0", undefined, [profile]), /supported binding/);
  const f = await runtimeFixture(t, { apiProfiles: [profile], providerAccounts: [apiAccount()] });
  const session = f.create({ provider: "opencode" }); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 1, f.manager.list()[0].failureDetails);
  const { args, options } = f.calls[0], config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
  const backend = Object.values(config.provider)[0];
  assert.equal(backend.npm, "@ai-sdk/google"); assert.equal(backend.options.baseURL, profile.baseUrl);
  assert.equal(backend.options.apiKey, "{env:CANVASTTY_PROFILE_API_KEY}");
  assert.equal(options.env.CANVASTTY_PROFILE_API_KEY, "unit-test-key");
  assert.equal(args[args.indexOf("--model") + 1], config.model);
  assert.equal(JSON.stringify({ args, config, sessions: f.manager.list() }).includes("unit-test-key"), false);
});

test("one API account can serve multiple runtimes but duplicate key/profile aliases cannot create identities", () => {
  const profile = api(), account = apiAccount();
  assert.equal(selectLaunchAccount([account], "minimax", undefined, undefined, "D0", undefined, [profile]).id, account.id);
  assert.equal(selectLaunchAccount([account], "omp", undefined, undefined, "D0", undefined, [profile]).id, account.id);
  assert.throws(() => selectLaunchAccount([account, { ...account, id: "alias", provider: "omp", hostId: "remote" }], "opencode", undefined, undefined, "D0", undefined, [profile]), /same host|Duplicate/);
  const second = { ...profile, id: "second", secretRef: "DEEPSEEK_API_KEY" };
  const other = { ...account, id: "second-account", provider: "minimax", binding: { kind: "api-profile", profileId: "second" } };
  assert.throws(() => selectLaunchAccount([account, other], "opencode", undefined, undefined, "D0", { limit: 1 }, [profile, second]), /account limit/);
});

for (const provider of ["opencode", "minimax", "omp"]) test(`${provider} actually launches its API model and cleans private configuration after exit`, async (t) => {
  const f = await runtimeFixture(t, { apiProfiles: [api()], providerAccounts: [apiAccount(provider)] });
  const session = f.create({ provider });
  f.manager.input(session.id, "pending task\r");
  assert.equal(f.calls.length, 0);
  await f.manager.waitForLaunch(session.id);
  assert.equal(f.manager.list()[0].exitCode, null, f.manager.list()[0].failureDetails);
  assert.equal(f.calls.length, 1);
  const { args, options } = f.calls[0];
  assert.equal(JSON.stringify(args).includes("unit-test-key"), false);
  assert.equal(JSON.stringify(f.manager.list()).includes("unit-test-key"), false);
  assert.deepEqual(f.writes, ["pending task\r"]);
  let temporary;
  if (provider === "opencode") {
    const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(args[args.indexOf("--model") + 1], config.model);
    assert.ok(config.model.endsWith("/chosen-model"));
    assert.equal(Object.values(config.provider)[0].options.apiKey, "{env:CANVASTTY_PROFILE_API_KEY}");
    assert.equal(options.env.CANVASTTY_PROFILE_API_KEY, "unit-test-key");
  } else {
    temporary = options.env[provider === "minimax" ? "MINIMAX_DATA_DIR" : "PI_CODING_AGENT_DIR"];
    assert.equal((await stat(temporary)).mode & 0o777, 0o700);
    const path = join(temporary, provider === "minimax" ? "config.yaml" : "models.yml");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const config = JSON.parse(await readFile(path, "utf8"));
    if (provider === "minimax") {
      assert.equal(args.includes("--model"), false);
      assert.match(config.defaultModel, /^custom_provider:canvastty_.*\/chosen-model$/);
      assert.equal(Object.values(config.custom_provider)[0].options.apiKey, "unit-test-key");
    } else {
      assert.equal(options.env.OMP_PROFILE, ""); assert.equal(options.env.PI_PROFILE, "");
      assert.equal(Object.values(config.providers)[0].apiKey, "CANVASTTY_PROFILE_API_KEY");
      assert.match(args[args.indexOf("--model") + 1], /^canvastty_.*\/chosen-model$/);
    }
  }
  f.exits[0]({ exitCode: 0 });
  await new Promise((r) => setTimeout(r, 10));
  if (temporary) await assert.rejects(stat(temporary), /ENOENT/);
});

test("local selected home clears conflicting API and Claude keychain overrides without reading credentials", async (t) => {
  const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR };
  process.env.ANTHROPIC_API_KEY = "ambient-key";
  process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/wrong-account";
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const f = await runtimeFixture(t);
  f.update({ providerAccounts: [{ id: "claude-account", provider: "claude", label: "Claude", binding: { kind: "cli-home", directory: f.directory } }] });
  const session = f.create({ provider: "claude", model: "claude-selected" });
  await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls[0].options.env.CLAUDE_CONFIG_DIR, f.directory);
  assert.equal(f.calls[0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
  assert.equal(f.calls[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(f.calls[0].args, ["--model", "claude-selected"]);
});

test("noncanonical homes fail before spawn and custom home adapters never prepare global overlays", async (t) => {
  let overlays = 0;
  const f = await runtimeFixture(t, {}, { runtime: { prepareLaunch() { overlays++; throw new Error("global overlay should not run"); }, currentStatus() { return null; } } });
  const alias = join(f.directory, "alias");
  await symlink(f.directory, alias);
  f.update({ providerAccounts: [{ id: "home", provider: "hermes", label: "Hermes", binding: { kind: "cli-home", directory: alias } }] });
  let session = f.create({ provider: "hermes" });
  await f.manager.waitForLaunch(session.id);
  assert.match(f.manager.list()[0].failureDetails, /canonical/);
  assert.equal(f.calls.length, 0);
  f.update({ providerAccounts: [{ id: "home", provider: "hermes", label: "Hermes", binding: { kind: "cli-home", directory: f.directory } }] });
  session = f.manager.restart(session.id);
  await f.manager.waitForLaunch(session.id);
  assert.equal(overlays, 0);
  assert.deepEqual(f.calls[0].args, ["chat"]);
  assert.match(f.manager.list()[0].integrationNote, /PTY\/process/);
});

test("async launch reservations count against budgets and cannot spawn after disposal", async (t) => {
  let resolveKey;
  const key = new Promise((resolve) => { resolveKey = resolve; });
  const f = await runtimeFixture(t, { apiProfiles: [api()], providerAccounts: [apiAccount()], agentBudgets: { maxLocalAgents: 1, maxRemoteAgentsPerHost: 1, maxChildren: 1, maxDepth: 1 } }, { secrets: { get: () => key } });
  const session = f.create({ provider: "opencode" });
  assert.throws(() => f.create({ provider: "opencode" }), /concurrency/);
  await Promise.resolve();
  const task = f.manager.waitForLaunch(session.id);
  f.manager.dispose(session.id);
  resolveKey("unit-test-key");
  await task;
  assert.equal(f.calls.length, 0);
});

test("settings mutation while reading a key invalidates prepared launch instead of using stale credentials", async (t) => {
  let resolveKey;
  const key = new Promise((resolve) => { resolveKey = resolve; });
  const f = await runtimeFixture(t, { apiProfiles: [api()], providerAccounts: [apiAccount()] }, { secrets: { get: () => key } });
  const session = f.create({ provider: "opencode" });
  await Promise.resolve();
  f.update({ apiProfiles: [{ ...api(), baseUrl: "https://changed.example/v1" }] });
  resolveKey("unit-test-key");
  await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 0);
  assert.match(f.manager.list()[0].failureDetails, /binding changed/);
});

test("remote launch uses discovered executable and quoted model/profile/home without forwarding local keys", async (t) => {
  const host = { id: "remote", label: "Remote", sshHost: "remote.invalid", maxDataClass: "D1", workspaces: [{ localPath: process.cwd(), remotePath: "/work" }] };
  const account = { id: "remote-account", label: "Account", provider: "codex", hostId: "remote", binding: { kind: "cli-home", directory: "/home/runner/accounts/codex" } };
  const f = await runtimeFixture(t, { remoteHosts: [host], providerAccounts: [account] }, { options: { discovery: { discover: async () => ({ reachable: true, providers: [{ provider: "codex", installed: true, path: "/custom bin/codex" }] }) } }, secrets: { get: async () => { throw new Error("must not read local vault"); } } });
  const model = "model'$(echo never)";
  const session = f.create({ hostId: "remote", model, profile: "yolo" });
  await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls[0].command, "ssh");
  const remote = f.calls[0].args.at(-1);
  assert.ok(remote.includes("'/custom bin/codex'"));
  assert.ok(remote.includes("'--model' 'model'\\''$(echo never)'"));
  assert.ok(remote.includes("'--dangerously-bypass-approvals-and-sandbox'"));
  assert.ok(remote.includes("'CODEX_HOME=/home/runner/accounts/codex'"));
  assert.ok(!remote.includes("unit-test-key"));
});

test("remote API binding and missing selected home binding fail closed before any process", async (t) => {
  const f = await runtimeFixture(t, { providerAccounts: [{ id: "legacy", label: "Legacy", provider: "codex" }] });
  const session = f.create();
  await f.manager.waitForLaunch(session.id);
  assert.match(f.manager.list()[0].failureDetails, /explicit supported authentication binding/);
  assert.equal(f.calls.length, 0);
  const profile = { ...api(), hostId: "remote" }, account = apiAccount("opencode", { hostId: "remote" });
  f.update({ providerAccounts: [account], apiProfiles: [profile] });
  await assert.rejects(f.service.prepare({ ...session, provider: "opencode", accountId: account.id, hostId: "remote" }, false), /never forwarded/);
});

test("oversized initial prompt is rejected before a child reservation is created", async (t) => {
  const f = await runtimeFixture(t);
  const parent = f.create({ role: "orchestrator" });
  const control = new AgentControlService(f.manager);
  assert.throws(() => control.spawn({ provider: "codex", cwd: process.cwd(), parentSessionId: parent.id, initialPrompt: "x".repeat(131072) }), /Initial agent prompt/);
  assert.equal(f.manager.list().length, 1);
});

test("removing an unrelated API profile does not break independent accounts, and stale candidates do not hide a valid one", () => {
  const claude = { id: "claude", provider: "claude", label: "Claude" };
  const broken = apiAccount();
  assert.equal(selectLaunchAccount([broken, claude], "claude", undefined, "claude", "D0", undefined, []).id, "claude");
  assert.equal(selectLaunchAccount([broken, claude], "claude", undefined, undefined, "D0", undefined, []).id, "claude");
  assert.throws(() => selectLaunchAccount([broken, claude], "opencode", undefined, undefined, "D0", undefined, []), /missing/);
  const stale = { ...claude, id: "stale" };
  stale.assessment = assess(stale);
  stale.assessment.evidence.binding = "old binding";
  assert.equal(selectLaunchAccount([stale, claude], "claude", undefined, undefined, "D0", { limit: 2 }, []).id, "claude");
});

test("Grok measured grid and async account preparation launch once, with the latest size and pending input", async (t) => {
  const f = await runtimeFixture(t);
  f.update({ providerAccounts: [{ id: "grok", provider: "grok", label: "Grok", binding: { kind: "cli-home", directory: f.directory } }] });
  const session = f.create({ provider: "grok", model: "grok-selected" });
  f.manager.input(session.id, "once\r");
  assert.equal(f.calls.length, 0);
  f.manager.resize(session.id, 90, 30);
  f.manager.resize(session.id, 100, 35);
  await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.cols, 100);
  assert.equal(f.calls[0].options.rows, 35);
  assert.equal(f.calls[0].options.env.GROK_HOME, f.directory);
  assert.deepEqual(f.calls[0].args, ["--model", "grok-selected"]);
  assert.deepEqual(f.writes, ["once\r"]);
  f.exits[0]({ exitCode: 0 });
  f.manager.restart(session.id);
  f.manager.input(session.id, "do not deliver\r");
  f.manager.resize(session.id, 100, 35);
  const pending = f.manager.waitForLaunch(session.id);
  f.manager.dispose(session.id);
  await pending;
  assert.equal(f.calls.length, 1);
});

test("restore uses the bound account adapter and refuses to resume after changing its home", async (t) => {
  const { persistedTerminalSession } = await import("../src/main/services/TerminalSessionStore.ts");
  const f = await runtimeFixture(t);
  const account = { id: "codex", provider: "codex", label: "Codex", binding: { kind: "cli-home", directory: f.directory } };
  f.update({ providerAccounts: [account] });
  const first = f.create({ model: "chosen-model" });
  await f.manager.waitForLaunch(first.id);
  const descriptor = persistedTerminalSession(f.manager.list()[0]);
  f.manager.dispose(first.id);
  f.manager.configureSessionPersistence({ load: async () => [descriptor], replace: async () => {}, clear: async () => {} }, true);
  await f.manager.restorePersistedSessions();
  await f.manager.waitForLaunch(first.id);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].args.includes("resume"));
  assert.equal(f.calls[1].options.env.CODEX_HOME, f.directory);
  assert.ok(f.calls[1].args.includes('cli_auth_credentials_store="file"'));
  f.manager.dispose(first.id);
  const another = join(f.directory, "other-home"); await mkdir(another);
  f.update({ providerAccounts: [{ ...account, binding: { kind: "cli-home", directory: another } }] });
  await f.manager.restorePersistedSessions();
  await f.manager.waitForLaunch(first.id);
  assert.equal(f.calls.length, 2);
  assert.match(f.manager.list()[0].failureDetails, /Cannot resume/);
});

test("OpenCode API configuration merges existing MCP and lifecycle extensions", async (t) => {
  const f = await runtimeFixture(t, { apiProfiles: [api()], providerAccounts: [apiAccount()] }, {
    browser: { prepareLaunch: () => ({ args: [], environment: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { canvastty: { type: "local", command: ["helper"] } } }) }, cleanup() {} }) },
    runtime: { prepareLaunch: () => ({ args: [], environment: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ["file:///runtime-hook.js"] }) }, cleanup() {} }), currentStatus: () => null }
  });
  const session = f.create({ provider: "opencode" }); await f.manager.waitForLaunch(session.id);
  const config = JSON.parse(f.calls[0].options.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.mcp.canvastty.command, ["helper"]);
  assert.deepEqual(config.plugin, ["file:///runtime-hook.js"]);
  assert.equal(Object.values(config.provider)[0].options.baseURL, "https://api.example/v1");
});

for (const provider of ["opencode", "minimax"]) test(`${provider} supports measured Anthropic protocol without rewriting a relay path`, async (t) => {
  const f = await runtimeFixture(t, { apiProfiles: [{ ...api("anthropic-compatible"), baseUrl: "https://relay.example/custom/messages" }], providerAccounts: [apiAccount(provider)] });
  const session = f.create({ provider }); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 1, f.manager.list()[0].failureDetails);
  if (provider === "opencode") {
    const config = Object.values(JSON.parse(f.calls[0].options.env.OPENCODE_CONFIG_CONTENT).provider)[0];
    assert.equal(config.npm, "@ai-sdk/anthropic");
    assert.equal(config.options.baseURL, "https://relay.example/custom/messages");
  } else {
    const config = JSON.parse(await readFile(join(f.calls[0].options.env.MINIMAX_DATA_DIR, "config.yaml"), "utf8"));
    const backend = Object.values(config.custom_provider)[0];
    assert.equal(backend.api, "anthropic-messages");
    assert.equal(backend.options.baseURL, "https://relay.example/custom/messages");
  }
});

test("API model/key absence and unsupported OMP Anthropic fail closed without a PTY", async (t) => {
  const f = await runtimeFixture(t, { apiProfiles: [{ ...api(), defaultModel: undefined }], providerAccounts: [apiAccount()] });
  let session = f.create({ provider: "opencode" }); await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 0); assert.match(f.manager.list()[0].failureDetails, /model/);
  f.update({ apiProfiles: [api("anthropic-compatible")], providerAccounts: [apiAccount("omp")] });
  assert.throws(() => f.create({ provider: "omp" }), /supported binding/);
  const withoutKey = await runtimeFixture(t, { apiProfiles: [api()], providerAccounts: [apiAccount()] }, { secrets: { get: async () => null } });
  session = withoutKey.create({ provider: "opencode" }); await withoutKey.manager.waitForLaunch(session.id);
  assert.equal(withoutKey.calls.length, 0); assert.match(withoutKey.manager.list()[0].failureDetails, /key is not configured/);
});

test("secret configuration is removed after a PTY spawn failure", async (t) => {
  const f = await runtimeFixture(t, { apiProfiles: [api()], providerAccounts: [apiAccount("minimax")] }, { failSpawn: true });
  const session = f.create({ provider: "minimax" });
  await f.manager.waitForLaunch(session.id);
  assert.equal(f.calls.length, 1);
  await assert.rejects(stat(f.calls[0].options.env.MINIMAX_DATA_DIR), /ENOENT/);
  assert.match(f.manager.list()[0].failureDetails, /fake PTY spawn failed/);
});

test("cancelling after secret configuration is prepared cleans it without launching", async (t) => {
  const f = await runtimeFixture(t, { apiProfiles: [api()], providerAccounts: [apiAccount("minimax")] });
  let notifyReady, finish;
  const ready = new Promise((resolve) => { notifyReady = resolve; });
  const gate = new Promise((resolve) => { finish = resolve; });
  let temporary;
  f.manager.configureProviderLaunch({ prepare: async (...args) => {
    const prepared = await f.service.prepare(...args);
    temporary = prepared.environment.MINIMAX_DATA_DIR;
    notifyReady();
    await gate;
    return prepared;
  } });
  const session = f.create({ provider: "minimax" });
  await ready;
  assert.ok((await stat(temporary)).isDirectory());
  const pending = f.manager.waitForLaunch(session.id);
  f.manager.dispose(session.id);
  finish();
  await pending;
  assert.equal(f.calls.length, 0);
  await assert.rejects(stat(temporary), /ENOENT/);
});

test("secret configuration cleanup can retry after a temporary filesystem denial", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("Requires POSIX permission enforcement for a non-root user.");
  const f = await runtimeFixture(t, { apiProfiles: [api()], providerAccounts: [apiAccount("minimax")] });
  const metadata = { id: "cleanup-retry", provider: "minimax", profile: "normal", cwd: process.cwd(), accountId: "account", model: "chosen-model", dataClass: "D0" };
  const prepared = await f.service.prepare(metadata, false);
  const temporary = prepared.environment.MINIMAX_DATA_DIR;
  try {
    await chmod(temporary, 0o000);
    await assert.rejects(prepared.cleanup(), { code: "EACCES" });
    assert.throws(() => prepared.assertCurrent(metadata), /binding changed/);
    await chmod(temporary, 0o700);
    const retry = prepared.cleanup();
    assert.equal(prepared.cleanup(), retry);
    await retry;
    await assert.rejects(stat(temporary), { code: "ENOENT" });
  } finally {
    await chmod(temporary, 0o700).catch(() => undefined);
  }
});
