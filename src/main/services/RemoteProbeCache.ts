import type { RemoteHost } from "../../shared/contracts.ts";

/** No timers or background work. All callers share a bounded FIFO transport pool. */
export class ProbeLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;
  private readonly maxQueued: number;
  constructor(limit = 8, maxQueued = 8192) {
    this.limit = limit;
    this.maxQueued = maxQueued;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid probe concurrency.");
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxQueued) throw new Error("Remote probe queue is full; retry later.");
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export const remoteProbeLimiter = new ProbeLimiter();

export interface ProbeCacheOptions { minCacheMs?: number; now?: () => number; maxEntries?: number }

/** Cache only observed facts, never session counts or policy decisions. In-flight
 * reads coalesce even for forced refreshes. Completed and pending maps are bounded. */
export class ProbeCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>();
  private readonly pending = new Map<string, Promise<T>>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxEntries: number;
  constructor(options: ProbeCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.minCacheMs ?? 5000;
    this.maxEntries = options.maxEntries ?? 512;
  }
  read(key: string, work: () => Promise<T>, force = false): Promise<T> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const cached = this.entries.get(key);
    if (!force && cached && this.now() - cached.at < this.ttl) return Promise.resolve(structuredClone(cached.value));
    if (this.pending.size >= this.maxEntries) return Promise.reject(new Error("Too many remote probes are pending; retry later."));
    const promise = Promise.resolve().then(work).then((value) => {
      this.entries.delete(key);
      this.entries.set(key, { at: this.now(), value: structuredClone(value) });
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}

/** Explicit, stable identity includes SSH destination and all host policy/mapping
 * fields; editing a record under its existing id cannot reuse the old facts. */
export function remoteProbeKey(host: RemoteHost, scope: unknown = null): string {
  return JSON.stringify([host.id, host.sshHost, host.sshUser ?? null, host.sshPort ?? null,
    host.priority ?? null, host.maxSessions ?? null, host.minFreeMemoryMb ?? null,
    host.maxLoadPerCore ?? null, host.maxDataClass ?? null,
    host.providerAccess?.mode ?? null, host.providerAccess?.providers ?? null,
    host.workspaces?.map(({ localPath, remotePath }) => [localPath, remotePath]) ?? null, scope]);
}
