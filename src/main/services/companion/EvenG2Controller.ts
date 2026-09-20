import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFile, writeFile, mkdir, rename, stat, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import { hostname } from "node:os";
import type { TerminalManager } from "../TerminalManager.ts";
import type { LimitsSnapshot, ProviderId } from "../../../shared/contracts.ts";
import type {
  CompanionGrant,
  CompanionRequest,
} from "../../../shared/companion.ts";
import type {
  EvenG2Config,
  EvenG2State,
  EvenG2Command,
  EvenG2Telemetry,
  EvenG2Address,
} from "../../../shared/evenG2.ts";
import { normalizeSessionTitle } from "../../../shared/companion.ts";
import { SessionAccess } from "./SessionAccess.ts";
import { RequestLedger } from "./RequestLedger.ts";
import { CompanionSessions } from "./CompanionSessions.ts";
import { TerminalPresentation } from "./TerminalPresentation.ts";
import { SpeechRecognizer } from "./SpeechRecognizer.ts";
import { lanAddresses, httpsOrigin, addressOrigin } from "./LanNetwork.ts";
import { LocalLink } from "./LocalLink.ts";
import {
  sealLocal,
  LOCAL_LINK_LIMIT,
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
  private readonly discovery: LocalDiscovery | null;
  private readonly defaultWorkspace: string;
  private readonly speechSetup: SpeechSetup | null;
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

  constructor(options: {
    userDataPath: string;
    terminals: Terminals;
    webRoot: string;
    speechWorker: string;
    speech?: SpeechPort;
    limits: () => Promise<LimitsSnapshot>;
    openBrowser: () => Promise<{ title: string; url: string }>;
    port?: number;
    addresses?: () => EvenG2Address[];
    defaultWorkspace?: string;
    bundledSpeech?: string;
    localHostname?: string;
    localDiscovery?: boolean;
  }) {
    this.file = join(options.userDataPath, "even-g2.json");
    this.localLink = new LocalLink(options.userDataPath);
    this.discovery = options.localDiscovery ? new LocalDiscovery() : null;
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
    this.webRoot = options.webRoot;
    this.port = options.port ?? 3481;
    this.discover = options.addresses ?? lanAddresses;
    this.speech = options.speech ?? new SpeechRecognizer(options.speechWorker);
    this.limits = options.limits;
    this.presentation = new TerminalPresentation(this.terminals);
    this.actions = new CompanionSessions(
      {
        list: () => this.terminals.listMetadata().map(safeSession),
        read: (id) => this.presentation.read(id),
        input: (id, data) => {
          const written = this.terminals.inputChecked(id, data);
          if (written) this.presentation.pending(id);
          return written;
        },
        close: (id) => this.terminals.dispose(id),
        rename: (id, title) => safeSession(this.terminals.rename(id, title)),
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
              allowBrowser: peer.grant.allowBrowser === true,
            });
            this.peers.push({
              id: peer.id,
              name: String(peer.name || "Even App").slice(0, 80),
              tokenHash: peer.tokenHash,
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
  observe(channel: string, payload: unknown): void {
    if (this.config.enabled) this.presentation.observe(channel, payload);
  }
  answer(id: string, text: string, turnId: string | null): void {
    if (this.config.enabled) this.presentation.answer(id, text, turnId);
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
      publicOrigin: httpsOrigin(value.publicOrigin),
      sessionIds: [...new Set(value.sessionIds)],
      allowInput: value.allowInput,
      allowCreate: value.allowCreate,
      allowClose: value.allowClose,
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
      allowBrowser: this.config.allowBrowser,
    });
  }
  private save(): Promise<void> {
    const payload = JSON.stringify(
      {
        version: 1,
        config: this.config,
        peers: this.peers.map((p) => ({ ...p, grant: this.access.get(p.id) })),
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
    this.saveQueue = operation.catch(() => undefined);
    return operation;
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
        grant: this.access.get(p.id),
        ...(this.seen.get(p.id) || { lastSeen: 0, telemetry: null }),
      })),
      pairing: this.pairing
        ? {
            code: this.pairing.code,
            expiresAt: this.pairing.expiresAt,
            pending: this.pairing.pending
              ? { id: this.pairing.pending.id, name: this.pairing.pending.name }
              : null,
          }
        : null,
      transport: {
        kind: this.config.publicOrigin ? "https" : "lan",
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
        this.speech.cancelAll();
        this.config = config;
        this.pairing = null;
        for (const peer of this.peers) peer.grant = this.grant(peer.id);
        this.speech.configure(config.speechExecutable, config.speechModel);
        if (config.enabled) await this.start();
        else await this.stop();
        await this.save();
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
        if (!this.config.enabled || !this.server?.listening)
          throw new Error("enable-first");
        if (
          !this.config.sessionIds.length &&
          !(this.config.allowCreate && this.config.workspace)
        )
          throw new Error("choose-sessions");
        if (this.peers.length >= 8) throw new Error("device-limit");
        if (this.discovery && !this.discovery.host) throw new Error("local-discovery-unavailable");
        const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
        const expiresAt = Date.now() + 120000;
        this.pairing = {
          code, expiresAt, attempts: 0,
          local: new LocalPairing(code, expiresAt),
          pending: null,
        };
      } else if (command.type === "cancel-pairing" || command.type === "reject")
        this.pairing = null;
      else if (command.type === "approve") {
        const pending = this.pairing?.pending;
        if (
          !pending ||
          pending.id !== command.id ||
          this.pairing!.expiresAt < Date.now()
        )
          throw new Error("pairing-expired");
        pending.grant = this.grant(pending.id);
        this.peers.push(pending);
        this.pairing = null;
        try {
          await this.save();
        } catch (error) {
          this.access.revoke(pending.id);
          this.peers = this.peers.filter((peer) => peer.id !== pending.id);
          throw error;
        }
      } else if (command.type === "revoke") {
        this.access.revoke(command.id);
        this.ledger.forgetDevice(command.id);
        this.peers = this.peers.filter((p) => p.id !== command.id);
        this.seen.delete(command.id);
        await this.save();
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
        void this.reconcileNetwork()
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
        await this.discovery.start(targets.find(a => !a.includes(":")) || this.boundAddress, selected.name, this.port);
      return;
    }
    try {
      for (const address of targets) {
        const server = createServer((req, res) => {
          void this.handle(req, res, address).catch(() => {
            if (!res.headersSent)
              this.json(res, 409, { error: "request-failed" });
            else res.destroy();
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
        await this.discovery.start(targets.find(a => !a.includes(":")) || this.boundAddress, selected.name, this.port);
      if (this.closing) await this.closeListener();
      this.error = "";
    } catch (error) {
      await this.closeListener();
      throw error;
    }
  }
  private localOrigins(): string[] {
    if (!this.boundAddress || this.config.publicOrigin) return [];
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
    this.speechSetup?.cancel();
    await this.stop();
    this.presentation.close();
    await this.saveQueue;
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
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    address = this.boundAddress,
  ): Promise<void> {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (["/g2/discover", "/g2/pair-start", "/g2/pair-finish"].includes(url.pathname)) {
      const active = !!this.pairing && this.pairing.expiresAt > Date.now();
      res.once("finish", () => {
        const line = `${new Date().toISOString()} ${req.method} ${url.pathname} HTTP ${res.statusCode} active=${active} family=${address.includes(":") ? "IPv6" : "IPv4"}`;
        this.pairingDiagnostics = [...this.pairingDiagnostics, line].slice(-64);
        const text = this.pairingDiagnostics.join("\n") + "\n";
        this.diagnosticsWrite = this.diagnosticsWrite.catch(() => {}).then(() =>
          writeFile(join(this.file, "..", "even-g2-pairing.log"), text, { mode: 0o600 })).catch(() => {});
      });
    }
    const expectedHost = new URL(addressOrigin(address, this.port)).host;
    const localHost = this.localName.toLowerCase() + ":" + this.port;
    if (
      req.headers.host?.toLowerCase() !== expectedHost &&
      (this.config.publicOrigin ||
        req.headers.host?.toLowerCase() !== localHost &&
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
    if (!this.config.publicOrigin && url.pathname === "/g2/discover" && req.method === "GET") {
      return this.json(res, 200, { type: "canvastty-local", version: 2,
        pairing: !!this.pairing && this.pairing.expiresAt > Date.now() && !this.pairing.pending });
    }
    if (!this.config.publicOrigin && req.method === "POST" &&
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
        const connection = this.localLink.connection(this.localOrigins());
        const packet = await sealLocal({ version: 1, computer: String(data.id),
          key: session.key, origins: connection.origins }, { connection, code: pair.code }, "response");
        if (this.pairing !== pair || pair.expiresAt <= Date.now())
          return this.json(res, 403, { error: "pairing-unavailable" });
        return this.json(res, 200, { proof: session.proof, packet });
      } catch { return this.json(res, 403, { error: "pairing-unavailable" }); }
    }
    if (
      req.method === "POST" &&
      url.pathname === "/g2/link" &&
      !this.config.publicOrigin
    ) {
      const packet = await this.body(req, LOCAL_LINK_LIMIT + 1024);
      const result = await this.localLink.receive(
        packet as unknown as LocalPacket,
        async (request: LocalRequest) => {
          if (!this.config.enabled || !this.server?.listening)
            throw new Error("integration-disabled");
          const response = await fetch(
            addressOrigin(this.boundAddress, this.port) + request.path,
            {
              method: request.method,
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + request.token,
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
      );
      return this.json(res, 200, result);
    }
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/g2/") &&
      !url.pathname.startsWith("/g2/api/")
    ) {
      const root = resolve(this.webRoot),
        path = resolve(root, url.pathname.slice(4) || "index.html");
      if (!path.startsWith(root + sep) || !existsSync(path))
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
    if (req.method === "POST" && url.pathname === "/g2/api/pair") {
      const data = await this.body(req),
        pair = this.pairing;
      if (
        !pair ||
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
      return this.json(res, 202, { token, id, state: "pending" });
    }
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    if (!/^[a-f0-9]{64}$/.test(token))
      return this.json(res, 401, { error: "unauthorized" });
    const tokenHash = hash(token),
      peer = this.peers.find((p) => p.tokenHash === tokenHash);
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
    const existing = this.seen.get(peer.id);
    this.seen.set(peer.id, {
      lastSeen: Date.now(),
      telemetry: existing?.telemetry || null,
    });
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
      return this.json(res, 200, { session: safeSession(session), ...view });
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
            this.presentation.pending(id);
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
