import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PROVIDERS, type ProviderId } from "../../../shared/contracts.ts";
import {
  CLAUDE_HTTP_HOOK,
  MAX_ANSWER_CHARS,
  MAX_HOOK_INPUT_BYTES,
  MAX_RUNTIME_MESSAGE_BYTES,
  MAX_RESULT_CHARS,
  normalizeThreadId,
  PERMISSION_GATE,
  permissionGateTimings,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_STATES
} from "../../../agent-runtime/runtime-protocol.mjs";
import { NdjsonLineReader } from "../../../agent-runtime/ndjson.mjs";
import {
  WindowsPipeHostTransport,
  type AgentGatewaySocket,
  type WindowsPipeHostTransportOptions
} from "../agent-browser/WindowsPipeHostTransport.ts";
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  closeServer,
  listenOnEndpoint,
  makePrivateDirectory,
  removeEndpoint,
  tokenDigest,
  tokenMatches
} from "../gatewaySocket.ts";

const AGENT_PROVIDER_SET = new Set<ProviderId>(AGENT_PROVIDERS);
const MAX_RUNTIME_SESSIONS = 32;
const MAX_TRANSPORT_RESTART_ATTEMPTS = 3;
// Hook helpers write their one message right after connecting. A connection
// that stays silent is closed, so idle clients cannot hold all 64 slots.
const FIRST_MESSAGE_TIMEOUT_MS = 5_000;
const TRANSPORT_RESTART_BASE_DELAY_MS = 500;
/** Decision checks in flight, per session and in total; over a cap the call is refused with advice to slow down. */
const MAX_DECISIONS_PER_SESSION = 8;
const MAX_DECISIONS_TOTAL = 32;
/** Loopback HTTP listener for Claude Code's HTTP lifecycle hooks: connections, header and time bounds. */
const HTTP_MAX_CONNECTIONS = 64;
const HTTP_MAX_HEADER_BYTES = 8 * 1024;
const HTTP_MAX_HEADERS = 32;
const HTTP_HEADERS_TIMEOUT_MS = 5_000;
const HTTP_REQUEST_TIMEOUT_MS = 10_000;
const HTTP_KEEP_ALIVE_MS = 5_000;
const HTTP_EVENT_RE = /^[A-Za-z][A-Za-z_]{0,79}$/u;
const OVERLOADED_MESSAGE = "CanvasTTY is checking too many tool calls from this session at once. Wait a few seconds and run the command again, one at a time.";

export type RuntimeLifecycleState = "idle" | "working" | "needs_approval";

export interface RuntimeLifecycleSignal {
  state: RuntimeLifecycleState;
  event: string;
  turnId: string | null;
  /** The provider's own conversation id (Codex thread, Claude or OpenCode session), as its hook reported it. */
  threadId?: string;
  result?: { text: string; truncated: boolean };
  lastAssistantMessage?: string;
  answerCaptureGrantExpiresAt?: number;
}

export interface RuntimeSessionCapability {
  address: string;
  terminalSessionId: string;
  provider: Exclude<ProviderId, "terminal">;
  capabilityToken: string;
}

interface RuntimeLease {
  terminalSessionId: string;
  provider: Exclude<ProviderId, "terminal">;
  tokenDigest: Buffer;
  activeTurnId: string | null;
  /** Turn ids this session already reported (bounded, oldest dropped): a late start of one of them is stale. */
  seenTurnIds: Set<string>;
  latest: RuntimeLifecycleSignal | null;
  captureResult: boolean;
  answerCaptureGrantExpiresAt: number | null;
  /** Launched with decision hooks; otherwise permission requests are refused. */
  decisions: boolean;
  /** How long a decision may take for this session (sized at launch from the decision services' budgets). */
  gatewayMs: number;
  checks: Set<AbortController>;
}

/** One decision hook call (permission-gate.mjs). The tool input is agent-influenced data, never instructions. */
export interface RuntimePermissionRequest {
  requestId: string;
  provider: Exclude<ProviderId, "terminal">;
  toolName: string;
  /** The whole tool input, or null when it was over the bound (then `truncated`, and only a preview). */
  toolInput: unknown;
  toolInputPreview: string | null;
  toolInputSha256: string;
  truncated: boolean;
  /** The agent's current folder as its CLI reported it. */
  cwd: string | null;
}

/** `none`: no opinion, the CLI goes on as it would without CanvasTTY. */
export interface RuntimePermissionDecision {
  behavior: "allow" | "deny" | "ask" | "none";
  message?: string;
}

interface ParsedLifecycleMessage {
  terminalSessionId: string;
  provider: Exclude<ProviderId, "terminal">;
  capabilityToken: string;
  state: RuntimeLifecycleState;
  event: string;
  turnId: string | null;
  threadId?: string;
  result?: { text: string; truncated: boolean };
  lastAssistantMessage?: string;
}

export interface RuntimeGatewayOptions {
  platform?: NodeJS.Platform;
  runtimeDirectory?: string;
  windowsHostPath?: string;
  windowsPipeHostFactory?: (options: WindowsPipeHostTransportOptions) => WindowsPipeHostTransport;
  /** A connection must send its one message within this time (default 5 s). */
  firstMessageTimeoutMs?: number;
  onSignal?(terminalSessionId: string, signal: RuntimeLifecycleSignal): void;
  onAnswerCaptureRevoked?(terminalSessionId: string): void;
  /**
   * Decision hooks: answers one tool call. `signal` aborts when the hook's socket closes, the session is revoked or
   * the gateway's deadline passes; the answer is then `ask`.
   */
  onPermissionRequest?(terminalSessionId: string, request: RuntimePermissionRequest, signal: AbortSignal): Promise<RuntimePermissionDecision> | RuntimePermissionDecision;
  now?: () => number;
  /**
   * Also listen on 127.0.0.1 (random port) for Claude Code's HTTP lifecycle hooks. POSIX only; when the listener
   * cannot start, launches simply keep the command helper.
   */
  httpHooks?: boolean;
}

export class RuntimeGateway {
  private readonly platform: NodeJS.Platform;
  private readonly requestedRuntimeDirectory: string | undefined;
  private readonly windowsHostPath: string | undefined;
  private readonly windowsPipeHostFactory: (options: WindowsPipeHostTransportOptions) => WindowsPipeHostTransport;
  private readonly onSignal: RuntimeGatewayOptions["onSignal"];
  private readonly onAnswerCaptureRevoked: RuntimeGatewayOptions["onAnswerCaptureRevoked"];
  private readonly onPermissionRequest: RuntimeGatewayOptions["onPermissionRequest"];
  private readonly now: () => number;
  private readonly firstMessageTimeoutMs: number;
  private readonly checks = new Set<AbortController>();
  private readonly leases = new Map<string, RuntimeLease>();
  private readonly sockets = new Set<AgentGatewaySocket>();
  private closed = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartAttempts = 0;
  private server: Server | null = null;
  private windowsTransport: WindowsPipeHostTransport | null = null;
  private endpoint: string | null = null;
  private ownedRuntimeDirectory: string | null = null;
  private readonly httpHooksRequested: boolean;
  private httpServer: HttpServer | null = null;
  private httpPort: number | null = null;
  /** Set when Claude reached the listener without its capability (a settings policy emptied the header). */
  private httpUnusable = false;

  constructor(options: RuntimeGatewayOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.requestedRuntimeDirectory = options.runtimeDirectory;
    this.windowsHostPath = options.windowsHostPath;
    this.windowsPipeHostFactory = options.windowsPipeHostFactory
      ?? ((transportOptions) => new WindowsPipeHostTransport(transportOptions));
    this.firstMessageTimeoutMs = options.firstMessageTimeoutMs ?? FIRST_MESSAGE_TIMEOUT_MS;
    this.onSignal = options.onSignal;
    this.onAnswerCaptureRevoked = options.onAnswerCaptureRevoked;
    this.onPermissionRequest = options.onPermissionRequest;
    this.now = options.now ?? Date.now;
    this.httpHooksRequested = options.httpHooks === true && this.platform !== "win32";
  }

  /**
   * Base URL for Claude Code HTTP lifecycle hooks, or null when the listener is not running or proved unusable in
   * this run (then launches use the command helper).
   */
  get httpHookBase(): string | null {
    return this.httpServer && this.httpPort !== null && !this.httpUnusable ? `http://127.0.0.1:${this.httpPort}` : null;
  }

  get address(): string {
    if (!this.endpoint) throw new Error("Agent runtime gateway has not started.");
    return this.endpoint;
  }

  async start(): Promise<string> {
    if (this.endpoint && (this.server || this.windowsTransport?.isRunning)) return this.address;
    if (this.platform === "win32") {
      if (!this.windowsHostPath) {
        throw new Error("Agent runtime access on Windows requires the packaged current-user-only named-pipe host.");
      }
      this.closed = false;
      const transport = this.windowsPipeHostFactory({
        hostPath: this.windowsHostPath,
        platform: this.platform,
        parentPid: process.pid
      });
      this.windowsTransport = transport;
      // The pipe host can die later (crash, EPIPE, FATAL frame). Without this
      // every later launch failed with "must be started" until restart.
      transport.on("fatal", () => this.handleTransportFatal(transport));
      try {
        const endpoint = await transport.start((socket) => this.accept(socket));
        if (this.windowsTransport !== transport) {
          await transport.close();
          throw new Error("Windows agent pipe host was superseded during startup.");
        }
        this.endpoint = endpoint;
        this.restartAttempts = 0;
        return endpoint;
      } catch (error) {
        await transport.close();
        if (this.windowsTransport === transport) this.windowsTransport = null;
        this.endpoint = null;
        throw error;
      }
    }

    const created = await createEndpoint(this.requestedRuntimeDirectory);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    this.endpoint = created.endpoint;
    this.ownedRuntimeDirectory = created.ownedRuntimeDirectory;
    try {
      await listenOnEndpoint(server, created.endpoint, this.platform);
      if (this.httpHooksRequested) await this.startHttp();
      return created.endpoint;
    } catch (error) {
      await closeServer(server);
      this.server = null;
      this.endpoint = null;
      this.ownedRuntimeDirectory = null;
      await removeEndpoint(created.endpoint, created.ownedRuntimeDirectory, { socketFile: true, ignoreErrors: true });
      throw error;
    }
  }

  registerSession(
    terminalSessionId: string,
    provider: Exclude<ProviderId, "terminal">,
    captureResultOrGrantExpiresAt: boolean | number = false,
    answerCaptureGrantExpiresAt?: number,
    decisions = false,
    decisionBudgetMs?: number
  ): RuntimeSessionCapability {
    if (!this.endpoint || (!this.server && !this.windowsTransport?.isRunning)) {
      throw new Error("Agent runtime gateway must be started before launching agents.");
    }
    if (!terminalSessionId || !AGENT_PROVIDER_SET.has(provider)) {
      throw new Error("Agent runtime launch identity is invalid.");
    }
    if (!this.leases.has(terminalSessionId) && this.leases.size >= MAX_RUNTIME_SESSIONS) {
      throw new Error("CanvasTTY supports at most 32 runtime-observed agent sessions.");
    }
    this.revokeTerminalSession(terminalSessionId);
    const capabilityToken = randomBytes(32).toString("base64url");
    const grantExpiresAt = typeof captureResultOrGrantExpiresAt === "number"
      ? captureResultOrGrantExpiresAt : answerCaptureGrantExpiresAt;
    this.leases.set(terminalSessionId, {
      terminalSessionId,
      provider,
      tokenDigest: tokenDigest(capabilityToken),
      activeTurnId: null,
      seenTurnIds: new Set(),
      latest: null,
      captureResult: captureResultOrGrantExpiresAt === true,
      answerCaptureGrantExpiresAt: provider === "codex"
        && typeof grantExpiresAt === "number"
        && Number.isFinite(grantExpiresAt)
        && grantExpiresAt > this.now()
        ? grantExpiresAt
        : null,
      decisions,
      gatewayMs: permissionGateTimings(decisionBudgetMs).gatewayMs,
      checks: new Set()
    });
    return { address: this.endpoint, terminalSessionId, provider, capabilityToken };
  }

  currentStatus(terminalSessionId: string): RuntimeLifecycleState | null {
    return this.leases.get(terminalSessionId)?.latest?.state ?? null;
  }

  /**
   * Ends a session's lease. A launch's own cleanup passes its capability token, so a cleanup that runs
   * late (after the card was relaunched under the same id) cannot revoke the newer launch's lease.
   */
  revokeTerminalSession(terminalSessionId: string, capabilityToken?: string): void {
    const lease = this.leases.get(terminalSessionId);
    if (!lease) return;
    if (capabilityToken !== undefined && !tokenMatches(capabilityToken, lease.tokenDigest)) return;
    lease.tokenDigest.fill(0);
    this.leases.delete(terminalSessionId);
    for (const check of lease.checks) check.abort();
    if (lease.answerCaptureGrantExpiresAt !== null) {
      this.onAnswerCaptureRevoked?.(terminalSessionId);
    }
  }

  private handleTransportFatal(transport: WindowsPipeHostTransport): void {
    if (this.windowsTransport !== transport) return;
    this.windowsTransport = null;
    this.endpoint = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.scheduleTransportRestart();
  }

  private scheduleTransportRestart(): void {
    if (this.closed || this.restartTimer || this.restartAttempts >= MAX_TRANSPORT_RESTART_ATTEMPTS) return;
    const delay = TRANSPORT_RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts;
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closed || this.windowsTransport) return;
      this.start().catch(() => this.scheduleTransportRestart());
    }, delay);
    this.restartTimer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const lease of this.leases.values()) {
      lease.tokenDigest.fill(0);
      for (const check of lease.checks) check.abort();
      if (lease.answerCaptureGrantExpiresAt !== null) {
        this.onAnswerCaptureRevoked?.(lease.terminalSessionId);
      }
    }
    this.leases.clear();
    const httpServer = this.httpServer;
    this.httpServer = null;
    this.httpPort = null;
    if (httpServer) {
      httpServer.closeAllConnections();
      await closeServer(httpServer);
    }
    const server = this.server;
    const transport = this.windowsTransport;
    const endpoint = this.endpoint;
    const ownedRuntimeDirectory = this.ownedRuntimeDirectory;
    this.server = null;
    this.windowsTransport = null;
    this.endpoint = null;
    this.ownedRuntimeDirectory = null;
    if (server) await closeServer(server);
    if (transport) await transport.close();
    if (endpoint) await removeEndpoint(endpoint, ownedRuntimeDirectory, { socketFile: this.platform !== "win32", ignoreErrors: true });
  }

  private accept(socket: AgentGatewaySocket): void {
    if (this.sockets.size >= MAX_RUNTIME_SESSIONS * 2) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const lines = new NdjsonLineReader({ maxLineBytes: MAX_RUNTIME_MESSAGE_BYTES });
    let handled = false;
    const close = () => {
      clearTimeout(firstMessage);
      this.sockets.delete(socket);
      socket.destroy();
    };
    const firstMessage = setTimeout(close, this.firstMessageTimeoutMs);
    firstMessage.unref?.();
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      if (handled) return;
      let line: Buffer | undefined;
      try {
        [line] = lines.push(chunk);
      } catch {
        return close();
      }
      if (!line) return;
      handled = true;
      clearTimeout(firstMessage);
      try {
        const value: unknown = JSON.parse(line.toString("utf8"));
        // Decision hooks keep the socket open for the answer; every other message is unchanged.
        if (isPermissionRequest(value)) return this.acceptPermission(socket, value, close);
        if (isAnswerCaptureCheck(value)) {
          const answerCapture = this.answerCaptureIsActive(value);
          socket.write(Buffer.from(`${JSON.stringify({
            v: RUNTIME_PROTOCOL_VERSION,
            type: "ack",
            answerCapture
          })}\n`, "utf8"));
        } else {
          // The ack goes out before the app reacts: the hook (and the agent behind it) waits only for the check.
          const delivery = this.handleLifecycle(value);
          socket.write(Buffer.from(`${JSON.stringify({ v: RUNTIME_PROTOCOL_VERSION, type: "ack" })}\n`, "utf8"));
          this.deliverLater(delivery);
        }
        const timeout = setTimeout(close, 1_000);
        timeout.unref();
      } catch {
        close();
      }
    });
    socket.on("error", close);
    socket.on("close", () => {
      clearTimeout(firstMessage);
      this.sockets.delete(socket);
    });
  }

  private answerCaptureIsActive(value: unknown): boolean {
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== [
      "capabilityToken", "provider", "terminalSessionId", "type", "v"
    ].sort().join(",")
      || value.v !== RUNTIME_PROTOCOL_VERSION || value.type !== "answer-capture-check"
      || typeof value.terminalSessionId !== "string" || !value.terminalSessionId
      || value.terminalSessionId.length > 160 || value.provider !== "codex"
      || typeof value.capabilityToken !== "string" || value.capabilityToken.length < 32) {
      throw new Error("Answer-capture check is invalid.");
    }
    const lease = this.leases.get(value.terminalSessionId);
    if (!lease || lease.provider !== value.provider) return false;
    if (!tokenMatches(value.capabilityToken, lease.tokenDigest)) return false;
    if (lease.answerCaptureGrantExpiresAt === null) return false;
    if (lease.answerCaptureGrantExpiresAt <= this.now()) {
      lease.answerCaptureGrantExpiresAt = null;
      this.onAnswerCaptureRevoked?.(value.terminalSessionId);
      return false;
    }
    return true;
  }

  /**
   * Checks one lifecycle message and updates the lease at once (so currentStatus never lags); returns the app's
   * reaction to run after the hook has its answer, or null when there is nothing to report.
   */
  private handleLifecycle(value: unknown): Delivery | null {
    const message = parseLifecycleMessage(value);
    const lease = this.leases.get(message.terminalSessionId);
    if (!lease || lease.provider !== message.provider) throw new Error("Runtime capability is invalid.");
    if (!tokenMatches(message.capabilityToken, lease.tokenDigest)) throw new Error("Runtime capability is invalid.");
    return this.applyLifecycle(lease, message);
  }

  private applyLifecycle(lease: RuntimeLease, message: Omit<ParsedLifecycleMessage, "capabilityToken">): Delivery | null {
    if (message.result && !lease.captureResult) throw new Error("Result capture is not enabled for this session.");
    if (message.lastAssistantMessage !== undefined && (
      lease.answerCaptureGrantExpiresAt === null
      || lease.answerCaptureGrantExpiresAt <= this.now()
    )) {
      lease.answerCaptureGrantExpiresAt = null;
      this.onAnswerCaptureRevoked?.(message.terminalSessionId);
      throw new Error("Answer capture is not authorized for this session.");
    }

    if (message.turnId && isTurnStart(message.event)) {
      // Each hook runs on its own connection, so a start of an earlier turn can arrive after the next turn began;
      // it must not make that newer turn's events look stale.
      if (message.turnId !== lease.activeTurnId && lease.seenTurnIds.has(message.turnId)) return null;
      lease.activeTurnId = message.turnId;
      rememberTurn(lease, message.turnId);
    } else if (
      message.turnId
      && lease.activeTurnId
      && message.turnId !== lease.activeTurnId
    ) {
      return null;
    } else if (message.turnId) {
      rememberTurn(lease, message.turnId);
    }
    const signal: RuntimeLifecycleSignal = {
      state: message.state,
      event: message.event,
      turnId: message.turnId,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      ...(message.result === undefined ? {} : { result: message.result }),
      ...(message.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: message.lastAssistantMessage })
    };
    if (message.lastAssistantMessage !== undefined && lease.answerCaptureGrantExpiresAt !== null) {
      signal.answerCaptureGrantExpiresAt = lease.answerCaptureGrantExpiresAt;
    }
    // Captured text is delivered once and never stored in the lifecycle lease.
    lease.latest = {
      state: signal.state,
      event: signal.event,
      turnId: signal.turnId,
      ...(signal.threadId === undefined ? {} : { threadId: signal.threadId })
    };
    return { terminalSessionId: message.terminalSessionId, signal };
  }

  /** Runs the app's reaction after the current I/O callback, in arrival order; a failure there never reaches a hook. */
  private deliverLater(delivery: Delivery | null): void {
    const onSignal = this.onSignal;
    if (!delivery || !onSignal) return;
    setImmediate(() => {
      try {
        onSignal(delivery.terminalSessionId, delivery.signal);
      } catch (error) {
        console.warn("CanvasTTY could not apply an agent lifecycle event:", error instanceof Error ? error.message : String(error));
      }
    });
  }

  private async startHttp(): Promise<void> {
    const server = createHttpServer({
      maxHeaderSize: HTTP_MAX_HEADER_BYTES,
      headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
      requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
      keepAliveTimeout: HTTP_KEEP_ALIVE_MS
    }, (request, response) => this.acceptHttp(request, response));
    server.maxHeadersCount = HTTP_MAX_HEADERS;
    server.maxConnections = HTTP_MAX_CONNECTIONS;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      console.warn("CanvasTTY runs Claude Code lifecycle hooks through its helper: the loopback listener did not start.",
        error instanceof Error ? error.message : String(error));
      server.close();
      return;
    }
    server.on("error", () => undefined);
    this.httpServer = server;
    this.httpPort = (server.address() as AddressInfo).port;
  }

  /**
   * One Claude Code HTTP lifecycle hook: `POST /claude/v1/<state>/<event>` with the session id and capability in
   * headers Claude fills from the session's environment. Anything a browser could send (another Origin, a form
   * content type, a rebound Host) is refused before the body is read. The answer is always `{}`: lifecycle hooks
   * decide nothing, and Claude goes on whatever the status.
   */
  private acceptHttp(request: IncomingMessage, response: ServerResponse): void {
    const finish = (status: number, closeConnection = status !== 200): void => {
      if (response.headersSent) return;
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...(closeConnection ? { connection: "close" } : {})
      });
      response.end("{}");
    };
    const route = httpRoute(request, this.httpPort);
    if (typeof route === "number") return finish(route);
    const headerValue = (name: string): string | null => {
      const value = request.headers[name];
      return typeof value === "string" ? value : null;
    };
    const terminalSessionId = headerValue(CLAUDE_HTTP_HOOK.sessionHeader);
    const capability = headerValue(CLAUDE_HTTP_HOOK.capabilityHeader);
    const lease = terminalSessionId && terminalSessionId.length <= 160 ? this.leases.get(terminalSessionId) : undefined;
    if (!lease || lease.provider !== "claude") return finish(401);
    if (!capability) {
      // Claude sent the session but not its capability: a settings policy (httpHookAllowedEnvVars) emptied the
      // header. New launches go back to the helper for the rest of this run.
      this.httpUnusable = true;
      return finish(401);
    }
    if (capability.length < 32 || !tokenMatches(capability, lease.tokenDigest)) return finish(401);
    const declared = Number(request.headers["content-length"]);
    let size = 0;
    let oversized = Number.isFinite(declared) && declared > MAX_HOOK_INPUT_BYTES;
    const chunks: Buffer[] = [];
    // Once per request: an input found oversized while it streams completes at once, and again at its "end".
    let completed = false;
    const complete = (): void => {
      if (completed || response.headersSent) return;
      completed = true;
      let input: unknown = null;
      if (!oversized) {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          input = raw.trim().length > 0 ? JSON.parse(raw) : null;
        } catch {
          input = null;
        }
      }
      let delivery: Delivery | null = null;
      try {
        delivery = this.leases.get(terminalSessionId!) === lease
          ? this.applyLifecycle(lease, claudeLifecycleMessage(terminalSessionId!, route.state, route.event, input, lease.captureResult))
          : null;
      } catch {
        delivery = null;
      }
      // An oversized body is still being sent: answer once it has arrived (read and dropped), so the connection is
      // closed after it rather than reset under the sender, which would lose the answer (ECONNRESET).
      if (oversized && !request.complete) {
        request.resume();
        request.once("end", () => finish(200, true));
        request.once("close", () => finish(200, true));
      } else {
        finish(200, oversized);
      }
      this.deliverLater(delivery);
    };
    if (oversized) return complete();
    request.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_HOOK_INPUT_BYTES) {
        // Like the helper: an input over the bound still reports its state, without any of its fields.
        oversized = true;
        chunks.length = 0;
        complete();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", complete);
    request.on("error", () => undefined);
  }

  /**
   * One decision hook call. Authenticated exactly like a lifecycle message, and only for a session launched with
   * decision hooks. The socket stays open until the answer; a closed socket, a revoke or the gateway deadline
   * aborts the check, and the answer is then `ask`. Checks are capped per session and in total; over a cap the
   * call is refused with a message asking the model to slow down (a flood must not slip past the rules).
   * An `ask` that stands for the gateway's own failure (deadline, a handler that threw or answered nonsense) is marked
   * `unavailable`, so a fail-closed gate for a CLI that cannot ask denies it instead of letting the call run.
   */
  private acceptPermission(socket: AgentGatewaySocket, value: Record<string, unknown>, close: () => void): void {
    let request: RuntimePermissionRequest & { terminalSessionId: string; capabilityToken: string };
    try {
      request = parsePermissionMessage(value);
    } catch {
      return close();
    }
    const lease = this.leases.get(request.terminalSessionId);
    if (!lease || lease.provider !== request.provider) return close();
    if (!tokenMatches(request.capabilityToken, lease.tokenDigest) || !lease.decisions) return close();
    const { terminalSessionId, capabilityToken: _token, ...forwarded } = request;
    let answered = false;
    const answer = (decision: RuntimePermissionDecision, unavailable = false): void => {
      if (answered) return;
      answered = true;
      const line = {
        v: RUNTIME_PROTOCOL_VERSION,
        type: "permission_decision",
        requestId: request.requestId,
        behavior: decision.behavior,
        ...(decision.message ? { message: decision.message } : {}),
        ...(unavailable ? { unavailable: true } : {})
      };
      try {
        socket.write(Buffer.from(`${JSON.stringify(line)}\n`, "utf8"));
      } catch { /* the hook is gone: the CLI goes on without an answer */ }
      const timeout = setTimeout(close, 1_000);
      timeout.unref();
    };
    if (lease.checks.size >= MAX_DECISIONS_PER_SESSION || this.checks.size >= MAX_DECISIONS_TOTAL) {
      return answer({ behavior: "deny", message: OVERLOADED_MESSAGE });
    }
    const controller = new AbortController();
    lease.checks.add(controller);
    this.checks.add(controller);
    const deadline = setTimeout(() => controller.abort(), lease.gatewayMs);
    deadline.unref();
    const settle = (decision: RuntimePermissionDecision | null): void => {
      clearTimeout(deadline);
      lease.checks.delete(controller);
      this.checks.delete(controller);
      if (controller.signal.aborted || !isDecision(decision)) return answer({ behavior: "ask" }, true);
      answer(enforceDecision(forwarded, decision));
    };
    controller.signal.addEventListener("abort", () => settle(null), { once: true });
    socket.on("close", () => controller.abort());
    const handler = this.onPermissionRequest;
    if (!handler) return settle({ behavior: "none" });
    let pendingAnswer: Promise<RuntimePermissionDecision>;
    try {
      pendingAnswer = Promise.resolve(handler(terminalSessionId, forwarded, controller.signal));
    } catch {
      return settle(null);
    }
    pendingAnswer.then(settle, () => settle(null));
  }
}

interface Delivery {
  terminalSessionId: string;
  signal: RuntimeLifecycleSignal;
}

/**
 * The route of a Claude HTTP hook request, or the status that refuses it. Only a JSON POST addressed to this
 * listener's own loopback Host passes, and only without the headers a browser adds (Origin, Referer, Sec-Fetch-*).
 */
function httpRoute(request: IncomingMessage, port: number | null): { state: RuntimeLifecycleState; event: string } | number {
  if (request.method !== "POST") return 405;
  if (port === null || request.headers.host !== `127.0.0.1:${port}`) return 403;
  if (request.headers.origin !== undefined || request.headers.referer !== undefined
    || request.headers["sec-fetch-site"] !== undefined || request.headers["sec-fetch-mode"] !== undefined) return 403;
  const type = request.headers["content-type"];
  if (typeof type !== "string" || type.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") return 415;
  const path = request.url ?? "";
  if (!path.startsWith(CLAUDE_HTTP_HOOK.pathPrefix)) return 404;
  const parts = path.slice(CLAUDE_HTTP_HOOK.pathPrefix.length).split("/");
  if (parts.length !== 2 || !(RUNTIME_STATES as readonly string[]).includes(parts[0]!) || !HTTP_EVENT_RE.test(parts[1]!)) return 404;
  return { state: parts[0] as RuntimeLifecycleState, event: parts[1]! };
}

/** What hook-helper.mjs would have sent for this Claude hook input (same fields, same bounds). */
function claudeLifecycleMessage(
  terminalSessionId: string,
  state: RuntimeLifecycleState,
  event: string,
  input: unknown,
  captureResult: boolean
): Omit<ParsedLifecycleMessage, "capabilityToken"> {
  const record = isRecord(input) ? input : {};
  const turnId = firstString(record.turn_id, record.turnId, record.prompt_id, record.promptId);
  const threadId = normalizeThreadId("claude", firstString(
    record.session_id, record.sessionId, record.thread_id, record.threadId, record.conversation_id, record.conversationId
  ));
  const finalAnswer = state === "idle" && event === "Stop" && typeof record.last_assistant_message === "string"
    ? record.last_assistant_message
    : null;
  let result: { text: string; truncated: boolean } | undefined;
  if (captureResult && finalAnswer !== null) {
    const text = boundedText(finalAnswer, MAX_RESULT_CHARS);
    result = { text, truncated: text.length < finalAnswer.length };
  }
  return {
    terminalSessionId,
    provider: "claude",
    state,
    event,
    turnId: turnId !== null && turnId.length <= 160 ? turnId : null,
    ...(threadId !== undefined ? { threadId } : {}),
    ...(result === undefined ? {} : { result })
  };
}

function firstString(...values: unknown[]): string | null {
  const found = values.find((value) => typeof value === "string" && value.length > 0);
  return typeof found === "string" ? found : null;
}

/** Cuts at the limit without leaving a dangling high surrogate. */
function boundedText(value: string, limit: number): string {
  const text = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/u.test(text) ? text.slice(0, -1) : text;
}

/** What leaves the gateway, whatever the handler said: never an allow of cut input. */
const MAX_SEEN_TURNS = 64;

function rememberTurn(lease: RuntimeLease, turnId: string): void {
  lease.seenTurnIds.delete(turnId);
  lease.seenTurnIds.add(turnId);
  while (lease.seenTurnIds.size > MAX_SEEN_TURNS) lease.seenTurnIds.delete(lease.seenTurnIds.values().next().value!);
}

function enforceDecision(request: RuntimePermissionRequest, decision: RuntimePermissionDecision): RuntimePermissionDecision {
  if (decision.behavior === "allow" && request.truncated) return { behavior: "ask" };
  const message = typeof decision.message === "string" ? decision.message.slice(0, PERMISSION_GATE.messageChars) : "";
  return { behavior: decision.behavior, ...(message ? { message } : {}) };
}

function isDecision(decision: RuntimePermissionDecision | null | undefined): decision is RuntimePermissionDecision {
  return Boolean(decision) && ["allow", "deny", "ask", "none"].includes(decision!.behavior);
}

function isPermissionRequest(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "permission_request";
}

const PERMISSION_KEYS = [
  "capabilityToken", "cwd", "provider", "requestId", "terminalSessionId", "toolInput",
  "toolInputPreview", "toolInputSha256", "toolName", "truncated", "type", "v"
].sort().join(",");

function parsePermissionMessage(value: Record<string, unknown>): RuntimePermissionRequest & { terminalSessionId: string; capabilityToken: string } {
  if (Object.keys(value).sort().join(",") !== PERMISSION_KEYS) throw new Error("Permission request has an invalid schema.");
  if (value.v !== RUNTIME_PROTOCOL_VERSION || value.type !== "permission_request") throw new Error("Permission request version is unsupported.");
  if (
    typeof value.terminalSessionId !== "string" || !value.terminalSessionId || value.terminalSessionId.length > 160
    || typeof value.provider !== "string" || !AGENT_PROVIDER_SET.has(value.provider as ProviderId)
    || typeof value.capabilityToken !== "string" || value.capabilityToken.length < 32
    || typeof value.requestId !== "string" || !/^[A-Za-z0-9-]{8,80}$/u.test(value.requestId)
    || typeof value.toolName !== "string" || !value.toolName || value.toolName.length > PERMISSION_GATE.toolNameChars
    || typeof value.toolInputSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.toolInputSha256)
    || typeof value.truncated !== "boolean"
    || (value.cwd !== null && (typeof value.cwd !== "string" || !value.cwd || value.cwd.length > 4_096))
    || (value.toolInputPreview !== null && (typeof value.toolInputPreview !== "string" || value.toolInputPreview.length > PERMISSION_GATE.toolInputPreviewChars))
  ) throw new Error("Permission request fields are invalid.");
  // Cut input carries only its preview; whole input carries no preview and must match its hash.
  if (value.truncated ? value.toolInput !== null || value.toolInputPreview === null : value.toolInputPreview !== null) {
    throw new Error("Permission request input is inconsistent.");
  }
  if (!value.truncated && createHash("sha256").update(JSON.stringify(value.toolInput), "utf8").digest("hex") !== value.toolInputSha256) {
    throw new Error("Permission request input does not match its hash.");
  }
  return value as unknown as RuntimePermissionRequest & { terminalSessionId: string; capabilityToken: string };
}

function isAnswerCaptureCheck(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "answer-capture-check";
}

/** The turn-end events that carry a final answer: a Stop hook, or OpenCode's own session.idle (its plugin reads it). */
function isResultEvent(provider: unknown, event: unknown): boolean {
  return event === "Stop" || (provider === "opencode" && event === "session.idle");
}

function parseLifecycleMessage(value: unknown): ParsedLifecycleMessage {
  if (!isRecord(value)) throw new Error("Runtime message must be an object.");
  const keys = Object.keys(value).filter((key) => key !== "lastAssistantMessage").sort();
  const expected = [
    "capabilityToken", "event", "provider", "state", "terminalSessionId", "turnId", "type", "v"
  ];
  if (value.result !== undefined) expected.push("result");
  if (value.threadId !== undefined) expected.push("threadId");
  expected.sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Runtime message has an invalid schema.");
  }
  if (value.v !== RUNTIME_PROTOCOL_VERSION || value.type !== "lifecycle") {
    throw new Error("Runtime message version is unsupported.");
  }
  if (
    typeof value.terminalSessionId !== "string"
    || value.terminalSessionId.length === 0
    || value.terminalSessionId.length > 160
    || typeof value.provider !== "string"
    || !AGENT_PROVIDER_SET.has(value.provider as ProviderId)
    || typeof value.capabilityToken !== "string"
    || value.capabilityToken.length < 32
    || typeof value.state !== "string"
    || !(RUNTIME_STATES as readonly string[]).includes(value.state)
    || typeof value.event !== "string"
    || value.event.length === 0
    || value.event.length > 80
    || (value.turnId !== null && (typeof value.turnId !== "string" || value.turnId.length > 160))
  ) throw new Error("Runtime message fields are invalid.");
  // Only the provider's own id shape, already in its stored form, is accepted.
  if (value.threadId !== undefined && normalizeThreadId(String(value.provider), value.threadId) !== value.threadId) {
    throw new Error("Runtime threadId is invalid.");
  }
  if (value.result !== undefined && (
    value.state !== "idle" || !isResultEvent(value.provider, value.event) || !isRecord(value.result)
    || Object.keys(value.result).sort().join(",") !== "text,truncated"
    || typeof value.result.text !== "string" || value.result.text.length > MAX_RESULT_CHARS
    || typeof value.result.truncated !== "boolean"
  )) throw new Error("Runtime result is invalid.");
  if (value.lastAssistantMessage !== undefined && (
    value.provider !== "codex" || value.event !== "Stop" || value.state !== "idle"
    || typeof value.lastAssistantMessage !== "string" || value.lastAssistantMessage.length > MAX_ANSWER_CHARS
  )) throw new Error("Runtime lastAssistantMessage is invalid.");
  return value as unknown as ParsedLifecycleMessage;
}

function isTurnStart(event: string): boolean {
  return event === "UserPromptSubmit"
    || event === "TurnStarted"
    || event === "pre_llm_call"
    || event === "session.status:busy"
    || event === "session.status:retry";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function createEndpoint(requestedRuntimeDirectory?: string): Promise<{
  endpoint: string;
  ownedRuntimeDirectory: string | null;
}> {
  const suffix = randomBytes(8).toString("hex");
  const runtimeDirectory = requestedRuntimeDirectory
    ?? join(tmpdir(), `ctty-runtime-${process.getuid?.() ?? "user"}-${suffix}`);
  await makePrivateDirectory(runtimeDirectory, { recursive: true });
  const endpoint = join(runtimeDirectory, `r-${randomBytes(2).toString("hex")}.sock`);
  if (Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("Agent runtime directory is too long for a Unix domain socket.");
  }
  return {
    endpoint,
    ownedRuntimeDirectory: requestedRuntimeDirectory ? null : runtimeDirectory
  };
}
