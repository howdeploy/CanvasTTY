import assert from "node:assert/strict";
import test from "node:test";
import { HostPlacementService, comparePlacementCandidates } from "../src/main/services/HostPlacement.ts";

const WORKSPACE = "/Users/runner/project";

function host(id, extra = {}) {
  return { id, label: `Host ${id}`, sshHost: `${id}.internal.example`, ...extra };
}

function mapped(remotePath = "/remote/project", localPath = WORKSPACE) {
  return [{ localPath, remotePath }];
}

function reachableMetrics(hostId, fields = {}) {
  return {
    hostId,
    collectedAt: 1_000,
    reachable: true,
    load1: 0.5,
    cores: 8,
    memoryTotalMb: 16_384,
    memoryAvailableMb: 8_192,
    gpuVramTotalMb: null,
    gpuVramUsedMb: null,
    ...fields
  };
}

function unreachableMetrics(hostId) {
  return {
    hostId,
    collectedAt: 1_000,
    reachable: false,
    load1: null,
    cores: null,
    memoryTotalMb: null,
    memoryAvailableMb: null,
    gpuVramTotalMb: null,
    gpuVramUsedMb: null,
    detail: "connection refused in test"
  };
}

function discoveryResult(hostId, installed = ["claude"]) {
  return {
    hostId,
    reachable: true,
    providers: installed.map((provider) => ({ provider, installed: true }))
  };
}

// Fake data sources recording every call, so tests can assert both the
// decision and the probing behavior behind it.
function makeSources({ metrics = () => null, discovery = () => null, sessions = () => 0 } = {}) {
  const probed = { metrics: [], discovery: [], sessions: [] };
  const sources = {
    metrics(current) {
      probed.metrics.push(current.id);
      return metrics(current);
    },
    discovery(current) {
      probed.discovery.push(current.id);
      return discovery(current);
    },
    activeSessions(hostId) {
      probed.sessions.push(hostId);
      return sessions(hostId);
    }
  };
  return { probed, sources };
}

test("the host with fewer active sessions wins and its mapped remote path is returned", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id, { load1: 0.1 })),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: (hostId) => (hostId === "busy" ? 3 : 1)
  });

  const decision = await new HostPlacementService(sources).place(
    [
      host("busy", { workspaces: mapped("/srv/busy-project") }),
      host("idle", { workspaces: mapped("/srv/idle-project") })
    ],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "idle");
  assert.equal(decision.remoteWorkspace, "/srv/idle-project");
});

test("a lighter load breaks an equal-session tie, ahead of priority", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(
      current.id === "calm"
        ? reachableMetrics("calm", { load1: 0.5, cores: 4 })
        : reachableMetrics("hot", { load1: 1.5, cores: 4 })
    ),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 2
  });

  const decision = await new HostPlacementService(sources).place(
    [
      host("calm", { workspaces: mapped(), priority: 100 }),
      host("hot", { workspaces: mapped(), priority: 0 })
    ],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "calm");
});

test("load is normalized by cores: 8 cores at load 4 beats 2 cores at load 1.5", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(
      current.id === "octo"
        ? reachableMetrics("octo", { load1: 4, cores: 8 })
        : reachableMetrics("duo", { load1: 1.5, cores: 2 })
    ),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 0
  });

  const decision = await new HostPlacementService(sources).place(
    [
      host("octo", { workspaces: mapped(), priority: 100 }),
      host("duo", { workspaces: mapped(), priority: 0 })
    ],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  // 4/8 = 0.5 beats 1.5/2 = 0.75 despite the larger raw load.
  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "octo");
});

test("available memory breaks a load tie, descending, ahead of priority", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(
      reachableMetrics(current.id, {
        load1: 1.0,
        cores: 2,
        memoryAvailableMb: current.id === "roomy" ? 16_384 : 4_096
      })
    ),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 1
  });

  const decision = await new HostPlacementService(sources).place(
    [
      host("roomy", { workspaces: mapped(), priority: 100 }),
      host("tight", { workspaces: mapped(), priority: 0 })
    ],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "roomy");
});

test("priority breaks metric ties, with undefined counting as 50", async () => {
  const pinned = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 1
  });
  const first = await new HostPlacementService(pinned.sources).place(
    [host("loose", { workspaces: mapped(), priority: 40 }), host("pinned", { workspaces: mapped(), priority: 10 })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.equal(first.host.id, "pinned");

  const unset = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 1
  });
  const second = await new HostPlacementService(unset.sources).place(
    [host("worst", { workspaces: mapped(), priority: 60 }), host("unset", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  // No priority means 50, which still beats an explicit 60.
  assert.equal(second.host.id, "unset");
});

test("the host id is the final stable tie-break", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 2
  });
  const hosts = [host("zeta", { workspaces: mapped() }), host("alpha", { workspaces: mapped() })];

  const forward = await new HostPlacementService(sources).place(hosts, { provider: "claude", localWorkspace: WORKSPACE });
  const reversed = await new HostPlacementService(sources).place([...hosts].reverse(), { provider: "claude", localWorkspace: WORKSPACE });

  assert.equal(forward.host.id, "alpha");
  assert.equal(reversed.host.id, "alpha", "input order must never change the decision");
});

test("unreachable and null-metrics hosts are excluded with the provider-stage reason", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(
      current.id === "dead" ? unreachableMetrics("dead") : null
    ),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 0
  });

  const decision = await new HostPlacementService(sources).place(
    [host("dead", { workspaces: mapped() }), host("silent", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.deepEqual(decision, { kind: "local", reason: "no reachable host with claude installed" });
});

test("provider presence flows through discovery: a worse-ranked host with cursor wins", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(
      current.id === "fast"
        ? reachableMetrics("fast", { load1: 0.1, cores: 8 })
        : reachableMetrics("slow", { load1: 9, cores: 1 })
    ),
    discovery: (current) => Promise.resolve(
      current.id === "fast" ? discoveryResult("fast", ["claude"]) : discoveryResult("slow", ["cursor"])
    ),
    sessions: (hostId) => (hostId === "fast" ? 0 : 3)
  });

  const decision = await new HostPlacementService(sources).place(
    [host("fast", { workspaces: mapped() }), host("slow", { workspaces: mapped("/srv/cursor-project") })],
    { provider: "cursor", localWorkspace: WORKSPACE }
  );

  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "slow");
  assert.equal(decision.remoteWorkspace, "/srv/cursor-project");
});

test("a host without the requested provider is excluded with a reason naming the provider", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id, ["claude", "codex"])),
    sessions: () => 0
  });

  const decision = await new HostPlacementService(sources).place(
    [host("wrong-cli", { workspaces: mapped() })],
    { provider: "cursor", localWorkspace: WORKSPACE }
  );

  assert.deepEqual(decision, { kind: "local", reason: "no reachable host with cursor installed" });
});

test("a host that does not map the workspace is excluded at the mapping stage", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 0
  });

  const decision = await new HostPlacementService(sources).place(
    [host("elsewhere", { workspaces: mapped("/remote/other", "/Users/runner/unrelated") })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.deepEqual(decision, { kind: "local", reason: "workspace not mapped on any eligible host" });
});

test("a host at its session cap is excluded — explicit cap and the default of 4", async () => {
  const capped = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 2
  });
  const cappedDecision = await new HostPlacementService(capped.sources).place(
    [host("tiny", { workspaces: mapped(), maxSessions: 2 })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.deepEqual(cappedDecision, { kind: "local", reason: "all eligible hosts full" });

  const defaults = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: (hostId) => (hostId === "saturated" ? 4 : 3)
  });
  const defaultDecision = await new HostPlacementService(defaults.sources).place(
    [host("saturated", { workspaces: mapped() }), host("spare", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  // No maxSessions means 4: a host holding exactly 4 is full, one holding 3 is not.
  assert.equal(defaultDecision.kind, "remote");
  assert.equal(defaultDecision.host.id, "spare");
});

test("no configured hosts answers local immediately without probing anything", async () => {
  const { probed, sources } = makeSources();

  const decision = await new HostPlacementService(sources).place([], { provider: "claude", localWorkspace: WORKSPACE });

  assert.deepEqual(decision, { kind: "local", reason: "no configured hosts" });
  assert.deepEqual(probed, { metrics: [], discovery: [], sessions: [] });
});

test("the fallback reason names the deepest stage any host reached", async () => {
  const unreachableStage = makeSources({
    metrics: (current) => Promise.resolve(
      current.id === "dead" ? unreachableMetrics("dead") : reachableMetrics(current.id)
    ),
    discovery: (current) => Promise.resolve(
      current.id === "no-cli" ? discoveryResult("no-cli", ["codex"]) : discoveryResult(current.id)
    ),
    sessions: () => 0
  });
  const stage1 = await new HostPlacementService(unreachableStage.sources).place(
    [host("dead", { workspaces: mapped() }), host("no-cli", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.deepEqual(stage1, { kind: "local", reason: "no reachable host with claude installed" });

  const mappingStage = makeSources({
    metrics: (current) => Promise.resolve(
      current.id === "dead" ? unreachableMetrics("dead") : reachableMetrics(current.id)
    ),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 0
  });
  const stage2 = await new HostPlacementService(mappingStage.sources).place(
    [
      host("dead", { workspaces: mapped() }),
      host("elsewhere", { workspaces: mapped("/remote/other", "/Users/runner/unrelated") })
    ],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.deepEqual(stage2, { kind: "local", reason: "workspace not mapped on any eligible host" });

  const capacityStage = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 9
  });
  const stage3 = await new HostPlacementService(capacityStage.sources).place(
    [
      host("elsewhere", { workspaces: mapped("/remote/other", "/Users/runner/unrelated") }),
      host("packed", { workspaces: mapped(), maxSessions: 1 })
    ],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.deepEqual(stage3, { kind: "local", reason: "all eligible hosts full" });
});

test("a throwing metrics source degrades only its host, sync or async, never the call", async () => {
  const { probed, sources } = makeSources({
    metrics: (current) => {
      if (current.id === "broken") return Promise.reject(new Error("probe timed out"));
      if (current.id === "sync-throw") throw new Error("source exploded");
      return Promise.resolve(reachableMetrics(current.id));
    },
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    // Both degraded hosts would win the ranking if their metrics had loaded;
    // the healthy one stays under the default cap of 4.
    sessions: (hostId) => (hostId === "healthy" ? 3 : 0)
  });

  const decision = await new HostPlacementService(sources).place(
    [
      host("broken", { workspaces: mapped() }),
      host("sync-throw", { workspaces: mapped() }),
      host("healthy", { workspaces: mapped() })
    ],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "healthy");
  assert.deepEqual([...probed.metrics].sort(), ["broken", "healthy", "sync-throw"]);
});

test("a throwing discovery source degrades that host to not-installed", async () => {
  const { sources } = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id, { load1: 0.01 })),
    discovery: (current) => {
      if (current.id === "no-probe") return Promise.reject(new Error("discovery failed"));
      return Promise.resolve(discoveryResult(current.id));
    },
    sessions: (hostId) => (hostId === "no-probe" ? 0 : 3)
  });

  const decision = await new HostPlacementService(sources).place(
    [host("no-probe", { workspaces: mapped() }), host("ok", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "ok");

  const allBroken = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: () => Promise.reject(new Error("discovery failed")),
    sessions: () => 0
  });
  const fallback = await new HostPlacementService(allBroken.sources).place(
    [host("a", { workspaces: mapped() }), host("b", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.deepEqual(fallback, { kind: "local", reason: "no reachable host with claude installed" });
});

test("every host is probed in parallel even when the first host would win", async () => {
  const ids = ["alpha", "beta", "gamma"];
  const total = ids.length;
  let started = 0;
  let releaseBarrier;
  let probesOverlapped = true;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });
  // If place() probed hosts one-by-one, only the first metrics call would ever
  // start and the barrier would never open by itself; the timer then releases
  // it anyway so the test fails with a clear message instead of hanging.
  const timer = setTimeout(() => {
    probesOverlapped = false;
    releaseBarrier();
  }, 1_000);
  const { probed, sources } = makeSources({
    metrics: (current) => {
      started += 1;
      if (started === total) releaseBarrier();
      return barrier.then(() => Promise.resolve(
        current.id === "alpha"
          ? reachableMetrics("alpha", { load1: 0.01, cores: 8, memoryAvailableMb: 64_000 })
          : reachableMetrics(current.id, { load1: 9, cores: 1, memoryAvailableMb: 64 })
      ));
    },
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: (hostId) => (hostId === "alpha" ? 0 : 2)
  });

  const decision = await new HostPlacementService(sources).place(
    ids.map((id) => host(id, { workspaces: mapped(), priority: id === "alpha" ? 0 : 50 })),
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  clearTimeout(timer);
  assert.equal(probesOverlapped, true, "all metric probes must start before any of them resolves");
  assert.deepEqual([...probed.metrics].sort(), ["alpha", "beta", "gamma"]);
  assert.deepEqual([...probed.discovery].sort(), ["alpha", "beta", "gamma"]);
  assert.deepEqual([...probed.sessions].sort(), ["alpha", "beta", "gamma"]);
  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "alpha");
});

// A standalone candidate for comparator tests: healthy defaults everywhere.
function candidate(hostId, fields = {}, hostExtra = {}) {
  return {
    host: host(hostId, hostExtra),
    metrics: reachableMetrics(hostId),
    providerInstalled: true,
    remoteWorkspace: "/remote/project",
    activeSessions: 0,
    ...fields
  };
}

test("comparator: null metrics sorts last within the same session slot, but session count still dominates", () => {
  const blind = candidate("a", { metrics: null });
  const seen = candidate("b");
  assert.ok(comparePlacementCandidates(blind, seen) > 0);
  assert.ok(comparePlacementCandidates(seen, blind) < 0);

  const idleBlind = candidate("a", { metrics: null, activeSessions: 0 });
  const busySeen = candidate("b", { activeSessions: 1 });
  assert.ok(comparePlacementCandidates(idleBlind, busySeen) < 0);
});

test("comparator: an uncomputable load sorts after any concrete load", () => {
  const heavy = candidate("b", { metrics: reachableMetrics("b", { load1: 99, cores: 1 }) });
  const noLoad = candidate("a", { metrics: reachableMetrics("a", { load1: null, cores: 8 }) });
  const noCores = candidate("c", { metrics: reachableMetrics("c", { load1: 1, cores: 0 }) });
  const noMetrics = candidate("d", { metrics: null });

  assert.ok(comparePlacementCandidates(noLoad, heavy) > 0);
  assert.ok(comparePlacementCandidates(noCores, heavy) > 0);
  assert.ok(comparePlacementCandidates(noMetrics, heavy) > 0);
  // Two null loads tie and fall through: memory decides before the id.
  assert.ok(comparePlacementCandidates(noCores, noMetrics) < 0, "a concrete memory beats a null one once loads tie");
  const blindA = candidate("d", { metrics: reachableMetrics("d", { load1: null }) });
  const blindB = candidate("e", { metrics: reachableMetrics("e", { load1: null }) });
  assert.equal(comparePlacementCandidates(blindA, blindB), -1, "fully tied null loads fall to the id tie-break");
});

test("comparator: null memory sorts after any concrete memory, and two nulls fall through", () => {
  const unknown = candidate("a", { metrics: reachableMetrics("a", { memoryAvailableMb: null }) });
  const tiny = candidate("b", { metrics: reachableMetrics("b", { memoryAvailableMb: 1 }) });
  assert.ok(comparePlacementCandidates(unknown, tiny) > 0);
  assert.ok(comparePlacementCandidates(tiny, unknown) < 0);

  const alsoUnknown = candidate("b", { metrics: reachableMetrics("b", { memoryAvailableMb: null }) });
  assert.equal(comparePlacementCandidates(unknown, alsoUnknown), -1, "two null memories tie; host id decides");
});

test("comparator: antisymmetric, total, and stable under reshuffling", () => {
  const candidates = [
    candidate("zeta", { activeSessions: 2 }),
    candidate("alpha", { metrics: null, activeSessions: 1 }),
    candidate("mid", { activeSessions: 1 }),
    candidate("prio", { activeSessions: 1 }, { priority: 1 }),
    candidate("roomy", { metrics: reachableMetrics("roomy", { memoryAvailableMb: 64_000 }) })
  ];

  for (const a of candidates) {
    for (const b of candidates) {
      const forward = comparePlacementCandidates(a, b);
      const backward = comparePlacementCandidates(b, a);
      // 0 - backward avoids assert.equal's 0 !== -0 strictness trap.
      assert.equal(forward, 0 - backward);
      if (a !== b) assert.notEqual(forward, 0);
    }
  }

  const sorted = [...candidates].sort(comparePlacementCandidates);
  const resorted = [...sorted].reverse().sort(comparePlacementCandidates);
  assert.deepEqual(resorted.map((entry) => entry.host.id), sorted.map((entry) => entry.host.id));
  // By the documented keys: fewest sessions first (roomy), then within the
  // 1-session slot priority (prio) before default 50 (mid) before the
  // null-metrics host (alpha), then the 2-session host (zeta).
  assert.deepEqual(sorted.map((entry) => entry.host.id), ["roomy", "prio", "mid", "alpha", "zeta"]);
});

// --- provider availability: policy rules and API-reachability data ------------

// A parallel factory to makeSources that also injects an access source. The
// original helper stays untouched so its probed-object shape keeps matching
// the earlier tests byte for byte.
function makeAccessSources({ metrics = () => null, discovery = () => null, sessions = () => 0, access = () => null } = {}) {
  const probed = { metrics: [], discovery: [], access: [], sessions: [] };
  const sources = {
    metrics(current) {
      probed.metrics.push(current.id);
      return metrics(current);
    },
    discovery(current) {
      probed.discovery.push(current.id);
      return discovery(current);
    },
    activeSessions(hostId) {
      probed.sessions.push(hostId);
      return sessions(hostId);
    },
    access(current) {
      probed.access.push(current.id);
      return access(current);
    }
  };
  return { probed, sources };
}

// Every host reachable + installed + mapped by default, so each test below
// flips exactly one availability fact.
function healthySources(overrides = {}) {
  return makeAccessSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    ...overrides
  });
}

test("an allowlist host denies unlisted providers with the availability reason", async () => {
  const { sources } = healthySources();
  const decision = await new HostPlacementService(sources).place(
    [host("ru-box", { workspaces: mapped(), providerAccess: { mode: "allowlist", providers: ["qwen", "kimi"] } })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.deepEqual(decision, {
    kind: "local",
    reason: "provider claude is not permitted or reachable on any eligible host"
  });
});

test("a blocklist host denies its listed providers with the same reason", async () => {
  const { sources } = healthySources();
  const decision = await new HostPlacementService(sources).place(
    [host("filtered", { workspaces: mapped(), providerAccess: { mode: "blocklist", providers: ["claude"] } })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.deepEqual(decision, {
    kind: "local",
    reason: "provider claude is not permitted or reachable on any eligible host"
  });
  // The same host admits a provider the blocklist does not name.
  const allowed = await new HostPlacementService(healthySources({
    discovery: () => Promise.resolve(discoveryResult("filtered", ["qwen"]))
  }).sources).place(
    [host("filtered", { workspaces: mapped(), providerAccess: { mode: "blocklist", providers: ["claude"] } })],
    { provider: "qwen", localWorkspace: WORKSPACE }
  );
  assert.equal(allowed.kind, "remote");
  assert.equal(allowed.host.id, "filtered");
});

test("a host with no providerAccess rule stays unrestricted", async () => {
  const { sources } = healthySources({
    discovery: () => Promise.resolve(discoveryResult("open", ["grok"]))
  });
  const decision = await new HostPlacementService(sources).place(
    [host("open", { workspaces: mapped() })],
    { provider: "grok", localWorkspace: WORKSPACE }
  );

  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "open");
});

test("an access source reporting the endpoint blocked excludes the host", async () => {
  const { sources } = healthySources({
    access: (current) => Promise.resolve({ hostId: current.id, reachable: true, providers: { claude: current.id === "blocked" ? false : true } })
  });
  const decision = await new HostPlacementService(sources).place(
    [host("blocked", { workspaces: mapped() }), host("clear", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "clear");
});

test("every host blocked network-wise falls back local with the availability reason", async () => {
  const { sources } = healthySources({
    access: (current) => Promise.resolve({ hostId: current.id, reachable: true, providers: { claude: false } })
  });
  const decision = await new HostPlacementService(sources).place(
    [host("a", { workspaces: mapped() }), host("b", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.deepEqual(decision, {
    kind: "local",
    reason: "provider claude is not permitted or reachable on any eligible host"
  });
});

test("access data of null, an omitted source, or a subset without the provider never filters", async () => {
  // A null result (probe skipped or host had nothing to say) is no data.
  const nullResult = await new HostPlacementService(healthySources({
    access: () => Promise.resolve(null)
  }).sources).place(
    [host("quiet", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.equal(nullResult.kind, "remote");

  // No access member at all: the legacy source shape keeps working unchanged.
  const noSource = makeSources({
    metrics: (current) => Promise.resolve(reachableMetrics(current.id)),
    discovery: (current) => Promise.resolve(discoveryResult(current.id)),
    sessions: () => 0
  });
  const omitted = await new HostPlacementService(noSource.sources).place(
    [host("legacy", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.equal(omitted.kind, "remote");

  // A probe that covered other providers says nothing about this one.
  const subset = await new HostPlacementService(healthySources({
    access: () => Promise.resolve({ hostId: "narrow", reachable: true, providers: { qwen: true } })
  }).sources).place(
    [host("narrow", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.equal(subset.kind, "remote");
});

test("a throwing access source degrades only its host, fail-open, never the call", async () => {
  const { probed, sources } = healthySources({
    access: (current) => {
      if (current.id === "blind") return Promise.reject(new Error("access probe crashed"));
      return Promise.resolve({ hostId: current.id, reachable: true, providers: { claude: true } });
    },
    // The degraded host would win the ranking outright if allowed, which is
    // exactly the point: missing access data must not cost it the placement.
    sessions: (hostId) => (hostId === "blind" ? 0 : 3)
  });

  const decision = await new HostPlacementService(sources).place(
    [host("blind", { workspaces: mapped() }), host("seen", { workspaces: mapped() })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "blind");
  assert.deepEqual([...probed.access].sort(), ["blind", "seen"]);
});

test("a denied best-ranked host loses to a permitted worse-ranked host", async () => {
  const { sources } = healthySources({
    metrics: (current) => Promise.resolve(
      current.id === "closed"
        ? reachableMetrics("closed", { load1: 0.01, cores: 8, memoryAvailableMb: 64_000 })
        : reachableMetrics(current.id, { load1: 9, cores: 1, memoryAvailableMb: 64 })
    ),
    discovery: (current) => Promise.resolve(
      current.id === "closed" ? discoveryResult("closed", ["claude", "codex"]) : discoveryResult(current.id)
    ),
    access: (current) => Promise.resolve({ hostId: current.id, reachable: true, providers: { claude: current.id !== "closed" } }),
    sessions: (hostId) => (hostId === "closed" ? 0 : 2)
  });

  const decision = await new HostPlacementService(sources).place(
    [host("closed", { workspaces: mapped(), priority: 0 }), host("usable", { workspaces: mapped(), priority: 100 })],
    { provider: "claude", localWorkspace: WORKSPACE }
  );

  assert.equal(decision.kind, "remote");
  assert.equal(decision.host.id, "usable");
});

test("the availability stage reports deeper than the installed stage and shallower than mapping", async () => {
  // A host missing the CLI fails shallow; the denying host fails at the
  // availability stage, which is therefore the deepest reached.
  const deeperThanInstalled = healthySources({
    discovery: (current) => Promise.resolve(
      current.id === "no-cli" ? discoveryResult("no-cli", ["codex"]) : discoveryResult(current.id)
    )
  });
  const stageA = await new HostPlacementService(deeperThanInstalled.sources).place(
    [
      host("no-cli", { workspaces: mapped() }),
      host("deny", { workspaces: mapped(), providerAccess: { mode: "allowlist", providers: ["qwen"] } })
    ],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.deepEqual(stageA, {
    kind: "local",
    reason: "provider claude is not permitted or reachable on any eligible host"
  });

  // A host that survives availability but fails mapping drags the diagnosis
  // one stage deeper, so availability stays in its place in the chain.
  const shallowerThanMapping = healthySources();
  const stageB = await new HostPlacementService(shallowerThanMapping.sources).place(
    [
      host("deny", { workspaces: mapped(), providerAccess: { mode: "allowlist", providers: ["qwen"] } }),
      host("unmapped", { workspaces: mapped("/remote/other", "/Users/runner/unrelated") })
    ],
    { provider: "claude", localWorkspace: WORKSPACE }
  );
  assert.deepEqual(stageB, { kind: "local", reason: "workspace not mapped on any eligible host" });
});

test("apiReachable is a filter signal only: it never participates in ranking", () => {
  // Fully tied through every documented key, differing only in apiReachable:
  // the id tie-break decides, whether the signals agree or conflict.
  const reachable = candidate("a", { apiReachable: true });
  const blocked = candidate("b", { apiReachable: false });
  assert.equal(comparePlacementCandidates(reachable, blocked), -1);
  assert.equal(comparePlacementCandidates(blocked, reachable), 1);
  const unknown = candidate("c", { apiReachable: null });
  const alsoUnknown = candidate("d", { apiReachable: null });
  assert.equal(comparePlacementCandidates(unknown, alsoUnknown), -1);
});
