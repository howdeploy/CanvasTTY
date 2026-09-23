import { accountRouteBinding } from '../src/shared/providerAccountPolicy.ts';
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { TerminalManager } from "./helpers/delegation-test-manager.mjs";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { SessionLaunchPolicy } from "../src/main/services/SessionLaunchPolicy.ts";
import { SettingsStore, normalizeSettings, normalizeProviderAccounts } from "../src/main/services/SettingsStore.ts";
import { dataClassForPath, accountSupportsModel, isValidRemoteHost } from "../src/shared/contracts.ts";
import { validateOrchestrationArguments } from "../src/agent-browser/orchestration-catalog.mjs";

const budgets = { maxLocalAgents: 4, maxRemoteAgentsPerHost: 4, maxChildren: 4, maxDepth: 2 };
function fixture(extra = {}) {
  let settings = { defaultDataClass: "D0", providerAccounts: [], pathPolicies: [], remoteHosts: [], agentBudgets: budgets, ...extra };
  const calls = [], exits = [], written = [];
  const registry = { get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }) };
  const terminals = new TerminalManager(() => {}, registry, undefined, undefined, true, (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: calls.length, write: (data) => written.push(data), kill() {}, pause() {}, resume() {}, resize() {}, onData() { return { dispose() {} }; }, onExit(callback) { exits.push(callback); return { dispose() {} }; } };
  });
  terminals.configureRemoteHosts((id) => settings.remoteHosts.find((host) => host.id === id) ?? null);
  terminals.configureLaunchPolicy(new SessionLaunchPolicy(() => settings, { repositoryRoot: () => process.cwd() }));
  return { terminals, calls, exits, written, control: new AgentControlService(terminals), update: (patch) => { settings = { ...settings, ...patch }; } };
}
const request = (extra = {}) => ({ provider: "codex", cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 }, ...extra });

test("MCP accepts launch policy fields and passes them to the created session", async () => {
  const args = { provider: "codex", cwd: process.cwd(), model: "gpt-test", accountId: "private", dataClass: "D1", profile: "yolo", allowSubagents: true };
  assert.equal(validateOrchestrationArguments("spawn_agent", args).ok, true);
  for (const dataClass of ["D9", null, 1]) assert.equal(validateOrchestrationArguments("spawn_agent", { ...args, dataClass }).ok, false);
  const { terminals, control } = fixture({ providerAccounts: [{ id: "private", provider: "codex", label: "Private" }] });
  const parent = terminals.create(request({ role: "orchestrator" }));
  const created = await new ScopedOrchestrationHandler(control).execute(parent.id, { tool: "spawn_agent", arguments: args });
  const child = control.status(created.sessionId);
  for (const field of ["model", "accountId", "dataClass", "profile", "allowSubagents"]) assert.equal(child[field], args[field]);
  assert.equal(child.role, "subagent");
  terminals.disposeAll();
});

test("launch policy reads live settings for create, restart and deferred Grok launch", () => {
  const { terminals, update, exits, calls } = fixture();
  const child = terminals.create(request());
  const grok = terminals.create(request({ provider: "grok" }));
  exits[0]({ exitCode: 0 });
  update({ pathPolicies: [{ pattern: "**", dataClass: "D2" }] });
  assert.throws(() => terminals.create(request()), /at most D1/u);
  assert.throws(() => terminals.restart(child.id), /at most D1/u);
  terminals.resize(grok.id, 80, 24);
  assert.equal(terminals.list().find((session) => session.id === grok.id).status, "failed");
  assert.equal(calls.length, 1);
  terminals.disposeAll();
});

test("explicit hosts obey class, provider allowlist and maxSessions", () => {
  const base = { id: "remote", label: "Remote", sshHost: "remote.invalid", workspaces: [{ localPath: process.cwd(), remotePath: "/workspace" }] };
  const { terminals, update, calls } = fixture({ remoteHosts: [{ ...base, maxDataClass: "D0" }] });
  assert.throws(() => terminals.create(request({ hostId: "remote", dataClass: "D1" })), /host.*D0/iu);
  update({ remoteHosts: [{ ...base, providerAccess: { mode: "allowlist", providers: ["claude"] } }] });
  assert.throws(() => terminals.create(request({ hostId: "remote" })), /not allowed/u);
  update({ remoteHosts: [{ ...base, maxSessions: 1 }] });
  terminals.create(request({ hostId: "remote" }));
  assert.throws(() => terminals.create(request({ hostId: "remote" })), /limit/u);
  assert.equal(calls.length, 1);
  terminals.disposeAll();
});

test("account picker selects the first account satisfying model AND class", () => {
  const { terminals } = fixture({ maxAccountsPerProviderPerHost: 2, providerAccounts: [
    { id: "shared", provider: "devin", label: "Shared", models: ["devin*"], shared: true },
    { id: "private", provider: "devin", label: "Private", models: ["devin*"] }
  ] });
  const child = terminals.create(request({ provider: "devin", model: "devin-test", dataClass: "D2" }));
  assert.equal(child.accountId, "private");
  assert.throws(() => terminals.create(request({ dataClass: "D9" })), /data class/u);
  terminals.disposeAll();
});

test("concurrency counts active agents, excludes self on restart and releases completed children", async () => {
  const f = fixture({ agentBudgets: { ...budgets, maxLocalAgents: 2, maxChildren: 1 } });
  const parent = f.terminals.create(request({ role: "orchestrator" }));
  const pending = [];
  const control = new AgentControlService(f.terminals, { place: () => new Promise((resolve) => pending.push(resolve)) });
  const spawn = () => control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: process.cwd(), host: "auto" });
  const first = spawn(), second = spawn();
  pending.forEach((resolve) => resolve({ kind: "local", reason: "test" }));
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
  const child = results[0].value;
  f.exits[1]({ exitCode: 0 });
  assert.doesNotThrow(() => f.terminals.restart(child.id));
  f.exits[2]({ exitCode: 0 });
  assert.doesNotThrow(() => f.control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: process.cwd() }));
  f.terminals.disposeAll();
});

test("nested delegation is opt-in and enforces depth without changing ownership", async () => {
  const f = fixture({ agentBudgets: { ...budgets, maxLocalAgents: 8 } });
  const capabilities = [];
  f.terminals.configureOrchestration({ isEnabled: true, prepareLaunch: ({ terminalSessionId }) => { capabilities.push(terminalSessionId); return { environment: {}, cleanup() {} }; } });
  const parent = f.terminals.create(request({ role: "orchestrator" }));
  const spawn = (parentSessionId, allowSubagents) => f.control.spawn({ parentSessionId, provider: "codex", cwd: process.cwd(), allowSubagents });
  const leaf = spawn(parent.id);
  assert.equal(leaf.allowSubagents, false);
  assert.throws(() => spawn(leaf.id), /delegation.*disabled/iu);
  const child = spawn(parent.id, true);
  const grandchild = spawn(child.id, true);
  assert.equal(child.role, "subagent");
  assert.equal(grandchild.parentSessionId, child.id);
  assert.deepEqual(capabilities, [parent.id, child.id, grandchild.id]);
  assert.throws(() => spawn(grandchild.id), /depth/u);
  const handler = new ScopedOrchestrationHandler(f.control);
  await assert.rejects(handler.execute(child.id, { tool: "cancel_agent", arguments: { sessionId: parent.id } }));
  await assert.rejects(handler.execute(child.id, { tool: "cancel_agent", arguments: { sessionId: leaf.id } }));
  f.terminals.disposeAll();
});

test("Grok initial task waits for its deferred launch and enters argv exactly once", () => {
  // Freeform tasks now require D2 independently of the default/request class.
  const account = { id: 'grok-private', label: 'Private Grok', provider: 'grok' };
  account.assessment = { profile: { training: 'none', retention: 'bounded', thirdPartyProcessing: 'no', contractualMode: 'business' }, evidence: { kind: 'user-attested', reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: 'Explicit private route fixture', binding: accountRouteBinding(account), models: '*' } };
  const f = fixture({ providerAccounts: [account] });
  const parent = f.terminals.create(request({ role: "orchestrator" }));
  const child = f.control.spawn({ parentSessionId: parent.id, provider: "grok", cwd: process.cwd(), initialPrompt: "Please inspect the project" });
  assert.deepEqual(f.written, []);
  assert.throws(() => f.control.send(child.id, "x".repeat(131072)), /pending input/u);
  f.terminals.resize(child.id, 90, 30);
  assert.deepEqual(f.written, []);
  assert.equal(f.calls[1].args.at(-1), "CanvasTTY task:\nPlease inspect the project");
  f.terminals.resize(child.id, 100, 40);
  assert.deepEqual(f.written, []);
  assert.equal(f.calls[1].args.at(-1), "CanvasTTY task:\nPlease inspect the project");
  f.terminals.disposeAll();
});

test("anchored paths use an explicit repository root at any filesystem depth", () => {
  const policies = [{ pattern: "/src/core/**", dataClass: "D3" }];
  assert.equal(dataClassForPath(policies, "/Users/runner/projects/repo/src/core/x.ts", "D0", "/Users/runner/projects/repo"), "D3");
  assert.equal(dataClassForPath(policies, "/Users/runner/projects/other/src/core/x.ts", "D0", "/Users/runner/projects/repo"), "D0");
  assert.equal(dataClassForPath(policies, "/Users/runner/projects/repo/vendor/src/core/x.ts", "D0", "/Users/runner/projects/repo"), "D0");
  const f = fixture({ pathPolicies: policies });
  f.terminals.configureLaunchPolicy(new SessionLaunchPolicy(() => ({ defaultDataClass: "D0", pathPolicies: policies, remoteHosts: [], providerAccounts: [], agentBudgets: budgets }), { repositoryRoot: () => { throw new Error("cannot resolve root"); } }));
  assert.throws(() => f.terminals.create(request()), /resolve.*root/u);
  assert.equal(f.calls.length, 0);
});

test("corrupted and empty explicit account model allowlists never become unrestricted", () => {
  for (const models of [[], ["", 7], "broken"]) {
    const [account] = normalizeProviderAccounts([{ id: "a", provider: "codex", label: "A", models }], []);
    assert.ok(account, "retain a blocked account rather than falling back to ambient credentials");
    assert.deepEqual(account.models, []);
    assert.equal(accountSupportsModel(account, "any"), false);
    assert.equal(accountSupportsModel(account, undefined), false);
  }
});

test("an account remains bound to one host through explicit, auto and restart launches", async () => {
  const host = { id: "remote", label: "Remote", sshHost: "remote.invalid", workspaces: [{ localPath: process.cwd(), remotePath: "/workspace" }] };
  const f = fixture({ remoteHosts: [host], providerAccounts: [{ id: "bound", provider: "codex", label: "Bound", hostId: "remote" }] });
  const parent = f.terminals.create(request({ provider: "claude", role: "orchestrator" }));
  assert.throws(() => f.terminals.create(request({ accountId: "bound" })), /bound.*remote/iu);
  const control = new AgentControlService(f.terminals, { place: async (request) => { assert.deepEqual(request.eligibleHostIds, ["remote"]); return { kind: "remote", host, remoteWorkspace: "/workspace" }; } });
  const child = await control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: process.cwd(), host: "auto", accountId: "bound" });
  assert.equal(child.hostId, "remote");
  assert.equal(child.accountId, "bound");
  f.exits[1]({ exitCode: 0 });
  f.update({ providerAccounts: [{ id: "bound", provider: "codex", label: "Bound", hostId: "other" }] });
  assert.throws(() => f.terminals.restart(child.id), /bound.*other/iu);
  f.terminals.disposeAll();
});

test("configured account capacity is per provider per host and allows an explicit second account", () => {
  const accounts = [
    { id: "first", provider: "codex", label: "First" },
    { id: "second", provider: "codex", label: "Second" },
    { id: "claude", provider: "claude", label: "Claude" },
    { id: "grok", provider: "grok", label: "Grok" }
  ];
  const f = fixture({ providerAccounts: accounts, maxAccountsPerProviderPerHost: 1 });
  assert.throws(() => f.terminals.create(request({ accountId: "first" })), /account.*limit/iu);
  assert.doesNotThrow(() => f.terminals.create(request({ provider: "claude" })));
  f.update({ maxAccountsPerProviderPerHost: 2 });
  const session = f.terminals.create(request({ accountId: "first" }));
  f.exits[1]({ exitCode: 0 });
  assert.doesNotThrow(() => f.terminals.restart(session.id));
  f.terminals.disposeAll();
});

test("legacy multiple-host account bindings require explicit repair", () => {
  const [ambiguous] = normalizeProviderAccounts([{ id: "a", provider: "codex", label: "A", hostIds: ["one", "two"] }], []);
  assert.equal(ambiguous.bindingRequired, true);
  const [single] = normalizeProviderAccounts([{ id: "b", provider: "codex", label: "B", hostIds: ["one"] }], []);
  assert.equal(single.hostId, "one");
  const f = fixture({ providerAccounts: [ambiguous] });
  assert.throws(() => f.terminals.create(request({ accountId: "a" })), /binding.*repair/iu);
  assert.throws(() => f.terminals.create(request()), /binding.*repair/iu);
  assert.equal(f.calls.length, 0);
});

test("deferred sessions inherit a changed default class at the actual launch", () => {
  const f = fixture();
  const grok = f.terminals.create(request({ provider: "grok" }));
  f.update({ defaultDataClass: "D2" });
  f.terminals.resize(grok.id, 80, 24);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.terminals.list()[0].privacyNotice, { cap: "D1", dataClass: "D2" });
  assert.equal(f.terminals.list()[0].dataClass, "D2");
  f.terminals.disposeAll();
});


test("new budgets and account capacity settings migrate and persist", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-budget-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en");
  const initial = await store.load();
  assert.deepEqual(initial.agentBudgets, budgets);
  assert.equal(initial.maxAccountsPerProviderPerHost, 1);
  const changed = { maxLocalAgents: 6, maxRemoteAgentsPerHost: 3, maxChildren: 2, maxDepth: 3 };
  await store.update({ agentBudgets: changed, maxAccountsPerProviderPerHost: 2 });
  const restored = await new SettingsStore(directory, "en").load();
  assert.deepEqual(restored.agentBudgets, changed);
  assert.equal(restored.maxAccountsPerProviderPerHost, 2);
  const normalized = normalizeSettings({ agentBudgets: { maxLocalAgents: -1, maxDepth: 100 }, maxAccountsPerProviderPerHost: 20 }, initial);
  assert.deepEqual(normalized.agentBudgets, budgets);
  assert.equal(normalized.maxAccountsPerProviderPerHost, 1);
  const persisted = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  assert.deepEqual(persisted.agentBudgets, changed);
});

test("launch fields survive persistence and restore rechecks current account policy", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-policy-restore-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const account = { id: "private", provider: "codex", label: "Private" };
  const first = fixture({ providerAccounts: [account] });
  first.terminals.configureSessionPersistence(new TerminalSessionStore(directory), true);
  const created = first.terminals.create(request({ role: "orchestrator", model: "gpt-test", dataClass: "D1", accountId: "private", allowSubagents: true }));
  await first.terminals.shutdown();
  const restored = fixture({ defaultDataClass: "D2", providerAccounts: [account] });
  restored.terminals.configureSessionPersistence(new TerminalSessionStore(directory), true);
  await restored.terminals.restorePersistedSessions();
  const session = restored.terminals.list()[0];
  for (const field of ["id", "model", "accountId", "dataClass", "allowSubagents", "role"]) assert.equal(session[field], created[field]);
  assert.equal(restored.calls.length, 1, "explicit D1 remains explicit across restore");
  await restored.terminals.shutdown();
  const blocked = fixture({ providerAccounts: [{ ...account, maxDataClass: "D0" }] });
  blocked.terminals.configureSessionPersistence(new TerminalSessionStore(directory), true);
  await blocked.terminals.restorePersistedSessions();
  assert.equal(blocked.calls.length, 0);
  assert.equal(blocked.terminals.list()[0].status, "failed");
  assert.match(blocked.terminals.list()[0].failureDetails, /at most D0/u);
  await blocked.terminals.shutdown();
});

test("remote agent budget applies independently to each host", () => {
  const hosts = ["one", "two"].map((id) => ({ id, label: id, sshHost: `${id}.invalid`, workspaces: [{ localPath: process.cwd(), remotePath: "/workspace" }] }));
  const f = fixture({ remoteHosts: hosts, agentBudgets: { ...budgets, maxRemoteAgentsPerHost: 1 } });
  f.terminals.create(request({ hostId: "one" }));
  assert.throws(() => f.terminals.create(request({ hostId: "one" })), /concurrency limit/u);
  f.terminals.create(request({ hostId: "two" }));
  f.terminals.create(request());
  assert.equal(f.calls.length, 3);
  f.terminals.disposeAll();
});


test("canonical repository classification covers dot segments and symlinked cwd", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-real-policy-root-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", directory]);
  await mkdir(join(directory, "src", "core"), { recursive: true });
  await symlink(join(directory, "src", "core"), join(directory, "alias"));
  const settings = { defaultDataClass: "D0", pathPolicies: [{ pattern: "/src/core/**", dataClass: "D2" }], remoteHosts: [], providerAccounts: [], agentBudgets: budgets, maxAccountsPerProviderPerHost: 1 };
  const f = fixture();
  f.terminals.configureLaunchPolicy(new SessionLaunchPolicy(() => settings));
  for (const cwd of [`${directory}/./src/core`, join(directory, "alias")]) {
    assert.throws(() => f.terminals.create(request({ cwd })), /at most D1/u);
  }
  assert.equal(f.calls.length, 0);
  assert.doesNotThrow(() => f.terminals.create(request({ cwd: directory })));
  f.terminals.disposeAll();
});

test("legacy restored sessions keep inheriting live default classification", async () => {
  const f = fixture();
  const descriptor = { id: "legacy", provider: "codex", profile: "normal", title: "Legacy", titleCustomized: false, cwd: process.cwd(), position: { x: 0, y: 0 }, size: { width: 700, height: 430 } };
  f.terminals.configureSessionPersistence({ load: async () => [descriptor], replace: async () => {} }, true);
  await f.terminals.restorePersistedSessions();
  f.exits[0]({ exitCode: 0 });
  f.update({ defaultDataClass: "D2" });
  const restarted = f.terminals.restart("legacy");
  assert.equal(restarted.dataClass, "D2");
  assert.deepEqual(restarted.privacyNotice, { cap: "D1", dataClass: "D2" });
  f.terminals.disposeAll();
});

test("canceling a delegated branch disposes descendants without orphaning live agents", () => {
  const f = fixture();
  const parent = f.terminals.create(request({ role: "orchestrator" }));
  const child = f.control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: process.cwd(), allowSubagents: true });
  f.control.spawn({ parentSessionId: child.id, provider: "codex", cwd: process.cwd() });
  f.control.cancel(child.id);
  assert.deepEqual(f.terminals.list().map((session) => session.id), [parent.id]);
  f.terminals.disposeAll();
});

test("session persistence supports hundreds of bounded remote descriptors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-many-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = Array.from({ length: 520 }, (_, index) => ({ id: `agent-${index}`, provider: "codex", profile: "normal", title: `Agent ${index}`, titleCustomized: false, cwd: process.cwd(), position: { x: 0, y: 0 }, size: { width: 700, height: 430 }, hostId: `host-${index}` }));
  await new TerminalSessionStore(directory).replace(sessions);
  const restored = await new TerminalSessionStore(directory).load();
  assert.equal(restored.length, 512);
  assert.equal(restored[199].hostId, "host-199");
});


test("local and auto are reserved selectors, never remote host identities", () => {
  for (const id of ["local", "auto"]) {
    const host = { id, label: "Reserved", sshHost: "remote.invalid", workspaces: [{ localPath: process.cwd(), remotePath: "/workspace" }] };
    assert.equal(isValidRemoteHost(host), false);
    const f = fixture({ remoteHosts: [host], providerAccounts: [{ id: "private", provider: "codex", label: "Private", hostId: "local" }] });
    assert.throws(() => f.terminals.create(request({ hostId: id, accountId: "private" })), /invalid|bound/u);
    assert.equal(f.calls.length, 0);
    assert.doesNotThrow(() => f.terminals.create(request({ accountId: "private" })));
    f.terminals.disposeAll();
  }
});

test("auto probes only a fixed account host and never falls back if it is unavailable", async () => {
  const bound = { id: "remote", label: "Remote", sshHost: "remote.invalid", workspaces: [{ localPath: process.cwd(), remotePath: "/workspace" }] };
  const f = fixture({ remoteHosts: [bound], providerAccounts: [{ id: "bound", provider: "codex", label: "Bound", hostId: "remote" }] });
  const parent = f.terminals.create(request({ provider: "claude", role: "orchestrator" }));
  const seen = [];
  const control = new AgentControlService(f.terminals, { place: async (value) => { seen.push(value); return { kind: "local", reason: "unreachable" }; } });
  await assert.rejects(async () => control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: process.cwd(), host: "auto", accountId: "bound" }), /unavailable|unreachable/iu);
  assert.deepEqual(seen[0].eligibleHostIds, ["remote"]);
  assert.equal(f.calls.length, 1);
  f.terminals.disposeAll();
});

test("auto chooses the account bound to the selected host, after model and class filtering", async () => {
  const hosts = ["busy", "idle"].map((id) => ({ id, label: id, sshHost: `${id}.invalid`, workspaces: [{ localPath: process.cwd(), remotePath: "/workspace" }] }));
  const accounts = [{ id: "first", provider: "codex", label: "First", hostId: "busy", models: ["allowed"] }, { id: "second", provider: "codex", label: "Second", hostId: "idle", models: ["allowed"] }, { id: "wrong-model", provider: "codex", label: "Wrong", hostId: "unprobed", models: ["different"] }];
  const f = fixture({ remoteHosts: hosts, providerAccounts: accounts });
  const parent = f.terminals.create(request({ provider: "claude", role: "orchestrator" }));
  let seen;
  const control = new AgentControlService(f.terminals, { place: async (value) => { seen = value; return { kind: "remote", host: hosts[1], remoteWorkspace: "/workspace" }; } });
  const child = await control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: process.cwd(), host: "auto", model: "allowed" });
  assert.deepEqual(seen.eligibleHostIds, ["busy", "idle"]);
  assert.equal(child.hostId, "idle");
  assert.equal(child.accountId, "second");
  f.terminals.disposeAll();
});

test("rebinding an account while it runs cannot spread it across two hosts", () => {
  const host = { id: "remote", label: "Remote", sshHost: "remote.invalid", workspaces: [{ localPath: process.cwd(), remotePath: "/workspace" }] };
  const account = { id: "bound", provider: "codex", label: "Bound" };
  const f = fixture({ remoteHosts: [host], providerAccounts: [account] });
  f.terminals.create(request({ accountId: "bound" }));
  f.update({ providerAccounts: [{ ...account, hostId: "remote" }] });
  assert.throws(() => f.terminals.create(request({ accountId: "bound", hostId: "remote" })), /account.*running.*host/iu);
  f.exits[0]({ exitCode: 0 });
  assert.equal(f.terminals.create(request({ accountId: "bound", hostId: "remote" })).hostId, "remote");
  f.terminals.disposeAll();
});

test("explicit MCP host cannot bypass dynamic resource preflight", async () => {
  const remote = { id: "remote", label: "Remote", sshHost: "remote.invalid", minFreeMemoryMb: 4096, workspaces: [{ localPath: process.cwd(), remotePath: "/workspace" }] };
  const f = fixture({ remoteHosts: [remote] });
  const parent = f.terminals.create(request({ provider: "claude", role: "orchestrator" }));
  let seen;
  const control = new AgentControlService(f.terminals, { place: async (value) => { seen = value; return { kind: "local", reason: "host resource constraints are not met" }; } });
  await assert.rejects(control.spawn({ parentSessionId: parent.id, provider: "codex", cwd: process.cwd(), host: "remote" }), /resource/u);
  assert.deepEqual(seen.eligibleHostIds, ["remote"]);
  assert.equal(f.calls.length, 1);
  f.terminals.disposeAll();
});
