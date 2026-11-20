import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { SecretRedactionRegistry } from "./safety/SecretRedaction";
import type { DiagnosticAttachment } from "../../shared/contracts";

const compress = promisify(gzip);
const MAX_FILE_BYTES = 1024 * 1024;
const FILE_COUNT = 4;
const originalConsole = {
  log: console.log.bind(console), info: console.info.bind(console),
  warn: console.warn.bind(console), error: console.error.bind(console)
};

export class DiagnosticLog {
  readonly runId = randomUUID();
  private readonly secrets = new SecretRedactionRegistry();
  private additionalRedaction: (text: string) => string = text => text;
  private queue: Promise<void>;
  private bytes = 0;
  private pending = 0;
  private dropped = 0;
  private storageFailed = false;

  constructor(private readonly directory: string) {
    this.secrets.add("diagnostics-environment", Object.entries(process.env)
      .filter(([key]) => /key|token|secret|password|authorization|cookie/i.test(key))
      .map(([, value]) => value ?? ""));
    this.queue = mkdir(directory, { recursive: true, mode: 0o700 }).then(async () => {
      this.bytes = await stat(this.file(0)).then(value => value.size).catch(() => 0);
    }).catch(error => this.storageError(error));
  }

  configureRedaction(redact: (text: string) => string): void { this.additionalRedaction = redact; }

  private file(index: number): string { return join(this.directory, index === 0 ? "application.jsonl" : `application.${index}.jsonl`); }

  private redact(text: string): string {
    return this.additionalRedaction(this.secrets.redact(text))
      .replace(/canvasduo:\/\/[A-Za-z0-9_-]+/gi, "<duo-invitation>")
      .replaceAll(this.directory, "<logs>").replaceAll(homedir(), "<home>");
  }

  sanitize(value: unknown, depth = 0, budget = { nodes: 512 }): unknown {
    if (depth > 5 || --budget.nodes < 0) return "<truncated>";
    if (value instanceof Error) return {
      name: value.name, message: this.redact(value.message).slice(0, 4096),
      stack: this.redact(value.stack ?? "").slice(0, 8192),
      ...(typeof (value as NodeJS.ErrnoException).code === "string" ? { code: (value as NodeJS.ErrnoException).code } : {})
    };
    if (typeof value === "string") return this.redact(value).slice(0, 8192);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 40).map(item => this.sanitize(item, depth + 1, budget));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
      this.redact(key).slice(0, 256), /api[_-]?key|token|secret|password|authorization|cookie|^key$|^hostKey$|^guestSeed$|^invites?$|^invitation$|^env$|prompt|messages|^args$|stdout|stderr|buffer/i.test(key)
        ? "<redacted>" : this.sanitize(item, depth + 1, budget)
    ]));
    return null;
  }

  record(level: "info" | "warn" | "error", scope: string, event: string, details?: unknown): void {
    if (this.pending >= 256) { this.dropped += 1; return; }
    let line: string;
    try {
      line = JSON.stringify({ at: new Date().toISOString(), runId: this.runId, level, scope, event,
        ...(details === undefined ? {} : { details: this.sanitize(details) }),
        ...(this.dropped ? { dropped: this.dropped } : {}) }) + "\n";
      if (Buffer.byteLength(line) > 64 * 1024) {
        line = JSON.stringify({ at: new Date().toISOString(), runId: this.runId, level, scope, event,
          details: "<event exceeds 64 KiB>", dropped: this.dropped }) + "\n";
      }
    } catch { this.dropped += 1; return; }
    this.dropped = 0;
    this.pending += 1;
    this.queue = this.queue.then(async () => {
      const length = Buffer.byteLength(line);
      if (this.bytes + length > MAX_FILE_BYTES) {
        await rm(this.file(FILE_COUNT - 1), { force: true });
        for (let index = FILE_COUNT - 2; index >= 0; index -= 1) {
          await rename(this.file(index), this.file(index + 1)).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        }
        this.bytes = 0;
      }
      await appendFile(this.file(0), line, { mode: 0o600 });
      this.bytes += length;
    }).catch(error => this.storageError(error)).finally(() => { this.pending -= 1; });
  }

  captureConsole(): void {
    for (const method of ["log", "info", "warn", "error"] as const) {
      console[method] = (...values: unknown[]): void => {
        originalConsole[method](...values);
        this.record(method === "warn" || method === "error" ? method : "info", "main", `console.${method}`, values);
      };
    }
  }

  private storageError(error: unknown): void {
    if (!this.storageFailed) originalConsole.warn("CanvasTTY diagnostics could not be written.", error);
    this.storageFailed = true;
  }

  async flush(): Promise<void> { await this.queue; }

  async report(description: string, context: unknown, attachment?: DiagnosticAttachment): Promise<{ reportId: string; body: Buffer }> {
    const reportId = randomUUID();
    this.record("info", "diagnostics", "report.prepared", { reportId });
    await this.flush();
    // Serialize the snapshot with rotation so files cannot move while they are being read.
    const snapshot = this.queue.then(async () => {
      const logs: { name: string; content: string }[] = [];
      for (let index = FILE_COUNT - 1; index >= 0; index -= 1) {
        const content = await readFile(this.file(index), "utf8").catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (content !== null) logs.push({ name: index === 0 ? "application.jsonl" : `application.${index}.jsonl`, content: this.redact(content) });
      }
      return logs;
    });
    this.queue = snapshot.then(() => undefined, error => this.storageError(error));
    const logs = await snapshot;
    const body = await compress(Buffer.from(JSON.stringify({ formatVersion: 1, reportId,
      createdAt: new Date().toISOString(), runId: this.runId, description: this.sanitize(description),
      context: this.sanitize(context), logs, storageFailed: this.storageFailed, dropped: this.dropped,
      ...(attachment ? { attachment } : {}) })));
    return { reportId, body };
  }
}
