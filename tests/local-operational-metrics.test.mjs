import assert from "node:assert/strict";
import test from "node:test";
import { LocalOperationalMetricsService } from "../src/main/services/LocalOperationalMetrics.ts";

test("local operational metrics are on-demand aggregates, with no terminal content or egress", () => {
  let calls = 0;
  const service = new LocalOperationalMetricsService({
    now: () => 123,
    sessions: () => { calls++; return [{ exitCode: null }, { exitCode: null, hostId: "remote" }, { exitCode: 0 }, { exitCode: null }]; },
    processMetrics: () => [{ cpuPercent: 1.5, workingSetKb: 4096 }, { cpuPercent: 2.25, workingSetKb: 1024 }],
    system: () => ({ load1: 0.25, cores: 4, memoryTotalMb: 16384, memoryAvailableMb: 8192 })
  });
  assert.equal(calls, 0);
  assert.deepEqual(service.collect(), { collectedAt: 123, activeSessions: 3, activeLocalSessions: 2, activeRemoteSessions: 1, cpuPercent: 3.75, memoryWorkingSetMb: 5, load1: 0.25, cores: 4, memoryTotalMb: 16384, memoryAvailableMb: 8192 });
  assert.equal(calls, 1);
});

test("missing process metrics stay unknown rather than report zero use", () => {
  const service = new LocalOperationalMetricsService({ sessions: () => [], processMetrics: () => [] });
  assert.equal(service.collect().cpuPercent, null);
  assert.equal(service.collect().memoryWorkingSetMb, null);
  const broken = new LocalOperationalMetricsService({ sessions: () => [], processMetrics: () => { throw new Error("unavailable"); } });
  assert.equal(broken.collect().cpuPercent, null);
});
