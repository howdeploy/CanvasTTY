import { verifiedEnvironmentPluginSource } from "./helpers/environment-provenance.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { EnvironmentRegistry } from "../src/main/services/EnvironmentRegistry.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { subagentWorktreeResolver } from "../src/main/services/SubagentWorktreeResolver.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { fakeSpawner } from "./helpers/terminal.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = process.env.CANVASTTY_ENVIRONMENTS_PLUGIN_DIR
  ?? resolve(repoRoot, "../canvastty-work/canvastty-plugin-environments");
const pluginPresent = existsSync(join(pluginRoot, "canvastty.plugin.json"));
const waitFor = async (predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  throw new Error("Condition was not met in time.");
};

test("two delegated workers use the real worktree plugin, stay isolated, and only merge after an explicit choice", {
  skip: !pluginPresent && "Set CANVASTTY_ENVIRONMENTS_PLUGIN_DIR to the environments plugin source checkout."
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-subagent-worktree-plugin-")));
  const project = join(root, "project");
  const pluginData = join(root, "plugin-data");
  await mkdir(project, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", project, "-c", "user.name=CanvasTTY test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  }).trim();
  git("init", "-q", "-b", "main");
  // The real plugin commits in a child process, without this helper's -c flags.
  git("config", "user.name", "CanvasTTY test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(project, "shared.txt"), "base version\n");
  git("add", "shared.txt");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const serviceEnvironment = { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, LC_ALL: "C" };
  const gitAddLog = join(root, "worktree-add.log");
  const gitAddOverlap = join(root, "worktree-add-overlap");
  if (process.platform !== "win32") {
    const wrapperDir = join(root, "git-wrapper");
    await mkdir(wrapperDir);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shimConfig = JSON.stringify({ realGit, lock: join(root, "worktree-add.lock"), gitAddLog, gitAddOverlap });
    await writeFile(join(wrapperDir, "git"), `#!${process.execPath}
const { appendFileSync, mkdirSync, rmdirSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const config = ${shimConfig};
const args = process.argv.slice(2);
const isWorktreeAdd = args.some((arg, index) => arg === "worktree" && args[index + 1] === "add");
const runGit = () => spawnSync(config.realGit, args, { stdio: "inherit", env: process.env });
if (!isWorktreeAdd) {
  const result = runGit();
  if (result.error) { console.error(result.error.message); process.exit(1); }
  process.exit(result.status ?? 1);
}
appendFileSync(config.gitAddLog, "add\\n");
try { mkdirSync(config.lock); } catch {
  writeFileSync(config.gitAddOverlap, "A second git worktree add overlapped the first.\\n");
  console.error("overlapping git worktree add operations");
  process.exit(88);
}
try {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
  const result = runGit();
  if (result.error) { console.error(result.error.message); process.exitCode = 1; }
  else process.exitCode = result.status ?? 1;
} finally { rmdirSync(config.lock); }
`, { mode: 0o755 });
    serviceEnvironment.PATH = `${wrapperDir}${delimiter}${process.env.PATH ?? ""}`;
  }
  const manifest = JSON.parse(await readFile(join(pluginRoot, "canvastty.plugin.json"), "utf8"));
  const pluginId = manifest.id;
  const calls = [];
  let supervisor;
  let pluginSessions;
  const clis = { get: provider => ({ state: "available", provider, executable: process.execPath, launcher: "native", environment: { PATH: process.env.PATH ?? "" }, checked: [] }), snapshot: () => ({}) };
  const terminals = new TerminalManager((channel, payload) => pluginSessions?.observe(channel, payload), clis, undefined, undefined, true,
    fakeSpawner(calls));
  const teardown = [];
  t.after(async () => {
    const failures = [];
    for (const action of teardown.reverse()) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    try { await terminals.shutdown(); } catch (error) { failures.push(error); }
    try { await supervisor?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Worktree plugin fixture cleanup failed");
  });

  pluginSessions = new PluginSessions({ terminals, notify: (id, service, method, params) => supervisor?.notify(id, service, method, params) ?? false });
  supervisor = new PluginServiceSupervisor({
    command: process.execPath,
    environment: serviceEnvironment,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 15_000,
    stopGraceMs: 300,
    host: {
      storageGet: async () => null,
      storageSet: async () => undefined,
      emit: () => undefined,
      sessions: (id, service, method, params, permissions) => pluginSessions.handle(id, service, method, params, permissions),
      setBadge: () => null
    }
  });

  const serviceSpec = async service => {
    const entryPath = join(pluginRoot, service.entry);
    return {
      pluginId, serviceId: service.id, root: pluginRoot, entryPath,
      sha256: createHash("sha256").update(await readFile(entryPath)).digest("hex"),
      dataDir: pluginData,
      permissions: service.id === "worktree"
        ? ["environment:provide"]
        : ["tools:agents", "cards:decorate", "sessions:events", "storage"]
    };
  };
  const worktreeService = manifest.services.find(service => service.id === "worktree");
  const resultsService = manifest.services.find(service => service.id === "results");
  assert.ok(worktreeService?.environments?.some(kind => kind.kind === "worktree"));
  await supervisor.sync([await serviceSpec(worktreeService), await serviceSpec(resultsService)]);
  await waitFor(() => supervisor.report(pluginId).services.every(service => service.state === "running"));

  const envProvider = { pluginId, sourceUrl: verifiedEnvironmentPluginSource(pluginRoot), pluginName: manifest.name, serviceId: worktreeService.id, kinds: worktreeService.environments, secrets: false };
  const registry = new EnvironmentRegistry({
    providers: () => [envProvider],
    call: (id, service, method, params, timeoutMs) => supervisor.hostCall(id, service, method, params, timeoutMs),
    secret: async () => null
  });
  terminals.configureEnvironments(registry);
  const rootSession = terminals.create({ provider: "codex", profile: "normal", cwd: project, position: { x: 0, y: 0 }, role: "orchestrator" });
  const selected = [];
  const resolveEnvironment = subagentWorktreeResolver({
    isGitProject: async folder => { try { return Boolean(execFileSync("git", ["-C", folder, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()); } catch { return false; } },
    providers: () => [envProvider]
  });
  const control = new AgentControlService(terminals, {
    currentTurnEpoch: () => 1,
    resolveSubagentEnvironment: request => { selected.push(request.liveChildren); return resolveEnvironment(request); }
  });
  const first = await control.spawn({ parentSessionId: rootSession.id, provider: "codex", cwd: project,
    title: "First worker", profile: "plan", model: "fixture-model", readOnlyReview: true });
  const second = await control.spawn({ parentSessionId: rootSession.id, provider: "codex", cwd: project, title: "Second worker" });
  await waitFor(() => calls.length === 3
    && terminals.pluginContext(first.id)?.environment
    && terminals.pluginContext(second.id)?.environment).catch(error => {
      throw new Error(`${error.message}; cards=${JSON.stringify(terminals.listMetadata().map(session => ({ id: session.id, status: session.status,
        failureDetails: session.failureDetails, environmentChoice: session.environmentChoice, environment: session.environment })))}`
        + `; services=${JSON.stringify(supervisor.report(pluginId))}`);
    });
  if (process.platform !== "win32") {
    assert.deepEqual((await readFile(gitAddLog, "utf8")).trim().split("\n"), ["add", "add"],
      "both plugin worktree additions pass through the serialized-operation fixture");
    assert.equal(existsSync(gitAddOverlap), false, "delegated workers never overlap git worktree add operations");
  }
  assert.deepEqual(selected.sort(), [0, 1], "the first and subsequent worker both go through the resolver");

  const firstContext = terminals.pluginContext(first.id);
  const secondContext = terminals.pluginContext(second.id);
  const firstRef = firstContext.environment.ref;
  const secondRef = secondContext.environment.ref;
  assert.equal(firstRef.repo, project);
  assert.equal(secondRef.repo, project);
  assert.equal(firstRef.base, base);
  assert.equal(secondRef.base, base, "the second worker starts from the same project commit, not the first worker's edits");
  assert.equal(git("show", `${firstRef.branch}:shared.txt`), "base version");
  assert.equal(git("show", `${secondRef.branch}:shared.txt`), "base version");

  await writeFile(join(firstRef.dir, "shared.txt"), "first worker version\n");
  assert.equal(await readFile(join(secondRef.dir, "shared.txt"), "utf8"), "base version\n",
    "the second worker cannot see unmerged edits in the first isolated worktree");
  await writeFile(join(secondRef.dir, "shared.txt"), "second worker version\n");
  assert.equal(await readFile(join(project, "shared.txt"), "utf8"), "base version\n",
    "neither worker writes through to the checked-out project");

  const firstPty = calls.find(call => call.options.cwd === firstContext.workingDirectory).process;
  assert.equal(control.markLoopDetected(first.id), true);
  let stopCount = 0;
  let readOnlyDuringStop;
  firstPty.kill = () => { stopCount++; readOnlyDuringStop = control.isReadOnlyReviewer(first.id); firstPty.emitExit(137); };
  const retried = await control.retry(first.id, "The worktree agent stopped making progress.");
  const retryContext = terminals.pluginContext(retried.id);
  assert.equal(retryContext.workingDirectory, firstContext.workingDirectory, "retry runs in the original worktree directory");
  assert.deepEqual(retryContext.environment, firstContext.environment, "retry retains the same plugin environment ref");
  assert.equal(await readFile(join(retryContext.workingDirectory, "shared.txt"), "utf8"), "first worker version\n",
    "edits from the failed attempt remain available to its retry");
  assert.equal(retried.id, first.id, "retry reuses the prepared worktree session instead of creating a second owner");
  assert.equal(control.isReadOnlyReviewer(retried.id), true, "retry retains its host-owned read-only tool restriction");
  assert.equal(readOnlyDuringStop, true, "the read-only tool restriction stays in force while the prior PTY stops");
  assert.equal(stopCount, 1, "a quiet live PTY is stopped before the same writable worktree is reused");
  assert.equal(retried.profile, first.profile, "retry preserves the launch mode");
  assert.equal(retried.model, first.model, "retry preserves the selected model");
  assert.equal(calls.filter(call => call.options.cwd === firstContext.workingDirectory).length, 2,
    "retry launches in the same worktree without preparing another one");
  assert.equal(control.observe(retried.id).loopDetected, undefined, "the prior attempt's loop marker does not authorize another retry");

  assert.equal(control.markLoopDetected(retried.id), true);
  calls.findLast(call => call.options.cwd === firstContext.workingDirectory).process.emitExit(137);
  const retriedAgain = await control.retry(retried.id, "The second attempt stopped in the same worktree.");
  const secondRetryContext = terminals.pluginContext(retriedAgain.id);
  assert.equal(control.isReadOnlyReviewer(retriedAgain.id), true, "repeated retry retains its host-owned read-only tool restriction");
  assert.equal(secondRetryContext.workingDirectory, firstContext.workingDirectory, "a repeated retry keeps the original worktree directory");
  assert.deepEqual(secondRetryContext.environment, firstContext.environment, "a repeated retry keeps the original environment ref");
  assert.equal(await readFile(join(secondRetryContext.workingDirectory, "shared.txt"), "utf8"), "first worker version\n",
    "the worktree edit also survives a repeated retry");
  assert.equal(calls.filter(call => call.options.cwd === firstContext.workingDirectory).length, 3,
    "both retries launch without preparing or owning another worktree");
  assert.equal(control.observe(retriedAgain.id).loopDetected, undefined, "each retry clears the prior loop marker");
  assert.equal(control.markLoopDetected(retriedAgain.id), true);
  await assert.rejects(control.retry(retriedAgain.id), /limit of 2 retries/u, "the same worktree owner retains the finite retry limit");
  calls.findLast(call => call.options.cwd === firstContext.workingDirectory).process.emitExit(0);

  for (const worker of [first, second]) {
    assert.equal(terminals.decisionContext(worker.id).cwd, terminals.pluginContext(worker.id).workingDirectory,
      "runtime decision hooks use the environment's actual worktree as their root");
    const pty = calls.findLast(call => call.options.cwd === terminals.pluginContext(worker.id).workingDirectory);
    assert.ok(pty, `fake PTY launched for ${worker.title}`);
    if (worker.id !== first.id) pty.process.emitExit(0);
  }
  await waitFor(() => [first, second].every(worker => terminals.getMetadata(worker.id)?.status === "done"));

  const rootSummary = () => pluginSessions.summary(rootSession.id);
  const invoke = (actionId, input = {}) => supervisor.hostCall(pluginId, "results", "canvastty.cards.invoke",
    { actionId, session: rootSummary(), input }, 15_000);
  let review;
  await waitFor(async () => {
    const answer = await invoke("review-task-changes");
    if (answer.review) { review = answer.review; return true; }
    return false;
  });
  assert.deepEqual(review.groups.map(group => group.sessionId), [first.id, second.id]);
  assert.equal(review.groups[0].files[0].conflict.current.text, "second worker version");
  assert.equal(review.groups[0].files[0].conflict.agent.text, "first worker version");
  assert.equal(git("rev-parse", "HEAD"), base, "review collection does not merge into the checked-out branch");

  for (const worker of [first, second]) {
    const detail = await invoke("review-task-changes", { agentSessionId: worker.id, file: "shared.txt", page: 0 });
    assert.ok(detail.review, JSON.stringify(detail));
  }
  const accepted = await invoke("accept-task-changes", {
    agentSessionId: first.id, files: ["shared.txt"], resolutions: { "shared.txt": "agent" }
  });
  assert.equal(accepted.tone, "info", accepted.message);
  assert.equal(git("show", "HEAD:shared.txt"), "first worker version");
  await waitFor(() => !existsSync(firstRef.dir));
  assert.equal(git("branch", "--list", firstRef.branch), "", "accept removes the completed source worktree and its branch");
  assert.ok(existsSync(secondRef.dir), "the other worker's source remains until its changes are resolved");
  assert.equal(git("show", "HEAD:shared.txt"), "first worker version", "only the chosen worker version was merged");

  // The first acceptance changes the conflict's current side. Reopen the complete task review,
  // inspect the second worker's updated diff, then explicitly keep the current first-worker version.
  const afterFirstAcceptance = await invoke("review-task-changes");
  assert.ok(afterFirstAcceptance.review, JSON.stringify(afterFirstAcceptance));
  const secondConflict = await invoke("review-task-changes", { agentSessionId: second.id, file: "shared.txt", page: 0 });
  assert.ok(secondConflict.review, JSON.stringify(secondConflict));
  const secondSharedFile = secondConflict.review.groups.flatMap(group => group.files)
    .find(file => file.path === "shared.txt");
  assert.equal(secondSharedFile.conflict.current.text, "first worker version");
  assert.equal(secondSharedFile.conflict.agent.text, "second worker version");
  const keepFirstVersion = await invoke("accept-task-changes", {
    agentSessionId: second.id, files: ["shared.txt"], resolutions: { "shared.txt": "current" }
  });
  assert.equal(keepFirstVersion.tone, "info", keepFirstVersion.message);
  assert.equal(git("show", "HEAD:shared.txt"), "first worker version", "resolving current keeps the already accepted first-worker version");
  const afterCurrentResolution = await invoke("review-task-changes");
  assert.ok(afterCurrentResolution.review, JSON.stringify(afterCurrentResolution));
  assert.ok(!afterCurrentResolution.review.groups.some(group => group.sessionId === second.id
    && group.files.some(file => file.path === "shared.txt")),
  "the explicit current-side choice removes the discarded second-worker version from fresh review");
  await waitFor(() => !existsSync(secondRef.dir));
  assert.equal(git("branch", "--list", secondRef.branch), "", "resolving current releases the finished second-worker source");

  // Reuse the resolved card ID for a new source tree. The prior resolution must not hide this new work.
  const reused = await supervisor.hostCall(pluginId, "worktree", "canvastty.environment.prepare",
    { sessionId: first.id, cwd: project, projectRoot: project, options: {} }, 15_000);
  assert.ok(reused.ref, JSON.stringify(reused));
  await writeFile(join(reused.ref.dir, "new-turn.txt"), "new work on a reused card id\n");
  const previousSummary = pluginSessions.summary(first.id);
  assert.ok(previousSummary?.environment);
  await supervisor.notify(pluginId, "results", "canvastty.sessions.event", {
    type: "status", session: { ...previousSummary, environment: { ...previousSummary.environment, ref: reused.ref } }
  });

  const remaining = await invoke("review-task-changes");
  assert.ok(remaining.review, JSON.stringify(remaining));
  assert.ok(!remaining.review.groups.some(group => group.sessionId === second.id && group.files.some(file => file.path === "shared.txt")),
    "the explicit current-side resolution hides the second worker's discarded version");
  assert.ok(remaining.review.groups.find(group => group.sessionId === first.id)?.files.some(file => file.path === "new-turn.txt"),
    "a new worktree ref on a previously resolved session ID is included again");
  const notReopened = await invoke("accept-task-changes");
  assert.equal(notReopened.tone, "error", "a reused actor's new files cannot inherit the earlier review approval");
  for (const group of remaining.review.groups) for (const file of group.files) {
    const detail = await invoke("review-task-changes", { agentSessionId: group.sessionId, file: file.path, page: 0 });
    assert.ok(detail.review, JSON.stringify(detail));
  }
  const acceptedTask = await invoke("accept-task-changes");
  assert.equal(acceptedTask.tone, "info", JSON.stringify({ message: acceptedTask.message, review: remaining.review }));
  await waitFor(() => !existsSync(reused.ref.dir));
  assert.equal(git("branch", "--list", reused.ref.branch), "", "reused session worktree branch is removed after its new diff is reviewed");
  assert.equal(git("show", "HEAD:new-turn.txt"), "new work on a reused card id", "the newly reviewed work is accepted rather than skipped");
});
