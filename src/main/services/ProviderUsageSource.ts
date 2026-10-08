import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

export interface ProviderUsage {
  total: number;
  input: number | null;
  output: number | null;
  model?: string;
}

interface CachedUsage { signature: string; value: ProviderUsage }
interface WorkerUsageResult { usage?: ProviderUsage | null; signature?: string; unchanged?: boolean }

const READ_TIMEOUT_MS = 2_000;
const MAX_ROLLOUT_BYTES = 1024 * 1024;
const MAX_ROLLOUT_LINE_CHARS = 256 * 1024;

/**
 * Read only published numeric counters from the local Codex index and rollout.
 * Rollout JSON is parsed inside a bounded worker; message and transcript text
 * never crosses the worker boundary.
 */
export class ProviderUsageSource {
  private readonly home: string;
  private readonly pending = new Map<string, Promise<ProviderUsage | null>>();
  private readonly cache = new Map<string, CachedUsage>();

  constructor(codexHome: string) { this.home = resolve(codexHome); }

  codexUsage(threadId: string): Promise<ProviderUsage | null> {
    if (!/^[\w-]{1,160}$/.test(threadId)) return Promise.resolve(null);
    const current = this.pending.get(threadId);
    if (current) return current;

    const cached = this.cache.get(threadId);
    const read = this.read(threadId, cached?.signature).then((result) => {
      if (result?.unchanged && cached) return cached.value;
      if (!result?.usage || !result.signature) {
        this.cache.delete(threadId);
        return null;
      }
      this.cache.set(threadId, { signature: result.signature, value: result.usage });
      return result.usage;
    }).catch(() => null).finally(() => this.pending.delete(threadId));
    this.pending.set(threadId, read);
    return read;
  }

  /** Compatibility for callers that only consume the CLI's aggregate count. */
  async codexTotal(threadId: string): Promise<number | null> {
    return (await this.codexUsage(threadId))?.total ?? null;
  }

  private async read(threadId: string, previousSignature?: string): Promise<WorkerUsageResult | null> {
    const files = (await readdir(this.home)).filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!files[0]) return null;
    const database = join(this.home, files[0]);
    const home = await realpath(this.home);

    return new Promise((resolveResult) => {
      const worker = new Worker(CODEX_USAGE_WORKER, {
        eval: true,
        workerData: { database, home, threadId, previousSignature, maxRolloutBytes: MAX_ROLLOUT_BYTES, maxLineChars: MAX_ROLLOUT_LINE_CHARS }
      });
      let finished = false;
      const finish = (value: WorkerUsageResult | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        void worker.terminate();
        resolveResult(value);
      };
      const timer = setTimeout(() => finish(null), READ_TIMEOUT_MS);
      worker.once("message", (value: unknown) => finish(isWorkerUsageResult(value) ? value : null));
      worker.once("error", () => finish(null));
      worker.once("exit", () => finish(null));
    });
  }
}

/** Kept self-contained so every database and rollout operation stays off the main thread. */
const CODEX_USAGE_WORKER = `
(() => {
  const { parentPort, workerData } = require("node:worker_threads");
  const { DatabaseSync } = require("node:sqlite");
  const fs = require("node:fs");
  const path = require("node:path");

  function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  function safeModel(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 200
      && !/[\\u0000-\\u001f\\u007f]/u.test(value) ? value.trim() || null : null;
  }
  function pathInsideHome(file) {
    return path.isAbsolute(file) ? path.resolve(file) : path.resolve(workerData.home, file);
  }
  function readLatestCounters(file) {
    const descriptor = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(descriptor).size;
      const length = Math.min(size, workerData.maxRolloutBytes);
      const buffer = Buffer.alloc(length);
      if (length) fs.readSync(descriptor, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      const lines = text.split(String.fromCharCode(10));
      if (size > length) lines.shift(); // Do not parse a partial JSON record at the range boundary.
      let model;
      let usage = null;
      for (const line of lines) {
        if (line.length > workerData.maxLineChars || !line.includes("token_count") && !line.includes("turn_context")) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const payload = event && typeof event === "object" ? event.payload : null;
        if (event?.type === "turn_context" || payload?.type === "turn_context") {
          const context = payload?.type === "turn_context" ? payload : payload ?? event;
          model = safeModel(context.model ?? context.model_slug ?? context.modelName ?? event.model) ?? model;
        }
        if (event?.type !== "event_msg" && event?.type !== "token_count" && payload?.type !== "token_count") continue;
        const info = payload?.info ?? event?.info;
        const totalUsage = info?.total_token_usage ?? payload?.total_token_usage ?? event?.total_token_usage;
        if (!totalUsage || typeof totalUsage !== "object") continue;
        const input = safeCount(totalUsage.input_tokens);
        const output = safeCount(totalUsage.output_tokens);
        const reportedTotal = safeCount(totalUsage.total_tokens);
        const total = reportedTotal ?? (input !== null && output !== null ? safeCount(input + output) : null);
        if (total !== null) usage = { total, input, output };
      }
      return { usage, size, modified: fs.fstatSync(descriptor).mtimeMs, model };
    } finally { fs.closeSync(descriptor); }
  }

  let db;
  try {
    db = new DatabaseSync(workerData.database, { readOnly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 500");
    const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
    if (!columns.has("id")) throw new Error("Codex thread index is unavailable.");
    const selected = ["id", "tokens_used", "model", "rollout_path", "updated_at", "updated_at_ms"]
      .filter((column) => columns.has(column)).map((column) => '"' + column + '"');
    const row = db.prepare("SELECT " + selected.join(",") + " FROM threads WHERE id = ? LIMIT 1").get(workerData.threadId);
    db.close();
    db = null;
    if (!row) { parentPort.postMessage(null); return; }

    const databaseTotal = safeCount(row.tokens_used);
    let rollout = null;
    let fileSignature = "";
    if (typeof row.rollout_path === "string" && row.rollout_path.length <= 4096) {
      const candidate = pathInsideHome(row.rollout_path);
      if (candidate) {
        try {
          // Both sides use the OS resolver, as the host's realpath() does: the JavaScript resolver keeps
          // Windows 8.3 short names (RUNNER~1) and drive-letter case, so a file inside the home looked outside it.
          const realHome = fs.realpathSync.native(workerData.home);
          const realFile = fs.realpathSync.native(candidate);
          if (realFile.startsWith(realHome + path.sep)) {
            const info = fs.statSync(realFile);
            fileSignature = JSON.stringify([row.updated_at_ms ?? row.updated_at ?? null, databaseTotal, row.model ?? null, realFile, info.size, info.mtimeMs]);
            if (workerData.previousSignature === fileSignature) {
              parentPort.postMessage({ unchanged: true, signature: fileSignature });
              return;
            }
            rollout = readLatestCounters(realFile);
          }
        } catch { /* The aggregate SQLite counter remains usable if the rollout has moved or is unavailable. */ }
      }
    }

    const total = rollout?.usage?.total ?? databaseTotal;
    if (total === null) { parentPort.postMessage(null); return; }
    const model = safeModel(rollout?.model) ?? safeModel(row.model);
    const value = {
      total,
      input: rollout?.usage?.input ?? null,
      output: rollout?.usage?.output ?? null,
      ...(model ? { model } : {})
    };
    const signature = fileSignature || JSON.stringify([row.updated_at_ms ?? row.updated_at ?? null, databaseTotal, row.model ?? null, row.rollout_path ?? null]);
    parentPort.postMessage({ usage: value, signature });
  } catch {
    try { db?.close(); } catch { /* The worker has already failed. */ }
    parentPort.postMessage(null);
  }
})();
`;

function isWorkerUsageResult(value: unknown): value is WorkerUsageResult {
  if (!value || typeof value !== "object") return false;
  const result = value as WorkerUsageResult;
  if (result.unchanged === true) return typeof result.signature === "string";
  if (!result.usage || typeof result.signature !== "string") return false;
  const { total, input, output, model } = result.usage;
  return Number.isSafeInteger(total) && total >= 0
    && (input === null || Number.isSafeInteger(input) && input >= 0)
    && (output === null || Number.isSafeInteger(output) && output >= 0)
    && (model === undefined || typeof model === "string" && model.length <= 200);
}
