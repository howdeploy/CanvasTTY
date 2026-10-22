import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { AgentBrowserBridge } from "../src/main/services/agent-browser/AgentBrowserBridge.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { isControlProvider } from "../src/main/services/agent-control/controlCapabilities.ts";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { AgentIsolation } from "../src/main/services/isolation/AgentIsolation.ts";
import { AGENT_PASS_ENV, agentEnvironment, shellEnvironment } from "../src/main/services/ambientProviderKeys.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const at = { x: 0, y: 0 };
// Fake values only: the test sets them on its own process, never reads the person's environment.
const FAKE = {
  OPENAI_API_KEY: "fake-oa",
  OPENAI_ADMIN_KEY: "fake-oa-adm",
  ANTHROPIC_API_KEY: "fake-an",
  ANTHROPIC_ADMIN_KEY: "fake-an-adm",
  OPENROUTER_API_KEY: "fake-or",
  GEMINI_API_KEY: "fake-gemini",
  GITLAB_ADMIN_TOKEN: "fake-gl-adm",
  ANTHROPIC_AUTH_TOKEN: "fake-at",
  CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth",
  AWS_BEARER_TOKEN_BEDROCK: "fake-bedrock",
  AWS_ACCESS_KEY_ID: "fake-akid",
  AWS_SECRET_ACCESS_KEY: "fake-sak",
  AWS_SESSION_TOKEN: "fake-st",
  GITHUB_TOKEN: "fake-gh",
  GH_TOKEN: "fake-gh2",
  SSH_AUTH_SOCK: "/fake/agent",
  XAI_API_KEY: "fake-xai",
  HF_TOKEN: "fake-hf",
  NPM_TOKEN: "fake-npm",
  HTTPS_PROXY: "http://proxy:3128",
  no_proxy: "localhost",
  NODE_EXTRA_CA_CERTS: "/fake/ca.pem",
  LC_ALL: "C.UTF-8",
  EDITOR: "vi",
  CANVASTTY_GITHUB_TOKEN: "fake-ctgh"
};
const ADMIN = ["OPENAI_ADMIN_KEY", "ANTHROPIC_ADMIN_KEY", "GITLAB_ADMIN_TOKEN"];
const ORDINARY = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"];
/** Credentials that are not provider API keys by name; a delegated card gets none of them (allowlist). */
const OTHER_CREDENTIALS = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK", "XAI_API_KEY", "HF_TOKEN", "NPM_TOKEN"];
/** What a delegated card still needs to run and reach the network. */
const KEPT = ["PATH", "HTTPS_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "LC_ALL", "EDITOR"];
const SECRETS = [...ADMIN, ...ORDINARY, ...OTHER_CREDENTIALS];
const SECRET_VALUES = [...SECRETS, "CANVASTTY_GITHUB_TOKEN"].map((name) => FAKE[name]);

/** Sets fake keys (and optionally the opt-in) on this process for the test, restoring what was there. */
function withFakeKeys(t, extra = {}) {
  const names = [...Object.keys(FAKE), AGENT_PASS_ENV];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env[AGENT_PASS_ENV];
  Object.assign(process.env, FAKE, extra);
}

async function project(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ctty-keys-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

function present(env, names) {
  return names.filter((name) => env[name] !== undefined);
}

function manager(t, calls, isolation) {
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.shutdown());
  if (isolation) terminals.configureIsolation(isolation);
  return terminals;
}

/** A layer that always applies and records the environment it wraps. */
function recordingLayer(userData, wrapped) {
  return {
    containment: () => true,
    decide: (input) => new AgentIsolation({ userDataPath: userData, enabled: () => true, platform: "darwin", exists: () => true }).decide(input),
    wrap: (launch) => {
      wrapped.push(launch.env);
      return { command: "/usr/bin/sandbox-exec", args: ["-f", "/p.sb", launch.command, ...launch.args], env: { ...launch.env, TMPDIR: "/s/" }, cleanup: () => undefined };
    }
  };
}

test("(a) a plain shell card the person starts keeps their environment, provider and admin keys included", async (t) => {
  withFakeKeys(t);
  const cwd = await project(t);
  const calls = [];
  manager(t, calls).create({ provider: "terminal", profile: "normal", cwd, position: at });
  const env = calls.at(-1).options.env;
  assert.deepEqual(present(env, SECRETS), SECRETS);
  assert.equal(env.CANVASTTY_GITHUB_TOKEN, undefined, "CanvasTTY's own token is the app's, not the shell's");
});

test("a plain shell card a plugin starts is delegated: its owner drives it, so it gets only the allowlist", async (t) => {
  withFakeKeys(t);
  const cwd = await project(t);
  const calls = [];
  const terminals = manager(t, calls);
  const sessions = new PluginSessions({ terminals, notify: () => true });
  await sessions.handle("p.shell", "svc", "sessions.create", { provider: "terminal", cwd }, ["sessions:launch"]);
  assert.equal(calls.length, 1);
  const env = calls.at(-1).options.env;
  assert.deepEqual(present(env, SECRETS), [], "no admin key, provider key or other credential");
  assert.deepEqual(present(env, KEPT), KEPT, "what it needs to run and reach the network stays");
  // Directly through the manager too (whatever the caller), keyed on the owning plugin.
  terminals.create({ provider: "terminal", profile: "normal", cwd, position: at }, { origin: "plugin", ownerPluginId: "p.shell" });
  assert.deepEqual(present(calls.at(-1).options.env, SECRETS), []);
});

test("an orchestrator cannot start a plain shell card, neither through spawn_agent nor its control connection", async (t) => {
  const cwd = await project(t);
  const calls = [];
  const terminals = manager(t, calls);
  const control = new AgentControlService(terminals, { containment: () => terminals.containment() });
  const orchestrator = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  const before = calls.length;
  assert.throws(() => control.spawn({ parentSessionId: orchestrator.id, provider: "terminal", cwd }), /Unknown agent provider/u);
  assert.equal(calls.length, before);
  assert.equal(isControlProvider("terminal"), false);
});

test("(b) an agent card the person starts keeps ordinary provider keys but never admin keys", async (t) => {
  withFakeKeys(t);
  const cwd = await project(t);
  const calls = [];
  const terminals = manager(t, calls);
  for (const provider of ["claude", "codex", "opencode", "qwen"]) {
    terminals.create({ provider, profile: "normal", cwd, position: at });
    const env = calls.at(-1).options.env;
    assert.deepEqual(present(env, ADMIN), [], `${provider}: no admin key`);
    assert.equal(env.CANVASTTY_GITHUB_TOKEN, undefined, `${provider}: no CanvasTTY credential`);
    assert.deepEqual(present(env, ORDINARY), ORDINARY, `${provider}: its sign-in by API key keeps working`);
    assert.deepEqual(present(env, OTHER_CREDENTIALS), OTHER_CREDENTIALS, `${provider}: otherwise unchanged for the person's own card`);
    assert.equal(env.OPENAI_API_KEY, FAKE.OPENAI_API_KEY);
  }
});

test("(c) an agent card under isolation: no admin keys reach the layer or the process; the person's own card keeps ordinary keys", async (t) => {
  withFakeKeys(t);
  const cwd = await project(t);
  const calls = [];
  const wrapped = [];
  const terminals = manager(t, calls, recordingLayer(join(cwd, "u"), wrapped));
  const card = terminals.create({ provider: "claude", profile: "auto", cwd, position: at });
  assert.deepEqual(card.isolation, { state: "on", layer: "seatbelt" });
  assert.equal(calls.at(-1).command, "/usr/bin/sandbox-exec");
  for (const env of [wrapped.at(-1), calls.at(-1).options.env]) {
    assert.deepEqual(present(env, ADMIN), []);
    assert.deepEqual(present(env, ORDINARY), ORDINARY);
  }
});

test("(d) a subagent gets no ambient provider key, admin key or other credential, isolated or not", async (t) => {
  withFakeKeys(t);
  const cwd = await project(t);
  for (const layer of ["isolated", "no layer"]) {
    const calls = [];
    const wrapped = [];
    const isolation = layer === "isolated"
      ? recordingLayer(join(cwd, "u"), wrapped)
      : new AgentIsolation({ userDataPath: join(cwd, "u"), enabled: () => true, platform: "win32" });
    const terminals = manager(t, calls, isolation);
    const control = new AgentControlService(terminals, { containment: () => terminals.containment() });
    const orchestrator = terminals.create({ provider: "codex", profile: "auto", cwd, position: at, role: "orchestrator" });
    assert.deepEqual(present(calls.at(-1).options.env, ORDINARY), ORDINARY, `${layer}: the person's orchestrator keeps them`);
    const child = await control.spawn({ parentSessionId: orchestrator.id, provider: "claude", cwd });
    assert.equal(child.role, "subagent");
    const env = calls.at(-1).options.env;
    assert.deepEqual(present(env, SECRETS), [], `${layer}: the subagent`);
    if (layer === "isolated") assert.deepEqual(present(wrapped.at(-1), SECRETS), []);
    assert.deepEqual(present(env, KEPT), KEPT, "what it needs to run and reach the network stays");
  }
});

test("the person's explicit opt-in passes named keys to every agent card, subagents included", async (t) => {
  withFakeKeys(t, { [AGENT_PASS_ENV]: "OPENAI_ADMIN_KEY, ANTHROPIC_API_KEY" });
  const cwd = await project(t);
  const calls = [];
  const terminals = manager(t, calls, new AgentIsolation({ userDataPath: join(cwd, "u"), enabled: () => true, platform: "win32" }));
  const control = new AgentControlService(terminals, { containment: () => terminals.containment() });
  const top = terminals.create({ provider: "codex", profile: "normal", cwd, position: at, role: "orchestrator" });
  assert.deepEqual(present(calls.at(-1).options.env, ADMIN), ["OPENAI_ADMIN_KEY"]);
  await control.spawn({ parentSessionId: top.id, provider: "claude", cwd });
  assert.deepEqual(present(calls.at(-1).options.env, SECRETS), ["OPENAI_ADMIN_KEY", "ANTHROPIC_API_KEY"]);
});

test("agentEnvironment: names compare case-insensitively (Windows); admin credentials of any provider; delegated is an allowlist", () => {
  const base = { Path: "C:\\bin", openai_api_key: "x", Openai_Admin_Key: "y", GITHUB_TOKEN: "g", AZURE_OPENAI_API_KEY: "z",
    XAI_ADMIN_API_KEY: "w", ADMIN_TOKEN: "a", SOME_ADMIN_ACCESS_TOKEN: "b", HOME: "/h", SystemRoot: "C:\\Windows",
    https_proxy: "http://p", Lc_Ctype: "UTF-8", XDG_CONFIG_HOME: "/h/.config", CODEX_HOME: "/h/.codex", MY_SERVICE_PASSWORD: "p" };
  assert.deepEqual(agentEnvironment(base, { delegated: false }), { Path: "C:\\bin", openai_api_key: "x", GITHUB_TOKEN: "g",
    AZURE_OPENAI_API_KEY: "z", HOME: "/h", SystemRoot: "C:\\Windows", https_proxy: "http://p", Lc_Ctype: "UTF-8",
    XDG_CONFIG_HOME: "/h/.config", CODEX_HOME: "/h/.codex", MY_SERVICE_PASSWORD: "p" });
  const delegated = { Path: "C:\\bin", HOME: "/h", SystemRoot: "C:\\Windows", https_proxy: "http://p", Lc_Ctype: "UTF-8",
    XDG_CONFIG_HOME: "/h/.config", CODEX_HOME: "/h/.codex" };
  assert.deepEqual(agentEnvironment(base, { delegated: true }), delegated);
  assert.deepEqual(agentEnvironment({ ...base, [AGENT_PASS_ENV]: "openai_admin_key GITHUB_TOKEN" }, { delegated: true }),
    { ...delegated, Openai_Admin_Key: "y", GITHUB_TOKEN: "g" });
  // CanvasTTY's own credentials reach no agent card, the person's own included; its other variables are not inherited
  // by a delegated card (the launch sets what a card needs).
  const app = { CANVASTTY_GITHUB_TOKEN: "t", CANVASTTY_API_KEY: "k", CANVASTTY_CODEX_KEYBOARD: "{}", CANVASTTY_HELPERS: "node" };
  assert.deepEqual(agentEnvironment(app, { delegated: false }), { CANVASTTY_CODEX_KEYBOARD: "{}", CANVASTTY_HELPERS: "node" });
  assert.deepEqual(agentEnvironment(app, { delegated: true }), {});
  assert.deepEqual(shellEnvironment({ ...app, GITHUB_TOKEN: "g" }), { CANVASTTY_CODEX_KEYBOARD: "{}", CANVASTTY_HELPERS: "node", GITHUB_TOKEN: "g" });
});

/** The real launch builders (agent runtime hooks, browser/orchestration MCP bridge), both built over process.env. */
function builders(root) {
  const helper = { command: "/app/CanvasTTY", args: ["/app/helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const browserGateway = {
    isEnabled: true,
    setEnabled() {},
    registerAgent: (input) => ({ agentId: "a", connectionId: "c", terminalSessionId: input.terminalSessionId, provider: input.provider,
      capabilityToken: "b".repeat(40), address: "/tmp/b.sock" }),
    revokeTerminalSession() {},
    holdPendingForTerminal() {}
  };
  const runtimeGateway = {
    registerSession: (id, provider) => ({ address: "/tmp/r.sock", terminalSessionId: id, provider, capabilityToken: "r".repeat(40) }),
    revokeTerminalSession() {},
    currentStatus: () => null
  };
  const browser = new AgentBrowserBridge(browserGateway, { helper, orchestrationHelper: helper, providerClis: availableRegistry(),
    runtimeDirectory: join(root, "rt-b"), hermesHomeDirectory: join(root, "hermes"), kimiHomeDirectory: join(root, "kimi"),
    probeKimiPerRunConfig: () => true });
  const runtime = new AgentRuntimeBridge(runtimeGateway, { helper, runtimeDirectory: join(root, "rt-r"),
    openCodePluginPath: "/app/opencode-plugin.mjs", kimiHomeDirectory: join(root, "kimi"), hermesHomeDirectory: join(root, "hermes"),
    grokHomeDirectory: join(root, "grok"), coreHooksEnabled: true });
  return { browser, runtime };
}

test("no launch builder re-injects what the filter removed: the env handed to the PTY of a delegated card holds no ambient credential", async (t) => {
  // The person's OpenCode inline config carries a provider key; the builders read it from the app's environment.
  withFakeKeys(t, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { x: { options: { apiKey: "fake-oc" } } } }) });
  t.after(() => { delete process.env.OPENCODE_CONFIG_CONTENT; });
  const cwd = await project(t);
  const calls = [];
  const { browser, runtime } = builders(cwd);
  const terminals = new TerminalManager(() => undefined, availableRegistry(), browser, runtime, true, fakeSpawner(calls));
  t.after(() => terminals.shutdown());
  const control = new AgentControlService(terminals, { containment: () => terminals.containment() });
  const orchestrator = terminals.create({ provider: "opencode", profile: "normal", cwd, position: at, role: "orchestrator" });
  const own = calls.at(-1).options.env;
  assert.match(own.OPENCODE_CONFIG_CONTENT, /fake-oc/u, "the person's own card keeps their OpenCode config");
  assert.match(own.OPENCODE_CONFIG_CONTENT, /opencode-plugin\.mjs/u);
  assert.equal(own.CANVASTTY_GITHUB_TOKEN, undefined);
  assert.deepEqual(present(own, ADMIN), []);
  for (const provider of ["opencode", "claude", "codex", "qwen"]) {
    await control.spawn({ parentSessionId: orchestrator.id, provider, cwd });
    const env = calls.at(-1).options.env;
    const text = JSON.stringify(env);
    for (const value of [...SECRET_VALUES, "fake-oc"]) assert.ok(!text.includes(value), `${provider} subagent: ${value} is not in its env`);
    assert.deepEqual(present(env, [...SECRETS, "CANVASTTY_GITHUB_TOKEN"]), [], provider);
    if (provider === "opencode") {
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      assert.ok(config.plugin.some((entry) => entry.endsWith("/opencode-plugin.mjs")), "its lifecycle plugin is still there");
      assert.ok(config.mcp.canvastty_browser, "its browser server is still there");
      assert.equal(config.provider, undefined, "the person's inline config is not handed to a delegated agent");
    }
  }
  // A plugin-started plain shell, through the same manager.
  const sessions = new PluginSessions({ terminals, notify: () => true });
  await sessions.handle("p.shell", "svc", "sessions.create", { provider: "terminal", cwd }, ["sessions:launch"]);
  const shell = JSON.stringify(calls.at(-1).options.env);
  for (const value of [...SECRET_VALUES, "fake-oc"]) assert.ok(!shell.includes(value), `plugin shell: ${value}`);
});
