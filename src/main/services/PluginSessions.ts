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
import { createHmac, randomBytes } from "node:crypto";
import { ASSISTANT_PLUGIN_ID, ASSISTANT_SERVICE_ID, isInstalledAssistant, type PluginInstallRecord } from "./AssistantLoopSignal.ts";
import { IPC } from "../../shared/contracts.ts";
import type { PersistedEnvironmentRef } from "./TerminalSessionStore.ts";
import { ACCOUNTS_PLUGIN_ID } from "./accountHomeIsolation.ts";

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
  create(request: CreateSessionRequest, control?: { origin?: "plugin"; ownerPluginId?: string; continueTaskFrom?:string; reuseTaskEnvironmentFrom?:string }): SessionSnapshot;
  listMetadata(): SessionMetadata[];
  pluginContext(id: string): {
    metadata: SessionMetadata;
    workingDirectory: string;
    environment: PersistedEnvironmentRef | null;
    restored: boolean;
    owner: string | null;
  } | null;
  setPluginOwner(id: string, pluginId: string): void;
  inheritTaskScope?(sourceId:string,replacementId:string):void;
  completeTaskContinuation?(sourceId:string,replacementId:string):void;
  readBuffer(id: string): TerminalBufferSnapshot;
  deliverInput(id: string, text: string): Promise<{ delivered: boolean }>;
  dispose(id: string, options?: { keepEnvironmentData?: boolean }): void;
  redactSecrets(text: string): string;
  redactSecretsTail(text: string, maxChars: number): string;
}

export interface PluginSessionsDependencies {
  terminals: TerminalPort;
  experimentalEnabled?: () => boolean;
  handoffTaskOwner?(sourceId:string,replacementId:string):Promise<void | (() => Promise<void>)>;
  /** Live host install provenance; absent or untrusted records never receive activity. */
  installRecord?(pluginId:string):PluginInstallRecord|null;
  /** Sends a notification to a running service; false when it is not running. */
  notify(pluginId: string, serviceId: string, method: "canvastty.sessions.event" | "canvastty.activity", params: PluginSessionEvent | PluginActivity): boolean;
}
export interface PluginActivity {
  type: string; sessionId: string; at: number; turnId?: string; turnEpoch?: number; evidenceId?: string; toolName?: string; normalizedAction?: string;
  normalizedActionHash?: string; errorHash?: string; outputHash?: string; changedPathHashes?: string[];
  resultClass?: string; provider?: string; accountId?: string; resetAt?: number;
  task?: string; parentSessionId?: string; status?: "failed"|"accepted"|"rejected"|"rework";
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
const MAX_LOOP_EVIDENCE = 512;
const LOOP_EVIDENCE_TTL_MS = 60_000;
const PROFILES = new Set<LaunchProfileId>(["normal", "yolo", "auto", "acceptEdits", "plan"]);

interface LoopEvidence { sessionId: string; turnEpoch: number; issuedAt: number }

function boundedPluginText(value: string, limit: number): string {
  const text = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/u.test(text) ? text.slice(0, -1) : text;
}

function validTurnId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 160
    && /^[A-Za-z0-9._:-]+$/u.test(value) ? value : undefined;
}

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
  private readonly handoffConsents = new Map<string, number>();
  private readonly known = new Map<string, { status: SessionStatus; exited: boolean; summary: PluginSessionSummary; owner: string | null }>();
  private readonly fingerprintKey = randomBytes(32);
  private readonly loopEvidence = new Map<string, LoopEvidence>();

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
      case "sessions.handoff":
        need("sessions:launch");
        return this.handoff(pluginId, values);
      default:
        return undefined;
    }
  }

  /** A stopped service subscribes again when it starts. */
  serviceStopped(pluginId: string, serviceId: string): void {
    this.subscribers.delete(`${pluginId}:${serviceId}`);
  }
  /** Only a click on the host-owned Handoff card action authorizes replacing another plugin's agent. */
  async withCardConsent<T>(pluginId: string, actionId: string, sessionId: string, action: () => Promise<T>): Promise<T> {
    if (pluginId !== ACCOUNTS_PLUGIN_ID || actionId !== "handoff") return action();
    this.requireExperimental();
    const key=`${pluginId}:${sessionId}`;
    if (this.handoffConsents.has(key)) throw new Error("A handoff is already pending.");
    this.handoffConsents.set(key,Date.now()+15_000);
    try { return await action(); } finally { this.handoffConsents.delete(key); }
  }
  private requireExperimental(): void {
    if (this.deps.experimentalEnabled?.() !== true) throw new Error("Experimental account handoff is disabled; not verified live.");
  }
  private async handoff(pluginId: string, values: Record<string,unknown>): Promise<PluginSessionSummary | null> {
    this.requireExperimental();
    if (pluginId !== ACCOUNTS_PLUGIN_ID) throw new Error("Only the trusted Accounts plugin can request handoff.");
    if (typeof values.sessionId !== "string") throw new Error("Handoff session id is required.");
    const key=`${pluginId}:${values.sessionId}`, expiry=this.handoffConsents.get(key);
    if (!expiry || expiry < Date.now()) throw new Error("Handoff requires the person's Handoff card action.");
    this.handoffConsents.delete(key);
    const source=this.deps.terminals.pluginContext(values.sessionId);
    if (!source || source.metadata.provider === "terminal") throw new Error("Source agent is unavailable.");
    if (source.environment && source.environment.kind !== "worktree") throw new Error("Handoff is available for local agents and worktrees only.");
    if (typeof values.summary !== "string" || Buffer.byteLength(values.summary) > 8192) throw new Error("Handoff summary must be at most 8 KiB.");
    const metadata=source.metadata;
    const created=this.deps.terminals.create({provider:(values.provider ?? metadata.provider) as ProviderId,
      cwd:source.workingDirectory, profile:metadata.profile, position:{x:metadata.position.x+40,y:metadata.position.y+40},
      title:`${metadata.title} · handoff`,role:metadata.role,
      ...(metadata.parentSessionId ? {parentSessionId:metadata.parentSessionId} : {}),
      ...(values.model !== undefined ? {model:values.model as string} : metadata.model ? {model:metadata.model} : {}),
      ...(values.effort !== undefined ? {effort:values.effort as CreateSessionRequest["effort"]} : metadata.effort ? {effort:metadata.effort} : {}),
      ...(values.launchOptions ? {launchOptions:values.launchOptions as CreateSessionRequest["launchOptions"]} : {})},
      {origin:"plugin",ownerPluginId:pluginId,continueTaskFrom:metadata.id,...(source.environment ? {reuseTaskEnvironmentFrom:metadata.id} : {})});
    let rollback: void | (() => Promise<void>) = undefined;
    try {
      this.deps.terminals.inheritTaskScope?.(metadata.id,created.id);
      const delivered=await this.deps.terminals.deliverInput(created.id,`${this.deps.terminals.redactSecrets(values.summary)}\r`);
      this.requireExperimental();
      if (!delivered.delivered) throw new Error("Replacement did not accept the handoff; the original agent is still running.");
      rollback = await this.deps.handoffTaskOwner?.(metadata.id,created.id);
      this.requireExperimental();
      this.deps.terminals.completeTaskContinuation?.(metadata.id,created.id);
      this.deps.terminals.dispose(metadata.id,{keepEnvironmentData:true});
      return this.summary(created.id);
    } catch (error) {
      if (rollback) {
        try { await rollback(); }
        catch (rollbackError) {
          // Keep an available replacement: it may still own tasks whose compensation could not be persisted.
          throw new AggregateError([error, rollbackError], `Handoff failed and task ownership could not be restored. Replacement ${created.id} was retained if still available; inspect the task board before retrying.`);
        }
      }
      this.deps.terminals.dispose(created.id,{keepEnvironmentData:true}); throw error;
    }
  }
  activity(event: PluginActivity): void {
    const quotaEvent = event.type === "limit.exhausted" || event.type === "route.outcome";
    if (quotaEvent && this.deps.experimentalEnabled?.() !== true) return;
    let assistantTrusted = false, accountsTrusted = false;
    try { assistantTrusted = isInstalledAssistant(this.deps.installRecord?.(ASSISTANT_PLUGIN_ID) ?? null); } catch { /* fail closed */ }
    if (quotaEvent) {
      try {
        const record = this.deps.installRecord?.(ACCOUNTS_PLUGIN_ID);
        accountsTrusted = Boolean(record?.enabled && record.nativeCodeTrusted
          && record.sourceUrl.toLowerCase() === "https://github.com/biackfiame/canvastty-plugin-accounts.git");
      } catch { /* fail closed independently of the Assistant installation */ }
    }
    if (!assistantTrusted && !accountsTrusted) return;
    let safeEvent = event.type === "tool-outcome" ? this.safeToolOutcome(event)
      : event.type === "activity" || event.type === "pretool" ? this.safePretool(event) : event;
    if (!safeEvent) return;
    const context=this.deps.terminals.pluginContext(safeEvent.sessionId);
    if (!context) return;
    if ((safeEvent.type === "activity" || safeEvent.type === "tool-outcome")
      && Number.isSafeInteger(safeEvent.turnEpoch) && safeEvent.turnEpoch! > 0
      && context.metadata.exitCode === null && context.metadata.status !== "done" && context.metadata.status !== "failed") {
      const evidenceId = this.issueLoopEvidence(safeEvent.sessionId, safeEvent.turnEpoch!);
      safeEvent = { ...safeEvent, evidenceId };
    }
    for (const subscriber of this.subscribers.values()) {
      const assistant = assistantTrusted && subscriber.pluginId === ASSISTANT_PLUGIN_ID && subscriber.serviceId === ASSISTANT_SERVICE_ID;
      const accounts = quotaEvent && accountsTrusted && subscriber.pluginId === ACCOUNTS_PLUGIN_ID && subscriber.serviceId === "accounts";
      if (!assistant && !accounts) continue;
      if (subscriber.ownedOnly && context.owner !== subscriber.pluginId) continue;
      const payload: PluginActivity = accounts ? {
        type: safeEvent.type, sessionId: safeEvent.sessionId, at: safeEvent.at,
        ...(safeEvent.provider !== undefined ? { provider: safeEvent.provider } : {}),
        ...(safeEvent.accountId !== undefined ? { accountId: safeEvent.accountId } : {}),
        ...(safeEvent.resetAt !== undefined ? { resetAt: safeEvent.resetAt } : {}),
        ...(safeEvent.task !== undefined ? { task: safeEvent.task } : {}),
        ...(safeEvent.parentSessionId !== undefined ? { parentSessionId: safeEvent.parentSessionId } : {}),
        ...(safeEvent.status !== undefined ? { status: safeEvent.status } : {})
      } : safeEvent;
      this.deps.notify(subscriber.pluginId,subscriber.serviceId,"canvastty.activity",payload);
    }
  }

  /** Consume host evidence once, and only for the same still-live card and currently open turn. */
  consumeLoopEvidence(sessionId: string, evidenceId: string, currentTurnEpoch: number | null): boolean {
    const evidence = this.loopEvidence.get(evidenceId);
    if (!evidence) return false;
    this.loopEvidence.delete(evidenceId);
    const age = Date.now() - evidence.issuedAt;
    if (evidence.sessionId !== sessionId || evidence.turnEpoch !== currentTurnEpoch
      || !Number.isFinite(age) || age < 0 || age > LOOP_EVIDENCE_TTL_MS) return false;
    const context = this.deps.terminals.pluginContext(sessionId);
    return Boolean(context && context.metadata.exitCode === null
      && context.metadata.status !== "done" && context.metadata.status !== "failed");
  }

  private issueLoopEvidence(sessionId: string, turnEpoch: number): string {
    const now = Date.now();
    while (this.loopEvidence.size >= MAX_LOOP_EVIDENCE) this.loopEvidence.delete(this.loopEvidence.keys().next().value!);
    const evidenceId = randomBytes(18).toString("base64url");
    this.loopEvidence.set(evidenceId, { sessionId, turnEpoch, issuedAt: now });
    return evidenceId;
  }

  /** Equality survives inside one host session, while plugins cannot test guessed commands against plain SHA. */
  private fingerprint(sessionId:string,domain:string,hash:string):string {
    return createHmac("sha256",this.fingerprintKey).update(JSON.stringify(["activity-v1",sessionId,domain,hash])).digest("hex");
  }

  private safeToolOutcome(event: PluginActivity): PluginActivity | null {
    if (!Number.isFinite(event.at) || typeof event.sessionId !== "string" || !event.sessionId
      || !["success", "error", "denied", "unknown"].includes(event.resultClass ?? "")) return null;
    const changedPathHashes = Array.isArray(event.changedPathHashes)
      ? [...new Set(event.changedPathHashes.filter((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)))].slice(0, 16)
      : [];
    const redactedName = typeof event.toolName === "string"
      ? this.deps.terminals.redactSecrets(event.toolName.replace(/[\u0000-\u001f\u007f]/gu, ""))
      : "unknown";
    const safeName = boundedPluginText(redactedName, 80);
    const actionHash = typeof event.normalizedActionHash === "string" && /^[a-f0-9]{64}$/u.test(event.normalizedActionHash)
      ? event.normalizedActionHash : undefined;
    const errorHash = event.resultClass === "error" && typeof event.errorHash === "string" && /^[a-f0-9]{64}$/u.test(event.errorHash)
      ? event.errorHash : undefined;
    const outputHash = event.resultClass !== "error" && typeof event.outputHash === "string" && /^[a-f0-9]{64}$/u.test(event.outputHash)
      ? event.outputHash : undefined;
    const turnId = validTurnId(event.turnId);
    return {
      type: "tool-outcome",
      sessionId: event.sessionId,
      at: event.at,
      ...(turnId ? { turnId } : {}),
      ...(Number.isSafeInteger(event.turnEpoch) && (event.turnEpoch as number) > 0 ? { turnEpoch: event.turnEpoch as number } : {}),
      toolName: safeName || "unknown",
      resultClass: event.resultClass,
      ...(actionHash ? { normalizedActionHash: this.fingerprint(event.sessionId,"action",actionHash) } : {}),
      ...(errorHash ? { errorHash:this.fingerprint(event.sessionId,"error",errorHash) } : {}),
      ...(outputHash ? { outputHash:this.fingerprint(event.sessionId,"output",outputHash) } : {}),
      changedPathHashes:changedPathHashes.map(hash=>this.fingerprint(event.sessionId,"path",hash))
    };
  }

  /** Pre-tool summaries carry only hashes and bounded labels; tool input never reaches plugins. */
  private safePretool(event: PluginActivity): PluginActivity | null {
    if (!Number.isFinite(event.at) || typeof event.sessionId !== "string" || !event.sessionId) return null;
    const action = typeof event.normalizedAction === "string" ? event.normalizedAction : event.normalizedActionHash;
    if (typeof action !== "string" || !/^[a-f0-9]{64}$/u.test(action)) return null;
    const redactedName = typeof event.toolName === "string"
      ? this.deps.terminals.redactSecrets(event.toolName.replace(/[\u0000-\u001f\u007f]/gu, ""))
      : "unknown";
    const safeName = boundedPluginText(redactedName, 80);
    const resultClass = ["deny", "ask", "allow"].includes(event.resultClass ?? "") ? event.resultClass : undefined;
    const turnId = validTurnId(event.turnId);
    return {
      type: "activity",
      sessionId: event.sessionId,
      at: event.at,
      toolName: safeName || "unknown",
      normalizedAction: this.fingerprint(event.sessionId,"action",action),
      ...(typeof event.normalizedActionHash==="string" && /^[a-f0-9]{64}$/u.test(event.normalizedActionHash)
        ? {normalizedActionHash:this.fingerprint(event.sessionId,"action",event.normalizedActionHash)} : {}),
      ...(Number.isSafeInteger(event.turnEpoch) && (event.turnEpoch as number) > 0 ? { turnEpoch: event.turnEpoch as number } : {}),
      ...(resultClass ? { resultClass } : {}),
      ...(turnId ? { turnId } : {})
    };
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
      for (const [evidenceId, evidence] of this.loopEvidence) if (evidence.sessionId === payload.id) this.loopEvidence.delete(evidenceId);
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
    return this.deps.terminals.deliverInput(sessionId, submit ? `${values.text}\r` : values.text)
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
