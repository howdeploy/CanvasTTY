import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { configuredMode } from "../src/main/services/configuredMode.ts";
import { EnvironmentRegistry } from "../src/main/services/EnvironmentRegistry.ts";
import { AgentIsolation } from "../src/main/services/isolation/AgentIsolation.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

const PLUGIN = "com.example.env";
// The program the environment wraps the agent in: an absolute path to a program on every platform (the registry
// refuses anything else; "/bin/sh" is not one on Windows). The spawner is fake, so it never runs.
const WRAPPER = process.execPath;
const at = { x: 0, y: 0 };
const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

function setup(t, keeps, project) {
  const registry = new EnvironmentRegistry({
    providers: () => [{ pluginId: PLUGIN, pluginName: "Env", serviceId: "env", secrets: false,
      kinds: [{ kind: "box", label: "Box", executionLocation: "local", ...(keeps ? { keeps } : {}) }] }],
    call: async (_pluginId, _serviceId, method, params) => {
      const step = method.replace("canvastty.environment.", "");
      if (step === "prepare") return { ref: { box: "b-1" }, label: "box b-1" };
      if (step === "wrap") return { command: WRAPPER, args: ["box", params.command, ...params.args], cwd: params.cwd };
      if (step === "resume") return { ok: true };
      return {};
    },
    secret: async () => null
  });
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  t.after(() => terminals.shutdown());
  terminals.configureEnvironments(registry);
  terminals.configureIsolation({
    containment: () => true,
    decide: (input) => new AgentIsolation({ userDataPath: "/u", enabled: () => true, platform: "darwin", exists: () => true }).decide(input),
    wrap: (launch) => ({ command: "/usr/bin/sandbox-exec", args: ["-f", "/p.sb", launch.command, ...launch.args], env: launch.env, cleanup() {} })
  });
  const create = (profile) => terminals.create({ provider: "codex", profile, cwd: project, position: at, environment: { pluginId: PLUGIN, kind: "box" } });
  const card = (id) => terminals.list().find((session) => session.id === id);
  return { terminals, calls, create, card };
}

test("environments declare what they keep: keeps is validated in the manifest", () => {
  const manifest = (keeps) => validatePluginManifest({
    apiVersion: 2, id: "com.example.k", name: "K", version: "1.0.0", description: "d", author: "a", permissions: ["environment:provide"],
    services: [{ id: "s", title: "S", description: "d", entry: "s.mjs", environments: [{ kind: "box", label: "Box", executionLocation: "local", keeps }] }], contributions: []
  });
  assert.deepEqual(manifest({ launch: true, isolated: true }).services[0].environments[0].keeps, { launch: true, isolated: true });
  assert.throws(() => manifest({ hooks: true }), /keeps/u);
  assert.throws(() => manifest({ launch: "yes" }), /keeps\.launch must be true or false/u);
});

test("an environment that does not pass the launch on refuses any profile but normal, and marks the card", async (t) => {
  const project = await realpath(await mkdtemp(join(tmpdir(), "ctty-keeps-")));
  t.after(() => rm(project, { recursive: true, force: true }));
  const { calls, create, card } = setup(t, undefined, project);
  const auto = create("auto");
  await waitFor(() => card(auto.id).status === "failed");
  assert.match(card(auto.id).failureDetails, /^Launch refused: box b-1 does not pass the launch on unchanged .* the auto profile's settings and CanvasTTY's hooks would not reach the agent/u);
  assert.equal(calls.length, 0);
  const normal = create("normal");
  await waitFor(() => calls.length === 1);
  assert.match(card(normal.id).isolation.reason, /Base protection and CanvasTTY's hooks do not reach the agent in box b-1/u);
});

test("an isolated environment (container, remote) is not wrapped again; a local one runs inside the layer", async (t) => {
  const project = await realpath(await mkdtemp(join(tmpdir(), "ctty-keeps-")));
  t.after(() => rm(project, { recursive: true, force: true }));
  const container = setup(t, { launch: true, isolated: true, confines: true }, project);
  const inside = container.create("auto");
  await waitFor(() => container.calls.length === 1);
  assert.equal(container.calls[0].command, WRAPPER, "no second sandbox around a container");
  assert.equal(container.card(inside.id).isolation.state, "environment");
  // No shell guard is claimed for a wrapped launch (OpenCode would otherwise run commands without asking).
  const local = setup(t, { launch: true }, project);
  const worktree = local.create("auto");
  await waitFor(() => local.calls.length === 1);
  assert.equal(local.calls[0].command, "/usr/bin/sandbox-exec", "the local environment's command runs inside the layer");
  assert.deepEqual(local.calls[0].args.slice(0, 3), ["-f", "/p.sb", WRAPPER]);
  assert.equal(local.card(worktree.id).isolation.state, "on");
});

test("manual shows when the CLI's own configuration skips approvals", () => {
  // configuredMode builds the paths it reads with the host's path rules (backslashes on Windows): so does the fixture.
  const home = join(sep, "h");
  const project = join(sep, "p");
  const at = (...parts) => join(...parts);
  const files = new Map([
    [at(home, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } })],
    [at(home, ".codex", "config.toml"), 'model = "x"\napproval_policy = "never"\n[projects."/p"]\ntrust_level = "trusted"\n'],
    [at(home, ".config", "opencode", "opencode.json"), JSON.stringify({ permission: "allow" })]
  ]);
  const read = (path) => files.get(path) ?? null;
  assert.deepEqual(configuredMode("claude", { HOME: home }, project, read), { mode: "bypassPermissions", source: at(home, ".claude", "settings.json") });
  assert.deepEqual(configuredMode("codex", { HOME: home }, project, read), { mode: "approval_policy=never", source: at(home, ".codex", "config.toml") });
  assert.deepEqual(configuredMode("opencode", { HOME: home }, project, read), { mode: "permission=allow", source: at(home, ".config", "opencode", "opencode.json") });
  files.set(at(project, ".claude", "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "default" } }));
  assert.equal(configuredMode("claude", { HOME: home }, project, read), null, "a later file that asks again wins");
  assert.equal(configuredMode("grok", { HOME: home }, project, read), null);
});
