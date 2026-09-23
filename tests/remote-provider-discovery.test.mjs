import assert from "node:assert/strict";
import test from "node:test";
import { buildSshArguments } from "../src/main/services/RemoteHostsService.ts";
import { RemoteProviderDiscovery } from "../src/main/services/RemoteProviderDiscovery.ts";
import { PROVIDER_CLI_DEFINITIONS, PROVIDER_CLI_IDS } from "../src/main/services/providerCliRegistry.ts";

const validHost = {
  id: "gpu-box",
  label: "GPU box",
  sshHost: "gpu.internal.example"
};

// Recomputed from the registry rather than imported, so these tests pin the
// discovery to the single source of truth instead of sharing its helper.
function expectedCommandNames() {
  const names = [];
  for (const id of PROVIDER_CLI_IDS) {
    for (const command of PROVIDER_CLI_DEFINITIONS[id].commands) {
      if (!names.includes(command)) names.push(command);
    }
  }
  return names;
}

function scriptFromCommand(command) {
  assert.equal(command.length, 1);
  assert.match(command[0], /^sh -lc '.*'$/u);
  const script = command[0].slice("sh -lc '".length, -1);
  assert.equal(script.includes("'"), false, "the quoted script must not contain single quotes");
  return script;
}

function loopNames(script) {
  const start = script.indexOf("for c in ") + "for c in ".length;
  return script.slice(start, script.indexOf("; do")).split(" ");
}

function fakeRunner(output) {
  const calls = [];
  const runner = (host, command, timeoutMs) => {
    calls.push({ host, command, timeoutMs });
    return Promise.resolve(output);
  };
  return { calls, runner };
}

test("one ssh round-trip resolves every installed provider, first declared command wins", async () => {
  const names = expectedCommandNames();
  const { calls, runner } = fakeRunner({
    code: 0,
    stdout: names.map((name) => `${name}=/usr/local/bin/${name}`).join("\n") + "\n",
    stderr: ""
  });
  const discovery = new RemoteProviderDiscovery(runner);
  const result = await discovery.discover(validHost);

  assert.equal(calls.length, 1);
  assert.equal(result.hostId, "gpu-box");
  assert.equal(result.reachable, true);
  assert.equal(result.providers.length, PROVIDER_CLI_IDS.length);

  const byProvider = new Map(result.providers.map((status) => [status.provider, status]));
  for (const id of PROVIDER_CLI_IDS) {
    const status = byProvider.get(id);
    assert.equal(status.installed, true, `${id} should be installed`);
    assert.equal(status.path, `/usr/local/bin/${status.command}`);
    assert.ok(PROVIDER_CLI_DEFINITIONS[id].commands.includes(status.command));
  }
  // Cursor uses the unique spelling even when the generic alias also resolves.
  assert.deepEqual(byProvider.get("cursor"), {
    provider: "cursor",
    installed: true,
    command: "cursor-agent",
    path: "/usr/local/bin/cursor-agent"
  });
  assert.deepEqual(byProvider.get("minimax"), {
    provider: "minimax",
    installed: true,
    command: "mcode",
    path: "/usr/local/bin/mcode"
  });

  const script = scriptFromCommand(calls[0].command);
  assert.ok(script.includes('command -v "$c"'));
  assert.ok(script.endsWith("exit 0"));
  const looped = loopNames(script);
  assert.deepEqual(looped, names);
  assert.equal(new Set(looped).size, looped.length, "each command name appears exactly once");
  assert.equal(calls[0].timeoutMs, 12000);
  assert.equal(calls[0].host, validHost);
});

test("the composed ssh argv keeps BatchMode, a bounded connect timeout, and no tty", async () => {
  const { calls, runner } = fakeRunner({ code: 0, stdout: "", stderr: "" });
  await new RemoteProviderDiscovery(runner).discover(validHost);

  const argv = buildSshArguments(validHost, 12000, calls[0].command);
  assert.ok(argv.includes("-o"));
  assert.ok(argv.includes("BatchMode=yes"));
  assert.ok(argv.includes("ConnectTimeout=12"));
  assert.ok(argv.includes("StrictHostKeyChecking=accept-new"));
  assert.equal(argv.includes("-tt") || argv.includes("-t"), false);
  assert.ok(argv.includes("gpu.internal.example"));
  assert.equal(argv[argv.length - 1], calls[0].command[0]);

  const portHost = { ...validHost, id: "build-farm", sshUser: "deploy", sshPort: 2222 };
  const { calls: portCalls, runner: portRunner } = fakeRunner({ code: 0, stdout: "", stderr: "" });
  await new RemoteProviderDiscovery(portRunner).discover(portHost, 5000);
  const portArgv = buildSshArguments(portHost, 5000, portCalls[0].command);
  assert.ok(portArgv.includes("-p"));
  assert.ok(portArgv.includes("2222"));
  assert.ok(portArgv.includes("deploy@gpu.internal.example"));
  assert.ok(portArgv.includes("ConnectTimeout=5"));
  assert.equal(portCalls[0].timeoutMs, 5000);
  assert.equal(portArgv.includes("-tt"), false);
});

test("a partially installed host reports only the providers whose commands resolved", async () => {
  const stdout = expectedCommandNames()
    .filter((name) => name !== "mcode" && name !== "cursor-agent")
    .map((name) => `${name}=/opt/tools/${name}`)
    .join("\n");
  const { runner } = fakeRunner({ code: 0, stdout, stderr: "" });
  const result = await new RemoteProviderDiscovery(runner).discover(validHost);

  assert.equal(result.reachable, true);
  const byProvider = new Map(result.providers.map((status) => [status.provider, status]));
  assert.deepEqual(byProvider.get("minimax"), { provider: "minimax", installed: false });
  assert.equal("command" in byProvider.get("minimax"), false);
  assert.equal("path" in byProvider.get("minimax"), false);
  // A generic agent spelling cannot establish Cursor identity (Grok collision).
  assert.deepEqual(byProvider.get("cursor"), {
    provider: "cursor",
    installed: false
  });
  assert.equal(byProvider.get("codex").installed, true);
});

test("a reachable host with no provider CLIs reports every provider uninstalled", async () => {
  const { runner } = fakeRunner({ code: 0, stdout: "", stderr: "" });
  const result = await new RemoteProviderDiscovery(runner).discover(validHost);
  assert.equal(result.reachable, true);
  assert.equal(result.providers.length, PROVIDER_CLI_IDS.length);
  assert.ok(result.providers.every((status) => status.installed === false));
  assert.ok(result.providers.every((status) => !("command" in status) && !("path" in status)));
});

test("stdout noise from login profiles never counts as a resolved command", async () => {
  const stdout = [
    "Welcome to the build farm",
    "codex=",
    "=/usr/bin/stray",
    "claude=/usr/bin/claude\n"
  ].join("\n");
  const { runner } = fakeRunner({ code: 0, stdout, stderr: "" });
  const result = await new RemoteProviderDiscovery(runner).discover(validHost);
  const byProvider = new Map(result.providers.map((status) => [status.provider, status]));
  assert.equal(byProvider.get("claude").installed, true);
  assert.equal(byProvider.get("codex").installed, false);
  assert.equal(result.providers.filter((status) => status.installed).length, 1);
});

test("a failing ssh exit reports an unreachable host with no provider claims", async () => {
  const { runner } = fakeRunner({
    code: 255,
    stdout: "",
    stderr: "ssh: connect to host gpu.internal.example port 22: Connection refused\r\n"
  });
  const result = await new RemoteProviderDiscovery(runner).discover(validHost);
  assert.equal(result.hostId, "gpu-box");
  assert.equal(result.reachable, false);
  assert.deepEqual(result.providers, []);
  assert.equal(result.detail, "ssh: connect to host gpu.internal.example port 22: Connection refused");
});

test("a killed ssh process (timeout) reports unreachable without throwing", async () => {
  const { runner } = fakeRunner({ code: null, stdout: "", stderr: "" });
  const result = await new RemoteProviderDiscovery(runner).discover(validHost);
  assert.equal(result.reachable, false);
  assert.deepEqual(result.providers, []);
  assert.equal(result.detail, "ssh exited with code unknown");
});

test("a throwing runner reports an unreachable host instead of rejecting", async () => {
  const discovery = new RemoteProviderDiscovery(() => Promise.reject(new Error("probe timed out")));
  const result = await discovery.discover(validHost);
  assert.equal(result.hostId, "gpu-box");
  assert.equal(result.reachable, false);
  assert.deepEqual(result.providers, []);
  assert.equal(result.detail, "probe timed out");
});

test("unreachable detail is excerpted to 300 characters", async () => {
  const { runner } = fakeRunner({ code: 255, stdout: "", stderr: "x".repeat(1_000) });
  const result = await new RemoteProviderDiscovery(runner).discover(validHost);
  assert.equal(result.reachable, false);
  assert.equal(result.detail.length, 300);
});

test("an invalid host never reaches the runner and explains why", async () => {
  let calls = 0;
  const discovery = new RemoteProviderDiscovery(() => {
    calls += 1;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  });
  const result = await discovery.discover({ ...validHost, sshHost: "gpu.internal.example rm -rf" });
  assert.equal(result.hostId, "gpu-box");
  assert.equal(result.reachable, false);
  assert.deepEqual(result.providers, []);
  assert.match(result.detail, /sshHost/);
  assert.equal(calls, 0);
});
