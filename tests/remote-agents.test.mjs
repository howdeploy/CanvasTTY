import assert from "node:assert/strict";
import test from "node:test";
import { remoteAgentLaunch } from "../src/main/services/remoteAgentLaunch.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { validateOrchestrationArguments } from "../src/agent-browser/orchestration-catalog.mjs";

const localWorkspace = process.cwd();

function fakeSpawner(calls) {
  return (command, args, options) => {
    const process = {
      pid: 20_000 + calls.length,
      write() {},
      resize() {},
      kill() {},
      pause() {},
      resume() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }
    };
    calls.push({ command, args, options });
    return process;
  };
}

function availableRegistry() {
  return {
    get(provider) {
      return {
        state: "available",
        provider,
        executable: `/resolved/${provider}`,
        launcher: "native",
        environment: { PATH: "/resolved:/usr/bin" },
        checked: [{ path: `/resolved/${provider}`, result: "selected" }]
      };
    },
    snapshot() { return {}; }
  };
}

function remoteHost({ id = "build-1", remotePath = "/srv/proj" } = {}) {
  return {
    id,
    label: "Build host",
    sshHost: "build.example.com",
    sshUser: "deploy",
    sshPort: 2222,
    workspaces: [{ localPath: localWorkspace, remotePath }]
  };
}

function terminalsFixture(hosts = [remoteHost()]) {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  terminals.configureRemoteHosts((hostId) => hosts.find((host) => host.id === hostId) ?? null);
  return { calls, terminals };
}

function controlFixture({ hosts, placement } = {}) {
  const { calls, terminals } = terminalsFixture(hosts);
  const control = new AgentControlService(terminals, placement);
  const parent = terminals.create({
    provider: "claude",
    cwd: localWorkspace,
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  return { calls, terminals, control, parent };
}

test("remoteAgentLaunch composes one quoted remote command with no user and no port", () => {
  const launch = remoteAgentLaunch({ id: "gpu", label: "GPU", sshHost: "gpu.internal.example" }, "/srv/proj", "codex");
  assert.equal(launch.command, "ssh");
  assert.deepEqual(launch.args, ["-tt", "gpu.internal.example", "cd '/srv/proj' && exec codex"]);
});

test("remoteAgentLaunch adds -p for a port and user@ for a user", () => {
  const launch = remoteAgentLaunch(
    { id: "farm", label: "Farm", sshHost: "192.168.1.40", sshUser: "deploy", sshPort: 2222 },
    "/srv/proj",
    "mcode"
  );
  assert.deepEqual(launch.args, ["-tt", "-p", "2222", "deploy@192.168.1.40", "cd '/srv/proj' && exec mcode"]);
});

test("remoteAgentLaunch quotes a workspace with spaces but never single quotes", () => {
  const spaced = remoteAgentLaunch({ id: "gpu", label: "GPU", sshHost: "gpu" }, "/srv/my proj", "codex");
  assert.deepEqual(spaced.args, ["-tt", "gpu", "cd '/srv/my proj' && exec codex"]);
  assert.throws(
    () => remoteAgentLaunch({ id: "gpu", label: "GPU", sshHost: "gpu" }, "/srv/o'brien", "codex"),
    /cannot be safely quoted/u
  );
  assert.throws(
    () => remoteAgentLaunch({ id: "gpu", label: "GPU", sshHost: "gpu" }, "/srv/proj\nwhoami", "codex"),
    /cannot be safely quoted/u
  );
});

test("remoteAgentLaunch rejects commands that are not inert unquoted shell words", () => {
  const host = { id: "gpu", label: "GPU", sshHost: "gpu" };
  assert.throws(() => remoteAgentLaunch(host, "/srv/proj", "co'dex"), /not safe to run unquoted/u);
  assert.throws(() => remoteAgentLaunch(host, "/srv/proj", "codex; rm -rf /"), /not safe to run unquoted/u);
  assert.throws(() => remoteAgentLaunch(host, "/srv/proj", "codex && whoami"), /not safe to run unquoted/u);
  assert.throws(() => remoteAgentLaunch(host, "/srv/proj", ""), /not safe to run unquoted/u);
});

test("an agent session with a hostId launches its provider CLI over ssh", () => {
  const { calls, terminals } = terminalsFixture();
  const session = terminals.create({
    provider: "codex",
    cwd: localWorkspace,
    profile: "normal",
    position: { x: 0, y: 0 },
    hostId: "build-1"
  });
  assert.equal(session.hostId, "build-1");

  const spawn = calls[calls.length - 1];
  assert.equal(spawn.command, "ssh");
  assert.ok(spawn.args.includes("-tt"));
  assert.deepEqual(
    spawn.args,
    ["-tt", "-p", "2222", "deploy@build.example.com", "cd '/srv/proj' && exec codex"]
  );
  assert.equal(spawn.options.env.TERM, "xterm-256color");
  terminals.disposeAll();
});

test("an agent session on a host without a workspace mapping fails the create", () => {
  const { calls, terminals } = terminalsFixture();
  assert.throws(
    () => terminals.create({
      provider: "codex",
      cwd: "/",
      profile: "normal",
      position: { x: 0, y: 0 },
      hostId: "build-1"
    }),
    /Workspace \/ is not mapped on host build-1/u
  );
  assert.equal(calls.length, 0);
});

test("an agent session without a hostId still launches the local resolved executable", () => {
  const { calls, terminals } = terminalsFixture();
  terminals.create({
    provider: "codex",
    cwd: localWorkspace,
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const spawn = calls[calls.length - 1];
  assert.equal(spawn.command, "/resolved/codex");
  assert.equal(spawn.args.includes("cd '/srv/proj' && exec codex"), false);
  terminals.disposeAll();
});

test("host \"auto\" with a remote placement decision launches over ssh on the chosen host", async () => {
  const placed = [];
  const placement = {
    async place(request) {
      placed.push(request);
      return { kind: "remote", host: remoteHost(), remoteWorkspace: "/srv/proj" };
    }
  };
  const { calls, terminals, control, parent } = controlFixture({ placement });
  const child = await control.spawn({
    parentSessionId: parent.id,
    provider: "codex",
    cwd: localWorkspace,
    host: "auto"
  });

  assert.deepEqual(placed, [{ provider: "codex", localWorkspace }]);
  assert.equal(child.hostId, "build-1");
  assert.equal(child.provider, "codex");
  const spawn = calls[calls.length - 1];
  assert.equal(spawn.command, "ssh");
  assert.ok(spawn.args.some((argument) => argument === "cd '/srv/proj' && exec codex"));
  terminals.disposeAll();
});

test("host \"auto\" with a local placement decision stays local", async () => {
  const placement = {
    async place() {
      return { kind: "local", reason: "no reachable host with codex installed" };
    }
  };
  const { calls, terminals, control, parent } = controlFixture({ placement });
  const child = await control.spawn({
    parentSessionId: parent.id,
    provider: "codex",
    cwd: localWorkspace,
    host: "auto"
  });

  assert.equal(child.hostId, undefined);
  assert.equal(calls[calls.length - 1].command, "/resolved/codex");
  terminals.disposeAll();
});

test("host \"auto\" without a placement coordinator fails open to a local spawn", () => {
  const { calls, terminals, control, parent } = controlFixture();
  const child = control.spawn({
    parentSessionId: parent.id,
    provider: "codex",
    cwd: localWorkspace,
    host: "auto"
  });

  assert.equal(child.hostId, undefined);
  assert.equal(calls[calls.length - 1].command, "/resolved/codex");
  terminals.disposeAll();
});

test("a specific host id passes through to the terminal manager", () => {
  const { calls, terminals, control, parent } = controlFixture({
    hosts: [remoteHost({ id: "alt-1", remotePath: "/srv/alt" })]
  });
  const child = control.spawn({
    parentSessionId: parent.id,
    provider: "codex",
    cwd: localWorkspace,
    host: "alt-1"
  });

  assert.equal(child.hostId, "alt-1");
  const spawn = calls[calls.length - 1];
  assert.equal(spawn.command, "ssh");
  assert.ok(spawn.args.includes("cd '/srv/alt' && exec codex"));
  terminals.disposeAll();
});

test("an invalid host value throws before anything spawns", () => {
  const { calls, terminals, control, parent } = controlFixture();
  for (const host of ["not a host!", "auto ", "", "host;whoami"]) {
    assert.throws(
      () => control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: localWorkspace, host }),
      /Agent host must be "auto" or a host id/u
    );
  }
  assert.equal(calls.length, 1);
  terminals.disposeAll();
});

test("spawn_agent threads the host argument into control.spawn", async () => {
  let captured = null;
  const handler = new ScopedOrchestrationHandler({
    spawn(request) {
      captured = request;
      return { id: "child-1", provider: "codex", status: "running", title: "worker" };
    }
  });
  const result = await handler.execute("parent-1", {
    id: "request-1",
    tool: "spawn_agent",
    arguments: { provider: "codex", cwd: localWorkspace, host: "auto" }
  });

  assert.deepEqual(captured, {
    parentSessionId: "parent-1",
    provider: "codex",
    cwd: localWorkspace,
    host: "auto"
  });
  assert.equal(result.sessionId, "child-1");
});

test("the spawn_agent catalog accepts an optional host argument", () => {
  const withHost = validateOrchestrationArguments("spawn_agent", {
    provider: "codex",
    cwd: localWorkspace,
    host: "auto"
  });
  assert.equal(withHost.ok, true);
  assert.equal(withHost.value.host, "auto");

  const withoutHost = validateOrchestrationArguments("spawn_agent", {
    provider: "codex",
    cwd: localWorkspace
  });
  assert.equal(withoutHost.ok, true);
  assert.equal("host" in withoutHost.value, false);
});
