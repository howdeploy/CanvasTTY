import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rename, stat, rm } from "node:fs/promises";
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { isPathInside } from "../../../agent-runtime/path-inside.mjs";
import { hostname } from "node:os";
import type { TerminalManager } from "../TerminalManager.ts";
import type { AttentionEvent, NotificationChannel } from "../../../shared/backlog.ts";
import type { LimitsSnapshot, ProviderId, SessionMetadata } from "../../../shared/contracts.ts";
import { CANVAS_LAUNCHER_ITEMS } from "../../../shared/providerCatalog.ts";
import {
  CompanionError,
  normalizeSessionTitle,
  type CompanionGrant,
  type CompanionRequest,
} from "../../../shared/companion.ts";
import type {
  EvenG2Config,
  EvenG2State,
  EvenG2Command,
  EvenG2Telemetry,
  EvenG2Address,
} from "../../../shared/evenG2.ts";
import type { AgentCliAvailability } from "../../../shared/contracts.ts";
import { SessionAccess } from "./SessionAccess.ts";
import { RequestLedger } from "./RequestLedger.ts";
import { CompanionSessions } from "./CompanionSessions.ts";
import { HumanQuestionError, type HumanQuestionService } from "../HumanQuestionService.ts";
import { TerminalPresentation } from "./TerminalPresentation.ts";
import { SpeechRecognizer } from "./SpeechRecognizer.ts";
import { lanAddresses, httpsOrigin, addressOrigin } from "./LanNetwork.ts";
import { LocalLink } from "./LocalLink.ts";
import {
  sealLocal,
  LOCAL_LINK_LIMIT,
  localOrigin,
  type LocalPacket,
  type LocalRequest,
} from "../../../shared/localLink.ts";
import { LocalPairing } from "./LocalPairing.ts";
import { LocalDiscovery } from "./LocalDiscovery.ts";
import { SpeechSetup } from "./SpeechSetup.ts";

type Terminals = Pick<
  TerminalManager,
  | "listMetadata"
  | "geometry"
  | "readBuffer"
  | "create"
  | "dispose"
  | "rename"
  | "inputChecked"
  | "redactSecrets"
>;
type SpeechPort = Pick<
  SpeechRecognizer,
  | "configure"
  | "inspect"
  | "available"
  | "model"
  | "cancel"
  | "cancelAll"
  | "run"
>;
type StoredPeer = {
  id: string;
  name: string;
  tokenHash: string;
  transportVersion: 2;
  /** Desktop-selected device capability, independent of network transport. */
  clientType: "phone" | "even-g2";
  /** Legacy summaryOnly records need a host to resolve their original device role. */
  needsReclassification?: boolean;
  grant: CompanionGrant;
};
const MODEL =
  "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf";
const defaultConfig = (): EvenG2Config => ({
  enabled: false,
  workspace: "",
  interfaceName: "",
  publicOrigin: "",
  sessionIds: [],
  allowInput: true,
  allowCreate: true,
  allowClose: false,
  allowBrowser: true,
  speechExecutable:
    process.platform === "darwin" &&
    existsSync("/Applications/Handy.app/Contents/MacOS/handy")
      ? "/Applications/Handy.app/Contents/MacOS/handy"
      : "",
  speechModel: MODEL,
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const safeSession = (s: ReturnType<Terminals["listMetadata"]>[number]) => ({
  id: s.id,
  title: s.title,
  status: s.status,
  provider: s.provider,
});
const MOBILE_ACTIONS: Record<string, true> = {
  "sessions.list": true, "sessions.overview": true, "session.read": true,
  "session.output": true, "session.interrupt": true,
  "session.close": true, "session.rename": true,
  "session.reply": true,
};
const TAILSCALE_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/;
const isUsbOrigin = (origin: string, port: number): boolean =>
  port > 0 && origin === `http://127.0.0.1:${port}`;


export class EvenG2Controller {
  private config = defaultConfig();
  private readonly file: string;
  private readonly terminals: Terminals;
  private readonly webRoot: string;
  private readonly discover: () => EvenG2Address[];
  private addresses: EvenG2Address[] = [];
  private boundAddress = "";
  private closing = false;
  private readonly speech: SpeechPort;
  private readonly localLink: LocalLink;
  private readonly localName: string;
  private readonly discovery: Pick<LocalDiscovery, "host" | "start" | "stop"> | null;
  /** When a Bonjour name that could not be published is tried again (every name taken: ~40 s of dns-sd each time). */
  private discoveryRetryAt = 0;
  /** A revoke is in memory but not yet on disk: saved again until it is. */
  private unsaved = false;
  private diagnosticsTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly defaultWorkspace: string;
  private readonly speechSetup: SpeechSetup | null;
  private readonly mobileRoot: string | null;
  private readonly mobileForwardSecret = randomBytes(32);
  private extraServers = new Map<string, Server>();
  private readonly access = new SessionAccess();
  private readonly ledger = new RequestLedger();
  readonly presentation: TerminalPresentation;
  private readonly actions: CompanionSessions;
  private peers: StoredPeer[] = [];
  private seen = new Map<
    string,
    { lastSeen: number; telemetry: EvenG2Telemetry | null }
  >();
  private pairing: {
    code: string;
    expiresAt: number;
    attempts: number;
    target: "phone" | "even-g2";
    local: LocalPairing;
    pending: StoredPeer | null;
  } | null = null;
  private server: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private port: number;
  private error = "";
  private saveQueue = Promise.resolve();
  private commandBusy = false;
  private pairingDiagnostics: string[] = [];
  private diagnosticsWrite = Promise.resolve();
  private limits: () => Promise<LimitsSnapshot>;
  private readonly loopWarningActive:(id:string)=>boolean;
  private readonly notifications:(channel:NotificationChannel,id:string)=>AttentionEvent[];

  private readonly experimentalEnabled: () => boolean;

  constructor(options: {
    experimentalEnabled?: () => boolean;
    loopWarningActive?: (sessionId:string)=>boolean;
    notifications?: (channel:NotificationChannel,sessionId:string)=>AttentionEvent[];
    userDataPath: string;
    terminals: Terminals;
    webRoot: string;
    speechWorker: string;
    speech?: SpeechPort;
    limits: () => Promise<LimitsSnapshot>;
    mobileRoot?: string;
    providerAvailability?: () => AgentCliAvailability;
    openBrowser: () => Promise<{ title: string; url: string }>;
    humanQuestions?: Pick<HumanQuestionService, "pending" | "reply">;
    port?: number;
    addresses?: () => EvenG2Address[];
    defaultWorkspace?: string;
    bundledSpeech?: string;
    localHostname?: string;
    /** true: publish through macOS Bonjour; an object replaces LocalDiscovery (tests). */
    localDiscovery?: boolean | Pick<LocalDiscovery, "host" | "start" | "stop">;
  }) {
    this.experimentalEnabled = () => options.experimentalEnabled?.() === true;
    this.file = join(options.userDataPath, "even-g2.json");
    this.localLink = new LocalLink(options.userDataPath);
    this.discovery = typeof options.localDiscovery === "object" ? options.localDiscovery
      : options.localDiscovery ? new LocalDiscovery() : null;
    this.localName =
      options.localHostname || hostname().split(".")[0] + ".local";
    this.defaultWorkspace =
      options.defaultWorkspace || join(options.userDataPath, "projects");
    this.speechSetup = options.bundledSpeech
      ? new SpeechSetup({
          userDataPath: options.userDataPath,
          binary: options.bundledSpeech,
        })
      : null;
    this.terminals = options.terminals;
    this.notifications=options.notifications ?? (()=>[]);
    this.loopWarningActive=options.loopWarningActive ?? (()=>false);
    this.mobileRoot = options.mobileRoot ?? null;
    this.webRoot = options.webRoot;
    this.port = options.port ?? 3481;
    this.discover = options.addresses ?? lanAddresses;
    this.speech = options.speech ?? new SpeechRecognizer(options.speechWorker);
    this.limits = options.limits;
    this.presentation = new TerminalPresentation(this.terminals);
    this.actions = new CompanionSessions(
      {
        list: () => this.terminals.listMetadata().map(row => ({...safeSession(row),title:this.terminals.redactSecrets(row.title)})),
        overview: () => this.terminals.listMetadata().map((s) => ({
          ...safeSession(s), title:this.terminals.redactSecrets(s.title),attention:this.notifications("phone",s.id).slice(-3).map(({id,kind,at})=>({id,kind,at})), startedAt: s.startedAt, exitCode: s.exitCode, revision: s.revision,
        })),
        output: (id) => ({
          ...this.terminals.readBuffer(id),
          ...this.terminals.geometry(id),
        }),
        providers: () => ({
          ...Object.fromEntries(CANVAS_LAUNCHER_ITEMS.map((provider) => [provider, false])),
          ...options.providerAvailability?.(),
          terminal: true,
        }) as Record<ProviderId, boolean>,
        read: (id) => this.presentation.read(id),
        summary: (id) => {
          const sessions=this.terminals.listMetadata(), row=sessions.find(row => row.id === id);
          if (!row) throw new CompanionError("unavailable");
          const children=sessions.filter(child => child.parentSessionId === id);
          const notices=options.notifications?.("phone",id) ?? [];
          const body=[this.terminals.redactSecrets(row.title),`Status: ${row.status}`,
            ...(children.length ? [`Subagents: ${children.filter(child=>child.status === "working").length} working, ${children.filter(child=>child.status === "done" || child.turnCompleted).length} finished, ${children.filter(child=>child.status === "failed").length} failed`] : []),
            ...(row.status === "needs_approval" ? ["The agent needs attention. Review any provider prompt on the desktop."] : []),
            ...notices.slice(-3).map(event=>`Attention: ${event.kind}`)].join("\n");
          return {body,revision:`${row.id}:${row.revision}:${notices.at(-1)?.id ?? ""}`};
        },
        ...(options.humanQuestions ? {
          question: (id: string) => this.experimentalEnabled() ? options.humanQuestions!.pending(id) : null,
          reply: (id: string, requestId: string, answer: string | number) => {
            if (!this.experimentalEnabled()) throw new CompanionError("not-permitted");
            try { options.humanQuestions!.reply(id, requestId, answer); }
            catch (error) {
              if (error instanceof HumanQuestionError)
                throw new CompanionError(error.code === "INVALID_REQUEST" ? "invalid-request" : "stale-request");
              throw error;
            }
          },
        } : {}),
        input: (id, data) => {
          const written = this.terminals.inputChecked(id, data);
          if (written) this.presentation.pending(id);
          return written;
        },
        inputSubmitted: (id) => this.presentation.submitted(id),
        close: (id) => this.terminals.dispose(id),
        rename: (id, title) => ({...safeSession(this.terminals.rename(id,title)),title:this.terminals.redactSecrets(title)}),
        create: (provider) => {
          if (!this.config.workspace) throw new Error("workspace-required");
          return safeSession(
            this.terminals.create({
              provider,
              profile: "normal",
              cwd: this.config.workspace,
              position: {
                x: 1600,
                y: this.terminals.listMetadata().length * 470,
              },
            }),
          );
        },
        openBrowser: options.openBrowser,
        limits: options.limits,
      },
      this.access,
      this.ledger,
    );
  }
  async load(): Promise<void> {
    await this.localLink.load();
    await this.speechSetup?.inspect();
    this.addresses = this.discover();
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      // A previous loopback/ADB grant does not silently enable a LAN listener.
      if (
        value.config &&
        ("adbPath" in value.config || "selectedSerial" in value.config)
      ) {
        value.config.enabled = false;
        value.peers = [];
      }
      this.config = await this.validateConfig({
        ...defaultConfig(),
        ...value.config,
      });
      if (Array.isArray(value.peers))
        for (const peer of value.peers.slice(0, 8)) {
          if (
            typeof peer.id === "string" &&
            /^[a-f0-9]{32}$/.test(peer.id) &&
            /^[a-f0-9]{64}$/.test(peer.tokenHash) &&
            peer.transportVersion === 2 &&
            Array.isArray(peer.grant?.sessionIds)
          ) {
            const grant = this.access.share({
              deviceId: peer.id,
              sessionIds: peer.grant.sessionIds
                .filter((id: unknown) => typeof id === "string")
                .slice(0, 64),
              allowInput: peer.grant.allowInput === true,
              allowCreate: peer.grant.allowCreate === true,
              allowClose: peer.grant.allowClose === true,
              allowBrowser: peer.grant.allowBrowser === true && !this.config.publicOrigin,
            });
            this.peers.push({
              id: peer.id,
              name: String(peer.name || "Even App").slice(0, 80),
              tokenHash: peer.tokenHash,
              transportVersion: 2,
              clientType: peer.clientType === "phone" || peer.clientType === "even-g2"
                ? peer.clientType
                : peer.summaryOnly === true ? "phone" : "even-g2",
              ...((peer.needsReclassification === true ||
                (peer.clientType !== "phone" && peer.clientType !== "even-g2" && peer.summaryOnly === true))
                ? { needsReclassification: true } : {}),
              grant,
            });
          }
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.error = "settings-unavailable";
    }
    if (!this.config.workspace) this.config.workspace = this.defaultWorkspace;
    this.speech.configure(
      this.config.speechExecutable,
      this.config.speechModel,
    );
    if (this.config.enabled) {
      try {
        await this.start();
      } catch {
        await this.stop();
        this.error = "listener-unavailable";
      }
    }
  }
  /** History remains available; the glasses notice describes only a still-current condition. */
  private currentAttention(session:SessionMetadata,selectionSent:boolean):AttentionEvent|null {
    return [...this.notifications("glasses",session.id)].reverse().find(event=>{
      if(event.sessionId!==session.id)return false;
      switch(event.kind) {
        case "approval": return session.status==="needs_approval" && !selectionSent;
        case "response": return session.status==="idle" && !session.turnCompleted && this.presentation.canShowResponseAttention(session.id);
        case "done": return session.status==="done" || session.status==="idle" && session.turnCompleted===true;
        case "failed": return session.status==="failed";
        case "budget": return session.taskBudget?.warning===true || session.taskBudget?.paused===true;
        case "loop": return session.exitCode===null && this.loopWarningActive(session.id);
      }
    }) ?? null;
  }
  observe(channel: string, payload: unknown): void {
    if (this.config.enabled) this.presentation.observe(channel, payload);
  }
  answer(id: string, text: string, turnId: string | null, expiresAt: number): void {
    if (this.config.enabled) this.presentation.answer(id, text, turnId, expiresAt);
  }
  clearAnswer(id: string): void {
    this.presentation.clearAnswer(id);
  }
  private async validateConfig(value: EvenG2Config): Promise<EvenG2Config> {
    for (const key of [
      "enabled",
      "allowInput",
      "allowCreate",
      "allowClose",
      "allowBrowser",
    ] as const)
      if (typeof value[key] !== "boolean") throw new Error("invalid-settings");
    for (const key of [
      "workspace",
      "interfaceName",
      "publicOrigin",
      "speechExecutable",
      "speechModel",
    ] as const)
      if (
        typeof value[key] !== "string" ||
        value[key].length > 4096 ||
        /[\x00-\x1f]/.test(value[key])
      )
        throw new Error("invalid-settings");
    if (
      !Array.isArray(value.sessionIds) ||
      value.sessionIds.length > 64 ||
      value.sessionIds.some(
        (id) => typeof id !== "string" || !id || id.length > 128,
      )
    )
      throw new Error("invalid-settings");
    if (value.workspace === this.defaultWorkspace)
      await mkdir(value.workspace, { recursive: true });
    if (value.workspace && !(await stat(value.workspace)).isDirectory())
      throw new Error("workspace-unavailable");
    return {
      enabled: value.enabled,
      workspace: value.workspace ? resolve(value.workspace) : "",
      interfaceName: value.interfaceName,
      publicOrigin: isUsbOrigin(value.publicOrigin, this.port)
        ? value.publicOrigin : httpsOrigin(value.publicOrigin),
      sessionIds: [...new Set(value.sessionIds)],
      allowInput: value.allowInput,
      allowCreate: value.allowCreate,
      allowClose: value.allowClose,
      // The person's LAN choice is kept while a web transport is active; grant() withholds it there, so
      // switching back to LAN restores it instead of silently dropping the glasses' browser permission.
      allowBrowser: value.allowBrowser,
      speechExecutable: value.speechExecutable,
      speechModel: value.speechModel,
    };
  }
  private grant(id: string, ids = this.config.sessionIds): CompanionGrant {
    return this.access.share({
      deviceId: id,
      sessionIds: ids,
      allowInput: this.config.allowInput,
      allowCreate: this.config.allowCreate,
      allowClose: this.config.allowClose,
      // USB, Tailscale and private HTTPS origins never grant the project browser.
      allowBrowser: this.config.allowBrowser && !this.config.publicOrigin,
    });
  }
  private save(config: EvenG2Config = this.config, peers: StoredPeer[] = this.peers): Promise<void> {
    const payload = JSON.stringify(
      {
        version: 1,
        config,
        peers: peers.map((p) => ({ ...p, grant: this.access.get(p.id) })),
      },
      null,
      2,
    );
    const operation = this.saveQueue.then(async () => {
      await mkdir(resolve(this.file, ".."), { recursive: true, mode: 0o700 });
      const temporary =
        this.file + "." + randomBytes(8).toString("hex") + ".tmp";
      try {
        await writeFile(temporary, payload, { mode: 0o600, flag: "wx" });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.saveQueue = operation.then(() => { this.unsaved = false; }, () => undefined);
    return operation;
  }
  /** Whether the companion is switched on; decides answer capture for sessions spawned now. */
  enabled(): boolean {
    return this.config.enabled;
  }
  /** The desktop's current scoped grant, independent of transport and the phone's own claims. */
  canReply(sessionId: string): boolean {
    if (!this.experimentalEnabled() || !this.config.enabled || this.closing) return false;
    return this.peers.some(peer => {
      if (peer.clientType !== "phone") return false;
      try {
        const grant = this.access.get(peer.id);
        return grant.allowInput && grant.sessionIds.includes(sessionId);
      } catch { return false; }
    });
  }
  state(): EvenG2State {
    if (this.pairing && Date.now() > this.pairing.expiresAt)
      this.pairing = null;
    return {
      config: structuredClone(this.config),
      availableSessions: this.terminals.listMetadata().map(safeSession),
      peers: this.peers.map((p) => ({
        id: p.id,
        name: p.name,
        clientType: p.clientType,
        ...(p.needsReclassification ? { needsReclassification: true } : {}),
        grant: this.access.get(p.id),
        ...(this.seen.get(p.id) || { lastSeen: 0, telemetry: null }),
      })),
      pairing: this.pairing
        ? {
            code: this.pairing.code,
            expiresAt: this.pairing.expiresAt,
            target: this.pairing.target,
            pending: this.pairing.pending
              ? { id: this.pairing.pending.id, name: this.pairing.pending.name }
              : null,
          }
        : null,
      transport: {
        kind: isUsbOrigin(this.config.publicOrigin, this.port)
          ? "usb" : this.config.publicOrigin ? "https" : "lan",
        addresses: structuredClone(this.addresses),
        origin: this.boundAddress
          ? this.config.publicOrigin ||
            addressOrigin(this.boundAddress, this.port)
          : "",
        origins: this.localOrigins(),
        ready: !!this.server?.listening,
      },
      listening: !!this.server?.listening,
      port: this.port,
      error: this.error,
      speechSetup: this.speechSetup?.state(),
      speech: { available: this.speech.available, model: this.speech.model },
    };
  }
  async command(command: EvenG2Command): Promise<EvenG2State> {
    if (!command || typeof command !== "object")
      throw new Error("invalid-command");
    if (this.commandBusy) throw new Error("operation-pending");
    this.commandBusy = true;
    try {
      if (command.type === "configure") {
        const config = await this.validateConfig(command.config);
        // Saved before it is applied: a configuration that cannot be saved changes nothing (like approve).
        await this.save(config);
        this.speech.cancelAll();
        this.config = config;
        this.pairing = null;
        this.localLink.clearBootstraps();
        for (const peer of this.peers) {
          peer.grant = this.grant(peer.id);
        }
        this.speech.configure(config.speechExecutable, config.speechModel);
        if (config.enabled) await this.start();
        else await this.stop();
      } else if (command.type === "prepare-speech") {
        if (!this.speechSetup) throw new Error("bundled-speech-unavailable");
        const current = this.config.speechExecutable;
        void this.speechSetup
          .prepare()
          .then(async () => {
            if (this.closing || this.config.speechExecutable !== current)
              return;
            this.config.speechExecutable = this.speechSetup!.binary;
            this.config.speechModel = this.speechSetup!.modelPath;
            this.speech.configure(
              this.config.speechExecutable,
              this.config.speechModel,
            );
            await this.speech.inspect();
            await this.save();
          })
          .catch(() => {});
      } else if (command.type === "cancel-speech-setup") {
        this.speechSetup?.cancel();
      } else if (command.type === "refresh") {
        this.addresses = this.discover();
        if (this.config.enabled) await this.reconcileNetwork();
      } else if (command.type === "begin-pairing") {
        if ((command.target ?? (this.isPhoneOnlyTransport() ? "phone" : "even-g2")) === "phone" && !this.experimentalEnabled())
          throw new Error("Experimental phone integration is disabled; not verified live.");
        if (!this.config.enabled || !this.server?.listening)
          throw new Error("enable-first");
        if (
          !this.config.sessionIds.length &&
          !(this.config.allowCreate && this.config.workspace)
        )
          throw new Error("choose-sessions");
        if (this.peers.length >= 8) throw new Error("device-limit");
        if (!this.config.publicOrigin && this.discovery && !this.discovery.host) throw new Error("local-discovery-unavailable");
        if (command.target !== undefined && command.target !== "phone" && command.target !== "even-g2")
          throw new Error("invalid-client-type");
        this.localLink.clearBootstraps();
        const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
        const expiresAt = Date.now() + 120000;
        this.pairing = {
          code,
          expiresAt,
          attempts: 0,
          target: command.target ?? (this.isPhoneOnlyTransport() ? "phone" : "even-g2"),
          local: new LocalPairing(code, expiresAt),
          pending: null,
        };
      } else if (command.type === "cancel-pairing" || command.type === "reject") {
        this.pairing = null;
        this.localLink.clearBootstraps();
      } else if (command.type === "approve") {
        const pending = this.pairing?.pending;
        if (
          !pending ||
          pending.id !== command.id ||
          this.pairing!.expiresAt < Date.now()
        )
          throw new Error("pairing-expired");
        if (pending.clientType === "phone" && !this.experimentalEnabled()) throw new Error("Experimental phone integration is disabled; not verified live.");
        pending.grant = this.grant(pending.id);
        this.peers.push(pending);
        this.pairing = null;
        this.localLink.clearBootstraps();
        try {
          await this.save();
        } catch (error) {
          this.access.revoke(pending.id);
          this.peers = this.peers.filter((peer) => peer.id !== pending.id);
          throw error;
        }
      } else if (command.type === "set-peer-type") {
        if (command.clientType === "phone" && !this.experimentalEnabled()) throw new Error("Experimental phone integration is disabled; not verified live.");
        if (command.clientType !== "phone" && command.clientType !== "even-g2")
          throw new Error("invalid-client-type");
        const peer = this.peers.find((entry) => entry.id === command.id);
        if (!peer) throw new Error("device-unavailable");
        if (!peer.needsReclassification) throw new Error("not-ambiguous");
        const next = this.peers.map((entry) => entry.id === peer.id
          ? { ...entry, clientType: command.clientType, needsReclassification: undefined }
          : entry);
        if (command.clientType === "phone") {
          // Restrict immediately, then retry the persisted change if disk is temporarily unavailable.
          this.peers = next;
          try {
            await this.save();
          } catch (error) {
            this.unsaved = true;
            throw error;
          }
        } else {
          // Do not grant legacy G2 routes until the host's explicit role choice is durable.
          await this.save(this.config, next);
          this.peers = next;
        }
      } else if (command.type === "revoke") {
        this.access.revoke(command.id);
        this.ledger.forgetDevice(command.id);
        this.peers = this.peers.filter((p) => p.id !== command.id);
        this.seen.delete(command.id);
        // The device lost access at once; never rolled back. Not saved: saved again until it is, so a restart
        // does not bring the device back.
        try {
          await this.save();
        } catch (error) {
          this.unsaved = true;
          throw error;
        }
      } else throw new Error("unknown-command");
      if (!this.config.enabled || this.server?.listening) this.error = "";
      return this.state();
    } finally {
      this.commandBusy = false;
    }
  }
  private async start(): Promise<void> {
    await this.reconcileNetwork();
    await this.speech.inspect();
    if (!this.timer)
      this.timer = setInterval(() => {
        if (this.commandBusy || this.closing) return;
        this.commandBusy = true;
        void (this.unsaved ? this.save().catch(() => undefined) : Promise.resolve())
          .then(() => this.reconcileNetwork())
          .catch(() => {
            this.error = "listener-unavailable";
          })
          .finally(() => {
            this.commandBusy = false;
          });
      }, 5000);
  }
  private async reconcileNetwork(): Promise<void> {
    this.addresses = this.discover();
    const selected = this.config.publicOrigin
      ? { name: "loopback", address: "127.0.0.1" }
      : this.config.interfaceName
        ? this.addresses.find(
            (address) => address.name === this.config.interfaceName,
          )
        : this.addresses[0];
    const targets = selected
      ? this.config.publicOrigin
        ? [selected.address]
        : [
            ...new Set(
              this.addresses
                .filter((a) => a.name === selected.name)
                .map((a) => a.address),
            ),
          ].slice(0, 6)
      : [];
    const old = this.boundAddress
      ? [this.boundAddress, ...this.extraServers.keys()]
      : [];
    if (JSON.stringify(targets) !== JSON.stringify(old))
      await this.closeListener();
    if (!selected || this.closing) {
      this.error = "network-unavailable";
      return;
    }
    if (this.server?.listening) {
      if (!this.config.publicOrigin && this.discovery && !this.discovery.host)
        await this.startDiscovery(targets.find(a => !a.includes(":")) || this.boundAddress, selected.name);
      return;
    }
    try {
      for (const address of targets) {
        const server = createServer((req, res) => {
          void this.handle(req, res, address).catch((error: unknown) => {
            if (!res.headersSent) {
              const mobile = req.url?.split("?")[0] === "/g2/api/mobile";
              const code = error instanceof CompanionError ? error.code
                : error instanceof SyntaxError ||
                  (error instanceof Error && ["json-required", "too-large", "invalid-body"].includes(error.message))
                  ? "invalid-request" : "request-failed";
              const status = code === "invalid-request" ? 400
                : code === "not-paired" ? 401
                : code === "not-shared" || code === "not-permitted" ? 403
                : code === "stale-request" ? 408
                : code === "busy" ? 429
                : code === "unavailable" ? 404
                : code === "request-failed" ? 500 : 409;
              this.json(res, mobile ? status : 409, { error: mobile ? code : "request-failed" });
            } else res.destroy();
          });
        });
        server.requestTimeout = 70000;
        server.headersTimeout = 10000;
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.port, address, () => {
              server.off("error", reject);
              resolve();
            });
          });
        } catch (error) {
          server.close();
          throw error;
        }
        server.on("error", () => {
          this.error = "listener-failed";
        });
        if (!this.server) {
          this.server = server;
          this.boundAddress = address;
          this.port = (server.address() as { port: number }).port;
        } else this.extraServers.set(address, server);
      }
      if (!this.config.publicOrigin && this.discovery && !this.closing)
        await this.startDiscovery(targets.find(a => !a.includes(":")) || this.boundAddress, selected.name);
      if (this.closing) await this.closeListener();
      this.error = "";
    } catch (error) {
      await this.closeListener();
      throw error;
    }
  }
  /**
   * Publishes the Bonjour name. A failure is not the listener's (it serves addresses typed by hand; pairing says
   * local-discovery-unavailable) and is tried again after five minutes, not on every 5 s network check.
   */
  private async startDiscovery(address: string, interfaceName: string): Promise<void> {
    if (!this.discovery || Date.now() < this.discoveryRetryAt) return;
    try {
      await this.discovery.start(address, interfaceName, this.port);
      this.discoveryRetryAt = 0;
    } catch {
      this.discoveryRetryAt = Date.now() + 5 * 60_000;
    }
  }
  private localOrigins(): string[] {
    if (this.config.publicOrigin) return [this.config.publicOrigin];
    if (!this.boundAddress) return [];
    if (this.discovery?.host) return [`http://${this.discovery.host}:${this.port}`];
    const origins = [this.boundAddress, ...this.extraServers.keys()].map((a) =>
      addressOrigin(a, this.port),
    );
    if (/^[a-z0-9][a-z0-9-]*\.local$/i.test(this.localName))
      origins.push(`http://${this.localName}:${this.port}`);
    return origins;
  }
  private async closeListener(): Promise<void> {
    this.discovery?.stop();
    this.pairing = null;
    this.speech.cancelAll();
    const servers = [this.server, ...this.extraServers.values()].filter(
      (s): s is Server => !!s,
    );
    this.server = null;
    this.boundAddress = "";
    this.extraServers.clear();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  }
  private async stop(): Promise<void> {
    this.pairing = null;
    this.speech.cancelAll();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.closeListener();
    this.presentation.close();
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.diagnosticsTimer) clearTimeout(this.diagnosticsTimer);
    this.diagnosticsTimer = null;
    this.speechSetup?.cancel();
    await this.stop();
    this.presentation.close();
    if (this.unsaved) await this.save().catch(() => undefined);
    await this.saveQueue;
    await this.diagnosticsWrite;
  }
  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  private async body(
    req: IncomingMessage,
    limit = 1_310_720,
  ): Promise<Record<string, unknown>> {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new Error("json-required");
    const parts: Buffer[] = [];
    let length = 0;
    for await (const raw of req) {
      const part = Buffer.from(raw);
      length += part.length;
      if (length > limit) throw new Error("too-large");
      parts.push(part);
    }
    const value = JSON.parse(Buffer.concat(parts).toString());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid-body");
    return value;
  }
  private request(
    data: Record<string, unknown>,
    action: CompanionRequest["action"],
  ): CompanionRequest {
    return {
      version: 1,
      id:
        typeof data.requestId === "string"
          ? data.requestId
          : randomBytes(16).toString("hex"),
      sentAt: typeof data.sentAt === "number" ? data.sentAt : Date.now(),
      action,
    };
  }
  /** These transports restrict routes while active; the host-selected device type is persistent. */
  private isPhoneOnlyTransport(): boolean {
    return TAILSCALE_ORIGIN.test(this.config.publicOrigin) ||
      isUsbOrigin(this.config.publicOrigin, this.port);
  }
  private isSummaryOnlyPeer(peer: StoredPeer): boolean {
    return peer.clientType === "phone" || this.isPhoneOnlyTransport();
  }
  private isEncryptedForward(req: IncomingMessage): boolean {
    const secret = req.headers["x-canvastty-local-forward"];
    return ["127.0.0.1", this.boundAddress].includes(req.socket.remoteAddress ?? "") &&
      typeof secret === "string" && /^[a-f0-9]{64}$/.test(secret) &&
      timingSafeEqual(Buffer.from(secret, "hex"), this.mobileForwardSecret);
  }
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    address = this.boundAddress,
  ): Promise<void> {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!this.experimentalEnabled() && (
      url.pathname === "/mobile" || url.pathname.startsWith("/mobile/") || url.pathname === "/g2/api/mobile" ||
      (this.pairing?.target === "phone" && ["/g2/pair-start", "/g2/pair-finish", "/g2/api/pair"].includes(url.pathname))
    )) return this.json(res, 403, { error: "experimental-disabled" });
    if (["/g2/discover", "/g2/pair-start", "/g2/pair-finish"].includes(url.pathname)) {
      const active = !!this.pairing && this.pairing.expiresAt > Date.now();
      res.once("finish", () => {
        if (this.closing) return;
        const line = `${new Date().toISOString()} ${req.method} ${url.pathname} HTTP ${res.statusCode} active=${active} family=${address.includes(":") ? "IPv6" : "IPv4"}`;
        this.pairingDiagnostics = [...this.pairingDiagnostics, line].slice(-64);
        // Anyone on the LAN can call these: the log is written at most once a second, not per request.
        if (this.diagnosticsTimer) return;
        this.diagnosticsTimer = setTimeout(() => {
          this.diagnosticsTimer = null;
          const text = this.pairingDiagnostics.join("\n") + "\n";
          this.diagnosticsWrite = this.diagnosticsWrite.catch(() => {}).then(() =>
            writeFile(join(this.file, "..", "even-g2-pairing.log"), text, { mode: 0o600 })).catch(() => {});
        }, 1_000);
        this.diagnosticsTimer.unref?.();
      });
    }
    const expectedHost = new URL(addressOrigin(address, this.port)).host;
    const localHost = this.localName.toLowerCase() + ":" + this.port;
    if (
      req.headers.host?.toLowerCase() !== expectedHost &&
      req.headers.host?.toLowerCase() !== (this.config.publicOrigin
        ? new URL(this.config.publicOrigin).host
        : localHost) &&
      (this.config.publicOrigin ||
        req.headers.host?.toLowerCase() !== `${this.discovery?.host}:${this.port}`)
    )
      return this.json(res, 403, { error: "invalid-host" });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Headers": "Authorization,Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      res.end();
      return;
    }
    if (url.pathname === "/g2/discover" && req.method === "GET") {
      return this.json(res, 200, { type: "canvastty-local", version: 2,
        pairing: !!this.pairing && this.pairing.expiresAt > Date.now() && !this.pairing.pending });
    }
    if (req.method === "POST" &&
      ["/g2/pair-start", "/g2/pair-finish"].includes(url.pathname)) {
      const pair = this.pairing;
      if (!pair || pair.expiresAt <= Date.now() || pair.pending)
        return this.json(res, 403, { error: "pairing-unavailable" });
      const data = await this.body(req, 8192);
      if (this.pairing !== pair) return this.json(res, 403, { error: "pairing-unavailable" });
      try {
        if (url.pathname === "/g2/pair-start")
          return this.json(res, 200, pair.local.start(data.public));
        const session = pair.local.finish(data.id, data.proof);
        const pairedConnection = this.localLink.bootstrapConnection(
          String(data.id), session.key, this.localOrigins(),
        );
        const packet = await sealLocal({ version: 1, computer: String(data.id),
          key: session.key, origins: this.localOrigins() },
        { connection: pairedConnection, code: pair.code }, "response");
        if (this.pairing !== pair || pair.expiresAt <= Date.now())
          return this.json(res, 403, { error: "pairing-unavailable" });
        this.localLink.registerBootstrap(String(data.id), session.key, pair.expiresAt);
        return this.json(res, 200, { proof: session.proof, packet });
      } catch { return this.json(res, 403, { error: "pairing-unavailable" }); }
    }
    if (req.method === "POST" && url.pathname === "/g2/link") {
      const packet = await this.body(req, LOCAL_LINK_LIMIT + 1024);
      const result = await this.localLink.receive(
        packet as unknown as LocalPacket,
        async (request: LocalRequest) => {
          if (!this.config.enabled || !this.server?.listening)
            throw new Error("integration-disabled");
          const webMode = TAILSCALE_ORIGIN.test(this.config.publicOrigin) ||
            isUsbOrigin(this.config.publicOrigin, this.port);
          if (webMode) {
            if (request.path === "/g2/api/home" && request.method === "GET" && !request.token)
              return { status: 401, body: { error: "unauthorized" } };
            if (!(
              (request.path === "/g2/api/pair" && request.method === "POST" && packet.bootstrapId) ||
              (request.path === "/g2/api/pair-status" && request.method === "GET" && packet.deviceId) ||
              (request.path === "/g2/api/mobile" && request.method === "POST" && packet.deviceId)
            ))
              return { status: 403, body: { error: "not-permitted" } };
          }
          const response = await fetch(
            addressOrigin(this.boundAddress, this.port) + request.path,
            {
              method: request.method,
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + request.token,
                ...((request.path === "/g2/api/mobile" ||
                  (webMode && (request.path === "/g2/api/pair" || request.path === "/g2/api/pair-status"))) ? {
                  "X-CanvasTTY-Local-Forward": this.mobileForwardSecret.toString("hex"),
                  "X-CanvasTTY-Local-Device": typeof packet.deviceId === "string" ? packet.deviceId : "",
                } : {}),
              },
              body:
                request.method === "POST"
                  ? JSON.stringify(request.body)
                  : undefined,
              redirect: "error",
              signal: AbortSignal.timeout(65_000),
            },
          );
          return { status: response.status, body: await response.json() };
        },
        (id) =>
          this.peers.some((peer) => peer.id === id && (peer.clientType !== "phone" || this.experimentalEnabled())) ||
          (this.pairing?.pending?.id === id && (this.pairing.target !== "phone" || this.experimentalEnabled())),
      );
      return this.json(res, 200, result);
    }
    if (req.method === "GET" && (url.pathname === "/mobile" || url.pathname.startsWith("/mobile/"))) {
      if (!this.mobileRoot || !existsSync(this.mobileRoot))
        return this.json(res, 404, { error: "not-found" });
      const root = realpathSync(this.mobileRoot);
      const file = resolve(root, url.pathname.slice("/mobile/".length) || "index.html");
      if (!isPathInside(root, file, { allowRoot: false }) || !existsSync(file))
        return this.json(res, 404, { error: "not-found" });
      const path = realpathSync(file);
      if (!isPathInside(root, path, { allowRoot: false }) || !statSync(path).isFile())
        return this.json(res, 404, { error: "not-found" });
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webp": "image/webp",
        ".woff2": "font/woff2",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, {
        "Content-Type": types[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(readFileSync(path));
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/g2/") &&
      !url.pathname.startsWith("/g2/api/")
    ) {
      const root = resolve(this.webRoot),
        path = resolve(root, url.pathname.slice(4) || "index.html");
      if (!isPathInside(root, path, { allowRoot: false }) || !existsSync(path))
        return this.json(res, 404, { error: "not-found" });
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
      };
      res.writeHead(200, {
        "Content-Type": types[extname(path)] || "application/octet-stream",
      });
      res.end(readFileSync(path));
      return;
    }
    if ((TAILSCALE_ORIGIN.test(this.config.publicOrigin) ||
         isUsbOrigin(this.config.publicOrigin, this.port)) &&
        url.pathname.startsWith("/g2/api/") &&
        (url.search || !this.isEncryptedForward(req) ||
          (url.pathname !== "/g2/api/pair" &&
           url.pathname !== "/g2/api/pair-status" &&
           url.pathname !== "/g2/api/mobile")))
      return this.json(res, 403, { error: "not-permitted" });
    if (req.method === "POST" && url.pathname === "/g2/api/pair") {
      const data = await this.body(req),
        pair = this.pairing;
      if (
        !pair ||
        (pair.target === "phone" && !this.experimentalEnabled()) ||
        pair.expiresAt < Date.now() ||
        pair.pending ||
        ++pair.attempts > 10 ||
        data.code !== pair.code
      )
        return this.json(res, 403, { error: "pairing-unavailable" });
      const token = randomBytes(32).toString("hex"),
        id = randomBytes(16).toString("hex");
      pair.pending = {
        id,
        name:
          typeof data.name === "string" ? data.name.slice(0, 80) : "Even App",
        tokenHash: hash(token),
        transportVersion: 2,
        clientType: pair.target,
        grant: {
          deviceId: id,
          revision: 0,
          sessionIds: [],
          allowInput: false,
          allowCreate: false,
          allowClose: false,
          allowBrowser: false,
        },
      };
      return this.json(res, 202, {
        token,
        id,
        state: "pending",
        transportKey: this.localLink.deviceConnection(id, []).key,
      });
    }
    if (url.pathname === "/g2/api/mobile") {
      if (req.method !== "POST" || url.search || !this.isEncryptedForward(req))
        return this.json(res, 403, { error: "not-permitted" });
    }
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    if (!/^[a-f0-9]{64}$/.test(token))
      return this.json(res, 401, { error: "unauthorized" });
    const tokenHash = hash(token),
      peer = this.peers.find((p) => p.tokenHash === tokenHash);
    if (peer?.clientType === "phone" && !this.experimentalEnabled()) return this.json(res, 403, { error: "experimental-disabled" });
    if (url.pathname === "/g2/api/pair-status" && req.method === "GET")
      return this.json(res, 200, {
        state: peer
          ? "approved"
          : this.pairing &&
              this.pairing.expiresAt > Date.now() &&
              this.pairing.pending?.tokenHash === tokenHash
            ? "pending"
            : "rejected",
      });
    if (!peer) return this.json(res, 401, { error: "unauthorized" });
    if (this.isSummaryOnlyPeer(peer) && url.pathname !== "/g2/api/mobile") return this.json(res, 403, { error: "not-permitted" });
    if (url.pathname === "/g2/api/mobile" && !this.isSummaryOnlyPeer(peer))
      return this.json(res, 403, { error: "not-permitted" });
    if (url.pathname === "/g2/api/mobile" &&
        req.headers["x-canvastty-local-device"] !== peer.id)
      return this.json(res, 403, { error: "not-permitted" });
    const existing = this.seen.get(peer.id);
    this.seen.set(peer.id, {
      lastSeen: Date.now(),
      telemetry: existing?.telemetry || null,
    });
    if (url.pathname === "/g2/api/mobile") {
      const data = await this.body(req, 65_536);
      const type = (data.action as Record<string, unknown> | null)?.type;
      if (typeof type !== "string" || !Object.hasOwn(MOBILE_ACTIONS, type))
        throw new CompanionError("invalid-request");
      if (!this.experimentalEnabled()) return this.json(res, 403, { error: "experimental-disabled" });
      const result = await this.actions.dispatch(peer.id, data,{summaryOnly:true});
      if (type === "session.create") await this.save();
      return this.json(res, 200, result);
    }
    const grant = this.access.get(peer.id);
    if (req.method === "GET" && url.pathname === "/g2/api/home") {
      const sessions = await this.actions.dispatch(
        peer.id,
        this.request({}, { type: "sessions.list" }),
      );
      const limits = await this.limits().catch(() => null);
      this.access.assertCurrent(grant);
      return this.json(res, 200, {
        sessions,
        limits,
        localOrigins: this.localOrigins(),
        speechAvailable: this.speech.available && grant.allowInput,
        speechModel: this.speech.model,
        computerName: hostname(),
        features: {
          terminalChoices: grant.allowInput,
          manualInput: grant.allowInput,
          sessionClose: grant.allowClose,
          sessionRename: grant.allowInput,
          projectBrowser: grant.allowBrowser,
          sessionCreate: grant.allowCreate,
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/g2/api/terminal") {
      const id = url.searchParams.get("id") || "";
      this.access.assertSession(grant, id);
      const view = await this.presentation.read(id);
      this.access.assertCurrent(grant);
      const session = this.terminals.listMetadata().find((s) => s.id === id);
      if (!session) return this.json(res, 404, { error: "not-found" });
      return this.json(res, 200, { session: {...safeSession(session),title:this.terminals.redactSecrets(session.title)}, ...view,attention:this.currentAttention(session,view.revision.startsWith("selected-")) });
    }
    if (req.method !== "POST")
      return this.json(res, 404, { error: "not-found" });
    const data = await this.body(req),
      id = typeof data.sessionId === "string" ? data.sessionId : "";
    if (
      !["/g2/api/device-state", "/g2/api/cancel"].includes(url.pathname) &&
      (typeof data.requestId !== "string" ||
        !/^[a-f0-9]{32}$/.test(data.requestId) ||
        typeof data.sentAt !== "number" ||
        !Number.isSafeInteger(data.sentAt) ||
        data.sentAt < Date.now() - 120000 ||
        data.sentAt > Date.now() + 30000)
    )
      return this.json(res, 400, { error: "invalid-request" });
    if (url.pathname === "/g2/api/device-state") {
      const telemetry: EvenG2Telemetry = {
        clientVersion: String(data.clientVersion || "").slice(0, 24),
        display: data.display === "confirmed" ? "confirmed" : "unknown",
        microphone: ["never", "on", "off", "unknown"].includes(
          String(data.microphone),
        )
          ? (data.microphone as EvenG2Telemetry["microphone"])
          : "unknown",
        audioBytes:
          typeof data.audioBytes === "number" &&
          Number.isSafeInteger(data.audioBytes)
            ? Math.max(0, Math.min(960000, data.audioBytes))
            : 0,
        error: typeof data.error === "string" ? data.error.slice(0, 200) : "",
        diagnostics: Array.isArray(data.diagnostics)
          ? data.diagnostics
              .filter((line): line is string => typeof line === "string")
              .slice(-24)
              .map((line) => line.slice(0, 180))
          : [],
      };
      this.seen.set(peer.id, { lastSeen: Date.now(), telemetry });
      return this.json(res, 200, { accepted: true });
    }
    if (url.pathname === "/g2/api/create") {
      const existingIds = new Set(
        this.terminals.listMetadata().map((session) => session.id),
      );
      const remaining = grant.sessionIds.filter((sessionId) =>
        existingIds.has(sessionId),
      );
      if (remaining.length !== grant.sessionIds.length)
        this.access.share({ ...grant, sessionIds: remaining });
      const result = await this.actions.dispatch(
        peer.id,
        this.request(data, {
          type: "session.create",
          provider: data.provider as ProviderId,
        }),
      );
      await this.save();
      return this.json(res, 201, { session: result });
    }
    if (url.pathname === "/g2/api/session-rename")
      return this.json(res, 200, {
        session: await this.actions.dispatch(
          peer.id,
          this.request(data, {
            type: "session.rename",
            sessionId: id,
            title: data.title as string,
          }),
        ),
      });
    if (url.pathname === "/g2/api/session-close")
      return this.json(
        res,
        200,
        await this.actions.dispatch(
          peer.id,
          this.request(data, { type: "session.close", sessionId: id }),
        ),
      );
    if (url.pathname === "/g2/api/browser")
      return this.json(res, 200, {
        opened: true,
        ...((await this.actions.dispatch(
          peer.id,
          this.request(data, { type: "browser.open", sessionId: id }),
        )) as object),
      });
    if (url.pathname === "/g2/api/cancel") {
      if (typeof data.requestId === "string")
        this.speech.cancel(hash(peer.id + ":" + data.requestId));
      return this.json(res, 200, { cancelled: true });
    }
    if (
      typeof data.requestId !== "string" ||
      !/^[a-f0-9]{32}$/.test(data.requestId) ||
      typeof data.sentAt !== "number" ||
      !Number.isSafeInteger(data.sentAt) ||
      data.sentAt < Date.now() - 120000 ||
      data.sentAt > Date.now() + 30000
    )
      return this.json(res, 400, { error: "invalid-request" });
    this.access.assertSession(grant, id);
    if (!grant.allowInput)
      return this.json(res, 403, { error: "not-permitted" });
    if (url.pathname === "/g2/api/voice") {
      if (
        data.purpose !== undefined &&
        data.purpose !== "input" &&
        data.purpose !== "rename"
      )
        return this.json(res, 400, { error: "invalid-purpose" });
      const purpose = data.purpose === "rename" ? "rename" : "input";
      const voiceRequest = {
        ...this.request(data, { type: "session.read", sessionId: id }),
        action: {
          type: "session.voice",
          sessionId: id,
          purpose,
          audio: data.audio,
        },
      };
      const result = await this.ledger.run(peer.id, voiceRequest, () =>
        this.speech.run(
          { ...data, requestId: hash(peer.id + ":" + data.requestId) },
          async (text, cancelled) => {
            if (purpose === "rename") {
              if (cancelled()) return false;
              this.access.assertCurrent(grant);
              if (
                !this.terminals
                  .listMetadata()
                  .some((session) => session.id === id)
              )
                throw new Error("terminal-closed");
              normalizeSessionTitle(text);
              return true; // Preview only; a separate confirmed rename request changes metadata.
            }
            const view = await this.presentation.read(id);
            if (cancelled()) return false;
            if (view.interaction) throw new Error("menu-open");
            this.access.assertCurrent(grant);
            if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text))
              throw new Error("invalid-transcript");
            if (
              !this.terminals.inputChecked(
                id,
                "\x1b[200~" + text + "\x1b[201~\r",
              )
            )
              throw new Error("terminal-closed");
            this.presentation.submitted(id);
            return true;
          },
        ),
      );
      return this.json(res, 200, result);
    }
    if (url.pathname === "/g2/api/control") {
      if (
        data.action === "text" &&
        (await this.presentation.read(id)).interaction
      )
        return this.json(res, 409, { error: "menu-open" });
      if (data.action === "text")
        return this.json(res, 200, {
          accepted: true,
          ...((await this.actions.dispatch(
            peer.id,
            this.request(data, {
              type: "session.input",
              sessionId: id,
              text: data.text as string,
            }),
          )) as object),
        });
      if (data.action !== "choose" && data.action !== "custom")
        return this.json(res, 400, { error: "invalid-action" });
      const request = {
        ...this.request(data, { type: "session.read", sessionId: id }),
        action: {
          type: "session.choose",
          sessionId: id,
          menuId: data.menuId,
          index: data.index,
          custom: data.action === "custom",
        },
      };
      const result = await this.ledger.run(peer.id, request, async () => {
        const choice = await this.presentation.choice(
          id,
          String(data.menuId),
          Number(data.index),
          data.action === "custom",
        );
        this.access.assertCurrent(grant);
        if (!this.terminals.inputChecked(id, choice.data))
          throw new Error("terminal-closed");
        choice.commit();
        return { accepted: true };
      });
      return this.json(res, 200, result);
    }
    return this.json(res, 404, { error: "not-found" });
  }
}
