import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type {
  CreateSessionRequest,
  Point,
  ProviderId,
  SessionBounds,
  SessionEvent,
  SessionMetadata,
  SessionRemovedEvent,
  SessionSnapshot,
  TerminalBufferSnapshot,
  TerminalDataEvent
} from "../../shared/contracts.ts";
import {
  INITIAL_TERMINAL_COLS,
  INITIAL_TERMINAL_ROWS,
  IPC
} from "../../shared/contracts.ts";
import type {
  AgentBrowserLaunchCoordinator,
  PreparedAgentBrowserPtyLaunch
} from "./agent-browser/AgentBrowserBridge.ts";
import { AGENT_BROWSER_ENV } from "./agent-browser/AgentBrowserBridge.ts";
import type {
  AgentRuntimeLaunchCoordinator,
  PreparedAgentRuntimePtyLaunch
} from "./agent-runtime/AgentRuntimeBridge.ts";
import { AGENT_RUNTIME_ENV } from "../../agent-runtime/runtime-protocol.mjs";
import { mergeOpenCodeLaunchEnvironment } from "./agent-runtime/ProviderRuntimeLaunch.ts";
import { tryPtyOperation } from "./ptySafety.ts";
import { terminalFailureDetails } from "./terminalFailureDetails.ts";
import { resolveTerminalLaunch } from "./terminalLaunch.ts";
import {
  persistedTerminalSession,
  type PersistedTerminalSession,
  type TerminalSessionStore
} from "./TerminalSessionStore.ts";
import type { ProviderCliRegistry, UnavailableProviderCli } from "./providerCliRegistry.ts";
import {
  createProviderLifecycleParser,
  initialSessionStatus,
  type ProviderLifecycleParser
} from "./providerLifecycle.ts";

const MAX_SCROLLBACK_CHARS = 240_000;
const OUTPUT_BATCH_MS = 16;
const DEFAULT_TERMINAL_SIZE = { width: 700, height: 430 };
const MIN_TERMINAL_SIZE = { width: 420, height: 260 };
const MAX_TERMINAL_SIZE = { width: 1_600, height: 1_100 };

interface ManagedSession {
  metadata: SessionMetadata;
  process: IPty | null;
  cols: number;
  rows: number;
  bufferChunks: string[];
  bufferStart: number;
  bufferLength: number;
  outputOffset: number;
  pendingOutput: string[];
  outputTimer: ReturnType<typeof setTimeout> | null;
  agentBrowser: PreparedAgentBrowserPtyLaunch | null;
  agentRuntime: PreparedAgentRuntimePtyLaunch | null;
  lifecycle: ProviderLifecycleParser | null;
  awaitingInitialResize: boolean;
  resumeOnLaunch: boolean;
}

export interface ProviderLifecycleSignal {
  kind: "lifecycle";
  state: "idle" | "working" | "needs_approval";
  requestId?: string;
}

type Emit = (
  channel: typeof IPC.terminalData | typeof IPC.terminalSession | typeof IPC.terminalRemoved,
  payload: TerminalDataEvent | SessionEvent | SessionRemovedEvent
) => void;

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly emit: Emit;
  private readonly providerClis: ProviderCliRegistry;
  private readonly agentBrowser?: AgentBrowserLaunchCoordinator;
  private readonly agentRuntime?: AgentRuntimeLaunchCoordinator;
  private readonly spawnPty: typeof pty.spawn;
  private lifecycleHooksEnabled: boolean;
  private sessionStore: TerminalSessionStore | null = null;
  private sessionPersistenceEnabled = false;
  private suppressPersistence = false;

  constructor(
    emit: Emit,
    providerClis: ProviderCliRegistry,
    agentBrowser?: AgentBrowserLaunchCoordinator,
    agentRuntime?: AgentRuntimeLaunchCoordinator,
    lifecycleHooksEnabled = true,
    spawnPty: typeof pty.spawn = pty.spawn
  ) {
    this.emit = emit;
    this.providerClis = providerClis;
    this.agentBrowser = agentBrowser;
    this.agentRuntime = agentRuntime;
    this.spawnPty = spawnPty;
    this.lifecycleHooksEnabled = lifecycleHooksEnabled;
  }

  configureSessionPersistence(store: TerminalSessionStore, enabled: boolean): void {
    this.sessionStore = store;
    this.sessionPersistenceEnabled = Boolean(enabled);
  }

  async restorePersistedSessions(): Promise<void> {
    const store = this.sessionStore;
    if (!store) return;
    const persisted = await store.load();
    if (!this.sessionPersistenceEnabled) {
      if (persisted.length > 0) await store.clear();
      return;
    }

    for (const descriptor of persisted) this.restorePersistedSession(descriptor);
    await this.persistSessions();
  }

  async setSessionPersistenceEnabled(enabled: boolean): Promise<void> {
    const next = Boolean(enabled);
    if (this.sessionPersistenceEnabled === next) return;
    this.sessionPersistenceEnabled = next;
    if (next) await this.persistSessions();
    else await this.sessionStore?.clear();
  }

  async shutdown(): Promise<void> {
    await this.persistSessions().catch((error) => {
      console.warn("CanvasTTY terminal window state could not be saved during shutdown.", error);
    });
    this.suppressPersistence = true;
    this.disposeAll();
    if (this.sessionStore) await this.sessionStore.flush().catch(() => undefined);
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((session) => snapshot(session));
  }

  readBuffer(id: string): TerminalBufferSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    return {
      buffer: session.bufferChunks.slice(session.bufferStart).join(""),
      outputOffset: session.outputOffset
    };
  }

  create(request: CreateSessionRequest): SessionSnapshot {
    assertCreateRequest(request);
    assertDirectory(request.cwd);

    const id = randomUUID();
    const metadata: SessionMetadata = {
      id,
      revision: 0,
      provider: request.provider,
      profile: request.profile,
      title: request.title?.trim() || defaultTitle(request.provider, request.cwd),
      titleCustomized: Boolean(request.title?.trim()),
      cwd: request.cwd,
      position: request.position,
      size: DEFAULT_TERMINAL_SIZE,
      status: initialSessionStatus(request.provider),
      startedAt: Date.now(),
      exitCode: null,
      failureDetails: null
    };
    const awaitMeasuredGrid = request.provider === "grok"
      && this.providerClis.get(request.provider).state === "available";
    const launched = awaitMeasuredGrid
      ? { process: null, agentBrowser: null, agentRuntime: null, failure: null }
      : this.spawnProcess(id, request.provider, request.profile, request.cwd);
    if (launched.failure) applyLaunchFailure(metadata, launched.failure);

    const session: ManagedSession = {
      metadata,
      process: launched.process,
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      bufferChunks: [],
      bufferStart: 0,
      bufferLength: 0,
      outputOffset: 0,
      pendingOutput: [],
      outputTimer: null,
      agentBrowser: launched.agentBrowser,
      agentRuntime: launched.agentRuntime,
      lifecycle: this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(request.provider, request.cwd)
        : null,
      awaitingInitialResize: awaitMeasuredGrid,
      resumeOnLaunch: false
    };
    this.sessions.set(id, session);
    if (launched.process) this.bindProcess(id, session, launched.process);
    const runtimeStatus = this.agentRuntime?.currentStatus(id);
    if (runtimeStatus) session.metadata.status = runtimeStatus;

    this.emitSession(metadata);
    this.schedulePersistence();
    return snapshot(session);
  }

  restart(id: string): SessionSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    if (session.metadata.exitCode === null) throw new Error("Terminal session is still running.");

    if (session.metadata.provider === "grok") {
      session.agentBrowser?.cleanup();
      session.agentRuntime?.cleanup();
      session.process = null;
      session.agentBrowser = null;
      session.agentRuntime = null;
      session.lifecycle = this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd)
        : null;
      session.awaitingInitialResize = true;
      session.resumeOnLaunch = false;
      session.metadata.startedAt = Date.now();
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      this.emitSession(session.metadata);
      return snapshot(session);
    }

    const launched = this.spawnProcess(
      id,
      session.metadata.provider,
      session.metadata.profile,
      session.metadata.cwd,
      session.cols,
      session.rows
    );
    session.process = launched.process;
    session.agentBrowser = launched.agentBrowser;
    session.agentRuntime = launched.agentRuntime;
    session.awaitingInitialResize = false;
    session.lifecycle = this.lifecycleHooksEnabled
      ? createProviderLifecycleParser(session.metadata.provider, session.metadata.cwd)
      : null;
    session.metadata.startedAt = Date.now();
    if (launched.failure) {
      applyLaunchFailure(session.metadata, launched.failure);
    } else {
      session.metadata.status = initialSessionStatus(session.metadata.provider);
      session.metadata.exitCode = null;
      session.metadata.failureDetails = null;
      if (launched.process) this.bindProcess(id, session, launched.process);
      const runtimeStatus = this.agentRuntime?.currentStatus(id);
      if (runtimeStatus) session.metadata.status = runtimeStatus;
    }
    this.emitSession(session.metadata);
    return snapshot(session);
  }

  input(id: string, data: string): void {
    if (typeof data !== "string" || data.length === 0) return;
    const session = this.sessions.get(id);
    if (!session || session.metadata.exitCode !== null || !session.process) return;
    const process = session.process;
    tryPtyOperation(() => process.write(data));
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const session = this.sessions.get(id);
    if (!session) return;
    const safeCols = Math.max(20, Math.min(400, Math.floor(cols)));
    const safeRows = Math.max(5, Math.min(200, Math.floor(rows)));
    session.cols = safeCols;
    session.rows = safeRows;
    if (session.awaitingInitialResize) {
      this.launchAwaitingSession(id, session);
      return;
    }
    if (session.metadata.exitCode !== null || !session.process) return;
    const process = session.process;
    tryPtyOperation(() => process.resize(safeCols, safeRows));
  }

  setBounds(id: string, bounds: SessionBounds): void {
    if (!isSessionBounds(bounds)) return;
    const session = this.sessions.get(id);
    if (!session) return;

    session.metadata.position = bounds.position;
    session.metadata.size = {
      width: clamp(bounds.size.width, MIN_TERMINAL_SIZE.width, MAX_TERMINAL_SIZE.width),
      height: clamp(bounds.size.height, MIN_TERMINAL_SIZE.height, MAX_TERMINAL_SIZE.height)
    };
    this.emitSession(session.metadata);
    this.schedulePersistence();
  }

  rename(id: string, title: string): SessionMetadata {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal session does not exist.");
    if (typeof title !== "string") throw new Error("Window title is invalid.");

    const nextTitle = title.trim();
    if (nextTitle.length === 0) throw new Error("Window title cannot be empty.");
    session.metadata.title = nextTitle.slice(0, 80);
    session.metadata.titleCustomized = true;
    this.emitSession(session.metadata);
    this.schedulePersistence();
    return structuredClone(session.metadata);
  }

  applyProviderSignal(id: string, signal: ProviderLifecycleSignal): void {
    const session = this.sessions.get(id);
    if (!this.lifecycleHooksEnabled || !session || session.metadata.status === "done" || session.metadata.status === "failed") return;

    const nextStatus = signal.state;
    if (session.metadata.status === nextStatus) return;
    session.metadata.status = nextStatus;
    this.emitSession(session.metadata);
  }

  setLifecycleHooksEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.lifecycleHooksEnabled === next) return;
    this.lifecycleHooksEnabled = next;
    if (next) return;
    for (const session of this.sessions.values()) {
      session.lifecycle = null;
      if (
        session.metadata.provider === "terminal"
        || session.metadata.status === "done"
        || session.metadata.status === "failed"
        || session.metadata.status === "unavailable"
      ) continue;
      session.metadata.status = "unavailable";
      this.emitSession(session.metadata);
    }
  }

  dispose(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    this.flushOutput(id, session);
    this.sessions.delete(id);
    session.agentBrowser?.cleanup();
    session.agentRuntime?.cleanup();
    if (session.process) {
      try {
        session.process.kill();
      } catch (error) {
        console.warn(`PTY ${id} could not be killed cleanly.`, error);
      }
    }
    this.emit(IPC.terminalRemoved, { id });
    this.schedulePersistence();
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.dispose(id);
    }
  }

  private restorePersistedSession(descriptor: PersistedTerminalSession): void {
    if (this.sessions.has(descriptor.id)) return;
    const metadata: SessionMetadata = {
      id: descriptor.id,
      revision: 0,
      provider: descriptor.provider,
      profile: descriptor.profile,
      title: descriptor.title,
      titleCustomized: descriptor.titleCustomized,
      cwd: descriptor.cwd,
      position: descriptor.position,
      size: descriptor.size,
      status: initialSessionStatus(descriptor.provider),
      startedAt: Date.now(),
      exitCode: null,
      failureDetails: null
    };

    let process: IPty | null = null;
    let agentBrowser: PreparedAgentBrowserPtyLaunch | null = null;
    let agentRuntime: PreparedAgentRuntimePtyLaunch | null = null;
    let directoryReady = true;
    try {
      assertDirectory(descriptor.cwd);
    } catch (error) {
      directoryReady = false;
      metadata.status = "failed";
      metadata.exitCode = 1;
      metadata.failureDetails = error instanceof Error ? error.message : String(error);
    }
    const awaitMeasuredGrid = directoryReady
      && descriptor.provider === "grok"
      && this.providerClis.get(descriptor.provider).state === "available";

    if (directoryReady && !awaitMeasuredGrid) {
      try {
        const launched = this.spawnProcess(
          descriptor.id,
          descriptor.provider,
          descriptor.profile,
          descriptor.cwd,
          INITIAL_TERMINAL_COLS,
          INITIAL_TERMINAL_ROWS,
          descriptor.provider !== "terminal"
        );
        process = launched.process;
        agentBrowser = launched.agentBrowser;
        agentRuntime = launched.agentRuntime;
        if (launched.failure) applyLaunchFailure(metadata, launched.failure);
      } catch (error) {
        metadata.status = "failed";
        metadata.exitCode = 1;
        metadata.failureDetails = error instanceof Error ? error.message : String(error);
      }
    }

    const session: ManagedSession = {
      metadata,
      process,
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      bufferChunks: [],
      bufferStart: 0,
      bufferLength: 0,
      outputOffset: 0,
      pendingOutput: [],
      outputTimer: null,
      agentBrowser,
      agentRuntime,
      lifecycle: this.lifecycleHooksEnabled
        ? createProviderLifecycleParser(descriptor.provider, descriptor.cwd)
        : null,
      awaitingInitialResize: awaitMeasuredGrid,
      resumeOnLaunch: awaitMeasuredGrid && descriptor.provider !== "terminal"
    };
    this.sessions.set(descriptor.id, session);
    if (process) this.bindProcess(descriptor.id, session, process);
    const runtimeStatus = this.agentRuntime?.currentStatus(descriptor.id);
    if (runtimeStatus) session.metadata.status = runtimeStatus;
    this.emitSession(metadata);
  }

  private persistSessions(): Promise<void> {
    if (!this.sessionPersistenceEnabled || this.suppressPersistence || !this.sessionStore) {
      return Promise.resolve();
    }
    return this.sessionStore.replace(
      [...this.sessions.values()].map((session) => persistedTerminalSession(session.metadata))
    );
  }

  private schedulePersistence(): void {
    void this.persistSessions().catch((error) => {
      console.warn("CanvasTTY terminal window state could not be saved.", error);
    });
  }

  private emitSession(metadata: SessionMetadata): void {
    metadata.revision += 1;
    this.emit(IPC.terminalSession, { session: structuredClone(metadata) });
  }

  private launchAwaitingSession(id: string, session: ManagedSession): void {
    if (!session.awaitingInitialResize) return;
    session.awaitingInitialResize = false;
    const resumePrevious = session.resumeOnLaunch;
    session.resumeOnLaunch = false;
    try {
      const launched = this.spawnProcess(
        id,
        session.metadata.provider,
        session.metadata.profile,
        session.metadata.cwd,
        session.cols,
        session.rows,
        resumePrevious
      );
      session.process = launched.process;
      session.agentBrowser = launched.agentBrowser;
      session.agentRuntime = launched.agentRuntime;
      if (launched.failure) {
        applyLaunchFailure(session.metadata, launched.failure);
      } else {
        session.metadata.status = initialSessionStatus(session.metadata.provider);
        session.metadata.exitCode = null;
        session.metadata.failureDetails = null;
        if (launched.process) this.bindProcess(id, session, launched.process);
        const runtimeStatus = this.agentRuntime?.currentStatus(id);
        if (runtimeStatus) session.metadata.status = runtimeStatus;
      }
    } catch (error) {
      session.process = null;
      session.agentBrowser = null;
      session.agentRuntime = null;
      session.metadata.status = "failed";
      session.metadata.exitCode = 1;
      session.metadata.failureDetails = error instanceof Error ? error.message : String(error);
    }
    this.emitSession(session.metadata);
  }

  private spawnProcess(
    id: string,
    provider: ProviderId,
    profile: CreateSessionRequest["profile"],
    cwd: string,
    cols = INITIAL_TERMINAL_COLS,
    rows = INITIAL_TERMINAL_ROWS,
    resumePrevious = false
  ): {
    process: IPty | null;
    agentBrowser: PreparedAgentBrowserPtyLaunch | null;
    agentRuntime: PreparedAgentRuntimePtyLaunch | null;
    failure: UnavailableProviderCli | null;
  } {
    const providerCli = provider === "terminal" ? undefined : this.providerClis.get(provider);
    if (providerCli?.state === "unavailable") {
      return { process: null, agentBrowser: null, agentRuntime: null, failure: providerCli };
    }
    const agentRuntime = provider === "terminal"
      ? null
      : this.agentRuntime?.prepareLaunch({ terminalSessionId: id, provider, cwd }) ?? null;
    let agentBrowser: PreparedAgentBrowserPtyLaunch | null = null;
    try {
      agentBrowser = provider === "terminal" || provider === "grok"
        ? null
        : this.agentBrowser?.prepareLaunch({ terminalSessionId: id, provider, cwd }) ?? null;
      const baseEnvironment = terminalEnvironment();
      const browserEnvironment = agentBrowser?.environment ?? {};
      const runtimeEnvironment = agentRuntime?.environment ?? {};
      const providerEnvironment = provider === "opencode"
        ? mergeOpenCodeLaunchEnvironment(browserEnvironment, runtimeEnvironment)
        : { ...browserEnvironment, ...runtimeEnvironment };
      const providerArgs = [...(agentRuntime?.args ?? []), ...(agentBrowser?.args ?? [])];
      const launch = resolveTerminalLaunch(provider, profile, providerArgs, {
        environment: { ...baseEnvironment, ...providerEnvironment },
        ...(providerCli ? { providerCli } : {}),
        resumePrevious
      });
      return {
        process: this.spawnPty(launch.command, launch.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: { ...baseEnvironment, ...providerEnvironment, ...launch.environment }
        }),
        agentBrowser,
        agentRuntime,
        failure: null
      };
    } catch (error) {
      agentBrowser?.cleanup();
      agentRuntime?.cleanup();
      throw error;
    }
  }

  private bindProcess(id: string, session: ManagedSession, process: IPty): void {
    process.onData((data) => {
      const current = this.sessions.get(id);
      if (!current || current !== session || current.process !== process) return;

      const lifecycleState = current.lifecycle?.push(data);
      if (lifecycleState) this.applyProviderSignal(id, { kind: "lifecycle", state: lifecycleState });
      appendScrollback(current, data);
      this.queueOutput(id, current, data);
    });

    process.onExit(({ exitCode }) => {
      const current = this.sessions.get(id);
      if (!current || current !== session || current.process !== process) return;

      this.flushOutput(id, current);
      current.metadata.exitCode = exitCode;
      current.metadata.status = exitCode === 0 ? "done" : "failed";
      current.metadata.failureDetails = exitCode === 0
        ? null
        : terminalFailureDetails(current.bufferChunks.slice(current.bufferStart).join(""));
      current.agentBrowser?.cleanup();
      current.agentBrowser = null;
      current.agentRuntime?.cleanup();
      current.agentRuntime = null;
      this.emitSession(current.metadata);
    });
  }

  private queueOutput(id: string, session: ManagedSession, data: string): void {
    session.pendingOutput.push(data);
    if (session.outputTimer !== null) return;
    // Keep a TUI's clear-and-redraw sequence in one renderer update whenever possible.
    session.outputTimer = setTimeout(() => this.flushOutput(id, session), OUTPUT_BATCH_MS);
  }

  private flushOutput(id: string, session: ManagedSession): void {
    if (session.outputTimer !== null) {
      clearTimeout(session.outputTimer);
      session.outputTimer = null;
    }
    if (session.pendingOutput.length === 0) return;

    const data = session.pendingOutput.join("");
    session.pendingOutput.length = 0;
    this.emit(IPC.terminalData, { id, data, outputOffset: session.outputOffset });
  }
}

function applyLaunchFailure(metadata: SessionMetadata, failure: UnavailableProviderCli): void {
  metadata.status = "failed";
  metadata.exitCode = 127;
  metadata.failureDetails = failure.diagnostic;
}

export function terminalEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const reserved = new Set<string>([
    ...Object.values(AGENT_BROWSER_ENV),
    ...Object.values(AGENT_RUNTIME_ENV)
  ]);
  const environment = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string"
      && !reserved.has(entry[0])
      && !entry[0].startsWith("CANVASTTY_PLUGIN_HOOK_")
      && entry[0] !== "CANVASTTY_LIFECYCLE_HOOKS_ENABLED"
      && entry[0] !== "ELECTRON_RUN_AS_NODE"
    ))
  );
  return { ...environment, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

function defaultTitle(provider: ProviderId, cwd: string): string {
  const project = basename(cwd) || cwd;
  if (provider === "terminal") return `Terminal · ${project}`;
  if (provider === "opencode") return `${project} · OpenCode`;
  if (provider === "hermes") return `${project} · Hermes`;
  if (provider === "qwen") return `${project} · Qwen Code`;
  if (provider === "grok") return `${project} · Grok Build`;
  return `${project} · ${provider[0].toUpperCase()}${provider.slice(1)}`;
}

function assertDirectory(cwd: string): void {
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new Error(`Project folder does not exist: ${cwd}`);
  }
}

function assertCreateRequest(request: CreateSessionRequest): void {
  const providers = new Set<ProviderId>(["terminal", "codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok"]);
  if (!request || !providers.has(request.provider)) throw new Error("Unknown terminal provider.");
  if (request.profile !== "normal" && request.profile !== "yolo") throw new Error("Unknown launch profile.");
  if (typeof request.cwd !== "string" || request.cwd.length === 0) throw new Error("Project folder is required.");
  if (!isPoint(request.position)) throw new Error("Session position is invalid.");
}

function isPoint(value: unknown): value is Point {
  return Boolean(
    value
    && typeof value === "object"
    && "x" in value
    && "y" in value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
  );
}

function isSessionBounds(value: unknown): value is SessionBounds {
  if (!value || typeof value !== "object" || !("position" in value) || !("size" in value)) return false;
  const size = value.size;
  return isPoint(value.position)
    && Boolean(
      size
      && typeof size === "object"
      && "width" in size
      && "height" in size
      && Number.isFinite(size.width)
      && Number.isFinite(size.height)
    );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snapshot(session: ManagedSession): SessionSnapshot {
  return {
    ...structuredClone(session.metadata),
    buffer: session.bufferChunks.slice(session.bufferStart).join("")
  };
}

function appendScrollback(session: ManagedSession, data: string): void {
  session.outputOffset += data.length;
  session.bufferChunks.push(data);
  session.bufferLength += data.length;

  while (session.bufferLength > MAX_SCROLLBACK_CHARS) {
    const first = session.bufferChunks[session.bufferStart];
    if (first === undefined) {
      session.bufferChunks.length = 0;
      session.bufferStart = 0;
      session.bufferLength = 0;
      return;
    }
    const overflow = session.bufferLength - MAX_SCROLLBACK_CHARS;
    if (first.length <= overflow) {
      session.bufferStart += 1;
      session.bufferLength -= first.length;
      continue;
    }
    session.bufferChunks[session.bufferStart] = first.slice(overflow);
    session.bufferLength -= overflow;
  }

  if (session.bufferStart > 256 && session.bufferStart * 2 >= session.bufferChunks.length) {
    session.bufferChunks = session.bufferChunks.slice(session.bufferStart);
    session.bufferStart = 0;
  }
}
