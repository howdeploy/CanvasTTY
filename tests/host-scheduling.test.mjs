import assert from "node:assert/strict";
import test from "node:test";
import { HostPlacementService } from "../src/main/services/HostPlacement.ts";
import { RemoteHostMetricsService } from "../src/main/services/RemoteHostMetrics.ts";
import { RemoteProviderDiscovery } from "../src/main/services/RemoteProviderDiscovery.ts";
import { RemoteProviderAccess } from "../src/main/services/RemoteProviderAccess.ts";
import { normalizeRemoteHosts } from "../src/main/services/SettingsStore.ts";
const host = (id = "one", extra = {}) => ({ id, label: id, sshHost: `${id}.example`, workspaces: [{ localPath: "/project", remotePath: "/work" }], ...extra });
const metrics = (h, extra = {}) => ({ hostId: h.id, collectedAt: 0, reachable: true, load1: 1, cores: 4, memoryAvailableMb: 8192, ...extra });
const discovery = (h) => ({ hostId: h.id, reachable: true, providers: [{ provider: "claude", installed: true }] });
const request = { provider: "claude", localWorkspace: "/project", dataClass: "D0" };
const sources = (extra = {}) => ({ metrics: async (h) => metrics(h), discovery: async (h) => discovery(h), activeSessions: () => 0, ...extra });

test("100 hosts and concurrent placements bound probes and share in-flight work", async () => {
  let active = 0, peak = 0, calls = 0;
  const probe = (result) => async (h) => { calls++; active++; peak = Math.max(active, peak); await new Promise((r) => setTimeout(r, 1)); active--; return result(h); };
  const placement = new HostPlacementService(sources({ metrics: probe(metrics), discovery: probe(discovery), access: probe((h) => ({ hostId: h.id, reachable: true, providers: { claude: true } })) }));
  const hosts = Array.from({ length: 100 }, (_, i) => host(`h${i}`));
  assert.equal(calls, 0);
  const answers = await Promise.all([placement.place(hosts, request), placement.place(hosts, request)]);
  assert.ok(answers.every((answer) => answer.kind === "remote"));
  assert.ok(peak <= 8, `peak concurrent probes: ${peak}`);
  assert.equal(calls, 300, "each host fact collected once across concurrent placements");
});

test("static policy, binding, mapping and capacity exclusions do not start probes", async () => {
  let calls = 0;
  const placement = new HostPlacementService(sources({ metrics: async () => { calls++; return null; }, discovery: async () => { calls++; return null; }, activeSessions: (id) => id === "full" ? 4 : 0 }));
  for (const current of [host("denied", { providerAccess: { mode: "blocklist", providers: ["claude"] } }), host("private", { maxDataClass: "D0" }), host("unmapped", { workspaces: [] }), host("full"), host("invalid", { sshHost: "-x" })]) {
    await placement.place([current], { ...request, dataClass: "D1" });
  }
  await placement.place([host("unbound")], { ...request, eligibleHostIds: ["one"] });
  assert.equal(calls, 0);
});

test("placement asks only for the requested provider and rechecks live capacity", async () => {
  const asked = [];
  let full = false;
  const placement = new HostPlacementService(sources({
    discovery: async (h, subset) => { asked.push(subset); return discovery(h); },
    access: async (h, subset) => { asked.push(subset); full = true; return { hostId: h.id, reachable: true, providers: { claude: true } }; },
    capacity: () => {
      const observedFull = full;
      return { activeSessions: () => observedFull ? 4 : 0 };
    }
  }));
  const result = await placement.place([host()], request);
  assert.equal(result.kind, "local");
  assert.deepEqual(asked, [["claude"], ["claude"]]);
});

test("declared resource constraints fail closed on missing or exhausted metrics", async () => {
  for (const values of [{ memoryAvailableMb: null }, { memoryAvailableMb: 512 }, { cores: null }, { cores: 0 }, { load1: null }, { load1: 9 }]) {
    const placement = new HostPlacementService(sources({ metrics: async (h) => metrics(h, values) }));
    const answer = await placement.place([host("bounded", { minFreeMemoryMb: 1024, maxLoadPerCore: 1 })], request);
    assert.equal(answer.kind, "local", JSON.stringify(values));
    assert.match(answer.reason, /resource/u);
  }
  assert.deepEqual(normalizeRemoteHosts([host("bounded", { minFreeMemoryMb: 1024, maxLoadPerCore: 0.75 })], [])[0], host("bounded", { minFreeMemoryMb: 1024, maxLoadPerCore: 0.75 }));
  for (const constraint of [{ minFreeMemoryMb: -1 }, { maxLoadPerCore: NaN }, { maxLoadPerCore: -1 }]) assert.deepEqual(normalizeRemoteHosts([host("bad", constraint)], []), []);
});

test("remote services deduplicate concurrent reads and invalidate edited host identity", async () => {
  for (const factory of [(run) => new RemoteHostMetricsService(run), (run) => new RemoteProviderDiscovery(run), (run) => new RemoteProviderAccess(run)]) {
    let calls = 0;
    const service = factory(async () => { calls++; await new Promise((r) => setTimeout(r, 1)); return { code: 0, stdout: "cores=4\nclaude=/bin/claude\nclaude=1\n", stderr: "" }; });
    const read = (h) => service.collect?.(h) ?? service.discover?.(h) ?? service.probe(h);
    assert.equal(calls, 0);
    await Promise.all([read(host()), read(host())]);
    assert.equal(calls, 1);
    await read(host());
    assert.equal(calls, 1);
    await read(host("one", { sshHost: "different.example" }));
    await read(host("one", { sshUser: "other" }));
    await read(host("one", { sshPort: 2222 }));
    assert.equal(calls, 4);
  }
});

test("provider subsets partition caches and discovery probes no unrelated CLI", async () => {
  const accessCalls = [];
  const access = new RemoteProviderAccess(async (_host, command) => { accessCalls.push(command[0]); return { code: 0, stdout: "claude=1\ncodex=1\n", stderr: "" }; });
  await access.probe(host(), undefined, ["claude"]);
  await access.probe(host(), undefined, ["claude"]);
  await access.probe(host(), undefined, ["codex"]);
  assert.equal(accessCalls.length, 2);
  assert.ok(accessCalls[0].includes("api.anthropic.com"));
  assert.ok(!accessCalls[0].includes("api.openai.com"));
  const scripts = [];
  const service = new RemoteProviderDiscovery(async (_host, command) => { scripts.push(command[0]); return { code: 0, stdout: "claude=/bin/claude\n", stderr: "" }; });
  const result = await service.discover(host(), undefined, ["claude"]);
  assert.equal(result.providers.length, 1);
  assert.match(scripts[0], /for c in claude;/u);
});

test("known SSH access failure excludes the host even when metrics were cached", async () => {
  const placement = new HostPlacementService(sources({ access: async (h) => ({ hostId: h.id, reachable: false, providers: {} }) }));
  assert.equal((await placement.place([host()], request)).kind, "local");
});

test("resource limits persist through the settings store", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SettingsStore } = await import("../src/main/services/SettingsStore.ts");
  const directory = await mkdtemp(join(tmpdir(), "canvastty-resources-"));
  try {
    const store = new SettingsStore(directory, "en");
    await store.load();
    await store.update({ remoteHosts: [host("limits", { minFreeMemoryMb: 4096, maxLoadPerCore: 0.5 })] });
    const restored = new SettingsStore(directory, "en");
    await restored.load();
    assert.equal(restored.get().remoteHosts[0].minFreeMemoryMb, 4096);
    assert.equal(restored.get().remoteHosts[0].maxLoadPerCore, 0.5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("explicit HTTP access blocks do not become usable endpoints; 401 means only reachable", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "canvastty-probe-http-"));
  try {
    await writeFile(join(directory, "curl"), '#!/bin/sh\nprintf "%s" "$FAKE_HTTP_CODE"\nexit "${FAKE_EXIT_CODE:-0}"\n', { mode: 0o700 });
    for (const [code, exitCode] of [["403", "0"], ["451", "0"], ["000", "0"], ["401", "0"], ["200", "0"], ["200", "28"]]) {
      const access = new RemoteProviderAccess(async (_host, command) => {
        const script = command[0].slice("sh -lc '".length, -1);
        const stdout = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: directory, FAKE_HTTP_CODE: code, FAKE_EXIT_CODE: exitCode } });
        return { code: 0, stdout, stderr: "" };
      });
      assert.equal((await access.probe(host(), undefined, ["claude"])).providers.claude, (code === "401" || code === "200") && exitCode === "0", `${code}/${exitCode}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cache storage and transport queue stay bounded and rejected work releases its slot", async () => {
  const { ProbeCache, ProbeLimiter } = await import("../src/main/services/RemoteProbeCache.ts");
  const cache = new ProbeCache({ maxEntries: 2 });
  let calls = 0;
  const read = (id) => cache.read(id, async () => ++calls);
  await read("a"); await read("b"); await read("c"); await read("a");
  assert.equal(calls, 4, "oldest cached fact was evicted");
  let release;
  const limiter = new ProbeLimiter(1, 1);
  const first = limiter.run(() => new Promise((resolve) => { release = resolve; }));
  const second = limiter.run(async () => { throw new Error("probe failed"); });
  await assert.rejects(limiter.run(async () => 3), /queue is full/u);
  release(); await first;
  await assert.rejects(second, /probe failed/u);
  assert.equal(await limiter.run(async () => 4), 4);
});
