import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import { availableRegistry, fakeSpawner } from "./helpers/terminal.mjs";
const target = { id: "local", label: "My CLI", provider: "codex", accountId: "default", maxDataClass: "D3" };
const request = extra => ({ provider: "codex", profile: "normal", cwd: tmpdir(), position: { x: 0, y: 0 }, ...extra });
function fixture(t) {
  let policy = { enabled: true, defaultDataClass: "D2", targets: [target] };
  const calls = [];
  const m = new TerminalManager(() => {
  }, availableRegistry(), undefined, undefined, false, fakeSpawner(calls));
  m.configureExecutionPolicy(() => policy);
  t.after(() => m.disposeAll());
  return { m, calls, set: p => policy = p };
}
test("execution target denies unknown routes before any PTY and permits exact native configuration", t => {
  const f = fixture(t);
  assert.throws(() => f.m.create(request({ provider: "opencode" })), /execution target/i);
  assert.equal(f.calls.length, 0);
  f.m.create(request());
  assert.equal(f.calls.length, 1);
});
test("target revocation prevents new input but preserves interrupt", t => {
  const f = fixture(t);
  const s = f.m.create(request());
  f.set({ enabled: true, defaultDataClass: "D2", targets: [] });
  assert.equal(f.m.inputChecked(s.id, "secret"), false);
  assert.equal(f.m.inputChecked(s.id, "\x03"), true);
});
test("plugin roots cannot lower the person classification and explicit models cannot widen target", t => {
  const f = fixture(t);
  f.set({ enabled: true, defaultDataClass: "D3", targets: [{ ...target, maxDataClass: "D2" }] });
  assert.throws(() => f.m.create(request(), { origin: "plugin", ownerPluginId: "fixture" }), /execution target/i);
  f.set({ enabled: true, defaultDataClass: "D2", targets: [target] });
  assert.throws(() => f.m.create(request({ model: "other" })), /execution target/i);
});
import { normalizeExecutionPolicy, publicEndpoint } from "../src/shared/executionPolicy.ts";
import { TerminalSessionStore } from "../src/main/services/TerminalSessionStore.ts";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { ScopedOrchestrationHandler } from "../src/main/services/agent-browser/OrchestrationTools.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
const tick = () => new Promise(r => setTimeout(r, 15));
const choice = { pluginId: "fixture", kind: "remote", options: { host: "fixture.invalid", optional: "" } };
function environment(f, prepare) {
  const events = [];
  f.m.configureEnvironments({ available: () => true, normalizeChoice: (_p, c) => c, prepare: async (p) => {
      events.push("prepare");
      return prepare ? prepare(p) : { ok: true, environment: { pluginId: "fixture", kind: "remote", label: "Fixture", ref: {} } };
    }, resume: async () => {
      events.push("resume");
      return { ok: true };
    }, wrap: async (_e, p) => {
      events.push("wrap");
      return { ok: true, ...p.launch, secrets: [] };
    }, release: async () => {
      events.push("release");
    }, describe: async () => ({}), keeps: () => ({ launch: true, isolated: true }) });
  return events;
}
test("malformed/duplicate policies fail closed; endpoint metadata cannot contain secrets", () => {
  assert.equal(normalizeExecutionPolicy(undefined).enabled, false);
  for (const v of [null, {}, { enabled: false, defaultDataClass: "D2", targets: [target, target] }, { enabled: false, defaultDataClass: "D2", targets: [{ ...target, environment: { ...choice, options: { password: "no" } } }] }])
    assert.deepEqual(normalizeExecutionPolicy(v), { enabled: true, defaultDataClass: "D3", targets: [] });
  assert.equal(publicEndpoint("api.example.test:8443"), "api.example.test:8443");
  assert.equal(publicEndpoint("https://user:secret@api.example.test"), undefined);
  assert.equal(normalizeExecutionPolicy({ enabled: true, defaultDataClass: "D2", targets: [{ ...target, environment: choice }] }).targets.length, 1);
});
test("revocation while environment prepares releases it and never wraps or spawns", async (t) => {
  const f = fixture(t);
  let release;
  const events = environment(f, () => new Promise(r => release = r));
  f.set({ enabled: true, defaultDataClass: "D2", targets: [{ ...target, environment: choice }] });
  const s = f.m.create(request({ environment: choice }));
  await Promise.resolve(); // contributed launches register cancellation ownership before invoking plugins
  assert.deepEqual(events, ["prepare"]);
  f.set({ enabled: true, defaultDataClass: "D2", targets: [] });
  release({ ok: true, environment: { pluginId: "fixture", kind: "remote", label: "Fixture", ref: {} } });
  await tick();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(events, ["prepare", "release"]);
  assert.match(f.m.getMetadata(s.id).failureDetails, /execution target/i);
});
test("cancel during prepare releases late placement and never starts a local fallback", async (t) => {
  const f = fixture(t);
  let release;
  const events = environment(f, () => new Promise(r => release = r));
  f.set({ enabled: true, defaultDataClass: "D2", targets: [{ ...target, environment: choice }] });
  const s = f.m.create(request({ environment: choice }));
  await Promise.resolve(); // reach the deferred prepare before cancelling its owner
  f.m.dispose(s.id);
  release({ ok: true, environment: { pluginId: "fixture", kind: "remote", label: "Fixture", ref: {} } });
  await tick();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(events, ["prepare", "release"]);
});
test("approved remote destination receives exact configuration and has no local protection evidence", async (t) => {
  const f = fixture(t);
  const events = environment(f);
  f.set({ enabled: true, defaultDataClass: "D2", targets: [{ ...target, environment: choice }] });
  const s = f.m.create(request({ environment: choice }));
  await tick();
  assert.equal(f.calls.length, 1, f.m.getMetadata(s.id).failureDetails);
  assert.deepEqual(events, ["prepare", "wrap"]);
  assert.equal(f.m.decisionExecutionProtection(s.id).state, "unverified");
});
test("public account route identity changes stop before environment preparation", async (t) => {
  const f = fixture(t);
  const events = environment(f);
  const a = { ...target, accountId: "fixture-account", inferenceModel: "fixture-model", endpoint: "api.fixture.invalid", accountKind: "api-key", environment: choice };
  const policy = { enabled: true, defaultDataClass: "D2", targets: [a] };
  f.set(policy);
  f.m.configureExecutionPolicy(() => policy, async () => ({ model: "new-model", endpoint: a.endpoint, kind: a.accountKind, state: "ready" }));
  f.m.configureLaunchPipeline({ normalizeOptions: (_p, o) => o, unavailable: () => [], prepare: async () => {
      throw Error("must not prepare");
    }, forgetSession: async () => {
    } });
  const s = f.m.create(request({ environment: choice, launchOptions: { "canvastty-accounts": { account: a.accountId } } }));
  await tick();
  assert.deepEqual(events, []);
  assert.equal(f.calls.length, 0);
  assert.match(f.m.getMetadata(s.id).failureDetails, /route.*changed/i);
});
test("D3 inherits through children and continuation and cannot route to D2 target", async (t) => {
  const f = fixture(t);
  f.set({ enabled: true, defaultDataClass: "D3", targets: [target] });
  const root = f.m.create(request({ role: "orchestrator" }));
  f.set({ enabled: true, defaultDataClass: "D0", targets: [target, { ...target, id: "weak", provider: "opencode", maxDataClass: "D2" }] });
  const control = new AgentControlService(f.m);
  assert.deepEqual(control.executionTargets(root.id).map(t => t.id), ["local"]);
  await assert.rejects(async () => control.spawn({ parentSessionId: root.id, provider: "opencode", cwd: tmpdir() }), /execution target/i);
  const replacement = f.m.create(request(), { origin: "plugin", ownerPluginId: "accounts", continueTaskFrom: root.id });
  assert.equal(f.m.executionDataClass(replacement.id), "D3");
  assert.deepEqual(f.m.strategyLaunchOptions(root.id, "assistant"), { dataClass: "D3", privacy: { version: 1, selected: "unresolved", floor: "D3" } });
});
test("orchestrator automatic routing receives only approved target candidates and forged results fail closed", async (t) => {
  const f = fixture(t);
  f.set({ enabled: true, defaultDataClass: "D3", targets: [target, { ...target, id: "other", model: "strong" }, { ...target, id: "forbidden", model: "cheap", maxDataClass: "D0" }] });
  const root = f.m.create(request({ role: "orchestrator" }));
  const control = new AgentControlService(f.m);
  let chosen = "other", seen;
  const h = new ScopedOrchestrationHandler(control, null, undefined, { router: { route: async (r) => {
        seen = r;
        return { candidateId: chosen, reason: "fixture" };
      } } });
  const child = await h.execute(root.id, { id: "1", tool: "spawn_agent", arguments: { provider: "codex", cwd: tmpdir(), executionTargetId: "auto" } });
  assert.deepEqual(seen.candidates.map(c => c.id), ["local", "other"]);
  assert.equal(f.m.getMetadata(child.sessionId).model, "strong");
  chosen = "forbidden";
  await assert.rejects(h.execute(root.id, { id: "2", tool: "spawn_agent", arguments: { provider: "codex", cwd: tmpdir(), executionTargetId: "auto" } }), /No permitted execution target/);
  assert.equal(f.calls.length, 2);
});
test("persisted approved native target resumes, legacy unknown target stays stopped", async (t) => {
  const f = fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "target-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TerminalSessionStore(dir);
  f.m.configureSessionPersistence(store, "continue");
  const s = f.m.create(request());
  await f.m.shutdown();
  const rows = await store.load();
  assert.equal(rows[0].executionClass, "D2");
  const g = fixture(t);
  g.m.configureSessionPersistence(store, "continue");
  await g.m.restorePersistedSessions();
  assert.equal(g.calls.length, 1);
  await g.m.shutdown();
  delete rows[0].executionAuthorization;
  await store.replace(rows);
  const h = fixture(t);
  h.m.configureSessionPersistence(store, "continue");
  await h.m.restorePersistedSessions();
  assert.equal(h.calls.length, 0);
  assert.match(h.m.getMetadata(s.id).failureDetails, /execution target/i);
});
test("automatic selection excludes unready account targets before asking Jev", async (t) => {
  const f = fixture(t);
  const a = { ...target, id: "account", accountId: "fixture-account", inferenceModel: "strong", endpoint: "api.fixture.invalid", accountKind: "api-key" };
  f.set({ enabled: true, defaultDataClass: "D2", targets: [target, a] });
  const root = f.m.create(request({ role: "orchestrator" }));
  let queried = 0;
  const h = new ScopedOrchestrationHandler(new AgentControlService(f.m), null, undefined, { accountCandidates: async () => [], router: { route: async () => {
        queried++;
        throw Error("must not see unavailable account");
      } } });
  const child = await h.execute(root.id, { id: "a", tool: "spawn_agent", arguments: { provider: "codex", cwd: tmpdir(), executionTargetId: "auto" } });
  assert.ok(child.sessionId);
  assert.equal(queried, 0);
  assert.equal(f.calls.length, 2);
});
test("contributed account destination is verified and revocation while prepare waits cleans it up", async (t) => {
  for (const mode of ["success", "changed", "revoked"]) {
    const f = fixture(t);
    let finish, cleanups = 0;
    const a = { ...target, id: "account", accountId: "fixture-account", inferenceModel: "fixture-model", endpoint: "api.fixture.invalid", accountKind: "api-key" };
    let policy = { enabled: true, defaultDataClass: "D2", targets: [a] };
    f.m.configureExecutionPolicy(() => policy, async () => ({ model: a.inferenceModel, endpoint: a.endpoint, kind: a.accountKind, state: "ready" }));
    f.m.configureLaunchPipeline({ normalizeOptions: (_p, o) => o, unavailable: () => [], forgetSession: async () => {
      }, prepare: () => new Promise(r => finish = r) });
    const s = f.m.create(request({ launchOptions: { "canvastty-accounts": { account: a.accountId } } }));
    await tick();
    if (mode === "revoked") {
      policy = { ...policy, targets: [] };
    }
    finish({ ok: true, args: [], env: {}, secrets: [], accountId: a.accountId, accountRoute: { model: a.inferenceModel, endpoint: a.endpoint, kind: a.accountKind }, apiDomains: [mode === "changed" ? "other.invalid" : a.endpoint], cleanup: async () => {
        cleanups++;
      } });
    await tick();
    assert.equal(f.calls.length, mode === "success" ? 1 : 0, f.m.getMetadata(s.id).failureDetails);
    if (mode !== "success") {
      assert.equal(cleanups, 1);
    }
  }
});

for (const change of [{ model: "changed" }, { endpoint: "api.fixture.invalid:9443" }, { kind: "ollama-cloud" }, null]) {
  test(`prepared Accounts identity rejects delayed change ${JSON.stringify(change)} and cleans up`, async t => {
    const f = fixture(t);
    const route = { model: "approved", endpoint: "api.fixture.invalid:8443", kind: "api-key" };
    const approved = { ...target, accountId: "fixture-account", inferenceModel: route.model, endpoint: route.endpoint, accountKind: route.kind };
    const policy = { enabled: true, defaultDataClass: "D2", targets: [approved] };
    f.m.configureExecutionPolicy(() => policy, async () => ({ ...route, state: "ready" }));
    let release, cleaned = 0;
    f.m.configureLaunchPipeline({ normalizeOptions: (_p, o) => o, unavailable: () => [], forgetSession: async () => {},
      prepare: () => new Promise(resolve => { release = resolve; }) });
    const session = f.m.create(request({ launchOptions: { "canvastty-accounts": { account: approved.accountId } } }));
    await tick();
    release({ ok: true, env: {}, envSources: {}, secrets: [], args: [], thirdPartyModel: true,
      accountId: approved.accountId, apiDomains: ["api.fixture.invalid"], ...(change ? { accountRoute: { ...route, ...change } } : {}), cleanup: async () => { cleaned++; } });
    await tick();
    assert.equal(f.calls.length, 0);
    assert.equal(cleaned, 1);
    assert.match(f.m.getMetadata(session.id).failureDetails, /account.*(route|destination)/i);
  });
}
test("host privacy retains Assistant default with a separate floor and conservative legacy class", async t => {
  const f = fixture(t);
  f.m.configureLaunchPipeline({ normalizeOptions: (_p, o) => o, unavailable: () => [], forgetSession: async () => {}, prepare: async () => ({ ok: true, env: {}, envSources: {}, secrets: [], args: [], thirdPartyModel: false, cleanup: async () => {} }) });
  const root = f.m.create(request({ launchOptions: { assistant: { dataClass: "default" } } }));
  const expected = { dataClass: "D3", privacy: { version: 1, selected: "default", floor: "D2" } };
  assert.deepEqual(f.m.strategyLaunchOptions(root.id, "assistant"), expected);
  assert.deepEqual(f.m.decisionLaunchOptions(root.id, "assistant"), expected);
});

test('unresolved Assistant default filters targets conservatively while Accounts without privacy preserves the core floor', t => {
  const f = fixture(t);
  f.m.configureLaunchPipeline({ normalizeOptions: (_p, o) => o, unavailable: () => [], forgetSession: async () => {}, prepare: async () => ({ ok: true, env: {}, envSources: {}, secrets: [], args: [], thirdPartyModel: false, cleanup: async () => {} }) });
  f.set({ enabled: true, defaultDataClass: 'D2', targets: [target, { ...target, id: 'D2', model: 'limited', maxDataClass: 'D2' }] });
  const root = f.m.create(request({ launchOptions: { assistant: { dataClass: 'default' } } }));
  assert.equal(f.m.executionDataClass(root.id), 'D2');
  assert.deepEqual(f.m.allowedExecutionTargets(root.id).map(t => t.id), ['local']);
  assert.throws(() => f.m.create(request({ parentSessionId: root.id, model: 'limited' }), { origin: 'subagent' }), /execution target/i);
  const accountFree = f.m.create(request({ launchOptions: { 'canvastty-accounts': { account: 'none' } } }));
  assert.deepEqual(f.m.allowedExecutionTargets(accountFree.id).map(t => t.id), ['local', 'D2']);
});

test('account-backed diff reviewers authorize the account rather than cleanup id and recheck preparation and spawn', async t => {
  const { createDiffOnlyReviewWorkspace } = await import('../src/main/services/DiffOnlyReviewWorkspace.ts');
  for (const mode of ['success', 'forbidden', 'revoked', 'changed', 'wrap-revoked']) {
    const f = fixture(t);
    const project = await mkdtemp(join(tmpdir(), 'authority-review-'));
    t.after(() => rm(project, { recursive: true, force: true }));
    const root = f.m.create(request({ cwd: project, role: 'orchestrator' }));
    const workspace = createDiffOnlyReviewWorkspace('+ fixture');
    t.after(() => workspace.cleanup());
    const account = { ...target, id: 'account', accountId: 'fixture', inferenceModel: 'approved', endpoint: 'api.fixture.invalid:8443', accountKind: 'api-key' };
    let policy = { enabled: true, defaultDataClass: 'D2', targets: [target, ...(mode === 'forbidden' ? [] : [account])] };
    f.m.configureExecutionPolicy(() => policy, async () => ({ model: account.inferenceModel, endpoint: account.endpoint, kind: account.accountKind, state: 'ready' }));
    let prepares = 0, cleanups = 0;
    f.m.configureLaunchPipeline({ normalizeOptions: (_p, o) => o, unavailable: () => [], forgetSession: async () => {}, prepare: async ctx => {
      prepares++;
      assert.equal(ctx.accountRouteEvidence, true);
      if (mode === 'revoked') policy = { ...policy, targets: [target] };
      return { ok: true, env: {}, envSources: {}, args: [], secrets: [], thirdPartyModel: false, accountId: account.accountId,
        accountRoute: { model: mode === 'changed' ? 'changed' : account.inferenceModel, endpoint: account.endpoint, kind: account.accountKind },
        apiDomains: ['api.fixture.invalid'], cleanup: async () => { cleanups++; } };
    } });
    f.m.configureIsolation({ containment: () => true, decide: ({ profile }) => ({ apply: true, profile, isolation: { state: 'on', layer: 'seatbelt' } }), wrap: launch => {
      if (mode === 'wrap-revoked') policy = { ...policy, targets: [target] };
      return { command: launch.command, args: launch.args, env: launch.env, cleanup() {} };
    } });
    const prepare = () => f.m.prepareReviewerAccount({ taskRootSessionId: root.id, provider: 'codex', workspace, launchOptions: { 'canvastty-accounts': { account: account.accountId } } });
    if (['forbidden', 'revoked', 'changed'].includes(mode)) {
      await assert.rejects(prepare(), /execution target|account route/i);
      assert.equal(prepares, mode === 'forbidden' ? 0 : 1);
      assert.equal(cleanups, mode === 'forbidden' ? 0 : 1);
    } else {
      const prepared = await prepare();
      assert.notEqual(prepared.id, account.accountId);
      const create = () => f.m.createReadOnlyReviewer({ taskRootSessionId: root.id, provider: 'codex', workspace, title: 'Review', account: prepared });
      if (mode === 'wrap-revoked') {
        assert.throws(create, /execution target/i);
        await prepared.contribution.cleanup();
        assert.equal(f.calls.length, 1);
        continue;
      }
      const reviewer = create();
      assert.equal(f.calls.length, mode === 'success' ? 2 : 1, reviewer.failureDetails);
      if (mode === 'success') assert.equal(reviewer.profile, 'plan');
    }
  }
});

test('restoring old authorization recomposes unresolved root privacy before any spawn', async t => {
  const f = fixture(t), dir = await mkdtemp(join(tmpdir(), 'privacy-restore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const limited = { ...target, maxDataClass: 'D2' };
  const policy = { enabled: true, defaultDataClass: 'D2', targets: [limited] };
  f.set(policy);
  const store = new TerminalSessionStore(dir);
  f.m.configureSessionPersistence(store, 'continue');
  const root = f.m.create(request());
  await f.m.shutdown();
  const rows = await store.load();
  rows[0].executionPrivacy = { assistant: 'default' };
  await store.replace(rows);
  const g = fixture(t); g.set(policy); g.m.configureSessionPersistence(store, 'continue');
  await g.m.restorePersistedSessions();
  assert.equal(g.calls.length, 0);
  assert.match(g.m.getMetadata(root.id).failureDetails, /execution target/i);
});

test('handoff keeps conservative target authorization separately from the inherited core floor', async t => {
  const f = fixture(t);
  f.m.configureLaunchPipeline({ normalizeOptions: (_p, o) => o, unavailable: () => [], forgetSession: async () => {}, prepare: async () => ({ ok: true, env: {}, envSources: {}, secrets: [], args: [], thirdPartyModel: false, cleanup: async () => {} }) });
  const limited = { ...target, id: 'limited', model: 'limited', maxDataClass: 'D2' };
  f.set({ enabled: true, defaultDataClass: 'D2', targets: [target, limited] });
  const root = f.m.create(request({ launchOptions: { assistant: { dataClass: 'default' } } }));
  const replacement = f.m.create(request({ model: 'limited' }));
  f.m.inheritTaskScope(root.id, replacement.id);
  assert.equal(f.m.executionDataClass(replacement.id), 'D2');
  assert.equal(f.m.inputChecked(replacement.id, 'private prompt'), false);
});
