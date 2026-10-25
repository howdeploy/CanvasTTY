import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { AgentIsolation, SANDBOX_EXEC } from "../src/main/services/isolation/AgentIsolation.ts";
import { isolationPaths } from "../src/main/services/isolation/isolationPaths.ts";
import { bubblewrapArguments } from "../src/main/services/isolation/bubblewrap.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { DecisionHooks } from "../src/main/services/DecisionHooks.ts";
import { canvasTtyPrivateData } from "../src/main/services/safety/baseProtection.ts";

// Any plugin id: the host treats every plugin's data the same way.
const PLUGIN = "com.example.accounts";
const OTHER = "com.example.other";
const mac = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const onMac = { skip: mac ? false : "macOS seatbelt (sandbox-exec) only" };

async function fixture(t) {
  // Short: Unix socket paths are limited to ~104 bytes, so /tmp rather than macOS's long per-user folder.
  const root = await realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "ctty-acct-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "u");
  const pluginData = join(userData, "plugin-data");
  const accountData = join(pluginData, PLUGIN);
  const otherData = join(pluginData, OTHER);
  const homes = join(accountData, "homes");
  const project = join(root, "p");
  const temp = join(root, "t");
  const home = join(root, "h");
  await Promise.all([homes, otherData, project, temp, home].map((path) => mkdir(path, { recursive: true })));
  return { root, userData, pluginData, accountData, otherData, homes, project, temp, home };
}

async function prepare(f, options = {}) {
  const provider = options.provider ?? "codex";
  const pluginId = options.pluginId ?? PLUGIN;
  const dataDir = Object.hasOwn(options, "dataDir") ? options.dataDir : join(f.pluginData, pluginId);
  const env = options.env ?? { CODEX_HOME: join(f.homes, "codex-alternate") };
  const requests = [];
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId, pluginName: "Accounts", serviceId: "accounts", launch: { fields: [] }, secrets: false,
      ...(dataDir === undefined ? {} : { dataDir }) }],
    call: async (calledId, _serviceId, _method, params) => {
      requests.push({ calledId, params });
      return { env, ...(options.answerExtra ?? {}) };
    },
    secret: async () => null,
    runsRoot: join(f.userData, "launch-runs")
  });
  const result = await pipeline.prepare({ sessionId: "fixture", provider, profile: "normal", role: "agent", cwd: f.project,
    restoring: false, resume: false, options: { [pluginId]: { account: "alternate" } }, environment: null });
  return { result, requests };
}

function isolation(f, extra = {}) {
  return new AgentIsolation({
    userDataPath: f.userData,
    enabled: () => true,
    tempRoot: f.temp,
    hostEnvironment: { HOME: f.home, PATH: "/usr/bin:/bin" },
    ...extra
  });
}

const fakeSeatbelt = { platform: "darwin", exists: (path) => path === SANDBOX_EXEC };

test("the selected account home is the exact CLI home a chosen contributor set inside its own data, and stays out of plugin RPC", async (t) => {
  const f = await fixture(t);
  const accountHome = join(f.homes, "codex-alternate");
  const { result, requests } = await prepare(f, { env: { CODEX_HOME: accountHome } });
  assert.equal(result.ok, true);
  assert.equal(result.accountHome, accountHome);
  assert.deepEqual(result.env, { CODEX_HOME: accountHome });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].calledId, PLUGIN);
  for (const hostOnly of ["dataDir", "accountHome", "grantedPrivate"]) {
    assert.equal(Object.hasOwn(requests[0].params, hostOnly), false, `${hostOnly} is host-only`);
  }
  await result.cleanup();

  for (const [provider, key] of [["claude", "CLAUDE_CONFIG_DIR"], ["grok", "GROK_HOME"]]) {
    const own = join(f.homes, `${provider}-alternate`);
    const other = await prepare(f, { provider, env: { [key]: own } });
    assert.equal(other.result.ok, true);
    assert.equal(other.result.accountHome, own, provider);
    await other.result.cleanup();
  }
});

test("no account home without host authority, outside the contributor's own data, at its data root or through another variable", async (t) => {
  const f = await fixture(t);
  const cases = [
    { name: "no host data folder", dataDir: undefined, env: { CODEX_HOME: join(f.homes, "codex-a") } },
    { name: "another plugin's data", env: { CODEX_HOME: join(f.otherData, "codex-a") } },
    { name: "the plugin's whole data folder", env: { CODEX_HOME: f.accountData } },
    { name: "all plugin data", env: { CODEX_HOME: f.pluginData } },
    { name: "a path that climbs out", env: { CODEX_HOME: `${f.homes}/../../${OTHER}/codex-a` } },
    { name: "another provider's variable", env: { CLAUDE_CONFIG_DIR: join(f.homes, "claude-a") } },
    { name: "a variable that is not a CLI home", env: { SOME_DIR: join(f.homes, "codex-a") } },
    { name: "a Claude home for Codex", provider: "claude", env: { CODEX_HOME: join(f.homes, "codex-a") } },
    { name: "outside plugin data", env: { CODEX_HOME: join(f.root, "elsewhere") } }
  ];
  for (const row of cases) {
    const { result } = await prepare(f, row);
    assert.equal(result.ok, true, row.name);
    assert.equal(result.accountHome, undefined, row.name);
    await result.cleanup();
  }
});

test("a plugin cannot name an isolation grant in its answer", async (t) => {
  const f = await fixture(t);
  const accountHome = join(f.homes, "codex-alternate");
  for (const key of ["accountHome", "grantedPrivate", "dataDir"]) {
    const { result } = await prepare(f, { env: { CODEX_HOME: accountHome }, answerExtra: { [key]: [f.pluginData] } });
    assert.equal(result.ok, false, key);
    assert.match(result.reason, /unknown key/u);
  }
});

test("an isolated agent's paths hide all plugin data and reopen only the selected home", async (t) => {
  const f = await fixture(t);
  const selected = join(f.homes, "codex-alternate");
  const sibling = join(f.homes, "codex-other");
  await Promise.all([selected, sibling].map((path) => mkdir(path)));
  const base = { provider: "codex", cwd: f.project, sessionTemp: join(f.temp, "s"), userDataPath: f.userData, sessionId: "s",
    hostEnvironment: { HOME: f.home } };

  const plain = isolationPaths({ ...base, env: { HOME: f.home } });
  assert.ok(plain.unreadable.includes(f.pluginData), "plugin data is private app data");
  assert.ok(!plain.readableAgain.some((path) => path.startsWith(f.pluginData)), "nothing of it is reopened without a selection");

  const paths = isolationPaths({ ...base, env: { HOME: f.home, CODEX_HOME: selected }, grantedPrivate: [selected] });
  assert.ok(paths.unreadable.includes(f.pluginData));
  assert.deepEqual(paths.readableAgain.filter((path) => path.startsWith(f.pluginData)), [selected]);
  assert.ok(paths.writable.includes(selected), "the CLI's own home stays writable");
  assert.ok(!paths.readableAgain.includes(sibling) && !paths.readableAgain.includes(f.homes) && !paths.readableAgain.includes(f.accountData));

  // The CLI started with a home in plugin data that the launch was not handed: refused, never left readable.
  assert.throws(() => isolationPaths({ ...base, env: { HOME: f.home, CODEX_HOME: sibling }, grantedPrivate: [selected] }),
    /overlaps protected CanvasTTY data/u);

  // Linux: an empty tmpfs over all plugin data, then only the selected home bound back (writable: it is the CLI's).
  // Its config.toml exists (LinuxHostPaths puts a placeholder there before a launch) and is read-only again.
  const kinds = new Map([[f.project, "directory"], [f.pluginData, "directory"], [selected, "directory"], [sibling, "directory"],
    [join(selected, "config.toml"), "file"]]);
  const text = bubblewrapArguments(paths, { command: "/usr/bin/codex", args: [], cwd: f.project }, (path) => kinds.get(path) ?? null).join(" ");
  const afterHidden = text.slice(text.indexOf(`--tmpfs ${f.pluginData}`));
  assert.ok(text.includes(`--tmpfs ${f.pluginData}`));
  assert.ok(afterHidden.includes(`--bind ${selected} ${selected}`));
  assert.ok(!text.includes(sibling));
});

test("AgentIsolation.wrap reopens only a real folder inside one plugin's data, never through a symbolic link", async (t) => {
  const f = await fixture(t);
  const sandbox = isolation(f, fakeSeatbelt);
  const wrap = (home, env = { CODEX_HOME: home }) => sandbox.wrap({ sessionId: "a", provider: "codex", cwd: f.project, command: "/bin/sh",
    args: [], env: { HOME: f.home, PATH: "/usr/bin:/bin", ...env }, profile: "acceptEdits", accountHome: home });

  const target = join(f.otherData, "secret");
  const alias = join(f.homes, "codex-alias");
  await mkdir(target, { recursive: true });
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  // The refusal says once that the agent was not started.
  const refusal = (why) => ({ name: "LaunchRefusal", message: `agent isolation could not be set up: ${why} The agent was not started without it.` });
  assert.throws(() => wrap(alias), refusal("The selected account home is missing or crosses a symbolic link."));
  assert.throws(() => wrap(join(f.homes, "codex-missing")), refusal("The selected account home is missing or crosses a symbolic link."));
  assert.throws(() => wrap(f.accountData), refusal("The selected account home must be a folder inside one plugin's data."));
  assert.throws(() => wrap("relative/home"), refusal("The selected account home must be an exact absolute folder."));

  const selected = join(f.homes, "codex-alternate");
  await mkdir(selected);
  const ok = wrap(selected);
  try {
    const profile = await readFile(ok.args[1], "utf8");
    assert.ok(profile.includes(`(deny file-read* file-write*`) && profile.includes(`(subpath "${f.pluginData}")`));
    assert.match(profile, new RegExp(`\\(allow file-read\\*[^\\n]*\\(subpath "${selected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"\\)`, "u"));
  } finally {
    ok.cleanup();
  }
  // An environment that replaced the CLI's home: nothing of plugin data is reopened, and the launch is not refused for it.
  const elsewhere = join(f.root, "elsewhere");
  await mkdir(elsewhere);
  const replaced = wrap(selected, { CODEX_HOME: elsewhere });
  try {
    assert.ok(!(await readFile(replaced.args[1], "utf8")).includes(`(subpath "${selected}")`));
  } finally {
    replaced.cleanup();
  }
});

test("a project inside plugin data that CanvasTTY placed there is reopened exactly; all of plugin data or a whole plugin's data is never a project", async (t) => {
  const f = await fixture(t);
  const worktree = join(f.otherData, "worktrees", "one");
  const sibling = join(f.otherData, "worktrees", "two");
  await Promise.all([worktree, sibling].map((path) => mkdir(path, { recursive: true })));
  const base = { provider: "codex", sessionTemp: join(f.temp, "s"), userDataPath: f.userData, sessionId: "s", env: { HOME: f.home } };
  // An environment of the plugin that owns the folder placed the launch there (TerminalManager.placedProjects).
  const placed = { placedProjects: [{ folder: worktree, pluginId: OTHER }] };
  const paths = isolationPaths({ ...base, cwd: worktree, ...placed });
  assert.ok(paths.unreadable.includes(f.pluginData));
  assert.deepEqual(paths.readableAgain.filter((path) => path.startsWith(f.pluginData)), [worktree]);
  assert.ok(paths.writable.includes(worktree));
  const plan = isolationPaths({ ...base, cwd: worktree, readOnlyProject: true, ...placed });
  assert.ok(plan.readableAgain.includes(worktree) && !plan.writable.includes(worktree), "plan keeps it read-only");
  for (const cwd of [f.pluginData, f.otherData]) {
    assert.throws(() => isolationPaths({ ...base, cwd, placedProjects: [{ folder: cwd }] }), /private plugin data/u, cwd);
  }
});

test("seatbelt, for real: an isolated agent reads and writes only its selected home in plugin data", onMac, async (t) => {
  const f = await fixture(t);
  const selected = join(f.homes, "codex-alternate");
  const sibling = join(f.homes, "codex-other");
  const otherPlugin = join(f.otherData, "worktrees", "sibling");
  const settings = join(f.accountData, "accounts.json");
  await Promise.all([selected, sibling, otherPlugin].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(selected, "marker"), "selected fixture home\n");
  await writeFile(join(sibling, "marker"), "sibling fixture home\n");
  await writeFile(join(otherPlugin, "marker"), "other plugin fixture\n");
  await writeFile(settings, "private account settings\n");
  const wrapped = isolation(f).wrap({
    sessionId: "selected-account",
    provider: "codex",
    cwd: f.project,
    command: "/bin/sh",
    args: ["-c", [
      'cat "$CODEX_HOME/marker" >/dev/null && echo OWN-READ-ok',
      'echo actor > "$CODEX_HOME/actor.txt" && echo OWN-WRITE-ok',
      'echo actor > "$CODEX_HOME/config.toml" 2>/dev/null || echo CLI-SETTINGS-WRITE-denied',
      `cat ${JSON.stringify(join(sibling, "marker"))} >/dev/null 2>&1 || echo ACCOUNT-SIBLING-READ-denied`,
      `echo actor >> ${JSON.stringify(join(sibling, "marker"))} 2>/dev/null || echo ACCOUNT-SIBLING-WRITE-denied`,
      `cat ${JSON.stringify(join(otherPlugin, "marker"))} >/dev/null 2>&1 || echo OTHER-PLUGIN-READ-denied`,
      `cat ${JSON.stringify(settings)} >/dev/null 2>&1 || echo SETTINGS-READ-denied`,
      `echo actor >> ${JSON.stringify(settings)} 2>/dev/null || echo SETTINGS-WRITE-denied`,
      `ls ${JSON.stringify(f.pluginData)} >/dev/null 2>&1 || echo PLUGIN-DATA-LIST-denied`
    ].join("; ")],
    env: { HOME: f.home, PATH: "/usr/bin:/bin", CODEX_HOME: selected },
    profile: "acceptEdits",
    accountHome: selected
  });
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: f.project, env: wrapped.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split("\n").filter(Boolean), [
      "OWN-READ-ok", "OWN-WRITE-ok", "CLI-SETTINGS-WRITE-denied", "ACCOUNT-SIBLING-READ-denied", "ACCOUNT-SIBLING-WRITE-denied",
      "OTHER-PLUGIN-READ-denied", "SETTINGS-READ-denied", "SETTINGS-WRITE-denied", "PLUGIN-DATA-LIST-denied"
    ]);
    assert.equal(await readFile(join(selected, "actor.txt"), "utf8"), "actor\n");
    assert.equal(existsSync(join(selected, "config.toml")), false);
    assert.equal(await readFile(join(sibling, "marker"), "utf8"), "sibling fixture home\n");
    assert.equal(await readFile(settings, "utf8"), "private account settings\n");
  } finally {
    wrapped.cleanup();
  }
});

test("seatbelt, for real: without a selected home an isolated agent reads no plugin data", onMac, async (t) => {
  const f = await fixture(t);
  const home = join(f.homes, "codex-a");
  await mkdir(home);
  await writeFile(join(home, "auth.json"), "FAKE-TOKEN\n");
  const wrapped = isolation(f).wrap({ sessionId: "plain", provider: "codex", cwd: f.project, command: "/bin/sh",
    args: ["-c", `cat ${JSON.stringify(join(home, "auth.json"))} 2>/dev/null || echo TOKEN-READ-denied`],
    env: { HOME: f.home, PATH: "/usr/bin:/bin" }, profile: "acceptEdits" });
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: f.project, env: wrapped.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.stdout.trim(), "TOKEN-READ-denied");
  } finally {
    wrapped.cleanup();
  }
});

test("a launch hands the isolation layer the account home its contributor selected", async (t) => {
  const f = await fixture(t);
  const selected = join(f.homes, "codex-alternate");
  await mkdir(selected);
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: PLUGIN, pluginName: "Accounts", serviceId: "accounts", dataDir: f.accountData, secrets: false,
      launch: { fields: [{ key: "account", label: "Account", kind: "text", default: "" }] } }],
    call: async () => ({ env: { CODEX_HOME: selected } }),
    secret: async () => null,
    runsRoot: join(f.userData, "launch-runs")
  });
  const calls = [];
  const spawner = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 41_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
  };
  const registry = {
    get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }),
    snapshot: () => ({})
  };
  const terminals = new TerminalManager(() => undefined, registry, undefined, undefined, true, spawner);
  t.after(() => terminals.shutdown());
  terminals.configureLaunchPipeline(pipeline);
  const wraps = [];
  const layer = isolation(f, fakeSeatbelt);
  terminals.configureIsolation({
    containment: () => true,
    decide: (input) => layer.decide(input),
    wrap: (launch) => {
      wraps.push(launch);
      return { command: SANDBOX_EXEC, args: ["-f", "/p.sb", launch.command, ...launch.args], env: launch.env, cleanup() {} };
    }
  });
  terminals.create({ provider: "codex", profile: "acceptEdits", cwd: f.project, position: { x: 0, y: 0 },
    launchOptions: { [PLUGIN]: { account: "alternate" } } });
  const deadline = Date.now() + 5_000;
  while (wraps.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(wraps.length, 1);
  assert.equal(wraps[0].accountHome, selected);
  assert.equal(wraps[0].env.CODEX_HOME, selected);
  assert.equal(calls.at(-1).command, SANDBOX_EXEC);
});

test("base protection: a card's own selected account home is its own; other accounts' homes and the rest of plugin data stay private", async (t) => {
  const f = await fixture(t);
  const selected = join(f.homes, "claude-alternate");
  const neighbour = join(f.homes, "claude-other");
  await Promise.all([selected, neighbour].map((path) => mkdir(path)));
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: PLUGIN, pluginName: "Accounts", serviceId: "accounts", dataDir: f.accountData, secrets: false,
      launch: { fields: [{ key: "account", label: "Account", kind: "text", default: "" }] } }],
    call: async (_pluginId, _serviceId, _method, params) => ({ env: params.provider === "codex" ? { CODEX_HOME: `${selected}/` } : { CLAUDE_CONFIG_DIR: selected } }),
    secret: async () => null,
    runsRoot: join(f.userData, "launch-runs")
  });
  const spawned = [];
  const spawner = (command) => {
    spawned.push(command);
    return { pid: 42_000 + spawned.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
  };
  const registry = {
    get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }),
    snapshot: () => ({})
  };
  const terminals = new TerminalManager(() => undefined, registry, undefined, undefined, true, spawner);
  t.after(() => terminals.shutdown());
  terminals.configureLaunchPipeline(pipeline);
  const hooks = new DecisionHooks({ baseProtection: () => true, services: () => [], call: async () => null, home: f.home,
    privateData: canvasTtyPrivateData(f.userData), session: (id) => terminals.decisionContext(id) });
  const decide = async (id, toolName, toolInput) =>
    (await hooks.decide(id, { toolName, toolInput, toolInputPreview: null, cwd: null, truncated: false }, new AbortController().signal)).behavior;
  // Person-launched (no isolation layer): base protection is the guard here.
  const withAccount = (provider) => terminals.create({ provider, profile: "auto", cwd: f.project, position: { x: 0, y: 0 },
    launchOptions: { [PLUGIN]: { account: "alternate" } } }).id;
  const plain = terminals.create({ provider: "claude", profile: "auto", cwd: f.project, position: { x: 0, y: 0 } }).id;
  const cards = [withAccount("claude"), withAccount("codex")];
  const deadline = Date.now() + 5_000;
  while (spawned.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(spawned.length, 3);
  for (const id of cards) {
    assert.ok(terminals.decisionContext(id).configDirs.includes(selected), id);
    assert.equal(await decide(id, "Read", { file_path: join(selected, "auth.json") }), "none", "own home");
    assert.equal(await decide(id, "Bash", { command: `cat '${join(selected, "auth.json")}'` }), "none", "own home");
    assert.equal(await decide(id, "Read", { file_path: join(neighbour, "auth.json") }), "deny", "another account's home");
    assert.equal(await decide(id, "Bash", { command: `cat '${join(neighbour, "auth.json")}'` }), "deny", "another account's home");
    assert.equal(await decide(id, "Read", { file_path: join(f.otherData, "state.json") }), "deny", "another plugin's data");
    assert.equal(await decide(id, "Read", { file_path: join(f.project, "a.ts") }), "none", "the project");
  }
  assert.equal(terminals.decisionContext(plain).configDirs.includes(selected), false);
  assert.equal(await decide(plain, "Read", { file_path: join(selected, "auth.json") }), "deny", "not this card's home");
  assert.equal(await decide(plain, "Bash", { command: "cat a.ts && grep -r todo ." }), "none", "a normal project is unaffected");
});
