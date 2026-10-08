import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_BROWSER_ENV } from "../src/main/services/agent-browser/AgentBrowserBridge.ts";
import { AgentRuntimeBridge } from "../src/main/services/agent-runtime/AgentRuntimeBridge.ts";
import { ClaudeHttpHookPolicy } from "../src/main/services/agent-runtime/ClaudeHttpHooks.ts";
import { EnvironmentRegistry } from "../src/main/services/EnvironmentRegistry.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";

test("strict network policy revokes existing browser grants and omits them from new launches", () => {
  let networkMode = "open";
  let browserPrepared = 0;
  let browserCleaned = 0;
  const browser = {
    prepareLaunch({ terminalSessionId }) {
      browserPrepared++;
      return {
        agentId: "agent", connectionId: terminalSessionId, args: [],
        environment: {
          [AGENT_BROWSER_ENV.address]: "/private/browser/gateway.sock",
          [AGENT_BROWSER_ENV.capabilityToken]: "browser-token"
        },
        cleanup() { browserCleaned++; }
      };
    }
  };
  const isolation = {
    decide({ profile }) {
      return networkMode === "open"
        ? { apply: false, profile }
        : { apply: true, profile, isolation: { state: "on", layer: "seatbelt" } };
    },
    networkPolicyFor() { return { mode: networkMode, domains: [] }; },
    containment() { return true; },
    wrap(launch) { return { command: launch.command, args: [...launch.args], env: launch.env, cleanup() {} }; }
  };
  const calls = [];
  const manager = new TerminalManager(
    () => undefined, availableRegistry(), browser, undefined, true, fakeSpawner(calls)
  );
  manager.configureIsolation(isolation);

  manager.create({
    provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 }
  });
  assert.equal(browserPrepared, 1, "open launches preserve the existing browser bridge");

  networkMode = "offline";
  assert.equal(manager.revokeBrowserCapabilitiesForStrictNetwork(), 1);
  assert.equal(browserCleaned, 1, "a policy change revokes a currently granted host browser lease");

  manager.create({
    provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 }
  });
  assert.equal(browserPrepared, 1, "strict launches do not prepare the browser bridge or issue a browser token");
  assert.ok(calls.length >= 2, "both launches still reach the PTY path");
  manager.disposeAll();
  assert.equal(browserCleaned, 1, "revoked browser capabilities are not cleaned up a second time");
});

test("Claude strict-network launches keep socket lifecycle hooks on Linux and preserve HTTP hooks when open", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-claude-network-hooks-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const runtimeDirectory = join(fixture, "runtime");
  const gateway = {
    httpHookBase: "http://127.0.0.1:43210",
    registerSession(terminalSessionId, provider) {
      return { address: join(runtimeDirectory, "agent-runtime.sock"), terminalSessionId, provider, capabilityToken: `cap-${terminalSessionId}` };
    },
    revokeTerminalSession() {},
    currentStatus() { return null; }
  };
  const policy = new ClaudeHttpHookPolicy({
    platform: "linux", home: fixture, managedSettingsPaths: [], readText: () => null, entry: () => null,
    version: () => "2.1.281"
  });
  const runtime = new AgentRuntimeBridge(gateway, {
    helper: { command: process.execPath, args: [join(fixture, "hook-helper.mjs")], env: {} },
    runtimeDirectory, openCodePluginPath: join(fixture, "opencode-plugin.mjs"), platform: "linux", environment: {},
    claudeHttpHooks: (facts) => policy.verdict(facts)
  });
  let networkMode = "open";
  const isolation = {
    decide({ profile }) {
      return networkMode === "open"
        ? { apply: false, profile }
        : { apply: true, profile, isolation: { state: "on", layer: "bubblewrap", network: { mode: networkMode, domains: [] } } };
    },
    networkPolicyFor() { return { mode: networkMode, domains: [] }; },
    containment() { return true; },
    wrap(launch) { return { command: launch.command, args: [...launch.args], env: launch.env, cleanup() {} }; }
  };
  const calls = [];
  const manager = new TerminalManager(() => undefined, availableRegistry(), undefined, runtime, true, fakeSpawner(calls));
  manager.configureIsolation(isolation);
  t.after(async () => { await manager.shutdown(); });

  for (const mode of ["open", "offline", "allowed-domains"]) {
    networkMode = mode;
    manager.create({ provider: "claude", cwd: fixture, profile: "normal", position: { x: 0, y: 0 } });
    const call = calls.at(-1);
    assert.ok(call, `${mode}: Claude launch reaches the fake PTY`);
    const settingsIndex = call.args.indexOf("--settings");
    assert.ok(settingsIndex >= 0, `${mode}: lifecycle settings are present`);
    const settings = JSON.parse(call.args[settingsIndex + 1]);
    const lifecycleHook = settings.hooks.Stop[0].hooks[0];
    if (mode === "open") {
      assert.equal(lifecycleHook.type, "http", "open Linux launch keeps the supported HTTP listener path");
    } else {
      assert.equal(lifecycleHook.type, "command", `${mode} Linux launch uses the gateway Unix-socket helper`);
      assert.match(lifecycleHook.command, /hook-helper\.mjs/u);
    }
  }
});

test("worktree placement and approved handoff retain the original network-policy root", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "canvastty-network-worktree-"));
  const projectRoot = join(fixture, "project");
  const worktreeRoot = join(fixture, "worktree");
  await Promise.all([mkdir(projectRoot), mkdir(worktreeRoot)]);
  const environmentCalls = [];
  const environment = new EnvironmentRegistry({
    providers: () => [{
      pluginId: "test.worktree", pluginName: "Test worktree", serviceId: "environment",
      kinds: [{ kind: "worktree", label: "Worktree", executionLocation: "local", keeps: { launch: true } }], secrets: false
    }],
    call: async (_pluginId, _serviceId, method, params) => {
      environmentCalls.push({ method, params });
      if (method === "canvastty.environment.prepare") {
        return { ref: { worktree: "prepared" }, label: "Prepared worktree", cwd: worktreeRoot };
      }
      if (method === "canvastty.environment.wrap") {
        return { command: params.command, args: params.args, env: {}, cwd: params.cwd };
      }
      if (method === "canvastty.environment.describe") return { label: "Prepared worktree" };
      return {};
    },
    secret: async () => null
  });
  const policyRoots = [];
  const wrappedRoots = [];
  const networkPolicy = {
    mode: "allowed-domains",
    domains: ["api.example.test"]
  };
  const isolation = {
    decide({ profile, cwd }) {
      policyRoots.push(cwd);
      return {
        apply: true,
        profile,
        isolation: { state: "on", layer: "seatbelt", network: networkPolicy }
      };
    },
    networkPolicyFor(cwd) {
      policyRoots.push(cwd);
      return networkPolicy;
    },
    containment() { return true; },
    wrap(launch) {
      wrappedRoots.push(launch.networkProjectRoot);
      return { command: launch.command, args: [...launch.args], env: launch.env, cleanup() {} };
    }
  };
  const ptyCalls = [];
  const manager = new TerminalManager(
    () => undefined, {
      get(provider) {
        return { state: "available", provider, executable: process.execPath, launcher: "native",
          environment: { PATH: process.env.PATH ?? "" }, checked: [] };
      },
      snapshot() { return {}; }
    }, undefined, undefined, true, fakeSpawner(ptyCalls)
  );
  manager.configureEnvironments(environment);
  manager.configureIsolation(isolation);
  t.after(async () => {
    await manager.shutdown();
    await rm(fixture, { recursive: true, force: true });
  });

  const source = manager.create({
    provider: "codex", cwd: projectRoot, profile: "normal", position: { x: 0, y: 0 },
    environment: { pluginId: "test.worktree", kind: "worktree" }
  });
  assert.deepEqual(source.taskScope, { id: source.id, cwd: projectRoot, startedAt: source.startedAt });
  const sourceInput = await manager.deliverInput(source.id, "start\r", 2_000);
  assert.equal(sourceInput.delivered, true, `the source launches after its worktree is prepared: ${sourceInput.reason ?? manager.list().find((item) => item.id === source.id)?.failureDetails ?? "unknown failure"}`);
  assert.equal(ptyCalls[0]?.options.cwd, worktreeRoot);

  const prepareCall = environmentCalls.find((call) => call.method === "canvastty.environment.prepare");
  assert.equal(prepareCall?.params.projectRoot, projectRoot,
    "the environment plugin receives the trusted project root even though it places the terminal elsewhere");
  assert.ok(policyRoots.length >= 2);
  assert.ok(policyRoots.every((root) => root === projectRoot), `network decisions used: ${JSON.stringify(policyRoots)}`);
  assert.deepEqual(wrappedRoots, [projectRoot], "isolation wraps the prepared worktree under the original project's policy");

  // This host-only control value models the already-approved handoff path. The replacement starts in the existing
  // worktree, but it must inherit the trusted task identity before a PTY is planned or its first input is delivered.
  const replacement = manager.create({
    provider: "codex", cwd: worktreeRoot, profile: "normal", position: { x: 30, y: 30 }
  }, { continueTaskFrom: source.id });
  assert.deepEqual(replacement.taskScope, source.taskScope,
    "continuation identity is present in the returned replacement snapshot before input delivery");
  const replacementInput = await manager.deliverInput(replacement.id, "continue\r", 2_000);
  assert.equal(replacementInput.delivered, true);
  assert.equal(ptyCalls[1]?.options.cwd, worktreeRoot);
  assert.deepEqual(wrappedRoots, [projectRoot, projectRoot],
    "the replacement is isolated according to its original task root, not the worktree path");
  assert.ok(policyRoots.every((root) => root === projectRoot), `handoff policy decisions used: ${JSON.stringify(policyRoots)}`);
});
