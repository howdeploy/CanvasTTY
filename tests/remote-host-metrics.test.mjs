import assert from "node:assert/strict";
import test from "node:test";
import { buildSshArguments } from "../src/main/services/RemoteHostsService.ts";
import { RemoteHostMetricsService } from "../src/main/services/RemoteHostMetrics.ts";

const validHost = {
  id: "gpu-box",
  label: "GPU box",
  sshHost: "gpu.internal.example"
};

function fakeRunner(output) {
  const calls = [];
  const runner = (host, command, timeoutMs) => {
    calls.push({ host, command, timeoutMs });
    return Promise.resolve(output);
  };
  return { calls, runner };
}

// Unwraps `sh -lc '<script>'` the way the ssh argv carries it, pinning both
// the single-quoted wrapping and the script's own quote discipline.
function scriptFromCommand(command) {
  assert.equal(command.length, 1);
  assert.match(command[0], /^sh -lc '.*'$/u);
  const script = command[0].slice("sh -lc '".length, -1);
  assert.equal(script.includes("'"), false, "the quoted script must not contain single quotes");
  return script;
}

const fullProbeStdout = [
  "load1=0.42",
  "cores=10",
  "mem_total_kb=16777216",
  "mem_available_kb=8388607",
  "gpu_vram_total_mb=155648",
  "gpu_vram_used_mb=3071.6",
  ""
].join("\n");

test("one ssh round-trip parses every labelled line, rounding Mb values to integers", async () => {
  const { calls, runner } = fakeRunner({ code: 0, stdout: fullProbeStdout, stderr: "" });
  let currentTime = 1_000;
  const service = new RemoteHostMetricsService(runner, { now: () => currentTime });
  const metrics = await service.collect(validHost);

  assert.equal(calls.length, 1);
  assert.deepEqual(metrics, {
    hostId: "gpu-box",
    collectedAt: 1_000,
    reachable: true,
    load1: 0.42,
    cores: 10,
    memoryTotalMb: 16384,
    memoryAvailableMb: 8192,
    gpuVramTotalMb: 155648,
    gpuVramUsedMb: 3072
  });
  assert.equal(metrics.detail, undefined);
  assert.equal(calls[0].timeoutMs, 10_000);
  assert.equal(calls[0].host, validHost);

  const script = scriptFromCommand(calls[0].command);
  assert.ok(script.includes("/proc/loadavg"));
  assert.ok(script.includes("uptime"));
  assert.ok(script.includes("getconf _NPROCESSORS_ONLN"));
  assert.ok(script.includes("nproc"));
  assert.ok(script.includes("/proc/meminfo"));
  assert.ok(script.includes("MemAvailable"));
  assert.ok(script.includes("command -v nvidia-smi"));
  assert.ok(script.includes("--query-gpu=memory.total,memory.used"));
  assert.ok(script.includes("--format=csv,noheader,nounits"));
  assert.ok(script.endsWith("exit 0"));
});

test("the composed ssh argv keeps BatchMode, a bounded connect timeout, and no tty", async () => {
  const { calls, runner } = fakeRunner({ code: 0, stdout: "", stderr: "" });
  await new RemoteHostMetricsService(runner).collect(validHost);

  const argv = buildSshArguments(validHost, 10_000, calls[0].command);
  assert.ok(argv.includes("-o"));
  assert.ok(argv.includes("BatchMode=yes"));
  assert.ok(argv.includes("ConnectTimeout=10"));
  assert.ok(argv.includes("StrictHostKeyChecking=accept-new"));
  assert.equal(argv.includes("-tt") || argv.includes("-t"), false);
  assert.ok(argv.includes("gpu.internal.example"));
  assert.equal(argv[argv.length - 1], calls[0].command[0]);
});

test("a reachable host without GPU tooling reports null GPU fields, not a failure", async () => {
  const stdout = ["load1=1.5", "cores=8", "mem_total_kb=8388608", "mem_available_kb=4194304", ""].join("\n");
  const { calls, runner } = fakeRunner({ code: 0, stdout, stderr: "" });
  const metrics = await new RemoteHostMetricsService(runner).collect(validHost);

  assert.equal(calls.length, 1);
  assert.equal(metrics.reachable, true);
  assert.equal(metrics.gpuVramTotalMb, null);
  assert.equal(metrics.gpuVramUsedMb, null);
  assert.equal(metrics.load1, 1.5);
  assert.equal(metrics.cores, 8);
  assert.equal(metrics.memoryTotalMb, 8192);
  assert.equal(metrics.memoryAvailableMb, 4096);
});

test("garbage or missing values parse to null, never NaN, and profile noise is ignored", async () => {
  const stdout = [
    "Welcome to the build farm",
    "load1=heavy load",
    "load1=0.42",
    "load1=99",
    "cores=many",
    "cores=2.5",
    "mem_total_kb=",
    "mem_available_kb=banana",
    "gpu_vram_total_mb=NaN",
    "gpu_vram_used_mb=-5",
    ""
  ].join("\n");
  const { runner } = fakeRunner({ code: 0, stdout, stderr: "" });
  const metrics = await new RemoteHostMetricsService(runner).collect(validHost);

  assert.equal(metrics.reachable, true);
  // First parseable occurrence wins; the 99 re-report is ignored.
  assert.equal(metrics.load1, 0.42);
  assert.equal(metrics.cores, null);
  assert.equal(metrics.memoryTotalMb, null);
  assert.equal(metrics.memoryAvailableMb, null);
  assert.equal(metrics.gpuVramTotalMb, null);
  assert.equal(metrics.gpuVramUsedMb, null);
  for (const value of [metrics.cores, metrics.memoryTotalMb, metrics.memoryAvailableMb, metrics.gpuVramTotalMb, metrics.gpuVramUsedMb]) {
    assert.equal(Number.isNaN(value), false);
  }
});

test("a failing ssh exit reports an unreachable snapshot with a bounded stderr excerpt", async () => {
  const { runner } = fakeRunner({
    code: 255,
    stdout: "",
    stderr: "ssh: connect to host gpu.internal.example port 22: Connection refused\r\n"
  });
  const metrics = await new RemoteHostMetricsService(runner).collect(validHost);
  assert.equal(metrics.hostId, "gpu-box");
  assert.equal(metrics.reachable, false);
  assert.equal(metrics.load1, null);
  assert.equal(metrics.cores, null);
  assert.equal(metrics.memoryTotalMb, null);
  assert.equal(metrics.memoryAvailableMb, null);
  assert.equal(metrics.gpuVramTotalMb, null);
  assert.equal(metrics.gpuVramUsedMb, null);
  assert.equal(metrics.detail, "ssh: connect to host gpu.internal.example port 22: Connection refused");
});

test("unreachable detail is excerpted to 300 characters and a null exit code names the failure", async () => {
  const longStderr = { code: 255, stdout: "", stderr: "x".repeat(1_000) };
  const first = await new RemoteHostMetricsService(fakeRunner(longStderr).runner).collect(validHost);
  assert.equal(first.reachable, false);
  assert.equal(first.detail.length, 300);

  const killed = { code: null, stdout: "", stderr: "" };
  const second = await new RemoteHostMetricsService(fakeRunner(killed).runner).collect(validHost);
  assert.equal(second.reachable, false);
  assert.equal(second.detail, "ssh exited with code unknown");
});

test("a throwing runner reports an unreachable snapshot instead of rejecting", async () => {
  const service = new RemoteHostMetricsService(() => Promise.reject(new Error("probe timed out")));
  const metrics = await service.collect(validHost);
  assert.equal(metrics.hostId, "gpu-box");
  assert.equal(metrics.reachable, false);
  assert.equal(metrics.detail, "probe timed out");
});

test("a fresh cache entry answers without ssh; only force or an expired TTL re-probes", async () => {
  const { calls, runner } = fakeRunner({ code: 0, stdout: fullProbeStdout, stderr: "" });
  let currentTime = 10_000;
  const service = new RemoteHostMetricsService(runner, { now: () => currentTime });

  const first = await service.collect(validHost);
  assert.equal(calls.length, 1);

  const second = await service.collect(validHost);
  assert.equal(calls.length, 1, "a second collect inside the TTL must not re-invoke the runner");
  assert.deepEqual(second, first);

  currentTime += 4_999;
  await service.collect(validHost);
  assert.equal(calls.length, 1, "age just under minCacheMs is still fresh");

  currentTime += 1;
  await service.collect(validHost);
  assert.equal(calls.length, 2, "age reaching minCacheMs expires the entry");

  await service.collect(validHost, { force: true });
  assert.equal(calls.length, 3, "force bypasses a fresh entry");

  // minCacheMs 0 never counts as fresh: both collects ran.
  const zero = fakeRunner({ code: 0, stdout: "", stderr: "" });
  const zeroService = new RemoteHostMetricsService(zero.runner, { minCacheMs: 0 });
  await zeroService.collect(validHost);
  await zeroService.collect(validHost);
  assert.equal(zero.calls.length, 2);
});

test("an unreachable host is cached on the same TTL so a dead host is not hammered", async () => {
  const { calls, runner } = fakeRunner({
    code: 255,
    stdout: "",
    stderr: "ssh: connect to host gpu.internal.example port 22: Connection timed out"
  });
  let currentTime = 0;
  const service = new RemoteHostMetricsService(runner, { now: () => currentTime });

  await service.collect(validHost);
  await service.collect(validHost);
  assert.equal(calls.length, 1, "the unreachable result is served from cache");

  currentTime += 5_000;
  await service.collect(validHost);
  assert.equal(calls.length, 2, "the unreachable entry expires on the same TTL");
});

test("an invalid host never reaches the runner, and the rejection is not cached", async () => {
  const { calls, runner } = fakeRunner({ code: 0, stdout: fullProbeStdout, stderr: "" });
  const service = new RemoteHostMetricsService(runner, { now: () => 500 });

  const invalid = await service.collect({ ...validHost, sshHost: "gpu.internal.example rm -rf" });
  assert.equal(invalid.hostId, "gpu-box");
  assert.equal(invalid.reachable, false);
  assert.match(invalid.detail, /sshHost/);
  assert.equal(calls.length, 0);

  // The invalid rejection is not cached under the host id: a now-valid entry
  // with the same id reaches the runner immediately.
  const repaired = await service.collect(validHost);
  assert.equal(calls.length, 1);
  assert.equal(repaired.reachable, true);
});
