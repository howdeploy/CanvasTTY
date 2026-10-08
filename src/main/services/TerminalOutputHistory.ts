import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TerminalOutputContext, TerminalOutputSearchResult } from "../../shared/contracts.ts";

export interface TerminalOutputRedactionSnapshot {
  revision: number;
  values: string[];
}

export interface TerminalHistoryRecoverySnapshot {
  sessionId: string;
  buffer: string;
  outputOffset: number;
}

interface WorkerReply { requestId: number; ok: boolean; value?: unknown; error?: string }
interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void }
interface OutboundBatch { worker: ChildProcess; requestId: number; items: object[]; dataChars: number; promise: Promise<unknown> }
export interface TerminalOutputHistoryOptions {
  /**
   * A private directory for the worker's crash-recovery spill: output encrypted with a key held only in this
   * process's memory, bounded like the in-memory history, wiped on a fresh start and on close.
   */
  spillDirectory?: string;
}

function historyWorkerEnvironment(): NodeJS.ProcessEnv {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
  };
}

const MAX_QUEUED_CHARS = 8_000_000;
const MAX_IPC_BATCH_REQUESTS = 64;
const MAX_IPC_BATCH_DATA_CHARS = 256_000;
// A 50M UTF-16 history plus masked search caches kept the output worker's RSS
// hundreds of megabytes above startup. Keep the worker's raw and recovery
// budgets aligned so a restart cannot briefly recreate the old peak.
const MAX_RECOVERY_CHARS = 16_000_000;
const MAX_RECOVERY_SESSIONS = 1_024;

/** Read newest tails first without copying data the worker would immediately prune. */
export function collectTerminalHistoryRecoverySnapshots(
  sessionIds: string[],
  readBuffer: (sessionId: string, maxChars: number) => { buffer: string; outputOffset: number },
  maxChars = MAX_RECOVERY_CHARS
): TerminalHistoryRecoverySnapshot[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > MAX_RECOVERY_CHARS) throw new Error("Invalid terminal history recovery limit.");
  if (sessionIds.length > MAX_RECOVERY_SESSIONS || sessionIds.some(id => !validId(id))) throw new Error("Unsupported terminal history recovery session count or IDs.");
  let remaining = maxChars;
  const snapshots: TerminalHistoryRecoverySnapshot[] = [];
  for (const sessionId of [...sessionIds].reverse()) {
    try {
      const snapshot = readBuffer(sessionId, remaining);
      const buffer = remaining > 0 ? snapshot.buffer.slice(-remaining) : "";
      remaining -= buffer.length;
      // Keep offsets even when no tail fits: omitted live sessions must report a history gap.
      snapshots.push({ sessionId, buffer, outputOffset: snapshot.outputOffset });
    } catch { /* A card may have been removed immediately before recovery. */ }
  }
  return snapshots.reverse();
}

/**
 * Bounded output history for search and context reads. Raw text reaches disk only encrypted, under a key that never
 * leaves this process's memory (the optional crash-recovery spill); only the trusted worker can materialize a
 * complete masked copy, using the host registry snapshot for the current revision.
 */
export class TerminalOutputHistory {
  private worker: ChildProcess | null = null;
  private emptyWorkerTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private outbound: OutboundBatch | null = null;
  private outboundFlush: NodeJS.Immediate | null = null;
  private readonly spillDirectory: string | null;
  private readonly spillKey = randomBytes(32);
  private readonly gapPending = new Set<string>();
  private readonly activeSessionIds = new Set<string>();
  private nextRequestId = 1;
  private queuedChars = 0;
  private closed = false;
  private needsRecovery = false;
  private generation = 0;
  private secretsRevision = -1;
  private readonly getRedactionSnapshot: () => TerminalOutputRedactionSnapshot;
  private readonly getRecoverySnapshots: () => TerminalHistoryRecoverySnapshot[];

  constructor(getRedactionSnapshot: () => TerminalOutputRedactionSnapshot,
    getRecoverySnapshots: () => TerminalHistoryRecoverySnapshot[] = () => [], options: TerminalOutputHistoryOptions = {}) {
    this.getRedactionSnapshot = getRedactionSnapshot;
    this.getRecoverySnapshots = getRecoverySnapshots;
    this.spillDirectory = typeof options.spillDirectory === "string" && options.spillDirectory ? options.spillDirectory : null;
  }

  /** Append a raw PTY batch in FIFO order. Duplicate startup snapshots are discarded by absolute source offset. */
  append(sessionId: string, data: string, outputOffset: number): Promise<void> {
    this.assertOpen();
    if (!validId(sessionId) || typeof data !== "string" || data.length > 1_000_000 || !Number.isSafeInteger(outputOffset) || outputOffset < 0) {
      return Promise.reject(new Error("Invalid terminal output history chunk."));
    }
    if (this.gapPending.has(sessionId)) return Promise.resolve();
    if (this.queuedChars + data.length > MAX_QUEUED_CHARS) {
      this.gapPending.add(sessionId);
      const work = this.request("gap", { sessionId, outputOffset });
      const generation = this.generation;
      return work.then(() => undefined).finally(() => { if (generation === this.generation) this.gapPending.delete(sessionId); });
    }
    this.queuedChars += data.length;
    const work = this.request("append", { sessionId, data, outputOffset });
    const generation = this.generation;
    return work
      .then(() => undefined)
      .finally(() => { if (generation === this.generation) this.queuedChars = Math.max(0, this.queuedChars - data.length); });
  }

  remove(sessionId: string): Promise<void> {
    if (!validId(sessionId)) return Promise.resolve();
    this.gapPending.delete(sessionId);
    return this.request("remove", { sessionId }).then(() => undefined);
  }

  async search(query: string, sessionIds?: string[]): Promise<TerminalOutputSearchResult> {
    this.assertOpen();
    if (query.length > 200 || !query.trim()) return { matches: [], prunedSessionIds: [] };
    if (sessionIds && (sessionIds.length > 256 || sessionIds.some((id) => !validId(id)))) throw new Error("Invalid terminal output search scope.");
    await this.syncRedactionSnapshot();
    return await this.request("search", { query, sessionIds: sessionIds ?? null }) as TerminalOutputSearchResult;
  }

  async readContext(sessionId: string, offset: number): Promise<TerminalOutputContext> {
    this.assertOpen();
    if (!validId(sessionId) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid terminal output context request.");
    await this.syncRedactionSnapshot();
    return await this.request("context", { sessionId, offset }) as TerminalOutputContext;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearEmptyWorkerTimer();
    this.clearOutboundQueue();
    const worker = this.worker;
    if (!worker) {
      if (this.spillDirectory) await rm(this.spillDirectory, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    const error = new Error("Terminal output history is shutting down.");
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    await stopWorker(worker);
    this.worker = null;
    if (this.spillDirectory) await rm(this.spillDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async syncRedactionSnapshot(): Promise<void> {
    this.ensureWorker();
    const worker = this.worker;
    const snapshot = this.redactionSnapshot();
    if (snapshot.revision === this.secretsRevision) return;
    await this.request("secrets", { revision: snapshot.revision, values: snapshot.values });
    if (this.worker === worker) this.secretsRevision = snapshot.revision;
  }

  private redactionSnapshot(): TerminalOutputRedactionSnapshot {
    const snapshot = this.getRedactionSnapshot();
    if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.values)
      || snapshot.values.length > 32_768 || snapshot.values.some((value) => typeof value !== "string" || value.length > 65_536)) {
      throw new Error("Terminal output redaction is unavailable.");
    }
    return snapshot;
  }

  private request(type: string, data: Record<string, unknown>): Promise<unknown> {
    if (this.closed && type !== "close") return Promise.reject(new Error("Terminal output history is closed."));
    let worker: ChildProcess;
    try {
      this.ensureWorker();
      if (!this.worker) throw new Error("Terminal output history worker could not start.");
      worker = this.worker;
      this.clearEmptyWorkerTimer();
      if ((type === "append" || type === "gap") && typeof data.sessionId === "string") this.activeSessionIds.add(data.sessionId);
      else if (type === "remove" && typeof data.sessionId === "string") this.activeSessionIds.delete(data.sessionId);
    }
    catch (error) { return Promise.reject(error instanceof Error ? error : new Error("Terminal output history worker could not start.")); }
    if (type === "append" || type === "gap" || type === "remove") return this.enqueue(worker, { type, ...data });
    // Queries and snapshots go after every queued write, as one message each.
    this.flushOutbound(worker);
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.sendNow(worker, { requestId, type, ...data });
    });
  }

  /**
   * Writes travel in batches that share one acknowledgement: a busy terminal produces many small PTY chunks, and a
   * reply, a pending entry and a promise per chunk cost more than the chunk itself.
   */
  private enqueue(worker: ChildProcess, item: Record<string, unknown>): Promise<unknown> {
    const dataChars = typeof item.data === "string" ? item.data.length : 0;
    if (this.outbound && (this.outbound.worker !== worker || this.outbound.dataChars + dataChars > MAX_IPC_BATCH_DATA_CHARS)) this.flushOutbound(this.outbound.worker);
    if (!this.outbound) {
      const requestId = this.nextRequestId++;
      const promise = new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
      this.outbound = { worker, requestId, items: [], dataChars: 0, promise };
      this.scheduleOutboundFlush();
    }
    const batch = this.outbound;
    batch.items.push(item);
    batch.dataChars += dataChars;
    if (batch.items.length >= MAX_IPC_BATCH_REQUESTS || batch.dataChars >= MAX_IPC_BATCH_DATA_CHARS) this.flushOutbound(worker);
    return batch.promise;
  }

  private ensureWorker(): void {
    if (this.worker) return;
    this.assertOpen();
    const recovering = this.needsRecovery;
    const snapshots = recovering ? this.getRecoverySnapshots() : [];
    if (!Array.isArray(snapshots) || snapshots.length > MAX_RECOVERY_SESSIONS || snapshots.some(snapshot =>
      !validId(snapshot.sessionId) || typeof snapshot.buffer !== "string" || snapshot.buffer.length > 1_000_000
      || !Number.isSafeInteger(snapshot.outputOffset) || snapshot.outputOffset < snapshot.buffer.length)) {
      throw new Error("Terminal history recovery snapshots are invalid.");
    }
    const path = workerEntryPath();
    const redaction = this.redactionSnapshot();
    const worker = fork(path, [], {
      // Direct Node tests can fork the source .ts worker on Node versions that require this flag.
      // Electron production loads the built .js worker instead.
      execArgv: [
        ...(path.endsWith(".ts") ? ["--experimental-strip-types"] : []),
        // Raw history lives outside the V8 heap; keep the heap itself compact instead of fast-growing.
        "--optimize-for-size",
        "--max-old-space-size=128",
        "--max-semi-space-size=2"
      ],
      env: historyWorkerEnvironment(),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced"
    });
    this.worker = worker;
    if (recovering) {
      this.activeSessionIds.clear();
      for (const snapshot of snapshots) this.activeSessionIds.add(snapshot.sessionId);
    }
    worker.on("message", (reply: WorkerReply | WorkerReply[]) => {
      if (this.worker !== worker) return;
      for (const item of Array.isArray(reply) ? reply : [reply]) this.onReply(item);
    });
    worker.on("error", (error) => this.fail(worker, error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", (code) => {
      if (!this.closed) this.fail(worker, new Error(`Terminal output history worker exited (${code ?? 1}).`));
    });
    this.needsRecovery = false;
    this.secretsRevision = redaction.revision;
    // A fresh start wipes an earlier run's spill; a restart after a crash reads it back first.
    if (this.spillDirectory) this.sendNow(worker, { requestId: 0, type: "spill", directory: this.spillDirectory, key: this.spillKey, recover: recovering });
    this.sendNow(worker, { requestId: 0, type: "secrets", revision: redaction.revision, values: redaction.values });
    // FIFO messages seed recent PTY tails before queries; positive source offsets mark lost history.
    let remaining = MAX_RECOVERY_CHARS;
    const bounded = snapshots.map(snapshot => ({ ...snapshot }));
    for (let index = bounded.length - 1; index >= 0; index--) {
      const snapshot = bounded[index]!;
      snapshot.buffer = remaining > 0 ? snapshot.buffer.slice(-remaining) : "";
      remaining -= snapshot.buffer.length;
    }
    for (const snapshot of bounded) this.sendNow(worker, { requestId: 0, type: "append", sessionId: snapshot.sessionId,
      data: snapshot.buffer, outputOffset: snapshot.outputOffset });
  }

  private onReply(reply: WorkerReply): void {
    if (!reply || !Number.isSafeInteger(reply.requestId)) return;
    const entry = this.pending.get(reply.requestId);
    if (!entry) return;
    this.pending.delete(reply.requestId);
    if (!reply.ok) entry.reject(new Error(typeof reply.error === "string" ? reply.error : "Terminal output history request failed."));
    else entry.resolve(reply.value);
    this.scheduleEmptyWorkerTermination();
  }

  private scheduleOutboundFlush(): void {
    if (this.outboundFlush) return;
    const scheduled = setImmediate(() => {
      if (this.outboundFlush !== scheduled) return;
      this.outboundFlush = null;
      if (this.outbound) this.flushOutbound(this.outbound.worker);
    });
    this.outboundFlush = scheduled;
  }

  private flushOutbound(worker: ChildProcess): void {
    const batch = this.outbound;
    if (!batch || batch.worker !== worker) return;
    if (this.outboundFlush) clearImmediate(this.outboundFlush);
    this.outboundFlush = null;
    this.outbound = null;
    if (this.worker !== worker) return;
    this.sendNow(worker, { requestId: batch.requestId, type: "batch", items: batch.items });
  }

  private sendNow(worker: ChildProcess, message: object): void {
    if (this.worker !== worker) return;
    if (!worker.connected) {
      this.fail(worker, new Error("Terminal output history process is disconnected."));
      return;
    }
    try {
      worker.send(message, error => { if (error) this.fail(worker, error); });
    } catch (reason) {
      this.fail(worker, reason instanceof Error ? reason : new Error("Terminal output history worker rejected a request."));
    }
  }

  private clearOutboundQueue(): void {
    if (this.outboundFlush) clearImmediate(this.outboundFlush);
    this.outboundFlush = null;
    this.outbound = null;
  }

  private fail(worker: ChildProcess, error: Error): void {
    if (this.worker !== worker) return;
    this.clearEmptyWorkerTimer();
    this.clearOutboundQueue();
    this.worker = null;
    this.needsRecovery = true;
    this.generation++;
    this.secretsRevision = -1;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.queuedChars = 0;
    this.gapPending.clear();
    void stopWorker(worker);
  }

  private scheduleEmptyWorkerTermination(): void {
    this.clearEmptyWorkerTimer();
    if (this.activeSessionIds.size > 0 || this.pending.size > 0 || !this.worker || this.closed) return;
    const worker = this.worker;
    this.emptyWorkerTimer = setTimeout(() => {
      this.emptyWorkerTimer = null;
      if (this.worker !== worker || this.activeSessionIds.size > 0 || this.pending.size > 0 || this.closed) return;
      // Keep full history searchable while any session remains. Once every session has been removed and
      // the worker is quiescent, its raw and masked heaps have no remaining user-visible value.
      this.worker = null;
      this.needsRecovery = true;
      this.secretsRevision = -1;
      void stopWorker(worker);
    }, 0);
    this.emptyWorkerTimer.unref();
  }

  private clearEmptyWorkerTimer(): void {
    if (!this.emptyWorkerTimer) return;
    clearTimeout(this.emptyWorkerTimer);
    this.emptyWorkerTimer = null;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Terminal output history is closed.");
  }
}

function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }

function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const onExit = (): void => resolve();
    worker.once("exit", onExit);
    try {
      if (!worker.kill()) {
        worker.removeListener("exit", onExit);
        resolve();
      }
    } catch {
      worker.removeListener("exit", onExit);
      resolve();
    }
  });
}

function workerEntryPath(): string {
  // electron-vite emits the dedicated worker beside out/main/index.js; direct Node tests run the source .ts file.
  const built = fileURLToPath(new URL("./TerminalOutputHistoryWorker.js", import.meta.url));
  if (existsSync(built)) return built;
  const source = fileURLToPath(new URL("./TerminalOutputHistoryWorker.ts", import.meta.url));
  if (existsSync(source)) return source;
  throw new Error("Terminal output history worker entry is missing.");
}
