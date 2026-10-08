import { dirname, join, isAbsolute, normalize } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type {
  LaunchProfileId,
  SessionRole,
  Point,
  ProviderId,
  SessionEnvironmentChoice,
  SessionMetadata,
  Size
} from "../../shared/contracts.ts";
import { normalizeThreadId } from "../../agent-runtime/runtime-protocol.mjs";
import { isLaunchProfile } from "../../shared/autoMode.ts";
import { isProviderId } from "../../shared/providerCatalog.ts";
import { launchEffortProblem, launchModelProblem, type ReasoningEffort } from "../../shared/launchModel.ts";

const TERMINAL_SESSION_STORE_VERSION = 2;
/**
 * A bound against a damaged or hostile file, far above what a canvas holds: every open card is saved (a cap that cut
 * the newest cards lost them on the next restore). Records are counted after validation.
 */
const MAX_PERSISTED_SESSIONS = 1_024;
/** Opaque plugin-owned JSON (launch options, environment refs) is capped per value. */
export const MAX_PLUGIN_SLOT_BYTES = 4_096;
const MAX_OPTION_PLUGINS = 16;

export interface PersistedTerminalSession {
  /** Host-only launch history; missing evidence on a legacy placed card is conservatively unknown. */
  isolatedEnvironmentScopes?: {roots:string[];ambiguous:boolean};
  taskScope?:{id:string;cwd:string;startedAt:number};
  id: string;
  provider: ProviderId;
  profile: LaunchProfileId;
  /** Records written before roles existed restore as ordinary agents. */
  role: SessionRole;
  title: string;
  titleCustomized: boolean;
  cwd: string;
  position: Point;
  size: Size;
  parentSessionId?: string;
  /** The provider's own conversation id, learned from a lifecycle hook or selected in local history. */
  threadId?: string;
  /** State at quit or at the moment the process exited; v1 records read as "running". */
  lastState: PersistedLastState;
  exitCode?: number | null;
  /** False when the person chose "Don't restore this card". */
  restore: boolean;
  /** Plugin launch options keyed by plugin id, each opaque and at most 4 KB. */
  options?: Record<string, unknown>;
  /** Where the session runs when a plugin placed it; opaque to core, at most 4 KB. */
  environment?: PersistedEnvironmentRef;
  /**
   * The launcher's environment choice while its plugin has not prepared it (pending, or prepare failed). A card
   * with it never restores as a local one: it comes back held, and Restart prepares with these options.
   */
  environmentChoice?: SessionEnvironmentChoice;
  /** The plugin that started the card (EP-4 `sessions.create`); it keeps control after a restore. */
  ownerPluginId?: string;
  /** The model and reasoning effort its launches ask the CLI for (launchModel.ts). */
  model?: string;
  effort?: ReasoningEffort;
  reviewRequested?: boolean;
  /** An isolated session ran since then and its repositories were not audited yet, or a report is still open. */
  gitAuditSince?: number;
}

export type PersistedLastState = "running" | "exited" | "failed";

export interface PersistedEnvironmentRef {
  pluginId: string;
  kind: string;
  ref: unknown;
  label: string;
}

interface PersistedTerminalSessionState {
  version: typeof TERMINAL_SESSION_STORE_VERSION;
  sessions: PersistedTerminalSession[];
}

const EMPTY_STATE: PersistedTerminalSessionState = {
  version: TERMINAL_SESSION_STORE_VERSION,
  sessions: []
};

/**
 * Why the saved cards could not be read. `newer`: a later CanvasTTY wrote the file; `unreadable`: it could not be
 * read at all (permissions, I/O). Both leave the file as it is: nothing is written over it for the rest of this
 * run. `corrupt`: it is not a card list; it was kept beside the file (`backupPath`) and a fresh file is used.
 */
export type SessionStoreProblem =
  | { kind: "newer" | "unreadable"; backupPath: null }
  | { kind: "corrupt"; backupPath: string | null };

/** How the store replaces its file; tests pass a rename that fails the way Windows does. */
export interface SessionStoreFileOptions {
  rename?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

// Windows refuses to replace a file another handle has open (a reader, an indexer, antivirus) with EPERM, EACCES or
// EBUSY; the handle goes away within moments. Retrying for about a second keeps a save from being dropped.
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 400];

export async function replaceFile(
  from: string,
  to: string,
  { rename: move = rename, platform = process.platform }: SessionStoreFileOptions = {}
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (platform !== "win32" || !code || !WINDOWS_TRANSIENT_RENAME_CODES.has(code) || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export class TerminalSessionStore {
  readonly filePath: string;
  private value: PersistedTerminalSessionState = structuredClone(EMPTY_STATE);
  private writeQueue = Promise.resolve();
  private problem: SessionStoreProblem | null = null;
  private readonly fileOptions: SessionStoreFileOptions;

  constructor(userDataPath: string, fileName = "terminal-sessions.json", fileOptions: SessionStoreFileOptions = {}) {
    this.filePath = join(userDataPath, fileName);
    this.fileOptions = fileOptions;
  }

  /** What went wrong reading the saved cards at load(), or null. */
  get loadProblem(): SessionStoreProblem | null {
    return this.problem ? { ...this.problem } : null;
  }

  async load(): Promise<PersistedTerminalSession[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) {
        this.problem = { kind: "unreadable", backupPath: null };
        console.warn("CanvasTTY terminal window state could not be read; it is left as it is and not saved over this run.", error);
      }
      return this.get();
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { parsed = undefined; }
    const version = parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
    if (typeof version === "number" && Number.isInteger(version) && version > TERMINAL_SESSION_STORE_VERSION) {
      // A later CanvasTTY's cards: this build cannot read them and must not replace them with its own.
      this.problem = { kind: "newer", backupPath: null };
      console.warn(`CanvasTTY terminal window state was written by a newer version (${version}); it is left as it is and not saved over this run.`);
      return this.get();
    }
    if (!isReadableState(parsed)) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        await rename(this.filePath, backupPath);
        this.problem = { kind: "corrupt", backupPath };
        console.warn(`CanvasTTY terminal window state could not be parsed; it was kept as ${backupPath} and an empty state is used.`);
      } catch (error) {
        // Not even set aside: leave it alone instead of writing over it.
        this.problem = { kind: "unreadable", backupPath: null };
        console.warn("CanvasTTY terminal window state could not be parsed or set aside; it is left as it is.", error);
      }
      return this.get();
    }
    this.value = normalizePersistedTerminalSessions(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(this.value)) await this.persist();
    return this.get();
  }

  get(): PersistedTerminalSession[] {
    return structuredClone(this.value.sessions);
  }

  async replace(sessions: readonly PersistedTerminalSession[]): Promise<void> {
    this.value = normalizePersistedTerminalSessions({
      version: TERMINAL_SESSION_STORE_VERSION,
      sessions
    });
    await this.persist();
  }

  clear(): Promise<void> {
    return this.replace([]);
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): Promise<void> {
    // The file on disk is one this build could not read: keep it (the cards of this run live in memory only).
    if (this.problem && this.problem.kind !== "corrupt") return this.writeQueue;
    const snapshot = `${JSON.stringify(this.value, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
        await replaceFile(temporaryPath, this.filePath, this.fileOptions);
      } catch (error) {
        // A rename that still fails (a file locked for longer on Windows) must not leave the temp file behind.
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    return this.writeQueue;
  }
}

function normalizeStoredThreadId(provider: ProviderId, candidate: unknown): string | undefined {
  return typeof candidate === "string" ? normalizeThreadId(provider, candidate.trim()) : undefined;
}

/** What core keeps beside the live metadata: nothing here is scrollback, prompts or secrets. */
export type PersistedSessionExtras = Pick<PersistedTerminalSession, "options" | "environment" | "environmentChoice" | "ownerPluginId" | "gitAuditSince" | "isolatedEnvironmentScopes"> & {
  /** Overrides the derived state while a card is held stopped (its environment is unavailable). */
  heldState?: PersistedLastState;
};

export function persistedTerminalSession(
  metadata: SessionMetadata,
  threadId?: unknown,
  extras: PersistedSessionExtras = {}
): PersistedTerminalSession {
  const normalizedThreadId = normalizeStoredThreadId(metadata.provider, threadId);
  const lastState: PersistedLastState = extras.heldState
    ?? (metadata.exitCode === null ? "running" : metadata.exitCode === 0 ? "exited" : "failed");
  return {
    id: metadata.id,
    provider: metadata.provider,
    profile: metadata.profile,
    role: metadata.role,
    title: metadata.title,
    titleCustomized: metadata.titleCustomized,
    cwd: metadata.cwd,
    position: { ...metadata.position },
    size: { ...metadata.size },
    ...(metadata.parentSessionId !== undefined ? { parentSessionId: metadata.parentSessionId } : {}),
    ...(metadata.taskScope ? {taskScope:{...metadata.taskScope}} : {}),
    ...(normalizedThreadId !== undefined ? { threadId: normalizedThreadId } : {}),
    lastState,
    ...(lastState !== "running" ? { exitCode: metadata.exitCode } : {}),
    restore: metadata.skipRestore !== true,
    ...(extras.isolatedEnvironmentScopes ? {isolatedEnvironmentScopes:structuredClone(extras.isolatedEnvironmentScopes)} : {}),
    ...(extras.options ? { options: structuredClone(extras.options) } : {}),
    ...(extras.environment ? { environment: structuredClone(extras.environment) } : {}),
    ...(extras.environmentChoice && !extras.environment ? { environmentChoice: structuredClone(extras.environmentChoice) } : {}),
    ...(extras.ownerPluginId ? { ownerPluginId: extras.ownerPluginId } : {}),
    ...(extras.gitAuditSince !== undefined ? { gitAuditSince: extras.gitAuditSince } : {}),
    ...(metadata.model !== undefined ? { model: metadata.model } : {}),
    ...(metadata.effort !== undefined ? { effort: metadata.effort } : {}),
    ...(metadata.reviewRequested !== undefined ? { reviewRequested: metadata.reviewRequested } : {})
  };
}

/** Invalid or pre-evidence environment records must never silently regain local restoration authority. */
function normalizeIsolationEvidence(value:unknown,placed:boolean):PersistedTerminalSession["isolatedEnvironmentScopes"] {
  if(value===undefined)return placed ? {roots:[],ambiguous:true} : undefined;
  const invalid={roots:[],ambiguous:true};
  if(!value || typeof value!=="object" || Array.isArray(value))return invalid;
  const evidence=value as {roots?:unknown;ambiguous?:unknown};
  if(Object.keys(value).some(key=>key!=="roots" && key!=="ambiguous") || typeof evidence.ambiguous!=="boolean" || !Array.isArray(evidence.roots) || evidence.roots.length>32)return invalid;
  if(evidence.roots.some(root=>typeof root!=="string" || root.length===0 || root.length>4096 || root.includes("\0") || !isAbsolute(root) || normalize(root)!==root))return invalid;
  return {roots:[...new Set(evidence.roots as string[])],ambiguous:evidence.ambiguous};
}

export function normalizePersistedTerminalSessions(candidate: unknown): PersistedTerminalSessionState {
  if (!candidate || typeof candidate !== "object") return structuredClone(EMPTY_STATE);
  const source = candidate as { version?: unknown; sessions?: unknown };
  // v1 is read-compatible: missing v2 fields mean unknown conversation, no environment, running.
  if ((source.version !== 1 && source.version !== TERMINAL_SESSION_STORE_VERSION) || !Array.isArray(source.sessions)) {
    return structuredClone(EMPTY_STATE);
  }

  const sessions: PersistedTerminalSession[] = [];
  const ids = new Set<string>();
  for (const value of source.sessions.slice(0, MAX_PERSISTED_SESSIONS * 4)) {
    if (sessions.length >= MAX_PERSISTED_SESSIONS) {
      console.warn(`CanvasTTY saves at most ${MAX_PERSISTED_SESSIONS} terminal windows; the rest are not restored.`);
      break;
    }
    if (!value || typeof value !== "object") continue;
    // codexThreadId: the v1 name of threadId (Codex only).
    const session = value as Partial<PersistedTerminalSession> & { codexThreadId?: unknown };
    if (!isSessionId(session.id) || ids.has(session.id)) continue;
    if (!isProviderId(session.provider)) continue;
    if (!isLaunchProfile(session.profile)) continue;
    if (typeof session.title !== "string" || session.title.trim().length === 0) continue;
    if (typeof session.titleCustomized !== "boolean") continue;
    if (typeof session.cwd !== "string" || session.cwd.length === 0 || session.cwd.length > 4_096) continue;
    if (!isFinitePoint(session.position) || !isFiniteSize(session.size)) continue;
    const rawRole: unknown = session.role;
    const roleKnown = rawRole === undefined || rawRole === "agent" || rawRole === "interactive"
      || rawRole === "orchestrator" || rawRole === "subagent";
    if (!roleKnown) continue;
    const role: SessionRole = rawRole === "orchestrator" || rawRole === "subagent" ? rawRole : "agent";
    const parentSessionId = typeof session.parentSessionId === "string"
      ? session.parentSessionId
      : undefined;
    if (session.parentSessionId !== undefined && parentSessionId === undefined) continue;
    if (role === "subagent" && parentSessionId === undefined) continue;
    // A damaged or obsolete conversation ID must not make the whole card disappear.
    // It can still restore with Codex's interactive resume picker.
    const threadId = normalizeStoredThreadId(
      session.provider as ProviderId,
      session.threadId ?? (session.provider === "codex" ? session.codexThreadId : undefined)
    );
    const lastState: PersistedLastState = session.lastState === "exited" || session.lastState === "failed"
      ? session.lastState
      : "running";
    const exitCode = Number.isInteger(session.exitCode) ? session.exitCode as number : null;
    const options = normalizeOptions(session.options);
    const environment = normalizeEnvironment(session.environment);
    // A placed session whose ref is unreadable must not come back as a local one.
    if (session.environment !== undefined && !environment) continue;
    // Likewise a launch whose environment was chosen but not prepared yet.
    const environmentChoice = environment ? undefined : normalizeEnvironmentChoice(session.environmentChoice);
    if (!environment && session.environmentChoice !== undefined && !environmentChoice) continue;
    const isolation=normalizeIsolationEvidence(session.isolatedEnvironmentScopes,Boolean(environment));
    sessions.push({
      id: session.id,
      provider: session.provider as ProviderId,
      profile: session.profile,
      role: session.provider === "terminal" ? "agent" : role,
      title: session.title.trim().slice(0, 80),
      titleCustomized: session.titleCustomized,
      cwd: session.cwd,
      position: { ...session.position },
      size: {
        width: clamp(session.size.width, 420, 1_600),
        height: clamp(session.size.height, 260, 1_100)
      },
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(isTaskScope(session.taskScope) ? {taskScope:{...session.taskScope}} : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      lastState,
      ...(lastState !== "running" ? { exitCode } : {}),
      restore: session.restore !== false,
      ...(options ? { options } : {}),
      ...(environment ? { environment } : {}),
      ...(isolation ? {isolatedEnvironmentScopes:isolation} : {}),
      ...(environmentChoice ? { environmentChoice } : {}),
      ...(isPluginId(session.ownerPluginId) ? { ownerPluginId: session.ownerPluginId } : {}),
      ...(typeof session.gitAuditSince === "number" && Number.isFinite(session.gitAuditSince) && session.gitAuditSince > 0
        ? { gitAuditSince: session.gitAuditSince } : {}),
      // A model or effort this CLI would not take is dropped: the card restores on the CLI's default.
      ...(session.provider !== "terminal" && session.model !== undefined && launchModelProblem(session.provider as ProviderId, session.model) === null
        ? { model: session.model } : {}),
      ...(session.provider !== "terminal" && session.effort !== undefined && launchEffortProblem(session.provider as ProviderId, session.effort) === null
        ? { effort: session.effort } : {}),
      ...(typeof session.reviewRequested === "boolean" ? { reviewRequested: session.reviewRequested } : {})
    });
    ids.add(session.id);
  }
  return { version: TERMINAL_SESSION_STORE_VERSION, sessions };
}

function normalizeOptions(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const options: Record<string, unknown> = {};
  for (const [pluginId, entry] of Object.entries(value).slice(0, MAX_OPTION_PLUGINS)) {
    if (!isPluginId(pluginId) || !fitsPluginSlot(entry)) continue;
    options[pluginId] = structuredClone(entry);
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function normalizeEnvironment(value: unknown): PersistedEnvironmentRef | undefined {
  if (!isRecord(value) || !isPluginId(value.pluginId)) return undefined;
  if (typeof value.kind !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.kind)) return undefined;
  if (typeof value.label !== "string" || value.label.trim().length === 0) return undefined;
  if (value.ref === undefined || !fitsPluginSlot(value.ref)) return undefined;
  return {
    pluginId: value.pluginId,
    kind: value.kind,
    ref: structuredClone(value.ref),
    label: value.label.trim().slice(0, 80)
  };
}

function normalizeEnvironmentChoice(value: unknown): SessionEnvironmentChoice | undefined {
  if (!isRecord(value) || !isPluginId(value.pluginId) || !fitsPluginSlot(value)) return undefined;
  if (typeof value.kind !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.kind)) return undefined;
  if (value.options !== undefined && (!isRecord(value.options)
    || Object.values(value.options).some((option) => typeof option !== "boolean" && typeof option !== "string"))) return undefined;
  return {
    pluginId: value.pluginId,
    kind: value.kind,
    ...(value.options !== undefined ? { options: structuredClone(value.options) as Record<string, boolean | string> } : {})
  };
}

/** Same shape PluginManager accepts for plugin ids. */
function isPluginId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 80
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && !value.includes("..");
}

function fitsPluginSlot(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && Buffer.byteLength(json, "utf8") <= MAX_PLUGIN_SLOT_BYTES;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(value);
}

function isFinitePoint(value: unknown): value is Point {
  return Boolean(value && typeof value === "object"
    && "x" in value && "y" in value
    && Number.isFinite(value.x) && Number.isFinite(value.y));
}

function isFiniteSize(value: unknown): value is Size {
  return Boolean(value && typeof value === "object"
    && "width" in value && "height" in value
    && Number.isFinite(value.width) && Number.isFinite(value.height));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A v1 or v2 card list (its records are checked one by one when normalized). */
function isReadableState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as { version?: unknown; sessions?: unknown };
  return (state.version === 1 || state.version === TERMINAL_SESSION_STORE_VERSION) && Array.isArray(state.sessions);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isTaskScope(value:unknown):value is {id:string;cwd:string;startedAt:number} {
  return isRecord(value) && typeof value.id==="string" && /^[\w-]{1,160}$/.test(value.id) && typeof value.cwd==="string" && value.cwd.length>0 && value.cwd.length<=4096 && typeof value.startedAt==="number" && Number.isFinite(value.startedAt) && value.startedAt>0;
}
