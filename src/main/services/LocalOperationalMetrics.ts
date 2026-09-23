import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { LocalOperationalMetrics } from "../../shared/contracts.ts";

interface Sources {
  sessions(): readonly { exitCode: number | null; hostId?: string }[];
  /** Electron's process measurements, reduced before entering this service. */
  processMetrics(): readonly { cpuPercent: number; workingSetKb: number }[];
  now?(): number;
  system?(): Pick<LocalOperationalMetrics, "load1" | "cores" | "memoryTotalMb" | "memoryAvailableMb">;
}

/** Collect only when requested. No timer, IPC push, subprocess, or network use. */
export class LocalOperationalMetricsService {
  private readonly sources: Sources;
  constructor(sources: Sources) { this.sources = sources; }
  collect(): LocalOperationalMetrics {
    const active = this.sources.sessions().filter((session) => session.exitCode === null);
    const local = active.filter((session) => session.hostId === undefined).length;
    let processMetrics: ReturnType<Sources["processMetrics"]> = [];
    try { processMetrics = this.sources.processMetrics(); } catch { /* unsupported platform */ }
    const sum = (key: "cpuPercent" | "workingSetKb"): number | null => processMetrics.length > 0
      && processMetrics.every((metric) => Number.isFinite(metric[key]) && metric[key] >= 0)
      ? processMetrics.reduce((total, metric) => total + metric[key], 0) : null;
    const memoryKb = sum("workingSetKb");
    const system = this.sources.system?.() ?? {
      load1: loadavg()[0] ?? null, cores: cpus().length,
      memoryTotalMb: Math.round(totalmem() / 1048576), memoryAvailableMb: Math.round(freemem() / 1048576)
    };
    return { collectedAt: this.sources.now?.() ?? Date.now(), activeSessions: active.length,
      activeLocalSessions: local, activeRemoteSessions: active.length - local,
      cpuPercent: sum("cpuPercent"), memoryWorkingSetMb: memoryKb === null ? null : memoryKb / 1024, ...system };
  }
}
