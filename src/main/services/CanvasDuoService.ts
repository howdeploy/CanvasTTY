import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import type { DuoCard, DuoCommand, DuoComment, DuoCursor, DuoReply, DuoSnapshot, DuoState } from "../../shared/canvasDuo.ts";
import { validSurfaceInputs, validSurfaceFrame, type DuoSurfacePort, type DuoSurfaceInput } from "../../shared/duoSurface.ts";
import { DuoDiagnostics } from "./DuoDiagnostics.ts";
import type { DuoDiagnosticEvent } from "../../shared/duoDiagnostics.ts";
import { DuoPeerTransport, type PeerInvite } from "./DuoPeerTransport.ts";
import { SessionScreen, type ScreenPort } from "./materials/sessionScreen.ts";
import type { DuoDocumentPort, DuoDocumentOp } from '../../shared/duoDocument';
import { DUO_CURSOR_DESIGNS, DUO_CURSOR_NICKNAME_MAX_LENGTH, mergeDuoSnapshot, normalizeDuoCursorDesign, normalizeDuoCursorNickname } from '../../shared/canvasDuo.ts';
import { DUO_READ_CHANNELS } from '../../shared/duoResources.ts';

type TerminalMetadata = import("../../shared/contracts").SessionMetadata;
interface TerminalPort extends ScreenPort {
  create?(request: import("../../shared/contracts").CreateSessionRequest): { id: string };
  setBounds?(id: string, bounds: import("../../shared/contracts").SessionBounds): void;
  rename?(id: string, title: string): unknown;
  dispose?(id: string): void;
  resize?(id: string, cols: number, rows: number): void;
  listMetadata(): Array<Pick<TerminalMetadata, "id" | "title" | "provider" | "exitCode" | "position" | "size"> &
    Partial<Pick<TerminalMetadata, "role" | "status" | "turnCompleted" | "revision" | "nativeEditor">>>;
  inputChecked(id: string, text: string, origin: "person"): boolean;
}
interface LanInvite { version: 1; host: string; port: number; key: string }
type Invite = LanInvite | PeerInvite;
interface Packet { nonce: string; data: string; tag: string }
interface DuoTerminalFiles {
  canOpen(id:string,reference:string):Promise<boolean>;
  open(id:string,reference:string,authorized:()=>boolean):Promise<void>;
}
type RemoteAction = { rootId?: string; pageId?: string; pageOffset?: number; outputOffsets?:Record<string,number>; documentVersion?:string; ops?:DuoDocumentOp[]; channel?:string; args?:unknown[]; name?:"terminal"|"note"|"home"; frameId?:string; events?:DuoSurfaceInput[]; action: string; cardId?: string; text?: string; x?: number; y?: number; design?: unknown; nickname?: unknown; bounds?: import("../../shared/contracts").SessionBounds; cols?: number; rows?: number };
type Message = RemoteAction & { id: string; peer: string; at: number };
const LIMIT = 2 * 1024 * 1024;
// AES envelope base64 adds one third to the plaintext, plus transport framing.
const MAX_RESPONSE_BYTES = 1_400_000;
const OUTPUT_BUDGET_BYTES = 480_000;
const DOCUMENT_PAGE_SIZE = 128_000;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const TTL = 60 * 60 * 1000;
const PEER_LEASE_MS = 15_000;
export function duoLanAddress(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const a = host.split(".").map(Number);
  return a.every(n => n <= 255) && (a[0] === 10 || a[0] === 127 || (a[0] === 192 && a[1] === 168) || (a[0] === 172 && a[1]! >= 16 && a[1]! <= 31) || (a[0] === 100 && a[1]! >= 64 && a[1]! <= 127));
}
export function parseDuoInvite(raw: unknown): Invite {
  if (typeof raw !== 'string' || raw.length > 1800) throw new Error('Invalid Canvas Duo invitation.');
  if (!raw.startsWith('canvasduo://')) throw new Error('Invalid Canvas Duo invitation.');
  const encoded = raw.slice(12);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid Canvas Duo invitation.');
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Invite;
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.key)) throw new Error('Invalid Canvas Duo invitation.');
  if (value.version === 3) {
    if (!/^[a-f0-9]{64}$/.test(value.hostKey) || !/^[A-Za-z0-9_-]{43}$/.test(value.guestSeed)) throw new Error('Invalid Canvas Duo invitation.');
  } else if (value.version !== 1 || !duoLanAddress(value.host) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('Invalid Canvas Duo invitation.');
  return value;
}
export function sealDuo(value: unknown, key: Buffer, direction: "request" | "response"): Packet {
  return sealDuoJson(JSON.stringify(value), key, direction);
}
function sealDuoJson(json: string, key: Buffer, direction: "request" | "response"): Packet {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`CanvasDuo/1/${direction}`));
  const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return { nonce: nonce.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
export function openDuo(packet: unknown, key: Buffer, direction: "request" | "response"): unknown {
  const p = packet as Packet;
  if (!p || typeof p.nonce !== "string" || typeof p.tag !== "string" || typeof p.data !== "string" || p.nonce.length !== 16 || p.tag.length !== 24 || p.data.length > LIMIT * 2) throw new Error("Invalid encrypted packet.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(p.nonce, "base64"));
  decipher.setAAD(Buffer.from(`CanvasDuo/1/${direction}`));
  decipher.setAuthTag(Buffer.from(p.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(p.data, "base64")), decipher.final()]).toString("utf8"));
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error("Request too large.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Ephemeral, opt-in encrypted sharing. Keys and remote input never enter settings or logs. */
export class CanvasDuoService {
  private readonly diagnostics: DuoDiagnostics;
  private trace: ReturnType<DuoDiagnostics["begin"]> | undefined;
  diagnosticReport() { return this.diagnostics.report(); }
  private readonly terminals: TerminalPort;
  private server: Server | null = null;
  private peerHost: DuoPeerTransport | null = null;
  private peerClient: DuoPeerTransport | null = null;
  private key: Buffer | null = null;
  private guest: Invite | null = null;
  private peerId = randomUUID();
  private connectedPeer = "";
  private peerEpoch = 0;
  private peerLastSeen = 0;
  private expiresAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private updatesTimer: ReturnType<typeof setTimeout> | null = null;
  private updateSnapshot: DuoSnapshot | undefined;
  private reconnectPending: Promise<void> | null = null;
  private reconnectAfter = 0;
  private reconnectAttempts = 0;
  private connectAbort: AbortController | null = null;
  private published = '';
  private selected = new Set<string>();
  private controlled = new Set<string>();
  private invites: string[] = [];
  private seen = new Map<string, number>();
  private requests = new Map<string, number[]>();
  private documentPages = new Map<string, { text: string; peer: string; expires: number }>();
  private outputCursor = 0;
  private comments: DuoComment[] = [];
  private focus = new Map<string, string>();
  private profiles = new Map<string, Pick<DuoCursor, 'nickname' | 'design'>>();
  private terminalAuthors = new Map<string, "host" | "guest">();
  private cursors = new Map<string, DuoCursor>();
  private screens = new Map<string, SessionScreen>();
  private snapshotPending: Promise<DuoSnapshot> | null = null;
  private generation = 0;
  private lifecycleEpoch = 0;
  private snapshotSequence = 0;
  private workspaceId = "";
  private manage = false;
  private fullCanvas = false;
  private documentSync = false;
  private lastSuccessAt = 0;
  private operation: Promise<unknown> = Promise.resolve();
  private receivedMutations: Promise<unknown> = Promise.resolve();
  private options: {onDiagnostic?:(event:DuoDiagnosticEvent)=>void; peerOptions?: Record<string,unknown>; cwd?: string; surface?:DuoSurfacePort; document?:DuoDocumentPort; files?:DuoTerminalFiles; onChanged?:(reply:DuoReply)=>void};
  constructor(terminals: TerminalPort, options: {onDiagnostic?:(event:DuoDiagnosticEvent)=>void; peerOptions?: Record<string,unknown>; cwd?: string; surface?:DuoSurfacePort; document?:DuoDocumentPort; files?:DuoTerminalFiles; onChanged?:(reply:DuoReply)=>void} = {}) { this.terminals = terminals; this.options = options; this.diagnostics = new DuoDiagnostics(options.onDiagnostic); }

  private publish(reply:DuoReply):void {
    if (!this.options.onChanged) return;
    const signature = JSON.stringify(reply, (key,value) => key === 'sequence' ? undefined : value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])) : value);
    if (signature === this.published) return;
    this.published = signature;
    this.options.onChanged(reply);
  }

  /** Timers in the main process keep receiving data when Chromium is hidden. */
  private startUpdates(generation: number): void {
    if (!this.options.onChanged) return;
    const tick = async (): Promise<void> => {
      if (generation !== this.generation) return;
      try {
        let reply: DuoReply;
        if (this.guest || this.connectedPeer) {
          const offsets = Object.fromEntries((this.updateSnapshot?.cards ?? []).filter(c => c.output).map(c => [c.id, c.output!.outputOffset]));
          reply = await this.execute(this.documentSync ? { action:'updates', outputOffsets:offsets, documentVersion:this.updateSnapshot?.documentVersion } : { action:'snapshot' });
        } else reply = { state:this.state() };
        if (generation !== this.generation) return;
        if (reply.snapshot) this.updateSnapshot = mergeDuoSnapshot(this.updateSnapshot, reply.snapshot);
        this.publish({ ...reply, snapshot:this.updateSnapshot });
      } catch (error) {
        if (generation !== this.generation) return;
        this.publish({ state:this.state(), error:error instanceof Error ? error.message : String(error) });
        void this.reconnect(generation).catch(() => undefined);
      }
      if (generation === this.generation) {
        this.updatesTimer = setTimeout(() => void tick(), this.documentSync ? 150 : 750);
        this.updatesTimer.unref();
      }
    };
    this.updatesTimer = setTimeout(() => void tick(), 0);
    this.updatesTimer.unref();
  }

  /** Only re-establish transport. Never repeat a command with uncertain delivery. */
  private reconnect(generation:number):Promise<void> {
    if (this.reconnectPending) return this.reconnectPending;
    const invite = this.guest;
    if (!invite || invite.version !== 3 || this.peerClient?.connected || Date.now() < this.reconnectAfter || this.expiresAt <= Date.now()) return Promise.resolve();
    this.manage = false;
    this.reconnectAfter = Date.now() + Math.min(15000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 4));
    const trace = this.diagnostics.begin('guest','p2p');
    trace.record('reconnect-start');
    const task = (async () => {
      const old = this.peerClient; this.peerClient = null;
      await old?.stop();
      if (generation !== this.generation) return;
      this.trace = trace;
      const abort = new AbortController(); this.connectAbort = abort;
      const client = await DuoPeerTransport.join(invite, this.options.peerOptions, abort.signal, trace);
      if (generation !== this.generation) { await client.stop(); return; }
      this.peerClient = client;
      try { await this.remote({ action:'heartbeat' }); this.reconnectAttempts = 0; trace.record('reconnected'); }
      catch (error) { if(this.peerClient===client)this.peerClient = null; await client.stop(); throw error; }
    })().catch(error => { trace.record('reconnect-failed',error); throw error; }).finally(() => { if (this.reconnectPending === task) this.reconnectPending = null; });
    this.reconnectPending = task;
    return task;
  }

  private hosting(): boolean { return Boolean(this.server || this.peerHost); }

  private available(): DuoCard[] {
    return this.terminals.listMetadata().map(s => ({ id: s.id, title: s.title, focusedBy: [...this.focus].filter(([, id]) => id === s.id).map(([role]) => this.identity(role).nickname ?? role), participant: this.terminalAuthors.get(s.id) ?? 'host', provider: s.provider, role: s.role, status: s.status, turnCompleted: s.turnCompleted, running: s.exitCode === null, control: this.documentSync ? this.manage : this.controlled.has(s.id), position: s.position, size: s.size, revision: s.revision, nativeEditor: s.nativeEditor }));
  }
  private expirePeer(): void {
    if (!this.connectedPeer || Date.now() - this.peerLastSeen <= PEER_LEASE_MS) return;
    this.trace?.record("peer-lease-expired");
    this.releaseGuest();
  }
  private releaseGuest(): void {
    this.connectedPeer = "";
    this.peerLastSeen = 0;
    this.documentPages.clear();
    this.controlled.clear();
    this.manage = false;
    this.options.surface?.release();
    this.options.document?.clear();
    this.focus.delete("guest"); this.profiles.delete("guest");
    this.cursors.delete("guest");
  }
  state(): DuoState {
    this.expirePeer();
    return { role: this.hosting() ? "host" : this.guest ? "guest" : "idle", invites: [...this.invites], expiresAt: this.expiresAt,
      status: this.hosting() ? (this.connectedPeer ? (Date.now()-this.peerLastSeen < 5000 ? "connected" : "disconnected") : "waiting") : this.guest ? (this.lastSuccessAt && Date.now()-this.lastSuccessAt < 5000 ? "connected" : "disconnected") : "idle", workspaceId:this.workspaceId, manage:this.manage, fullCanvas:this.fullCanvas, documentSync:this.documentSync,
      available: this.guest ? [] : this.available(), selected: [...this.selected], controlled: [...this.controlled], connection: this.peerHost?.route ?? this.peerClient?.route, peer: Boolean(this.connectedPeer) && Date.now() - this.peerLastSeen < 5000 };
  }
  command(command: DuoCommand): Promise<DuoReply> {
    if (!command || typeof command !== "object") return Promise.reject(new Error("Invalid Duo command."));
    // Emergency stop is independent of an outstanding connect/RPC.
    if (command.action === "stop") { this.lifecycleEpoch++; return this.execute(command); }
    // Serialize lifecycle changes, so double-clicking Start cannot leave an orphan listener.
    if (["host", "join", "stop", "select"].includes(command.action)) {
      const epoch = this.lifecycleEpoch;
      const task = this.operation.catch(() => undefined).then(() => {
        if (epoch !== this.lifecycleEpoch) throw new Error("Duo connection cancelled.");
        return this.execute(command);
      });
      this.operation = task;
      return task;
    }
    return this.execute(command);
  }
  private select(ids: unknown, control: unknown): void {
    const available = new Set(this.available().map(c => c.id));
    if (!Array.isArray(ids) || ids.length > 8 || !ids.every(id => typeof id === "string" && available.has(id)) || !Array.isArray(control) || control.length > 8 || !control.every(id => ids.includes(id))) throw new Error("Choose up to eight existing terminal cards.");
    this.selected = new Set(ids); this.controlled = new Set(control);
    for (const [id, screen] of this.screens) if (!this.selected.has(id)) { screen.dispose(); this.screens.delete(id); }
    this.comments = this.comments.filter(c => c.cardId==="canvas"||this.fullCanvas||this.selected.has(c.cardId));
    for (const [id, cursor] of this.cursors) if (!this.selected.has(cursor.cardId)) this.cursors.delete(id);
  }
  private async execute(command: DuoCommand): Promise<DuoReply> {
    if (command.action === "state") {
      const state=this.state();
      // A reloaded renderer must receive the current workspace even if the
      // deduplicated main-process stream has no new changes to publish.
      return { state, ...(this.updateSnapshot?{snapshot:mergeDuoSnapshot(this.updateSnapshot,{partial:true,cards:[],comments:[],cursors:[],expiresAt:this.expiresAt,manage:this.manage})}:{}) };
    }
    if (command.action === "stop") {
      const leave = this.guest ? this.remote({ action: "leave" }).catch(() => undefined) : undefined;
      await this.stop();
      if (leave) await Promise.race([leave, new Promise(resolve => setTimeout(resolve, 150))]);
      return { state: this.state() };
    }
    if (command.action === "host") {
      await this.stop();
      const trace = this.diagnostics.begin('host',command.transport === 'lan' ? 'lan':'p2p'); this.trace = trace;
      this.select(command.selected, command.controlled);
      this.workspaceId = randomUUID(); this.manage = command.manage === true; this.fullCanvas=command.fullCanvas===true;
      this.documentSync=this.fullCanvas&&command.documentSync===true;
      if(this.fullCanvas&&!(this.documentSync?this.options.document:this.options.surface)){await this.stop();throw new Error("Full canvas sharing is unavailable in this build.");}
      const generation = this.generation;
      this.key = randomBytes(32); this.expiresAt = Date.now() + TTL;
      if (command.transport !== 'lan') {
        try {
          const key = this.key;
          const peer = await DuoPeerTransport.host(key.toString('base64url'), packet => this.receive(packet, key), () => {
            if (generation !== this.generation) return;
            trace.record('peer-disconnected');
            this.releaseGuest();
          }, this.options.peerOptions, trace);
          if (generation !== this.generation) { await peer.transport.stop(); throw new Error("Duo connection cancelled."); }
          this.peerHost = peer.transport;
          this.invites = ['canvasduo://' + Buffer.from(JSON.stringify(peer.invite)).toString('base64url')];
          this.timer = setTimeout(() => { if(!this.connectedPeer || Date.now()-this.peerLastSeen>PEER_LEASE_MS) void this.stop(); }, TTL); this.timer.unref();
          this.startUpdates(generation);
          return {state:this.state()};
        } catch (error) { trace.record('host-failed',error); if (generation === this.generation) await this.stop(); throw new Error('Cannot establish a direct Duo connection on this network.'); }
      }
      const server = createServer((req, res) => { void (async () => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        const address = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
        if (req.method !== "POST" || req.url !== "/duo" || req.headers.origin !== undefined || !duoLanAddress(address) || !this.key || (this.expiresAt <= Date.now() && !this.connectedPeer)) { res.writeHead(403).end(); return; }
        try {
          const key = this.key;
          const packet = await body(req);
          const result = await this.receive(packet, key);
          if (res.destroyed || this.key !== key) return;
          res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
        } catch { res.writeHead(403).end(); }
      })().catch(() => { if (!res.destroyed) res.writeHead(500).end(); }); });
      server.requestTimeout = 10_000; server.headersTimeout = 10_000;
      server.maxConnections = 8;
      this.server = server;
      try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", () => { server.removeListener("error", reject); resolve(); }); }); }
      catch (error) { trace.record('host-failed',error); await this.stop(); throw error; }
      server.on("error", () => { void this.stop(); });
      trace.record('listening');
      const port = (server.address() as AddressInfo).port;
      const hosts = Object.values(networkInterfaces()).flatMap(v => v ?? []).filter(v => v.family === "IPv4" && !v.internal && duoLanAddress(v.address)).map(v => v.address);
      this.invites = [...new Set(hosts.length ? hosts : ["127.0.0.1"])].map(host => "canvasduo://" + Buffer.from(JSON.stringify({ version: 1, host, port, key: this.key!.toString("base64url") })).toString("base64url"));
      this.timer = setTimeout(() => { if(!this.connectedPeer || Date.now()-this.peerLastSeen>PEER_LEASE_MS) void this.stop(); }, TTL); this.timer.unref();
      this.startUpdates(generation);
      return { state: this.state() };
    }
    if (command.action === "select") { if (!this.hosting()) throw new Error("Start hosting first."); this.select(command.selected, command.controlled); this.manage=command.manage===true; if(!this.manage) { this.options.surface?.release(); this.options.document?.revokeControl?.(); } return { state: this.state() }; }
    if (command.action === "join") {
      let invite: Invite;
      try { invite = parseDuoInvite(command.invite); } catch { this.diagnostics.begin('guest','p2p').record('invitation-invalid',new Error('Invalid Canvas Duo invitation.')); throw new Error('Invalid Canvas Duo invitation.'); }
      await this.stop();
      const trace = this.diagnostics.begin('guest',invite.version===3?'p2p':'lan'); this.trace=trace;
      this.guest = invite; this.peerId = randomUUID();
      const generation = this.generation;
      try {
        if(invite.version===3) { const abort=new AbortController();this.connectAbort=abort;const client=await DuoPeerTransport.join(invite,this.options.peerOptions,abort.signal,trace); if(generation!==this.generation){await client.stop();throw new Error("Duo connection cancelled.");} this.peerClient=client; }
        if(generation!==this.generation)throw new Error("Duo connection cancelled.");
        trace.record('snapshot-start');
        const snapshot = await this.remote({ action: "snapshot" }); trace.record('connected'); this.expiresAt = snapshot.expiresAt;
        this.updateSnapshot = snapshot;
        this.startHeartbeat(generation);
        this.startUpdates(generation);
        return { state: this.state(), snapshot }; }
      catch (error) { trace.record('join-failed',error); if (generation === this.generation) await this.stop(); throw error; }
    }
    if (!this.hosting() && !this.guest) throw new Error("Start or join a Duo session first.");
    const generation = this.generation;
    const snapshot = this.guest ? await this.remote(command) : await this.perform(command, "host");
    if (generation !== this.generation) throw new Error("Duo session changed.");
    return { state: this.state(), snapshot };
  }
  private async receive(packet: unknown, key: Buffer): Promise<unknown> {
    const value = openDuo(packet, key, 'request') as Message;
    this.expirePeer();
    if (this.key !== key || (this.expiresAt <= Date.now() && this.connectedPeer !== value.peer)) throw new Error('Duo session changed.');
    this.validateMessage(value);
    if (this.connectedPeer && value.peer !== this.connectedPeer) throw new Error('This invitation is already in use.');
    if (!this.connectedPeer) {
      this.peerEpoch++;
      this.trace?.record("peer-authenticated");
    }
    this.connectedPeer = value.peer; this.peerLastSeen = Date.now();
    let json: string;
    try {
      const generation = this.generation;
      const epoch = this.peerEpoch;
      const isCurrent = () => generation === this.generation && this.key === key && this.peerEpoch === epoch;
      const perform = () => {
        if (!isCurrent() || this.connectedPeer !== value.peer) throw Error('Duo session changed.');
        return this.perform(value, 'guest');
      };
      const read = ['heartbeat', 'snapshot', 'updates', 'document-page', 'surface', 'file-can-open'].includes(value.action)
        || (value.action === 'resource' && (DUO_READ_CHANNELS.has(value.channel ?? '')
          || ['protocol', 'chunk', 'browser-frame'].includes(value.channel ?? '')));
      // Slow capture/media/document reads must not hold keyboard input or the
      // lease heartbeat. Mutating requests retain arrival order and recheck
      // authorization at execution, including after Stop or Leave.
      let task: Promise<DuoSnapshot>;
      if (read) task = perform();
      else {
        task = this.receivedMutations.catch(() => undefined).then(perform);
        this.receivedMutations = task;
      }
      const snapshot = await task;
      if (!isCurrent() || (value.action !== 'leave' && this.connectedPeer !== value.peer)) throw Error('Duo session changed.');
      json = JSON.stringify({ id: value.id, ok: true, snapshot });
      if (Buffer.byteLength(json) > MAX_RESPONSE_BYTES) {
        if (!snapshot.document) throw Error('Duo response is too large.');
        const { document, ...metadata } = snapshot;
        const text = JSON.stringify(document);
        if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw Error('Shared Canvas document is too large.');
        const id = randomUUID();
        const now = Date.now();
        for (const [key, page] of this.documentPages) if (page.expires <= now) this.documentPages.delete(key);
        if (this.documentPages.size >= 2) this.documentPages.delete(this.documentPages.keys().next().value!);
        json = JSON.stringify({ id: value.id, ok: true, snapshot: { ...metadata, documentPage: { id, length: text.length } } });
        if (Buffer.byteLength(json) > MAX_RESPONSE_BYTES) throw Error('Duo response is too large.');
        this.documentPages.set(id, { text, peer: value.peer, expires: now + 60_000 });
      }
    }
    catch (error) {
      json = JSON.stringify({ id: value.id, ok: false, error: error instanceof Error ? error.message : 'Duo request failed.' });
    }
    if(this.key!==key)throw new Error('Duo session changed.');
    return sealDuoJson(json, key, 'response');
  }
  private validateMessage(value: Message): void {
    const now = Date.now();
    if (!value || typeof value.id !== "string" || !/^[\w-]{1,80}$/.test(value.id) || typeof value.peer !== "string" || !/^[\w-]{1,80}$/.test(value.peer) || !Number.isFinite(value.at) || Math.abs(now - value.at) > 60_000) throw new Error("Expired request.");
    for (const [id, at] of this.seen) if (now - at > 120_000) this.seen.delete(id);
    const upload = value.action === 'resource' && value.channel === 'file-upload';
    const chunk = value.action === 'resource' && value.channel === 'chunk';
    const pointer = value.action === 'cursor' && value.cardId === 'canvas' && this.documentSync;
    const lane = upload ? 'upload' : chunk ? 'chunk' : pointer ? 'pointer' : value.action === 'heartbeat' || value.action === 'document-page' ? value.action : 'control';
    const limit = lane === 'pointer' ? 12 : lane === 'upload' ? 16 : lane === 'heartbeat' ? 4 : (lane === 'document-page' || lane === 'chunk') ? 22 : 30;
    const requests = (this.requests.get(lane) ?? []).filter(at => now - at < 1000);
    if (this.seen.has(value.id) || this.seen.size >= 10_000 || requests.length >= limit) throw new Error("Repeated or excessive request.");
    this.seen.set(value.id, now);
    this.requests.set(lane, [...requests, now]);
  }
  private remoteInFlight = 0;
  private remoteWaiters: Array<() => void> = [];
  private readonly bulkRequests = {
    chunk: { tail: Promise.resolve<unknown>(undefined), lastAt: -Infinity, intervalMs: 55 },
    upload: { tail: Promise.resolve<unknown>(undefined), lastAt: -Infinity, intervalMs: 85 },
    "document-page": { tail: Promise.resolve<unknown>(undefined), lastAt: -Infinity, intervalMs: 55 }
  };
  /** Chromium throttles hidden-window timers; a renderer poll cannot own the peer lease. */
  private startHeartbeat(generation:number):void {
    if(this.heartbeatTimer)clearInterval(this.heartbeatTimer);
    let pending=false;
    this.heartbeatTimer=setInterval(()=>{
      if(pending||generation!==this.generation||!this.guest)return;
      pending=true;
      void this.remote({action:'heartbeat'}).catch(()=>this.reconnect(generation)).catch(()=>undefined).finally(()=>{pending=false;});
    },2000);
    this.heartbeatTimer.unref();
  }
  private async remote(command: RemoteAction): Promise<DuoSnapshot> {
    const generation = this.generation;
    if (command.action === 'heartbeat') return this.remoteNow(command);
    if (command.action === 'resource' && command.channel === 'chunk') return this.requestBulk('chunk', command, generation);
    if (command.action === 'resource' && command.channel === 'file-upload') {
      // A single paced bulk slot leaves the normal queue and keepalive free.
      return this.requestBulk('upload', command, generation);
    }
    if (this.remoteInFlight >= 4) {
      if (this.remoteWaiters.length >= 128) throw Error('Duo request queue is full.');
      await new Promise<void>(resolve => this.remoteWaiters.push(resolve));
    } else this.remoteInFlight++;
    try {
      if (generation !== this.generation) throw Error('Duo session changed.');
      const snapshot = await this.remoteNow(command);
      const { documentPage, ...metadata } = snapshot;
      if (!documentPage) return snapshot;
      if (!/^[\w-]{1,80}$/.test(documentPage.id) || !Number.isSafeInteger(documentPage.length)
          || documentPage.length < 1 || documentPage.length > MAX_DOCUMENT_BYTES) throw Error('Invalid Duo document size.');
      const chunks: string[] = [];
      for (let offset = 0; offset < documentPage.length; ) {
        const page = await this.requestBulk('document-page', { action: 'document-page', pageId: documentPage.id, pageOffset: offset }, generation);
        const chunk = page.result;
        if (typeof chunk !== 'string' || chunk.length !== Math.min(DOCUMENT_PAGE_SIZE, documentPage.length - offset)) throw Error('Invalid Duo document page.');
        chunks.push(chunk);
        offset += chunk.length;
      }
      return { ...metadata, document: JSON.parse(chunks.join('')) };
    } finally {
      const next = this.remoteWaiters.shift();
      if (next) next();
      else this.remoteInFlight--;
    }
  }
  private requestBulk(lane: keyof typeof this.bulkRequests, command: RemoteAction, generation: number): Promise<DuoSnapshot> {
    const queue = this.bulkRequests[lane];
    const task = queue.tail.catch(() => undefined).then(async () => {
      const wait = queue.lastAt + queue.intervalMs - performance.now();
      if (wait > 0) await delay(wait);
      if (generation !== this.generation) throw Error('Duo session changed.');
      queue.lastAt = performance.now();
      return this.remoteNow(command);
    });
    queue.tail = task;
    return task;
  }

  private async remoteNow(command: RemoteAction): Promise<DuoSnapshot> {
    const invite = this.guest;
    if (!invite) throw new Error("Duo is disconnected.");
    const generation = this.generation;
    const trace=this.trace, started=performance.now();
    const id = randomUUID(); const key = Buffer.from(invite.key, "base64url");
    // No retries: ambiguous input must never be sent twice.
    const packet = sealDuo({ ...command, id, peer: this.peerId, at: Date.now() }, key, 'request');
    let encrypted: unknown;
    let authenticated = false;
    try {
    if(invite.version === 3) {
      if(!this.peerClient)throw new Error('Duo is disconnected.');
      encrypted=await this.peerClient.request(packet);
    } else {
      const response = await fetch(`http://${invite.host}:${invite.port}/duo`, {method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)});
      if(!response.ok)throw new Error('Duo invitation rejected or expired.');
      const reader=response.body?.getReader();if(!reader)throw new Error('Empty Duo response.');
      const chunks:Uint8Array[]=[];let length=0;
      try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>LIMIT)throw new Error('Duo response too large.');chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>undefined);}
      encrypted=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    const result = openDuo(encrypted, key, "response") as { id: string; ok: boolean; error?: string; snapshot: DuoSnapshot };
    if (generation !== this.generation || result.id !== id) throw new Error("Duo session changed.");
    authenticated = true; this.lastSuccessAt = Date.now();
    if (!result.ok) throw new Error(result.error ?? "Duo request failed.");
    if (!result.snapshot || !Array.isArray(result.snapshot.cards) || result.snapshot.cards.length > 128 || !Array.isArray(result.snapshot.comments) || !Array.isArray(result.snapshot.cursors)) throw new Error("Invalid Duo snapshot.");
    if(result.snapshot.surface&&!validSurfaceFrame(result.snapshot.surface))throw new Error("Invalid shared canvas frame.");
    if (command.action === 'document-page') return result.snapshot;
    this.workspaceId=result.snapshot.workspaceId ?? ""; this.manage=result.snapshot.manage===true; this.fullCanvas=result.snapshot.fullCanvas===true; this.documentSync=result.snapshot.documentSync===true;
    return result.snapshot;
    } catch (error) { trace?.record(authenticated?"remote-rejected":"request-failed",error); if (!authenticated && generation === this.generation) { this.lastSuccessAt = 0; this.manage = false; } throw error; }
    finally { if(performance.now()-started>2000)trace?.record("request-slow"); }
  }
  private recordCursor(author: "host" | "guest", cardId: string, x: number, y: number, command: RemoteAction): void {
    this.profiles.set(author, {design: normalizeDuoCursorDesign(command.design), nickname: normalizeDuoCursorNickname(command.nickname)});
    this.cursors.set(author, {
      cardId, x, y, author, at: Date.now(),
      design: normalizeDuoCursorDesign(command.design),
      nickname: normalizeDuoCursorNickname(command.nickname)
    });
  }

  private visibleCursors(): DuoCursor[] {
    return [...this.cursors.values()]
      .filter(c => (this.documentSync || this.selected.has(c.cardId)) && Date.now() - c.at < 5000)
      .map(cursor => ({ ...cursor, ...this.identity(cursor.author) }));
  }

  private identity(role: string): Pick<DuoCursor, 'design' | 'nickname'> {
    const profile = this.profiles.get(role) ?? {};
    if (role === 'host') return profile;
    const host = this.profiles.get('host');
    const design = profile.design ?? 'circle';
    const nickname = profile.nickname;
    const collision = nickname && host?.nickname && nickname.toLowerCase() === host.nickname.toLowerCase();
    return { design: design === (host?.design ?? 'blob') ? DUO_CURSOR_DESIGNS.find(id => id !== design) : profile.design,
      nickname: collision ? nickname.slice(0, DUO_CURSOR_NICKNAME_MAX_LENGTH - 2) + ' 2' : nickname };
  }

  private async perform(command: RemoteAction, author: "host" | "guest"): Promise<DuoSnapshot> {
    // No document, terminal reads or browser capture on this authenticated keepalive path.
    if(command.action==='heartbeat')return {partial:true,cards:[],comments:[],cursors:[],expiresAt:this.expiresAt,
      workspaceId:this.workspaceId,manage:this.manage,fullCanvas:this.fullCanvas,documentSync:this.documentSync};
    if (command.action === 'document-page') {
      const page = this.documentPages.get(command.pageId ?? '');
      const offset = command.pageOffset;
      if (author !== 'guest' || !page || page.peer !== this.connectedPeer || page.expires < Date.now()
          || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset >= page.text.length) {
        throw Error('Shared document page expired.');
      }
      const result = page.text.slice(offset, offset + DOCUMENT_PAGE_SIZE);
      if (offset + result.length === page.text.length) this.documentPages.delete(command.pageId!);
      return { partial: true, cards: [], comments: [], cursors: [], expiresAt: this.expiresAt, result };
    }
    if(command.action==='document-edit'||command.action==='resource'){
      if(!this.documentSync||!this.options.document)throw Error('Shared object synchronization is not enabled.');
      const generation=this.generation;
      const peer = this.connectedPeer;
      const epoch = this.peerEpoch;
      const connected = () => generation === this.generation && this.documentSync
        && (author === 'host' || Boolean(peer) && this.connectedPeer === peer && this.peerEpoch === epoch);
      const authorized = () => connected() && (author === 'host' || this.manage);
      let result:unknown;
      if(command.action==='document-edit'){
        if(!authorized())throw Error('The host has not granted shared workspace control.');
        await this.options.document.edit(command.ops!,authorized);
      }else result=await this.options.document.resource(command.channel!,command.args!,authorized,author==='host'||this.manage,connected);
      if(!connected())throw Error('Duo session changed.');
      if (command.action === 'resource') return { partial:true, cards:[], comments:[], cursors:[], result,
        expiresAt:this.expiresAt, workspaceId:this.workspaceId, manage:this.manage, fullCanvas:true, documentSync:true };
      return {incremental:true,sequence:++this.snapshotSequence,cards:this.available(),comments:this.comments,cursors:[],expiresAt:this.expiresAt,workspaceId:this.workspaceId,manage:this.manage,fullCanvas:true,documentSync:true,
        ...(command.action==='document-edit'?{document:await this.options.document.snapshot()}:{result})};
    }
    if (command.action === "leave" && author === "guest") {
      this.releaseGuest();
      return { cards: [], comments: [], cursors: [], expiresAt: this.expiresAt };
    }
    if(command.action==='surface'||command.action==='surface-input'||command.action==='surface-action') {
      if(!this.fullCanvas||this.documentSync||!this.options.surface)throw new Error("Screen sharing is not enabled in this workspace.");
      if(command.action==='surface-action'){
        if(author==='guest'&&!this.manage)throw new Error('The host has not granted shared workspace control.');
        if(!['terminal','note','home'].includes(command.name??'')||!this.options.surface.action)throw Error('Invalid shared canvas action.');
        const generation=this.generation;
        await this.options.surface.action(command.name!,()=>generation===this.generation&&this.fullCanvas&&(author==='host'||this.manage));
      }
      if(command.action==='surface-input') {
        if(author==='guest'&&!this.manage)throw new Error("The host has not granted shared workspace control.");
        if(typeof command.frameId!=='string'||command.frameId.length>80||!validSurfaceInputs(command.events))throw new Error("Invalid shared canvas input.");
        const generation=this.generation;
        await this.options.surface.input(command.frameId,command.events,()=>generation===this.generation&&this.fullCanvas&&(author==='host'||this.manage));
      }
      return {sequence:++this.snapshotSequence,cards:this.available(),comments:this.comments,cursors:[],expiresAt:this.expiresAt,workspaceId:this.workspaceId,manage:this.manage,fullCanvas:true,...(command.action==='surface'?{surface:await this.options.surface.capture()}:{})};
    }
    if (command.action === 'focus') {
      const id = command.cardId;
      if (id && !this.available().some(c => c.id === id && (this.fullCanvas || this.selected.has(id)))) throw Error('This card is not shared.');
      if (id) this.focus.set(author, id);
      else this.focus.delete(author);
      this.profiles.set(author, { design: normalizeDuoCursorDesign(command.design), nickname: normalizeDuoCursorNickname(command.nickname) });
      return { partial:true, cards:[], comments:[], cursors:[], expiresAt:this.expiresAt, workspaceId:this.workspaceId,
        manage:this.manage, fullCanvas:this.fullCanvas, documentSync:this.documentSync };
    }
    if (command.action === 'updates') {
      if (!this.documentSync || !command.outputOffsets || typeof command.outputOffsets !== 'object' || Array.isArray(command.outputOffsets) || Object.keys(command.outputOffsets).length > 128 || !Object.values(command.outputOffsets).every(n => Number.isSafeInteger(n) && n >= 0) || (command.documentVersion !== undefined && !/^[a-f0-9]{64}$/.test(command.documentVersion))) throw Error('Invalid workspace update cursor.');
    }
    let createdId: string | undefined;
    const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1_000_000;
    if(command.action==='create') {
      if(author==='guest'&&!this.manage)throw new Error("The host has not granted shared workspace control.");
      if(!this.terminals.create||!finite(command.x)||!finite(command.y)||(this.fullCanvas?this.available().length:this.selected.size)>=(this.fullCanvas?128:8))throw new Error("Cannot create this shared terminal (limit: 8).");
      let cwd = this.options.cwd ?? process.cwd();
      if (command.rootId !== undefined) {
        const selected = this.documentSync && this.options.document?.terminalDirectory?.(command.rootId);
        if (!selected) throw Error('The selected host folder is no longer available.');
        cwd = selected;
      }
      const session=this.terminals.create({provider:'terminal',profile:'normal',cwd,position:{x:command.x,y:command.y},title:'Duo · Terminal'});
      this.terminalAuthors.set(session.id, author);
      createdId=session.id;this.selected.add(session.id);if(this.manage)this.controlled.add(session.id);
    } else if (command.action !== "snapshot" && command.action !== 'updates') {
      const id = command.cardId;
      if (command.action==="comment" && id==="canvas") {
        if(typeof command.text!=="string"||!command.text.trim()||command.text.length>1000)throw new Error("Invalid comment.");
        this.comments=[...this.comments.slice(-99),{id:randomUUID(),cardId:id,author,text:command.text.trim(),at:Date.now()}];
        return {...await this.snapshot(),workspaceId:this.workspaceId,manage:this.manage,fullCanvas:this.fullCanvas, documentSync:this.documentSync,comments:this.comments};
      }
      if(command.action==='cursor'&&id==='canvas'&&this.documentSync){
        if(!finite(command.x)||!finite(command.y))throw Error('Invalid canvas cursor.');
        this.recordCursor(author, id, command.x, command.y, command);
        return { partial:true, cursorUpdate:true, cards:[], comments:[], cursors:this.visibleCursors(), expiresAt:this.expiresAt,
          workspaceId:this.workspaceId, manage:this.manage, fullCanvas:true, documentSync:true };
      } else {
      if (typeof id !== "string" || (!this.fullCanvas&&!this.selected.has(id)) || !this.available().some(c => c.id === id)) throw new Error("This card is not shared.");
      if(command.action==='file-open'||command.action==='file-can-open') {
        if(!this.documentSync||!this.options.files||author!=='guest'||!this.manage)throw Error('The host has not granted shared workspace control.');
        if(typeof command.text!=='string'||!command.text||command.text.length>8192)throw Error('Invalid terminal file reference.');
        const generation=this.generation,authorized=()=>generation===this.generation&&this.documentSync&&this.manage;
        const result=command.action==='file-can-open'?await this.options.files.canOpen(id,command.text):await this.options.files.open(id,command.text,authorized);
        if(!authorized())throw Error('Shared workspace control was revoked.');
        return {partial:true,cards:[],comments:[],cursors:[],expiresAt:this.expiresAt,workspaceId:this.workspaceId,manage:this.manage,fullCanvas:true,documentSync:true,result};
      }else if(['bounds','rename','close'].includes(command.action)) {
        if(author==='guest'&&!this.manage)throw new Error("The host has not granted shared workspace control.");
        if(command.action==='bounds') {
          const b=command.bounds;
          if(!b||!finite(b.position?.x)||!finite(b.position?.y)||!finite(b.size?.width)||!finite(b.size?.height)||b.size.width<200||b.size.height<100||b.size.width>5000||b.size.height>5000||!this.terminals.setBounds)throw new Error("Invalid shared card bounds.");
          this.terminals.setBounds(id,b);
        }else if(command.action==='rename') {
          if(typeof command.text!=='string'||!command.text.trim()||command.text.length>160||!this.terminals.rename)throw new Error("Invalid shared card title.");
          this.terminals.rename(id,command.text);
        }else{
          if(!this.terminals.dispose)throw new Error("Closing shared terminals unavailable.");
          this.terminals.dispose(id);this.selected.delete(id);this.controlled.delete(id);
        }
      } else if(command.action==='resize') {
        if(author==='guest'&&!(this.documentSync?this.manage:this.controlled.has(id)))throw new Error("The host has not granted input for this card.");
        if(!Number.isInteger(command.cols)||!Number.isInteger(command.rows)||command.cols!<2||command.cols!>500||command.rows!<2||command.rows!>300||!this.terminals.resize)throw new Error("Invalid terminal geometry.");
        this.terminals.resize(id,command.cols!,command.rows!);
      } else if (command.action === "input") {
        if (author !== "guest" || !(this.documentSync?this.manage:this.controlled.has(id))) throw new Error("The host has not granted input for this card.");
        if (typeof command.text !== "string" || !command.text.length || command.text.length > 4096) throw new Error("Input must contain 1–4096 characters.");
        if (!this.terminals.inputChecked(id, command.text, "person")) throw new Error("Terminal is stopped; input was not delivered.");
        if (this.documentSync) return {partial:true,cards:[],comments:[],cursors:[],expiresAt:this.expiresAt,workspaceId:this.workspaceId,manage:this.manage,fullCanvas:true,documentSync:true};
      } else if (command.action === "comment") {
        if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 1000) throw new Error("Comment must contain 1–1000 characters.");
        this.comments = [...this.comments.slice(-99), { id: randomUUID(), cardId: id, author, text: command.text.trim(), at: Date.now() }];
      } else if (command.action === "cursor") {
        if (!Number.isFinite(command.x) || !Number.isFinite(command.y) || command.x! < 0 || command.x! > 1 || command.y! < 0 || command.y! > 1) throw new Error("Invalid cursor position.");
        this.recordCursor(author, id, command.x!, command.y!, command);
      } else throw new Error("Unsupported Duo action.");
      }
    }
    let snapshot: DuoSnapshot;
    if (command.action === 'updates') {
      snapshot = await this.snapshot(command);
    } else if (command.action === "snapshot") {
      if (!this.snapshotPending) {
        const pending = this.snapshot().finally(() => { if (this.snapshotPending === pending) this.snapshotPending = null; });
        this.snapshotPending = pending;
      }
      snapshot = await this.snapshotPending;
    } else {
      this.snapshotPending = null;
      snapshot = await this.snapshot();
    }
    // Recheck sharing after async terminal parsing: revocation must take effect immediately.
    return { ...snapshot, workspaceId:this.workspaceId, manage:this.manage, fullCanvas:this.fullCanvas, documentSync:this.documentSync, createdId, cards: snapshot.cards.filter(c => this.fullCanvas||this.selected.has(c.id)).map(c => ({ ...c, control: this.documentSync?this.manage:this.controlled.has(c.id) })), comments: this.comments.filter(c => c.cardId==="canvas"||this.fullCanvas||this.selected.has(c.cardId)), cursors: this.visibleCursors() };
  }
  private async snapshot(updates?:RemoteAction): Promise<DuoSnapshot> {
    const sequence = ++this.snapshotSequence;
    if(this.fullCanvas&&!this.documentSync)return {sequence,cards:this.available(),comments:[],cursors:[],expiresAt:this.expiresAt,fullCanvas:true};
    const cards = this.available().filter(card => this.documentSync || this.selected.has(card.id));
    let budget = OUTPUT_BUDGET_BYTES;
    const cursor = this.outputCursor % Math.max(1, cards.length);
    for (let i = 0; i < cards.length; i++) {
      const index = (cursor + i) % cards.length;
      const card = cards[index]!;
      try {
        const raw=this.terminals.readBuffer(card.id);const geometry=this.terminals.geometry(card.id);
        if (this.documentSync) {
          const offset = updates?.outputOffsets?.[card.id];
          const unchanged = offset === raw.outputOffset;
          const count = offset !== undefined && offset <= raw.outputOffset ? Math.min(32768, raw.outputOffset-offset) : 32768;
          const buffer = count ? raw.buffer.slice(-count) : "";
          if (!unchanged) {
            const output = { buffer, outputOffset: raw.outputOffset, startOffset: raw.outputOffset - buffer.length, restorePrefix: raw.restorePrefix?.slice(-8192), ...geometry };
            const bytes = Buffer.byteLength(JSON.stringify(output));
            if (bytes > budget) {
              // Leave offsets untouched for skipped cards. The next update starts here.
              this.outputCursor = index;
              break;
            }
            budget -= bytes;
            cards[index] = { ...card, output };
          }
          continue;
        }
        let screen = this.screens.get(card.id);
        if (!screen) { screen = new SessionScreen(this.terminals, card.id); this.screens.set(card.id, screen); }
        else screen.feed({ id: card.id, data: raw.buffer, outputOffset: raw.outputOffset });
        const output = { buffer: raw.buffer.slice(-32768), outputOffset: raw.outputOffset, restorePrefix: raw.restorePrefix?.slice(-8192), ...geometry };
        const text = (await screen.text()).slice(-16 * 1024);
        const bytes = Buffer.byteLength(JSON.stringify({ output, text }));
        if (bytes <= budget) { cards[index] = { ...card, output, text }; budget -= bytes; }
        else {
          const textBytes = Buffer.byteLength(JSON.stringify(text));
          if (textBytes <= budget) { cards[index] = { ...card, text }; budget -= textBytes; }
        }
      } catch { cards[index] = { ...card, text: "Terminal is no longer available." }; }
    }
    const document = this.documentSync ? await this.options.document!.snapshot() : undefined;
    const documentVersion = document ? createHash('sha256').update(JSON.stringify(document)).digest('hex') : undefined;
    return { cards, sequence, comments: [], cursors: [], expiresAt: this.expiresAt,
      ...(this.documentSync?{documentSync:true,documentVersion,...(updates?{incremental:true}:{}),...(documentVersion !== updates?.documentVersion ? {document} : {})}: {}) };
  }
  async stop(): Promise<void> {
    this.trace?.record("stopped"); this.trace=undefined;
    this.receivedMutations = Promise.resolve();
    this.generation++; this.options.surface?.release(); this.options.document?.clear(); this.fullCanvas=false; this.documentSync=false;
    this.connectAbort?.abort(); this.connectAbort = null;
    const server = this.server; this.server = null;
    const host = this.peerHost; this.peerHost = null;
    const client = this.peerClient; this.peerClient = null;
    this.key = null; this.guest = null; this.expiresAt = 0; this.workspaceId="";this.manage=false;this.lastSuccessAt=0; this.connectedPeer = "";
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = null;
    if (this.updatesTimer) clearTimeout(this.updatesTimer); this.updatesTimer = null;
    this.updateSnapshot=undefined;this.reconnectAfter=0;this.reconnectAttempts=0;this.reconnectPending=null;
    this.terminalAuthors.clear(); this.focus.clear(); this.profiles.clear();
    this.invites = []; this.selected.clear(); this.controlled.clear(); this.comments = []; this.cursors.clear(); this.seen.clear(); this.requests.clear(); this.documentPages.clear(); this.outputCursor = 0;
    for (const screen of this.screens.values()) screen.dispose(); this.screens.clear(); this.snapshotPending = null;
    this.published='';this.publish({state:this.state()});
    await Promise.all([host?.stop(),client?.stop()]);
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()); }); }
  }
}
