import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import test from "node:test";
import { EnvironmentRegistry, resolveCommand } from "../src/main/services/EnvironmentRegistry.ts";
import { validatePluginManifest } from "../src/main/services/PluginManager.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";

const example = new URL("../examples/plugins/env-worktree/", import.meta.url);
const exampleManifest = JSON.parse(await readFile(new URL("canvastty.plugin.json", example), "utf8"));
const PLUGIN = "com.example.env";
const SECRET = "environment-secret-4d9e1b77";
const cwd = process.cwd();
const at = { x: 0, y: 0 };
const choice = { pluginId: PLUGIN, kind: "box" };

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

function clis() {
  return {
    get(provider) {
      return { state: "available", provider, executable: `/resolved/${provider}`, launcher: "native",
        environment: { PATH: process.env.PATH ?? "" }, checked: [] };
    },
    snapshot() { return {}; }
  };
}

function spawner(calls) {
  return (command, args, options) => {
    const exits = [];
    const data = [];
    calls.push({
      command, args, options,
      exit: (code) => exits.forEach((listener) => listener({ exitCode: code })),
      print: (text) => data.forEach((listener) => listener(text))
    });
    return {
      pid: 50_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData(listener) { data.push(listener); return { dispose() {} }; },
      onExit(listener) { exits.push(listener); return { dispose() {} }; }
    };
  };
}

const provider = (extra = {}) => ({
  pluginId: PLUGIN,
  pluginName: "Env",
  serviceId: "env",
  kinds: [{ kind: "box", label: "Box", executionLocation: "local", fields: [{ key: "name", label: "Name", kind: "text", default: "one" }] }],
  secrets: false,
  ...extra
});

/** A registry over scripted answers: `answers[step]` is a value or (params) => value/promise. */
function registryFixture({ providers = () => [provider()], answers = {}, secrets = {}, timeouts, experimentalEnabled } = {}) {
  const requests = [];
  const registry = new EnvironmentRegistry({
    experimentalEnabled,
    providers,
    call: async (pluginId, serviceId, method, params, budget) => {
      const step = method.replace("canvastty.environment.", "");
      requests.push({ pluginId, serviceId, step, params, budget });
      const answer = answers[step];
      return typeof answer === "function" ? answer(params) : answer;
    },
    secret: async (pluginId, key) => secrets[`${pluginId}/${key}`] ?? null,
    ...(timeouts ? { timeouts } : {})
  });
  return { registry, requests };
}

const defaultAnswers = (extra = {}) => ({
  prepare: { ref: { box: "b-1" }, label: "box b-1" },
  wrap: (params) => ({ command: process.execPath, args: ["-c", "exit 0", "wrapped", params.command, ...params.args], cwd: params.cwd }),
  resume: { ok: true },
  release: {},
  describe: { label: "box b-1 (running)", detail: "demo box" },
  ...extra
});

// Managers keep writing until shutdown; remove their shared directory only after every
// owner has stopped. Node after hooks run in registration order, not resource order.
function persistenceFixtureLifetime(t, directory) {
  const shutdowns = [];
  t.after(async () => {
    const errors = [];
    for (const shutdown of shutdowns.reverse()) {
      try { await shutdown(); } catch (error) { errors.push(error); }
    }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Environment fixture cleanup failed");
  });
  return { after: (shutdown) => shutdowns.push(shutdown) };
}

async function managerFixture(t, registry, { mode = "continue", directory } = {}) {
  const storeDirectory = directory ?? await mkdtemp(join(tmpdir(), "canvastty-env-store-"));
  const calls = [];
  const manager = new TerminalManager(() => undefined, clis(), undefined, undefined, true, spawner(calls));
  t.after(() => manager.shutdown());
  if (!directory) t.after(() => rm(storeDirectory, { recursive: true, force: true }));
  manager.configureEnvironments(registry);
  manager.configureSessionPersistence(new TerminalSessionStore(storeDirectory), mode);
  await manager.restorePersistedSessions();
  return { manager, calls, storeDirectory };
}

const card = (manager, id) => manager.list().find((session) => session.id === id);
const saved = async (directory) => JSON.parse(await readFile(join(directory, "terminal-sessions.json"), "utf8")).sessions;

test("manifests declare environments (kinds unique across the plugin's services) and need environment:provide", async () => {
  const manifest = validatePluginManifest(exampleManifest);
  assert.deepEqual(manifest.services[0].environments.map((kind) => kind.kind), ["worktree"]);
  assert.equal(manifest.services[0].environments[0].fields[0].key, "branch");
  const withEnvironments = (environments, permissions = ["environment:provide"]) => validatePluginManifest({
    ...exampleManifest, permissions, services: [{ ...exampleManifest.services[0], environments }]
  });
  assert.throws(() => withEnvironments(exampleManifest.services[0].environments, []), /environment:provide/u);
  assert.throws(() => withEnvironments([]), /between 1 and 8/u);
  assert.throws(() => withEnvironments([{ kind: "Bad Kind", label: "X" }]), /kind is invalid/u);
  assert.throws(() => withEnvironments([{ kind: "a", label: "A" }, { kind: "a", label: "B" }]), /duplicated/u);
  assert.throws(() => withEnvironments([{ kind: "a", label: "A", appliesTo: ["browser"] }]), /must list providers/u);
  assert.throws(() => withEnvironments([{ kind: "a", label: "A", fields: [{ key: "x", label: "X", kind: "color" }] }]), /boolean, select or text/u);
  assert.deepEqual(withEnvironments([{ kind: "a", label: "A", appliesTo: ["terminal", "claude"] }]).services[0].environments[0].appliesTo,
    ["terminal", "claude"]);
  assert.throws(() => validatePluginManifest({
    ...exampleManifest,
    services: [exampleManifest.services[0], { ...exampleManifest.services[0], id: "second" }]
  }), /kinds must be unique across its services/u);
  // Kinds may be split over services (one per module); each kind is answered by the service that lists it.
  const split = validatePluginManifest({
    ...exampleManifest,
    services: [exampleManifest.services[0], { ...exampleManifest.services[0], id: "second", environments: [{ kind: "remote", label: "Remote", executionLocation: "remote" }] }]
  });
  assert.deepEqual(split.services.map((service) => service.environments[0].kind), ["worktree", "remote"]);
  const { registry, requests } = registryFixture({
    experimentalEnabled: () => true,
    providers: () => [provider(), provider({ serviceId: "remote-svc", kinds: [{ kind: "remote", label: "Remote", executionLocation: "remote" }] })],
    answers: { prepare: { ref: {}, label: "x" } }
  });
  await registry.prepare({ sessionId: "s1", provider: "terminal", cwd, choice: { pluginId: PLUGIN, kind: "remote" } });
  await registry.prepare({ sessionId: "s2", provider: "terminal", cwd, choice });
  assert.deepEqual(requests.map((request) => request.serviceId), ["remote-svc", "env"]);
});

test("launcher choices are checked against the kinds and fields, with defaults", () => {
  const { registry } = registryFixture({ providers: () => [provider({ kinds: [
    { kind: "box", label: "Box", executionLocation: "local", fields: [{ key: "name", label: "Name", kind: "text", default: "one", maxLength: 8 }] },
    { kind: "agents-only", label: "Agents only", executionLocation: "local", appliesTo: ["claude"] }
  ] })] });
  assert.equal(registry.normalizeChoice("terminal", undefined), undefined);
  assert.deepEqual(registry.normalizeChoice("terminal", choice), { ...choice, options: { name: "one" } });
  assert.deepEqual(registry.normalizeChoice("claude", { pluginId: PLUGIN, kind: "agents-only" }), { pluginId: PLUGIN, kind: "agents-only" });
  assert.throws(() => registry.normalizeChoice("terminal", { pluginId: PLUGIN, kind: "agents-only" }), /does not apply to terminal/u);
  assert.throws(() => registry.normalizeChoice("terminal", { ...choice, options: { other: 1 } }), /no option other/u);
  assert.throws(() => registry.normalizeChoice("terminal", { ...choice, options: { name: "far too long" } }), /Name is invalid/u);
  assert.throws(() => registry.normalizeChoice("terminal", { pluginId: "gone.plugin", kind: "box" }), /not available/u);
  assert.throws(() => registry.normalizeChoice("terminal", "box"), /invalid/u);
});

test("prepare answers are validated and a timeout refuses", async () => {
  const prepare = (answer) => registryFixture({ answers: { prepare: answer }, timeouts: { prepare: 50 } }).registry
    .prepare({ sessionId: "s1", provider: "terminal", cwd, choice });
  assert.deepEqual(await prepare({ ref: { a: 1 }, label: "box", cwd }),
    { ok: true, environment: { pluginId: PLUGIN, kind: "box", ref: { a: 1 }, label: "box" }, cwd });
  assert.match((await prepare({ ref: "x".repeat(5_000), label: "box" })).reason, /at most 4 KB/u);
  assert.match((await prepare({ ref: {}, label: " " })).reason, /label is required/u);
  assert.match((await prepare({ ref: {}, label: "box", cwd: "relative/dir" })).reason, /cwd must be an existing absolute folder/u);
  assert.match((await prepare({ ref: {}, label: "box", extra: true })).reason, /unknown key extra/u);
  assert.match((await prepare({ refuse: { reason: "no docker" } })).reason, /Env: no docker/u);
  assert.match((await prepare(() => new Promise(() => undefined))).reason, /did not answer prepare within 0\.1 s; nothing was started locally/u);
  assert.match((await prepare(() => { throw new Error("boom"); })).reason, /could not prepare the environment: boom/u);
});

test("an environment prepared after its timeout is released, not left running", async () => {
  let finish;
  const { registry, requests } = registryFixture({
    answers: { prepare: () => new Promise((resolve) => { finish = resolve; }), release: {} },
    timeouts: { prepare: 20 }
  });
  const result = await registry.prepare({ sessionId: "s1", provider: "terminal", cwd, choice });
  assert.equal(result.ok, false);
  assert.ok(requests[0].budget > 20, "the plugin call itself may still answer after the launch gave up");
  finish({ ref: { box: "late" }, label: "late box" });
  await new Promise((resolve) => setImmediate(resolve));
  const release = requests.find((request) => request.step === "release");
  assert.deepEqual(release?.params, { sessionId: "s1", kind: "box", ref: { box: "late" }, keepData: false, reason: "closed" });
  // A late refusal holds nothing to release.
  let refuse;
  const refused = registryFixture({ answers: { prepare: () => new Promise((resolve) => { refuse = resolve; }) }, timeouts: { prepare: 20 } });
  await refused.registry.prepare({ sessionId: "s2", provider: "terminal", cwd, choice });
  refuse({ refuse: "no" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refused.requests.some((request) => request.step === "release"), false);
});

test("an environment resumed after its timeout is released again, its data kept, unless a newer resume holds it", async () => {
  const environment = { pluginId: PLUGIN, kind: "box", ref: { box: "b-1" }, label: "box" };
  const finishes = [];
  const { registry, requests } = registryFixture({
    answers: { resume: () => new Promise((resolve) => { finishes.push(resolve); }), release: {} },
    timeouts: { resume: 20 }
  });
  const result = await registry.resume(environment, "s1");
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not answer resume within/u);
  assert.ok(requests[0].budget > 20, "the plugin call itself may still answer after the launch gave up");
  finishes[0]({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  const releases = () => requests.filter((request) => request.step === "release");
  assert.deepEqual(releases().map((request) => request.params), [{ sessionId: "s1", kind: "box", ref: { box: "b-1" }, keepData: true, reason: "closed" }],
    "stopped again, never deleted: the card still holds this environment");
  // A late "stopped" holds nothing.
  void registry.resume(environment, "s2").then(() => finishes[1]({ stopped: { reason: "gone" } }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases().length, 1);
  // Timed out, then resumed again (the person restarted the card) and that one answered: the late first answer is not
  // allowed to stop what the second launch uses.
  await registry.resume(environment, "s3");
  const again = registry.resume(environment, "s3");
  finishes[3]({ ok: true });
  assert.equal((await again).ok, true);
  finishes[2]({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases().length, 1);
});

test("wrap output is validated: program, no shell string, env rules, secrets, cwd", async () => {
  const environment = { pluginId: PLUGIN, kind: "box", ref: {}, label: "box" };
  const request = { sessionId: "s1", provider: "terminal", secretEnvNames: [], takenEnv: new Set(["CTTY_CONTRIBUTED"]),
    path: dirname(process.execPath), launch: { command: process.execPath, args: ["-l"], env: {}, cwd } };
  const wrap = (answer, extra = {}) => registryFixture({
    answers: { wrap: answer }, secrets: { [`${PLUGIN}/token`]: SECRET }, ...extra
  }).registry.wrap(environment, request);

  const bare = await wrap({ command: basename(process.execPath), args: ["-e", "true"] });
  assert.equal(bare.ok, true, JSON.stringify(bare));
  assert.equal(bare.command, resolveCommand(basename(process.execPath), dirname(process.execPath)));
  assert.ok(isAbsolute(bare.command));
  assert.equal(bare.cwd, cwd);
  for (const command of ["sh -c 'rm -rf ~'", "bin/sh", "./sh", "/definitely/missing/program", "no-such-program-canvastty"]) {
    assert.match((await wrap({ command, args: [] })).reason, /absolute path to a program or a bare program name on PATH; CanvasTTY runs no shell string/u, command);
  }
  assert.match((await wrap({ command: process.execPath, args: ["a\u0000b"] })).reason, /without NUL/u);
  assert.match((await wrap({ command: process.execPath, args: "-c true" })).reason, /args must be an array/u);
  assert.match((await wrap({ command: process.execPath, cwd: "/definitely/missing" })).reason, /cwd must be an existing absolute folder/u);
  assert.match((await wrap({ command: process.execPath, env: { PATH: "/tmp" } })).reason, /env PATH is reserved/u);
  assert.match((await wrap({ command: process.execPath, env: { CANVASTTY_AGENT_TOKEN: "x" } })).reason, /reserved/u);
  assert.match((await wrap({ command: process.execPath, env: { CTTY_CONTRIBUTED: "x" } })).reason, /already sets for this launch/u);
  assert.match((await wrap({ command: process.execPath, shell: true })).reason, /unknown key shell/u);
  assert.match((await wrap({ command: process.execPath, secretEnv: { BOX_TOKEN: "token" } })).reason, /without the secrets permission/u);
  const secret = await wrap({ command: process.execPath, env: { BOX_NAME: "b" }, secretEnv: { BOX_TOKEN: "token" } },
    { providers: () => [provider({ secrets: true })] });
  assert.deepEqual(secret.ok && [secret.env, secret.secrets], [{ BOX_NAME: "b", BOX_TOKEN: SECRET }, [SECRET]]);
  const missing = await wrap({ command: process.execPath, secretEnv: { BOX_TOKEN: "unset" } }, { providers: () => [provider({ secrets: true })] });
  assert.match(missing.reason, /secret unset is not set/u);
  assert.match((await wrap({ refuse: { reason: "box is paused" } })).reason, /Env: box is paused/u);
});

test("lifecycle: prepare, wrap, describe, saved ref; the environment never sees reserved variables", async (t) => {
  const { registry, requests } = registryFixture({ answers: defaultAnswers() });
  const { manager, calls, storeDirectory } = await managerFixture(t, registry);
  const created = manager.create({ provider: "terminal", profile: "normal", cwd, position: at, environment: { ...choice, options: { name: "two" } } });
  assert.equal(created.exitCode, null);
  assert.equal(calls.length, 0, "the card waits for the environment");
  await waitFor(() => calls.length === 1);
  assert.deepEqual(requests.slice(0, 2).map((request) => request.step), ["prepare", "wrap"]);
  assert.deepEqual(requests[0].params, { sessionId: created.id, kind: "box", provider: "terminal", cwd, projectRoot:cwd, options: { name: "two" } });
  const wrapParams = requests[1].params;
  assert.deepEqual(wrapParams.ref, { box: "b-1" });
  assert.equal(Object.keys(wrapParams.env).some((key) => /^(CANVASTTY_|PATH$|TERM$)/u.test(key)), false);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(0, 3), ["-c", "exit 0", "wrapped"]);
  assert.equal(calls[0].options.cwd, cwd);
  await waitFor(() => card(manager, created.id).environment?.label === "box b-1 (running)");
  assert.equal(card(manager, created.id).environment.detail, "demo box");
  await waitFor(async () => (await saved(storeDirectory).catch(() => []))[0]?.environment?.label === "box b-1 (running)");
  assert.deepEqual((await saved(storeDirectory))[0].environment,
    { pluginId: PLUGIN, kind: "box", ref: { box: "b-1" }, label: "box b-1 (running)" });

  // Restarting the exited card wraps again without preparing a second environment.
  calls[0].exit(0);
  manager.restart(created.id);
  await waitFor(() => calls.length === 2);
  assert.equal(requests.filter((request) => request.step === "prepare").length, 1);
  assert.equal(requests.filter((request) => request.step === "resume").length, 0, "prepared in this run, so no resume");
});

test("refusals and timeouts leave the card failed with the reason and nothing spawned", async (t) => {
  const { registry } = registryFixture({
    answers: defaultAnswers({ prepare: () => new Promise(() => undefined) }), timeouts: { prepare: 60 }
  });
  const { manager, calls } = await managerFixture(t, registry);
  const created = manager.create({ provider: "terminal", profile: "normal", cwd, position: at, environment: choice });
  await waitFor(() => card(manager, created.id).status === "failed");
  assert.match(card(manager, created.id).failureDetails, /^Launch refused: Env did not answer prepare within 0\.1 s; nothing was started locally\./u);
  assert.equal(calls.length, 0);

  const wrapRefused = registryFixture({ answers: defaultAnswers({ wrap: { command: "sh -c 'echo hi'" } }) });
  const second = await managerFixture(t, wrapRefused.registry);
  const refused = second.manager.create({ provider: "terminal", profile: "normal", cwd, position: at, environment: choice });
  await waitFor(() => card(second.manager, refused.id).status === "failed");
  assert.match(card(second.manager, refused.id).failureDetails, /CanvasTTY runs no shell string/u);
  assert.equal(second.calls.length, 0);
  assert.throws(() => second.manager.create({ provider: "terminal", profile: "normal", cwd, position: at,
    environment: { pluginId: "gone.plugin", kind: "box" } }), /not available/u);
});

test("restore resumes environments first, then parents before children; stopped and missing never run locally", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-env-restore-"));
  const lifetime = persistenceFixtureLifetime(t, directory);
  const environment = (box) => ({ pluginId: PLUGIN, kind: "box", ref: { box }, label: `box ${box}` });
  const base = { provider: "terminal", profile: "normal", role: "agent", title: "T", titleCustomized: false, cwd,
    position: at, size: { width: 700, height: 430 }, lastState: "running", restore: true };
  await writeFile(join(directory, "terminal-sessions.json"), JSON.stringify({ version: 2, sessions: [
    { ...base, id: "child", provider: "claude", role: "subagent", parentSessionId: "parent", environment: environment("c") },
    { ...base, id: "parent", provider: "claude", role: "orchestrator", environment: environment("p") },
    { ...base, id: "stopped", environment: environment("s") },
    { ...base, id: "missing", environment: { ...environment("m"), pluginId: "gone.plugin" } },
    { ...base, id: "local" }
  ] }));
  const order = [];
  const { registry, requests } = registryFixture({ answers: defaultAnswers({
    resume: (params) => {
      order.push(`resume:${params.sessionId}`);
      return params.ref.box === "s" ? { stopped: { reason: "container was removed" } } : { ok: true };
    },
    wrap: (params) => {
      order.push(`wrap:${params.sessionId}`);
      return { command: process.execPath, args: [params.sessionId], cwd: params.cwd };
    }
  }) });
  const { manager, calls } = await managerFixture(lifetime, registry, { directory });
  await waitFor(() => calls.filter((call) => call.command === process.execPath).length === 2);
  // Every resume is answered before any wrapped launch starts, and the parent launches before its child.
  const firstWrap = order.findIndex((entry) => entry.startsWith("wrap:"));
  assert.deepEqual(order.slice(0, firstWrap).sort(), ["resume:child", "resume:parent", "resume:stopped"]);
  assert.deepEqual(order.slice(firstWrap), ["wrap:parent", "wrap:child"]);
  assert.equal(requests.some((request) => request.params.sessionId === "missing"), false);
  assert.equal(calls.filter((call) => call.command !== process.execPath).length, 1, "only the local card runs locally");

  const stopped = card(manager, "stopped");
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.restoreNote, "environment-unavailable");
  assert.match(stopped.failureDetails, /Environment stopped: Env: container was removed/u);
  const missing = card(manager, "missing");
  assert.equal(missing.restoreNote, "environment-unavailable");
  assert.match(missing.failureDetails, /Needs plugin gone\.plugin \(box m\).*not started locally/u);
  assert.throws(() => manager.restart("missing"), /was not started locally/u);
  // Held cards keep their record (and running state) until closed.
  await manager.shutdown();
  const records = await saved(directory);
  assert.deepEqual(records.filter((record) => ["stopped", "missing"].includes(record.id)).map((record) => record.lastState), ["running", "running"]);

  // Restarting a stopped card asks the plugin to resume again, never runs it locally.
  const again = await managerFixture(lifetime, registryFixture({ answers: defaultAnswers({ resume: { stopped: { reason: "still gone" } } }) }).registry, { directory });
  assert.equal(again.calls.filter((call) => call.command !== process.execPath).length, 1);
});

test("a card that does not come back never resumes its environment; it is released, its data kept", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-env-orphan-"));
  const lifetime = persistenceFixtureLifetime(t, directory);
  const environment = (box) => ({ pluginId: PLUGIN, kind: "box", ref: { box }, label: `box ${box}` });
  const base = { provider: "claude", profile: "normal", role: "agent", title: "T", titleCustomized: false, cwd,
    position: at, size: { width: 700, height: 430 }, lastState: "running", restore: true };
  await writeFile(join(directory, "terminal-sessions.json"), JSON.stringify({ version: 2, sessions: [
    { ...base, id: "orphan", role: "subagent", parentSessionId: "gone-parent", environment: environment("o") },
    { ...base, id: "skipped", restore: false, environment: environment("k") },
    { ...base, id: "kept", environment: environment("p") }
  ] }));
  const { registry, requests } = registryFixture({ answers: defaultAnswers() });
  const { manager } = await managerFixture(lifetime, registry, { directory });
  const steps = (id) => requests.filter((request) => request.params.sessionId === id).map((request) => request.step);
  assert.deepEqual(steps("orphan"), ["release"]);
  assert.deepEqual(steps("skipped"), ["release"]);
  assert.equal(requests.find((request) => request.params.sessionId === "orphan").params.keepData, true);
  assert.deepEqual(steps("kept").slice(0, 1), ["resume"]);
  assert.deepEqual(manager.list().map((session) => session.id), ["kept"]);
  await manager.shutdown();
});

test("an exited card resumes its environment only when restarted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-env-exited-"));
  const lifetime = persistenceFixtureLifetime(t, directory);
  await writeFile(join(directory, "terminal-sessions.json"), JSON.stringify({ version: 2, sessions: [{
    id: "done", provider: "terminal", profile: "normal", role: "agent", title: "T", titleCustomized: false, cwd,
    position: at, size: { width: 700, height: 430 }, lastState: "exited", exitCode: 0, restore: true,
    environment: { pluginId: PLUGIN, kind: "box", ref: { box: "d" }, label: "box d" }
  }] }));
  let resume = { stopped: { reason: "box is asleep" } };
  const { registry, requests } = registryFixture({ answers: defaultAnswers({ resume: () => resume }) });
  const { manager, calls } = await managerFixture(lifetime, registry, { directory });
  assert.equal(card(manager, "done").status, "done");
  assert.equal(requests.length, 0);
  manager.restart("done");
  await waitFor(() => card(manager, "done").status === "failed");
  assert.match(card(manager, "done").failureDetails, /Launch refused: environment stopped: Env: box is asleep/u);
  assert.equal(calls.length, 0);
  resume = { ok: true };
  manager.restart("done");
  await waitFor(() => calls.length === 1);
  assert.deepEqual(requests.map((request) => request.step).slice(0, 3), ["resume", "resume", "wrap"]);
});

test("closing a card releases its environment with the person's answer; quitting keeps it", async (t) => {
  const { registry, requests } = registryFixture({ answers: defaultAnswers() });
  const { manager, calls } = await managerFixture(t, registry);
  const kept = manager.create({ provider: "terminal", profile: "normal", cwd, position: at, environment: choice });
  const removed = manager.create({ provider: "terminal", profile: "normal", cwd, position: at, environment: choice });
  const quit = manager.create({ provider: "terminal", profile: "normal", cwd, position: at, environment: choice });
  await waitFor(() => calls.length === 3);
  manager.dispose(kept.id);
  manager.dispose(removed.id, { keepEnvironmentData: false });
  await waitFor(() => requests.filter((request) => request.step === "release").length === 2);
  const releases = () => requests.filter((request) => request.step === "release").map((request) => [request.params.sessionId, request.params.keepData, request.params.reason]);
  assert.deepEqual(releases(), [[kept.id, true, "closed"], [removed.id, false, "closed"]]);
  await manager.shutdown();
  assert.equal(releases().some(([id]) => id === quit.id), false, "quitting with saving on keeps the environment for restore");

  const off = registryFixture({ answers: defaultAnswers() });
  const offManager = await managerFixture(t, off.registry, { mode: "off" });
  offManager.manager.create({ provider: "terminal", profile: "normal", cwd, position: at, environment: choice });
  await waitFor(() => offManager.calls.length === 1);
  await offManager.manager.shutdown();
  assert.deepEqual(off.requests.filter((request) => request.step === "release").map((request) => [request.params.keepData, request.params.reason]),
    [[true, "quit"]]);

  // Closed while the environment was still being prepared: released without keeping anything.
  let finish;
  const slow = registryFixture({ answers: defaultAnswers({ prepare: () => new Promise((resolve) => { finish = resolve; }) }) });
  const slowManager = await managerFixture(t, slow.registry);
  const pending = slowManager.manager.create({ provider: "terminal", profile: "normal", cwd, position: at, environment: choice });
  await waitFor(() => typeof finish === "function");
  slowManager.manager.dispose(pending.id);
  finish({ ref: { box: "late" }, label: "late" });
  await waitFor(() => slow.requests.some((request) => request.step === "release"));
  assert.deepEqual(slow.requests.find((request) => request.step === "release").params,
    { sessionId: pending.id, kind: "box", ref: { box: "late" }, keepData: false, reason: "closed" });
  assert.equal(slowManager.calls.length, 0);
});

test("wrap secrets are masked in agent-readable text", async (t) => {
  const { registry } = registryFixture({
    providers: () => [provider({ secrets: true })],
    secrets: { [`${PLUGIN}/token`]: SECRET },
    answers: defaultAnswers({ wrap: (params) => ({ command: process.execPath, args: params.args, cwd: params.cwd, secretEnv: { BOX_TOKEN: "token" } }) })
  });
  const { manager, calls } = await managerFixture(t, registry);
  const created = manager.create({ provider: "terminal", profile: "normal", cwd, position: at, environment: choice });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].options.env.BOX_TOKEN, SECRET);
  assert.equal(manager.redactSecrets(`token=${SECRET}`), "token=<redacted:secret>");
  calls[0].print(`leaked ${SECRET}\r\n`);
  calls[0].exit(3);
  await waitFor(() => card(manager, created.id).status === "failed");
  assert.equal(card(manager, created.id).failureDetails.includes(SECRET), false);
});

test("the env-worktree example: a terminal in a real git worktree, restored in it, removed or kept on close", async (t) => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "canvastty-env-worktree-")));
  const lifetime = persistenceFixtureLifetime(t, root);
  const repo = join(root, "repo");
  await mkdir(join(repo, "sub"), { recursive: true });
  await writeFile(join(repo, "sub", "file.txt"), "hello\n");
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  const pluginRoot = fileURLToPath(new URL(".", example));
  const entryPath = join(pluginRoot, "services", "worktree.mjs");
  const dataDir = join(root, "plugin-data");
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: "9.9.9", locale: () => "en", stopGraceMs: 300,
    host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined }
  });
  lifetime.after(() => supervisor.dispose());
  const pluginId = exampleManifest.id;
  await supervisor.sync([{ pluginId, serviceId: "worktree", root: pluginRoot, entryPath,
    sha256: createHash("sha256").update(await readFile(entryPath)).digest("hex"), dataDir, permissions: ["environment:provide"] }]);
  // Host-only methods: a plugin surface cannot drive environments.
  await assert.rejects(supervisor.request(pluginId, "worktree", "canvastty.environment.prepare", {}), /method is invalid/u);
  const kinds = validatePluginManifest(exampleManifest).services[0].environments;
  const registry = new EnvironmentRegistry({
    providers: () => [{ pluginId, pluginName: "Worktree Env", serviceId: "worktree", kinds, secrets: false }],
    call: (id, serviceId, method, params, budget) => supervisor.hostCall(id, serviceId, method, params, budget),
    secret: async () => null
  });
  const store = join(root, "store");
  const first = await managerFixture(lifetime, registry, { directory: store });
  const worktree = { pluginId, kind: "worktree" };
  const removed = first.manager.create({ provider: "terminal", profile: "normal", cwd: join(repo, "sub"), position: at, environment: worktree });
  const kept = first.manager.create({ provider: "terminal", profile: "normal", cwd: repo, position: at,
    environment: { ...worktree, options: { branch: "feature/kept" } } });
  await waitFor(() => {
    assert.equal(card(first.manager, removed.id).failureDetails, null);
    assert.equal(card(first.manager, kept.id).failureDetails, null);
    return first.calls.length === 2;
  }, 15_000);
  const byCwd = (manager, id) => card(manager, id).cwd;
  const removedDir = byCwd(first.manager, removed.id);
  const keptDir = byCwd(first.manager, kept.id);
  assert.ok(removedDir.startsWith(join(dataDir, "worktrees")) && removedDir.endsWith(`${sep}sub`),
    JSON.stringify({ removedDir, dataDir }));
  assert.deepEqual(first.calls.map((call) => call.options.cwd).sort(), [keptDir, removedDir].sort());
  assert.equal(execFileSync("git", ["-C", keptDir, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim(), "feature/kept");
  await waitFor(() => card(first.manager, kept.id).environment?.label === "worktree feature/kept");
  await first.manager.shutdown();
  assert.ok(existsSync(removedDir) && existsSync(keptDir), "quitting keeps both worktrees");

  // Relaunch: resumed and wrapped into the same folders.
  const second = await managerFixture(lifetime, registry, { directory: store });
  await waitFor(() => second.calls.length === 2, 15_000);
  assert.deepEqual(second.calls.map((call) => call.options.cwd).sort(), [keptDir, removedDir].sort());
  assert.equal(card(second.manager, removed.id).environment.label, `worktree canvastty/${removed.id.slice(0, 8)}`);

  second.manager.dispose(removed.id, { keepEnvironmentData: false });
  second.manager.dispose(kept.id, { keepEnvironmentData: true });
  // release removes the folder first, then the branch: wait for both (under load the second lags).
  await waitFor(() => !existsSync(removedDir) && git("branch", "--list", `canvastty/${removed.id.slice(0, 8)}`) === "", 15_000);
  assert.ok(existsSync(keptDir));
  assert.match(git("branch", "--list", "feature/kept"), /feature\/kept/u);
});

test("quitting while prepare is pending: the choice is saved, the card comes back held, never local; Restart prepares with it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-env-pending-"));
  const lifetime = persistenceFixtureLifetime(t, directory);
  let finish;
  const slow = registryFixture({ answers: defaultAnswers({ prepare: () => new Promise((resolve) => { finish = resolve; }) }) });
  const first = await managerFixture(lifetime, slow.registry, { directory });
  const pending = first.manager.create({ provider: "terminal", profile: "normal", cwd, position: at,
    environment: { ...choice, options: { name: "two" } } });
  await waitFor(() => typeof finish === "function");
  await first.manager.shutdown();
  const [record] = await saved(directory);
  assert.equal(record.id, pending.id);
  assert.equal(record.lastState, "running");
  assert.equal(record.environment, undefined);
  assert.deepEqual(record.environmentChoice, { pluginId: PLUGIN, kind: "box", options: { name: "two" } });
  // The late answer belongs to a launch that no longer exists: released at once, never adopted or saved.
  finish({ ref: { box: "late" }, label: "late" });
  await waitFor(() => slow.requests.some((request) => request.step === "release"));
  assert.deepEqual(slow.requests.find((request) => request.step === "release").params,
    { sessionId: pending.id, kind: "box", ref: { box: "late" }, keepData: false, reason: "closed" });
  assert.equal(first.calls.length, 0);
  assert.equal((await saved(directory))[0].environment, undefined);

  // Next start: held with the reason, nothing spawned locally or anywhere, the choice kept for Restart.
  const second = registryFixture({ answers: defaultAnswers() });
  const restored = await managerFixture(lifetime, second.registry, { directory });
  const held = card(restored.manager, pending.id);
  assert.equal(held.status, "failed");
  assert.equal(held.restoreNote, "environment-pending");
  assert.match(held.failureDetails, /was being prepared when CanvasTTY closed.*not started locally/u);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(restored.calls.length, 0, "no local PTY");
  assert.equal(second.requests.length, 0, "nothing prepared without the person");
  // Held again on the next quit, until the person restarts it.
  await restored.manager.shutdown();
  assert.deepEqual((await saved(directory))[0].environmentChoice, { pluginId: PLUGIN, kind: "box", options: { name: "two" } });
  assert.equal((await saved(directory))[0].lastState, "running");

  const third = await managerFixture(lifetime, second.registry, { directory });
  third.manager.restart(pending.id);
  await waitFor(() => third.calls.length === 1);
  assert.deepEqual(second.requests.filter((request) => request.step === "prepare").map((request) => request.params.options), [{ name: "two" }]);
  assert.equal(third.calls[0].command, process.execPath, "wrapped by the environment, not the local shell");
  await waitFor(async () => (await saved(directory).catch(() => []))[0]?.environment?.ref?.box === "b-1");
  assert.equal((await saved(directory))[0].environmentChoice, undefined, "a prepared environment replaces the choice");

  // Stop and flush the previous run before replacing its descriptor for the next startup.
  await third.manager.shutdown();

  // A pending choice whose plugin is gone is held with the plugin's reason; Restart refuses, never runs locally.
  await writeFile(join(directory, "terminal-sessions.json"), JSON.stringify({ version: 2, sessions: [{
    ...record, environmentChoice: { pluginId: "gone.plugin", kind: "box" }
  }] }));
  const gone = await managerFixture(lifetime, registryFixture({ answers: defaultAnswers() }).registry, { directory });
  assert.equal(card(gone.manager, pending.id).restoreNote, "environment-pending");
  assert.match(card(gone.manager, pending.id).failureDetails, /Needs plugin gone\.plugin.*not started locally/u);
  assert.throws(() => gone.manager.restart(pending.id), /not started locally/u);
  assert.equal(gone.calls.length, 0);
});

test("a failed prepare keeps its choice across an app restart; manual Restart prepares it again, never locally", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-env-failed-"));
  const lifetime = persistenceFixtureLifetime(t, directory);
  let answer = { refuse: { reason: "no docker" } };
  const { registry, requests } = registryFixture({ answers: defaultAnswers({ prepare: () => answer }) });
  const first = await managerFixture(lifetime, registry, { directory });
  const created = first.manager.create({ provider: "terminal", profile: "normal", cwd, position: at,
    environment: { ...choice, options: { name: "two" } } });
  await waitFor(() => card(first.manager, created.id).status === "failed");
  // Restart in the same run keeps the options too.
  first.manager.restart(created.id);
  await waitFor(() => requests.filter((request) => request.step === "prepare").length === 2 && card(first.manager, created.id).status === "failed");
  await first.manager.shutdown();
  const [record] = await saved(directory);
  assert.equal(record.lastState, "failed");
  assert.deepEqual(record.environmentChoice, { pluginId: PLUGIN, kind: "box", options: { name: "two" } });

  const second = await managerFixture(lifetime, registry, { directory });
  const restored = card(second.manager, created.id);
  assert.equal(restored.status, "failed");
  assert.match(restored.failureDetails, /environment was not prepared.*not started locally/u);
  assert.equal(second.calls.length, 0);
  answer = { ref: { box: "b-2" }, label: "box b-2" };
  second.manager.restart(created.id);
  await waitFor(() => second.calls.length === 1);
  assert.equal(second.calls[0].command, process.execPath);
  assert.deepEqual(requests.filter((request) => request.step === "prepare").map((request) => request.params.options),
    [{ name: "two" }, { name: "two" }, { name: "two" }]);
  assert.equal(first.calls.length, 0);
});

test("a saved environment choice that cannot be read drops the card instead of restoring it locally", async () => {
  const { normalizePersistedTerminalSessions } = await import("../src/main/services/TerminalSessionStore.ts");
  const base = { id: "c", provider: "terminal", profile: "normal", role: "agent", title: "T", titleCustomized: false, cwd,
    position: at, size: { width: 700, height: 430 }, lastState: "running", restore: true };
  const read = (environmentChoice) => normalizePersistedTerminalSessions({ version: 2, sessions: [{ ...base, environmentChoice }] }).sessions;
  assert.deepEqual(read({ pluginId: PLUGIN, kind: "box", options: { name: "x", on: true } })[0].environmentChoice,
    { pluginId: PLUGIN, kind: "box", options: { name: "x", on: true } });
  for (const bad of [null, "box", { pluginId: PLUGIN }, { pluginId: "Bad Id", kind: "box" }, { pluginId: PLUGIN, kind: "box", options: { n: 1 } },
    { pluginId: PLUGIN, kind: "box", options: { big: "x".repeat(5_000) } }]) {
    assert.deepEqual(read(bad), [], JSON.stringify(bad)?.slice(0, 60));
  }
});

test("the environment wrapper gets the launch's search path even when Windows spells it Path", async () => {
  const { launchSearchPath } = await import("../src/main/services/TerminalManager.ts");
  assert.equal(launchSearchPath({ Path: "C:\\Windows\\System32;C:\\tools" }, "win32"), "C:\\Windows\\System32;C:\\tools");
  assert.equal(launchSearchPath({ PATH: "C:\\a", Path: "C:\\b" }, "win32"), "C:\\a");
  assert.equal(launchSearchPath({ path: "C:\\lower" }, "win32"), "C:\\lower");
  assert.equal(launchSearchPath({ Path: "/not/used" }, "linux"), undefined, "POSIX names are case-sensitive");
  assert.equal(launchSearchPath({ PATH: "/usr/bin" }, "darwin"), "/usr/bin");
  const source = await readFile(new URL("../src/main/services/TerminalManager.ts", import.meta.url), "utf8");
  assert.match(source, /path: launchSearchPath\(planned\.env\)/);
});
