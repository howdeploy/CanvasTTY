import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { EnvironmentRegistry } from "../src/main/services/EnvironmentRegistry.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { AgentIsolation, SANDBOX_EXEC, WORKTREE_GIT_NOTE } from "../src/main/services/isolation/AgentIsolation.ts";
import { subagentWorktreeResolver } from "../src/main/services/SubagentWorktreeResolver.ts";
import { fakeSpawner } from "./helpers/terminal.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = process.env.CANVASTTY_ENVIRONMENTS_PLUGIN_DIR
  ?? resolve(repoRoot, "../canvastty-work/canvastty-plugin-environments");
const pluginPresent = existsSync(join(pluginRoot, "canvastty.plugin.json"));
const onMac = process.platform === "darwin";

const waitFor = async (predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  throw new Error("Condition was not met in time.");
};

test("the real worktree environment wraps once before one active core seatbelt wrapper", {
  skip: !pluginPresent ? "Set CANVASTTY_ENVIRONMENTS_PLUGIN_DIR to the environments plugin source checkout."
    : !onMac ? "Native seatbelt profile evidence runs on macOS; Linux runtime containment is tested separately."
      : false
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-worktree-isolation-pipeline-")));
  const project = join(root, "project");
  const userData = join(root, "app-data");
  const pluginData = join(userData, "plugin-data");
  const tempRoot = join(root, "tmp");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(userData, { recursive: true }), mkdir(tempRoot, { recursive: true })]);
  const git = (...args) => execFileSync("git", ["-C", project, "-c", "user.name=CanvasTTY test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  }).trim();
  git("init", "-q", "-b", "main");
  await writeFile(join(project, "work.txt"), "base\n");
  await mkdir(join(project,"src","nested"),{recursive:true});
  await writeFile(join(project,"src","nested","module.txt"),"nested\n");
  git("add", "work.txt", "src/nested/module.txt");
  git("commit", "-qm", "base");

  const manifest = JSON.parse(await readFile(join(pluginRoot, "canvastty.plugin.json"), "utf8"));
  const pluginId = manifest.id;
  const worktreeService = manifest.services.find(service => service.id === "worktree");
  assert.ok(worktreeService?.environments?.some(kind => kind.kind === "worktree"));

  const ptyCalls = [];
  const wrapCalls = [];
  let supervisor;
  const clis = { get: provider => ({ state: "available", provider, executable: process.execPath, launcher: "native",
    environment: { PATH: process.env.PATH ?? "" }, checked: [] }), snapshot: () => ({}) };
  const terminals = new TerminalManager(() => undefined, clis, undefined, undefined, false, fakeSpawner(ptyCalls));
  const failures = [];
  t.after(async () => {
    try { await terminals.shutdown(); } catch (error) { failures.push(error); }
    try { await supervisor?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Worktree isolation fixture cleanup failed");
  });

  supervisor = new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 15_000,
    stopGraceMs: 300,
    environment: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    host: {
      storageGet: async () => null,
      storageSet: async () => undefined,
      emit: () => undefined,
      sessions: async () => { throw new Error("the worktree environment must not call session APIs"); },
      setBadge: () => null
    }
  });
  const entryPath = join(pluginRoot, worktreeService.entry);
  await supervisor.sync([{
    pluginId, serviceId: worktreeService.id, root: pluginRoot, entryPath,
    sha256: createHash("sha256").update(await readFile(entryPath)).digest("hex"),
    dataDir: pluginData, permissions: ["environment:provide"]
  }]);
  const status = () => supervisor.report(pluginId);
  await waitFor(() => status().services.every(service => service.state === "running"));

  const provider = { pluginId, pluginName: manifest.name, serviceId: worktreeService.id,
    kinds: worktreeService.environments, secrets: false };
  const registry = new EnvironmentRegistry({
    providers: () => [provider],
    call: (id, serviceId, method, params, timeoutMs) => {
      if (method === "canvastty.environment.wrap") wrapCalls.push({ sessionId: params.sessionId, command: params.command, cwd: params.cwd });
      return supervisor.hostCall(id, serviceId, method, params, timeoutMs);
    },
    secret: async () => null
  });
  terminals.configureEnvironments(registry);
  const isolation = new AgentIsolation({ userDataPath: userData, tempRoot, enabled: () => true,
    platform: "darwin", exists: path => path === SANDBOX_EXEC || existsSync(path),
    hostEnvironment: { HOME: process.env.HOME, PATH: process.env.PATH } });
  terminals.configureIsolation(isolation);

  const rootSession = terminals.create({ provider: "codex", profile: "normal", cwd: project, position: { x: 0, y: 0 }, role: "orchestrator" });
  const resolver = subagentWorktreeResolver({
    isGitProject: async folder => {
      try { return Boolean(execFileSync("git", ["-C", folder, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()); }
      catch { return false; }
    },
    providers: () => [provider]
  });
  const control = new AgentControlService(terminals, { resolveSubagentEnvironment: request => resolver(request) });
  const first = await control.spawn({ parentSessionId: rootSession.id, provider: "codex", cwd: project, title: "Isolation worker one" });
  const second = await control.spawn({ parentSessionId: rootSession.id, provider: "codex", cwd: join(project,"src","nested"), title: "Isolation worker from nested folder" });
  const workers = [first, second];
  await waitFor(() => workers.every(worker => terminals.pluginContext(worker.id)?.environment
    && ptyCalls.some(call => call.options.cwd === terminals.pluginContext(worker.id).workingDirectory))).catch(error => {
    throw new Error(`${error.message}; cards=${JSON.stringify(terminals.listMetadata().map(session => ({ id: session.id, status: session.status,
      failureDetails: session.failureDetails, environmentChoice: session.environmentChoice, environment: session.environment, isolation: session.isolation })))}; `
      + `pty=${JSON.stringify(ptyCalls.map(call => ({ command: call.command, cwd: call.options.cwd })))}; wraps=${JSON.stringify(wrapCalls)}; `
      + `services=${JSON.stringify(status())}`);
  });

  assert.deepEqual(wrapCalls.map(call => call.sessionId).sort(), workers.map(worker => worker.id).sort(),
    "the real environment service receives one wrap RPC for each delegated worker");
  assert.equal(ptyCalls.filter(call => call.command === SANDBOX_EXEC).length, workers.length,
    "each worker's final PTY launch has exactly one native isolation wrapper");
  for (const worker of workers) {
    const context = terminals.pluginContext(worker.id);
    const environmentWrap = wrapCalls.find(call => call.sessionId === worker.id);
    assert.equal(environmentWrap.command, process.execPath);
    assert.equal(environmentWrap.cwd, context.workingDirectory, "the host pins environment wrapping to its returned working directory");
    const launch = ptyCalls.find(call => call.options.cwd === context.workingDirectory);
    assert.ok(launch, `fake PTY captured ${worker.title}'s final launch`);
    assert.equal(launch.command, SANDBOX_EXEC, "the core's native isolation wrapper is the final command");
    assert.equal(launch.args[0], "-f");
    assert.equal(launch.args.filter(argument => argument === process.execPath).length, 1,
      "the original CLI appears once inside the single sandbox wrapper");
    assert.equal(terminals.getMetadata(worker.id).isolation.state, "on");
    assert.equal(terminals.getMetadata(worker.id).isolation.layer, "seatbelt");
    assert.equal(terminals.getMetadata(worker.id).isolation.reason, WORKTREE_GIT_NOTE);
    assert.equal(launch.options.cwd, context.workingDirectory, "the wrapped launch stays in the registered worktree");
    assert.equal(launch.options.env.GIT_OPTIONAL_LOCKS, "0");
    assert.match(launch.options.env.CANVASTTY_ISOLATION, /Git metadata stays read-only/u);

    const profile = await readFile(launch.args[1], "utf8");
    assert.ok(profile.includes(`(subpath "${pluginData}")`), "the worktree parent is hidden");
    assert.ok(profile.includes(`(allow file-write* (subpath "${context.environment.ref.dir}")`), "the registered worker tree is reopened for edits, including nested launch folders");
    const commonDir = join(context.environment.ref.repo, ".git");
    const adminDir = execFileSync("git", ["-C", context.environment.ref.dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
    const projectWriteReopen = profile.indexOf(`(allow file-write* (subpath "${context.environment.ref.dir}")`);
    assert.ok(profile.includes(`(subpath "${commonDir}")`) && profile.lastIndexOf(`(subpath "${commonDir}")`) > projectWriteReopen,
      "shared Git metadata is denied after the worker reopen");
    assert.ok(profile.includes(`(subpath "${adminDir}")`) && profile.lastIndexOf(`(subpath "${adminDir}")`) > projectWriteReopen,
      "the linked-worktree administration directory stays protected after the worker reopen");
  }
  assert.ok(wrapCalls.every(call => call.command === process.execPath),
    "the environment wrapper runs on the host CLI command before core isolation wraps it");

  for (const worker of workers) {
    const launch = ptyCalls.find(call => call.options.cwd === terminals.pluginContext(worker.id).workingDirectory);
    launch.process.emitExit(0);
  }
  await waitFor(() => workers.every(worker => terminals.getMetadata(worker.id)?.status === "done"));
});
