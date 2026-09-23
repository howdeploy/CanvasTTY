import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type {
  LaunchProfileId,
  SessionRole,
  Point,
  ProviderId,
  SessionMetadata,
  Size
} from "../../shared/contracts.ts";

export const TERMINAL_SESSION_STORE_VERSION = 1;
const MAX_PERSISTED_SESSIONS = 64;
const PROVIDERS = new Set<ProviderId>([
  "terminal",
  "codex",
  "claude",
  "qwen",
  "kimi",
  "opencode",
  "hermes",
  "grok",
  "omp",
  "pi",
  "cursor",
  "minimax",
  "devin",
  "antigravity"
]);

export interface PersistedTerminalSession {
  id: string;
  provider: ProviderId;
  profile: LaunchProfileId;
  title: string;
  titleCustomized: boolean;
  cwd: string;
  position: Point;
  size: Size;
  role?: SessionRole;
  parentSessionId?: string;
  /** Remote host for shell sessions; same id space as AppSettings.remoteHosts. */
  hostId?: string;
  /** Provider account chosen by spawn routing; same id space as
   *  AppSettings.providerAccounts. Bookkeeping only. */
  accountId?: string;
}

interface PersistedTerminalSessionState {
  version: typeof TERMINAL_SESSION_STORE_VERSION;
  sessions: PersistedTerminalSession[];
}

const EMPTY_STATE: PersistedTerminalSessionState = {
  version: TERMINAL_SESSION_STORE_VERSION,
  sessions: []
};

export class TerminalSessionStore {
  readonly filePath: string;
  private value: PersistedTerminalSessionState = structuredClone(EMPTY_STATE);
  private writeQueue = Promise.resolve();

  constructor(userDataPath: string, fileName = "terminal-sessions.json") {
    this.filePath = join(userDataPath, fileName);
  }

  async load(): Promise<PersistedTerminalSession[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.value = normalizePersistedTerminalSessions(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(this.value)) await this.persist();
    } catch (error) {
      if (!isMissingFile(error)) {
        console.warn("CanvasTTY terminal window state could not be loaded; an empty state is used.", error);
      }
    }
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
    const snapshot = `${JSON.stringify(this.value, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}

export function persistedTerminalSession(metadata: SessionMetadata): PersistedTerminalSession {
  return {
    id: metadata.id,
    provider: metadata.provider,
    profile: metadata.profile,
    title: metadata.title,
    titleCustomized: metadata.titleCustomized,
    cwd: metadata.cwd,
    position: { ...metadata.position },
    size: { ...metadata.size },
    ...(metadata.role !== "interactive" || metadata.parentSessionId !== undefined
      ? {
        role: metadata.role,
        ...(metadata.parentSessionId !== undefined ? { parentSessionId: metadata.parentSessionId } : {})
      }
      : {}),
    ...(metadata.hostId !== undefined ? { hostId: metadata.hostId } : {}),
    ...(metadata.accountId !== undefined ? { accountId: metadata.accountId } : {})
  };
}

export function normalizePersistedTerminalSessions(candidate: unknown): PersistedTerminalSessionState {
  if (!candidate || typeof candidate !== "object") return structuredClone(EMPTY_STATE);
  const source = candidate as Partial<PersistedTerminalSessionState>;
  if (source.version !== TERMINAL_SESSION_STORE_VERSION || !Array.isArray(source.sessions)) {
    return structuredClone(EMPTY_STATE);
  }

  const sessions: PersistedTerminalSession[] = [];
  const ids = new Set<string>();
  for (const value of source.sessions.slice(0, MAX_PERSISTED_SESSIONS)) {
    if (!value || typeof value !== "object") continue;
    const session = value as Partial<PersistedTerminalSession>;
    if (!isSessionId(session.id) || ids.has(session.id)) continue;
    if (!PROVIDERS.has(session.provider as ProviderId)) continue;
    if (session.profile !== "normal" && session.profile !== "yolo") continue;
    if (typeof session.title !== "string" || session.title.trim().length === 0) continue;
    if (typeof session.titleCustomized !== "boolean") continue;
    if (typeof session.cwd !== "string" || session.cwd.length === 0 || session.cwd.length > 4_096) continue;
    if (!isFinitePoint(session.position) || !isFiniteSize(session.size)) continue;
    const roleKnown = session.role === undefined
      || session.role === "interactive"
      || session.role === "orchestrator"
      || session.role === "subagent";
    if (!roleKnown) continue;
    const role = session.role;
    const parentSessionId = typeof session.parentSessionId === "string"
      ? session.parentSessionId
      : undefined;
    if (session.parentSessionId !== undefined && parentSessionId === undefined) continue;
    if (role === "subagent" && parentSessionId === undefined) continue;
    // hostId follows the same drop-invalid discipline as parentSessionId: a
    // non-empty string of at most 64 characters (the RemoteHost id schema in
    // shared/contracts) or the whole entry disappears rather than silently
    // re-aiming the session at another machine.
    const hostId = typeof session.hostId === "string" && session.hostId.length > 0 && session.hostId.length <= 64
      ? session.hostId
      : undefined;
    if (session.hostId !== undefined && hostId === undefined) continue;
    // accountId follows the same drop-invalid discipline as hostId: a
    // non-empty string of at most 64 characters (the ProviderAccount id
    // schema) or the whole entry disappears rather than silently crediting
    // the session to another subscription.
    const accountId = typeof session.accountId === "string" && session.accountId.length > 0 && session.accountId.length <= 64
      ? session.accountId
      : undefined;
    if (session.accountId !== undefined && accountId === undefined) continue;
    sessions.push({
      id: session.id,
      provider: session.provider as ProviderId,
      profile: session.profile,
      title: session.title.trim().slice(0, 80),
      titleCustomized: session.titleCustomized,
      cwd: session.cwd,
      position: { ...session.position },
      size: {
        width: clamp(session.size.width, 420, 1_600),
        height: clamp(session.size.height, 260, 1_100)
      },
      ...(role !== undefined ? { role } : {}),
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(hostId !== undefined ? { hostId } : {}),
      ...(accountId !== undefined ? { accountId } : {})
    });
    ids.add(session.id);
  }
  return { version: TERMINAL_SESSION_STORE_VERSION, sessions };
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

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
