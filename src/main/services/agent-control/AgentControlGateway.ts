import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import xterm from "@xterm/headless";
import type { CreateSessionRequest, SessionMetadata, SessionSnapshot, TerminalBufferSnapshot } from "../../../shared/contracts.ts";
import { IPC } from "../../../shared/contracts.ts";
import type { RuntimeLifecycleSignal } from "../agent-runtime/RuntimeGateway.ts";
import { WindowsPipeHostTransport, type AgentGatewaySocket } from "../agent-browser/WindowsPipeHostTransport.ts";
import { controlCapabilities, isControlProvider } from "./controlCapabilities.ts";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RECEIPTS = 4096;
const MAX_SESSIONS = 32;
const MAX_TEXT = 16_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SECRET = /^[a-f0-9]{64}$/;

interface TerminalPort {
  create(request: CreateSessionRequest, options?: { captureResult?: boolean }): SessionSnapshot;
  listMetadata(): SessionMetadata[];
  readBuffer(id: string): TerminalBufferSnapshot;
  inputChecked(id: string, text: string): boolean;
  geometry(id: string): { cols: number; rows: number };
}

interface ControlRequest {
  v: 1;
  id: string;
  instanceId: string;
  token: string;
  controller: string;
  method: "create" | "list" | "status" | "screen" | "send" | "result" | "interrupt" | "choose" | "dismiss";
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
  lifecycleEnabled(): boolean;
  platform?: NodeJS.Platform;
  windowsHostPath?: string;
  windowsPipeHostFactory?: (options: { hostPath: string; platform: NodeJS.Platform; parentPid: number }) => WindowsPipeHostTransport;
}

export class ControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Explicitly enabled, current-user-only control of sessions created by one controller. */
export class AgentControlGateway {
  private readonly options: AgentControlGatewayOptions;
  private readonly token = randomBytes(32).toString("hex");
  private readonly instanceId = randomBytes(16).toString("hex");
  private readonly sessions = new Map<string, OwnedSession>();
  private readonly sockets = new Set<AgentGatewaySocket>();
  private readonly receipts = new Map<string, { digest: string; result: Promise<unknown> }>();
  private readonly busy = new Set<string>();
  private server: Server | null = null;
  private windows: WindowsPipeHostTransport | null = null;
  private closed = false;

  constructor(options: AgentControlGatewayOptions) { this.options = options; }

  async start(): Promise<string> {
    if (this.server || this.windows || this.closed) throw new Error("Agent control is already started or closed.");
    const platform = this.options.platform ?? process.platform;
    let endpoint: string;
    if (platform === "win32") {
      if (!this.options.windowsHostPath) throw new Error("Agent control requires the current-user Windows pipe host.");
      this.windows = (this.options.windowsPipeHostFactory ?? ((options) => new WindowsPipeHostTransport(options)))({
        hostPath: this.options.windowsHostPath, platform, parentPid: process.pid
      });
      endpoint = await this.windows.start((socket) => this.accept(socket));
    } else {
      const directory = await mkdtemp(join(tmpdir(), "ctty-control-"));
      await chmod(directory, 0o700);
      endpoint = join(directory, "c.sock");
      if (Buffer.byteLength(endpoint) > 100) throw new Error("Agent control socket path is too long.");
      this.server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(endpoint, () => { this.server!.off("error", reject); resolve(); });
      });
      await chmod(endpoint, 0o600);
    }
    const directory = join(this.options.userDataPath, "agent-control");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const tokenFile = join(directory, `token-${this.instanceId}`);
    await writeFile(tokenFile, this.token, { flag: "wx", mode: 0o600 });
    const connection = join(directory, "connection.json");
    await writeFile(connection, JSON.stringify({ v: 1, service: "canvastty-agent-control", instanceId: this.instanceId,
      endpoint, tokenFile, pid: process.pid }, null, 2) + "\n", { mode: 0o600 });
    await chmod(connection, 0o600);
    return connection;
  }

  observe(channel: string, payload: unknown): void {
    if (channel === IPC.terminalRemoved) {
      const id = (payload as { id: string }).id;
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
    for (const socket of this.sockets) socket.destroy();
    for (const owned of this.sessions.values()) { await owned.ready; owned.terminal.dispose(); }
    this.sessions.clear();
    if (this.windows) await this.windows.close();
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    // Retain inert discovery/diagnostic records; a new app instance gets a new token and instanceId.
  }

  private accept(socket: AgentGatewaySocket): void {
    if (this.closed || this.sockets.size >= 32) { socket.destroy(); return; }
    this.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let handled = false;
    const timer = setTimeout(() => socket.destroy(), 10_000);
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
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      handled = true;
      let request: ControlRequest;
      try { request = this.parse(JSON.parse(buffer.subarray(0, newline).toString("utf8"))); }
      catch { reply({ v: 1, ok: false, error: { code: "INVALID_REQUEST", message: "Invalid or unauthenticated control request." } }); return; }
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
      || !["create", "list", "status", "screen", "send", "result", "interrupt", "choose", "dismiss"].includes(String(value.method))
      || !record(value.params)) throw new Error("Invalid envelope");
    if (!timingSafeEqual(Buffer.from(value.token), Buffer.from(this.token))) throw new Error("Invalid credential");
    return value as unknown as ControlRequest;
  }

  private async dispatch(request: ControlRequest): Promise<unknown> {
    const owner = hash(request.controller);
    const mutating = ["create", "send", "interrupt", "choose", "dismiss"].includes(request.method);
    if (!mutating) return this.perform(owner, request);
    const key = `${owner}:${request.id}`;
    const digest = hash(JSON.stringify([request.method, Object.entries(request.params).sort(([a], [b]) => a.localeCompare(b))]));
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new ControlError("REQUEST_CONFLICT", "Request ID was already used for different input.");
      return previous.result;
    }
    if (this.receipts.size >= MAX_RECEIPTS) throw new ControlError("LIMIT_REACHED", "Control request capacity reached; existing receipts remain available.");
    const result = this.perform(owner, request);
    this.receipts.set(key, { digest, result });
    return result;
  }

  private async perform(owner: string, request: ControlRequest): Promise<unknown> {
    if (this.closed) throw new ControlError("CLOSED", "Agent control is shutting down.");
    const params = request.params;
    if (request.method === "create") {
      fields(params, ["provider", "cwd", "title", "profile"]);
      if (!isControlProvider(params.provider) || !["normal", "yolo"].includes(String(params.profile))) throw new ControlError("INVALID_PARAMS", "Specify an agent provider (codex, claude, qwen, kimi, opencode, hermes, grok, omp, pi) and an explicit normal or yolo launch profile.");
      const provider = params.provider;
      const capabilities = controlCapabilities(provider);
      const requestedCwd = string(params.cwd, 4096, "cwd");
      if (!isAbsolute(requestedCwd)) throw new ControlError("INVALID_PARAMS", "cwd must be absolute.");
      const cwd = await realpath(requestedCwd).catch(() => { throw new ControlError("INVALID_PARAMS", "Project directory does not exist."); });
      if (this.closed) throw new ControlError("CLOSED", "Agent control is shutting down.");
      const title = params.title === undefined ? undefined : string(params.title, 80, "title");
      if (!this.options.lifecycleEnabled()) throw new ControlError("LIFECYCLE_DISABLED", "Enable agent lifecycle hooks before creating controlled sessions.");
      if (this.sessions.size >= MAX_SESSIONS) throw new ControlError("LIMIT_REACHED", "At most 32 controlled sessions are available per app instance.");
      // Result capture is a Codex-only hook; the manager refuses it for anyone else.
      const session = this.options.terminals.create({ provider, profile: params.profile as "normal" | "yolo", cwd, title,
        position: { x: 1600, y: this.options.terminals.listMetadata().length * 470 } }, { captureResult: capabilities.result });
      const terminal = new xterm.Terminal({ ...this.options.terminals.geometry(session.id), scrollback: 200, allowProposedApi: true });
      const snapshot = this.options.terminals.readBuffer(session.id);
      const owned: OwnedSession = { owner, startedAt: session.startedAt, terminal,
        ready: new Promise<void>((resolve) => terminal.write(snapshot.buffer, resolve)),
        outputOffset: snapshot.outputOffset, resultRevision: 0, turn: null, completedTurn: null };
      this.sessions.set(session.id, owned);
      const { buffer: _buffer, ...metadata } = session;
      return { session: metadata, capabilities };
    }
    if (request.method === "list") {
      fields(params, []);
      return { sessions: this.options.terminals.listMetadata().filter((s) => {
        const owned = this.sessions.get(s.id); return owned?.owner === owner && owned.startedAt === s.startedAt;
      }).map((s) => ({ ...s, capabilities: controlCapabilities(s.provider) })) };
    }
    fields(params, request.method === "send" ? ["sessionId", "text"] : request.method === "result" ? ["sessionId", "after"]
      : request.method === "choose" ? ["sessionId", "choice", "revision"]
        : request.method === "dismiss" ? ["sessionId", "revision"] : ["sessionId"]);
    const id = string(params.sessionId, 128, "sessionId");
    const owned = this.sessions.get(id);
    const metadata = this.options.terminals.listMetadata().find((s) => s.id === id);
    if (!owned || owned.owner !== owner || !metadata) throw new ControlError("SESSION_NOT_FOUND", "No owned session has that ID.");
    if (metadata.startedAt !== owned.startedAt) throw new ControlError("STALE_SESSION", "Session restarted; its old control grant is no longer valid.");
    if (request.method === "status") return { session: metadata, resultRevision: owned.resultRevision,
      turn: owned.turn ? { id: owned.turn.id, state: owned.turn.state } : null };
    if (request.method === "result") {
      const after = params.after === undefined ? 0 : params.after;
      if (!Number.isSafeInteger(after) || Number(after) < 0) throw new ControlError("INVALID_PARAMS", "after must be a non-negative result revision.");
      const fresh = owned.resultRevision > Number(after);
      return { session: metadata, resultRevision: owned.resultRevision, fresh,
        turn: fresh ? owned.completedTurn : null };
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
    const screen = viewport(owned.terminal);
    if (request.method === "screen") return { sessionId: id, text: screen, revision: hash(screen), outputOffset: owned.outputOffset,
      interaction: capabilities.menus ? codexChoices(screen) : null };
    if ((request.method === "choose" || request.method === "dismiss") && !capabilities.menus) {
      throw new ControlError("NOT_SUPPORTED", `Menus are parsed for Codex only; resolve ${fresh.provider} prompts from the desktop and treat screen as the only evidence.`);
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
}

export function codexComposerReady(screen: string): boolean {
  if (/Do you trust the contents|Press enter to confirm|Update Model Permissions|model:\s+loading|MCP startup/i.test(screen)) return false;
  return screen.split("\n").some((line) => /^\s*›\s*(?:Ask Codex to do anything)?\s*$/.test(line));
}

export function codexChoices(screen: string): { revision: string; selected: number; options: Array<{ number: number; label: string }> } | null {
  const matches = screen.split("\n").map((line) => line.match(/^\s*(›\s*)?(\d+)\.\s+(.+)$/)).filter((m) => m !== null);
  if (matches.length < 2 || matches.length > 12 || matches.filter((m) => m[1]).length !== 1) return null;
  if (matches.some((m, i) => Number(m[2]) !== i + 1)) return null;
  return { revision: hash(screen), selected: Number(matches.find((m) => m[1])![2]),
    options: matches.map((m) => ({ number: Number(m[2]), label: m[3] })) };
}

function viewport(terminal: import("@xterm/headless").Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = buffer.baseY; row < buffer.baseY + terminal.rows; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  return lines.join("\n").trim().slice(-24_000);
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
