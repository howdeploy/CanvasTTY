import { randomUUID } from "node:crypto";
import type { ApiProfile, ApiProfileProtocol, LaunchProfileId, ProviderId, ProviderSecretId } from "../../shared/contracts.ts";
import { API_PROFILE_PRESETS, PROVIDER_SECRET_IDS } from "../../shared/contracts.ts";
import { buildProviderApiUrl, normalizePublicHttpsBaseUrl } from "./SecretApiRequestWorker.mjs";

export type SecretGrantDuration = "10m" | "turn" | "session";

const REQUEST_TTL_MS = 10 * 60_000;
const TEN_MINUTES_MS = 10 * 60_000;
const MAX_REASON_CHARS = 1_000;
const MAX_API_BODY_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const SECRET_IDS = new Set<string>(PROVIDER_SECRET_IDS);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface SecretCommandSession {
  provider: ProviderId;
  cwd: string;
  networkProjectRoot?: string;
  profile: LaunchProfileId;
  /** Must be false for closed/disposed sessions. */
  active: boolean;
}

export interface SecretRequestSnapshot {
  id: string;
  sessionId: string;
  secretId: ProviderSecretId;
  reason: string;
  createdAt: number;
  expiresAt: number;
  turnAvailable: boolean;
}

export interface SecretGrantSnapshot {
  sessionId: string;
  secretId: ProviderSecretId;
  duration: SecretGrantDuration;
  approvedAt: number;
  expiresAt: number | null;
}

export interface SecretApiExecutionRequest {
  secretId: ProviderSecretId;
  apiProfile: { protocol: ApiProfileProtocol; baseUrl: string };
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  /** The host executor forwards this value only in the fixed helper's environment. */
  secret: string;
  cwd: string;
  networkProjectRoot?: string;
  launchProfile: LaunchProfileId;
  provider: ProviderId;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface SecretApiExecutionResult {
  status: number;
  body: string;
  truncated: boolean;
}

export interface SecretGrantServiceOptions {
  /** Main-process-only ProviderSecretsService.get callback. */
  getSecret(secretId: ProviderSecretId): Promise<string | null>;
  /** Resolve trusted session metadata from the host, never from tool arguments. */
  getSession(sessionId: string): SecretCommandSession | null;
  /** Current trusted launch/turn/input identity, or null when this launch cannot observe turn completion. */
  getTurnIdentity?(sessionId: string): string | null;
  /** Notify after host input changes the captured turn; callbacks never carry secret material. */
  watchTurn?(sessionId: string, changed: () => void): () => void;
  /** Human-owned profiles only. API origins are never accepted from agent tool arguments. */
  getApiProfiles?(): readonly ApiProfile[];
  /** Must execute the fixed host-owned API helper inside the host's approved isolation boundary. */
  execute?(request: SecretApiExecutionRequest): Promise<SecretApiExecutionResult>;
  /** Register key material with the process-wide terminal redactor before it can be output. */
  rememberSecret?(value: string): void;
  /** Full-text masker, typically TerminalManager.redactSecrets. */
  redact?(value: string): string;
  onRequest?(request: SecretRequestSnapshot): void;
  onDecision?(event: { request: SecretRequestSnapshot; decision: "approved" | "denied" | "expired" | "revoked"; duration?: SecretGrantDuration }): void;
  onRevoke?(event: { sessionId: string; secretId: ProviderSecretId; reason: "manual" | "turn-ended" | "session-ended" | "expired" }): void;
  now?: () => number;
}

interface SecretApiRequestInput {
  secretId: string; apiProfileId?: string; method: string; path: string;
  body?: Record<string, unknown>; timeoutMs?: number;
}

interface PendingRequest extends Omit<SecretRequestSnapshot, "turnAvailable"> { readonly originTurnIdentity: string | null; turnIdentity: string | null; }
interface Grant extends SecretGrantSnapshot { expiresAt: number | null; turnIdentity: string | null; }

/**
 * Host-owned, memory-only grants for using a provider secret in one isolated provider API request.
 * Agent tools can request and consume a grant but cannot approve or extend it. Approval
 * and revocation methods are intended for trusted main-process/UI IPC callers only.
 */
export class SecretGrantService {
  private readonly options: SecretGrantServiceOptions;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly grants = new Map<string, Grant>();
  private readonly turnWatches = new Map<string, () => void>();
  private readonly activeRuns = new Set<{ sessionId: string; secretIds: Set<ProviderSecretId>; controller: AbortController }>();

  constructor(options: SecretGrantServiceOptions) {
    this.options = options;
  }

  requestSecret(sessionId: string, secretId: string, reason: string): SecretRequestSnapshot {
    const session = this.activeSession(sessionId);
    if (session.provider === "terminal") throw new Error("Provider secrets are available to agent sessions only.");
    if (!isSecretId(secretId)) throw new Error("Unknown provider secret.");
    if (typeof reason !== "string" || !reason.trim() || reason.length > MAX_REASON_CHARS) {
      throw new Error("Give a short reason for requesting this provider secret.");
    }
    this.pruneExpired();
    const originTurnIdentity = this.currentTurn(sessionId);
    // Only a genuinely observed new turn gets a separate request. Idle/unsupported repeats keep the prior TTL.
    const duplicate = [...this.pendingRequests.values()].reverse().find((item) => item.sessionId === sessionId && item.secretId === secretId
      && (originTurnIdentity === null || item.originTurnIdentity === originTurnIdentity));
    if (duplicate) return this.requestSnapshot(duplicate);
    const now = this.now();
    const request: PendingRequest = {
      id: randomUUID(),
      sessionId,
      secretId,
      reason: this.mask(reason.trim()).slice(0, MAX_REASON_CHARS),
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      originTurnIdentity,
      turnIdentity: originTurnIdentity
    };
    this.pendingRequests.set(request.id, request);
    if (!this.turnWatches.has(sessionId) && this.options.watchTurn) {
      this.turnWatches.set(sessionId, this.options.watchTurn(sessionId, () => this.revalidateTurn(sessionId)));
    }
    this.emit(() => this.options.onRequest?.(this.requestSnapshot(request)));
    return this.requestSnapshot(request);
  }

  /** Safe for a human-facing UI; secret values are never included. */
  pending(sessionIds?: readonly string[]): SecretRequestSnapshot[] {
    this.pruneExpired();
    const allowed = sessionIds ? new Set(sessionIds) : null;
    return [...this.pendingRequests.values()]
      .filter((item) => !allowed || allowed.has(item.sessionId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((item) => this.requestSnapshot(item));
  }

  /** Safe for a human-facing UI; grants contain metadata only, never key material. */
  listGrants(sessionIds?: readonly string[]): SecretGrantSnapshot[] {
    this.pruneExpired();
    const allowed = sessionIds ? new Set(sessionIds) : null;
    return [...this.grants.values()]
      .filter((item) => !allowed || allowed.has(item.sessionId))
      .sort((a, b) => a.approvedAt - b.approvedAt)
      .map((item) => this.grantSnapshot(item));
  }

  /** UI-only. Call only after the person explicitly approves the pending request. */
  approve(requestId: string, duration: SecretGrantDuration): SecretGrantSnapshot {
    if (!isDuration(duration)) throw new Error("Invalid secret grant duration.");
    this.pruneExpired();
    const request = this.pendingRequests.get(requestId);
    if (!request) throw new Error("Secret request expired or is no longer pending.");
    const session = this.activeSession(request.sessionId);
    if (session.provider === "terminal") throw new Error("Provider secrets are available to agent sessions only.");
    if (duration === "turn" && (!request.turnIdentity || request.turnIdentity !== this.currentTurn(request.sessionId))) {
      throw new Error("Turn-scoped approval is unavailable for this launch or the requested turn has ended.");
    }
    const now = this.now();
    const grant: Grant = {
      sessionId: request.sessionId,
      secretId: request.secretId,
      duration,
      approvedAt: now,
      expiresAt: duration === "10m" ? now + TEN_MINUTES_MS : null,
      turnIdentity: duration === "turn" ? request.turnIdentity : null
    };
    this.pendingRequests.delete(request.id);
    this.grants.set(grantKey(request.sessionId, request.secretId), grant);
    this.emit(() => this.options.onDecision?.({ request: this.requestSnapshot(request), decision: "approved", duration }));
    return this.grantSnapshot(grant);
  }

  /** UI-only. */
  deny(requestId: string): void {
    this.pruneExpired();
    const request = this.pendingRequests.get(requestId);
    if (!request) throw new Error("Secret request expired or is no longer pending.");
    this.pendingRequests.delete(requestId);
    this.emit(() => this.options.onDecision?.({ request: this.requestSnapshot(request), decision: "denied" }));
  }

  /** UI-only. Revokes all grants for a session, or one selected secret. */
  revoke(sessionId: string, secretId?: string): number {
    if (secretId !== undefined && !isSecretId(secretId)) throw new Error("Unknown provider secret.");
    let count = 0;
    for (const grant of [...this.grants.values()]) {
      if (grant.sessionId !== sessionId || (secretId !== undefined && grant.secretId !== secretId)) continue;
      this.removeGrant(grant, "manual");
      count += 1;
    }
    for (const run of this.activeRuns) {
      if (run.sessionId === sessionId && (secretId === undefined || run.secretIds.has(secretId as ProviderSecretId))) run.controller.abort();
    }
    return count;
  }

  turnEnded(sessionId: string): void {
    for (const grant of [...this.grants.values()]) {
      if (grant.sessionId === sessionId && grant.duration === "turn") this.removeGrant(grant, "turn-ended");
    }
    this.abortRuns(sessionId);
    // Human approval may arrive after the reply ends. Keep its original TTL and longer scopes,
    // but never let this pending request borrow the ended turn or any later turn.
    for (const request of this.pendingRequests.values()) {
      if (request.sessionId === sessionId) request.turnIdentity = null;
    }
  }

  /** Revoke promptly on launch/input/hook changes; longer grants retain their established lifetime. */
  revalidateTurn(sessionId: string): void {
    const current = this.currentTurn(sessionId);
    for (const grant of [...this.grants.values()]) {
      if (grant.sessionId === sessionId && grant.duration === "turn" && (!current || grant.turnIdentity !== current)) {
        this.removeGrant(grant, "turn-ended");
      }
    }
  }

  sessionEnded(sessionId: string): void {
    this.turnWatches.get(sessionId)?.();
    this.turnWatches.delete(sessionId);
    for (const grant of [...this.grants.values()]) {
      if (grant.sessionId === sessionId) this.removeGrant(grant, "session-ended");
    }
    this.abortRuns(sessionId);
    this.clearPending(sessionId);
  }

  /** Raw model-selected executables are never given provider secrets. */
  async runSecretCommand(
    _sessionId: string,
    _input: { command: string; args: string[]; secretIds: string[]; timeoutMs?: number }
  ): Promise<never> {
    throw new Error("Arbitrary secret-bearing commands are disabled. Use a typed provider API request.");
  }

  async runSecretRequest(
    sessionId: string,
    input: SecretApiRequestInput,
    signal?: AbortSignal
  ): Promise<{ status: number; body: string; truncated: boolean }> {
    if (signal?.aborted) throw new Error("Provider API request was canceled.");
    const controller = new AbortController();
    if (!signal) return this.performSecretRequest(sessionId, input, controller);
    let cancel!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      cancel = () => { controller.abort(); reject(new Error("Provider API request was canceled.")); };
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      const result = await Promise.race([this.performSecretRequest(sessionId, input, controller), canceled]);
      if (signal.aborted) throw new Error("Provider API request was canceled.");
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private async performSecretRequest(
    sessionId: string,
    input: SecretApiRequestInput,
    controller: AbortController
  ): Promise<{ status: number; body: string; truncated: boolean }> {
    controller.signal.throwIfAborted();
    const session = this.activeSession(sessionId);
    if (session.provider === "terminal") throw new Error("Provider secrets are available to agent sessions only.");
    const request = validateApiRequest(input);
    const profile = resolveApiProfile(request.secretId, request.apiProfileId, this.options.getApiProfiles?.() ?? []);
    const baseUrl = normalizePublicHttpsBaseUrl(profile.baseUrl);
    // Validate the path and profile origin before touching the credential store.
    buildProviderApiUrl(baseUrl, request.path);
    if (!this.options.execute) throw new Error("Isolated provider API requests are unavailable.");
    this.pruneExpired();
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error("API request timeout must be between 1 and 300 seconds.");
    }

    this.revalidateTurn(sessionId);
    const grant = this.grants.get(grantKey(sessionId, request.secretId));
    if (!grant || (grant.expiresAt !== null && grant.expiresAt <= this.now())) {
      if (grant) this.removeGrant(grant, "expired");
      throw new Error(`Human approval is required for ${request.secretId}.`);
    }

    let secretValue = "";
    try {
      const value = await this.options.getSecret(request.secretId);
      controller.signal.throwIfAborted();
      if (typeof value !== "string" || value.length === 0) throw new Error("missing");
      secretValue = value;
      this.options.rememberSecret?.(value);
    } catch {
      if (controller.signal.aborted) throw new Error("Provider API request was canceled.");
      throw new Error("An approved provider secret is unavailable.");
    }

    // A revoke/session close may race while ProviderSecretsService reads from disk.
    try {
      this.activeSession(sessionId);
      this.revalidateTurn(sessionId);
      controller.signal.throwIfAborted();
      if (this.grants.get(grantKey(sessionId, request.secretId)) !== grant || (grant.expiresAt !== null && grant.expiresAt <= this.now())) {
        throw new Error("Provider secret approval was revoked or expired.");
      }
    } catch (error) {
      secretValue = "";
      throw error;
    }
    const run = { sessionId, secretIds: new Set([request.secretId]), controller };
    this.activeRuns.add(run);
    let timedOut = false;
    let grantExpired = false;
    let expiryHandle: ReturnType<typeof setTimeout> | undefined;
    const expireGrant = (): void => {
      grantExpired = true;
      // removeGrant checks identity: an older run must not revoke a replacement approval.
      this.removeGrant(grant, "expired");
      controller.abort();
    };
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      if (grant.expiresAt !== null) expiryHandle = setTimeout(expireGrant, Math.max(0, grant.expiresAt - this.now()));
      const apiRequestPromise = this.options.execute({
        secretId: request.secretId,
        apiProfile: { protocol: profile.protocol, baseUrl },
        method: request.method,
        path: request.path,
        ...(request.body ? { body: request.body } : {}),
        secret: secretValue,
        cwd: session.cwd,
        ...(session.networkProjectRoot ? {networkProjectRoot:session.networkProjectRoot} : {}),
        launchProfile: session.profile,
        provider: session.provider,
        timeoutMs,
        signal: controller.signal
      });
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("timeout"));
        }, timeoutMs);
      });
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error("aborted"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });
      const result = await Promise.race([apiRequestPromise, timeoutPromise, abortPromise]);
      if (grant.expiresAt !== null && grant.expiresAt <= this.now()) expireGrant();
      this.revalidateTurn(sessionId);
      controller.signal.throwIfAborted();
      if (!result || !Number.isInteger(result.status) || result.status < 100 || result.status > 599
        || typeof result.body !== "string" || typeof result.truncated !== "boolean") {
        throw new Error("invalid result");
      }
      const maskedBody = this.mask(result.body);
      return {
        status: result.status,
        body: this.capOutput(maskedBody),
        truncated: result.truncated || Buffer.byteLength(maskedBody, "utf8") > MAX_OUTPUT_BYTES
      };
    } catch {
      throw new Error(grantExpired ? "Provider secret approval expired." : timedOut ? "Provider API request timed out." : controller.signal.aborted ? "Provider API request was canceled." : "Provider API request failed.");
    } finally {
      if (expiryHandle !== undefined) clearTimeout(expiryHandle);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      secretValue = "";
      this.activeRuns.delete(run);
    }
  }

  private currentTurn(sessionId: string): string | null {
    try { return this.options.getTurnIdentity?.(sessionId) ?? null; } catch { return null; }
  }

  private requestSnapshot(request: PendingRequest): SecretRequestSnapshot {
    const { turnIdentity, originTurnIdentity: _origin, ...snapshot } = request;
    return { ...snapshot, turnAvailable: Boolean(turnIdentity && turnIdentity === this.currentTurn(request.sessionId)) };
  }

  private grantSnapshot(grant: Grant): SecretGrantSnapshot {
    const { turnIdentity: _identity, ...snapshot } = grant;
    return snapshot;
  }

  private activeSession(sessionId: string): SecretCommandSession {
    const session = this.options.getSession(sessionId);
    if (!session || session.active !== true || !session.cwd || !session.profile || session.provider === "terminal") {
      throw new Error("Secret operations require an active agent session.");
    }
    return session;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const request of [...this.pendingRequests.values()]) {
      if (request.expiresAt <= now) {
        this.pendingRequests.delete(request.id);
        this.emit(() => this.options.onDecision?.({ request: this.requestSnapshot(request), decision: "expired" }));
      }
    }
    for (const sessionId of new Set([...this.grants.values()].filter(grant => grant.duration === "turn").map(grant => grant.sessionId))) this.revalidateTurn(sessionId);
    for (const grant of [...this.grants.values()]) {
      if (grant.expiresAt !== null && grant.expiresAt <= now) this.removeGrant(grant, "expired");
    }
  }

  private removeGrant(grant: Grant, reason: "manual" | "turn-ended" | "session-ended" | "expired"): void {
    const key = grantKey(grant.sessionId, grant.secretId);
    if (this.grants.get(key) !== grant) return;
    this.grants.delete(key);
    for (const run of this.activeRuns) {
      if (run.sessionId === grant.sessionId && run.secretIds.has(grant.secretId)) run.controller.abort();
    }
    this.emit(() => this.options.onRevoke?.({ sessionId: grant.sessionId, secretId: grant.secretId, reason }));
  }

  private abortRuns(sessionId: string): void {
    for (const run of this.activeRuns) if (run.sessionId === sessionId) run.controller.abort();
  }

  private clearPending(sessionId: string): void {
    for (const request of [...this.pendingRequests.values()]) {
      if (request.sessionId !== sessionId) continue;
      this.pendingRequests.delete(request.id);
      this.emit(() => this.options.onDecision?.({ request: this.requestSnapshot(request), decision: "revoked" }));
    }
  }

  private mask(value: string): string {
    try { return this.options.redact?.(value) ?? value; } catch { return "[output redacted]"; }
  }

  private capOutput(value: string): string {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.byteLength <= MAX_OUTPUT_BYTES) return value;
    let start = bytes.byteLength - MAX_OUTPUT_BYTES + 3;
    // The ellipsis uses three bytes; skip any partial leading code point in the retained UTF-8 tail.
    while ((bytes[start]! & 0xc0) === 0x80) start += 1;
    return `…${bytes.subarray(start).toString("utf8")}`;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private emit(callback: () => void): void { try { callback(); } catch { /* audit/UI callbacks must not break secret controls */ } }
}

function validateApiRequest(input: {
  secretId: string; apiProfileId?: string; method: string; path: string;
  body?: Record<string, unknown>; timeoutMs?: number;
}): {
  secretId: ProviderSecretId; apiProfileId?: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; body?: Record<string, unknown>;
} {
  const allowedKeys = new Set(["secretId", "apiProfileId", "method", "path", "body", "timeoutMs"]);
  if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error("Provider API request is invalid.");
  }
  if (!isSecretId(input.secretId)) throw new Error("Unknown provider secret.");
  if (input.secretId === "DEVIN_API_KEY" || input.secretId === "CURSOR_API_KEY") {
    throw new Error(`Provider API requests are not supported for ${input.secretId}.`);
  }
  if (input.apiProfileId !== undefined && (typeof input.apiProfileId !== "string" || input.apiProfileId.length < 1 || input.apiProfileId.length > 64)) {
    throw new Error("API profile id is invalid.");
  }
  if (typeof input.method !== "string" || !METHODS.has(input.method)) throw new Error("API request method is invalid.");
  if (typeof input.path !== "string" || input.path.length < 1 || input.path.length > 2_048) throw new Error("API request path is invalid.");
  let body: Record<string, unknown> | undefined;
  if (input.body !== undefined) {
    if (!input.body || typeof input.body !== "object" || Array.isArray(input.body) || input.method === "GET") {
      throw new Error("API request body must be a JSON object and cannot accompany GET.");
    }
    let encoded: string | undefined;
    try { encoded = JSON.stringify(input.body); } catch { throw new Error("API request body is invalid."); }
    if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_API_BODY_BYTES) {
      throw new Error("API request body exceeds 64 KB.");
    }
    try { body = JSON.parse(encoded) as Record<string, unknown>; }
    catch { throw new Error("API request body is invalid."); }
  }
  return {
    secretId: input.secretId,
    ...(input.apiProfileId ? { apiProfileId: input.apiProfileId } : {}),
    method: input.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: input.path,
    ...(body ? { body } : {})
  };
}

function resolveApiProfile(secretId: ProviderSecretId, apiProfileId: string | undefined, configured: readonly ApiProfile[]): ApiProfile {
  const presets = API_PROFILE_PRESETS.filter((candidate) => candidate.secretRef === secretId);
  if (presets.length === 0) throw new Error(`Provider API requests are not supported for ${secretId}.`);
  if (apiProfileId) {
    const profile = configured.find((candidate) => candidate.id === apiProfileId)
      ?? API_PROFILE_PRESETS.find((candidate) => candidate.id === apiProfileId);
    if (!profile) throw new Error("Unknown provider API profile.");
    if (profile.secretRef !== secretId) throw new Error("The selected API profile uses a different provider secret.");
    return profile;
  }
  const standard = presets[0]!;
  return configured.find((candidate) => candidate.id === standard.id && candidate.secretRef === secretId) ?? standard;
}

function isSecretId(value: string): value is ProviderSecretId {
  return SECRET_IDS.has(value);
}

function isDuration(value: string): value is SecretGrantDuration {
  return value === "10m" || value === "turn" || value === "session";
}

function grantKey(sessionId: string, secretId: string): string {
  return `${sessionId}\u0000${secretId}`;
}
