import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlService } from "../src/main/services/AgentControlService.ts";
import { HostPlacementService } from "../src/main/services/HostPlacement.ts";
import { SettingsStore, normalizePathPolicies } from "../src/main/services/SettingsStore.ts";
import { TerminalManager } from "../src/main/services/TerminalManager.ts";
import {
  dataClassForPath,
  hostEffectiveMaxDataClass,
  isValidRemoteHost
} from "../src/shared/contracts.ts";

// Roadmap D5 (host confidentiality) + D6 (path policies): the effective
// ceiling of a task is min(provider tier, host ceiling), and within a repo a
// path's own class can only raise the task's tier, never lower it.

// --- D5: the host ceiling ------------------------------------------------------

test("hostEffectiveMaxDataClass: an explicit cap holds, an unlabeled host reads as D3", () => {
  const base = { id: "vps", label: "VPS", sshHost: "vps.example" };
  assert.equal(isValidRemoteHost(base), true);
  assert.equal(hostEffectiveMaxDataClass(base), "D3", "the operator's own machine is unrestricted");
  assert.equal(hostEffectiveMaxDataClass({ ...base, maxDataClass: "D3" }), "D3");
  assert.equal(hostEffectiveMaxDataClass({ ...base, maxDataClass: "D2" }), "D2");
  assert.equal(hostEffectiveMaxDataClass({ ...base, maxDataClass: "D0" }), "D0");
});

test("a RemoteHost maxDataClass outside D0-D3 invalidates the whole entry", () => {
  const base = { id: "vps", label: "VPS", sshHost: "vps.example" };
  assert.equal(isValidRemoteHost({ ...base, maxDataClass: "D9" }), false);
  assert.equal(isValidRemoteHost({ ...base, maxDataClass: 3 }), false);
  assert.equal(isValidRemoteHost({ ...base, maxDataClass: null }), false);
  assert.equal(isValidRemoteHost({ ...base, maxDataClass: "D1" }), true);
});

// --- D5: placement filtering by host class ------------------------------------

const WORKSPACE = "/Users/runner/project";

function host(id, extra = {}) {
  return { id, label: `Host ${id}`, sshHost: `${id}.internal.example`, ...extra };
}

function mapped(remotePath = "/remote/project", localPath = WORKSPACE) {
  return [{ localPath, remotePath }];
}

function reachableMetrics(hostId) {
  return {
    hostId,
    collectedAt: 1_000,
    reachable: true,
    load1: 0.5,
    cores: 8,
    memoryTotalMb: 16_384,
    memoryAvailableMb: 8_192,
    gpuVramTotalMb: null,
    gpuVramUsedMb: null
  };
}

function discoveryResult(hostId, installed = ["claude"]) {
  return {
    hostId,
    reachable: true,
    providers: installed.map((provider) => ({ provider, installed: true }))
  };
}

function healthySources(overrides = {}) {
  return {
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    activeSessions: () => 0,
    ...overrides
  };
}

function place(hosts, request, sources = healthySources()) {
  return new HostPlacementService(sources).place(hosts, request);
}

test("a host capped at D1 is excluded for a D2 request and serves the D1 one", async () => {
  const denied = await place(
    [host("eu-vps", { maxDataClass: "D1", workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE, dataClass: "D2" }
  );
  assert.deepEqual(denied, { kind: "local", reason: "no eligible host handles data class D2" });

  const allowed = await place(
    [host("eu-vps", { maxDataClass: "D1", workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE, dataClass: "D1" }
  );
  assert.equal(allowed.kind, "remote");
  assert.equal(allowed.host.id, "eu-vps");
});

test("a request without dataClass never filters by host class (backward compat)", async () => {
  const decision = await place(
    [host("any", { maxDataClass: "D0", workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "any");
});

test("the host class never participates in ranking", async () => {
  // Fully tied through every ranking key, differing only in ceiling: the id
  // tie-break decides, so the class is provably not a ranking key.
  const tied = await place(
    [
      host("zulu", { maxDataClass: "D1", workspaces: mapped() }),
      host("alpha", { maxDataClass: "D3", workspaces: mapped() })
    ],
    { provider: "claude", localWorkspace: WORKSPACE, dataClass: "D1" }
  );
  assert.equal(tied.kind, "remote");
  assert.equal(tied.host.id, "alpha");

  // A stricter-but-sufficient cap does not demote an otherwise better host:
  // the idle D1-capped host still beats the busy unrestricted one.
  const capped = await place(
    [
      host("tight", { maxDataClass: "D1", workspaces: mapped() }),
      host("open", { workspaces: mapped() })
    ],
    { provider: "claude", localWorkspace: WORKSPACE, dataClass: "D1" },
    healthySources({ activeSessions: (hostId) => (hostId === "tight" ? 0 : 3) })
  );
  assert.equal(capped.kind, "remote");
  assert.equal(capped.host.id, "tight");
});

test("the data-class stage reports after provider permission and before mapping", async () => {
  // One host fails at the provider-permission stage, one at the class stage:
  // the class stage is the deepest reached and names the class.
  const classStage = await place(
    [
      host("deny", { workspaces: mapped(), providerAccess: { mode: "allowlist", providers: ["qwen"] } }),
      host("capped", { maxDataClass: "D1", workspaces: mapped() })
    ],
    { provider: "claude", localWorkspace: WORKSPACE, dataClass: "D2" }
  );
  assert.deepEqual(classStage, { kind: "local", reason: "no eligible host handles data class D2" });

  // A host that survives the class stage but fails mapping reports mapping:
  // the class stage keeps its place in the chain.
  const mappingStage = await place(
    [
      host("capped", { maxDataClass: "D0", workspaces: mapped() }),
      host("elsewhere", { workspaces: mapped("/remote/other", "/Users/runner/unrelated") })
    ],
    { provider: "claude", localWorkspace: WORKSPACE, dataClass: "D1" }
  );
  assert.deepEqual(mappingStage, { kind: "local", reason: "workspace not mapped on any eligible host" });
});

// --- D6: the path-policy pattern matcher --------------------------------------

test("relative patterns match any path with the patterned ancestors", () => {
  const policies = [{ pattern: "docs/**", dataClass: "D1" }];
  assert.equal(dataClassForPath(policies, "docs/a/b.md", "D2"), "D1");
  assert.equal(dataClassForPath(policies, "/repo/docs/a.md", "D2"), "D1");
  assert.equal(dataClassForPath(policies, "./docs/guide.md", "D2"), "D1");
  assert.equal(dataClassForPath(policies, "/repo/vendor/docs", "D2"), "D1", "trailing ** spans zero segments");
  assert.equal(dataClassForPath(policies, "docstuff/a.md", "D2"), "D2", "segments are whole, not prefixes");
});

test("anchored patterns use an explicit repository root for absolute paths", () => {
  const policies = [{ pattern: "/src/core/**", dataClass: "D3" }];
  assert.equal(dataClassForPath(policies, "/repo/src/core/x.ts", "D1", "/repo"), "D3");
  assert.equal(dataClassForPath(policies, "/repo/src/core/deep/y.ts", "D1", "/repo"), "D3");
  assert.equal(dataClassForPath(policies, "src/core/x.ts", "D1"), "D3", "a repo-relative path anchors directly");
  assert.equal(dataClassForPath(policies, "/repo/vendor/src/core/x.ts", "D1", "/repo"), "D1", "two directories above the anchor never match");
  assert.equal(dataClassForPath(policies, "/repo/src/other/x.ts", "D1"), "D1");
});

test("single-segment stars stay inside the segment", () => {
  const env = [{ pattern: ".env*", dataClass: "D3" }];
  assert.equal(dataClassForPath(env, ".env", "D1"), "D3");
  assert.equal(dataClassForPath(env, ".env.local", "D1"), "D3");
  assert.equal(dataClassForPath(env, "/repo/.env", "D1"), "D3");
  assert.equal(dataClassForPath(env, "config/.env", "D1"), "D3");
  assert.equal(dataClassForPath(env, "env", "D1"), "D1");

  const anyEnv = [{ pattern: "*.env", dataClass: "D3" }];
  assert.equal(dataClassForPath(anyEnv, ".env", "D1"), "D3", "* spans zero characters within the segment");
  assert.equal(dataClassForPath(anyEnv, "prod.env", "D1"), "D3");
  assert.equal(dataClassForPath(anyEnv, "ops/prod.env", "D1"), "D3");
  assert.equal(dataClassForPath(anyEnv, "prod.env.local", "D1"), "D1", "the star never crosses into a later segment");
});

test("a leading ** spans any depth above the patterned directory", () => {
  const policies = [{ pattern: "**/deploy/**", dataClass: "D2" }];
  assert.equal(dataClassForPath(policies, "deploy/x.sh", "D0"), "D2");
  assert.equal(dataClassForPath(policies, "a/b/deploy/c/d.sh", "D0"), "D2");
  assert.equal(dataClassForPath(policies, "/repo/infra/deploy/k8s/x.yaml", "D0"), "D2");
  assert.equal(dataClassForPath(policies, "deploys/x.sh", "D0"), "D0", "segments match whole, not by prefix");
});

test("the first matching policy wins and later ones never override it", () => {
  const policies = [
    { pattern: "docs/**", dataClass: "D1" },
    { pattern: "docs/private/**", dataClass: "D3" }
  ];
  assert.equal(dataClassForPath(policies, "docs/a.md", "D2"), "D1");
  assert.equal(dataClassForPath(policies, "docs/private/k.md", "D2"), "D1", "the first match shadows the stricter later one");
});

test("no match falls back, and invalid inputs never throw", () => {
  const policies = [{ pattern: "docs/**", dataClass: "D1" }];
  assert.equal(dataClassForPath(policies, "src/main.ts", "D0"), "D0");
  assert.equal(dataClassForPath([], "docs/a.md", "D2"), "D2");
  assert.equal(dataClassForPath(policies, "", "D2"), "D2");
  assert.equal(dataClassForPath(policies, 42, "D0"), "D0");
  assert.equal(dataClassForPath(policies, null, "D0"), "D0");
  // A policy whose pattern violates the grammar never matches anything.
  assert.equal(dataClassForPath([{ pattern: "../keys/**", dataClass: "D3" }], "keys/x", "D0"), "D0");
  assert.equal(dataClassForPath([{ pattern: "a b", dataClass: "D3" }], "a b", "D0"), "D0");
});

// --- D6: settings persistence -------------------------------------------------

test("normalizePathPolicies round-trips a valid ordered table", () => {
  const policies = [
    { pattern: "/src/core/**", dataClass: "D3" },
    { pattern: ".env*", dataClass: "D3" },
    { pattern: "docs/**", dataClass: "D1" }
  ];
  assert.deepEqual(normalizePathPolicies(policies, []), policies);
  assert.deepEqual(normalizePathPolicies(undefined, policies), policies);
  assert.deepEqual(normalizePathPolicies("nope", []), []);
});

test("normalizePathPolicies drops invalid patterns and classes, duplicates, and overflow", () => {
  const kept = { pattern: "docs/**", dataClass: "D1" };
  assert.deepEqual(normalizePathPolicies([
    kept,
    { pattern: "../keys/**", dataClass: "D3" },
    { pattern: "src\\keys", dataClass: "D3" },
    { pattern: "docs/**", dataClass: "D3" },
    { pattern: "a b/**", dataClass: "D1" },
    { pattern: "ok/**", dataClass: "D9" },
    { pattern: "ok/**", dataClass: "confidential" },
    { pattern: "docs//**", dataClass: "D1" },
    { pattern: "docs/** ", dataClass: "D1" },
    null,
    "nope",
    { pattern: "x", dataClass: "D1" }
  ], []), [kept, { pattern: "x", dataClass: "D1" }]);
});

test("normalizePathPolicies holds at most 64 policies", () => {
  const many = Array.from({ length: 80 }, (_value, index) => ({
    pattern: `dir-${index}/**`,
    dataClass: "D1"
  }));
  const normalized = normalizePathPolicies(many, []);
  assert.equal(normalized.length, 64);
  assert.deepEqual(normalized[0], { pattern: "dir-0/**", dataClass: "D1" });
  assert.deepEqual(normalized[63], { pattern: "dir-63/**", dataClass: "D1" });
});

test("path policies persist through the settings store and settingsVersion reaches 24", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-pathpolicies-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory, "en");
  const loaded = await store.load();
  assert.deepEqual(loaded.pathPolicies, []);

  const policies = [{ pattern: ".env*", dataClass: "D3" }, { pattern: "docs/**", dataClass: "D1" }];
  await store.update({ pathPolicies: policies });
  const reloaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(reloaded.pathPolicies, policies);

  const persisted = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(persisted.settingsVersion, 24);
  assert.deepEqual(persisted.pathPolicies, policies);
});

test("legacy version-23 settings migrate to an empty policy table and persist version 24", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "canvastty-settings-pathpolicies-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "settings.json"), JSON.stringify({ settingsVersion: 23 }));
  const loaded = await new SettingsStore(directory, "en").load();
  assert.deepEqual(loaded.pathPolicies, []);
  const persisted = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(persisted.settingsVersion, 24);
});

// --- D5 + D6 in spawn: strictest-of(request, default, path) -------------------

function fakeSpawner(calls) {
  return (command, args, options) => {
    const process = {
      pid: 30_000 + calls.length,
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

function fixture(options, placement) {
  const calls = [];
  const terminals = new TerminalManager(
    () => undefined,
    availableRegistry(),
    undefined,
    undefined,
    true,
    fakeSpawner(calls)
  );
  const control = new AgentControlService(terminals, placement, options);
  return { calls, terminals, control };
}

function parentUnder(terminals) {
  return terminals.create({
    provider: "codex",
    cwd: process.cwd(),
    profile: "normal",
    position: { x: 0, y: 0 }
  });
}

// Two REAL workspaces (the terminal manager statSyncs the cwd): one the
// resolver leaves unclassified, one it holds at D3.
async function policyWorkspaces(t) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-pathclass-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = join(root, "docs-site");
  const restricted = join(root, "payments-core");
  await mkdir(open, { recursive: true });
  await mkdir(restricted, { recursive: true });
  return { open, restricted };
}

test("a pathClass resolver raises a restricted cwd past the provider ceiling", async (t) => {
  const { open, restricted } = await policyWorkspaces(t);
  const { calls, terminals, control } = fixture({
    defaultDataClass: "D1",
    pathClass: (cwd) => (cwd === restricted ? "D3" : null)
  });
  const parent = parentUnder(terminals);
  const before = calls.length;

  assert.throws(
    () => control.spawn({ parentSessionId: parent.id, provider: "qwen", cwd: restricted }),
    /Provider qwen handles at most D1; this task is D3\./u
  );
  assert.equal(calls.length, before, "the raised tier must block before anything launches");

  const child = control.spawn({ parentSessionId: parent.id, provider: "qwen", cwd: open });
  assert.equal(child.provider, "qwen");
  assert.equal(calls.length, before + 1);
  terminals.disposeAll();
});

test("a resolver answering null leaves the effective class untouched", async (t) => {
  const { restricted } = await policyWorkspaces(t);
  const { terminals, control } = fixture({ defaultDataClass: "D1", pathClass: () => null });
  const parent = parentUnder(terminals);
  const child = control.spawn({ parentSessionId: parent.id, provider: "qwen", cwd: restricted });
  assert.equal(child.provider, "qwen");
  terminals.disposeAll();
});

test("strictest-of: the raised class wins between an explicit request and the path", async (t) => {
  const { restricted } = await policyWorkspaces(t);
  const { terminals, control } = fixture({
    pathClass: (cwd) => (cwd === restricted ? "D3" : null)
  });
  const parent = parentUnder(terminals);
  assert.throws(
    () => control.spawn({ parentSessionId: parent.id, provider: "devin", cwd: restricted, dataClass: "D1" }),
    /Provider devin handles at most D2; this task is D3\./u
  );
  terminals.disposeAll();
});

test("a path class lower than the request class never lowers the tier", async (t) => {
  const { open } = await policyWorkspaces(t);
  const { terminals, control } = fixture({ pathClass: () => "D0" });
  const parent = parentUnder(terminals);
  // With lowering this would spawn; with max semantics the D2 request still
  // names D2 and the D1-capped provider still refuses it.
  assert.throws(
    () => control.spawn({ parentSessionId: parent.id, provider: "minimax", cwd: open, dataClass: "D2" }),
    /Provider minimax handles at most D1; this task is D2\./u
  );
  const child = control.spawn({ parentSessionId: parent.id, provider: "devin", cwd: open, dataClass: "D2" });
  assert.equal(child.provider, "devin");
  terminals.disposeAll();
});

test("a configured path resolver enforces classification without an explicit default", async (t) => {
  const { restricted } = await policyWorkspaces(t);
  const { terminals, control } = fixture({ pathClass: () => "D3" });
  const parent = parentUnder(terminals);
  assert.throws(() => control.spawn({ parentSessionId: parent.id, provider: "qwen", cwd: restricted }), /at most D1/u);
  terminals.disposeAll();
});

test("a throwing resolver fails closed before spawning", async (t) => {
  const { restricted } = await policyWorkspaces(t);
  const { terminals, control } = fixture({
    defaultDataClass: "D1",
    pathClass: () => {
      throw new Error("resolver exploded");
    }
  });
  const parent = parentUnder(terminals);
  assert.throws(() => control.spawn({ parentSessionId: parent.id, provider: "qwen", cwd: restricted }), /resolver exploded/u);
  terminals.disposeAll();
});

test("the raised class rides into the placement request; without classification it does not", async (t) => {
  const { restricted } = await policyWorkspaces(t);
  const placed = [];
  const placement = {
    async place(request) {
      placed.push(request);
      return { kind: "local", reason: "test stub" };
    }
  };

  const withPolicy = fixture({
    defaultDataClass: "D1",
    pathClass: (cwd) => (cwd === restricted ? "D2" : null)
  }, placement);
  const parent = parentUnder(withPolicy.terminals);
  await withPolicy.control.spawn({
    parentSessionId: parent.id,
    provider: "devin",
    cwd: restricted,
    host: "auto"
  });
  assert.deepEqual(placed, [{ provider: "devin", localWorkspace: restricted, dataClass: "D2" }]);
  withPolicy.terminals.disposeAll();

  const bare = fixture(undefined, placement);
  const bareParent = parentUnder(bare.terminals);
  await bare.control.spawn({
    parentSessionId: bareParent.id,
    provider: "devin",
    cwd: restricted,
    host: "auto"
  });
  assert.deepEqual(placed[1], { provider: "devin", localWorkspace: restricted });
  assert.equal("dataClass" in placed[1], false, "a spawn with no classification keeps the legacy request shape");
  bare.terminals.disposeAll();
});
