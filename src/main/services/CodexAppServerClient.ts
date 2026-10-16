import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { providerChildProcessLaunch, type AvailableProviderCli } from "./providerCliRegistry.ts";
import { NdjsonLineReader } from "../../agent-runtime/ndjson.mjs";

const MAX_LINE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 15_000;
type CodexAppServerErrorReason = "cli-not-found" | "protocol-error" | "timeout";
interface JsonRpcResponse { id?: unknown; result?: unknown; error?: unknown }
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: CodexAppServerError): void;
  timer: NodeJS.Timeout;
}
export class CodexAppServerError extends Error {
  readonly reason: CodexAppServerErrorReason;
  constructor(reason: CodexAppServerErrorReason) { super(reason); this.reason = reason; }
}

/** Shared bounded stdio transport. No provider credentials or RPC error bodies are logged. */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly cli: AvailableProviderCli | null;
  private readonly clientVersion: string;
  private readonly idleMs: number;
  private readonly cwd: string | undefined;

  constructor(cli: AvailableProviderCli | null, clientVersion: string, idleMs: number, cwd?: string) {
    this.cli = cli;
    this.clientVersion = clientVersion;
    this.idleMs = idleMs;
    this.cwd = cwd;
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    this.clearIdleTimer();
    try {
      await this.ensureConnected();
      return await this.request(method, params);
    } finally {
      this.scheduleIdleStop();
    }
  }

  /** Drops the current app-server so the next read starts one with the current login and configuration. */
  restart(): void {
    if (this.disposed) return;
    this.resetConnection();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    this.rejectPending("protocol-error");
    this.stopChild();
  }

  /** Stops the app-server once no read came for `idleMs`; the next read starts it again. */
  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    if (this.disposed || !this.child || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.resetConnection();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new CodexAppServerError("protocol-error"));
    if (this.ready) return this.ready;

    this.startChild();
    this.ready = this.request("initialize", {
      clientInfo: { name: "canvastty", version: this.clientVersion }
    }).then(() => {
      this.notify("initialized", {});
    }).catch((error: unknown) => {
      this.resetConnection();
      throw error;
    });
    return this.ready;
  }

  private startChild(): void {
    if (!this.cli) throw new CodexAppServerError("cli-not-found");
    const launch = providerChildProcessLaunch(
      this.cli,
      ["app-server", "--listen", "stdio://"]
    );
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, {
        shell: false,
        ...(this.cwd ? { cwd: this.cwd } : {}),
        env: { ...process.env, ...launch.environment },
        stdio: ["pipe", "pipe", "pipe"],
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
      });
    } catch {
      throw new CodexAppServerError("cli-not-found");
    }

    this.child = child;
    const lines = new NdjsonLineReader({ maxLineBytes: MAX_LINE_BYTES });
    child.stdout.on("data", (chunk: Buffer) => this.consume(child, lines, chunk));
    child.stdin.on("error", () => this.connectionFailed("protocol-error", child));
    child.stderr.resume();
    child.once("error", (error: NodeJS.ErrnoException) => {
      this.connectionFailed(error.code === "ENOENT" ? "cli-not-found" : "protocol-error", child);
    });
    child.once("close", () => this.connectionFailed("protocol-error", child));
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable || this.disposed) {
      return Promise.reject(new CodexAppServerError("protocol-error"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError("timeout"));
        this.resetConnection();
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });

      if (!this.write({ id, method, ...(params === undefined ? {} : { params }) })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CodexAppServerError("protocol-error"));
        this.resetConnection();
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.write({ method, params })) {
      throw new CodexAppServerError("protocol-error");
    }
  }

  private write(message: object): boolean {
    const child = this.child;
    if (!child || !child.stdin.writable || this.disposed) return false;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return false;
    try {
      child.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  private consume(child: ChildProcessWithoutNullStreams, lines: NdjsonLineReader, chunk: Buffer): void {
    if (this.disposed || child !== this.child) return;
    let complete: Buffer[];
    try {
      complete = lines.push(chunk);
    } catch {
      this.connectionFailed("protocol-error", child);
      return;
    }
    for (const raw of complete) {
      if (child !== this.child) return;
      const line = raw.toString("utf8").trim();
      if (line) this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.connectionFailed("protocol-error", this.child);
      return;
    }

    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error !== undefined) {
      pending.reject(new CodexAppServerError("protocol-error"));
      return;
    }
    pending.resolve(message.result);
  }

  private connectionFailed(reason: CodexAppServerErrorReason, child: ChildProcessWithoutNullStreams | null): void {
    if (child && child !== this.child) return;
    this.rejectPending(reason);
    this.resetConnection();
  }

  private rejectPending(reason: CodexAppServerErrorReason): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerError(reason));
    }
    this.pending.clear();
  }

  private resetConnection(): void {
    this.ready = null;
    this.rejectPending("protocol-error");
    this.stopChild();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;

    child.removeAllListeners("error");
    child.removeAllListeners("close");
    child.stdout.removeAllListeners("data");
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // The process may already be gone.
    }

    if (child.exitCode === null && child.signalCode === null) {
      const hardKillTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // Best-effort hardening during shutdown.
        }
      }, 500);
      hardKillTimer.unref();
    }
  }
}
