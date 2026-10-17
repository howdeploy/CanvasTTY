import type {
  CreateSessionRequest,
  LaunchProfileId,
  PluginPermission,
  ProviderId,
  SessionEvent,
  SessionMetadata,
  SessionRemovedEvent,
  SessionRole,
  SessionSnapshot,
  SessionStatus,
  TerminalBufferSnapshot,
  TerminalDataEvent
} from "../../shared/contracts.ts";
import { IPC } from "../../shared/contracts.ts";
import { codexPromptInput } from "./codexInput.ts";
import type { PersistedEnvironmentRef } from "./TerminalSessionStore.ts";

/** A card as plugin services see it (EP-4): metadata and where it runs, never screen text. */
export interface PluginSessionSummary {
  id: string;
  provider: ProviderId;
  role: SessionRole;
  parentSessionId?: string;
  title: string;
  status: SessionStatus;
  exitCode: number | null;
  /** The folder the person chose. */
  cwd: string;
  /** The folder the card actually runs in (an environment such as a worktree may move it). */
  workingDirectory: string;
  startedAt: number;
  /** The plugin environment it runs in, with that plugin's saved ref. */
  environment?: { pluginId: string; kind: string; label: string; ref: unknown };
}

export type PluginSessionEventType = "created" | "restored" | "status" | "exited" | "closed";

/** The notification a subscribed service gets (`canvastty.sessions.event`). */
export interface PluginSessionEvent {
  type: PluginSessionEventType;
  session: PluginSessionSummary;
  /** This plugin created the card (it may send to it and stop it). */
  owned: boolean;
  /** Only with `sessions:read-screen`, on status and exit: the redacted end of the card's output. */
  screen?: string;
}

interface TerminalPort {
  create(request: CreateSessionRequest, control?: { origin?: "plugin"; ownerPluginId?: string }): SessionSnapshot;
  listMetadata(): SessionMetadata[];
  pluginContext(id: string): {
    metadata: SessionMetadata;
    workingDirectory: string;
    environment: PersistedEnvironmentRef | null;
    restored: boolean;
    owner: string | null;
  } | null;
  setPluginOwner(id: string, pluginId: string): void;
  readBuffer(id: string): TerminalBufferSnapshot;
  deliverInput(id: string, text: string, waitMs?: number, signal?: AbortSignal, waitForCodexComposer?: boolean): Promise<{ delivered: boolean }>;
  dispose(id: string, options?: { keepEnvironmentData?: boolean }): void;
  redactSecrets(text: string): string;
  redactSecretsTail(text: string, maxChars: number): string;
}

export interface PluginSessionsDependencies {
  terminals: TerminalPort;
  /** Sends a notification to a running service; false when it is not running. */
  notify(pluginId: string, serviceId: string, method: "canvastty.sessions.event", params: PluginSessionEvent): boolean;
}

interface Subscriber {
  pluginId: string;
  serviceId: string;
  ownedOnly: boolean;
  screen: boolean;
}

const MAX_OWNED_PER_PLUGIN = 16;
const MAX_SEND_CHARS = 16_000;
const MAX_SCREEN_CHARS = 4_000;
const PROFILES = new Set<LaunchProfileId>(["normal", "yolo", "auto", "acceptEdits", "plan"]);

/**
 * Session events and plugin-owned session control (EP-4). A service subscribes to card events (metadata only;
 * the redacted end of the output only with `sessions:read-screen`). It can start cards through the normal launch
 * pipeline (launch options and environments included), and send text to and stop only the cards it started:
 * the same ownership rule as the agent-control gateway. Ownership lives on the card's saved record, so a restored
 * card stays under the plugin that started it.
 */
export class PluginSessions {
  private readonly deps: PluginSessionsDependencies;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly known = new Map<string, { status: SessionStatus; exited: boolean; summary: PluginSessionSummary; owner: string | null }>();

  constructor(deps: PluginSessionsDependencies) {
    this.deps = deps;
  }

  /** The host method a service calls (`sessions.*`); `permissions` are its plugin's active manifest permissions. */
  handle(pluginId: string, serviceId: string, method: string, params: unknown, permissions: readonly PluginPermission[]): unknown {
    const values = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const need = (permission: PluginPermission): void => {
      if (!permissions.includes(permission)) throw new Error(`Plugin does not have the ${permission} permission.`);
    };
    switch (method) {
      case "sessions.subscribe":
        need("sessions:events");
        this.subscribers.set(`${pluginId}:${serviceId}`, {
          pluginId, serviceId, ownedOnly: values.ownedOnly === true, screen: permissions.includes("sessions:read-screen")
        });
        return { sessions: this.summaries(pluginId, values.ownedOnly === true) };
      case "sessions.unsubscribe":
        this.subscribers.delete(`${pluginId}:${serviceId}`);
        return null;
      case "sessions.list":
        need("sessions:events");
        return { sessions: this.summaries(pluginId, values.ownedOnly === true) };
      case "sessions.create":
        need("sessions:launch");
        return this.create(pluginId, values);
      case "sessions.send":
        need("sessions:control");
        return this.send(pluginId, values);
      case "sessions.stop":
        need("sessions:control");
        return this.stop(pluginId, values);
      default:
        return undefined;
    }
  }

  /** A stopped service subscribes again when it starts. */
  serviceStopped(pluginId: string, serviceId: string): void {
    this.subscribers.delete(`${pluginId}:${serviceId}`);
  }

  /** The EP-4 summary of one card, or null when it does not exist. */
  summary(sessionId: string): PluginSessionSummary | null {
    const context = this.deps.terminals.pluginContext(sessionId);
    if (!context) return null;
    const { metadata, workingDirectory, environment } = context;
    return {
      id: metadata.id,
      provider: metadata.provider,
      role: metadata.role,
      ...(metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
      title: metadata.title,
      status: metadata.status,
      exitCode: metadata.exitCode,
      cwd: metadata.cwd,
      workingDirectory,
      startedAt: metadata.startedAt,
      ...(environment ? {
        environment: { pluginId: environment.pluginId, kind: environment.kind, label: environment.label, ref: environment.ref }
      } : {})
    };
  }

  /** Fed every terminal manager event, like the other in-process observers. */
  observe(channel: string, payload: SessionEvent | SessionRemovedEvent | TerminalDataEvent): void {
    if (channel === IPC.terminalRemoved && "id" in payload && !("data" in payload)) {
      const last = this.known.get(payload.id);
      this.known.delete(payload.id);
      if (last) this.dispatch("closed", last.summary, last.owner);
      return;
    }
    if (channel !== IPC.terminalSession || !("session" in payload)) return;
    const metadata = payload.session;
    const summary = this.summary(metadata.id);
    if (!summary) return;
    const previous = this.known.get(metadata.id);
    const exited = metadata.exitCode !== null;
    const context = this.deps.terminals.pluginContext(metadata.id);
    this.known.set(metadata.id, { status: metadata.status, exited, summary, owner: context?.owner ?? null });
    let type: PluginSessionEventType | null = null;
    if (!previous) type = context?.restored ? "restored" : "created";
    else if (exited && !previous.exited) type = "exited";
    else if (metadata.status !== previous.status) type = "status";
    if (type) this.dispatch(type, summary);
  }

  private dispatch(type: PluginSessionEventType, summary: PluginSessionSummary, closedOwner?: string | null): void {
    if (this.subscribers.size === 0) return;
    // After the current call returns: a card a plugin just created is owned by then.
    queueMicrotask(() => {
      const owner = closedOwner !== undefined ? closedOwner : this.owner(summary.id);
      let screen: string | undefined;
      for (const subscriber of this.subscribers.values()) {
        const owned = owner === subscriber.pluginId;
        if (subscriber.ownedOnly && !owned) continue;
        const event: PluginSessionEvent = { type, session: summary, owned };
        if (subscriber.screen && (type === "status" || type === "exited")) {
          screen ??= this.screen(summary.id);
          if (screen) event.screen = screen;
        }
        if (!this.deps.notify(subscriber.pluginId, subscriber.serviceId, "canvastty.sessions.event", event)) {
          this.subscribers.delete(`${subscriber.pluginId}:${subscriber.serviceId}`);
        }
      }
    });
  }

  private screen(sessionId: string): string {
    try {
      const { buffer } = this.deps.terminals.readBuffer(sessionId);
      // Masked before the cut (over a window wider than any match), so a secret the cut splits leaves no readable tail.
      return this.deps.terminals.redactSecretsTail(plainText(buffer), MAX_SCREEN_CHARS);
    } catch {
      return "";
    }
  }

  private summaries(pluginId: string, ownedOnly: boolean): Array<PluginSessionSummary & { owned: boolean }> {
    return this.deps.terminals.listMetadata()
      .map((metadata) => ({ summary: this.summary(metadata.id), owned: this.owner(metadata.id) === pluginId }))
      .filter((entry): entry is { summary: PluginSessionSummary; owned: boolean } => Boolean(entry.summary) && (!ownedOnly || entry.owned))
      .map(({ summary, owned }) => ({ ...summary, owned }));
  }

  private create(pluginId: string, values: Record<string, unknown>): { sessionId: string } {
    const owned = this.deps.terminals.listMetadata().filter((metadata) => this.owner(metadata.id) === pluginId).length;
    if (owned >= MAX_OWNED_PER_PLUGIN) throw new Error(`A plugin can run at most ${MAX_OWNED_PER_PLUGIN} cards of its own.`);
    if (typeof values.provider !== "string" || typeof values.cwd !== "string") throw new Error("provider and cwd are required.");
    const profile = values.profile === undefined ? "normal" : values.profile;
    if (!PROFILES.has(profile as LaunchProfileId)) throw new Error("profile must be auto, normal, acceptEdits, plan or yolo.");
    if (values.title !== undefined && (typeof values.title !== "string" || values.title.length > 80)) {
      throw new Error("title must be text of at most 80 characters.");
    }
    const cascade = 40 * (owned + 1);
    const created = this.deps.terminals.create({
      provider: values.provider as ProviderId,
      cwd: values.cwd,
      profile: profile as LaunchProfileId,
      position: { x: 80 + cascade, y: 80 + cascade },
      role: "agent",
      ...(typeof values.title === "string" ? { title: values.title } : {}),
      // The same launch pipeline as the launcher: options and environments are validated there.
      ...(values.launchOptions !== undefined ? { launchOptions: values.launchOptions as CreateSessionRequest["launchOptions"] } : {}),
      ...(values.environment !== undefined ? { environment: values.environment as CreateSessionRequest["environment"] } : {})
    }, { origin: "plugin", ownerPluginId: pluginId });
    this.deps.terminals.setPluginOwner(created.id, pluginId);
    const known = this.known.get(created.id);
    if (known) known.owner = pluginId;
    return { sessionId: created.id };
  }

  /** `sent` is true once the text reached the card's agent (after a launch its plugins prepared has started). */
  private send(pluginId: string, values: Record<string, unknown>): Promise<{ sessionId: string; sent: boolean }> {
    const sessionId = this.requireOwned(pluginId, values.sessionId);
    if (typeof values.text !== "string" || values.text.length === 0 || values.text.length > MAX_SEND_CHARS) {
      throw new Error(`text must be 1 to ${MAX_SEND_CHARS} characters.`);
    }
    const submit = values.submit === undefined ? true : values.submit === true;
    const codex = this.deps.terminals.pluginContext(sessionId)?.metadata.provider === "codex";
    const data = codex ? codexPromptInput(values.text, submit) : submit ? `${values.text}\r` : values.text;
    return this.deps.terminals.deliverInput(sessionId, data, undefined, undefined, codex)
      .then((delivery) => ({ sessionId, sent: delivery.delivered }));
  }

  private stop(pluginId: string, values: Record<string, unknown>): { sessionId: string; stopped: true } {
    const sessionId = this.requireOwned(pluginId, values.sessionId);
    // Closes the card; environment data is kept, as when a person closes it and chooses Keep.
    this.deps.terminals.dispose(sessionId, { keepEnvironmentData: true });
    return { sessionId, stopped: true };
  }

  private owner(sessionId: string): string | null {
    return this.deps.terminals.pluginContext(sessionId)?.owner ?? null;
  }

  /** A foreign or unknown id gets the same answer, so a plugin cannot probe other cards. */
  private requireOwned(pluginId: string, sessionId: unknown): string {
    if (typeof sessionId !== "string" || this.owner(sessionId) !== pluginId) {
      throw new Error("No session this plugin started has that id.");
    }
    return sessionId;
  }
}

/** Terminal output without escape sequences and carriage-return overdraw, for plugins that read it. */
export function plainText(buffer: string): string {
  return buffer
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B[@-Z\\-_]/gu, "")
    .replace(/\r+\n/gu, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, "");
}
