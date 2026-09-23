import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionLaunchPolicy } from "../src/main/services/SessionLaunchPolicy.ts";
import { SettingsStore } from "../src/main/services/SettingsStore.ts";
import { ambientPrivacyDecision } from "../src/shared/ambientPrivacy.ts";
import { launchAccountId, launchOptions, launchPrivacyNotice, reconcileLaunchDraft } from "../src/renderer/src/features/launcher/launchDraft.ts";

const PROVIDERS = ["codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi", "cursor", "minimax", "devin", "antigravity"];

async function freshSettings(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-ambient-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SettingsStore(root, "ru-RU", "darwin");
  return store.load();
}

test("a fresh install launches every agent directly and records a warning instead of blocking", async t => {
  const settings = await freshSettings(t);
  assert.equal(settings.defaultDataClass, "D2");
  const policy = new SessionLaunchPolicy(() => settings);
  for (const provider of PROVIDERS) {
    const launch = policy.check({ provider, cwd: process.cwd(), profile: "normal" }, []);
    assert.equal(launch.dataClass, "D2", provider);
    if (provider === "devin" || provider === "antigravity") assert.equal(launch.privacyNotice, undefined, provider);
    else assert.equal(launch.privacyNotice?.dataClass, "D2", provider);
  }
  const withTask = policy.check({ provider: "claude", cwd: process.cwd(), profile: "normal", initialPrompt: "Fix the button" }, []);
  assert.deepEqual(withTask.privacyNotice, { cap: "D1", dataClass: "D2" });
});

test("delegation warns only under an orchestrator the person launched; explicit classes stay enforced", async t => {
  const settings = await freshSettings(t);
  const policy = new SessionLaunchPolicy(() => settings);
  const child = { provider: "claude", cwd: process.cwd(), profile: "normal", role: "subagent", parentSessionId: "parent", initialPrompt: "Review" };
  // A parent without the orchestrator choice carries no consent: the child is blocked.
  const unconsented = { id: "parent", provider: "codex", role: "interactive", exitCode: null, cwd: process.cwd(), profile: "normal" };
  assert.throws(() => policy.check(child, [unconsented]), /handles at most D1; this task is D2\. Choose an account/);
  // The person launched the root as an orchestrator: the typed-task floor warns, as for a direct launch.
  const orchestrator = { ...unconsented, allowSubagents: true };
  assert.deepEqual(policy.check(child, [orchestrator]).privacyNotice, { cap: "D1", dataClass: "D2" });
  // Consent follows the chain only through sessions that may delegate, up to a root without a parent.
  const middle = { id: "middle", provider: "codex", role: "subagent", parentSessionId: "parent", allowSubagents: true, exitCode: null, cwd: process.cwd(), profile: "normal" };
  assert.ok(policy.check({ ...child, parentSessionId: "middle" }, [orchestrator, middle]).privacyNotice);
  assert.throws(() => policy.check({ ...child, parentSessionId: "middle" }, [orchestrator, { ...middle, allowSubagents: false }]), /handles at most D1/);
  assert.throws(() => policy.check({ ...child, parentSessionId: "gone" }, [orchestrator]), /handles at most D1/);
  // Agent-originated prompts into a consented child warn too; explicit higher classes still block.
  assert.ok(policy.check({ ...child, id: "c", initialPrompt: "next", automated: true }, [orchestrator]).privacyNotice);
  assert.throws(() => policy.check({ ...child, dataClass: "D3" }, [orchestrator]), /handles at most D1; this task is D3/);
  assert.throws(() => policy.check({ provider: "claude", cwd: process.cwd(), profile: "normal", dataClass: "D3" }, []), /handles at most D1; this task is D3/);

  const lowered = { ...settings, defaultDataClass: "D1" };
  const permissive = new SessionLaunchPolicy(() => lowered);
  const quiet = permissive.check({ provider: "claude", cwd: process.cwd(), profile: "normal", role: "subagent", parentSessionId: "parent" }, [orchestrator]);
  assert.equal(quiet.privacyNotice, undefined);
});

test("the notice clears when a later check no longer exceeds the estimate", async t => {
  const settings = await freshSettings(t);
  let current = settings;
  const policy = new SessionLaunchPolicy(() => current);
  const metadata = { provider: "claude", cwd: process.cwd(), profile: "normal" };
  Object.assign(metadata, policy.check(metadata, []));
  assert.ok(metadata.privacyNotice);
  current = { ...settings, defaultDataClass: "D1" };
  Object.assign(metadata, policy.check({ ...metadata, dataClass: undefined }, []));
  assert.equal(metadata.privacyNotice, undefined);
});

test("shared rule: only implicit defaults warn; delegated or explicitly raised classes block", () => {
  assert.equal(ambientPrivacyDecision({ provider: "claude", dataClass: "D1", defaultDataClass: "D2", delegated: false }).kind, "allow");
  assert.equal(ambientPrivacyDecision({ provider: "claude", dataClass: "D2", defaultDataClass: "D2", delegated: false }).kind, "warn");
  assert.equal(ambientPrivacyDecision({ provider: "claude", dataClass: "D2", defaultDataClass: "D0", initialPrompt: "task", delegated: false }).kind, "warn");
  assert.equal(ambientPrivacyDecision({ provider: "claude", dataClass: "D2", defaultDataClass: "D0", delegated: false }).kind, "block");
  assert.equal(ambientPrivacyDecision({ provider: "claude", dataClass: "D2", defaultDataClass: "D2", delegated: true }).kind, "block");
});

test("the launcher allows the default direct launch and shows the same warning", async t => {
  const settings = await freshSettings(t);
  const draft = { ...reconcileLaunchDraft(null, "claude", settings), cwd: process.cwd() };
  const options = launchOptions(draft, settings);
  assert.equal(options.provider, "claude");
  assert.deepEqual(launchPrivacyNotice(options, settings), { cap: "D1", dataClass: "D2" });
  assert.throws(() => launchOptions({ ...draft, dataClass: "D3" }, settings), /handles at most D1/);
});

test("a typed task still only warns when the session is rechecked before spawn, restarted or restored", async t => {
  const { TerminalManager } = await import("./helpers/delegation-test-manager.mjs");
  const { normalizePersistedTerminalSessions, persistedTerminalSession } = await import("../src/main/services/TerminalSessionStore.ts");
  const settings = { ...(await freshSettings(t)), defaultDataClass: "D0" };
  const calls = [], exits = [];
  const registry = { get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }) };
  const terminals = new TerminalManager(() => {}, registry, undefined, undefined, true, (command, args) => {
    calls.push({ command, args });
    return { pid: calls.length, write() {}, kill() {}, pause() {}, resume() {}, resize() {}, onData() { return { dispose() {} }; }, onExit(callback) { exits.push(callback); return { dispose() {} }; } };
  });
  terminals.configureLaunchPolicy(new SessionLaunchPolicy(() => settings, { repositoryRoot: () => process.cwd() }));
  t.after(() => terminals.disposeAll());
  const request = { cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 }, initialPrompt: "Create calc.py" };

  // Grok starts only after the grid is measured, so its launch is rechecked without the typed text.
  const grok = terminals.create({ ...request, provider: "grok" });
  terminals.resize(grok.id, 80, 24);
  const started = terminals.list().find((session) => session.id === grok.id);
  assert.notEqual(started.status, "failed", started.failureDetails);
  assert.deepEqual(started.privacyNotice, { cap: "D1", dataClass: "D2" });
  assert.equal(started.taskPromptFloor, true);

  const opencode = terminals.create({ ...request, provider: "opencode" });
  exits.at(-1)({ exitCode: 0 });
  assert.doesNotThrow(() => terminals.restart(opencode.id));

  // The flag survives persistence and marks delegated children with a task too; their consent is
  // decided separately by the delegation chain.
  const persisted = persistedTerminalSession(terminals.list().find((session) => session.id === opencode.id));
  assert.equal(persisted.taskPromptFloor, true);
  const restored = normalizePersistedTerminalSessions({ version: 1, sessions: [JSON.parse(JSON.stringify(persisted))] });
  assert.equal(restored.sessions[0]?.taskPromptFloor, true);
  assert.equal(normalizePersistedTerminalSessions({ version: 1, sessions: [{ ...persisted, taskPromptFloor: "yes" }] }).sessions.length, 0);
  const orchestrator = terminals.create({ ...request, provider: "opencode", initialPrompt: undefined, role: "orchestrator" });
  const child = terminals.create({ ...request, provider: "devin", role: "subagent", parentSessionId: orchestrator.id });
  assert.equal(terminals.list().find((session) => session.id === child.id)?.taskPromptFloor, true);
});

test("a consented subagent with a task survives the pre-spawn recheck; an unconsented one does not start", async t => {
  const { TerminalManager } = await import("./helpers/delegation-test-manager.mjs");
  const settings = { ...(await freshSettings(t)), defaultDataClass: "D0" };
  const calls = [];
  const registry = { get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: { PATH: "/usr/bin" }, checked: [] }) };
  const terminals = new TerminalManager(() => {}, registry, undefined, undefined, true, (command, args) => {
    calls.push({ command, args });
    return { pid: calls.length, write() {}, kill() {}, pause() {}, resume() {}, resize() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
  });
  terminals.configureLaunchPolicy(new SessionLaunchPolicy(() => settings, { repositoryRoot: () => process.cwd() }));
  t.after(() => terminals.disposeAll());
  const base = { cwd: process.cwd(), profile: "normal", position: { x: 0, y: 0 } };
  const orchestrator = terminals.create({ ...base, provider: "opencode", allowSubagents: true });
  // Grok waits for the measured grid, so its first start goes through the recheck without the task text.
  const child = terminals.create({ ...base, provider: "grok", role: "subagent", parentSessionId: orchestrator.id, initialPrompt: "Create sub.txt" });
  terminals.resize(child.id, 80, 24);
  const started = terminals.list().find((session) => session.id === child.id);
  assert.notEqual(started.status, "failed", started.failureDetails);
  assert.deepEqual(started.privacyNotice, { cap: "D1", dataClass: "D2" });
  const plain = terminals.create({ ...base, provider: "opencode" });
  assert.throws(() => terminals.create({ ...base, provider: "grok", role: "subagent", parentSessionId: plain.id, initialPrompt: "Create sub.txt" }), /handles at most D1|Parent session cannot delegate|delegat/i);
});

test("a signed-in CLI account without a reviewed assessment warns like the CLI login; its own limit, sharing and delegation still block", async t => {
  const settings = await freshSettings(t);
  const account = { id: "main", provider: "claude", label: "Main", hostId: "local", binding: { kind: "cli-home", directory: "/tmp/claude-main" }, maxDataClass: "D3" };
  let current = { ...settings, providerAccounts: [account] };
  const policy = new SessionLaunchPolicy(() => current);
  const direct = { provider: "claude", cwd: process.cwd(), profile: "normal", initialPrompt: "Fix the button" };
  // Picked automatically or explicitly, the account starts the typed task with the same warning as the CLI login.
  for (const request of [direct, { ...direct, accountId: "main" }, { provider: "claude", cwd: process.cwd(), profile: "normal" }]) {
    const launch = policy.check(request, []);
    assert.equal(launch.accountId, "main");
    assert.deepEqual(launch.privacyNotice, { cap: "D1", dataClass: "D2" });
  }
  // An explicitly raised class, the person's own lower limit and a shared account still block.
  assert.throws(() => policy.check({ ...direct, dataClass: "D3" }, []), /Account Main handles at most D1; this task is D3/);
  current = { ...settings, providerAccounts: [{ ...account, maxDataClass: "D1" }] };
  assert.throws(() => policy.check(direct, []), /Account Main handles at most D1; this task is D2/);
  current = { ...settings, providerAccounts: [{ ...account, shared: true }] };
  assert.throws(() => policy.check(direct, []), /Account Main handles at most D1; this task is D2/);
  // Delegation keeps the orchestrator consent rule.
  current = { ...settings, providerAccounts: [account] };
  const child = { ...direct, role: "subagent", parentSessionId: "parent" };
  const parent = { id: "parent", provider: "codex", role: "interactive", exitCode: null, cwd: process.cwd(), profile: "normal" };
  assert.throws(() => policy.check(child, [parent]), /Account Main handles at most D1; this task is D2/);
  assert.deepEqual(policy.check(child, [{ ...parent, allowSubagents: true }]).privacyNotice, { cap: "D1", dataClass: "D2" });
  // The launcher uses the only account without a separate choice and reaches the same decision.
  const draft = { ...reconcileLaunchDraft(null, "claude", current), cwd: process.cwd(), initialPrompt: "Fix the button" };
  assert.equal(launchAccountId(draft, current), "main");
  const options = launchOptions(draft, current);
  assert.equal(options.accountId, "main");
  assert.deepEqual(launchPrivacyNotice(options, current), { cap: "D1", dataClass: "D2" });
  assert.throws(() => launchOptions({ ...draft, dataClass: "D3" }, current), /Account Main handles at most D1; this task is D3/);
});
