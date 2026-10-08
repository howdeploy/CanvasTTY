import { randomUUID } from "node:crypto";
import * as electron from "electron";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { GithubDeviceFlowState } from "../../shared/contracts";

/** GitHub OAuth Device Flow for the plugin showcase. */

export interface GithubAuthStatus {
  configured: boolean;
  authorized: boolean;
  login: string | null;
  tokenExpiresAt: number | null;
  deviceFlowState: GithubDeviceFlowState;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  login: string;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

type GithubFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubAuthServiceOptions {
  fetcher?: GithubFetcher;
  safeStorage?: SafeStorageLike;
  now?: () => number;
  delay?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  pollTimeoutMs?: number;
}

declare const __CANVASTTY_GITHUB_OAUTH_CLIENT_ID__: string | undefined;

const AUTH_STORE_FILE = "github-oauth.json";
const DEVICE_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Public OAuth app identifier baked into official builds by electron-vite. */
const DEFAULT_OAUTH_CLIENT_ID = typeof __CANVASTTY_GITHUB_OAUTH_CLIENT_ID__ === "string"
  ? __CANVASTTY_GITHUB_OAUTH_CLIENT_ID__
  : "";

export class GithubAuthService {
  private readonly storePath: string;
  private tokens: StoredTokens | null = null;
  private readonly clientId: string;
  private refreshPromise: Promise<string | null> | null = null;
  private readonly fetcher: GithubFetcher;
  private readonly secureStorage: SafeStorageLike | null;
  private readonly now: () => number;
  private readonly wait: (durationMs: number, signal: AbortSignal) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private generation = 0;
  private deviceFlow: { generation: number; controller: AbortController } | null = null;
  private deviceFlowState: GithubDeviceFlowState = "idle";
  private storeWrite = Promise.resolve();

  constructor(userDataPath: string, clientId?: string, options: GithubAuthServiceOptions = {}) {
    this.storePath = join(userDataPath, AUTH_STORE_FILE);
    this.clientId = clientId !== undefined
      ? clientId.trim()
      : process.env.GITHUB_OAUTH_CLIENT_ID?.trim()
        || process.env.CANVASTTY_GITHUB_CLIENT_ID?.trim()
        || DEFAULT_OAUTH_CLIENT_ID.trim();
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.secureStorage = options.safeStorage ?? electron.safeStorage ?? null;
    this.now = options.now ?? Date.now;
    this.wait = options.delay ?? abortableDelay;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEVICE_POLL_TIMEOUT_MS;
  }

  get clientConfigured(): boolean {
    return this.clientId.length > 0;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || typeof parsed.data !== "string") return;
      if (!this.secureStorage?.isEncryptionAvailable()) {
        console.warn("CanvasTTY GitHub OAuth: OS keychain unavailable; stored session skipped.");
        return;
      }
      const decrypted = this.secureStorage.decryptString(Buffer.from(parsed.data, "base64"));
      const tokens: unknown = JSON.parse(decrypted);
      if (!isRecord(tokens)) return;
      const accessToken = typeof tokens.accessToken === "string" ? tokens.accessToken : null;
      const refreshToken = typeof tokens.refreshToken === "string" ? tokens.refreshToken : null;
      const expiresAt = typeof tokens.expiresAt === "number" && Number.isFinite(tokens.expiresAt)
        ? tokens.expiresAt
        : null;
      const login = typeof tokens.login === "string" ? tokens.login : null;
      if (!accessToken || !login) return;
      this.tokens = { accessToken, refreshToken, expiresAt, login };
    } catch (error) {
      if (!isMissingFile(error)) {
        console.warn("CanvasTTY GitHub OAuth session could not be restored.", error);
      }
    }
  }

  async getToken(): Promise<string | null> {
    const current = this.tokens;
    if (!current) return null;
    if (current.expiresAt === null || this.now() < current.expiresAt - 60_000) return current.accessToken;
    if (!current.refreshToken) return null;
    if (!this.refreshPromise) {
      const generation = this.generation;
      const refresh = this.refreshAccessToken(current, generation);
      this.refreshPromise = refresh;
      void refresh.finally(() => {
        if (this.refreshPromise === refresh) this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async status(): Promise<GithubAuthStatus> {
    if (!this.tokens) {
      return {
        configured: this.clientConfigured,
        authorized: false,
        login: null,
        tokenExpiresAt: null,
        deviceFlowState: this.deviceFlowState
      };
    }
    return {
      configured: this.clientConfigured,
      authorized: true,
      login: this.tokens.login,
      tokenExpiresAt: this.tokens.expiresAt,
      deviceFlowState: this.deviceFlowState
    };
  }

  async startDeviceFlow(): Promise<{
    userCode: string;
    verificationUri: string;
    interval: number;
    expiresAt: number;
  }> {
    if (!this.clientConfigured) {
      throw new Error("GitHub OAuth is not configured (missing client id).");
    }

    this.cancelDeviceFlow();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.deviceFlow = { generation, controller };
    this.deviceFlowState = "pending";

    try {
      const body = new URLSearchParams({ client_id: this.clientId });
      const response = await this.request("https://github.com/login/device/code", {
        method: "POST",
        headers: oauthHeaders(),
        body: body.toString()
      }, controller.signal);
      if (!response.ok) throw new Error(`GitHub device flow failed with HTTP ${response.status}.`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.device_code !== "string" || typeof payload.user_code !== "string") {
        throw new Error("GitHub device flow returned an invalid response.");
      }
      if (!this.isCurrentFlow(generation, controller.signal)) throw abortedError();

      const deviceCode = payload.device_code;
      const userCode = payload.user_code;
      const verificationUri = githubVerificationUri(payload.verification_uri);
      const interval = typeof payload.interval === "number" && payload.interval > 0 ? payload.interval : 5;
      const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0
        ? payload.expires_in
        : this.pollTimeoutMs / 1000;
      const flowLifetimeMs = Math.min(expiresIn * 1000, this.pollTimeoutMs);

      void this.pollDeviceCode(deviceCode, interval, flowLifetimeMs, generation, controller.signal)
        .catch(() => {
          if (!controller.signal.aborted) {
            this.finishDeviceFlow(generation, "failed");
            console.warn("CanvasTTY GitHub OAuth device poll failed.");
          }
        })
        .finally(() => {
          if (this.deviceFlow?.generation === generation) this.deviceFlow = null;
        });

      return { userCode, verificationUri, interval, expiresAt: this.now() + flowLifetimeMs };
    } catch (error) {
      if (this.deviceFlow?.generation === generation) {
        this.deviceFlow = null;
        this.deviceFlowState = "failed";
      }
      throw error;
    }
  }

  cancelDeviceFlow(): void {
    const flow = this.deviceFlow;
    if (!flow || this.deviceFlowState !== "pending") return;
    // Invalidate the generation before aborting so a fetcher that ignores its
    // AbortSignal cannot apply a late denial or token response to this flow.
    this.generation += 1;
    this.deviceFlow = null;
    this.deviceFlowState = "cancelled";
    flow.controller.abort();
  }

  async signOut(): Promise<void> {
    this.generation += 1;
    const flow = this.deviceFlow;
    this.deviceFlow = null;
    if (this.deviceFlowState === "pending") this.deviceFlowState = "cancelled";
    flow?.controller.abort();
    this.tokens = null;
    this.refreshPromise = null;
    await this.enqueueStoreWrite(async () => {
      await rm(this.storePath, { force: true });
    });
  }

  private isCurrentFlow(generation: number, signal: AbortSignal): boolean {
    return !signal.aborted && this.generation === generation && this.deviceFlow?.generation === generation;
  }

  private async pollDeviceCode(
    deviceCode: string,
    initialInterval: number,
    lifetimeMs: number,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    const started = this.now();
    let interval = initialInterval;
    while (this.now() - started < lifetimeMs) {
      await this.wait(interval * 1000, signal);
      if (!this.isCurrentFlow(generation, signal)) return;
      if (this.now() - started >= lifetimeMs) {
        this.finishDeviceFlow(generation, "expired");
        return;
      }

      const body = new URLSearchParams({
        client_id: this.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      });
      // A dropped connection, the 15 s request timeout or a GitHub 5xx is not
      // the end of the flow: the person may still approve the code. Back off
      // (RFC 8628 section 3.5) and poll again until the code expires.
      let payload: unknown;
      try {
        const response = await this.request("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: oauthHeaders(),
          body: body.toString()
        }, signal);
        if (!response.ok) {
          interval = backedOff(interval);
          continue;
        }
        payload = await response.json();
      } catch (error) {
        if (signal.aborted) throw error;
        interval = backedOff(interval);
        continue;
      }
      if (!this.isCurrentFlow(generation, signal)) return;
      if (!isRecord(payload)) {
        this.finishDeviceFlow(generation, "failed");
        return;
      }
      if (payload.error === "authorization_pending" || payload.error === "slow_down") {
        if (payload.error === "slow_down") {
          // +5 s for this and later polls; GitHub may name a longer interval.
          const requested = typeof payload.interval === "number" && Number.isFinite(payload.interval) ? payload.interval : 0;
          interval = Math.max(interval + 5, Math.min(requested, MAX_POLL_INTERVAL_SECONDS));
        }
        continue;
      }
      if (payload.error === "access_denied") {
        this.finishDeviceFlow(generation, "denied");
        return;
      }
      if (payload.error === "expired_token") {
        this.finishDeviceFlow(generation, "expired");
        return;
      }
      if (typeof payload.access_token === "string") {
        const login = await this.fetchLogin(payload.access_token, signal);
        if (!this.isCurrentFlow(generation, signal)) return;
        if (!login) {
          this.finishDeviceFlow(generation, "failed");
          return;
        }
        const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0
          ? payload.expires_in
          : null;
        const next: StoredTokens = {
          accessToken: payload.access_token,
          refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
          expiresAt: expiresIn === null ? null : this.now() + expiresIn * 1000,
          login
        };
        this.tokens = next;
        this.deviceFlowState = "idle";
        await this.persist(next, generation);
        return;
      }
      this.finishDeviceFlow(generation, "failed");
      return;
    }
    this.finishDeviceFlow(generation, "expired");
  }

  private finishDeviceFlow(generation: number, state: GithubDeviceFlowState): void {
    if (this.deviceFlow?.generation !== generation || this.deviceFlowState !== "pending") return;
    this.deviceFlowState = state;
  }

  private async refreshAccessToken(expected: StoredTokens, generation: number): Promise<string | null> {
    if (!expected.refreshToken) return null;
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: expected.refreshToken
    });
    try {
      const response = await this.request("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: oauthHeaders(),
        body: body.toString()
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.access_token !== "string") return null;
      if (this.generation !== generation || this.tokens !== expected) return null;
      const accessToken = payload.access_token;
      const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : expected.refreshToken;
      const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : null;
      const next: StoredTokens = {
        ...expected,
        accessToken,
        refreshToken,
        expiresAt: expiresIn === null ? null : this.now() + expiresIn * 1000
      };
      this.tokens = next;
      await this.persist(next, generation);
      return this.generation === generation && this.tokens === next ? accessToken : null;
    } catch {
      return null;
    }
  }

  private async fetchLogin(accessToken: string, signal: AbortSignal): Promise<string | null> {
    try {
      const response = await this.request("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "CanvasTTY plugin showcase"
        }
      }, signal);
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      return isRecord(payload) && typeof payload.login === "string" ? payload.login : null;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  private async request(input: string, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref();
    try {
      return await this.fetcher(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    }
  }

  private async persist(tokens: StoredTokens, generation: number): Promise<void> {
    await this.enqueueStoreWrite(async () => {
      if (this.generation !== generation || this.tokens !== tokens) return;
      try {
        await mkdir(dirname(this.storePath), { recursive: true });
        if (!this.secureStorage?.isEncryptionAvailable()) {
          console.warn("CanvasTTY GitHub OAuth: OS keychain unavailable; session not persisted.");
          return;
        }
        const encrypted = this.secureStorage.encryptString(JSON.stringify(tokens));
        const temporaryPath = `${this.storePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, JSON.stringify({ data: encrypted.toString("base64") }), { mode: 0o600 });
          if (this.generation === generation && this.tokens === tokens) {
            await rename(temporaryPath, this.storePath);
          }
        } finally {
          await rm(temporaryPath, { force: true });
        }
      } catch (error) {
        console.warn("CanvasTTY GitHub OAuth session could not be persisted.", error);
      }
    });
  }

  private enqueueStoreWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.storeWrite.catch(() => undefined).then(operation);
    this.storeWrite = next;
    return next;
  }
}

function oauthHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "CanvasTTY plugin showcase"
  };
}

function githubVerificationUri(value: unknown): string {
  if (typeof value !== "string") return "https://github.com/login/device";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname === "/login/device"
      ? url.toString()
      : "https://github.com/login/device";
  } catch {
    return "https://github.com/login/device";
  }
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortedError(): DOMException {
  return new DOMException("GitHub OAuth operation was cancelled.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

const MAX_POLL_INTERVAL_SECONDS = 60;

function backedOff(interval: number): number {
  return Math.min(Math.max(interval * 2, interval + 1), MAX_POLL_INTERVAL_SECONDS);
}
