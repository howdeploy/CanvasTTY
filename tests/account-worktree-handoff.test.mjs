import { verifiedEnvironmentPluginSource, verifiedAccountsPluginSource } from "./helpers/environment-provenance.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EnvironmentRegistry } from "../src/main/services/EnvironmentRegistry.ts";
import { LaunchPipeline } from "../src/main/services/LaunchPipeline.ts";
import { AgentIsolation, SANDBOX_EXEC } from "../src/main/services/isolation/AgentIsolation.ts";
import { PluginCards } from "../src/main/services/PluginCards.ts";
import { PluginServiceSupervisor } from "../src/main/services/PluginServiceSupervisor.ts";
import { PluginSessions } from "../src/main/services/PluginSessions.ts";
import { SecretRedactionRegistry } from "../src/main/services/safety/SecretRedaction.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { fakeSpawner } from "./helpers/terminal.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const accountsRoot = process.env.CANVASTTY_ACCOUNTS_PLUGIN_DIR
  ?? resolve(repoRoot, "../canvastty-work/canvastty-plugin-accounts");
const environmentsRoot = process.env.CANVASTTY_ENVIRONMENTS_PLUGIN_DIR
  ?? resolve(repoRoot, "../canvastty-work/canvastty-plugin-environments");
const fixtureAvailable = existsSync(join(accountsRoot, "canvastty.plugin.json"))
  && existsSync(join(environmentsRoot, "canvastty.plugin.json"));
const macIsolationAvailable = process.platform === "darwin" && existsSync(SANDBOX_EXEC);

const waitFor = async (predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  throw new Error("Condition was not met in time.");
};

test("consented account handoff continues in the same real worktree after an alternate launch", {
  skip: !fixtureAvailable
    ? "Set CANVASTTY_ACCOUNTS_PLUGIN_DIR and CANVASTTY_ENVIRONMENTS_PLUGIN_DIR to the built plugin checkouts."
    : !macIsolationAvailable && "Requires macOS sandbox-exec to exercise the real isolation wrapper."
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "canvastty-account-worktree-handoff-")));
  const project = join(root, "project");
  const userData = join(root, "app-data");
  const pluginDataRoot = join(userData, "plugin-data");
  const accountsData = join(pluginDataRoot, "canvastty-accounts");
  const environmentsData = join(pluginDataRoot, "canvastty-environments");
  const isolationTemp = join(root, "isolation-tmp");
  await Promise.all([project, accountsData, environmentsData, isolationTemp].map(path => mkdir(path, { recursive: true })));
  const git = (...args) => execFileSync("git", ["-C", project, "-c", "user.name=CanvasTTY test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  }).trim();
  git("init", "-q", "-b", "main");
  await writeFile(join(project, "task.txt"), "project baseline\n");
  git("add", "task.txt");
  git("commit", "-qm", "base");
  const projectHead = git("rev-parse", "HEAD");

  const accountsManifest = JSON.parse(await readFile(join(accountsRoot, "canvastty.plugin.json"), "utf8"));
  const environmentsManifest = JSON.parse(await readFile(join(environmentsRoot, "canvastty.plugin.json"), "utf8"));
  const accountsId = accountsManifest.id;
  const environmentsId = environmentsManifest.id;
  const accountsService = accountsManifest.services.find(service => service.id === "accounts");
  const worktreeService = environmentsManifest.services.find(service => service.id === "worktree");
  assert.ok(accountsService?.cardActions?.some(action => action.id === "handoff"));
  assert.ok(accountsService?.launch?.appliesTo?.includes("codex"));
  assert.ok(worktreeService?.environments?.some(kind => kind.kind === "worktree"));

  const alternateAccount = {
    id: "alternate",
    label: "Fixture alternate",
    preset: "zai-openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-fixture",
    responsesApi: true,
    agents: ["codex"]
  };
  const savedAccounts = {
    settings: { version: 1, accounts: [alternateAccount] },
    keyOrigins: { alternate: "https://api.z.ai" }
  };
  const fixtureSecret = "fixture-only-account-key-value";
  const redaction = new SecretRedactionRegistry();
  const ptyCalls = [];
  const killedPids = [];
  const writes = [];
  const lifecycle = [];
  const spawnFake = fakeSpawner(ptyCalls, {
    onWrite(data, options) { writes.push({ data, cwd: options.cwd }); }
  });
  const spawnPty = (command, args, options) => {
    const process = spawnFake(command, args, options);
    const row = ptyCalls.at(-1);
    const originalWrite = process.write.bind(process);
    const originalKill = process.kill.bind(process);
    process.write = data => {
      lifecycle.push({ type: "write", data, cwd: options.cwd, pid: row.process.pid });
      originalWrite(data);
    };
    process.kill = () => {
      killedPids.push(row.process.pid);
      lifecycle.push({ type: "kill", pid: row.process.pid });
      originalKill();
    };
    return process;
  };
  let supervisor;
  let terminals;
  let pluginSessions;
  let cards;
  const environmentCalls = [];
  const launchCalls = [];
  const networkRoots = [];
  const isolationLaunches = [];
  const hostCalls = [];
  const terminalEvents = [];
  let failNextIsolationLaunch = false;

  t.after(async () => {
    const failures = [];
    try { await terminals?.shutdown(); } catch (error) { failures.push(error); }
    try { await supervisor?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Account/worktree handoff fixture cleanup failed");
  });

  const cliRegistry = {
    get: provider => ({ state: "available", provider, executable: process.execPath, launcher: "native",
      environment: { PATH: process.env.PATH ?? "" }, checked: [] }),
    snapshot: () => ({})
  };
  terminals = new TerminalManager((channel, payload) => {
    if (payload?.session) terminalEvents.push(structuredClone(payload.session));
    pluginSessions?.observe(channel, payload);
  },
    cliRegistry, undefined, undefined, true, spawnPty);
  terminals.configureRedaction(redaction);
  redaction.add(`plugin:${accountsId}`, [fixtureSecret]);
  const isolation = new AgentIsolation({
    userDataPath: userData,
    tempRoot: isolationTemp,
    enabled: () => true,
    platform: "darwin",
    exists: path => path === SANDBOX_EXEC || existsSync(path),
    hostEnvironment: { HOME: process.env.HOME, PATH: process.env.PATH },
    networkPolicy: {
      getPolicy: projectRoot => { networkRoots.push(projectRoot); return { mode: "open" }; },
      getEffectivePolicy: projectRoot => { networkRoots.push(projectRoot); return { mode: "open", domains: [] }; },
      prepareLaunch: projectRoot => {
        networkRoots.push(projectRoot);
        if (failNextIsolationLaunch) {
          failNextIsolationLaunch = false;
          throw new Error("fixture isolation launch failure");
        }
        return { mode: "open", domains: [], cleanup() {} };
      }
    }
  });
  const isolationWrap = isolation.wrap.bind(isolation);
  isolation.wrap = launch => {
    isolationLaunches.push({ sessionId: launch.sessionId, provider: launch.provider, cwd: launch.cwd,
      networkProjectRoot: launch.networkProjectRoot, accountHome: launch.accountHome });
    return isolationWrap(launch);
  };
  terminals.configureIsolation(isolation);

  const accountPermissions = accountsManifest.permissions;
  supervisor = new PluginServiceSupervisor({
    command: process.execPath,
    hostVersion: "9.9.9",
    locale: () => "en",
    requestTimeoutMs: 15_000,
    stopGraceMs: 300,
    environment: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    host: {
      storageGet: async (pluginId, key) => pluginId === accountsId && key === "accounts" ? savedAccounts : null,
      storageSet: async (pluginId, key, value) => {
        hostCalls.push({ method: "storage.set", pluginId, key, value });
      },
      emit: (pluginId, serviceId, event, data) => hostCalls.push({ method: "event", pluginId, serviceId, event, data }),
      registerSecrets: (pluginId, values) => redaction.add(`plugin:${pluginId}`, values),
      maskSecrets: text => redaction.redact(text),
      secretGet: async (pluginId, key) => pluginId === accountsId && key === "key.alternate" ? fixtureSecret : null,
      sessions: (pluginId, serviceId, method, params, permissions) => pluginSessions.handle(pluginId, serviceId, method, params, permissions),
      setBadge: (pluginId, params) => cards.setBadge(pluginId, params)
    }
  });
  const accountsSourceUrl = verifiedAccountsPluginSource(accountsRoot);
  pluginSessions = new PluginSessions({
    experimentalEnabled: () => true,
    installRecord: id => id === accountsId ? {sourceUrl:accountsSourceUrl,enabled:true,nativeCodeTrusted:true} : null,
    terminals,
    notify: (pluginId, serviceId, method, params) => supervisor?.notify(pluginId, serviceId, method, params) ?? false
  });

  const accountActions = accountsService.cardActions;
  cards = new PluginCards({
    invokeWithConsent: (pluginId, actionId, sessionId, action) => pluginSessions.withCardConsent(pluginId, actionId, sessionId, action),
    providers: () => [{ pluginId: accountsId, pluginName: accountsManifest.name, serviceId: accountsService.id, actions: accountActions }],
    trustedPlugins: () => new Set([accountsId]),
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    session: sessionId => pluginSessions.summary(sessionId),
    redact: text => terminals.redactSecrets(text),
    changed: () => undefined
  });

  const accountsEntry = join(accountsRoot, accountsService.entry);
  const worktreeEntry = join(environmentsRoot, worktreeService.entry);
  const accountsSpec = {
    pluginId: accountsId,
    serviceId: accountsService.id,
    root: accountsRoot,
    entryPath: accountsEntry,
    sha256: createHash("sha256").update(await readFile(accountsEntry)).digest("hex"),
    dataDir: accountsData,
    permissions: accountPermissions
  };
  const worktreeSpec = {
    pluginId: environmentsId,
    serviceId: worktreeService.id,
    root: environmentsRoot,
    entryPath: worktreeEntry,
    sha256: createHash("sha256").update(await readFile(worktreeEntry)).digest("hex"),
    dataDir: environmentsData,
    permissions: ["environment:provide"]
  };
  await supervisor.sync([worktreeSpec, accountsSpec]);
  await waitFor(() => [accountsId, environmentsId].every(pluginId =>
    supervisor.report(pluginId).services.every(service => service.state === "running")));

  const accountContributor = {
    pluginId: accountsId,
    pluginName: accountsManifest.name,
    serviceId: accountsService.id,
    dataDir: accountsData,
    launch: accountsService.launch,
    secrets: accountPermissions.includes("secrets")
  };
  const pipeline = new LaunchPipeline({
    contributors: () => [accountContributor],
    call: (pluginId, serviceId, method, params, timeoutMs) => {
      launchCalls.push({ pluginId, serviceId, method, params });
      return supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs);
    },
    secret: async pluginId => pluginId === accountsId ? fixtureSecret : null,
    runsRoot: join(userData, "launch-runs")
  });
  terminals.configureLaunchPipeline(pipeline);
  const environmentProvider = { sourceUrl: verifiedEnvironmentPluginSource(environmentsRoot),
    pluginId: environmentsId,
    pluginName: environmentsManifest.name,
    serviceId: worktreeService.id,
    kinds: worktreeService.environments,
    secrets: false
  };
  const environments = new EnvironmentRegistry({
    providers: () => [environmentProvider],
    call: (pluginId, serviceId, method, params, timeoutMs) => {
      environmentCalls.push({ pluginId, serviceId, method, params });
      return supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs);
    },
    secret: async () => null
  });
  terminals.configureEnvironments(environments);

  const source = terminals.create({
    provider: "codex",
    cwd: project,
    profile: "acceptEdits",
    position: { x: 0, y: 0 },
    role: "agent",
    launchOptions: { [accountsId]: { account: "none", effort: "default", trustFolder: false } },
    environment: { pluginId: environmentsId, kind: "worktree" }
  });
  const sourceInput = await terminals.deliverInput(source.id, "start\r", 5_000);
  assert.equal(sourceInput.delivered, true, sourceInput.reason ?? JSON.stringify(terminals.getMetadata(source.id)));
  await waitFor(() => Boolean(terminals.pluginContext(source.id)?.environment)
    && ptyCalls.some(call => call.options.cwd === terminals.pluginContext(source.id)?.workingDirectory));
  const sourceIsolationLaunch = isolationLaunches.find(launch => launch.sessionId === source.id);
  assert.ok(sourceIsolationLaunch);
  assert.equal(sourceIsolationLaunch.accountHome, undefined,
    "an actor launched with the provider's default account receives no Accounts home grant");
  terminals.applyProviderSignal(source.id, { kind: "lifecycle", state: "working" });

  const sourceContext = terminals.pluginContext(source.id);
  assert.ok(sourceContext?.environment);
  assert.equal(sourceContext.metadata.isolation?.state, "on");
  assert.equal(sourceContext.metadata.isolation?.layer, "seatbelt");
  assert.equal(sourceContext.metadata.profile, "acceptEdits");
  const sourceRef = sourceContext.environment.ref;
  assert.equal(sourceRef.repo, project);
  assert.notEqual(sourceRef.dir, project);
  await writeFile(join(sourceRef.dir, "task.txt"), "worktree edits survive handoff\n");
  assert.equal(await readFile(join(project, "task.txt"), "utf8"), "project baseline\n");
  assert.equal(git("rev-parse", "HEAD"), projectHead);

  pluginSessions.activity({ type: "limit.exhausted", accountId: "default", sessionId: source.id, provider: "codex", at: Date.now() });
  await waitFor(() => cards.decorations().badges[source.id]?.some(badge => badge.pluginId === accountsId && badge.text === "quota: handoff"));
  const sourceSummary = () => pluginSessions.summary(source.id);
  const rawInvocation = {
    actionId: "handoff",
    sessionId: source.id,
    session: sourceSummary()
  };

  await assert.rejects(
    supervisor.hostCall(accountsId, accountsService.id, "canvastty.cards.invoke", rawInvocation, 15_000),
    /Handoff requires the person's Handoff card action/u,
    "a direct service request without the host card-action consent cannot start a replacement"
  );
  assert.ok(terminals.pluginContext(source.id), "a rejected unconsented request leaves the source actor running");
  assert.equal(killedPids.includes(ptyCalls[0].process.pid), false);
  assert.equal(cards.decorations().badges[source.id]?.some(badge => badge.text === "quota: handoff"), true,
    "the account's one-time quota offer remains available after the refused direct request");

  failNextIsolationLaunch = true;
  const failedHandoff = await cards.invoke(accountsId, "handoff", source.id);
  assert.equal(failedHandoff.tone, "error", "a refused replacement is surfaced to the person");
  const failedReplacement = terminalEvents.findLast(session => session.id !== source.id && session.status === "failed");
  assert.match(failedReplacement?.failureDetails ?? "", /fixture isolation launch failure/u,
    "the first replacement fails inside the real isolation wrapper before any PTY starts");
  assert.ok(terminals.pluginContext(source.id), "a failed replacement leaves the original actor alive");
  assert.equal(killedPids.includes(ptyCalls[0].process.pid), false, "a failed replacement does not stop the source PTY");
  assert.equal(await readFile(join(sourceRef.dir, "task.txt"), "utf8"), "worktree edits survive handoff\n",
    "a failed replacement preserves source worktree edits");
  assert.equal(await readFile(join(project, "task.txt"), "utf8"), "project baseline\n");
  assert.equal(git("rev-parse", "HEAD"), projectHead);
  assert.equal(cards.decorations().badges[source.id]?.some(badge => badge.text === "quota: handoff"), true,
    "a failed handoff keeps the quota offer available for a retry");

  const handoffResult = await cards.invoke(accountsId, "handoff", source.id);
  assert.equal(handoffResult.tone, "info", handoffResult.message);
  assert.match(handoffResult.message ?? "", /Started a replacement with alternate/u);
  assert.ok(handoffResult.message?.includes("masked summary"));

  await waitFor(() => terminals.listMetadata().some(session => session.id !== source.id
    && ptyCalls.some(call => call.options.cwd === sourceRef.dir && call.command === SANDBOX_EXEC)));
  const replacement = terminals.listMetadata().find(session => session.id !== source.id);
  assert.ok(replacement, "the replacement card was created");
  await waitFor(() => launchCalls.some(call => call.method === "canvastty.launch.prepare"
    && call.params.sessionId === replacement.id && call.params.options.account === "alternate"));
  const replacementContext = terminals.pluginContext(replacement.id);
  assert.ok(replacementContext?.environment);
  assert.equal(replacementContext.metadata.cwd, sourceRef.dir, "the replacement CLI starts in the original worktree folder");
  assert.equal(replacementContext.workingDirectory, sourceContext.workingDirectory);
  assert.deepEqual(replacementContext.environment, sourceContext.environment,
    "the new card owns the exact environment ref; no second worktree was created");
  assert.deepEqual(replacementContext.metadata.taskScope, sourceContext.metadata.taskScope,
    "the replacement inherits the original project task scope");
  assert.equal(replacementContext.metadata.isolation?.state, "on");
  assert.equal(replacementContext.metadata.isolation?.layer, "seatbelt");
  const replacementIsolationLaunch = isolationLaunches.find(launch => launch.sessionId === replacement.id);
  assert.equal(replacementIsolationLaunch?.accountHome, join(accountsData, "homes", "codex-alternate"),
    "only the selected alternate account's exact home is granted to the replacement");
  assert.equal(replacementIsolationLaunch?.networkProjectRoot, project,
    "the replacement keeps the original project as its policy root despite the worktree cwd");
  assert.equal(ptyCalls.filter(call => call.options.cwd === sourceRef.dir).length, 2,
    "both the original and its replacement were launched in the same worktree");
  assert.equal(environmentCalls.filter(call => call.method === "canvastty.environment.prepare").length, 1,
    "handoff reuses the prepared worktree instead of asking the environment plugin for another");
  const wraps = environmentCalls.filter(call => call.method === "canvastty.environment.wrap");
  assert.deepEqual(wraps.map(call => call.params.sessionId), [source.id, failedReplacement.id, replacement.id],
    "each launch uses the already prepared environment before isolation, including the refused replacement");
  assert.ok(wraps.every(call => JSON.stringify(call.params.ref) === JSON.stringify(sourceRef)),
    "every wrap uses the original worktree ref");
  assert.equal(environmentCalls.filter(call => call.method === "canvastty.environment.resume").length, 0,
    "borrowing the current environment does not resume or prepare it again");
  assert.equal(ptyCalls.at(-1).command, SANDBOX_EXEC, "the replacement goes through macOS's real AgentIsolation wrapper");
  assert.ok(networkRoots.every(path => path === project), `expected task-root isolation decisions: ${JSON.stringify(networkRoots)}`);

  const launchSelection = await readFile(join(accountsData, "session-account-selections.json"), "utf8");
  assert.match(launchSelection, new RegExp(`"${replacement.id}":"alternate"`, "u"),
    "the actual accounts service prepares and remembers the selected alternate account");
  assert.equal(writes.some(write => write.cwd === sourceRef.dir && write.data.includes("Continue this task:")), true,
    "the host delivered the bounded continuation summary before disposing the source");
  const handoffWriteIndex = lifecycle.findIndex(event => event.type === "write"
    && event.pid === ptyCalls[1].process.pid && event.cwd === sourceRef.dir && event.data.includes("Continue this task:"));
  const sourceKillIndex = lifecycle.findIndex(event => event.type === "kill" && event.pid === ptyCalls[0].process.pid);
  assert.ok(handoffWriteIndex >= 0 && sourceKillIndex > handoffWriteIndex,
    "the source PTY is killed only after the replacement accepts the continuation prompt");
  assert.equal(lifecycle.some(event => event.type === "write" && event.pid === ptyCalls[0].process.pid
    && event.data.includes("Continue this task:")), false, "the handoff prompt never goes to the old actor");
  assert.equal(terminals.pluginContext(source.id), null, "the old actor is stopped after delivery succeeds");
  assert.equal(killedPids.includes(ptyCalls[0].process.pid), true, "the old PTY was stopped only after replacement delivery");
  assert.equal(await readFile(join(sourceRef.dir, "task.txt"), "utf8"), "worktree edits survive handoff\n",
    "the source worktree's unmerged edits remain intact and visible to the replacement");
  assert.equal(await readFile(join(project, "task.txt"), "utf8"), "project baseline\n",
    "handoff never copies the worktree edit into the checked-out project");
  assert.equal(git("rev-parse", "HEAD"), projectHead, "handoff does not merge or commit anything");
});
