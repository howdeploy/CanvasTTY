import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lazyRequire } from "../../lazyRequire.ts";
import { NdjsonLineReader } from "../../../agent-runtime/ndjson.mjs";
import { MAX_UNIX_SOCKET_PATH_BYTES, closeServer, listenOnEndpoint, tokenDigest, tokenMatches } from "../gatewaySocket.ts";
import type { AgentProviderId, AppSettings, CreateSessionRequest, PixelSkinApertures, SessionMetadata, SessionSnapshot, TerminalBufferSnapshot } from "../../../shared/contracts.ts";
import { IPC } from "../../../shared/contracts.ts";
import type { RuntimeLifecycleSignal } from "../agent-runtime/RuntimeGateway.ts";
import { WindowsPipeHostTransport, type AgentGatewaySocket } from "../agent-browser/WindowsPipeHostTransport.ts";
import { CONTROL_PROVIDERS, controlCapabilities, isControlProvider } from "./controlCapabilities.ts";
import { isLaunchProfile } from "../../../shared/autoMode.ts";
import { LaunchRefusal } from "../launchRefusal.ts";
import { MAX_PIXEL_SKIN_ARCHIVE_BYTES, type PixelSkinPackRegistry } from "../PixelSkinPackRegistry.ts";
import type { SettingsStore } from "../SettingsStore.ts";
import { listProviderDirectory, type ProviderDirectory } from "../providerDirectory.ts";
import type { ExecutionTarget } from "../../../shared/executionPolicy.ts";
import { launchEffortProblem, launchModelProblem, type ReasoningEffort } from "../../../shared/launchModel.ts";

// Headless terminals are created on demand; the module loads with the first one.
const xterm = lazyRequire<typeof import("@xterm/headless")>("@xterm/headless");

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const BUILT_IN_PIXEL_SKINS = ["sakura", "matrix", "forest-cabin", "gold-black", "cat", "gothic-eclipse"];
const MAX_RECEIPTS = 4096;
// Refusals that happen before anything is written: a retry with the same
// request id must be performed again instead of replaying the refusal.
const RETRYABLE_REFUSALS = new Set(["BUSY", "NOT_READY", "LIMIT_REACHED", "LIFECYCLE_DISABLED", "CLOSED"]);
const MAX_SESSIONS = 32;
/** How long close() waits for a session's queued headless-terminal writes before disposing it anyway. */
const CLOSE_DRAIN_TIMEOUT_MS = 2_000;
const TRANSPORT_RESTART_BASE_DELAY_MS = 500;
/** A pipe host that keeps failing is tried again at most this far apart, never given up on. */
const TRANSPORT_RESTART_MAX_DELAY_MS = 60_000;
const MAX_TEXT = 16_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
/**
 * What a caller that is not CanvasTTY's control CLI reads (an unauthenticated, malformed or HTTP request): why it
 * was refused and what to do instead. Stable, and free of protocol details, file names and paths.
 */
export const CONTROL_REFUSAL_MESSAGE = "CanvasTTY refused this request: this endpoint only accepts requests from sessions CanvasTTY itself launched as orchestrators, and guessing its protocol will not work. If you are an agent and need other agents, ask the person to start you from CanvasTTY's launcher with the Orchestrator role: you will then get the canvastty_agents tools: call list_providers to see which agents CanvasTTY can launch, then spawn_agent, wait_for_agent and get_agent_result. Do not search the filesystem for agent CLIs or their configuration.";
/** An HTTP request line (curl, a browser, an HTTP/2 preface): answered with a minimal 403 instead of NDJSON. */
const HTTP_REQUEST_LINE = /^[A-Z]{3,10} \S{1,4096} HTTP\/\d(?:\.\d)?\r?$/;
const SECRET = /^[a-f0-9]{64}$/;

interface TerminalPort {
  create(request: CreateSessionRequest, options?: { captureResult?: boolean; origin?: "control" }): SessionSnapshot;
  listMetadata(): SessionMetadata[];
  readBuffer(id: string): TerminalBufferSnapshot;
  inputChecked(id: string, text: string): boolean;
  /** The launch still waits for its plugins: the card cannot take input yet. */
  launchPending?(id: string): boolean;
  geometry(id: string): { cols: number; rows: number };
  /** Masks plugin launch secrets in text handed to a controller. */
  redactSecrets?(text: string): string;
  /** Closes a card (a create whose setup failed must not leave one running without its controller). */
  dispose?(id: string): void;
}

/** Who sent a request: the person's own automation (the app-wide token) or one orchestrator session (its grant). */
type ControlScope = { kind: "person" } | { kind: "session"; sessionId: string };

/** What an orchestrator's control CLI asks for when it creates a worker: a subagent of that orchestrator. */
export interface SubagentSpawn {
  executionTargetId?: string;
  parentSessionId: string;
  provider: AgentProviderId;
  cwd: string;
  title?: string;
  profile?: unknown;
  model?: string;
  effort?: ReasoningEffort;
}

interface ControlRequest {
  v: 1;
  scope?: ControlScope;
  id: string;
  instanceId: string;
  token: string;
  controller: string;
  method: "create" | "list" | "providers" | "execution-targets" | "status" | "screen" | "send" | "result" | "interrupt" | "choose" | "dismiss"
    | "skin-list" | "skin-install" | "skin-select";
  params: Record<string, unknown>;
}

interface Turn {
  id: string;
  state: "queued" | "working" | "completed" | "interrupted" | "no_result";
  sawWorking: boolean;
  nativeTurnId: string | null;
  interruptRequested: boolean;
  result: { text: string; truncated: boolean } | null;
}

interface OwnedSession {
  owner: string;
  startedAt: number;
  terminal: import("@xterm/headless").Terminal;
  ready: Promise<void>;
  outputOffset: number;
  resultRevision: number;
  turn: Turn | null;
  completedTurn: Turn | null;
}

export interface AgentControlGatewayOptions {
  userDataPath: string;
  terminals: TerminalPort;
  pixelSkinPacks?: PixelSkinPackRegistry;
  settings?: SettingsStore;
  onSettingsChanged?(settings: AppSettings): void;
  lifecycleEnabled(): boolean;
  platform?: NodeJS.Platform;
  windowsHostPath?: string;
  windowsPipeHostFactory?: (options: { hostPath: string; platform: NodeJS.Platform; parentPid: number }) => WindowsPipeHostTransport;
  /** Receipts kept for request-id replay (default 4096); the oldest settled ones are dropped first. */
  maxReceipts?: number;
  /** Why a worker's model would not start (its CLI lists models and not this one), or null. */
  checkModel?(provider: AgentProviderId, model: string): Promise<string | null>;
  /** What `providers` answers: the agent providers this CanvasTTY can create workers for (cached state only). */
  providers?(): ProviderDirectory;
  /** Called after the Windows pipe host was restarted and connection.json names the new endpoint. */
  onTransportRestarted?(connectionPath: string): void;
  /**
   * Creates a worker for an orchestrator's own control connection as its subagent, under every delegation rule
   * (AgentControlService.spawn: profile at most the orchestrator's, never YOLO, folder inside its project, the
   * person's limits). Without it an orchestrator's connection cannot create workers.
   */
  spawnSubagent?(request: SubagentSpawn): Promise<SessionMetadata>;
  /** Read-only destinations permitted for the grant's task; null means policy is disabled. */
  executionTargets?(sessionId: string): ExecutionTarget[] | null;
}

class ControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Explicitly enabled, current-user-only control of sessions created by one controller. */
export class AgentControlGateway {
  private readonly options: AgentControlGatewayOptions;
  private readonly token = randomBytes(32).toString("hex");
  private readonly tokenHash = tokenDigest(this.token);
  private readonly instanceId = randomBytes(16).toString("hex");
  private readonly sessions = new Map<string, OwnedSession>();
  private readonly sockets = new Set<AgentGatewaySocket>();
  private readonly receipts = new Map<string, { digest: string; result: Promise<unknown>; settled: boolean }>();
  private readonly busy = new Set<string>();
  // Orchestrator sessions' own control connections: token digest -> the session and its private folder.
  private readonly grants = new Map<string, { sessionId: string; folder: string; digest: Buffer }>();
  private endpoint: string | null = null;
  private server: Server | null = null;
  private windows: WindowsPipeHostTransport | null = null;
  private socketDirectory: string | null = null;
  private tokenFileWritten = false;
  private starting = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartAttempts = 0;
  private startingSubagents = 0;
  private closed = false;

  constructor(options: AgentControlGatewayOptions) { this.options = options; }

  async start(): Promise<string> {
    if (this.starting || this.server || this.windows || this.closed) throw new Error("Agent control is already started or closed.");
    this.starting = true;
    try {
      const endpoint = await this.openEndpoint();
      this.endpoint = endpoint;
      const connection = await this.writeDiscovery(endpoint);
      await this.refreshSessionGrants(endpoint);
      return connection;
    } catch (error) {
      // Leave nothing listening and no dead transport behind, so a later start() can succeed.
      await this.closeEndpoint();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async openEndpoint(): Promise<string> {
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      if (!this.options.windowsHostPath) throw new Error("Agent control requires the current-user Windows pipe host.");
      const transport = (this.options.windowsPipeHostFactory ?? ((options) => new WindowsPipeHostTransport(options)))({
        hostPath: this.options.windowsHostPath, platform, parentPid: process.pid
      });
      this.windows = transport;
      transport.on("fatal", () => this.handleTransportFatal(transport));
      const endpoint = await transport.start((socket) => this.accept(socket));
      if (this.windows !== transport || this.closed) {
        await transport.close();
        throw new Error("Agent control is shutting down.");
      }
      return endpoint;
    }
    const directory = await mkdtemp(join(tmpdir(), "ctty-control-"));
    this.socketDirectory = directory;
    await chmod(directory, 0o700);
    const endpoint = join(directory, "c.sock");
    if (Buffer.byteLength(endpoint) > MAX_UNIX_SOCKET_PATH_BYTES) throw new Error("Agent control socket path is too long.");
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await listenOnEndpoint(server, endpoint, platform);
    return endpoint;
  }

  private async writeDiscovery(endpoint: string): Promise<string> {
    const directory = join(this.options.userDataPath, "agent-control");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const tokenFile = join(directory, `token-${this.instanceId}`);
    if (!this.tokenFileWritten) {
      await writeFile(tokenFile, this.token, { flag: "wx", mode: 0o600 });
      this.tokenFileWritten = true;
    }
    const connection = join(directory, "connection.json");
    // Written to a temp file and renamed: a controller reading the record while
    // a restarted host republishes it must never see it empty or half written.
    const temporary = `${connection}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ v: 1, service: "canvastty-agent-control", instanceId: this.instanceId,
        endpoint, tokenFile, pid: process.pid }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, connection);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return connection;
  }

  /** Repoint surviving session grants without changing their capabilities, tokens or controller identities. */
  private async refreshSessionGrants(endpoint: string): Promise<void> {
    for (const [key, grant] of this.grants) {
      const connection = join(grant.folder, "connection.json");
      const temporary = `${connection}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ v: 1, service: "canvastty-agent-control", instanceId: this.instanceId,
          endpoint, tokenFile: join(grant.folder, `token-${this.instanceId}`), pid: process.pid, scope: "session" }, null, 2) + "\n",
        { mode: 0o600, flag: "wx" });
        // A card may close while the file write is in flight. Never recreate or republish its withdrawn grant.
        if (this.closed || this.grants.get(key) !== grant) continue;
        await rename(temporary, connection);
      } catch (error) {
        if (!this.closed && this.grants.get(key) === grant) throw error;
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    if (this.closed) throw new Error("Agent control is shutting down.");
  }

  private async closeEndpoint(): Promise<void> {
    const server = this.server;
    const transport = this.windows;
    const directory = this.socketDirectory;
    this.server = null;
    this.windows = null;
    this.socketDirectory = null;
    this.endpoint = null;
    if (transport) await transport.close().catch(() => undefined);
    if (server) await closeServer(server);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  /** The Windows pipe host died: drop its connections and bring up a new one with a fresh discovery record. */
  private handleTransportFatal(transport: WindowsPipeHostTransport): void {
    if (this.windows !== transport) return;
    this.windows = null;
    this.endpoint = null;
    for (const socket of this.sockets) socket.destroy();
    this.scheduleTransportRestart();
  }

  private scheduleTransportRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = Math.min(TRANSPORT_RESTART_MAX_DELAY_MS, TRANSPORT_RESTART_BASE_DELAY_MS * 2 ** Math.min(this.restartAttempts, 16));
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closed || this.windows || this.starting) return;
      this.start().then((connection) => {
        this.restartAttempts = 0;
        this.options.onTransportRestarted?.(connection);
      }, () => this.scheduleTransportRestart());
    }, delay);
    this.restartTimer.unref?.();
  }

  /**
   * A private control connection for one orchestrator session: its own descriptor, token and controller file in a
   * folder of its own. Requests with it act as that orchestrator: `create` makes its subagents under every delegation
   * rule, and nothing that changes CanvasTTY's settings is available. The app-wide descriptor (the person's own
   * automation) is never handed to an agent. Replaces the session's previous grant; null while the endpoint is off.
   */
  grantSession(sessionId: string): string | null {
    if (this.closed || !this.endpoint || typeof sessionId !== "string" || !sessionId) return null;
    this.revokeSession(sessionId);
    const root = join(this.options.userDataPath, "agent-control", "sessions");
    const folder = join(root, randomBytes(12).toString("hex"));
    const token = randomBytes(32).toString("hex");
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      chmodSync(root, 0o700);
      mkdirSync(folder, { mode: 0o700 });
      writeFileSync(join(folder, `token-${this.instanceId}`), token, { flag: "wx", mode: 0o600 });
      // The controller identity is fixed for the grant, so the CLI never has to write next to its descriptor.
      writeFileSync(join(folder, "controller.json"), JSON.stringify({ v: 1, controller: randomBytes(32).toString("hex"), instanceId: this.instanceId }) + "\n", { flag: "wx", mode: 0o600 });
      const connection = join(folder, "connection.json");
      writeFileSync(connection, JSON.stringify({ v: 1, service: "canvastty-agent-control", instanceId: this.instanceId,
        endpoint: this.endpoint, tokenFile: join(folder, `token-${this.instanceId}`), pid: process.pid, scope: "session" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      const digest = tokenDigest(token);
      this.grants.set(digest.toString("hex"), { sessionId, folder, digest });
      return connection;
    } catch {
      rmSync(folder, { recursive: true, force: true });
      return null;
    }
  }

  /** Withdraws a session's control connection (its card closed, restarted or the endpoint stopped). */
  revokeSession(sessionId: string): void {
    for (const [key, grant] of this.grants) {
      if (grant.sessionId !== sessionId) continue;
      this.grants.delete(key);
      rmSync(grant.folder, { recursive: true, force: true });
    }
  }

  observe(channel: string, payload: unknown): void {
    // Once closing, PTY output must not keep extending a session's `ready` chain: close() awaits a
    // fixed snapshot of it, and an observation accepted afterwards would grow the chain forever.
    if (this.closed) return;
    if (channel === IPC.terminalRemoved) {
      const id = (payload as { id: string }).id;
      this.revokeSession(id);
      const owned = this.sessions.get(id);
      if (owned) {
        this.sessions.delete(id);
        void owned.ready.then(() => owned.terminal.dispose()).catch(() => undefined);
      }
      return;
    }
    if (channel !== IPC.terminalData) return;
    const event = payload as { id: string; data: string; outputOffset: number };
    const owned = this.sessions.get(event.id);
    if (!owned) return;
    const overlap = Math.max(0, owned.outputOffset - (event.outputOffset - event.data.length));
    const data = event.data.slice(overlap);
    owned.outputOffset = Math.max(owned.outputOffset, event.outputOffset);
    const geometry = this.options.terminals.geometry(event.id);
    if (data) owned.ready = owned.ready.then(() => new Promise<void>((resolve) => {
      if (owned.terminal.cols !== geometry.cols || owned.terminal.rows !== geometry.rows) owned.terminal.resize(geometry.cols, geometry.rows);
      owned.terminal.write(data, resolve);
    }));
  }

  onSignal(id: string, signal: RuntimeLifecycleSignal): void {
    const owned = this.sessions.get(id);
    const turn = owned?.turn;
    if (!owned || !turn || !["queued", "working"].includes(turn.state)) return;
    const metadata = this.options.terminals.listMetadata().find((s) => s.id === id);
    if (!metadata || metadata.startedAt !== owned.startedAt) return;
    if (signal.state === "working") {
      if (!turn.sawWorking) turn.nativeTurnId = signal.turnId;
      turn.sawWorking = true; turn.state = "working";
    }
    if (signal.turnId && turn.nativeTurnId && signal.turnId !== turn.nativeTurnId) return;
    if (signal.state !== "idle" || !turn.sawWorking) return;
    turn.state = turn.interruptRequested ? "interrupted" : signal.result ? "completed" : "no_result";
    turn.result = signal.result ?? null;
    owned.completedTurn = structuredClone(turn);
    owned.resultRevision += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    for (const socket of this.sockets) socket.destroy();
    // Fixed snapshot: `observe` refuses new writes once `closed` is set above, so this is every
    // session's whole pending output as of now, not a chain that PTY output could keep growing.
    const owned = [...this.sessions.values()];
    await Promise.all(owned.map((session) => Promise.race([session.ready, delay(CLOSE_DRAIN_TIMEOUT_MS)]).catch(() => undefined)));
    for (const session of owned) session.terminal.dispose();
    this.sessions.clear();
    for (const grant of this.grants.values()) rmSync(grant.folder, { recursive: true, force: true });
    this.grants.clear();
    this.endpoint = null;
    await this.closeEndpoint();
    // Retain inert discovery/diagnostic records; a new app instance gets a new token and instanceId.
  }

  private accept(socket: AgentGatewaySocket): void {
    if (this.closed || this.sockets.size >= 32) { socket.destroy(); return; }
    this.sockets.add(socket);
    const lines = new NdjsonLineReader({ maxLineBytes: MAX_REQUEST_BYTES });
    let handled = false;
    let timer = setTimeout(() => socket.destroy(), 10_000);
    timer.unref();
    socket.setNoDelay(true);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { clearTimeout(timer); this.sockets.delete(socket); });
    const reply = (value: unknown): void => {
      if (socket.destroyed) return;
      try {
        const data = Buffer.from(JSON.stringify(value) + "\n");
        if (data.length > MAX_RESPONSE_BYTES) { socket.destroy(); return; }
        socket.write(data);
      } catch { socket.destroy(); }
    };
    // A refusal is answered once and the connection closed, so a caller is not left waiting for the timeout.
    const close = (): void => {
      // A Unix socket half-closes after the reply is flushed; the Windows relay has no end(), so it is dropped shortly.
      const end = (socket as { end?: () => void }).end;
      if (typeof end === "function") end.call(socket);
      else setTimeout(() => socket.destroy(), 250).unref();
    };
    const refuse = (line: Buffer): void => {
      if (socket.destroyed) return;
      if (HTTP_REQUEST_LINE.test(line.subarray(0, 4200).toString("latin1"))) {
        const body = Buffer.from(`${CONTROL_REFUSAL_MESSAGE}\n`);
        socket.write(Buffer.concat([Buffer.from("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n"
          + `Content-Length: ${body.length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`), body]));
      } else {
        reply({ v: 1, ok: false, error: { code: "INVALID_REQUEST", message: CONTROL_REFUSAL_MESSAGE } });
      }
      close();
    };
    socket.on("data", (chunk) => {
      if (handled) return;
      let line: Buffer | undefined;
      try { [line] = lines.push(chunk); } catch { socket.destroy(); return; }
      if (!line) return;
      handled = true;
      let request: ControlRequest;
      try { request = this.parse(JSON.parse(line.toString("utf8"))); }
      catch { refuse(line); return; }
      if (request.method === "skin-install") {
        clearTimeout(timer);
        timer = setTimeout(() => socket.destroy(), 120_000);
        timer.unref();
      }
      void this.dispatch(request).then(
        (result) => reply({ v: 1, id: request.id, ok: true, result }),
        (error: unknown) => reply({ v: 1, id: request.id, ok: false, error: {
          code: error instanceof ControlError ? error.code : "CONTROL_FAILED",
          message: error instanceof ControlError ? error.message : "Agent control operation failed."
        } })
      );
    });
  }

  private parse(value: unknown): ControlRequest {
    if (!record(value) || Object.keys(value).sort().join(",") !== "controller,id,instanceId,method,params,token,v"
      || value.v !== 1 || typeof value.id !== "string" || !ID.test(value.id)
      || value.instanceId !== this.instanceId || typeof value.token !== "string" || !SECRET.test(value.token)
      || typeof value.controller !== "string" || !SECRET.test(value.controller)
      || !["create", "list", "providers", "execution-targets", "status", "screen", "send", "result", "interrupt", "choose", "dismiss",
        "skin-list", "skin-install", "skin-select"].includes(String(value.method))
      || !record(value.params)) throw new Error("Invalid envelope");
    let scope: ControlScope | null = tokenMatches(value.token, this.tokenHash) ? { kind: "person" } : null;
    if (!scope) {
      for (const grant of this.grants.values()) {
        if (tokenMatches(value.token, grant.digest)) { scope = { kind: "session", sessionId: grant.sessionId }; break; }
      }
    }
    if (!scope) throw new Error("Invalid credential");
    return { ...(value as unknown as ControlRequest), scope };
  }

  private async dispatch(request: ControlRequest): Promise<unknown> {
    // One orchestrator owns everything its connection creates, whatever client file its commands use.
    const owner = request.scope?.kind === "session" ? hash(`session:${request.scope.sessionId}`) : hash(request.controller);
    const mutating = ["create", "send", "interrupt", "choose", "dismiss", "skin-install", "skin-select"].includes(request.method);
    if (!mutating) return this.perform(owner, request);
    const key = `${owner}:${request.id}`;
    const digest = hash(JSON.stringify([request.method, Object.entries(request.params).sort(([a], [b]) => a.localeCompare(b))]));
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new ControlError("REQUEST_CONFLICT", "Request ID was already used for different input.");
      return previous.result;
    }
    if (!this.makeReceiptRoom()) throw new ControlError("LIMIT_REACHED", "Too many control requests are still running.");
    const result = this.perform(owner, request);
    const receipt = { digest, result, settled: false };
    this.receipts.set(key, receipt);
    result.then(() => { receipt.settled = true; }, (error: unknown) => {
      receipt.settled = true;
      if (error instanceof ControlError && RETRYABLE_REFUSALS.has(error.code) && this.receipts.get(key) === receipt) {
        this.receipts.delete(key);
      }
    });
    return result;
  }

  /** Drops the oldest finished receipts once the cap is reached; running ones are kept. */
  private makeReceiptRoom(): boolean {
    const limit = this.options.maxReceipts ?? MAX_RECEIPTS;
    if (this.receipts.size < limit) return true;
    for (const [key, receipt] of this.receipts) {
      if (!receipt.settled) continue;
      this.receipts.delete(key);
      if (this.receipts.size < limit) return true;
    }
    return this.receipts.size < limit;
  }

  private async perform(owner: string, request: ControlRequest): Promise<unknown> {
    if (this.closed) throw new ControlError("CLOSED", "Agent control is shutting down.");
    const params = request.params;
    const agent = request.scope?.kind === "session" ? request.scope.sessionId : null;
    if (request.method === "skin-list" || request.method === "skin-install" || request.method === "skin-select") {
      // An agent's connection changes nothing of CanvasTTY's own: settings, themes, protection are the person's.
      if (agent) throw new ControlError("NOT_ALLOWED", "An agent's control connection cannot change CanvasTTY's settings or themes; only the person can, in the app.");
      return this.performSkinOperation(request.method, params);
    }
    if (request.method === "create" && agent) return this.createSubagent(owner, agent, params);
    if (request.method === "create") {
      fields(params, ["provider", "cwd", "title", "profile", "model", "effort"]);
      if (!isControlProvider(params.provider)) throw new ControlError("INVALID_PARAMS", `Unknown agent provider. Run the providers command to see which agents CanvasTTY can launch; provider must be one of: ${CONTROL_PROVIDERS.join(", ")}.`);
      if (!isLaunchProfile(params.profile)) throw new ControlError("INVALID_PARAMS", "Specify an explicit launch profile: auto, normal, acceptEdits, plan or yolo.");
      const provider = params.provider;
      const capabilities = controlCapabilities(provider);
      const requestedCwd = string(params.cwd, 4096, "cwd");
      if (!isAbsolute(requestedCwd)) throw new ControlError("INVALID_PARAMS", "cwd must be absolute.");
      const cwd = await realpath(requestedCwd).catch(() => { throw new ControlError("INVALID_PARAMS", "Project directory does not exist."); });
      if (this.closed) throw new ControlError("CLOSED", "Agent control is shutting down.");
      const title = params.title === undefined ? undefined : string(params.title, 80, "title");
      const modelProblem = (params.model !== undefined ? launchModelProblem(provider, params.model) : null)
        ?? (params.effort !== undefined ? launchEffortProblem(provider, params.effort) : null);
      if (modelProblem) throw new ControlError("INVALID_PARAMS", `${modelProblem} Run the providers command for what ${provider} takes.`);
      if (params.model !== undefined) {
        let unknown: string | null = null;
        try { unknown = await this.options.checkModel?.(provider, params.model as string) ?? null; } catch { unknown = null; }
        if (unknown) throw new ControlError("INVALID_PARAMS", unknown.replace("Call list_providers", "Run the providers command"));
      }
      if (!this.options.lifecycleEnabled()) throw new ControlError("LIFECYCLE_DISABLED", "Enable agent lifecycle hooks before creating controlled sessions.");
      if (this.sessions.size + this.startingSubagents >= MAX_SESSIONS) throw new ControlError("LIMIT_REACHED", "At most 32 controlled sessions are available per app instance.");
      // Result capture is a Codex-only hook; the manager refuses it for anyone else.
      let session: SessionSnapshot;
      try {
        session = this.options.terminals.create({ provider, profile: params.profile, cwd, title,
          ...(params.model !== undefined ? { model: params.model as string } : {}),
          ...(params.effort !== undefined ? { effort: params.effort as ReasoningEffort } : {}),
          position: { x: 1600, y: this.options.terminals.listMetadata().length * 470 } }, { captureResult: capabilities.result, origin: "control" });
      } catch (error) {
        if (error instanceof LaunchRefusal) throw new ControlError("REFUSED", error.message);
        throw error;
      }
      try {
        const terminal = new (xterm().Terminal)({ ...this.options.terminals.geometry(session.id), scrollback: 200, allowProposedApi: true });
        const snapshot = this.options.terminals.readBuffer(session.id);
        const owned: OwnedSession = { owner, startedAt: session.startedAt, terminal,
          ready: new Promise<void>((resolve) => terminal.write(snapshot.buffer, resolve)),
          outputOffset: snapshot.outputOffset, resultRevision: 0, turn: null, completedTurn: null };
        this.sessions.set(session.id, owned);
      } catch (error) {
        // The card started but its controller never got it: close it, so a retry does not leave a second one.
        this.options.terminals.dispose?.(session.id);
        throw error;
      }
      const { buffer: _buffer, ...metadata } = session;
      return { session: metadata, capabilities };
    }
    if (request.method === "execution-targets") {
      fields(params, []);
      if (!agent) throw new ControlError("NOT_ALLOWED", "Execution target discovery requires an orchestrator's scoped connection.");
      if (!this.options.executionTargets) throw new ControlError("NOT_SUPPORTED", "Execution target discovery is unavailable.");
      const targets = this.options.executionTargets(agent);
      return { enabled: targets !== null, targets: targets ?? [] };
    }
    if (request.method === "providers") {
      fields(params, []);
      return this.options.providers?.() ?? listProviderDirectory({ cli: () => null, limits: () => null });
    }
    if (request.method === "list") {
      fields(params, []);
      return { sessions: this.options.terminals.listMetadata().filter((s) => {
        const owned = this.sessions.get(s.id); return owned?.owner === owner && owned.startedAt === s.startedAt;
      }).map((s) => ({ ...this.redactMetadata(s), capabilities: controlCapabilities(s.provider) })) };
    }
    fields(params, request.method === "send" ? ["sessionId", "text"] : request.method === "result" ? ["sessionId", "after"]
      : request.method === "choose" ? ["sessionId", "choice", "revision"]
        : request.method === "dismiss" ? ["sessionId", "revision"] : ["sessionId"]);
    const id = string(params.sessionId, 128, "sessionId");
    const owned = this.sessions.get(id);
    const metadata = this.options.terminals.listMetadata().find((s) => s.id === id);
    if (!owned || owned.owner !== owner || !metadata) throw new ControlError("SESSION_NOT_FOUND", "No owned session has that ID.");
    if (metadata.startedAt !== owned.startedAt) throw new ControlError("STALE_SESSION", "Session restarted; its old control grant is no longer valid.");
    if (request.method === "status") return { session: this.redactMetadata(metadata), resultRevision: owned.resultRevision,
      turn: owned.turn ? { id: owned.turn.id, state: owned.turn.state } : null };
    if (request.method === "result") {
      const after = params.after === undefined ? 0 : params.after;
      if (!Number.isSafeInteger(after) || Number(after) < 0) throw new ControlError("INVALID_PARAMS", "after must be a non-negative result revision.");
      const fresh = owned.resultRevision > Number(after);
      return { session: this.redactMetadata(metadata), resultRevision: owned.resultRevision, fresh,
        turn: fresh && owned.completedTurn ? this.redactTurn(owned.completedTurn) : null };
    }
    await owned.ready;
    if (this.closed) throw new ControlError("CLOSED", "Agent control is shutting down.");
    // The grant was checked before the replay await. Exit and restart reuse the
    // session id, so a write by id after the await would reach the new PTY.
    const current = this.sessions.get(id);
    const fresh = this.options.terminals.listMetadata().find((session) => session.id === id);
    if (current !== owned || current.owner !== owner || !fresh || fresh.startedAt !== owned.startedAt) {
      throw new ControlError("STALE_SESSION", "Session restarted; its old control grant is no longer valid.");
    }
    const capabilities = controlCapabilities(fresh.provider);
    const screen = viewport(owned.terminal, (text) => this.redact(text));
    if (request.method === "screen") return { sessionId: id, text: screen, revision: hash(screen), outputOffset: owned.outputOffset,
      interaction: capabilities.menus ? codexChoices(screen) : null };
    if ((request.method === "choose" || request.method === "dismiss") && !capabilities.menus) {
      throw new ControlError("NOT_SUPPORTED", `Menus are parsed for Codex only; resolve ${fresh.provider} prompts from the desktop and treat screen as the only evidence.`);
    }
    // Its launch plugins are still preparing it: nothing can be written yet, and nothing is queued.
    if (this.options.terminals.launchPending?.(id)) {
      throw new ControlError("NOT_READY", "The session is still starting (its launch is being prepared); nothing was written. Check status again.");
    }
    if (this.busy.has(id)) throw new ControlError("BUSY", "A control operation is pending for this session.");
    this.busy.add(id);
    try {
      if (request.method === "dismiss") {
        if (hash(screen) !== params.revision) throw new ControlError("STALE_MENU", "Screen changed; inspect it again.");
        if (metadata.status === "working" || codexComposerReady(screen) || !/Press[^\n]*(?:esc|escape)/i.test(screen)) {
          throw new ControlError("NOT_MENU", "No dismissible idle menu is visible.");
        }
        if (!this.options.terminals.inputChecked(id, "\x1b")) throw new ControlError("SESSION_EXITED", "The terminal no longer accepts input.");
        return { sessionId: id, delivery: "written-to-pty" };
      }
      if (request.method === "choose") {
        const menu = codexChoices(screen);
        if (!menu || menu.revision !== params.revision) throw new ControlError("STALE_MENU", "Menu changed or is absent; inspect screen before choosing.");
        if (!Number.isSafeInteger(params.choice) || Number(params.choice) < 1 || Number(params.choice) > menu.options.length) {
          throw new ControlError("INVALID_PARAMS", "Choose an observed menu option.");
        }
        const delta = Number(params.choice) - menu.selected;
        const keys = (delta < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(delta)) + "\r";
        if (!this.options.terminals.inputChecked(id, keys)) throw new ControlError("SESSION_EXITED", "The terminal no longer accepts input.");
        return { sessionId: id, choice: params.choice, delivery: "written-to-pty" };
      }
      if (request.method === "interrupt") {
        if (!owned.turn || !["queued", "working"].includes(owned.turn.state)) throw new ControlError("NO_ACTIVE_TURN", "No controller-submitted turn is active.");
        const previousInterrupt = owned.turn.interruptRequested;
        owned.turn.interruptRequested = true;
        if (!this.options.terminals.inputChecked(id, "\x03")) {
          owned.turn.interruptRequested = previousInterrupt;
          throw new ControlError("SESSION_EXITED", "The terminal no longer accepts input.");
        }
        return { sessionId: id, turnId: owned.turn.id, interruptRequested: true, stopped: false };
      }
      const text = string(params.text, MAX_TEXT, "text").replace(/\r\n/g, "\n");
      if (!this.options.lifecycleEnabled()) throw new ControlError("LIFECYCLE_DISABLED", "Agent lifecycle hooks are disabled.");
      if (/^[\s]*\//.test(text) || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) throw new ControlError("INVALID_PARAMS", "send accepts task text, not slash commands or terminal control sequences.");
      if (owned.turn && ["queued", "working"].includes(owned.turn.state)) throw new ControlError("BUSY", "The previous submitted turn has not finished.");
      // Only Codex's composer is recognised; for other providers the lifecycle
      // status is the sole readiness gate and the screen the only evidence.
      if (!["idle", "unavailable"].includes(fresh.status)) throw new ControlError("NOT_READY", "The session is not idle; inspect screen and wait for the current activity to finish.");
      if (capabilities.menus && !codexComposerReady(screen)) throw new ControlError("NOT_READY", "Codex is not at an empty task composer; inspect screen and resolve startup or approvals without changing its sandbox.");
      const previousTurn = owned.turn;
      owned.turn = { id: request.id, state: "queued", sawWorking: false, nativeTurnId: null, interruptRequested: false, result: null };
      if (!this.options.terminals.inputChecked(id, `\x1b[200~${text}\x1b[201~\r`)) {
        owned.turn = previousTurn;
        throw new ControlError("SESSION_EXITED", "The terminal no longer accepts input.");
      }
      return { sessionId: id, turnId: request.id, resultRevisionBefore: owned.resultRevision, delivery: "written-to-pty" };
    } finally { this.busy.delete(id); }
  }

  /** `create` on an orchestrator's own connection: a subagent of that orchestrator, under every delegation rule. */
  private async createSubagent(owner: string, parentSessionId: string, params: Record<string, unknown>): Promise<unknown> {
    fields(params, ["provider", "cwd", "title", "profile", "model", "effort", "executionTargetId"]);
    if (params.executionTargetId !== undefined && (typeof params.executionTargetId !== "string"
      || !/^[a-zA-Z0-9_-]{1,80}$/u.test(params.executionTargetId))) {
      throw new ControlError("INVALID_PARAMS", "Invalid executionTargetId; choose an id from execution-targets.");
    }
    if (!isControlProvider(params.provider)) throw new ControlError("INVALID_PARAMS", `Unknown agent provider. Run the providers command to see which agents CanvasTTY can launch; provider must be one of: ${CONTROL_PROVIDERS.join(", ")}.`);
    if (params.profile === "yolo") throw new ControlError("REFUSED", "YOLO (bypass) is never given to a subagent. Omit --profile to get this session's profile, or pass auto, normal, acceptEdits or plan.");
    if (!this.options.spawnSubagent) throw new ControlError("NOT_SUPPORTED", "This CanvasTTY cannot create subagents through the control endpoint; use the canvastty_agents spawn_agent tool.");
    if (!this.options.lifecycleEnabled()) throw new ControlError("LIFECYCLE_DISABLED", "Enable agent lifecycle hooks before creating controlled sessions.");
    // Subagents still starting hold their slot: concurrent creates cannot all pass this check and launch.
    if (this.sessions.size + this.startingSubagents >= MAX_SESSIONS) throw new ControlError("LIMIT_REACHED", "At most 32 controlled sessions are available per app instance.");
    const provider = params.provider;
    const cwd = string(params.cwd, 4096, "cwd");
    const title = params.title === undefined ? undefined : string(params.title, 80, "title");
    const problem = (params.model !== undefined ? launchModelProblem(provider, params.model) : null)
      ?? (params.effort !== undefined ? launchEffortProblem(provider, params.effort) : null);
    if (problem) throw new ControlError("INVALID_PARAMS", `${problem} Run the providers command for what ${provider} takes.`);
    let session: SessionMetadata;
    this.startingSubagents += 1;
    try {
      session = await this.options.spawnSubagent({ parentSessionId, provider, cwd,
        ...(params.executionTargetId !== undefined ? { executionTargetId: params.executionTargetId as string } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(params.profile !== undefined ? { profile: params.profile } : {}),
        ...(params.model !== undefined ? { model: params.model as string } : {}),
        ...(params.effort !== undefined ? { effort: params.effort as ReasoningEffort } : {}) });
    } catch (error) {
      throw new ControlError("REFUSED", error instanceof Error ? error.message : "The subagent was not created.");
    } finally {
      this.startingSubagents -= 1;
    }
    if (this.closed) throw new ControlError("CLOSED", "Agent control is shutting down.");
    const capabilities = controlCapabilities(provider);
    try {
      const terminal = new (xterm().Terminal)({ ...this.options.terminals.geometry(session.id), scrollback: 200, allowProposedApi: true });
      const snapshot = this.options.terminals.readBuffer(session.id);
      this.sessions.set(session.id, { owner, startedAt: session.startedAt, terminal,
        ready: new Promise<void>((resolve) => terminal.write(snapshot.buffer, resolve)),
        outputOffset: snapshot.outputOffset, resultRevision: 0, turn: null, completedTurn: null });
    } catch (error) {
      this.options.terminals.dispose?.(session.id);
      throw error;
    }
    return { session: this.redactMetadata(session), capabilities };
  }

  private redact(text: string): string {
    return this.options.terminals.redactSecrets?.(text) ?? text;
  }

  /** Failure details quote the child's last output: masked like the screen. */
  private redactMetadata<T extends { failureDetails?: string | null }>(metadata: T): T {
    return metadata.failureDetails ? { ...metadata, failureDetails: this.redact(metadata.failureDetails) } : metadata;
  }

  private redactTurn(turn: Turn): Turn {
    return turn.result ? { ...turn, result: { ...turn.result, text: this.redact(turn.result.text) } } : turn;
  }

  private async performSkinOperation(method: "skin-list" | "skin-install" | "skin-select", params: Record<string, unknown>): Promise<unknown> {
    const packs = this.options.pixelSkinPacks;
    const settings = this.options.settings;
    if (!packs || !settings) throw new ControlError("NOT_SUPPORTED", "Pixel theme control is unavailable.");
    if (method === "skin-list") {
      fields(params, []);
      const current = settings.get();
      return { builtIn: BUILT_IN_PIXEL_SKINS,
        installed: packs.list(), activeId: current.terminalBorderSkin, detail: current.terminalSkinDetail };
    }
    if (method === "skin-install") {
      fields(params, ["archivePath", "name", "activate", "detail", "apertures"]);
      const archivePath = string(params.archivePath, 4096, "archivePath");
      if (!isAbsolute(archivePath)) throw new ControlError("INVALID_PARAMS", "archivePath must be absolute.");
      const stat = await lstat(archivePath).catch(() => { throw new ControlError("INVALID_PARAMS", "Theme ZIP does not exist."); });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PIXEL_SKIN_ARCHIVE_BYTES) {
        throw new ControlError("INVALID_PARAMS", "Theme ZIP must be a regular file smaller than 150 MB.");
      }
      if (params.activate !== undefined && typeof params.activate !== "boolean") throw new ControlError("INVALID_PARAMS", "activate must be boolean.");
      const detail = this.skinDetail(params.detail);
      if (params.detail !== undefined && !params.activate) throw new ControlError("INVALID_PARAMS", "detail requires activate: true.");
      const name = params.name === undefined ? basename(archivePath).replace(/\.zip$/i, "") : string(params.name, 64, "name");
      let pack;
      try { pack = await packs.installZip(await readFile(archivePath), name,
        params.apertures as PixelSkinApertures | undefined); }
      catch (error) { throw new ControlError("INVALID_PACK", error instanceof Error ? error.message : "Invalid theme ZIP."); }
      if (params.activate) {
        const updated = await settings.update({ terminalBorderSkin: pack.id, ...(detail ? { terminalSkinDetail: detail } : {}) });
        this.options.onSettingsChanged?.(updated);
      }
      return { pack, active: Boolean(params.activate) };
    }
    fields(params, ["skinId", "detail"]);
    const skinId = string(params.skinId, 128, "skinId");
    if (!BUILT_IN_PIXEL_SKINS.includes(skinId)
      && !packs.list().some((pack) => pack.id === skinId)) {
      throw new ControlError("INVALID_PARAMS", "Unknown pixel theme ID.");
    }
    const detail = this.skinDetail(params.detail);
    const updated = await settings.update({ terminalBorderSkin: skinId as AppSettings["terminalBorderSkin"],
      ...(detail ? { terminalSkinDetail: detail } : {}) });
    this.options.onSettingsChanged?.(updated);
    return { activeId: updated.terminalBorderSkin, detail: updated.terminalSkinDetail };
  }

  private skinDetail(value: unknown): "minimal" | "detailed" | undefined {
    if (value === undefined) return undefined;
    if (value !== "minimal" && value !== "detailed") throw new ControlError("INVALID_PARAMS", "detail must be minimal or detailed.");
    return value;
  }
}

export function codexComposerReady(screen: string): boolean {
  if (/Do you trust the contents|Press enter to confirm|Update Model Permissions|model:\s+loading|MCP startup/i.test(screen)) return false;
  return screen.split("\n").some((line) => /^\s*›\s*(?:Ask Codex to do anything)?\s*$/.test(line));
}

function codexChoices(screen: string): { revision: string; selected: number; options: Array<{ number: number; label: string }> } | null {
  const matches = screen.split("\n").map((line) => line.match(/^\s*(›\s*)?(\d+)\.\s+(.+)$/)).filter((m) => m !== null);
  if (matches.length < 2 || matches.length > 12 || matches.filter((m) => m[1]).length !== 1) return null;
  if (matches.some((m, i) => Number(m[2]) !== i + 1)) return null;
  return { revision: hash(screen), selected: Number(matches.find((m) => m[1])![2]),
    options: matches.map((m) => ({ number: Number(m[2]), label: m[3] })) };
}

/**
 * The visible rows, masked with the scrollback above them: a secret the top edge cuts (its head scrolled away) is
 * masked whole before the rows are selected. Masking can join wrapped rows, so the last `rows` lines are taken after.
 */
function viewport(terminal: import("@xterm/headless").Terminal, redact: (text: string) => string): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.baseY + terminal.rows; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  return redact(lines.join("\n")).split("\n").slice(-terminal.rows).join("\n").trim().slice(-24_000);
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function string(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new ControlError("INVALID_PARAMS", `Invalid ${name}.`);
  return value;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ControlError("INVALID_PARAMS", "Unknown operation parameter.");
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
