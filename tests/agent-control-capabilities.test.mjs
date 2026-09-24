import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_PROVIDERS, CANVAS_LAUNCHER_ITEMS } from "../src/shared/contracts.ts";
import {
  CONTROL_CLI_ENV,
  CONTROL_CONNECTION_ENV,
  CONTROL_PROVIDERS,
  controlCapabilities,
  controlEnvironment,
  isControlProvider,
  isLaunchRole,
  launchRole
} from "../src/main/services/agent-control/controlCapabilities.ts";
import { TerminalManager, terminalEnvironment } from "../src/main/services/TerminalManager.ts";

const CONNECTION = { connectionPath: "/data/agent-control/connection.json", cliPath: "/app/scripts/canvastty-control.mjs" };

function availableRegistry() {
  return {
    get(provider) {
      return { state: "available", provider, executable: `/resolved/${provider}`, launcher: "native",
        environment: { PATH: "/resolved:/usr/bin" }, checked: [{ path: `/resolved/${provider}`, result: "selected" }] };
    },
    snapshot() { return {}; }
  };
}

function fakeSpawner(calls) {
  return (command, args, options) => {
    const process = { pid: 30_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
    calls.push({ command, args, options });
    return process;
  };
}

function manager(calls) {
  return new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
}

test("the control provider list is the shared agent provider list, never a plain terminal", () => {
  assert.deepEqual([...CONTROL_PROVIDERS], [...AGENT_PROVIDERS]);
  assert.deepEqual([...AGENT_PROVIDERS], CANVAS_LAUNCHER_ITEMS.filter((item) => item !== "terminal"));
  assert.deepEqual([...AGENT_PROVIDERS], ["codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi", "cursor", "minimax", "devin", "antigravity"]);
  assert.equal(isControlProvider("terminal"), false);
  assert.equal(isControlProvider("codex"), true);
  assert.equal(isControlProvider(undefined), false);
});

test("only Codex workers capture a result and expose parsed menus", () => {
  assert.deepEqual(controlCapabilities("codex"), { result: true, menus: true });
  for (const provider of AGENT_PROVIDERS.filter((p) => p !== "codex")) {
    assert.deepEqual(controlCapabilities(provider), { result: false, menus: false }, provider);
  }
  assert.deepEqual(controlCapabilities("terminal"), { result: false, menus: false });
});

test("the launch role defaults to agent and only an explicit orchestrator maps through", () => {
  assert.equal(launchRole(undefined), "agent");
  assert.equal(launchRole("agent"), "agent");
  assert.equal(launchRole("orchestrator"), "orchestrator");
  assert.equal(launchRole("ORCHESTRATOR"), "agent");
  assert.equal(launchRole(1), "agent");
  assert.equal(isLaunchRole("agent"), true);
  assert.equal(isLaunchRole("orchestrator"), true);
  assert.equal(isLaunchRole("worker"), false);
});

test("the control environment exists only for an orchestrator while the endpoint is live", () => {
  assert.deepEqual(controlEnvironment("orchestrator", CONNECTION), {
    CANVASTTY_CONTROL_CONNECTION: CONNECTION.connectionPath,
    CANVASTTY_CONTROL_CLI: CONNECTION.cliPath
  });
  assert.equal(CONTROL_CONNECTION_ENV, "CANVASTTY_CONTROL_CONNECTION");
  assert.equal(CONTROL_CLI_ENV, "CANVASTTY_CONTROL_CLI");
  assert.deepEqual(controlEnvironment("agent", CONNECTION), {});
  assert.deepEqual(controlEnvironment("orchestrator", null), {});
});

test("terminalEnvironment strips an inherited control grant like the other reserved variables", () => {
  const environment = terminalEnvironment({
    PATH: "/usr/bin",
    CANVASTTY_CONTROL_CONNECTION: "/leaked/connection.json",
    CANVASTTY_CONTROL_CLI: "/leaked/cli.mjs",
    CANVASTTY_RUNTIME_CAPTURE_RESULT: "1"
  });
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal("CANVASTTY_CONTROL_CONNECTION" in environment, false);
  assert.equal("CANVASTTY_CONTROL_CLI" in environment, false);
  assert.equal("CANVASTTY_RUNTIME_CAPTURE_RESULT" in environment, false);
});

test("TerminalManager hands the descriptor to orchestrator sessions only, and records the role", async () => {
  const previous = { connection: process.env.CANVASTTY_CONTROL_CONNECTION, cli: process.env.CANVASTTY_CONTROL_CLI };
  process.env.CANVASTTY_CONTROL_CONNECTION = "/parent/connection.json";
  process.env.CANVASTTY_CONTROL_CLI = "/parent/cli.mjs";
  const calls = [];
  const terminals = manager(calls);
  try {
    terminals.setControlConnection(CONNECTION);
    const base = { provider: "codex", profile: "yolo", cwd: process.cwd(), position: { x: 0, y: 0 } };

    const plain = terminals.create(base);
    assert.equal(plain.role, "agent");
    assert.equal(plain.profile, "yolo");
    assert.equal("CANVASTTY_CONTROL_CONNECTION" in calls.at(-1).options.env, false, "ordinary sessions inherit nothing");
    assert.equal("CANVASTTY_CONTROL_CLI" in calls.at(-1).options.env, false);

    const orchestrator = terminals.create({ ...base, role: "orchestrator" });
    assert.equal(orchestrator.role, "orchestrator");
    assert.equal(orchestrator.profile, "yolo", "the role never changes the selected profile");
    assert.equal(orchestrator.provider, "codex", "the role never changes the provider");
    assert.equal(calls.at(-1).options.env.CANVASTTY_CONTROL_CONNECTION, CONNECTION.connectionPath);
    assert.equal(calls.at(-1).options.env.CANVASTTY_CONTROL_CLI, CONNECTION.cliPath);
    assert.equal(terminals.listMetadata().find((s) => s.id === orchestrator.id).role, "orchestrator");

    terminals.setControlConnection(null);
    terminals.create({ ...base, role: "orchestrator" });
    assert.equal("CANVASTTY_CONTROL_CONNECTION" in calls.at(-1).options.env, false, "no descriptor while the endpoint is off");

    assert.throws(() => terminals.create({ ...base, role: "worker" }), /Unknown session role/);
    assert.throws(() => terminals.create({ ...base, provider: "terminal", profile: "normal", role: "orchestrator" }), /cannot be an orchestrator/);
  } finally {
    await terminals.shutdown();
    if (previous.connection === undefined) delete process.env.CANVASTTY_CONTROL_CONNECTION;
    else process.env.CANVASTTY_CONTROL_CONNECTION = previous.connection;
    if (previous.cli === undefined) delete process.env.CANVASTTY_CONTROL_CLI;
    else process.env.CANVASTTY_CONTROL_CLI = previous.cli;
  }
});
