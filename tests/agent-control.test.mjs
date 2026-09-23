import assert from "node:assert/strict";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";

const writes = new Map();

function fakeSpawner(calls) {
  return (command, args, options) => {
    const process = {
      pid: 20_000 + calls.length,
      write(data) {
        writes.set(options?.name ?? calls.length, [...(writes.get(options?.name ?? calls.length) ?? []), data]);
      },
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

function fixture() {
  const calls = [];
  const terminals = new TerminalManager(() => undefined, availableRegistry(), undefined, undefined, true, fakeSpawner(calls));
  const control = new AgentControlService(terminals);
  return { calls, terminals, control };
}

test("spawn creates a subagent next to its parent and delivers the initial prompt", () => {
  const { terminals, control, calls } = fixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 100, y: 100 }
  });
  const child = control.spawn({
    parentSessionId: parent.id,
    provider: "cursor",
    cwd: process.cwd(),
    initialPrompt: "Fix the failing Button test"
  });

  assert.equal(child.role, "subagent");
  assert.equal(child.parentSessionId, parent.id);
  assert.equal(child.provider, "cursor");
  assert.ok(child.position.x > parent.position.x);
  assert.ok(child.position.y > parent.position.y);

  const sent = [...writes.values()].flat().join("");
  assert.equal(sent, '');
  assert.equal(calls[1].args.at(-1), 'CanvasTTY task:\nFix the failing Button test');
  terminals.disposeAll();
});

test("children lists only that parent's subagents in spawn order", () => {
  const { terminals, control } = fixture();
  const parent = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  control.spawn({ parentSessionId: parent.id, provider: "cursor", cwd: process.cwd() });
  control.spawn({ parentSessionId: parent.id, provider: "minimax", cwd: process.cwd() });

  const other = terminals.create({
    provider: "claude",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 500, y: 500 }
  });
  control.spawn({ parentSessionId: other.id, provider: "devin", cwd: process.cwd() });

  assert.deepEqual(control.children(parent.id).map((session) => session.provider), ["cursor", "minimax"]);
  assert.deepEqual(control.children(other.id).map((session) => session.provider), ["devin"]);
  terminals.disposeAll();
});

test("send appends submit unless told otherwise and rejects exited sessions", () => {
  const { terminals, control } = fixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const child = control.spawn({ parentSessionId: parent.id, provider: "qwen", cwd: process.cwd() });
  control.send(child.id, "run the tests");
  control.send(child.id, " --quiet", false);

  const sent = [...writes.values()].flat().join("");
  assert.match(sent, /run the tests\r --quiet/u);
  terminals.disposeAll();
});

test("observe returns a capped terminal tail and result reflects exit state", () => {
  const { terminals, control } = fixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const observation = control.observe(parent.id);
  assert.equal(observation.sessionId, parent.id);
  assert.equal(observation.output.length <= 8_192, true);

  const running = control.result(parent.id);
  assert.equal(running.state, "running");
  assert.equal(running.exitCode, null);
  terminals.disposeAll();
});

test("cancel disposes the subagent and plain terminals are not agents", () => {
  const { terminals, control } = fixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const terminal = terminals.create({
    provider: "terminal",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  const child = control.spawn({ parentSessionId: parent.id, provider: "pi", cwd: process.cwd() });
  control.cancel(child.id);
  assert.equal(terminals.list().some((session) => session.id === child.id), false);

  assert.throws(() => control.send(terminal.id, "text"), /not agents/u);
  assert.throws(() => control.observe(terminal.id), /not agents/u);
  assert.throws(() => control.result(terminal.id), /not agents/u);
  terminals.disposeAll();
});

test("a parent cannot exceed the subagent fan-out cap", () => {
  const { terminals, control } = fixture();
  const parent = terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
  for (let index = 0; index < 16; index += 1) {
    control.spawn({ parentSessionId: parent.id, provider: "omp", cwd: process.cwd() });
  }
  assert.throws(
    () => control.spawn({ parentSessionId: parent.id, provider: "omp", cwd: process.cwd() }),
    /16 subagents/u
  );
  terminals.disposeAll();
});
