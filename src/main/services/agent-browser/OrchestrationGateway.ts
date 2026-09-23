import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
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

const CAPABILITY_TTL_MS = 60_000;

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
  socket: Socket;
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
  private readonly capabilityTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatExpiryMs: number;
  private readonly now: () => number;
  private socketEndpoint: string | null = null;
  private ownedRuntimeDirectory: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private enabled = true;

  constructor(options: OrchestrationGatewayOptions) {
    this.handler = options.handler;
    this.runtimeDirectory = options.runtimeDirectory;
    this.capabilityTtlMs = options.capabilityTtlMs ?? CAPABILITY_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? ORCHESTRATION_HEARTBEAT_INTERVAL_MS;
    this.heartbeatExpiryMs = options.heartbeatExpiryMs ?? ORCHESTRATION_HEARTBEAT_EXPIRY_MS;
    this.now = options.now ?? Date.now;
    this.server = createServer((socket) => this.accept(socket));
  }

  get isRunning(): boolean { return this.running && this.server.listening; }

  get address(): string | null {
    return this.socketEndpoint;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    if (this.enabled) return;
    for (const connection of [...this.connections]) this.closeConnection(connection, "revoked");
    for (const lease of [...this.leases.values()]) this.expireLease(lease);
  }

  async start(): Promise<void> {
    if (this.running) return;
    // Unix domain sockets cap at ~104 path bytes (macOS); fall back to a short
    // current-user directory exactly like the browser gateway does.
    let runtimeDirectory = this.runtimeDirectory;
    this.ownedRuntimeDirectory = null;
    let endpoint = join(runtimeDirectory, `orchestration-${randomUUID()}.sock`);
    if (Buffer.byteLength(endpoint, "utf8") > 100) {
      runtimeDirectory = join("/tmp", `ctty-orch-${process.getuid?.() ?? "user"}-${randomUUID().slice(0, 8)}`);
      this.ownedRuntimeDirectory = runtimeDirectory;
      endpoint = join(runtimeDirectory, "orchestration.sock");
    }
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(runtimeDirectory, 0o700);
    this.socketEndpoint = endpoint;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("error", onError);
        reject(error);
      };
      this.server.once("error", onError);
      this.server.listen(this.socketEndpoint!, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    await chmod(this.socketEndpoint, 0o600);
    this.running = true;
  }

  /** The sweep runs only while a lease or connection exists, so an idle gateway has no timer. */
  private ensureSweep(): void {
    if (this.heartbeatTimer !== null || !this.running) return;
    this.heartbeatTimer = setInterval(() => this.sweepConnections(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const connection of [...this.connections]) this.closeConnection(connection, "closed");
    for (const lease of [...this.leases.values()]) this.expireLease(lease);
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    if (this.socketEndpoint !== null) {
      await unlink(this.socketEndpoint).catch(() => undefined);
      this.socketEndpoint = null;
    }
    if (this.ownedRuntimeDirectory !== null) {
      await unlink(join(this.ownedRuntimeDirectory, "orchestration.sock")).catch(() => undefined);
      const { rmdir } = await import("node:fs/promises");
      await rmdir(this.ownedRuntimeDirectory).catch(() => undefined);
      this.ownedRuntimeDirectory = null;
    }
    this.running = false;
  }

  /** Called at orchestrator PTY launch; the token is one-use with a short TTL. */
  registerOrchestrator(input: { terminalSessionId: string }): OrchestrationCapability {
    if (!this.enabled || !this.isRunning || this.socketEndpoint === null) {
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
      tokenDigest: digest(token),
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
    this.ensureSweep();
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

  private accept(socket: Socket): void {
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
    this.ensureSweep();
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
    const presented = digest(message.capabilityToken);
    let accepted = false;
    if (!lease.used && this.now() <= lease.expiresAt && timingSafeEqual(lease.tokenDigest, presented)) {
      lease.used = true;
      accepted = true;
    } else if (
      lease.reconnectTokenDigest !== null
      && lease.reconnectToken !== null
      && timingSafeEqual(lease.reconnectTokenDigest, presented)
    ) {
      accepted = true;
    }
    if (!accepted) throw failure;
    if (connection.authenticated || connection.lease !== null) {
      throw orchestrationBridgeError("AUTH_REPLAYED", "This connection is already authenticated.", false);
    }
    // One live connection per lease: authenticating with the reconnect token
    // supersedes any connection that still holds this lease (a half-open
    // socket or a duplicated helper), so a lease never backs two concurrent
    // dispatching connections. The bootstrap token cannot hit this path — it
    // is single-use, so no earlier connection ever holds the lease yet.
    for (const other of [...this.connections]) {
      if (other !== connection && other.lease === lease) this.closeConnection(other, "revoked");
    }
    connection.authenticated = true;
    connection.lease = lease;
    connection.lastHeartbeatAt = this.now();
    const reconnectToken = randomBytes(32).toString("base64url");
    lease.reconnectToken = reconnectToken;
    lease.reconnectTokenDigest = digest(reconnectToken);
    lease.resolveAuthenticated();
    this.send(connection, {
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type: "authenticated",
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatExpiryMs: this.heartbeatExpiryMs,
      reconnectToken
    });
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
    try {
      const value = await this.handler.execute(connection.lease!.terminalSessionId, {
        id,
        tool: tool as never,
        arguments: args
      }, controller.signal);
      if (connection.closed) return;
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
    if (this.connections.size === 0 && this.leases.size === 0 && this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
