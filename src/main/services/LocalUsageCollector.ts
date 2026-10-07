import { execFile, type ExecFileOptions } from 'node:child_process';
import { constants, type Dirent } from 'node:fs';
import { access, open, readdir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises';
import { devNull, homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { UsageEvent } from '../../shared/usageHistory.ts';
import {
  claudeFlush, claudeUsage, codexUsage, fingerprint, identifier, record, tokens,
  type ClaudeFileState, type CodexFileState, type LogContext,
} from './usageReaders.ts';

const execute = promisify(execFile);

/** Resolve only absolute PATH entries: never execute a same-named file in the working directory. */
export async function discoverSqlite(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  executable: (path: string) => Promise<boolean> = async path => {
    try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
  },
): Promise<string | null> {
  const paths = platform === 'win32' ? win32 : posix;
  const key = platform === 'win32' ? Object.keys(environment).find(name => name.toUpperCase() === 'PATH') : 'PATH';
  for (const directory of (key ? environment[key] ?? '' : '').split(paths.delimiter)) {
    if (!paths.isAbsolute(directory)) continue;
    // A root-relative Windows path still depends on the current drive.
    if (platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(directory)) continue;
    const candidate = paths.join(directory, platform === 'win32' ? 'sqlite3.exe' : 'sqlite3');
    if (await executable(candidate)) return candidate;
  }
  return null;
}

const VERSION = 2;
const RETENTION = 30 * 86_400_000;
const CLOCK_SKEW = 60_000;
/** Claude Code may still append streamed entries of the newest message until its transcript idles. */
const SETTLE = 5 * 60_000;
const MAX_LINE = 16 * 1024 * 1024;
const CHUNK = 256 * 1024;
const HEAD = 256;
const MAX_DEPTH = 8;
const BYTE_BUDGET = 128 * 1024 * 1024;

type Source = 'codex' | 'claude';
interface FileCursor {
  /** `${dev}:${ino}`; together with the head fingerprint it detects replaced or truncated files. */
  node: string;
  head: string;
  headLength: number;
  /** Bytes examined (the file size once read to its end) and mtime at that time. */
  size: number;
  mtime: number;
  /** Byte offset after the last consumed newline. */
  offset: number;
  seen: number;
  /** Inside a line longer than MAX_LINE, discarded up to its newline. */
  skip?: boolean;
  codex?: CodexFileState;
  claude?: ClaudeFileState;
}
/** [input, output, cached, observedAt, changedAt] of one Hermes accounting row. */
type HermesBaseline = [number, number, number, number, number];
interface HermesDatabase { node: string; at: number; rows: Record<string, HermesBaseline> }
/** Serializable collector state: persist `collector.state` after the events of a collection are stored. */
export interface CollectorState {
  version?: number;
  files?: Record<string, FileCursor>;
  hermes?: Record<string, HermesDatabase>;
}
export interface CollectorOptions {
  sqlite?: string;
  /** Executable discovery is separate from the environment selecting source homes. */
  sqliteEnvironment?: NodeJS.ProcessEnv;
  sqliteRunner?: (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string }>;
  /** Maximum bytes of log backlog read per collection; the rest continues on the next one. */
  byteBudget?: number;
}
type Clean = Required<CollectorState>;
/**
 * `complete`: every discovered source was read to its end; absent default roots are normal.
 * `lost`: this run consumed accounting it could not use (unparsable or oversized lines, active
 * counters baselined without history), which no later run recovers. A lossy run is incomplete.
 */
interface Health { complete: boolean; lost: boolean }
interface Collection extends Health { events: UsageEvent[]; coverage: string[] }
interface Root { source: Source; path: string; label: string; profile: string }
interface LogFile { root: Root; path: string; key: string; node: string; size: number; mtime: number }
interface RootStats { files: number; read: number; bytes: number; invalid: number; oversized: number; unreadable: number; external: number; deep: number; problem: string }
interface HermesCandidate { database: string; total: number; events: UsageEvent[] }

class SourceProblem extends Error {}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hex = (value: string): boolean => /^[0-9a-f]{24}$/.test(value);
const label = (name: string): string => name.replace(/[^\w.@+-]/g, '_').slice(0, 64) || 'unnamed';
const errno = (error: unknown): string => String((error as NodeJS.ErrnoException)?.code ?? '');
const text = (value: unknown): string => String(value ?? '');
/** Hermes stores epoch seconds as REAL. */
const milliseconds = (value: unknown): number | null => finite(value) && value > 0 ? Math.ceil(value * 1000) : null;

function codexState(value: unknown): CodexFileState | undefined {
  const v = record(value), state: CodexFileState = {};
  if (typeof v.session === 'string') state.session = v.session;
  if (typeof v.app === 'string') state.app = v.app;
  if (typeof v.external === 'string') state.external = v.external;
  if (Array.isArray(v.total) && v.total.length === 3 && v.total.every(counter)) state.total = v.total as CodexFileState['total'];
  if (finite(v.copyUntil)) state.copyUntil = v.copyUntil;
  return Object.keys(state).length ? state : undefined;
}
function claudeState(value: unknown): ClaudeFileState | undefined {
  const p = record(record(value).pending), usage = p.usage;
  if (!identifier(p.id) || typeof p.session !== 'string' || !finite(p.from) || !finite(p.to)) return undefined;
  if (!Array.isArray(usage) || usage.length !== 4 || !usage.every(counter)) return undefined;
  return { pending: { id: p.id as string, session: p.session, from: p.from, to: p.to, usage: usage as [number, number, number, number] } };
}
/** Persisted state comes from disk: anything malformed is dropped, which only causes a rebaseline or re-read. */
export function sanitizeCollectorState(input: unknown): Clean {
  const state = record(input), clean: Clean = { version: VERSION, files: {}, hermes: {} };
  if (Object.keys(state).length && state.version !== VERSION) throw new Error("Unsupported usage collector version");
  for (const [key, value] of Object.entries(record(state.files))) {
    const c = record(value);
    if (!hex(key) || typeof c.node !== 'string' || typeof c.head !== 'string' || ![c.headLength, c.size, c.offset].every(counter)) continue;
    if (![c.mtime, c.seen].every(finite) || (c.offset as number) > (c.size as number)) continue;
    const cursor: FileCursor = { node: c.node, head: c.head, headLength: c.headLength as number, size: c.size as number,
      mtime: c.mtime as number, offset: c.offset as number, seen: c.seen as number };
    if (c.skip === true) cursor.skip = true;
    const codex = codexState(c.codex), claude = claudeState(c.claude);
    if (codex) cursor.codex = codex;
    if (claude) cursor.claude = claude;
    clean.files[key] = cursor;
  }
  for (const [key, value] of Object.entries(record(state.hermes))) {
    const d = record(value), rows: Record<string, HermesBaseline> = {};
    if (!hex(key) || typeof d.node !== 'string' || !finite(d.at)) continue;
    for (const [row, baseline] of Object.entries(record(d.rows))) {
      if (hex(row) && Array.isArray(baseline) && baseline.length === 5 && baseline.slice(0, 3).every(counter) && baseline.slice(3).every(finite)) {
        rows[row] = baseline as HermesBaseline;
      }
    }
    clean.hermes[key] = { node: d.node, at: d.at, rows };
  }
  return clean;
}

async function sideFile(path: string): Promise<number | null> {
  try { return (await stat(path)).size; } catch { return null; }
}
function sqliteProblem(error: unknown): string {
  if (error instanceof SourceProblem) return error.message;
  const e = error as NodeJS.ErrnoException & { stderr?: unknown; killed?: boolean };
  if (e.code === 'ENOENT') return 'sqlite3 is unavailable';
  if (e.killed) return 'read timed out';
  const text = String(e.stderr || e.message || '');
  // Older CLIs must fail closed: static SELECTs alone do not replace safe-mode protections.
  if (/(?:unknown|unrecognized|unsupported) option[^\n]*-safe\b/i.test(text)) return 'sqlite3 lacks required -safe support; install a newer SQLite CLI';
  if (/not a database|malformed|corrupt/i.test(text)) return 'database is corrupt or not SQLite';
  if (/locked|busy/i.test(text)) return 'database is busy';
  if (/no such (table|column)/i.test(text)) return 'unsupported accounting schema';
  if (/unable to open/i.test(text)) return 'database cannot be opened read-only';
  return 'read failed';
}
function hermesProvider(route: unknown): string {
  // Only the ChatGPT-subscription Codex route is unambiguous; anthropic can be an API key or a
  // subscription login, and other routes are not tracked quotas.
  return String(route ?? '').trim().toLowerCase() === 'openai-codex' ? 'codex' : 'unknown';
}
function sessionFromName(path: string): string {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1] ?? `file-${fingerprint(path).slice(0, 12)}`;
}
async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Collects token accounting of external agents from their local stores, strictly read-only:
 * logs are opened O_RDONLY and SQLite through a PATH-resolved executable in safe, read-only
 * mode that never creates a database or its -wal/-shm files. Only accounting fields leave here.
 */
export class LocalUsageCollector {
  readonly state: CollectorState;
  private readonly home: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly sqlitePath: string | undefined;
  private readonly sqliteEnvironment: NodeJS.ProcessEnv;
  private readonly sqliteRunner: NonNullable<CollectorOptions['sqliteRunner']>;
  private readonly byteBudget: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(home = homedir(), state: CollectorState = {}, environment: NodeJS.ProcessEnv = process.env, options: CollectorOptions = {}) {
    this.home = home;
    this.environment = environment;
    this.sqlitePath = options.sqlite;
    this.sqliteEnvironment = options.sqliteEnvironment ?? process.env;
    this.sqliteRunner = options.sqliteRunner ?? (async (file, args, options) => {
      const result = await execute(file, args, { ...options, encoding: 'utf8' });
      return { stdout: result.stdout };
    });
    this.byteBudget = options.byteBudget ?? BYTE_BUDGET;
    const clean = sanitizeCollectorState(state);
    for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key];
    this.state = Object.assign(state, clean);
  }

  /** Overlapping calls are serialized; state is committed only when a collection completes. */
  collect(now = Date.now()): Promise<Collection> {
    const run = this.queue.then(() => this.collectOnce(now));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async collectOnce(now: number): Promise<Collection> {
    const next: Clean = { version: VERSION, files: {}, hermes: {} };
    const events = new Map<string, UsageEvent>(), coverage: string[] = [], health: Health = { complete: true, lost: false };
    const add = (event: UsageEvent): void => {
      if (event.to < now - RETENTION) return;
      // Its source position is already consumed: a record dropped here is never read again.
      if (event.to > now + CLOCK_SKEW || event.from > event.to) { health.complete = false; health.lost = true; return; }
      const known = events.get(event.id);
      if (!known || event.input + event.output > known.input + known.output) events.set(event.id, event);
    };
    await this.collectHermes(now, next, add, coverage, health);
    await this.collectLogs(now, next, add, coverage, health);
    coverage.push(
      'Sources: Hermes state.db in the default home, every profiles/<name> (symlinks followed) and HERMES_HOME; Codex rollouts in ~/.codex and CODEX_HOME (sessions, archived_sessions); Claude Code transcripts in ~/.claude, ~/.config/claude and CLAUDE_CONFIG_DIR. Not covered: other OS users, undiscovered custom homes, other devices, web and desktop chat apps, and tools that keep no local log. This is not a complete record of usage on this device.',
      'Hermes: cumulative counters are baselined the first time a database is observed (no retrospective allocation); later increases are poll-delta intervals. Per-model rows are used; a session aggregate only for sessions without per-model rows, never both. Only the openai-codex route is attributed to codex; other routes (anthropic API key vs subscription is not recorded) are provider unknown.',
      'Logs: last 30 days, accounting fields only. Codex cumulative counters are differenced (cached is part of input, reasoning part of output) and identified per session lineage; Claude messages are deduplicated by API message id, including persisted print-mode (claude -p) sessions, which are attributed to Claude Code whatever launched them. The account or plan a log was billed to is not verified.',
    );
    this.state.version = VERSION;
    this.state.files = next.files;
    this.state.hermes = next.hermes;
    return { events: [...events.values()].sort((a, b) => a.to - b.to || (a.id < b.id ? -1 : 1)), coverage, ...health };
  }

  private directory(name: string): string | null {
    const value = this.environment[name]?.trim();
    return value && isAbsolute(value) ? resolve(value) : null;
  }

  private async hermesHomes(): Promise<{ path: string; label: string }[]> {
    const fallback = join(this.home, '.hermes'), env = this.directory('HERMES_HOME');
    const roots = [fallback];
    if (env) roots.push(...(basename(dirname(env)) === 'profiles' ? [dirname(dirname(env)), env] : [env]));
    const homes: { path: string; label: string }[] = [];
    for (const root of new Set(roots)) {
      homes.push({ path: root, label: root === fallback || basename(root) === '.hermes' ? 'default' : label(basename(root)) });
      let entries: Dirent[];
      try { entries = await readdir(join(root, 'profiles'), { withFileTypes: true }); } catch { continue; }
      // A symlink to a sibling profile is an alias: the profile it names keeps the attribution.
      const primary: { path: string; label: string }[] = [], aliases: { path: string; label: string }[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
        const path = join(root, 'profiles', entry.name);
        let alias = false;
        if (entry.isSymbolicLink()) {
          try { alias = dirname(resolve(dirname(path), await readlink(path))) === join(root, 'profiles'); } catch { /* Reported on access. */ }
        }
        (alias ? aliases : primary).push({ path, label: label(entry.name) });
      }
      homes.push(...primary, ...aliases);
    }
    return homes;
  }

  private async collectHermes(now: number, next: Clean, add: (event: UsageEvent) => void, coverage: string[], health: Health): Promise<void> {
    const databases = new Map<string, string>();
    for (const home of await this.hermesHomes()) {
      try {
        const real = await realpath(join(home.path, 'state.db'));
        if ((await stat(real)).isFile() && !databases.has(real)) databases.set(real, home.label);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(errno(error))) {
          health.complete = false;
          coverage.push(`Hermes ${home.label}: state.db not accessible (${errno(error) || 'error'}).`);
        }
      }
    }
    if (!databases.size) coverage.push('Hermes: no state.db found.');
    const candidates = new Map<string, HermesCandidate[]>(), locations = new Map<string, Set<string>>();
    for (const [database, profile] of databases) {
      const key = fingerprint(database);
      try {
        const node = await stat(database, { bigint: true }).then(s => `${s.dev}:${s.ino}`);
        const known = this.state.hermes![key];
        const previous = known?.node === node ? known : undefined;
        const { rows, residual } = await this.hermesRows(database);
        const baselines: Record<string, HermesBaseline> = {}, bySession = new Map<string, UsageEvent[]>();
        let perModel = 0, aggregates = 0, invalid = 0;
        for (const row of rows) {
          const kind = row.k, id = row.id;
          if ((kind !== 'm' && kind !== 's') || typeof id !== 'string' || !id) { invalid++; continue; }
          const rowKey = fingerprint(JSON.stringify(kind === 'm' ? ['m', id, text(row.model), text(row.provider), text(row.url), text(row.mode), text(row.task)] : ['s', id]));
          const counters = [row.i, row.o, row.cr, row.cw].map(tokens);
          const old = previous?.rows[rowKey];
          if (counters.some(value => value === null)) {
            invalid++;
            if (old) baselines[rowKey] = old;
            continue;
          }
          if (kind === 'm') perModel++; else aggregates++;
          if (!locations.has(id)) locations.set(id, new Set());
          locations.get(id)!.add(key);
          const [input, output, read, write] = counters as number[];
          const value: [number, number, number] = [input + read + write, output, read];
          const created = milliseconds(row.fs), changed = milliseconds(row.ls);
          // A row created after the previous observation holds only usage from that interval.
          const base: HermesBaseline | undefined = old
            ?? (previous && created !== null && created > previous.at ? [0, 0, 0, previous.at, previous.at] : undefined);
          const active = (changed ?? now) >= now - RETENTION;
          if (kind === 's' || active) baselines[rowKey] = [...value, now, changed ?? now];
          if (!base || value.some((v, index) => v < base[index])) {
            // Usage of an active row up to its new baseline is never counted.
            if (active && value.some(v => v > 0)) { health.complete = false; health.lost = true; }
            continue;
          }
          const [dInput, dOutput, dCached] = value.map((v, index) => v - base[index]);
          if (!dInput && !dOutput) continue;
          const from = base[3], to = changed !== null && changed > from && changed <= now ? changed : now;
          if (!bySession.has(id)) bySession.set(id, []);
          bySession.get(id)!.push({
            id: fingerprint(JSON.stringify(['hermes', rowKey, base])), provider: hermesProvider(row.provider), app: 'Hermes', profile,
            session: identifier(id) || `hermes-${fingerprint(id).slice(0, 12)}`, from, to,
            input: dInput, output: dOutput, cached: Math.min(dCached, dInput), timing: 'poll-delta',
          });
        }
        next.hermes[key] = { node, at: now, rows: baselines };
        for (const [session, list] of bySession) {
          if (!candidates.has(session)) candidates.set(session, []);
          candidates.get(session)!.push({ database: key, total: list.reduce((sum, e) => sum + e.input + e.output, 0), events: list });
        }
        const notes = [`${perModel} per-model rows`, ...(aggregates ? [`${aggregates} session aggregates without per-model rows`] : [])];
        if (!previous) notes.push('first observation, counters baselined');
        if (residual) notes.push(`${residual} sessions with aggregate usage beyond their per-model rows (difference not counted)`);
        if (invalid) { health.complete = false; notes.push(`${invalid} rows with invalid counters skipped`); }
        coverage.push(`Hermes ${profile}: ${notes.join('; ')}.`);
      } catch (error) {
        health.complete = false;
        coverage.push(`Hermes ${profile}: ${sqliteProblem(error)}; not collected this time.`);
        const known = this.state.hermes![key];
        if (known) next.hermes[key] = known;
      }
    }
    for (const [key, known] of Object.entries(this.state.hermes!)) {
      if (!next.hermes[key] && known.at >= now - RETENTION) next.hermes[key] = known;
    }
    // A session id present in several databases is a clone (copied profile or recovered store):
    // only its largest change is counted, never the sum.
    for (const list of candidates.values()) list.sort((a, b) => b.total - a.total || (a.database < b.database ? -1 : 1))[0].events.forEach(add);
    const duplicated = [...locations.values()].filter(places => places.size > 1).length;
    if (duplicated) coverage.push(`Hermes: ${duplicated} session ids appear in several databases; counted once.`);
  }

  /** Selects accounting columns only, in a single statement so all rows share one snapshot. */
  private async hermesRows(database: string): Promise<{ rows: Record<string, unknown>[]; residual: number }> {
    const schema = await this.sqlite(database, "SELECT 'sessions' AS t, name FROM pragma_table_info('sessions') UNION ALL SELECT 'session_model_usage', name FROM pragma_table_info('session_model_usage')");
    const columns = (table: string): Set<unknown> => new Set(schema.filter(row => row.t === table).map(row => row.name));
    const sessions = columns('sessions'), models = columns('session_model_usage');
    const usable = (set: Set<unknown>, id: string): boolean => [id, 'input_tokens', 'output_tokens'].every(name => set.has(name));
    const bySession = usable(sessions, 'id'), byModel = usable(models, 'session_id');
    if (!bySession && !byModel) throw new SourceProblem('unsupported accounting schema');
    const text = (set: Set<unknown>, name: string): string => set.has(name) ? `COALESCE(${name}, '')` : "''";
    const value = (set: Set<unknown>, name: string, fallback: string): string => set.has(name) ? name : fallback;
    const counters = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
    const sum = (set: Set<unknown>, alias: string): string => counters.filter(name => set.has(name)).map(name => `COALESCE(${alias}.${name}, 0)`).join(' + ');
    const parts: string[] = [];
    if (byModel) {
      parts.push(`SELECT 'm' AS k, session_id AS id, ${text(models, 'model')} AS model, ${text(models, 'task')} AS task, ${text(models, 'billing_provider')} AS provider, `
        + `${text(models, 'billing_mode')} AS mode, ${text(models, 'billing_base_url')} AS url, `
        + `${counters.map((name, index) => `${value(models, name, '0')} AS ${['i', 'o', 'cr', 'cw'][index]}`).join(', ')}, `
        + `${value(models, 'first_seen', 'NULL')} AS fs, ${value(models, 'last_seen', 'NULL')} AS ls FROM session_model_usage`);
    }
    if (bySession) {
      parts.push(`SELECT 's' AS k, id AS id, ${text(sessions, 'model')} AS model, '' AS task, ${text(sessions, 'billing_provider')} AS provider, `
        + `${text(sessions, 'billing_mode')} AS mode, ${text(sessions, 'billing_base_url')} AS url, `
        + `${counters.map((name, index) => `${value(sessions, name, '0')} AS ${['i', 'o', 'cr', 'cw'][index]}`).join(', ')}, `
        + `${value(sessions, 'started_at', 'NULL')} AS fs, NULL AS ls FROM sessions`
        + (byModel ? ' WHERE NOT EXISTS (SELECT 1 FROM session_model_usage u WHERE u.session_id = sessions.id)' : ''));
    }
    if (bySession && byModel) {
      parts.push(`SELECT 'r', NULL, '', '', '', '', '', COUNT(1), 0, 0, 0, NULL, NULL FROM sessions s `
        + `WHERE EXISTS (SELECT 1 FROM session_model_usage u WHERE u.session_id = s.id) `
        + `AND ${sum(sessions, 's')} > (SELECT COALESCE(SUM(${sum(models, 'u')}), 0) FROM session_model_usage u WHERE u.session_id = s.id)`);
    }
    const rows = await this.sqlite(database, parts.join(' UNION ALL '));
    return { rows: rows.filter(row => row.k !== 'r'), residual: rows.filter(row => row.k === 'r').reduce((total, row) => total + (tokens(row.i) ?? 0), 0) };
  }

  /**
   * A plain read-only connection creates a missing -shm file; readonly_shm never does. When no WAL
   * frames can exist (no or empty -wal) an immutable read takes no locks and creates nothing.
   */
  private async sqlite(database: string, sql: string): Promise<Record<string, unknown>[]> {
    const target = (query: string): string => `${pathToFileURL(database).href}?${query}`;
    const [wal, shm] = await Promise.all([sideFile(`${database}-wal`), sideFile(`${database}-shm`)]);
    if (shm === null && wal) throw new SourceProblem('WAL without shared-memory index (writer stopped uncleanly); skipped to avoid a stale read');
    try {
      return await this.query(target('mode=ro&readonly_shm=1'), sql);
    } catch (error) {
      if (!/unable to open/i.test(String((error as { stderr?: unknown }).stderr ?? ''))) throw error;
      if (await sideFile(`${database}-wal`)) throw error;
      return await this.query(target('mode=ro&immutable=1'), sql);
    }
  }

  private async query(target: string, sql: string): Promise<Record<string, unknown>[]> {
    const executable = this.sqlitePath ?? await discoverSqlite(this.sqliteEnvironment);
    if (!executable) throw new SourceProblem('sqlite3 is unavailable (not found on PATH)');
    const { stdout } = await this.sqliteRunner(executable,
      ['-readonly', '-batch', '-bail', '-safe', '-init', devNull, '-json', '-cmd', '.timeout 2000', target, sql],
      { shell: false, env: {}, timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (!stdout.trim()) return [];
    let rows: unknown;
    try { rows = JSON.parse(stdout); } catch { throw new SourceProblem('unexpected sqlite3 output'); }
    if (!Array.isArray(rows)) throw new SourceProblem('unexpected sqlite3 output');
    return rows.map(record);
  }

  private logRoots(): Root[] {
    const roots: Root[] = [];
    const add = (source: Source, base: string | null, folders: string[], name: string, profile: string): void => {
      if (base) for (const folder of folders) roots.push({ source, path: join(base, folder), label: `${name}/${folder}`, profile });
    };
    const codex = this.directory('CODEX_HOME'), claude = this.directory('CLAUDE_CONFIG_DIR');
    add('codex', join(this.home, '.codex'), ['sessions', 'archived_sessions'], '~/.codex', 'default');
    if (codex !== join(this.home, '.codex')) add('codex', codex, ['sessions', 'archived_sessions'], 'CODEX_HOME', codex ? label(basename(codex)) : '');
    add('claude', join(this.home, '.claude'), ['projects'], '~/.claude', 'default');
    add('claude', join(this.home, '.config', 'claude'), ['projects'], '~/.config/claude', 'default');
    if (claude !== join(this.home, '.claude')) add('claude', claude, ['projects'], 'CLAUDE_CONFIG_DIR', claude ? label(basename(claude)) : '');
    return roots;
  }

  private async collectLogs(now: number, next: Clean, add: (event: UsageEvent) => void, coverage: string[], health: Health): Promise<void> {
    const roots = this.logRoots(), stats = new Map<Root, RootStats>(), directories = new Set<string>(), found: LogFile[] = [], nodes = new Set<string>();
    for (const root of roots) {
      const s: RootStats = { files: 0, read: 0, bytes: 0, invalid: 0, oversized: 0, unreadable: 0, external: 0, deep: 0, problem: '' };
      stats.set(root, s);
      const walk = async (directory: string, depth: number): Promise<void> => {
        let real: string;
        try { real = await realpath(directory); } catch (error) {
          if (depth === 0) s.problem = errno(error) === 'ENOENT' ? 'not present' : `not accessible (${errno(error) || 'error'})`;
          return;
        }
        if (directories.has(real)) return;
        directories.add(real);
        if (depth > MAX_DEPTH) { s.deep++; return; }
        let entries: Dirent[];
        try { entries = await readdir(real, { withFileTypes: true }); } catch (error) {
          if (depth === 0) s.problem = `not readable (${errno(error) || 'error'})`; else s.unreadable++;
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const path = join(real, entry.name);
          if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;
          try {
            const info = await stat(path, { bigint: true });
            if (info.isDirectory()) { await walk(path, depth + 1); continue; }
            if (!info.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const node = `${info.dev}:${info.ino}`, mtime = Number(info.mtimeMs);
            if (nodes.has(node) || mtime < now - RETENTION) continue;
            nodes.add(node);
            s.files++;
            const real = await realpath(path);
            found.push({ root, path: real, key: fingerprint(real), node, size: Number(info.size), mtime });
          } catch (error) {
            // A dangling symlink or a file removed meanwhile is not a log; anything else is unread.
            if (errno(error) !== 'ENOENT') s.unreadable++;
          }
        }
      };
      await walk(root.path, 0);
    }
    // A renamed file (e.g. Codex archiving) keeps its inode: its cursor moves instead of a re-read.
    const present = new Set(found.map(file => file.key)), vacated = new Map<string, string>();
    for (const [key, cursor] of Object.entries(this.state.files!)) if (!present.has(key)) vacated.set(cursor.node, key);
    const claimed = new Set<string>();
    let budget = this.byteBudget, deferred = 0;
    for (const file of found.sort((a, b) => b.mtime - a.mtime)) {
      const s = stats.get(file.root)!, key = file.key, moved = vacated.get(file.node);
      const known = this.state.files![key] ?? (moved && !claimed.has(moved) ? this.state.files![moved] : undefined);
      claimed.add(key);
      if (moved && known === this.state.files![moved]) claimed.add(moved);
      const context: LogContext = { profile: file.root.profile, session: sessionFromName(file.path) };
      if (known && known.node === file.node && known.size === file.size && known.mtime === file.mtime) {
        const cursor = structuredClone(known);
        cursor.seen = now;
        if (cursor.claude?.pending && file.mtime <= now - SETTLE) {
          const event = claudeFlush(cursor.claude, context);
          if (event) add(event);
        }
        if (cursor.codex?.external) s.external++;
        next.files[key] = cursor;
        continue;
      }
      if (budget <= 0) { deferred++; if (known) next.files[key] = known; continue; }
      try {
        const result = await this.readLog(file, known, budget, now, context);
        budget -= result.bytes;
        if (result.partial) deferred++;
        if (result.lost) {
          health.complete = false; health.lost = true;
          coverage.push(`${file.root.label}: a log was truncated, replaced or rewritten; unread accounting may have been lost.`);
        }
        s.read++; s.bytes += result.bytes; s.invalid += result.invalid; s.oversized += result.oversized;
        if (result.cursor.codex?.external) s.external++;
        result.events.forEach(add);
        next.files[key] = result.cursor;
      } catch {
        s.unreadable++;
        if (known) next.files[key] = known;
      }
    }
    for (const [key, cursor] of Object.entries(this.state.files!)) {
      if (!claimed.has(key) && !next.files[key] && cursor.seen >= now - RETENTION) next.files[key] = cursor;
    }
    for (const root of roots) {
      const s = stats.get(root)!, name = `${root.source === 'codex' ? 'Codex' : 'Claude Code'} ${root.label}`;
      if (s.problem && s.problem !== 'not present') health.complete = false;
      if (s.unreadable || s.deep) health.complete = false;
      // Unparsable and oversized lines are consumed: their accounting is not read again.
      if (s.invalid || s.oversized) { health.complete = false; health.lost = true; }
      if (s.problem) { coverage.push(`${name}: ${s.problem}.`); continue; }
      const notes = [`${s.files} logs in window`, `${s.read} read (${(s.bytes / 1048576).toFixed(1)} MiB)`];
      if (s.invalid) notes.push(`${s.invalid} unparsable accounting lines`);
      if (s.oversized) notes.push(`${s.oversized} oversized lines skipped`);
      if (s.unreadable) notes.push(`${s.unreadable} entries unreadable`);
      if (s.deep) notes.push(`${s.deep} directories beyond depth ${MAX_DEPTH}`);
      if (s.external) notes.push(`${s.external} Hermes runtime rollouts excluded (counted from Hermes)`);
      coverage.push(`${name}: ${notes.join(', ')}.`);
    }
    if (deferred) health.complete = false;
    if (deferred) coverage.push(`Logs: read budget reached; ${deferred} changed logs continue next collection.`);
  }

  /** Reads complete lines after the cursor; any failure discards this file's progress and events. */
  private async readLog(file: LogFile, known: FileCursor | undefined, budget: number, now: number, context: LogContext):
    Promise<{ cursor: FileCursor; events: UsageEvent[]; bytes: number; invalid: number; oversized: number; partial: boolean; lost: boolean }> {
    const handle = await open(file.path, 'r');
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) throw new Error('not a regular file');
      const node = `${info.dev}:${info.ino}`, size = Number(info.size), mtime = Number(info.mtimeMs);
      const head = await readAt(handle, Math.min(HEAD, size), 0);
      const same = known && known.node === node && known.offset <= size && known.headLength <= head.length
        && fingerprint(head.subarray(0, known.headLength)) === known.head;
      const cursor: FileCursor = same ? structuredClone(known) : { node, head: '', headLength: 0, size, mtime, offset: 0, seen: now };
      Object.assign(cursor, { node, head: fingerprint(head), headLength: head.length, size, mtime, seen: now });
      const markers = file.root.source === 'codex' ? ['token_count', 'session_meta'] : ['"usage"'];
      const events: UsageEvent[] = [];
      let invalid = 0, oversized = 0;
      const consume = (line: Buffer): void => {
        if (!line.length || !markers.some(marker => line.includes(marker))) return;
        let raw: unknown;
        try { raw = JSON.parse(line.toString('utf8')); } catch { invalid++; return; }
        const event = file.root.source === 'codex' ? codexUsage(raw, cursor.codex ??= {}, context) : claudeUsage(raw, cursor.claude ??= {}, context);
        if (event) events.push(event);
      };
      const start = cursor.offset;
      let limit = Math.min(size, start + budget), position = start, parts: Buffer[] = [], length = 0;
      while (position < limit) {
        const data = await readAt(handle, Math.min(CHUNK, limit - position), position);
        if (!data.length) break;
        let from = 0;
        while (from < data.length) {
          const newline = data.indexOf(10, from), end = newline < 0 ? data.length : newline;
          if (!cursor.skip) {
            if (length + end - from > MAX_LINE) { parts = []; length = 0; cursor.skip = true; oversized++; }
            else { parts.push(data.subarray(from, end)); length += end - from; }
          }
          if (newline < 0) break;
          if (cursor.skip) delete cursor.skip; else consume(Buffer.concat(parts, length));
          parts = []; length = 0; from = newline + 1;
          cursor.offset = position + from;
        }
        position += data.length;
        if (cursor.skip) cursor.offset = position;
        // A budget smaller than one line must still make progress: finish that line (bounded by MAX_LINE).
        if (position >= limit && cursor.offset === start) limit = Math.min(size, start + MAX_LINE + 1);
      }
      // A final line without newline is consumed only when it is already a complete JSON object.
      if (position === size && length && !cursor.skip) {
        const line = Buffer.concat(parts, length);
        try {
          if (typeof JSON.parse(line.toString('utf8')) === 'object') { consume(line); cursor.offset = size; }
        } catch { /* Still being written. */ }
      }
      if (cursor.offset === size && cursor.claude?.pending && mtime <= now - SETTLE) {
        const event = claudeFlush(cursor.claude, context);
        if (event) events.push(event);
      }
      // Stopping at the byte budget leaves size below the file size, so the rest is read next time.
      cursor.size = position;
      return { cursor, events, bytes: position - start + head.length, invalid, oversized, partial: position < size, lost: known !== undefined && !same };
    } finally {
      await handle.close();
    }
  }
}
