import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService, subagentFolder } from "../src/main/services/AgentControlService.ts";
import { EnvironmentRegistry } from "../src/main/services/EnvironmentRegistry.ts";
import { AgentIsolation, SANDBOX_EXEC } from "../src/main/services/isolation/AgentIsolation.ts";
import { contributedAccountHome, validateAccountHome } from "../src/main/services/isolation/accountHomeIsolation.ts";
import { bubblewrapArguments } from "../src/main/services/isolation/bubblewrap.ts";
import { isolationPaths } from "../src/main/services/isolation/isolationPaths.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

// Plugin data and gateway sockets together: the account home a launch plugin selected stays open, a CANVASTTY_*_ADDRESS
// that did not come from CanvasTTY's own gateways binds nothing, and a folder inside plugin data is a project only
// where CanvasTTY itself placed the launch. Any plugin ids: the host treats every plugin's data the same way.
const ACCOUNTS = "com.example.accounts";
const ENVIRONMENTS = "com.example.env";
const posixHost = { skip: process.platform === "win32" ? "bubblewrap and seatbelt paths are POSIX paths" : false };
const mac = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const onMac = { skip: mac ? false : "macOS seatbelt (sandbox-exec) only" };
const at = { x: 0, y: 0 };
const BWRAP = "/usr/bin/bwrap";
// The program an environment wraps the agent in; the spawner is fake, so it never runs.
const WRAPPER = process.execPath;

/** A folder that holds CanvasTTY's userData (like a project at HOME), with an accounts plugin and an environment plugin. */
async function world(t) {
  // Short: Unix socket paths are limited to ~104 bytes, so /tmp rather than macOS's long per-user folder.
  const base = await realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "ctty-hard-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "h");
  const userData = join(base, "u");
  const pluginData = join(userData, "plugin-data");
  const homes = join(pluginData, ACCOUNTS, "homes");
  const selected = join(homes, "acct-1");
  const sibling = join(homes, "acct-2");
  const worktrees = join(pluginData, ENVIRONMENTS, "worktrees");
  const worktree = join(worktrees, "w1");
  const otherWorktree = join(worktrees, "w2");
  const lifecycle = join(userData, "lifecycle", "runtime");
  const project = join(base, "p");
  const temp = join(base, "t");
  for (const dir of [home, join(home, ".ssh"), selected, sibling, worktree, otherWorktree, lifecycle, project, temp,
    join(userData, "agent-control")]) await mkdir(dir, { recursive: true });
  await writeFile(join(selected, "auth.json"), "FAKE-SELECTED-TOKEN\n");
  await writeFile(join(sibling, "auth.json"), "FAKE-SIBLING-TOKEN\n");
  await writeFile(join(otherWorktree, "file.txt"), "other worktree\n");
  await writeFile(join(userData, "agent-control", "token-app"), "FAKE-APP-TOKEN\n");
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  return { base, home, userData, pluginData, homes, selected, sibling, worktrees, worktree, otherWorktree, lifecycle, project, temp, env };
}

const linux = (w) => new AgentIsolation({ userDataPath: w.userData, enabled: () => true, platform: "linux", bubblewrapPath: BWRAP,
  bubblewrapProbe: () => null, tempRoot: w.temp, hostEnvironment: w.env });

/** The last mount whose target is `path` or one of its folders (a later mount on a folder hides earlier ones under it). */
function mountFor(args, path) {
  let found = null;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--") break;
    let target = null;
    let mode = null;
    if (flag === "--bind" || flag === "--dev-bind") { target = args[i + 2]; mode = "bind"; i += 2; }
    else if (flag === "--ro-bind") { target = args[i + 2]; mode = "ro"; i += 2; }
    else if (flag === "--tmpfs") { target = args[i + 1]; mode = "tmpfs"; i += 1; }
    else if (flag === "--proc" || flag === "--chdir") { i += 1; continue; }
    else continue;
    if (path === target || path.startsWith(`${target.replace(/\/+$/u, "")}/`)) found = { target, mode };
  }
  return found;
}

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

/** A TerminalManager whose isolation layer is the real Linux one (bubblewrap arguments, the PTY spawner is fake). */
function manager(t, w, { runtime, environments } = {}) {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, runtime, true, fakeSpawner(calls));
  t.after(() => terminals.shutdown());
  const layer = linux(w);
  // The launch environment comes from this process; the layer gets the fixture's HOME instead (it may put placeholder
  // files into the CLI's folders there), and a CLI home only when a launch plugin set one inside the fixture.
  const hermetic = (env) => {
    const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(XDG_|CLAUDE_CONFIG_DIR$|GROK_HOME$)/u.test(key)));
    return { ...kept, HOME: w.home, CODEX_HOME: env.CODEX_HOME?.startsWith(`${w.base}/`) ? env.CODEX_HOME : join(w.home, ".codex") };
  };
  terminals.configureIsolation({ containment: () => true, decide: (input) => layer.decide(input),
    wrap: (launch) => layer.wrap({ ...launch, env: hermetic(launch.env) }) });
  if (environments) terminals.configureEnvironments(environments);
  const card = (id) => terminals.list().find((session) => session.id === id);
  return { terminals, calls, card };
}

test("together: the selected account home stays open, a plugin's CANVASTTY_*_ADDRESS binds nothing, the gateway folder is read-only", posixHost, async (t) => {
  const w = await world(t);
  const runtimeSocket = join(w.lifecycle, "r.sock");
  // A plugin aims a socket address at the accounts plugin's homes: before, its folder was bound writable after the
  // tmpfs over plugin data, which reopened every account's sign-in.
  const foreign = join(w.homes, "foo.sock");
  const runtime = {
    prepareLaunch: () => ({ args: [], environment: { CANVASTTY_RUNTIME_ADDRESS: runtimeSocket, CANVASTTY_RUNTIME_CAPABILITY: "c" }, cleanup() {} }),
    currentStatus: () => null
  };
  const { terminals, calls, card } = manager(t, w, { runtime });
  // The launch pipeline already refuses CANVASTTY_* names from plugins; the layer must not depend on that.
  terminals.configureLaunchPipeline({
    normalizeOptions: (_provider, options) => options,
    unavailable: () => [],
    forgetSession: async () => undefined,
    prepare: async () => ({ ok: true, env: { CODEX_HOME: w.selected, CANVASTTY_FOO_ADDRESS: foreign }, args: [], secrets: [],
      envSources: { CODEX_HOME: "Plugin Accounts", CANVASTTY_FOO_ADDRESS: "Plugin Accounts" }, thirdPartyModel: false,
      accountHome: w.selected, cleanup: async () => undefined })
  });
  const created = terminals.create({ provider: "codex", profile: "acceptEdits", cwd: w.project, position: at,
    launchOptions: { [ACCOUNTS]: { account: "acct-1" } } });
  await waitFor(() => calls.length === 1 || card(created.id).status === "failed");
  assert.equal(card(created.id).failureDetails, null);
  const { command, args, options } = calls[0];
  assert.equal(command, BWRAP);
  assert.equal(options.env.CODEX_HOME, w.selected);
  assert.equal(options.env.CANVASTTY_FOO_ADDRESS, foreign, "the variable itself still reaches the agent");
  // The selected account home: bound back, writable (it is the CLI's own home).
  assert.deepEqual(mountFor(args, join(w.selected, "auth.json")), { target: w.selected, mode: "bind" });
  // The plugin's address bound nothing: the other account and the homes folder stay under the tmpfs over plugin data.
  assert.deepEqual(mountFor(args, join(w.sibling, "auth.json")), { target: w.pluginData, mode: "tmpfs" });
  assert.deepEqual(mountFor(args, foreign), { target: w.pluginData, mode: "tmpfs" });
  assert.ok(!args.some((arg, i) => (arg === "--bind" || arg === "--ro-bind") && args[i + 2] === w.homes), "the homes folder is never bound");
  // CanvasTTY's own gateway folder: read-only, never writable.
  assert.deepEqual(mountFor(args, runtimeSocket), { target: w.lifecycle, mode: "ro" });
  assert.ok(!args.some((arg, i) => arg === "--bind" && args[i + 2] === w.lifecycle));
});

test("a subagent cannot work in CanvasTTY's private data, even when its project (the home folder) contains it", async (t) => {
  const w = await world(t);
  const refused = /cannot work in .*: it is CanvasTTY's private data/u;
  for (const requested of [w.homes, w.selected, join(w.pluginData, ACCOUNTS), w.pluginData, join(w.userData, "agent-control"), w.worktree]) {
    assert.match(subagentFolder(w.base, w.base, requested, w.userData).error ?? "", refused, requested);
  }
  assert.deepEqual(subagentFolder(w.base, w.base, w.project, w.userData), { cwd: w.project }, "the rest of the project is fine");
  assert.deepEqual(subagentFolder(w.base, w.base, join(w.userData, "lifecycle"), w.userData), { cwd: join(w.userData, "lifecycle") },
    "userData outside its private data is the project's like any folder");
  // A project that is an environment's worktree: its own folders, never a whole plugin's data above it.
  const sub = join(w.worktree, "src");
  await mkdir(sub);
  assert.deepEqual(subagentFolder(w.worktree, w.worktree, "src", w.userData), { cwd: sub });
  assert.match(subagentFolder(join(w.pluginData, ENVIRONMENTS), w.worktree, w.worktree, w.userData).error ?? "", refused,
    "a project that is a whole plugin's data does not open its folders");

  // Through the service: an orchestrator the person started in the folder above userData.
  const { terminals } = manager(t, w);
  const control = new AgentControlService(terminals, { containment: () => true, userDataPath: w.userData });
  const parent = terminals.create({ provider: "codex", profile: "normal", cwd: w.base, position: at, role: "orchestrator" });
  assert.throws(() => control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: w.homes }), refused);
  const child = await control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: w.project });
  assert.equal(child.cwd, w.project);
});

test("the layer opens a project inside plugin data only where CanvasTTY placed the launch", posixHost, async (t) => {
  const w = await world(t);
  const notPlaced = /inside CanvasTTY's private plugin data, and CanvasTTY did not place this launch there/u;

  // The exploit, past the subagent check: an agent's subagent asked for the account homes as its folder.
  const { terminals, calls, card } = manager(t, w);
  const parent = terminals.create({ provider: "codex", profile: "normal", cwd: w.base, position: at, role: "orchestrator" });
  const exploit = terminals.create({ provider: "codex", profile: "acceptEdits", cwd: w.homes, position: at, role: "subagent",
    parentSessionId: parent.id });
  assert.equal(card(exploit.id).status, "failed");
  assert.match(card(exploit.id).failureDetails, notPlaced);
  assert.equal(calls.filter((call) => call.command === BWRAP).length, 0, "nothing ran");

  // The folder the person chose for a card, and its subagents below it: opened (the person's choice).
  const chosen = terminals.create({ provider: "codex", profile: "acceptEdits", cwd: w.worktree, position: at, role: "orchestrator" });
  assert.equal(card(chosen.id).failureDetails, null);
  const below = join(w.worktree, "src");
  await mkdir(below);
  const nested = terminals.create({ provider: "codex", profile: "acceptEdits", cwd: below, position: at, role: "subagent", parentSessionId: chosen.id });
  assert.equal(card(nested.id).failureDetails, null);
  const launched = calls.filter((call) => call.command === BWRAP);
  assert.equal(launched.length, 2);
  assert.deepEqual(mountFor(launched[0].args, join(w.worktree, "f")), { target: w.worktree, mode: "bind" });
  assert.deepEqual(mountFor(launched[0].args, join(w.otherWorktree, "file.txt")), { target: w.pluginData, mode: "tmpfs" });

  // The pure check: no placement, a placement elsewhere, or one an environment of another plugin claims: refused.
  const base = { provider: "codex", cwd: w.worktree, sessionTemp: join(w.temp, "s"), userDataPath: w.userData, sessionId: "s", env: w.env };
  assert.throws(() => isolationPaths(base), notPlaced);
  assert.throws(() => isolationPaths({ ...base, placedProjects: [{ folder: w.base }] }), notPlaced, "a project above plugin data places nothing in it");
  assert.throws(() => isolationPaths({ ...base, placedProjects: [{ folder: w.worktree, pluginId: ACCOUNTS }] }), notPlaced, "another plugin's environment");
  assert.throws(() => isolationPaths({ ...base, placedProjects: [{ folder: w.worktree, pluginId: "../com.example.env" }] }), notPlaced);
  assert.throws(() => isolationPaths({ ...base, cwd: w.homes, placedProjects: [{ folder: w.worktree, pluginId: ENVIRONMENTS }] }), notPlaced);
  const paths = isolationPaths({ ...base, placedProjects: [{ folder: w.worktree, pluginId: ENVIRONMENTS }] });
  assert.deepEqual(paths.readableAgain.filter((path) => path.startsWith(w.pluginData)), [w.worktree]);
});

test("an environment's worktree inside its own plugin data still runs inside the layer; one in another plugin's data does not", posixHost, async (t) => {
  const w = await world(t);
  const environments = (cwd) => new EnvironmentRegistry({
    providers: () => [{ pluginId: ENVIRONMENTS, pluginName: "Env", serviceId: "env", secrets: false,
      kinds: [{ kind: "worktree", label: "Worktree", keeps: { launch: true } }] }],
    call: async (_pluginId, _serviceId, method, params) => {
      const step = method.replace("canvastty.environment.", "");
      if (step === "prepare") return { ref: { id: "w1" }, label: "worktree w1", cwd };
      if (step === "wrap") return { command: WRAPPER, args: ["run", params.command, ...params.args], cwd: params.cwd };
      if (step === "resume") return { ok: true };
      return {};
    },
    secret: async () => null
  });
  const create = (terminals) => terminals.create({ provider: "codex", profile: "acceptEdits", cwd: w.project, position: at,
    environment: { pluginId: ENVIRONMENTS, kind: "worktree" } });

  const own = manager(t, w, { environments: environments(w.worktree) });
  const placed = create(own.terminals);
  await waitFor(() => own.calls.length === 1 || own.card(placed.id).status === "failed");
  assert.equal(own.card(placed.id).failureDetails, null);
  assert.equal(own.card(placed.id).cwd, w.worktree);
  const { command, args } = own.calls[0];
  assert.equal(command, BWRAP);
  assert.deepEqual(mountFor(args, join(w.worktree, "new.txt")), { target: w.worktree, mode: "bind" });
  assert.deepEqual(mountFor(args, join(w.otherWorktree, "file.txt")), { target: w.pluginData, mode: "tmpfs" });
  assert.deepEqual(mountFor(args, join(w.selected, "auth.json")), { target: w.pluginData, mode: "tmpfs" });

  // The environment plugin answers with the accounts plugin's homes: not its own data, so the launch is refused.
  const foreign = manager(t, w, { environments: environments(w.homes) });
  const refused = create(foreign.terminals);
  await waitFor(() => foreign.card(refused.id).status === "failed");
  assert.match(foreign.card(refused.id).failureDetails, /CanvasTTY did not place this launch there/u);
  assert.equal(foreign.calls.length, 0);
});

test("account homes and socket folders: a trailing separator names the same home; a socket folder over a writable one is refused", posixHost, async (t) => {
  const w = await world(t);
  const dataDir = join(w.pluginData, ACCOUNTS);
  assert.equal(contributedAccountHome("codex", dataDir, "CODEX_HOME", `${w.selected}/`), w.selected);
  assert.equal(contributedAccountHome("codex", dataDir, "CODEX_HOME", `${w.selected}//`), w.selected);
  assert.equal(validateAccountHome(w.userData, "codex", w.selected, { CODEX_HOME: `${w.selected}/` }), w.selected);
  // Only the CLI's own home variable counts: never HOME or XDG_* (OpenCode's is OPENCODE_CONFIG_DIR).
  for (const [provider, key] of [["opencode", "XDG_CONFIG_HOME"], ["opencode", "XDG_DATA_HOME"], ["codex", "HOME"]]) {
    assert.equal(contributedAccountHome(provider, dataDir, key, w.selected), undefined, `${provider} ${key}`);
  }
  assert.equal(contributedAccountHome("opencode", dataDir, "OPENCODE_CONFIG_DIR", w.selected), w.selected);

  // A gateway socket folder that holds the writable project would make it read-only and undo its hooks tmpfs.
  const work = join(w.base, "work");
  const project = join(work, "p");
  await mkdir(project, { recursive: true });
  const sessionTemp = join(w.temp, "s");
  const paths = isolationPaths({ provider: "codex", cwd: project, sessionTemp, env: w.env, userDataPath: w.userData, sessionId: "s",
    gatewaySockets: [join(work, "gw.sock")] });
  const kinds = new Map([[project, "directory"], [work, "directory"], [sessionTemp, "directory"]]);
  assert.throws(() => bubblewrapArguments(paths, { command: "/usr/bin/codex", args: [], cwd: project }, (path) => kinds.get(path) ?? null),
    /gateway socket folder .*work contains .*p, which the agent writes/u);
});

test("seatbelt, for real: account home open, siblings and a foreign socket closed, gateway folder read-only, homes never a project", onMac, async (t) => {
  const w = await world(t);
  const runtimeSocket = join(w.lifecycle, "r.sock");
  const foreignFolder = join(w.base, "o");
  await mkdir(foreignFolder);
  const foreignSocket = join(foreignFolder, "f.sock");
  const servers = [runtimeSocket, foreignSocket].map((path) => {
    const server = createServer((socket) => socket.end());
    server.listen(path);
    return server;
  });
  t.after(() => servers.forEach((server) => server.close()));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const layer = new AgentIsolation({ userDataPath: w.userData, enabled: () => true, tempRoot: w.temp, hostEnvironment: w.env });
  const probe = (path, label) => `/usr/bin/python3 -c "import socket
s=socket.socket(socket.AF_UNIX)
try:
  s.connect('${path}'); print('${label}-CONNECT-ok')
except Exception: print('${label}-CONNECT-denied')"`;
  const wrapped = layer.wrap({
    sessionId: "together",
    provider: "codex",
    cwd: w.project,
    command: "/bin/sh",
    args: ["-c", [
      'cat "$CODEX_HOME/auth.json" >/dev/null && echo OWN-READ-ok',
      'echo actor > "$CODEX_HOME/actor.txt" && echo OWN-WRITE-ok',
      `cat ${JSON.stringify(join(w.sibling, "auth.json"))} >/dev/null 2>&1 || echo SIBLING-READ-denied`,
      `ls ${JSON.stringify(w.homes)} >/dev/null 2>&1 || echo HOMES-LIST-denied`,
      probe(runtimeSocket, "GATEWAY"),
      probe(foreignSocket, "FOREIGN"),
      `rm -f ${JSON.stringify(runtimeSocket)} 2>/dev/null; [ -S ${JSON.stringify(runtimeSocket)} ] && echo GATEWAY-RM-denied`,
      `touch ${JSON.stringify(join(w.lifecycle, "planted"))} 2>/dev/null || echo GATEWAY-WRITE-denied`
    ].join("; ")],
    env: { ...w.env, CODEX_HOME: w.selected, CANVASTTY_RUNTIME_ADDRESS: runtimeSocket, CANVASTTY_FOO_ADDRESS: foreignSocket },
    profile: "acceptEdits",
    accountHome: w.selected,
    gatewaySockets: [runtimeSocket]
  });
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: w.project, env: wrapped.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split("\n").filter(Boolean), [
      "OWN-READ-ok", "OWN-WRITE-ok", "SIBLING-READ-denied", "HOMES-LIST-denied",
      "GATEWAY-CONNECT-ok", "FOREIGN-CONNECT-denied", "GATEWAY-RM-denied", "GATEWAY-WRITE-denied"
    ]);
    assert.equal(await readFile(join(w.selected, "actor.txt"), "utf8"), "actor\n");
    assert.equal(existsSync(join(w.lifecycle, "planted")), false);
  } finally {
    wrapped.cleanup();
  }
  // The exploit's folder as a project (a subagent's cwd, not placed by CanvasTTY): the layer is never set up.
  assert.throws(() => layer.wrap({ sessionId: "exploit", provider: "codex", cwd: w.homes, command: "/bin/sh", args: ["-c", "true"],
    env: w.env, profile: "acceptEdits" }), /did not place this launch there/u);
  // An environment's worktree placed by its own plugin: writable there, nothing else of plugin data readable.
  const placed = layer.wrap({ sessionId: "worktree", provider: "codex", cwd: w.worktree, command: "/bin/sh", args: ["-c", [
    "echo x > new.txt && echo WORKTREE-WRITE-ok",
    `cat ${JSON.stringify(join(w.otherWorktree, "file.txt"))} >/dev/null 2>&1 || echo OTHER-WORKTREE-denied`,
    `cat ${JSON.stringify(join(w.selected, "auth.json"))} >/dev/null 2>&1 || echo ACCOUNT-denied`
  ].join("; ")], env: w.env, profile: "acceptEdits", placedProjects: [{ folder: w.worktree, pluginId: ENVIRONMENTS }] });
  try {
    const result = spawnSync(placed.command, placed.args, { cwd: w.worktree, env: placed.env, encoding: "utf8", timeout: 20_000 });
    assert.deepEqual(result.stdout.split("\n").filter(Boolean), ["WORKTREE-WRITE-ok", "OTHER-WORKTREE-denied", "ACCOUNT-denied"]);
  } finally {
    placed.cleanup();
  }
});
