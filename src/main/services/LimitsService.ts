import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  LimitProviderId,
  LimitSource,
  LimitUnavailableReason,
  LimitWindow,
  LimitsSnapshot,
  ProviderLimitsSnapshot
} from "../../shared/contracts";
import {
  providerChildProcessLaunch,
  type AvailableProviderCli,
  type ProviderCliRegistry
} from "./providerCliRegistry.ts";

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_LINE_BYTES = 1_048_576;
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 2;
const MAX_WINDOWS = 12;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

interface CacheEntry {
  cachedAt: number;
  value: LimitsSnapshot;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

interface RawLimitBucket {
  snapshot: Record<string, unknown>;
  isDefaultBucket: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: LimitsAdapterError): void;
  timer: NodeJS.Timeout;
}

export class LimitsService {
  private readonly codex: CodexAppServerClient;
  private readonly kimi: KimiWebUsageClient;
  private readonly providerClis: ProviderCliRegistry;
  private readonly clientVersion: string;
  private cache: CacheEntry | null = null;
  private inFlight: Promise<LimitsSnapshot> | null = null;
  private lastGoodCodex: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private lastGoodClaude: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private lastGoodKimi: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private lastGoodOpenCode: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private lastGoodGrok: Extract<ProviderLimitsSnapshot, { state: "available" }> | null = null;
  private disposed = false;

  constructor(providerClis: ProviderCliRegistry, clientVersion = "unknown") {
    this.providerClis = providerClis;
    this.clientVersion = clientVersion;
    this.codex = new CodexAppServerClient(availableCli(providerClis, "codex"), clientVersion);
    this.kimi = new KimiWebUsageClient(availableCli(providerClis, "kimi"));
  }

  async get(): Promise<LimitsSnapshot> {
    const now = Date.now();
    if (this.cache && now - this.cache.cachedAt < CACHE_TTL_MS) {
      return structuredClone(this.cache.value);
    }

    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
    }

    return structuredClone(await this.inFlight);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.codex.dispose();
    this.kimi.dispose();
  }

  private async refresh(): Promise<LimitsSnapshot> {
    const checkedAt = Date.now();
    const [codex, claude, kimi, opencode, grok] = await Promise.all([
      this.loadCodex(checkedAt),
      this.loadClaude(checkedAt),
      this.loadKimi(checkedAt),
      this.loadOpenCode(checkedAt),
      this.loadGrok(checkedAt)
    ]);
    const value: LimitsSnapshot = {
      fetchedAt: Date.now(),
      providers: [codex, claude, kimi, opencode, grok]
    };

    this.cache = { cachedAt: Date.now(), value };
    return value;
  }

  private async loadCodex(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("codex").state === "unavailable") {
      return unavailable("codex", "codex-app-server", "cli-not-found", checkedAt);
    }
    if (this.disposed) {
      return unavailable("codex", "codex-app-server", "protocol-error", checkedAt);
    }

    try {
      const raw = await this.codex.readRateLimits();
      const windows = normalizeCodexLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("not-authenticated");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "codex",
        state: "available",
        source: "codex-app-server",
        fetchedAt: Date.now(),
        windows
      };
      this.lastGoodCodex = available;
      return available;
    } catch (error) {
      const reason = adapterReason(error);
      if (this.lastGoodCodex) {
        return {
          ...this.lastGoodCodex,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("codex", "codex-app-server", reason, checkedAt);
    }
  }

  private async loadClaude(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("claude").state === "unavailable") {
      return unavailable("claude", "claude-usage-api", "cli-not-found", checkedAt);
    }
    try {
      const raw = await readClaudeUsage(this.clientVersion);
      const windows = normalizeClaudeLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("protocol-error");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "claude",
        state: "available",
        source: "claude-usage-api",
        fetchedAt: Date.now(),
        windows
      };
      this.lastGoodClaude = available;
      return available;
    } catch (error) {
      const reason = adapterReason(error);
      if (this.lastGoodClaude) {
        return {
          ...this.lastGoodClaude,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("claude", "claude-usage-api", reason, checkedAt);
    }
  }

  private async loadKimi(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("kimi").state === "unavailable") {
      return unavailable("kimi", "kimi-usage-api", "cli-not-found", checkedAt);
    }
    try {
      const raw = await this.kimi.readUsage();
      const windows = normalizeKimiLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("protocol-error");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "kimi",
        state: "available",
        source: "kimi-usage-api",
        fetchedAt: Date.now(),
        windows
      };
      this.lastGoodKimi = available;
      return available;
    } catch (error) {
      const reason = adapterReason(error);
      if (this.lastGoodKimi) {
        return {
          ...this.lastGoodKimi,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("kimi", "kimi-usage-api", reason, checkedAt);
    }
  }

  private async loadOpenCode(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("opencode").state === "unavailable") {
      return unavailable("opencode", "opencode-go-usage-api", "cli-not-found", checkedAt);
    }
    try {
      const raw = await readOpenCodeGoUsage(this.clientVersion);
      const windows = normalizeOpenCodeGoLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("protocol-error");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "opencode",
        state: "available",
        source: "opencode-go-usage-api",
        fetchedAt: Date.now(),
        windows
      };
      this.lastGoodOpenCode = available;
      return available;
    } catch (error) {
      const reason = adapterReason(error);
      if (this.lastGoodOpenCode) {
        return {
          ...this.lastGoodOpenCode,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("opencode", "opencode-go-usage-api", reason, checkedAt);
    }
  }

  private async loadGrok(checkedAt: number): Promise<ProviderLimitsSnapshot> {
    if (this.providerClis.get("grok").state === "unavailable") {
      return unavailable("grok", "grok-billing-api", "cli-not-found", checkedAt);
    }
    try {
      const raw = await readGrokUsage(this.clientVersion);
      const windows = normalizeGrokLimits(raw);
      if (windows.length === 0) throw new LimitsAdapterError("protocol-error");

      const available: Extract<ProviderLimitsSnapshot, { state: "available" }> = {
        provider: "grok",
        state: "available",
        source: "grok-billing-api",
        fetchedAt: Date.now(),
        windows
      };
      this.lastGoodGrok = available;
      return available;
    } catch (error) {
      const reason = adapterReason(error);
      if (this.lastGoodGrok) {
        return {
          ...this.lastGoodGrok,
          state: "stale",
          failedAt: Date.now(),
          reason
        };
      }
      return unavailable("grok", "grok-billing-api", reason, checkedAt);
    }
  }
}

async function readClaudeUsage(clientVersion: string): Promise<unknown> {
  const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const credentials = await readCredentialFile(join(configRoot, ".credentials.json"), "subscription-required");
  const oauth = isRecord(credentials.claudeAiOauth) ? credentials.claudeAiOauth : null;
  const accessToken = cleanSecret(oauth?.accessToken);
  if (!accessToken) throw new LimitsAdapterError("subscription-required");

  return fetchUsageJson(CLAUDE_USAGE_URL, accessToken, {
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": `canvastty/${clientVersion}`
  });
}

async function readOpenCodeGoUsage(clientVersion: string): Promise<unknown> {
  const credentials = await readFirstCredentialFile(openCodeAuthPaths(), "subscription-required");
  const go = isRecord(credentials["opencode-go"]) ? credentials["opencode-go"] : null;
  const accessToken = cleanSecret(go?.key);
  if (!accessToken) throw new LimitsAdapterError("subscription-required");

  return fetchUsageJson(OPENCODE_GO_USAGE_URL, accessToken, {
    "user-agent": `canvastty/${clientVersion}`
  });
}

async function readGrokUsage(clientVersion: string): Promise<unknown> {
  const configRoot = process.env.GROK_HOME || join(homedir(), ".grok");
  const credentials = await readCredentialFile(join(configRoot, "auth.json"), "not-authenticated");
  const accessToken = selectGrokAccessToken(credentials);
  if (!accessToken) throw new LimitsAdapterError("not-authenticated");

  return fetchUsageJson(GROK_BILLING_URL, accessToken, {
    "x-xai-token-auth": "xai-grok-cli",
    "user-agent": `canvastty/${clientVersion}`
  });
}

function openCodeAuthPaths(): string[] {
  const paths: string[] = [];
  if (process.env.XDG_DATA_HOME) {
    paths.push(join(process.env.XDG_DATA_HOME, "opencode", "auth.json"));
  }
  if (process.platform === "darwin") {
    paths.push(join(homedir(), "Library", "Application Support", "opencode", "auth.json"));
  } else if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    paths.push(join(process.env.LOCALAPPDATA, "opencode", "auth.json"));
  }
  paths.push(join(homedir(), ".local", "share", "opencode", "auth.json"));
  return [...new Set(paths)];
}

async function readFirstCredentialFile(
  paths: readonly string[],
  missingReason: LimitUnavailableReason
): Promise<Record<string, unknown>> {
  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new LimitsAdapterError("protocol-error");
      return parsed;
    } catch (error) {
      if (error instanceof LimitsAdapterError) throw error;
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      if (code === "ENOENT" || code === "EACCES") continue;
      throw new LimitsAdapterError("protocol-error");
    }
  }
  throw new LimitsAdapterError(missingReason);
}

function selectGrokAccessToken(credentials: Record<string, unknown>): string | null {
  const candidates = Object.values(credentials)
    .filter(isRecord)
    .map((credential) => ({
      token: cleanSecret(credential.key),
      authMode: credential.auth_mode === "oidc" ? 1 : 0,
      expiresAt: numericValue(credential.expires_at) ?? 0
    }))
    .filter((candidate): candidate is { token: string; authMode: number; expiresAt: number } => candidate.token !== null)
    .sort((left, right) => right.authMode - left.authMode || right.expiresAt - left.expiresAt);
  return candidates[0]?.token ?? null;
}

async function readCredentialFile(path: string, missingReason: LimitUnavailableReason): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new LimitsAdapterError("protocol-error");
    return parsed;
  } catch (error) {
    if (error instanceof LimitsAdapterError) throw error;
    const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
    if (code === "ENOENT" || code === "EACCES") throw new LimitsAdapterError(missingReason);
    throw new LimitsAdapterError("protocol-error");
  }
}

async function fetchUsageJson(
  url: string,
  accessToken: string,
  additionalHeaders: Record<string, string> = {}
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...additionalHeaders
      },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw new LimitsAdapterError("not-authenticated");
    }
    if (!response.ok) throw new LimitsAdapterError("protocol-error");

    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_BUFFER_BYTES) throw new LimitsAdapterError("protocol-error");
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof LimitsAdapterError) throw error;
    if (controller.signal.aborted) throw new LimitsAdapterError("timeout");
    throw new LimitsAdapterError("protocol-error");
  } finally {
    clearTimeout(timer);
  }
}

function cleanSecret(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function availableCli(
  registry: ProviderCliRegistry,
  provider: LimitProviderId
): AvailableProviderCli | null {
  const resolution = registry.get(provider);
  return resolution.state === "available" ? resolution : null;
}

class KimiWebUsageClient {
  private readonly cli: AvailableProviderCli | null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private baseUrl: string | null = null;
  private token: string | null = null;
  private buffer = "";
  private disposed = false;

  constructor(cli: AvailableProviderCli | null) {
    this.cli = cli;
  }

  async readUsage(): Promise<unknown> {
    await this.ensureConnected();
    if (!this.baseUrl || !this.token) throw new LimitsAdapterError("protocol-error");
    try {
      return await fetchUsageJson(`${this.baseUrl}/api/v1/oauth/usage`, this.token);
    } catch (error) {
      this.resetConnection();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopChild();
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new LimitsAdapterError("protocol-error"));
    if (this.ready) return this.ready;
    this.ready = this.startChild().catch((error: unknown) => {
      this.resetConnection();
      throw error;
    });
    return this.ready;
  }

  private async startChild(): Promise<void> {
    if (!this.cli) throw new LimitsAdapterError("cli-not-found");
    const port = await reserveLoopbackPort();
    const launch = providerChildProcessLaunch(
      this.cli,
      ["web", "--no-open", "--port", String(port), "--log-level", "silent"]
    );
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, {
        shell: false,
        env: { ...process.env, ...launch.environment },
        stdio: ["pipe", "pipe", "pipe"],
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
      });
    } catch {
      throw new LimitsAdapterError("cli-not-found");
    }

    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.resume();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new LimitsAdapterError("timeout"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();

      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
      };
      const fail = (reason: LimitUnavailableReason): void => {
        cleanup();
        reject(new LimitsAdapterError(reason));
      };
      const onError = (error: NodeJS.ErrnoException): void => fail(error.code === "ENOENT" ? "cli-not-found" : "protocol-error");
      const onClose = (): void => fail("protocol-error");
      const onData = (chunk: string): void => {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > MAX_BUFFER_BYTES) {
          fail("protocol-error");
          return;
        }
        const match = this.buffer.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)\/#token=([A-Za-z0-9_-]+)/);
        if (!match) return;
        this.baseUrl = match[1];
        this.token = match[2];
        this.buffer = "";
        cleanup();
        resolve();
      };

      child.stdout.on("data", onData);
      child.once("error", onError);
      child.once("close", onClose);
    });

    child.once("error", () => this.resetConnection());
    child.once("close", () => this.resetConnection());
  }

  private resetConnection(): void {
    this.ready = null;
    this.baseUrl = null;
    this.token = null;
    this.stopChild();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    if (!child) return;
    child.removeAllListeners();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // The local provider process may already be gone.
    }
  }
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new LimitsAdapterError("protocol-error")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new LimitsAdapterError("protocol-error"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(new LimitsAdapterError("protocol-error"));
        else resolve(port);
      });
    });
  });
}

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private disposed = false;
  private readonly cli: AvailableProviderCli | null;
  private readonly clientVersion: string;

  constructor(cli: AvailableProviderCli | null, clientVersion: string) {
    this.cli = cli;
    this.clientVersion = clientVersion;
  }

  async readRateLimits(): Promise<unknown> {
    await this.ensureConnected();
    return this.request("account/rateLimits/read");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending("protocol-error");
    this.stopChild();
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new LimitsAdapterError("protocol-error"));
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
    if (!this.cli) throw new LimitsAdapterError("cli-not-found");
    const launch = providerChildProcessLaunch(
      this.cli,
      ["app-server", "--listen", "stdio://"]
    );
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, {
        shell: false,
        env: { ...process.env, ...launch.environment },
        stdio: ["pipe", "pipe", "pipe"],
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
      });
    } catch {
      throw new LimitsAdapterError("cli-not-found");
    }

    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
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
      return Promise.reject(new LimitsAdapterError("protocol-error"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LimitsAdapterError("timeout"));
        this.resetConnection();
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });

      if (!this.write({ id, method, ...(params === undefined ? {} : { params }) })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new LimitsAdapterError("protocol-error"));
        this.resetConnection();
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.write({ method, params })) {
      throw new LimitsAdapterError("protocol-error");
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

  private consume(chunk: string): void {
    if (this.disposed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_BUFFER_BYTES) {
      this.connectionFailed("protocol-error", this.child);
      return;
    }

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.connectionFailed("protocol-error", this.child);
        return;
      }
      this.consumeLine(line);
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
      pending.reject(new LimitsAdapterError("protocol-error"));
      return;
    }
    pending.resolve(message.result);
  }

  private connectionFailed(reason: LimitUnavailableReason, child: ChildProcessWithoutNullStreams | null): void {
    if (child && child !== this.child) return;
    this.rejectPending(reason);
    this.resetConnection();
  }

  private rejectPending(reason: LimitUnavailableReason): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new LimitsAdapterError(reason));
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
    this.buffer = "";
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

class LimitsAdapterError extends Error {
  readonly reason: LimitUnavailableReason;

  constructor(reason: LimitUnavailableReason) {
    super(reason);
    this.reason = reason;
  }
}

function adapterReason(error: unknown): LimitUnavailableReason {
  return error instanceof LimitsAdapterError ? error.reason : "protocol-error";
}

function unavailable(
  provider: LimitProviderId,
  source: LimitSource,
  reason: LimitUnavailableReason,
  checkedAt: number
): ProviderLimitsSnapshot {
  return { provider, state: "unavailable", source, checkedAt, reason };
}

export function normalizeOpenCodeGoLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw) || !isRecord(raw.usage)) throw new LimitsAdapterError("protocol-error");
  const usage = raw.usage;
  const definitions: Array<{
    key: "rolling" | "weekly" | "monthly";
    slot: "primary" | "secondary";
    label: string;
    windowMinutes: number | null;
  }> = [
    { key: "rolling", slot: "primary", label: "5h", windowMinutes: 300 },
    { key: "weekly", slot: "secondary", label: "7d", windowMinutes: 10_080 },
    { key: "monthly", slot: "secondary", label: "monthly", windowMinutes: null }
  ];

  return definitions.flatMap(({ key, slot, label, windowMinutes }) => {
    const candidate = usage[key];
    if (!isRecord(candidate)) return [];
    const usedPercent = numericValue(candidate.percent);
    const resetsAt = epochMilliseconds(candidate.resetsAt);
    if (usedPercent === null && resetsAt === null) return [];
    return [{
      id: `opencode-go:${key}`,
      bucketId: "opencode-go",
      slot,
      isDefaultBucket: true,
      label,
      usedPercent: usedPercent === null ? null : clampPercent(usedPercent),
      used: null,
      limit: null,
      windowMinutes,
      resetsAt
    }];
  });
}

export function normalizeGrokLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw)) throw new LimitsAdapterError("protocol-error");
  const config = isRecord(raw.config) ? raw.config : raw;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const usedPercent = numericValue(config.creditUsagePercent);
  const startsAt = epochMilliseconds(period.start ?? config.billingPeriodStart);
  const resetsAt = epochMilliseconds(period.end ?? config.billingPeriodEnd);
  if (usedPercent === null && resetsAt === null) return [];

  const rawWindowMinutes = startsAt !== null && resetsAt !== null
    ? Math.round((resetsAt - startsAt) / 60_000)
    : null;
  const windowMinutes = rawWindowMinutes !== null && rawWindowMinutes > 0 ? rawWindowMinutes : null;
  const periodType = typeof period.type === "string" ? period.type.toLowerCase() : "period";
  const isWeekly = periodType.includes("week") || windowMinutes === 10_080;

  return [{
    id: isWeekly ? "grok:weekly" : `grok:${cleanId(periodType) ?? "period"}`,
    bucketId: "grok",
    slot: "secondary",
    isDefaultBucket: true,
    label: windowMinutes === null ? null : formatWindowLabel(windowMinutes),
    usedPercent: usedPercent === null ? null : clampPercent(usedPercent),
    used: null,
    limit: null,
    windowMinutes,
    resetsAt
  }];
}

export function normalizeClaudeLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw)) throw new LimitsAdapterError("protocol-error");
  const source = isRecord(raw.rate_limits) ? raw.rate_limits : raw;
  const definitions: Array<{
    key: string;
    slot: "primary" | "secondary";
    label: string;
    windowMinutes: number;
  }> = [
    { key: "five_hour", slot: "primary", label: "5h", windowMinutes: 300 },
    { key: "seven_day", slot: "secondary", label: "7d", windowMinutes: 10_080 }
  ];

  return definitions.flatMap(({ key, slot, label, windowMinutes }) => {
    const candidate = source[key];
    if (!isRecord(candidate)) return [];
    const usedPercent = numericValue(candidate.used_percentage) ?? numericValue(candidate.utilization);
    const resetsAt = epochMilliseconds(candidate.resets_at);
    if (usedPercent === null && resetsAt === null) return [];
    return [{
      id: `claude:${key}`,
      bucketId: "claude",
      slot,
      isDefaultBucket: true,
      label,
      usedPercent: usedPercent === null ? null : clampPercent(usedPercent),
      used: null,
      limit: null,
      windowMinutes,
      resetsAt
    }];
  });
}

export function normalizeKimiLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw)) throw new LimitsAdapterError("protocol-error");
  const payload = isRecord(raw.data) ? raw.data : raw;
  if (payload.kind === "error") {
    const message = typeof payload.message === "string" ? payload.message.toLowerCase() : "";
    throw new LimitsAdapterError(message.includes("auth") || message.includes("login") ? "not-authenticated" : "protocol-error");
  }
  const windows: LimitWindow[] = [];
  const managedSummary = payload.summary;
  if (isRecord(managedSummary) && isRecord(managedSummary.window)) {
    const windowMinutes = durationToMinutes(
      positiveNumericValue(managedSummary.window.duration),
      managedSummary.window.unit
    );
    const limit = positiveNumericValue(managedSummary.limit);
    const used = numericValue(managedSummary.used);
    const resetsAt = epochMilliseconds(managedSummary.reset_at);
    if (windowMinutes !== null && (limit !== null || used !== null || resetsAt !== null)) {
      windows.push({
        id: windowMinutes >= 10_080 ? "kimi:weekly" : `kimi:managed:${windowMinutes}`,
        bucketId: "kimi",
        slot: windowMinutes >= 10_080 ? "secondary" : "primary",
        isDefaultBucket: true,
        label: formatWindowLabel(windowMinutes),
        usedPercent: usagePercent(used, limit),
        used,
        limit,
        windowMinutes,
        resetsAt
      });
    }
  }

  const weekly = payload.usage;
  if (isRecord(weekly)) {
    const limit = positiveNumericValue(weekly.limit);
    const used = numericValue(weekly.used);
    const resetsAt = epochMilliseconds(weekly.resetTime);
    if (limit !== null || used !== null || resetsAt !== null) {
      windows.push({
        id: "kimi:weekly",
        bucketId: "kimi",
        slot: "secondary",
        isDefaultBucket: true,
        label: "7d",
        usedPercent: usagePercent(used, limit),
        used,
        limit,
        windowMinutes: 10_080,
        resetsAt
      });
    }
  }

  if (Array.isArray(payload.limits)) {
    for (const [index, candidate] of payload.limits.entries()) {
      if (!isRecord(candidate) || !isRecord(candidate.window)) continue;
      const duration = positiveNumericValue(candidate.window.duration);
      const windowMinutes = durationToMinutes(duration, candidate.window.timeUnit ?? candidate.window.unit);
      const detail = isRecord(candidate.detail) ? candidate.detail : candidate;
      const limit = positiveNumericValue(detail.limit);
      const remaining = numericValue(detail.remaining);
      const explicitUsed = numericValue(detail.used);
      const used = explicitUsed ?? (limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null);
      const resetsAt = epochMilliseconds(detail.resetTime ?? detail.reset_at);
      if (windowMinutes === null || (limit === null && used === null && resetsAt === null)) continue;
      windows.push({
        id: `kimi:rolling:${windowMinutes}:${index}`,
        bucketId: "kimi",
        slot: "primary",
        isDefaultBucket: true,
        label: formatWindowLabel(windowMinutes),
        usedPercent: usagePercent(used, limit),
        used,
        limit,
        windowMinutes,
        resetsAt
      });
      if (windows.length >= MAX_WINDOWS) break;
    }
  }

  return windows.slice(0, MAX_WINDOWS);
}

export function normalizeCodexLimits(raw: unknown): LimitWindow[] {
  if (!isRecord(raw)) throw new LimitsAdapterError("protocol-error");
  const hasRateLimits = Object.prototype.hasOwnProperty.call(raw, "rateLimits");
  const hasRateLimitsMap = Object.prototype.hasOwnProperty.call(raw, "rateLimitsByLimitId");
  if (!hasRateLimits && !hasRateLimitsMap) throw new LimitsAdapterError("protocol-error");

  const snapshots = new Map<string, RawLimitBucket>();
  addSnapshot(snapshots, raw.rateLimits, "codex", true);
  if (isRecord(raw.rateLimitsByLimitId)) {
    for (const [key, value] of Object.entries(raw.rateLimitsByLimitId)) {
      addSnapshot(snapshots, value, key, false);
    }
  }

  const windows: LimitWindow[] = [];
  for (const [limitId, bucket] of snapshots) {
    const { snapshot, isDefaultBucket } = bucket;
    const label = cleanLabel(snapshot.limitName);
    const primary = normalizeWindow(snapshot.primary, limitId, "primary", label, isDefaultBucket);
    const secondary = normalizeWindow(snapshot.secondary, limitId, "secondary", label, isDefaultBucket);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    if (windows.length >= MAX_WINDOWS) break;
  }
  return windows.slice(0, MAX_WINDOWS);
}

function addSnapshot(
  snapshots: Map<string, RawLimitBucket>,
  candidate: unknown,
  fallbackId: string,
  isDefaultBucket: boolean
): void {
  if (!isRecord(candidate)) return;
  const id = cleanId(candidate.limitId) ?? cleanId(fallbackId);
  if (!id || snapshots.has(id)) return;
  snapshots.set(id, { snapshot: candidate, isDefaultBucket });
}

function normalizeWindow(
  raw: unknown,
  bucketId: string,
  slot: "primary" | "secondary",
  label: string | null,
  isDefaultBucket: boolean
): LimitWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = finiteNumber(raw.usedPercent);
  const windowMinutes = positiveNumber(raw.windowDurationMins);
  const resetsAt = epochMilliseconds(raw.resetsAt);
  if (usedPercent === null && windowMinutes === null && resetsAt === null) return null;

  return {
    id: `${bucketId}:${slot}`,
    bucketId,
    slot,
    isDefaultBucket,
    label,
    usedPercent: usedPercent === null ? null : Math.min(100, Math.max(0, usedPercent)),
    used: null,
    limit: null,
    windowMinutes,
    resetsAt
  };
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  return cleaned || null;
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  return cleaned || null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumericValue(value: unknown): number | null {
  const number = numericValue(value);
  return number !== null && number > 0 ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function epochMilliseconds(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  const milliseconds = number < 1_000_000_000_000 ? number * 1_000 : number;
  return Number.isSafeInteger(Math.trunc(milliseconds)) ? Math.trunc(milliseconds) : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function usagePercent(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return clampPercent((used / limit) * 100);
}

function durationToMinutes(duration: number | null, unit: unknown): number | null {
  if (duration === null || typeof unit !== "string") return null;
  const normalizedUnit = unit.toLowerCase();
  const multiplier = unit === "TIME_UNIT_MINUTE" || normalizedUnit === "minute"
    ? 1
    : unit === "TIME_UNIT_HOUR" || normalizedUnit === "hour"
      ? 60
      : unit === "TIME_UNIT_DAY" || normalizedUnit === "day"
        ? 1_440
        : unit === "TIME_UNIT_WEEK" || normalizedUnit === "week"
          ? 10_080
          : null;
  return multiplier === null ? null : duration * multiplier;
}

function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes % 10_080 === 0) return `${windowMinutes / 10_080}w`;
  if (windowMinutes % 1_440 === 0) return `${windowMinutes / 1_440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
