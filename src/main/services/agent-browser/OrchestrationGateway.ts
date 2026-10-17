import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { join } from "node:path";
import type {
  OrchestrationBridgeErrorPayload,
  OrchestrationCapability,
  OrchestrationCommandHandler,
  OrchestrationServerMessage
} from "./orchestration-protocol.ts";
import {
  MAX_CONNECTED_ORCHESTRATORS,
  MAX_INFLIGHT_ORCHESTRATION_COMMANDS,
  ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
  ORCHESTRATION_HEARTBEAT_EXPIRY_MS,
  ORCHESTRATION_HEARTBEAT_INTERVAL_MS,
  OrchestrationNdjsonDecoder,
  asOrchestrationBridgeError,
  encodeOrchestrationServerMessage,
  orchestrationBridgeError,
  parseOrchestrationClientMessage
} from "./orchestration-protocol.ts";
import { ORCHESTRATION_TOOL_DEFINITIONS } from "../../../agent-browser/orchestration-catalog.mjs";
import type { McpToolDefinition } from "../../../agent-browser/orchestration-catalog.mjs";
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  closeServer,
  listenOnEndpoint,
  makePrivateDirectory,
  removeEndpoint,
  tokenDigest,
  tokenMatches
} from "../gatewaySocket.ts";

import {
  WindowsPipeHostTransport,
  type AgentGatewaySocket,
  type WindowsPipeHostTransportOptions
} from "./WindowsPipeHostTransport.ts";

const CAPABILITY_TTL_MS = 60_000;
const MAX_TRANSPORT_RESTART_ATTEMPTS = 3;
const TRANSPORT_RESTART_BASE_DELAY_MS = 500;
/** A replacement host that dies within this long of starting still counts toward MAX_TRANSPORT_RESTART_ATTEMPTS. */
const TRANSPORT_FAST_FAILURE_WINDOW_MS = 60_000;

interface CapabilityLease {
  connectionId: string;
  terminalSessionId: string;
  tokenDigest: Buffer;
  reconnectToken: string | null;
  reconnectTokenDigest: Buffer | null;
  expiresAt: number;
  used: boolean;
  resolveAuthenticated(): void;
  rejectAuthenticated(error: Error): void;
}

interface Connection {
  socket: AgentGatewaySocket;
  decoder: OrchestrationNdjsonDecoder;
  lease: CapabilityLease | null;
  authenticated: boolean;
  lastHeartbeatAt: number;
  controllers: Map<string, AbortController>;
  inflight: number;
  closed: boolean;
}

export interface OrchestrationGatewayOptions {
  runtimeDirectory: string;
  platform?: NodeJS.Platform;
  windowsHostPath?: string;
  windowsPipeHostFactory?: (options: WindowsPipeHostTransportOptions) => WindowsPipeHostTransport;
  handler: OrchestrationCommandHandler;
  capabilityTtlMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatExpiryMs?: number;
  now?: () => number;
}

export class OrchestrationGateway {
  private readonly server: Server;
  private readonly leases = new Map<string, CapabilityLease>();
  private readonly connections = new Set<Connection>();
  private readonly handler: OrchestrationCommandHandler;
  private readonly runtimeDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly windowsHostPath: string | undefined;
  private readonly windowsPipeHostFactory: (options: WindowsPipeHostTransportOptions) => WindowsPipeHostTransport;
  private windowsTransport: WindowsPipeHostTransport | null = null;
  private readonly capabilityTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatExpiryMs: number;
  private readonly now: () => number;
  private socketEndpoint: string | null = null;
  private ownedRuntimeDirectory: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private starting: Promise<void> | null = null;
  /** Bumped by stop(): a start() still opening the socket then knows it was stopped. */
  private generation = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  /** When the current Windows pipe host started listening. */
  private transportStartedAt: number | null = null;
  private restartToken = 0;
  private recovering = false;
  /** The start caller (or recovery attempt) that currently owns a shared in-flight start. */
  private startIntent = 0;
  private enabled = true;

  constructor(options: OrchestrationGatewayOptions) {
    this.handler = options.handler;
    this.runtimeDirectory = options.runtimeDirectory;
    this.platform = options.platform ?? process.platform;
    this.windowsHostPath = options.windowsHostPath;
    this.windowsPipeHostFactory = options.windowsPipeHostFactory
      ?? ((transportOptions) => new WindowsPipeHostTransport(transportOptions));
    this.capabilityTtlMs = options.capabilityTtlMs ?? CAPABILITY_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? ORCHESTRATION_HEARTBEAT_INTERVAL_MS;
    this.heartbeatExpiryMs = options.heartbeatExpiryMs ?? ORCHESTRATION_HEARTBEAT_EXPIRY_MS;
    this.now = options.now ?? Date.now;
    this.server = createServer((socket) => this.accept(socket));
  }

  get address(): string | null {
    return this.socketEndpoint;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    if (this.enabled) {
      if (this.recovering && !this.running) this.scheduleTransportRestart();
      return;
    }
    this.pauseTransportRestart();
    for (const connection of [...this.connections]) this.closeConnection(connection, "revoked");
    for (const lease of [...this.leases.values()]) this.expireLease(lease);
  }

  /**
   * Starts listening once: a second start() while the first is still opening the socket waits for it, and a stop()
   * meanwhile wins (the opened socket is closed again and start() leaves the gateway stopped).
   */
  start(): Promise<void> {
    if (this.running) {
      // The listener can become live before its recovery continuation settles. A caller
      // arriving in that window owns the completed start and invalidates that continuation.
      if (this.recovering) {
        this.startIntent += 1;
        this.cancelTransportRestart();
      }
      return Promise.resolve();
    }
    // A deliberate start supersedes a recovery that is waiting for backoff.
    if (this.restartTimer !== null) this.cancelTransportRestart();
    const intent = ++this.startIntent;
    const recovering = this.recovering;
    return this.beginStart().then(() => {
      if (intent !== this.startIntent) return;
      this.recovering = false;
      this.restartAttempts = 0;
    }, (error) => {
      if (intent === this.startIntent && recovering && this.enabled) this.scheduleTransportRestart();
      throw error;
    });
  }

  private beginStart(): Promise<void> {
    this.starting ??= this.open(this.generation).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async open(generation: number): Promise<void> {
    if (this.platform === "win32") {
      if (!this.windowsHostPath) throw new Error("Orchestration requires the current-user Windows pipe host.");
      const transport = this.windowsPipeHostFactory({
        hostPath: this.windowsHostPath,
        platform: this.platform,
        parentPid: process.pid
      });
      this.windowsTransport = transport;
      transport.on("fatal", () => {
        this.handleTransportFatal(transport, generation);
      });
      let endpoint: string;
      try {
        endpoint = await transport.start((socket) => this.accept(socket));
      } catch (error) {
        await transport.close();
        if (this.windowsTransport === transport) this.windowsTransport = null;
        this.socketEndpoint = null;
        throw error;
      }
      if (generation !== this.generation) {
        // stop() ran while the pipe host started: close it again and leave the gateway stopped.
        await transport.close();
        if (this.windowsTransport === transport) this.windowsTransport = null;
        return;
      }
      if (this.windowsTransport !== transport) {
        await transport.close();
        throw new Error("The Windows orchestration pipe host failed during startup.");
      }
      this.socketEndpoint = endpoint;
      this.transportStartedAt = this.now();
    } else {
      // Unix domain sockets cap at ~104 path bytes (macOS); fall back to a short
      // current-user directory exactly like the browser gateway does.
      let runtimeDirectory = this.runtimeDirectory;
      this.ownedRuntimeDirectory = null;
      let endpoint = join(runtimeDirectory, `orchestration-${randomUUID()}.sock`);
      if (Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
        runtimeDirectory = join("/tmp", `ctty-orch-${process.getuid?.() ?? "user"}-${randomUUID().slice(0, 8)}`);
        this.ownedRuntimeDirectory = runtimeDirectory;
        endpoint = join(runtimeDirectory, "orchestration.sock");
      }
      await makePrivateDirectory(runtimeDirectory, { recursive: true });
      if (generation !== this.generation) return;
      this.socketEndpoint = endpoint;
      await listenOnEndpoint(this.server, endpoint);
      if (generation !== this.generation) {
        // stop() ran while the socket opened: it closed nothing that was listening yet, so close it here.
        await closeServer(this.server);
        await removeEndpoint(endpoint, this.ownedRuntimeDirectory, { socketFile: true, ignoreErrors: true });
        if (this.socketEndpoint === endpoint) this.socketEndpoint = null;
        return;
      }
    }
    this.running = true;
    this.heartbeatTimer = setInterval(() => this.sweepConnections(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.startIntent += 1;
    this.cancelTransportRestart();
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const connection of [...this.connections]) this.closeConnection(connection, "closed");
    for (const lease of [...this.leases.values()]) this.expireLease(lease);
    const transport = this.windowsTransport;
    this.windowsTransport = null;
    if (transport) await transport.close();
    await closeServer(this.server);
    if (this.socketEndpoint !== null && this.platform !== "win32") {
      await removeEndpoint(this.socketEndpoint, this.ownedRuntimeDirectory, { socketFile: true, ignoreErrors: true });
    }
    this.socketEndpoint = null;
    this.ownedRuntimeDirectory = null;
    this.running = false;
    this.transportStartedAt = null;
  }

  private handleTransportFatal(transport: WindowsPipeHostTransport, generation: number): void {
    // A late event from an old host, or one superseded by explicit stop(), cannot affect a successor.
    if (this.windowsTransport !== transport || generation !== this.generation) return;
    const wasRunning = this.running;
    // A host that served for a while earns a fresh retry budget; one that dies right after starting does not, so a
    // host that keeps crashing on start-up is not restarted forever.
    const ranFor = this.transportStartedAt === null ? 0 : this.now() - this.transportStartedAt;
    if (ranFor >= TRANSPORT_FAST_FAILURE_WINDOW_MS) this.restartAttempts = 0;
    this.transportStartedAt = null;
    this.windowsTransport = null;
    this.socketEndpoint = null;
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const connection of [...this.connections]) this.closeConnection(connection, "closed");
    // Capabilities are one-run leases. A restarted listener only serves newly launched orchestrators.
    for (const lease of [...this.leases.values()]) this.expireLease(lease);
    void transport.close().catch((error) => console.warn("Orchestration pipe host shutdown failed.", error));

    // A fatal during the initial start is reported to that caller. Automatic recovery starts only
    // after this gateway has served at least one successful start.
    if (!wasRunning && !this.recovering) return;
    this.recovering = true;
    if (this.enabled && !this.starting) this.scheduleTransportRestart();
  }

  private scheduleTransportRestart(): void {
    if (!this.enabled || this.restartTimer !== null || !this.recovering) return;
    if (this.restartAttempts >= MAX_TRANSPORT_RESTART_ATTEMPTS) {
      this.recovering = false;
      return;
    }
    const delay = TRANSPORT_RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts;
    const token = this.restartToken;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (token !== this.restartToken || !this.enabled || !this.recovering) return;
      this.restartAttempts += 1;
      void this.restartTransport(token);
    }, delay);
    this.restartTimer.unref?.();
  }

  private async restartTransport(token: number): Promise<void> {
    if (token !== this.restartToken || !this.enabled) return;
    const intent = ++this.startIntent;
    try {
      await this.beginStart();
      // A deliberate start or a newer recovery attempt now owns the shared start promise.
      if (intent !== this.startIntent) return;
      if (token !== this.restartToken || !this.enabled) {
        const transport = this.windowsTransport;
        this.windowsTransport = null;
        this.socketEndpoint = null;
        this.running = false;
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        for (const connection of [...this.connections]) this.closeConnection(connection, "closed");
        for (const lease of [...this.leases.values()]) this.expireLease(lease);
        if (transport) await transport.close();
        if (this.recovering && this.enabled) this.scheduleTransportRestart();
        return;
      }
      // The retry budget is kept until the replacement outlives TRANSPORT_FAST_FAILURE_WINDOW_MS (see the fatal handler).
      this.recovering = false;
    } catch {
      if (intent === this.startIntent && token === this.restartToken && this.enabled) this.scheduleTransportRestart();
    }
  }

  private pauseTransportRestart(): void {
    this.restartToken += 1;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private cancelTransportRestart(): void {
    this.pauseTransportRestart();
    this.restartAttempts = 0;
    this.recovering = false;
  }

  /** Called at PTY launch; bootstrap may join an already-live launch, never revive a disconnected one. */
  registerOrchestrator(input: { terminalSessionId: string }): OrchestrationCapability {
    if (!this.enabled || !this.running || this.socketEndpoint === null) {
      throw new Error("The orchestration bridge is not running.");
    }
    if (typeof input.terminalSessionId !== "string" || input.terminalSessionId.length === 0) {
      throw new Error("A terminal session id is required.");
    }
    this.revokeTerminalSession(input.terminalSessionId);
    const token = randomBytes(32).toString("base64url");
    const connectionId = randomUUID();
    const lease: CapabilityLease = {
      connectionId,
      terminalSessionId: input.terminalSessionId,
      tokenDigest: tokenDigest(token),
      reconnectToken: null,
      reconnectTokenDigest: null,
      expiresAt: this.now() + this.capabilityTtlMs,
      used: false,
      resolveAuthenticated: () => undefined,
      rejectAuthenticated: () => undefined
    };
    const authenticated = new Promise<void>((resolve, reject) => {
      lease.resolveAuthenticated = resolve;
      lease.rejectAuthenticated = reject;
    });
    authenticated.catch(() => undefined);
    this.leases.set(lease.terminalSessionId, lease);
    return {
      address: this.socketEndpoint,
      connectionId,
      terminalSessionId: lease.terminalSessionId,
      capabilityToken: token,
      authenticated
    };
  }

  revokeTerminalSession(terminalSessionId: string): void {
    const lease = this.leases.get(terminalSessionId);
    if (!lease) return;
    this.leases.delete(terminalSessionId);
    lease.rejectAuthenticated(orchestrationBridgeError("SESSION_EXPIRED", "The orchestrator session ended.", false));
    for (const connection of [...this.connections]) {
      if (connection.lease === lease) this.closeConnection(connection, "revoked");
    }
  }

  private accept(socket: AgentGatewaySocket): void {
    if (this.connections.size >= MAX_CONNECTED_ORCHESTRATORS) {
      socket.destroy();
      return;
    }
    const connection: Connection = {
      socket,
      decoder: new OrchestrationNdjsonDecoder(),
      lease: null,
      authenticated: false,
      lastHeartbeatAt: this.now(),
      controllers: new Map(),
      inflight: 0,
      closed: false
    };
    this.connections.add(connection);
    socket.on("data", (chunk: Buffer) => {
      if (connection.closed) return;
      try {
        const messages = connection.decoder.push(chunk);
        for (const message of messages) void this.handleMessage(connection, message);
      } catch (error) {
        this.failConnection(connection, error);
      }
    });
    socket.on("error", () => this.closeConnection(connection, "closed"));
    socket.on("close", () => this.closeConnection(connection, "closed"));
  }

  private async handleMessage(connection: Connection, message: unknown): Promise<void> {
    try {
      const parsed = parseOrchestrationClientMessage(message, connection.authenticated);
      if (parsed.type === "authenticate") {
        this.authenticate(connection, parsed);
        return;
      }
      if (parsed.type === "heartbeat") {
        connection.lastHeartbeatAt = this.now();
        this.send(connection, {
          v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
          type: "heartbeat_ack",
          timestamp: parsed.timestamp
        });
        return;
      }
      if (parsed.type === "cancel") {
        connection.controllers.get(parsed.id)?.abort();
        return;
      }
      if (parsed.type === "list_tools") {
        this.listTools(connection, parsed.id);
        return;
      }
      await this.dispatch(connection, parsed.id, parsed.tool, parsed.arguments);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      this.failConnection(connection, error);
    }
  }

  private authenticate(connection: Connection, message: {
    connectionId: string;
    terminalSessionId: string;
    capabilityToken: string;
  }): void {
    const lease = this.leases.get(message.terminalSessionId);
    const failure = orchestrationBridgeError("AUTH_INVALID", "Orchestration capability rejected.", false);
    if (!lease) throw failure;
    if (message.connectionId !== lease.connectionId) throw failure;
    let accepted = false;
    if (!lease.used && this.now() <= lease.expiresAt && tokenMatches(message.capabilityToken, lease.tokenDigest)) {
      lease.used = true;
      accepted = true;
    } else if (lease.used && tokenMatches(message.capabilityToken, lease.tokenDigest)) {
      // New CLI threads can start another MCP helper with the same PTY environment.
      // Match the browser bridge: bootstrap can join this live launch, but cannot
      // revive it after every authenticated connection has gone away.
      accepted = [...this.connections].some(active => active.lease === lease && active.authenticated
        && !active.closed && active.lastHeartbeatAt >= this.now() - this.heartbeatExpiryMs);
    } else if (lease.reconnectToken !== null && tokenMatches(message.capabilityToken, lease.reconnectTokenDigest)) {
      accepted = true;
    }
    if (!accepted) throw failure;
    if (connection.authenticated || connection.lease !== null) {
      throw orchestrationBridgeError("AUTH_REPLAYED", "This connection is already authenticated.", false);
    }
    connection.authenticated = true;
    connection.lease = lease;
    connection.lastHeartbeatAt = this.now();
    // All helpers of a launch share its reconnect capability. Rotating it on
    // every join would strand earlier helpers after their next socket drop.
    if (lease.reconnectToken === null) {
      lease.reconnectToken = randomBytes(32).toString("base64url");
      lease.reconnectTokenDigest = tokenDigest(lease.reconnectToken);
    }
    const reconnectToken = lease.reconnectToken;
    lease.resolveAuthenticated();
    this.send(connection, {
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type: "authenticated",
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatExpiryMs: this.heartbeatExpiryMs,
      reconnectToken
    });
  }

  private listTools(connection: Connection, id: string): void {
    let tools: McpToolDefinition[];
    try {
      tools = this.handler.listTools?.(connection.lease!.terminalSessionId) ?? [...ORCHESTRATION_TOOL_DEFINITIONS];
    } catch {
      tools = [];
    }
    this.send(connection, { v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION, type: "response", id, result: { tools } });
  }

  private async dispatch(
    connection: Connection,
    id: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<void> {
    if (connection.inflight >= MAX_INFLIGHT_ORCHESTRATION_COMMANDS) {
      this.send(connection, {
        v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
        type: "response",
        id,
        error: { code: "BRIDGE_BUSY", message: "Too many in-flight orchestration commands.", retryable: true }
      });
      return;
    }
    const controller = new AbortController();
    connection.controllers.set(id, controller);
    connection.inflight += 1;
    // Cancel answers at once; a handler that cannot stop (a plugin call) is
    // no longer waited for, and its late result is dropped.
    const canceled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
    });
    canceled.catch(() => undefined);
    try {
      const value = await Promise.race([
        this.handler.execute(connection.lease!.terminalSessionId, {
          id,
          tool: tool as never,
          arguments: args
        }, controller.signal),
        canceled
      ]);
      if (connection.closed) return;
      if (controller.signal.aborted) throw new Error("canceled");
      this.send(connection, { v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION, type: "response", id, result: value });
    } catch (error) {
      if (connection.closed) return;
      if (controller.signal.aborted) {
        this.send(connection, {
          v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
          type: "response",
          id,
          error: { code: "CANCELED", message: "Orchestration command was canceled.", retryable: true }
        });
        return;
      }
      const payload = asOrchestrationBridgeError(error) as OrchestrationBridgeErrorPayload;
      this.send(connection, { v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION, type: "response", id, error: payload });
    } finally {
      connection.inflight -= 1;
      connection.controllers.delete(id);
    }
  }

  private send(connection: Connection, message: OrchestrationServerMessage): void {
    if (connection.closed) return;
    try {
      connection.socket.write(encodeOrchestrationServerMessage(message));
    } catch (error) {
      this.failConnection(connection, error);
    }
  }

  private failConnection(connection: Connection, error: unknown): void {
    if (connection.closed) return;
    const payload = asOrchestrationBridgeError(error);
    try {
      connection.socket.write(encodeOrchestrationServerMessage({
        v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
        type: "error",
        error: payload
      }));
    } catch {
      // The socket is already unusable; closing below is the only cleanup left.
    }
    this.closeConnection(connection, "protocol_error");
  }

  private closeConnection(connection: Connection, reason: "closed" | "expired" | "revoked" | "protocol_error"): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    for (const controller of connection.controllers.values()) controller.abort();
    connection.controllers.clear();
    if (reason === "revoked" && connection.lease) {
      connection.lease.rejectAuthenticated(
        orchestrationBridgeError("SESSION_EXPIRED", "The orchestrator session ended.", false)
      );
    }
    connection.socket.destroy();
  }

  private expireLease(lease: CapabilityLease): void {
    this.leases.delete(lease.terminalSessionId);
    lease.rejectAuthenticated(orchestrationBridgeError("SESSION_EXPIRED", "Capability expired.", false));
  }

  private sweepConnections(): void {
    const deadline = this.now() - this.heartbeatExpiryMs;
    for (const connection of [...this.connections]) {
      if (connection.lastHeartbeatAt < deadline) this.closeConnection(connection, "expired");
    }
    for (const lease of [...this.leases.values()]) {
      if (!lease.used && this.now() > lease.expiresAt) this.expireLease(lease);
    }
  }
}
