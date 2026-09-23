import { remoteHostInvalidReason } from "../../shared/contracts.ts";
import type { RemoteHost } from "../../shared/contracts";
import type { RemoteHostRunner } from "./RemoteHostsService.ts";

// Light utilization metrics for one remote host, answered with a single ssh
// round-trip whenever a caller asks (Host UI opening, auto-placement, the
// active-session loop). There is deliberately NO polling, NO timer, NO
// daemon here: collect() runs ssh only, and a short cache keeps repeated
// caller-driven asks from hammering the host — a dead host is cached on the
// same TTL so it is not retried on every question either.

/** Utilization snapshot for one remote host at one point in time. */
export interface RemoteHostMetrics {
  hostId: string;
  collectedAt: number;
  reachable: boolean;
  load1: number | null;
  cores: number | null;
  memoryTotalMb: number | null;
  memoryAvailableMb: number | null;
  gpuVramTotalMb: number | null;
  gpuVramUsedMb: number | null;
  detail?: string;
}

/** Constructor knobs; every field is injectable so tests need no clock or network. */
export interface RemoteHostMetricsOptions {
  /** How long a cached entry stays fresh. Defaults to 5 seconds. */
  minCacheMs?: number;
  /** Clock source for cache aging. Defaults to Date.now. */
  now?: () => number;
  /** Per-invocation ssh timeout. Defaults to 10 seconds. */
  timeoutMs?: number;
}

const DEFAULT_MIN_CACHE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DETAIL_MAX_LENGTH = 300;

// Inert by design: constructing the service spawns nothing and starts no
// timer. Each collect() that misses the cache runs exactly one ssh
// invocation; collect() calls that hit it run none.
export class RemoteHostMetricsService {
  private readonly run: RemoteHostRunner;
  private readonly minCacheMs: number;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, RemoteHostMetrics>();

  constructor(runner: RemoteHostRunner, options: RemoteHostMetricsOptions = {}) {
    this.run = runner;
    this.minCacheMs = options.minCacheMs ?? DEFAULT_MIN_CACHE_MS;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async collect(host: RemoteHost, options: { force?: boolean } = {}): Promise<RemoteHostMetrics> {
    const hostId = host && typeof host === "object" && typeof (host as { id?: unknown }).id === "string"
      ? (host as { id: string }).id
      : "unknown";
    // An invalid host never reaches the runner. The rejection is also not
    // cached: fixing the host entry should take effect on the next collect,
    // and skipping ssh made answering cheap enough not to need a cache.
    const invalidReason = remoteHostInvalidReason(host);
    if (invalidReason !== null) {
      return unreachable(hostId, this.now(), invalidReason);
    }
    const cached = this.cache.get(hostId);
    if (!options.force && cached !== undefined && this.now() - cached.collectedAt < this.minCacheMs) {
      return cached;
    }
    let metrics: RemoteHostMetrics;
    try {
      const { code, stdout, stderr } = await this.run(
        host,
        [`sh -lc '${remoteMetricsScript()}'`],
        this.timeoutMs
      );
      if (code !== 0) {
        metrics = unreachable(
          hostId,
          this.now(),
          excerpt(stderr) || `ssh exited with code ${code === null ? "unknown" : code}`
        );
      } else {
        const values = parseLabelledLines(stdout);
        metrics = {
          hostId,
          collectedAt: this.now(),
          reachable: true,
          load1: nonNegativeFloat(values.get("load1")),
          cores: nonNegativeInteger(values.get("cores")),
          memoryTotalMb: kbToMb(values.get("mem_total_kb")),
          memoryAvailableMb: kbToMb(values.get("mem_available_kb")),
          gpuVramTotalMb: mb(values.get("gpu_vram_total_mb")),
          gpuVramUsedMb: mb(values.get("gpu_vram_used_mb"))
        };
      }
    } catch (error) {
      metrics = unreachable(hostId, this.now(), excerpt(error instanceof Error ? error.message : String(error)));
    }
    // Unreachable results are cached too, on the same TTL, so a dead host is
    // not hammered once per question while the cache would otherwise only
    // cover successes.
    this.cache.set(hostId, metrics);
    return metrics;
  }
}

// The probe script: POSIX sh, no single quotes anywhere (the whole thing is
// wrapped in one single-quoted `sh -lc` argument — printf's usual '%s\n'
// spelling included would terminate that quoting remotely), every section
// guarded so a missing file or tool degrades to an omitted line instead of
// failing the probe, and an unconditional `exit 0` so a reachable host
// always reports reachable. The TS parser treats any omitted or unparsable
// line as null.
function remoteMetricsScript(): string {
  return [
    // load1: first field of /proc/loadavg, falling back to the 1-minute
    // average parsed out of `uptime` (the third field from the end on both
    // Linux and macOS; parseFloat on the TS side eats any trailing comma).
    'lv=$(awk "{print \\$1}" /proc/loadavg 2>/dev/null || true)',
    'if [ -n "$lv" ]; then printf "load1=%s\\n" "$lv"',
    'else u=$(uptime 2>/dev/null || true)',
    'if [ -n "$u" ]; then lu=$(printf "%s\\n" "$u" | awk "{print \\$(NF-2)}" 2>/dev/null || true)',
    'if [ -n "$lu" ]; then printf "load1=%s\\n" "$lu"; fi; fi; fi',
    // cores: getconf first (glibc, musl, macOS), nproc (coreutils) as fallback;
    // anything non-numeric emits no line at all.
    'n=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)',
    'if [ -z "$n" ]; then n=$(nproc 2>/dev/null || true); fi',
    'case "$n" in ""|*[!0-9]*) : ;; *) printf "cores=%s\\n" "$n" ;; esac',
    // memory: both figures out of /proc/meminfo, one awk pass, kb per line.
    'awk "/^MemTotal:/{print \\"mem_total_kb=\\" \\$2} /^MemAvailable:/{print \\"mem_available_kb=\\" \\$2}" /proc/meminfo 2>/dev/null || true',
    // GPU: only attempted when nvidia-smi exists, summed across GPUs; a
    // missing binary, a driverless machine, or a failing query all emit
    // nothing and never fail the probe.
    'if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits 2>/dev/null | awk -F, "NR>0{t+=\\$1; u+=\\$2; c+=1} END{if(c>0){print \\"gpu_vram_total_mb=\\" t; print \\"gpu_vram_used_mb=\\" u}}" || true; fi',
    'exit 0'
  ].join("; ");
}

// Parses `key=value` lines; anything else (login banners, profile noise,
// empty values) is ignored. Every occurrence of a key is kept in order so a
// field parser can skip a garbled first report and take the next parseable
// one instead of losing the field entirely.
function parseLabelledLines(stdout: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (value.length === 0) continue;
    const occurrences = values.get(key);
    if (occurrences === undefined) {
      values.set(key, [value]);
    } else {
      occurrences.push(value);
    }
  }
  return values;
}

// parseFloat tolerates trailing junk ("0.28," from uptime); the isFinite
// guard turns actual garbage into null, never NaN. Among several reports
// of one field, the first parseable one wins.
function nonNegativeFloat(raw: string[] | undefined): number | null {
  if (raw === undefined) return null;
  for (const candidate of raw) {
    const value = Number.parseFloat(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function nonNegativeInteger(raw: string[] | undefined): number | null {
  const value = nonNegativeFloat(raw);
  return value !== null && Number.isInteger(value) ? value : null;
}

function kbToMb(raw: string[] | undefined): number | null {
  const kb = nonNegativeFloat(raw);
  return kb === null ? null : Math.round(kb / 1024);
}

function mb(raw: string[] | undefined): number | null {
  const value = nonNegativeFloat(raw);
  return value === null ? null : Math.round(value);
}

function unreachable(hostId: string, collectedAt: number, detail: string): RemoteHostMetrics {
  return {
    hostId,
    collectedAt,
    reachable: false,
    load1: null,
    cores: null,
    memoryTotalMb: null,
    memoryAvailableMb: null,
    gpuVramTotalMb: null,
    gpuVramUsedMb: null,
    detail
  };
}

function excerpt(value: string): string {
  return value.trim().slice(0, DETAIL_MAX_LENGTH);
}
