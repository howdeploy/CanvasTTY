import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { ProviderRuntimeLaunchAdapters } from "../src/main/services/agent-runtime/ProviderRuntimeLaunch.ts";
import { ProviderLaunchAdapters } from "../src/main/services/agent-browser/ProviderLaunch.ts";
import { AgentBrowserBridge } from "../src/main/services/agent-browser/AgentBrowserBridge.ts";
import { accountHookHome } from "../src/main/services/accountHomes.ts";
import { contributedAccountHome } from "../src/main/services/isolation/accountHomeIsolation.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

const helper = Object.freeze({
  command: "/opt/CanvasTTY Agent/electron",
  args: ["/opt/CanvasTTY Agent/agent-runtime/hook-helper.mjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" }
});

const GROK_FILE = ["hooks", "canvastty-runtime-hooks.json"];
const KIMI_MARKER = "# >>> CanvasTTY lifecycle hooks >>>";
const PERSON_KIMI = "# the person's own settings\ndefault_model = \"kimi-k2\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"notify-send done\"\n";

/** userData with plugin-data/<plugin>/homes/<account>, the default CLI homes, and adapters bound to them. */
async function fixture(t, { root: withRoot = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), "canvastty-account-homes-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const pluginData = join(base, "userData", "plugin-data");
  const accountHome = (plugin, account) => join(pluginData, plugin, "homes", account);
  const defaultGrok = join(base, "home", ".grok");
  const defaultKimi = join(base, "home", ".kimi-code");
  await Promise.all([
    mkdir(accountHome("accounts", "a"), { recursive: true }),
    mkdir(accountHome("accounts", "b"), { recursive: true }),
    mkdir(defaultGrok, { recursive: true }),
    mkdir(defaultKimi, { recursive: true })
  ]);
  const adapters = () => new ProviderRuntimeLaunchAdapters({
    helper,
    runtimeDirectory: join(base, "runtime"),
    openCodePluginPath: join(base, "opencode-plugin.mjs"),
    grokHomeDirectory: defaultGrok,
    kimiHomeDirectory: defaultKimi,
    hermesHomeDirectory: join(base, "home", ".hermes"),
    ...(withRoot ? { accountHomesRoot: pluginData } : {}),
    platform: "linux"
  });
  return { base, pluginData, accountHome, defaultGrok, defaultKimi, adapters };
}

const exists = (path) => lstat(path).then(() => true, () => false);
const markers = (text) => text.split(KIMI_MARKER).length - 1;

test("accountHookHome: GROK_HOME for Grok, KIMI_CODE_HOME for Kimi, nothing for the other CLIs", () => {
  assert.equal(accountHookHome("grok", { GROK_HOME: "/data/plugin-data/a/homes/x/" }), "/data/plugin-data/a/homes/x");
  assert.equal(accountHookHome("kimi", { KIMI_CODE_HOME: "/data/plugin-data/a/homes/k" }), "/data/plugin-data/a/homes/k");
  // The older kimi-cli's home holds no Kimi Code hooks.
  assert.equal(accountHookHome("kimi", { KIMI_SHARE_DIR: "/data/plugin-data/a/homes/k" }), undefined);
  assert.equal(accountHookHome("grok", { KIMI_CODE_HOME: "/x" }), undefined);
  assert.equal(accountHookHome("claude", { CLAUDE_CONFIG_DIR: "/x", GROK_HOME: "/y" }), undefined);
  assert.equal(accountHookHome("codex", { CODEX_HOME: "/x" }), undefined);
  assert.equal(accountHookHome("grok", undefined), undefined);
  assert.equal(accountHookHome("grok", { GROK_HOME: "" }), undefined);
});

test("account home: only the contributor's own data folder; only GROK_HOME / KIMI_CODE_HOME get the hooks", () => {
  const dataDir = "/data/plugin-data/accounts";
  // The launch's account home (one rule, contributedAccountHome) gets the hooks only when it is the hook home too, as
  // TerminalManager checks it.
  const hookHome = (provider, key, value) => {
    const home = contributedAccountHome(provider, dataDir, key, value);
    const hook = accountHookHome(provider, { [key]: value });
    return home !== undefined && home === hook ? home : undefined;
  };
  assert.equal(hookHome("grok", "GROK_HOME", `${dataDir}/homes/a/`), `${dataDir}/homes/a`);
  assert.equal(hookHome("kimi", "KIMI_CODE_HOME", `${dataDir}/homes/k`), `${dataDir}/homes/k`);
  assert.equal(hookHome("grok", "GROK_HOME", "/data/plugin-data/other/homes/a"), undefined);
  assert.equal(hookHome("grok", "GROK_HOME", dataDir), undefined);
  assert.equal(hookHome("grok", "GROK_HOME", `${dataDir}/../other/homes/a`), undefined);
  assert.equal(hookHome("grok", "GROK_HOME", "homes/a"), undefined);
  assert.equal(hookHome("grok", "KIMI_CODE_HOME", `${dataDir}/homes/a`), undefined);
  assert.equal(hookHome("kimi", "KIMI_SHARE_DIR", `${dataDir}/homes/a`), undefined);
  assert.equal(hookHome("claude", "CLAUDE_CONFIG_DIR", `${dataDir}/homes/a`), undefined);
  assert.equal(contributedAccountHome("grok", undefined, "GROK_HOME", `${dataDir}/homes/a`), undefined);
});

test("Grok: an account home gets the status hooks, the default home is left alone, and the release removes them", async (t) => {
  const { accountHome, defaultGrok, adapters } = await fixture(t);
  const home = accountHome("accounts", "a");
  await mkdir(join(home, "hooks"), { recursive: true });
  await writeFile(join(home, "hooks", "person.json"), "{\"hooks\":{}}\n");
  await writeFile(join(home, "config.toml"), "model = \"grok-4\"\n");
  const launch = adapters().prepare("grok", "card-grok", true, false, undefined, undefined, false, home);
  const written = JSON.parse(await readFile(join(home, ...GROK_FILE), "utf8"));
  assert.match(written.hooks.UserPromptSubmit[0].hooks[0].command, /working.*UserPromptSubmit/u);
  assert.match(written.hooks.Notification[0].hooks[0].command, /needs_approval.*Notification/u);
  assert.equal(written.hooks.Notification[0].matcher, "permission_prompt");
  assert.equal((await stat(join(home, ...GROK_FILE))).mode & 0o777, 0o600);
  assert.equal(await exists(join(defaultGrok, ...GROK_FILE)), false, "the default ~/.grok is not touched");
  launch.releaseConfiguration();
  assert.equal(await exists(join(home, ...GROK_FILE)), false);
  assert.equal(await readFile(join(home, "hooks", "person.json"), "utf8"), "{\"hooks\":{}}\n");
  assert.equal(await readFile(join(home, "config.toml"), "utf8"), "model = \"grok-4\"\n");
});

test("Kimi: an account home's config.toml gets one owned block; the person's settings and file mode are kept and restored", async (t) => {
  const { accountHome, defaultKimi, adapters } = await fixture(t);
  const home = accountHome("accounts", "a");
  const config = join(home, "config.toml");
  await writeFile(config, PERSON_KIMI);
  await chmod(config, 0o640);
  await writeFile(join(defaultKimi, "config.toml"), "default_model = \"default\"\n");
  const launch = adapters().prepare("kimi", "card-kimi", true, false, undefined, undefined, false, home);
  const during = await readFile(config, "utf8");
  assert.ok(during.startsWith(PERSON_KIMI), "the person's settings stay first and unchanged");
  assert.equal(markers(during), 1);
  assert.match(during, /event = "TurnStarted"\ncommand = ".*working.*TurnStarted/u);
  assert.equal((await stat(config)).mode & 0o777, 0o640);
  assert.equal(await readFile(join(defaultKimi, "config.toml"), "utf8"), "default_model = \"default\"\n");
  assert.equal(await exists(join(defaultKimi, ".canvastty-runtime-kimi.json")), false);
  launch.releaseConfiguration();
  assert.equal(await readFile(config, "utf8"), PERSON_KIMI);
  assert.equal(await exists(join(home, ".canvastty-runtime-kimi.json")), false);
  assert.deepEqual(await readdir(join(home, ".canvastty-runtime-backups")).catch(() => []), [], "no backup is left");
});

test("idempotent: two cards in one account home share one overlay; another home gets its own; a crashed overlay is refreshed", async (t) => {
  const { accountHome, adapters } = await fixture(t);
  const home = accountHome("accounts", "a");
  const other = accountHome("accounts", "b");
  const config = join(home, "config.toml");
  await writeFile(config, PERSON_KIMI);
  const runtime = adapters();
  const first = runtime.prepare("kimi", "card-1", true, false, undefined, undefined, false, home);
  const second = runtime.prepare("kimi", "card-2", true, false, undefined, undefined, false, `${home}/`);
  const third = runtime.prepare("kimi", "card-3", true, false, undefined, undefined, false, other);
  assert.equal(markers(await readFile(config, "utf8")), 1);
  assert.equal(markers(await readFile(join(other, "config.toml"), "utf8")), 1);
  first.releaseConfiguration();
  first.releaseConfiguration();
  assert.equal(markers(await readFile(config, "utf8")), 1, "still in use by card-2");
  second.releaseConfiguration();
  assert.equal(await readFile(config, "utf8"), PERSON_KIMI);
  third.releaseConfiguration();
  assert.equal(await exists(join(other, "config.toml")), false, "a file CanvasTTY created is removed again");

  // An app that ended without releasing (a crash) leaves its overlay; the next launch there replaces it, not adds one.
  runtime.prepare("kimi", "card-crashed", true, false, undefined, undefined, false, home);
  runtime.prepare("grok", "card-crashed-grok", true, false, undefined, undefined, false, home);
  const restarted = adapters();
  const again = restarted.prepare("kimi", "card-again", true, false, undefined, undefined, false, home);
  const grokAgain = restarted.prepare("grok", "card-again-grok", true, false, undefined, undefined, false, home);
  assert.equal(markers(await readFile(config, "utf8")), 1);
  assert.ok((await readFile(config, "utf8")).startsWith(PERSON_KIMI));
  again.releaseConfiguration();
  grokAgain.releaseConfiguration();
  assert.equal(await readFile(config, "utf8"), PERSON_KIMI);
  assert.equal(await exists(join(home, ...GROK_FILE)), false);
});

test("symbolic links: a linked account home, a linked folder above it, or a linked config file is refused and nothing is written", async (t) => {
  const { base, pluginData, accountHome, defaultGrok, defaultKimi, adapters } = await fixture(t);
  const outside = join(base, "outside");
  await mkdir(join(outside, "hooks"), { recursive: true });
  await writeFile(join(outside, "config.toml"), "outside = true\n");
  const runtime = adapters();

  const linkedHome = accountHome("accounts", "linked");
  await symlink(outside, linkedHome);
  for (const provider of ["grok", "kimi"]) {
    assert.throws(() => runtime.prepare(provider, `card-${provider}`, true, false, undefined, undefined, false, linkedHome),
      /missing or crosses a symbolic link/u);
  }

  await symlink(join(pluginData, "accounts"), join(pluginData, "alias"));
  assert.throws(() => runtime.prepare("grok", "card-alias", true, false, undefined, undefined, false, join(pluginData, "alias", "homes", "a")),
    /missing or crosses a symbolic link/u);

  const kimiHome = accountHome("accounts", "a");
  await symlink(join(outside, "config.toml"), join(kimiHome, "config.toml"));
  assert.throws(() => runtime.prepare("kimi", "card-config", true, false, undefined, undefined, false, kimiHome),
    /symbolic link where CanvasTTY writes/u);

  const grokHome = accountHome("accounts", "b");
  await symlink(join(outside, "hooks"), join(grokHome, "hooks"));
  assert.throws(() => runtime.prepare("grok", "card-hooks", true, false, undefined, undefined, false, grokHome),
    /symbolic link where CanvasTTY writes/u);

  assert.deepEqual((await readdir(outside)).sort(), ["config.toml", "hooks"]);
  assert.equal(await readFile(join(outside, "config.toml"), "utf8"), "outside = true\n");
  assert.deepEqual(await readdir(join(outside, "hooks")), []);
  assert.deepEqual(await readdir(defaultGrok), []);
  assert.deepEqual(await readdir(defaultKimi), []);
  assert.equal(await exists(join(kimiHome, ".canvastty-runtime-kimi.json")), false);
});

test("a new account's home that does not exist yet is created (private, no link followed) and gets the overlays", async (t) => {
  const { accountHome, defaultGrok, defaultKimi, adapters } = await fixture(t);
  const runtime = adapters();
  for (const provider of ["grok", "kimi"]) {
    // A first sign-in: the contributor names the account's home before the CLI ever created it.
    const home = accountHome("accounts", `new-${provider}`);
    assert.equal(await exists(home), false);
    const launch = runtime.prepare(provider, `card-${provider}`, true, false, undefined, undefined, false, home);
    assert.equal((await stat(home)).mode & 0o777, 0o700, `${provider}: created private`);
    if (provider === "grok") assert.equal(await exists(join(home, ...GROK_FILE)), true);
    else assert.match(await readFile(join(home, "config.toml"), "utf8"), /CanvasTTY lifecycle hooks/u);
    launch.releaseConfiguration();
  }
  assert.deepEqual(await readdir(defaultGrok), []);
  assert.deepEqual(await readdir(defaultKimi), []);
});

test("homes the launch does not own are never written: outside plugin data, a whole plugin's folder, relative, or no root", async (t) => {
  const { base, pluginData, defaultGrok, defaultKimi, adapters } = await fixture(t);
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  const runtime = adapters();
  for (const candidate of [elsewhere, join(pluginData, "accounts"), pluginData, "relative/home", `${pluginData}/accounts/../accounts/homes/a`]) {
    const launch = runtime.prepare("grok", "card", true, false, undefined, undefined, false, candidate);
    const kimi = runtime.prepare("kimi", "card-k", true, false, undefined, undefined, false, candidate);
    assert.equal(await exists(join(defaultGrok, ...GROK_FILE)), true, `${candidate}: the default home, as before`);
    assert.match(await readFile(join(defaultKimi, "config.toml"), "utf8"), /CanvasTTY lifecycle hooks/u);
    launch.releaseConfiguration();
    kimi.releaseConfiguration();
  }
  assert.deepEqual(await readdir(elsewhere), []);
  assert.deepEqual(await readdir(join(pluginData, "accounts", "homes", "a")), []);

  const noRoot = await fixture(t, { root: false });
  const home = noRoot.accountHome("accounts", "a");
  const launch = noRoot.adapters().prepare("grok", "card", true, false, undefined, undefined, false, home);
  assert.deepEqual(await readdir(home), []);
  assert.equal(await exists(join(noRoot.defaultGrok, ...GROK_FILE)), true);
  launch.releaseConfiguration();
});

test("default homes are unchanged without an account home, and hooks off writes nowhere", async (t) => {
  const { accountHome, defaultGrok, defaultKimi, adapters } = await fixture(t);
  const runtime = adapters();
  const grok = runtime.prepare("grok", "card-grok");
  const kimi = runtime.prepare("kimi", "card-kimi");
  assert.equal(await exists(join(defaultGrok, ...GROK_FILE)), true);
  assert.equal(markers(await readFile(join(defaultKimi, "config.toml"), "utf8")), 1);
  grok.releaseConfiguration();
  kimi.releaseConfiguration();
  assert.equal(await exists(join(defaultGrok, ...GROK_FILE)), false);
  assert.equal(await exists(join(defaultKimi, "config.toml")), false);

  const home = accountHome("accounts", "a");
  const off = runtime.prepare("grok", "card-off", false, false, undefined, undefined, false, home);
  assert.deepEqual(await readdir(home), []);
  off.releaseConfiguration();
  // Claude Code and Codex take their hooks as arguments; their homes are never written either way.
  for (const provider of ["claude", "codex"]) {
    const launch = runtime.prepare(provider, `card-${provider}`, true, false, undefined, undefined, false, home);
    assert.ok(launch.args.length > 0);
    launch.releaseConfiguration();
  }
  assert.deepEqual(await readdir(home), []);
});

const PERSON_MCP = `${JSON.stringify({ mcpServers: { person: { transport: "stdio", command: "/usr/bin/true" } } }, null, 2)}\n`;
const BROWSER_RULE = "# CanvasTTY temporary browser permission begin";

const browserHelper = Object.freeze({ command: "/opt/CanvasTTY Agent/electron", args: ["/opt/CanvasTTY Agent/agent-browser/helper.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } });
const orchestrationHelper = Object.freeze({ command: "/opt/CanvasTTY Agent/electron", args: ["/opt/CanvasTTY Agent/agent-browser/orchestration.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } });

const registry = Object.freeze({
  get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }),
  snapshot: () => ({})
});

function browserAdapters(fix, perRun, withRoot = true) {
  return new ProviderLaunchAdapters({
    helper: browserHelper,
    orchestrationHelper,
    providerClis: registry,
    runtimeDirectory: join(fix.base, "browser-runtime"),
    hermesHomeDirectory: join(fix.base, "home", ".hermes"),
    kimiHomeDirectory: fix.defaultKimi,
    probeKimiPerRunConfig: () => perRun,
    ...(withRoot ? { accountHomesRoot: fix.pluginData } : {})
  });
}

test("Kimi tools (per-run MCP file): the account home gets the permission rule, the default home nothing; restored after", async (t) => {
  const fix = await fixture(t);
  const home = fix.accountHome("accounts", "a");
  await writeFile(join(home, "config.toml"), PERSON_KIMI);
  await writeFile(join(fix.defaultKimi, "config.toml"), "default_model = \"default\"\n");
  const adapters = browserAdapters(fix, true);
  const launch = adapters.prepare("kimi", "connection-1", { orchestration: true, accountHome: home });
  const mcpFile = launch.args[launch.args.indexOf("--mcp-config-file") + 1];
  const servers = JSON.parse(await readFile(mcpFile, "utf8")).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ["canvastty_agents", "canvastty_browser"]);
  const during = await readFile(join(home, "config.toml"), "utf8");
  assert.ok(during.startsWith(PERSON_KIMI));
  assert.equal(during.split(BROWSER_RULE).length - 1, 1);
  assert.equal(await readFile(join(fix.defaultKimi, "config.toml"), "utf8"), "default_model = \"default\"\n");
  // A second card in the same home shares the rule; another home gets its own.
  const second = adapters.prepare("kimi", "connection-2", { orchestration: true, accountHome: `${home}/` });
  assert.equal((await readFile(join(home, "config.toml"), "utf8")).split(BROWSER_RULE).length - 1, 1);
  launch.releaseConfiguration();
  assert.equal((await readFile(join(home, "config.toml"), "utf8")).split(BROWSER_RULE).length - 1, 1);
  second.releaseConfiguration();
  assert.equal(await readFile(join(home, "config.toml"), "utf8"), PERSON_KIMI);
  assert.deepEqual((await readdir(home)).sort(), ["config.toml"]);
});

test("Kimi tools (shared mcp.json): the account home's mcp.json gets both servers next to the person's; restored after", async (t) => {
  const fix = await fixture(t);
  const home = fix.accountHome("accounts", "a");
  await writeFile(join(home, "mcp.json"), PERSON_MCP);
  const launch = browserAdapters(fix, false).prepare("kimi", "connection-1", { orchestration: true, accountHome: home });
  assert.equal(launch.args.includes("--mcp-config-file"), false);
  const servers = JSON.parse(await readFile(join(home, "mcp.json"), "utf8")).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ["canvastty_agents", "canvastty_browser", "person"]);
  assert.match(await readFile(join(home, "config.toml"), "utf8"), /CanvasTTY temporary browser permission begin/u);
  assert.deepEqual(await readdir(fix.defaultKimi), [], "the default home is not touched");
  launch.releaseConfiguration();
  assert.equal(await readFile(join(home, "mcp.json"), "utf8"), PERSON_MCP);
  assert.deepEqual((await readdir(home)).sort(), ["mcp.json"]);
});

test("Kimi tools: symbolic links are refused, and a home the launch does not own falls back to the default home", async (t) => {
  const fix = await fixture(t);
  const outside = join(fix.base, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "mcp.json"), PERSON_MCP);
  const home = fix.accountHome("accounts", "a");
  await symlink(join(outside, "mcp.json"), join(home, "mcp.json"));
  const adapters = browserAdapters(fix, false);
  assert.throws(() => adapters.prepare("kimi", "c", { accountHome: home }), /symbolic link where CanvasTTY writes/u);
  const linked = fix.accountHome("accounts", "linked");
  await symlink(outside, linked);
  assert.throws(() => adapters.prepare("kimi", "c", { accountHome: linked }), /missing or crosses a symbolic link/u);
  assert.equal(await readFile(join(outside, "mcp.json"), "utf8"), PERSON_MCP);
  assert.deepEqual(await readdir(outside), ["mcp.json"]);

  const elsewhere = join(fix.base, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  for (const [candidate, runtime] of [[elsewhere, adapters], [fix.accountHome("accounts", "b"), browserAdapters(fix, false, false)]]) {
    const launch = runtime.prepare("kimi", "c", { accountHome: candidate });
    assert.ok(JSON.parse(await readFile(join(fix.defaultKimi, "mcp.json"), "utf8")).mcpServers.canvastty_browser);
    launch.releaseConfiguration();
    assert.deepEqual(await readdir(candidate), []);
  }
});

/** A card a launch contributor (data folder `plugin-data/<owner>`) starts with `variable` = `home`, through TerminalManager. */
async function contributedCard(t, fix, { provider, variable, home, owner = "accounts" }) {
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: owner, pluginName: "Accounts", serviceId: "launcher",
      launch: { appliesTo: [provider], fields: [{ key: "on", label: "On", kind: "boolean", default: true }] }, secrets: false,
      dataDir: join(fix.pluginData, owner) }],
    call: async () => ({ env: { [variable]: home } }),
    secret: async () => null,
    runsRoot: join(fix.base, "runs"),
    timeoutMs: 1_000
  });
  const gateway = {
    registerSession: (terminalSessionId, kind) => ({ address: join(fix.base, "rt.sock"), terminalSessionId, provider: kind, capabilityToken: "t" }),
    revokeTerminalSession() {},
    currentStatus: () => null
  };
  const bridge = new AgentRuntimeBridge(gateway, {
    helper,
    runtimeDirectory: join(fix.base, "runtime"),
    openCodePluginPath: join(fix.base, "opencode-plugin.mjs"),
    grokHomeDirectory: fix.defaultGrok,
    kimiHomeDirectory: fix.defaultKimi,
    hermesHomeDirectory: join(fix.base, "home", ".hermes"),
    accountHomesRoot: fix.pluginData,
    platform: "linux"
  });
  const browserGateway = {
    isEnabled: true,
    registerAgent: (input) => ({ agentId: "agent", connectionId: `connection-${input.terminalSessionId}`, terminalSessionId: input.terminalSessionId,
      provider: input.provider, capabilityToken: "c", address: join(fix.base, "browser.sock"), authenticated: new Promise(() => {}) }),
    revokeTerminalSession() {},
    holdPendingForTerminal() {}
  };
  const browser = new AgentBrowserBridge(browserGateway, {
    helper: browserHelper,
    providerClis: registry,
    runtimeDirectory: join(fix.base, "browser-runtime"),
    hermesHomeDirectory: join(fix.base, "home", ".hermes"),
    kimiHomeDirectory: fix.defaultKimi,
    probeKimiPerRunConfig: () => false,
    accountHomesRoot: fix.pluginData
  });
  const calls = [];
  const spawner = (command, args, options) => {
    const exits = [];
    calls.push({ command, args, options, exit: (code) => exits.forEach((listener) => listener({ exitCode: code })) });
    return {
      pid: 41_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; },
      onExit(listener) { exits.push(listener); return { dispose() {} }; }
    };
  };
  const manager = new TerminalManager(() => undefined, registry, browser, bridge, true, spawner);
  t.after(() => manager.shutdown());
  manager.configureLaunchPipeline(pipeline);
  const created = manager.create({ provider, profile: "normal", cwd: process.cwd(), position: { x: 0, y: 0 }, launchOptions: { [owner]: {} } });
  // Grok starts once the card reports its measured grid.
  manager.resize(created.id, 100, 30);
  const deadline = Date.now() + 5_000;
  while (calls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1, JSON.stringify(manager.list().map((card) => [card.status, card.failureDetails])));
  assert.equal(calls[0].options.env[variable], home);
  return { exit: () => calls[0].exit(0) };
}

async function until(predicate) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(await predicate());
}

test("a Grok card a contributor starts with GROK_HOME in its own account home gets the hooks there, through TerminalManager", async (t) => {
  const fix = await fixture(t);
  const home = fix.accountHome("accounts", "a");
  const card = await contributedCard(t, fix, { provider: "grok", variable: "GROK_HOME", home });
  assert.equal(await exists(join(home, ...GROK_FILE)), true);
  assert.equal(await exists(join(fix.defaultGrok, ...GROK_FILE)), false);
  card.exit();
  await until(async () => !(await exists(join(home, ...GROK_FILE))));
});

test("a Kimi card in its own account home gets status hooks and its browser/agents tools there, through TerminalManager", async (t) => {
  const fix = await fixture(t);
  const home = fix.accountHome("accounts", "a");
  await writeFile(join(home, "config.toml"), PERSON_KIMI);
  await writeFile(join(home, "mcp.json"), PERSON_MCP);
  const card = await contributedCard(t, fix, { provider: "kimi", variable: "KIMI_CODE_HOME", home });
  const config = await readFile(join(home, "config.toml"), "utf8");
  assert.ok(config.startsWith(PERSON_KIMI));
  assert.equal(markers(config), 1);
  assert.equal(config.split(BROWSER_RULE).length - 1, 1);
  assert.ok(JSON.parse(await readFile(join(home, "mcp.json"), "utf8")).mcpServers.canvastty_browser);
  assert.deepEqual(await readdir(fix.defaultKimi), []);
  card.exit();
  await until(async () => (await readFile(join(home, "config.toml"), "utf8")) === PERSON_KIMI);
  await until(async () => (await readFile(join(home, "mcp.json"), "utf8")) === PERSON_MCP);
});

test("a home in another plugin's data is not the launch's account home: nothing is written there, the default home is used", async (t) => {
  const fix = await fixture(t);
  const home = fix.accountHome("accounts", "a");
  for (const [provider, variable] of [["grok", "GROK_HOME"], ["kimi", "KIMI_CODE_HOME"]]) {
    const card = await contributedCard(t, fix, { provider, variable, home, owner: "other" });
    assert.deepEqual(await readdir(home), [], provider);
    if (provider === "grok") assert.equal(await exists(join(fix.defaultGrok, ...GROK_FILE)), true);
    else assert.match(await readFile(join(fix.defaultKimi, "config.toml"), "utf8"), /CanvasTTY lifecycle hooks/u);
    card.exit();
  }
});
