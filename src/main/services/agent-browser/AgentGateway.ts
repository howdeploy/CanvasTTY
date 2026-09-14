import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rmdir, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserActor, BrowserResult } from "../../../shared/contracts.ts";
import { MAX_BRIDGE_PAYLOAD_BYTES } from "../../../agent-browser/tool-catalog.mjs";
import {
  AGENT_BRIDGE_PROTOCOL_VERSION,
  HEARTBEAT_EXPIRY_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_CONNECTED_AGENTS,
  MAX_INFLIGHT_COMMANDS,
  NdjsonDecoder,
  asBridgeError,
  bridgeError,
  commandFromRequest,
  encodeServerMessage,
  parseClientMessage
} from "./protocol.ts";
import type {
  AgentCapability,
  AgentDisconnectReason,
  AgentProvider,
  BrowserCoreLike,
  ServerMessage
} from "./protocol.ts";
import {
  WindowsPipeHostTransport,
  type AgentGatewaySocket,
  type WindowsPipeHostTransportOptions
} from "./WindowsPipeHostTransport.ts";

const DEFAULT_CAPABILITY_TTL_MS = 60_000;
const MAX_TRANSPORT_RESTART_ATTEMPTS = 3;
const TRANSPORT_RESTART_BASE_DELAY_MS = 500;

export const WINDOWS_AGENT_GATEWAY_UNAVAILABLE =
  "Agent browser access on Windows requires the packaged current-user-only named-pipe host.";

export function supportsAgentGatewayPlatform(_platform: NodeJS.Platform = process.platform): boolean {
  return true;
}

interface CapabilityLease {
  actor: Extract<BrowserActor, { kind: "agent" }>;
  tokenDigest: Buffer;
  reconnectToken: string | null;
  reconnectTokenDigest: Buffer | null;
  expiresAt: number;
  used: boolean;
  resolveAuthenticated(): void;
  rejectAuthenticated(error: Error): void;
}

interface ConnectionState {
  socket: AgentGatewaySocket;
  decoder: NdjsonDecoder;
  actor: Extract<BrowserActor, { kind: "agent" }> | null;
  authenticated: boolean;
  lastHeartbeatAt: number;
  connectedAt: number;
  unsubscribe: (() => void) | null;
  controllers: Map<string, AbortController>;
  inflight: number;
  closed: boolean;
}

export interface AgentGatewayOptions {
  platform?: NodeJS.Platform;
  runtimeDirectory?: string;
  windowsHostPath?: string;
  windowsPipeHostFactory?: (options: WindowsPipeHostTransportOptions) => WindowsPipeHostTransport;
  capabilityTtlMs?: number;
  now?: () => number;
}

export interface RegisterAgentInput {
  terminalSessionId: string;
  provider: AgentProvider;
  cwd: string;
}

export class AgentGateway {
  private readonly browser: BrowserCoreLike;
  private readonly platform: NodeJS.Platform;
  private readonly capabilityTtlMs: number;
  private readonly now: () => number;
  private readonly requestedRuntimeDirectory: string | undefined;
  private readonly windowsHostPath: string | undefined;
  private readonly windowsPipeHostFactory: (
    options: WindowsPipeHostTransportOptions
  ) => WindowsPipeHostTransport;
  private readonly leases = new Map<string, CapabilityLease>();
  private readonly connections = new Map<string, Set<ConnectionState>>();
  private readonly acceptedConnections = new Set<ConnectionState>();
  private server: Server | null = null;
  private windowsTransport: WindowsPipeHostTransport | null = null;
  private endpoint: string | null = null;
  private ownedRuntimeDirectory: string | null = null;
  private expiryTimer: NodeJS.Timeout | undefined;
  private startPromise: Promise<string> | null = null;
  private restartTimer: NodeJS.Timeout | undefined;
  private restartAttempts = 0;
  private restartToken = 0;
  private recovering = false;
  private enabled = true;

  constructor(browser: BrowserCoreLike, options: AgentGatewayOptions = {}) {
    this.browser = browser;
    this.platform = options.platform ?? process.platform;
    this.requestedRuntimeDirectory = options.runtimeDirectory;
    this.windowsHostPath = options.windowsHostPath;
    this.windowsPipeHostFactory = options.windowsPipeHostFactory
      ?? ((transportOptions) => new WindowsPipeHostTransport(transportOptions));
    this.capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get address(): string {
    if (!this.endpoint) throw new Error("Agent gateway has not started.");
    return this.endpoint;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) return;
    this.cancelTransportRestart();
    for (const lease of this.leases.values()) {
      if (!lease.used) lease.rejectAuthenticated(new Error("Agent browser access was disabled."));
      clearLeaseSecrets(lease);
    }
    this.leases.clear();
    for (const state of [...this.acceptedConnections]) this.disconnect(state, "revoked");
  }

  async start(): Promise<string> {
    if (this.endpoint && (this.server || this.windowsTransport?.isRunning)) return this.address;
    return await this.beginStart();
  }

  private beginStart(): Promise<string> {
    // Concurrent callers share one bring-up so a failed start cannot leave two transports behind.
    if (this.startPromise) return this.startPromise;
    // An explicit bring-up supersedes a retry that was still waiting for its backoff.
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const starting = this.startOnce();
    this.startPromise = starting;
    const settle = () => {
      if (this.startPromise === starting) this.startPromise = null;
    };
    void starting.then(() => {
      settle();
      this.recovering = false;
      this.restartAttempts = 0;
    }, settle);
    return starting;
  }

  private async startWindowsTransport(): Promise<string> {
    if (!this.windowsHostPath) throw new Error(WINDOWS_AGENT_GATEWAY_UNAVAILABLE);
    const transport = this.windowsPipeHostFactory({
      hostPath: this.windowsHostPath,
      platform: this.platform,
      parentPid: process.pid
    });
    this.windowsTransport = transport;
    transport.on("fatal", () => this.handleTransportFatal(transport));
    try {
      const endpoint = await transport.start((socket) => this.accept(socket));
      if (this.windowsTransport !== transport) {
        // close() or a replacement landed while the host was coming up: the child is real
        // now, so this is the only place that can still shut it down.
        await transport.close();
        throw new Error("Windows agent pipe host was superseded during startup.");
      }
      this.endpoint = endpoint;
      this.expiryTimer = setInterval(() => this.expireConnections(), 1_000);
      this.expiryTimer.unref();
      return endpoint;
    } catch (error) {
      await transport.close();
      if (this.windowsTransport === transport) this.windowsTransport = null;
      this.endpoint = null;
      throw error;
    }
  }

  private async startOnce(): Promise<string> {
    if (this.platform === "win32") return await this.startWindowsTransport();

    const { endpoint, ownedRuntimeDirectory } = await createEndpoint(
      this.requestedRuntimeDirectory
    );
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    this.endpoint = endpoint;
    this.ownedRuntimeDirectory = ownedRuntimeDirectory;

    try {
      await listen(server, endpoint, this.platform);
      await chmod(endpoint, 0o600);
    } catch (error) {
      for (const state of [...this.acceptedConnections]) this.disconnect(state, "closed");
      await closeServer(server);
      this.server = null;
      this.endpoint = null;
      this.ownedRuntimeDirectory = null;
      await cleanupEndpoint(endpoint, ownedRuntimeDirectory, this.platform);
      throw error;
    }

    this.expiryTimer = setInterval(() => this.expireConnections(), 1_000);
    this.expiryTimer.unref();
    return endpoint;
  }

  registerAgent(input: RegisterAgentInput): AgentCapability {
    if (!this.enabled) throw new Error("Agent browser access is disabled.");
    if (
      !this.endpoint
      || (!this.server && !this.windowsTransport?.isRunning)
    ) {
      if (this.recovering) {
        throw new Error("Agent gateway is restarting after a host failure.");
      }
      throw new Error("Agent gateway must be started before launching agents.");
    }
    if (!input.terminalSessionId || !input.cwd) throw new Error("Agent launch identity is incomplete.");
    const pendingLeases = [...this.leases.values()].filter((lease) => !lease.used).length;
    if (pendingLeases + this.connections.size >= MAX_CONNECTED_AGENTS) {
      throw new Error("CanvasTTY supports at most 16 connected or launching browser agents.");
    }

    const agentId = randomUUID();
    const connectionId = randomUUID();
    const capabilityToken = randomBytes(32).toString("base64url");
    let resolveAuthenticated!: () => void;
    let rejectAuthenticated!: (error: Error) => void;
    const authenticated = new Promise<void>((resolve, reject) => {
      resolveAuthenticated = resolve;
      rejectAuthenticated = reject;
    });
    void authenticated.catch(() => undefined);
    const actor: Extract<BrowserActor, { kind: "agent" }> = {
      kind: "agent",
      agentId,
      provider: input.provider,
      terminalSessionId: input.terminalSessionId,
      connectionId,
      cwd: input.cwd
    };
    this.leases.set(connectionId, {
      actor,
      tokenDigest: digest(capabilityToken),
      reconnectToken: null,
      reconnectTokenDigest: null,
      expiresAt: this.now() + this.capabilityTtlMs,
      used: false,
      resolveAuthenticated,
      rejectAuthenticated
    });
    return {
      agentId,
      connectionId,
      terminalSessionId: input.terminalSessionId,
      provider: input.provider,
      capabilityToken,
      address: this.endpoint,
      authenticated
    };
  }

  revokeTerminalSession(terminalSessionId: string): void {
    for (const [connectionId, lease] of this.leases) {
      if (lease.actor.terminalSessionId !== terminalSessionId) continue;
      if (!lease.used) lease.rejectAuthenticated(new Error("Terminal session ended before browser authentication."));
      clearLeaseSecrets(lease);
      this.leases.delete(connectionId);
    }
    for (const state of [...this.acceptedConnections]) {
      if (state.actor?.terminalSessionId === terminalSessionId) this.disconnect(state, "revoked");
    }
  }

  async close(): Promise<void> {
    this.cancelTransportRestart();
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    for (const state of [...this.acceptedConnections]) this.disconnect(state, "closed");
    for (const lease of this.leases.values()) {
      if (!lease.used) lease.rejectAuthenticated(new Error("Agent gateway closed before authentication."));
      clearLeaseSecrets(lease);
    }
    this.leases.clear();

    const server = this.server;
    const windowsTransport = this.windowsTransport;
    const endpoint = this.endpoint;
    const ownedRuntimeDirectory = this.ownedRuntimeDirectory;
    this.server = null;
    this.windowsTransport = null;
    this.endpoint = null;
    this.ownedRuntimeDirectory = null;
    if (server) await closeServer(server);
    if (windowsTransport) await windowsTransport.close();
    if (endpoint) await cleanupEndpoint(endpoint, ownedRuntimeDirectory, this.platform);
  }

  private handleTransportFatal(transport: WindowsPipeHostTransport): void {
    // A transport that was already replaced must not disturb its successor.
    if (this.windowsTransport !== transport) return;
    this.windowsTransport = null;
    this.endpoint = null;
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    for (const state of [...this.acceptedConnections]) this.disconnect(state, "closed");
    // A failing first start() rejects to its caller instead of retrying behind it.
    if (this.startPromise || !this.enabled) return;
    this.recovering = true;
    this.scheduleTransportRestart();
  }

  private scheduleTransportRestart(): void {
    if (!this.enabled || this.restartTimer) return;
    if (this.restartAttempts >= MAX_TRANSPORT_RESTART_ATTEMPTS) {
      // Attempts exhausted: no timer, no endpoint, no further retry.
      this.recovering = false;
      return;
    }
    const delay = TRANSPORT_RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts;
    this.restartAttempts += 1;
    const token = this.restartToken;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.restartTransport(token);
    }, delay);
    this.restartTimer.unref();
  }

  private async restartTransport(token: number): Promise<void> {
    if (token !== this.restartToken || !this.enabled) return;
    try {
      const endpoint = await this.beginStart();
      if (token !== this.restartToken) {
        // close() or setEnabled(false) landed mid-attempt: leave nothing alive behind it.
        if (this.endpoint === endpoint) this.endpoint = null;
        clearInterval(this.expiryTimer);
        this.expiryTimer = undefined;
        const transport = this.windowsTransport;
        this.windowsTransport = null;
        if (transport) await transport.close();
        return;
      }
      this.recovering = false;
      this.restartAttempts = 0;
    } catch {
      if (token === this.restartToken && this.enabled) this.scheduleTransportRestart();
    }
  }

  private cancelTransportRestart(): void {
    this.restartToken += 1;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.restartAttempts = 0;
    this.recovering = false;
  }

  private accept(socket: AgentGatewaySocket): void {
    if (this.acceptedConnections.size >= MAX_CONNECTED_AGENTS * 2) {
      socket.destroy();
      return;
    }
    const now = this.now();
    const state: ConnectionState = {
      socket,
      decoder: new NdjsonDecoder(),
      actor: null,
      authenticated: false,
      lastHeartbeatAt: now,
      connectedAt: now,
      unsubscribe: null,
      controllers: new Map(),
      inflight: 0,
      closed: false
    };
    this.acceptedConnections.add(state);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        for (const value of state.decoder.push(bytes)) {
          void this.handleMessage(state, value).catch((error) => {
            this.write(state, {
              v: AGENT_BRIDGE_PROTOCOL_VERSION,
              type: "error",
              error: asBridgeError(error)
            });
            this.disconnect(state, "protocol_error");
          });
        }
      } catch (error) {
        this.write(state, { v: AGENT_BRIDGE_PROTOCOL_VERSION, type: "error", error: asBridgeError(error) });
        this.disconnect(state, "protocol_error");
      }
    });
    socket.on("error", () => this.disconnect(state, "closed"));
    socket.on("close", () => this.disconnect(state, "closed"));
  }

  private async handleMessage(state: ConnectionState, value: unknown): Promise<void> {
    if (state.closed) return;
    let message;
    try {
      message = parseClientMessage(value, state.authenticated);
    } catch (error) {
      this.write(state, { v: AGENT_BRIDGE_PROTOCOL_VERSION, type: "error", error: asBridgeError(error) });
      this.disconnect(state, "protocol_error");
      return;
    }

    if (message.type === "authenticate") {
      try {
        this.authenticate(state, message);
      } catch (error) {
        this.write(state, { v: AGENT_BRIDGE_PROTOCOL_VERSION, type: "error", error: asBridgeError(error) });
        this.disconnect(state, "protocol_error");
      }
      return;
    }
    const actor = state.actor;
    if (!actor) {
      this.disconnect(state, "protocol_error");
      return;
    }
    if (message.type === "heartbeat") {
      state.lastHeartbeatAt = this.now();
      this.browser.agentHeartbeat?.(actor, state.lastHeartbeatAt);
      this.write(state, {
        v: AGENT_BRIDGE_PROTOCOL_VERSION,
        type: "heartbeat_ack",
        timestamp: state.lastHeartbeatAt
      });
      return;
    }
    if (message.type === "cursor") {
      this.browser.agentCursor?.(actor, { tabId: message.tabId, x: message.x, y: message.y });
      return;
    }
    if (message.type === "cancel") {
      state.controllers.get(message.id)?.abort(new DOMException("Browser command was canceled.", "AbortError"));
      return;
    }
    await this.execute(state, message);
  }

  private authenticate(
    state: ConnectionState,
    message: Extract<ReturnType<typeof parseClientMessage>, { type: "authenticate" }>
  ): void {
    const activeConnections = this.connections.get(message.connectionId);
    if (!activeConnections && this.connections.size >= MAX_CONNECTED_AGENTS) {
      throw bridgeError("BRIDGE_BUSY", "Agent browser connection limit reached.", true);
    }
    const lease = this.leases.get(message.connectionId);
    if (!lease) throw bridgeError("AUTH_INVALID", "Agent browser capability is invalid.", false);
    if (!lease.used && lease.expiresAt <= this.now()) {
      clearLeaseSecrets(lease);
      this.leases.delete(message.connectionId);
      lease.rejectAuthenticated(new Error("Agent browser capability expired."));
      throw bridgeError("SESSION_EXPIRED", "Agent browser capability expired.", false);
    }
    const identityMatches = lease.actor.agentId === message.agentId
      && lease.actor.connectionId === message.connectionId
      && lease.actor.terminalSessionId === message.terminalSessionId
      && lease.actor.provider === message.provider;
    const suppliedDigest = digest(message.capabilityToken);
    const initialTokenMatches = suppliedDigest.length === lease.tokenDigest.length
      && timingSafeEqual(suppliedDigest, lease.tokenDigest);
    const reconnectTokenMatches = lease.reconnectTokenDigest !== null
      && suppliedDigest.length === lease.reconnectTokenDigest.length
      && timingSafeEqual(suppliedDigest, lease.reconnectTokenDigest);
    suppliedDigest.fill(0);
    if (!identityMatches) {
      throw bridgeError("AUTH_INVALID", "Agent browser capability is invalid.", false);
    }

    if (!lease.used) {
      if (!initialTokenMatches) {
        throw bridgeError("AUTH_INVALID", "Agent browser capability is invalid.", false);
      }
      lease.used = true;
      lease.reconnectToken = randomBytes(32).toString("base64url");
      lease.reconnectTokenDigest = digest(lease.reconnectToken);
    } else if (initialTokenMatches) {
      if (!activeConnections || activeConnections.size === 0) {
        throw bridgeError("AUTH_REPLAYED", "Agent browser capability was already used.", false);
      }
    } else if (!reconnectTokenMatches) {
      throw bridgeError("AUTH_INVALID", "Agent browser capability is invalid.", false);
    }

    const reconnectToken = lease.reconnectToken;
    if (!reconnectToken) throw bridgeError("INTERNAL_ERROR", "Agent reconnect capability is unavailable.", true);
    state.actor = lease.actor;
    state.authenticated = true;
    state.lastHeartbeatAt = this.now();
    const states = activeConnections ?? new Set<ConnectionState>();
    const firstConnection = states.size === 0;
    try {
      state.unsubscribe = this.browser.subscribe(lease.actor, 0, (event) => {
        try {
          this.write(state, { v: AGENT_BRIDGE_PROTOCOL_VERSION, type: "event", event });
        } catch {
          this.disconnect(state, "protocol_error");
        }
      });
      states.add(state);
      this.connections.set(lease.actor.connectionId, states);
      if (firstConnection) this.browser.agentConnected?.(lease.actor);
    } catch (error) {
      try {
        state.unsubscribe?.();
      } catch {
        // The browser rejected registration while tearing down.
      }
      state.unsubscribe = null;
      states.delete(state);
      if (states.size === 0) this.connections.delete(lease.actor.connectionId);
      lease.rejectAuthenticated(new Error("Browser core rejected the agent connection."));
      throw bridgeError("INTERNAL_ERROR", "Browser core rejected the agent connection.", true);
    }
    lease.resolveAuthenticated();
    this.write(state, {
      v: AGENT_BRIDGE_PROTOCOL_VERSION,
      type: "authenticated",
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      heartbeatExpiryMs: HEARTBEAT_EXPIRY_MS,
      reconnectToken
    });
  }

  private async execute(
    state: ConnectionState,
    message: Extract<ReturnType<typeof parseClientMessage>, { type: "request" }>
  ): Promise<void> {
    const actor = state.actor;
    if (!actor || state.closed) return;
    if (state.controllers.has(message.id)) return;
    if (state.inflight >= MAX_INFLIGHT_COMMANDS) {
      this.write(state, {
        v: AGENT_BRIDGE_PROTOCOL_VERSION,
        type: "response",
        id: message.id,
        error: { code: "BRIDGE_BUSY", message: "Browser command concurrency limit reached.", retryable: true }
      });
      return;
    }

    const command = commandFromRequest(message);
    const controller = new AbortController();
    state.controllers.set(message.id, controller);
    state.inflight += 1;
    const timeout = setTimeout(
      () => controller.abort(bridgeError("TIMEOUT", "Browser command exceeded the bridge deadline.", true)),
      Math.min(125_000, (command.timeoutMs ?? 120_000) + 5_000)
    );
    timeout.unref();
    try {
      const result = await this.browser.execute(actor, command, controller.signal);
      if (!result || result.requestId !== message.id) {
        throw bridgeError("INTERNAL_ERROR", "Browser core returned a mismatched response.", true);
      }
      this.writeResult(state, message.id, result);
    } catch (error) {
      const payload = asBridgeError(error);
      this.write(state, { v: AGENT_BRIDGE_PROTOCOL_VERSION, type: "response", id: message.id, error: payload });
    } finally {
      clearTimeout(timeout);
      if (state.controllers.get(message.id) === controller) state.controllers.delete(message.id);
      state.inflight = Math.max(0, state.inflight - 1);
    }
  }

  private writeResult(state: ConnectionState, id: string, result: BrowserResult): void {
    try {
      this.write(state, { v: AGENT_BRIDGE_PROTOCOL_VERSION, type: "response", id, result });
    } catch (error) {
      if (asBridgeError(error).code !== "PAYLOAD_TOO_LARGE") throw error;
      const fallback: BrowserResult = {
        ok: false,
        requestId: id,
        tabId: result.tabId ?? null,
        commandSequence: result.commandSequence ?? 0,
        revisionBefore: result.revisionBefore ?? null,
        revisionAfter: result.revisionAfter ?? null,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Browser result exceeds 512KB. Request a smaller page chunk.",
          retryable: true
        }
      };
      this.write(state, { v: AGENT_BRIDGE_PROTOCOL_VERSION, type: "response", id, result: fallback });
    }
  }

  private write(state: ConnectionState, message: ServerMessage): void {
    if (state.closed || state.socket.destroyed) return;
    const payload = encodeServerMessage(message);
    if (payload.length - 1 > MAX_BRIDGE_PAYLOAD_BYTES) {
      throw bridgeError("PAYLOAD_TOO_LARGE", "Bridge response exceeds 512KB.", false);
    }
    state.socket.write(payload);
  }

  private expireConnections(): void {
    const now = this.now();
    for (const [connectionId, lease] of this.leases) {
      if (!lease.used && lease.expiresAt <= now) {
        clearLeaseSecrets(lease);
        lease.rejectAuthenticated(new Error("Agent browser capability expired."));
        this.leases.delete(connectionId);
      }
    }
    for (const state of [...this.acceptedConnections]) {
      if (state.authenticated && now - state.lastHeartbeatAt > HEARTBEAT_EXPIRY_MS) {
        this.disconnect(state, "expired");
      } else if (!state.authenticated && now - state.connectedAt > HEARTBEAT_EXPIRY_MS) {
        this.disconnect(state, "expired");
      }
    }
  }

  private disconnect(state: ConnectionState, reason: AgentDisconnectReason): void {
    if (state.closed) return;
    state.closed = true;
    this.acceptedConnections.delete(state);
    for (const controller of state.controllers.values()) controller.abort(new Error("Agent browser connection closed."));
    state.controllers.clear();
    try {
      state.unsubscribe?.();
    } catch {
      // The browser is already tearing down.
    }
    state.unsubscribe = null;
    try {
      if (state.actor) {
        const states = this.connections.get(state.actor.connectionId);
        const removed = states?.delete(state) ?? false;
        if (removed && states?.size === 0) {
          this.connections.delete(state.actor.connectionId);
          try {
            this.browser.agentDisconnected?.(state.actor, reason);
          } catch {
            // A host callback cannot keep a revoked capability socket alive.
          }
        }
      }
    } finally {
      state.socket.destroy();
    }
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function clearLeaseSecrets(lease: CapabilityLease): void {
  lease.tokenDigest.fill(0);
  lease.reconnectTokenDigest?.fill(0);
  lease.reconnectTokenDigest = null;
  lease.reconnectToken = null;
}

async function createEndpoint(
  requestedRuntimeDirectory?: string
): Promise<{ endpoint: string; ownedRuntimeDirectory: string | null }> {
  const suffix = randomBytes(8).toString("hex");
  if (requestedRuntimeDirectory) {
    await mkdir(requestedRuntimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(requestedRuntimeDirectory, 0o700);
    const endpoint = join(requestedRuntimeDirectory, `g-${randomBytes(2).toString("hex")}.sock`);
    if (Buffer.byteLength(endpoint, "utf8") > 100) {
      throw new Error("Agent browser runtime directory is too long for a Unix domain socket.");
    }
    return { endpoint, ownedRuntimeDirectory: null };
  }

  let runtimeDirectory = join(tmpdir(), `ctty-${process.getuid?.() ?? "user"}-${suffix}`);
  let endpoint = join(runtimeDirectory, "gateway.sock");
  if (Buffer.byteLength(endpoint, "utf8") > 100) {
    runtimeDirectory = join("/tmp", `ctty-${process.getuid?.() ?? "user"}-${suffix}`);
    endpoint = join(runtimeDirectory, "gateway.sock");
  }
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  return { endpoint, ownedRuntimeDirectory: runtimeDirectory };
}

function listen(server: Server, endpoint: string, platform: NodeJS.Platform): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (platform === "win32") {
      server.listen({ path: endpoint, readableAll: false, writableAll: false });
    } else {
      server.listen(endpoint);
    }
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function cleanupEndpoint(
  endpoint: string,
  ownedRuntimeDirectory: string | null,
  platform: NodeJS.Platform
): Promise<void> {
  if (platform !== "win32") {
    try {
      await unlink(endpoint);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  if (ownedRuntimeDirectory) {
    try {
      await rmdir(ownedRuntimeDirectory);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
