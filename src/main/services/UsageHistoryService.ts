import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LimitProviderId, LimitsSnapshot } from "../../shared/contracts.ts";
import type { HistorySample, UsageCollectionHealth, UsageEvent, UsageHistory } from "../../shared/usageHistory.ts";
import { sanitizeCollectorState, type CollectorState } from "./LocalUsageCollector.ts";

const FILE_NAME = "usage-history.json";
const FORMAT = "canvastty-usage-history";
// Initial upstream disk format: prototype envelopes are deliberately unsupported.
const STORE_VERSION = 2;
const RETENTION_MS = 30 * 86_400_000;
const COLLECTION_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 5_000;
const DISPOSE_WAIT_MS = 3_000;
const MAX_EVENTS = 500_000;
const MAX_NOTICES = 10;
/** One entry per run: 30 days of 60 s runs fit. */
const MAX_HEALTH = 50_000;
const QUOTA_PROVIDERS: readonly LimitProviderId[] = ["codex", "claude"];
const PROVIDER_LABELS: Record<string, string> = { codex: "Codex", claude: "Claude" };
const STATIC_COVERAGE = [
  "Quota samples: Codex and Claude only, every 60 s while CanvasTTY runs; cached, stale or unavailable limit results are never recorded as new observations.",
  "Account scope: Codex uses a fingerprint of the local login's account ID; Claude uses a fingerprint of the current OAuth credential, so every token refresh starts a new scope and intervals across it are not compared.",
  "Retention: 30 days of quota samples and usage records."
];

export interface UsageLimitsSource {
  getProviders(providers: readonly LimitProviderId[]): Promise<LimitsSnapshot>;
}

export interface UsageCollector {
  readonly state: CollectorState;
  /** A result without `complete: true` is recorded as an incomplete run. */
  collect(now: number): Promise<{ events: UsageEvent[]; coverage: string[]; complete?: boolean; lost?: boolean }>;
}

export interface UsageHistoryServiceOptions {
  /** App userData only: history, collector cursors and notices share one atomically replaced file. */
  directory: string;
  limits: UsageLimitsSource;
  createCollector(state: CollectorState): UsageCollector;
  now?: () => number;
  intervalMs?: number;
  initialDelayMs?: number;
}

interface Notice {
  at: number;
  text: string;
}

interface StoredHistory {
  format: typeof FORMAT;
  version: typeof STORE_VERSION;
  history: UsageHistory;
  collector: CollectorState;
  notices: Notice[];
}

/**
 * Collects quota samples and local usage records on its own timer, independent of any
 * renderer. One collection runs at a time; each collector run works on a draft of the
 * cursors, which are committed together with the records they produced, so the saved
 * file never holds cursors ahead of its history.
 */
export class UsageHistoryService {
  readonly filePath: string;
  private readonly directory: string;
  private readonly limits: UsageLimitsSource;
  private readonly createCollector: (state: CollectorState) => UsageCollector;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private startedAt = 0;
  private collectedAt = 0;
  private samples: HistorySample[] = [];
  private events: UsageEvent[] = [];
  /** Local collection health of every run, failed ones included; the report never covers time before the first. */
  private health: UsageCollectionHealth[] = [];
  private readonly eventIndex = new Map<string, UsageEvent>();
  private eventsChanged = false;
  private readonly lastSampleAt = new Map<string, number>();
  private collectorState: CollectorState = { version: 2, files: {}, hermes: {} };
  private collectorCoverage: string[] = [];
  private runCoverage: string[] = [];
  private providerStatus: string[] = [];
  private notices: Notice[] = [];
  private loadError: string | null = null;
  private collectError: string | null = null;
  private saveError: string | null = null;
  private writable = true;
  private dirty = false;
  private running: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private disposing: Promise<void> | null = null;
  // Set after the final save: a collection still in flight is discarded, not merged.
  private closed = false;

  constructor(options: UsageHistoryServiceOptions) {
    this.directory = options.directory;
    this.filePath = join(options.directory, FILE_NAME);
    this.limits = options.limits;
    this.createCollector = options.createCollector;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? COLLECTION_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? INITIAL_DELAY_MS;
  }

  async load(): Promise<void> {
    const now = this.now();
    this.startedAt = now;
    let raw: string;
    let handle: FileHandle | undefined;
    try {
      // O_NOFOLLOW: a planted symlink is neither read nor, later, written through.
      handle = await open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!(await handle.stat()).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOTFILE" });
      raw = await handle.readFile("utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      this.block(`Usage history file could not be read (${errorCode(error)}); it was left untouched and new history is not being saved.`);
      return;
    } finally {
      await handle?.close().catch(() => undefined);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantine("invalid JSON", now);
      return;
    }
    if (isRecord(parsed) && typeof parsed.format === "string" && (parsed.format !== FORMAT || parsed.version !== STORE_VERSION)) {
      this.block(`Usage history file has an unsupported format (${String(parsed.version).slice(0, 20)}); it was left untouched and new history is not being saved.`);
      return;
    }
    if (isRecord(parsed) && isRecord(parsed.collector) && parsed.collector.version !== 2) {
      this.block("Usage history has an unsupported collector version; it was left untouched and new history is not being saved.");
      return;
    }
    const restored = isRecord(parsed) ? restore(parsed) : null;
    if (!restored) {
      await this.quarantine("invalid structure", now);
      return;
    }

    if (restored.invalid > 0) {
      // The cleaned history will replace the file, so the original is copied aside first.
      const name = preservedName(now);
      try {
        await copyFile(this.filePath, join(this.directory, name), constants.COPYFILE_EXCL);
      } catch (error) {
        this.block(`Usage history contains ${restored.invalid} invalid records and could not be preserved (${errorCode(error)}); it was left untouched and new history is not being saved.`);
        return;
      }
      const text = `${restored.invalid} invalid usage history records were ignored; the original file was preserved as ${name}.`;
      this.loadError = text;
      restored.notices.push({ at: now, text });
      this.dirty = true;
    }
    const { history } = restored;
    this.startedAt = history.startedAt;
    this.collectedAt = history.collectedAt;
    this.collectorState = restored.collector;
    this.notices = restored.notices.slice(-MAX_NOTICES);
    const noticeTexts = new Set(this.notices.map((notice) => notice.text));
    this.collectorCoverage = history.coverage.filter((line) => !STATIC_COVERAGE.includes(line) && !noticeTexts.has(line));
    this.providerStatus = history.providerStatus;
    this.samples = history.samples;
    this.health = (history.health ?? []).slice(-MAX_HEALTH);
    for (const sample of this.samples) this.rememberSample(sample);
    for (const event of history.events) this.eventIndex.set(event.id, event);
    this.eventsChanged = true;
    this.prune(now);
    this.rebuildEvents();
  }

  get(): UsageHistory {
    return structuredClone(this.snapshot());
  }

  /** Runs one collection now, or joins the one already running. */
  async collect(): Promise<UsageHistory> {
    if (!this.closed) await this.serialized();
    return this.get();
  }

  start(): void {
    if (this.started || this.disposing) return;
    this.started = true;
    this.schedule(this.initialDelayMs);
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.disposing = (async () => {
      const running = this.running;
      if (running) {
        let timeout: NodeJS.Timeout | undefined;
        await Promise.race([running, new Promise<void>((resolve) => { timeout = setTimeout(resolve, DISPOSE_WAIT_MS); })]);
        clearTimeout(timeout);
      }
      this.closed = true;
      await this.save();
    })();
    return this.disposing;
  }

  private schedule(delay: number): void {
    if (this.disposing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const began = Date.now();
      void this.serialized().then(() => this.schedule(Math.max(0, this.intervalMs - (Date.now() - began))));
    }, delay);
    this.timer.unref?.();
  }

  private serialized(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<void> {
    const now = this.now();
    let health: UsageCollectionHealth = { at: now, complete: false };
    try {
      const draft = structuredClone(this.collectorState);
      const [limits, local] = await Promise.allSettled([
        this.limits.getProviders(QUOTA_PROVIDERS),
        (async () => {
          const collector = this.createCollector(draft);
          const result = await collector.collect(now);
          return { result, state: collector.state };
        })()
      ]);
      if (this.closed) return;

      this.runCoverage = [];
      this.providerStatus = limits.status === "fulfilled"
        ? this.recordLimits(limits.value, now)
        : ["Quota limits: request failed; no quota samples were recorded in this run."];
      if (local.status === "fulfilled") {
        this.collectorState = local.value.state;
        const { result } = local.value;
        this.collectorCoverage = result.coverage.filter((line) => typeof line === "string");
        // Rejected records are gone: the collector's cursors have already moved past them.
        const rejected = this.mergeEvents(result.events, now);
        const lost = result.lost === true || rejected > 0;
        health = lost ? { at: now, complete: false, lost: true } : { at: now, complete: result.complete === true };
        this.collectError = null;
        this.dirty = true;
      } else {
        this.collectError = "Local usage collection failed in the last run; its cursors were not advanced and the next run retries.";
      }
      this.collectedAt = now;
    } catch {
      this.collectError = "Usage history collection failed unexpectedly in the last run.";
    }
    if (this.closed) return;
    this.health.push(health);
    if (this.health.length > MAX_HEALTH) this.health = this.health.slice(-MAX_HEALTH);
    this.dirty = true;
    try {
      this.prune(now);
      this.rebuildEvents();
    } catch {
      this.collectError = "Usage history collection failed unexpectedly in the last run.";
    }
    await this.save();
  }

  private recordLimits(snapshot: LimitsSnapshot, now: number): string[] {
    const status: string[] = [];
    for (const provider of QUOTA_PROVIDERS) {
      const label = PROVIDER_LABELS[provider] ?? provider;
      const value = snapshot.providers.find((candidate) => candidate.provider === provider);
      if (!value) {
        status.push(`${label}: no limits result; no quota sample.`);
        continue;
      }
      if (value.state === "unavailable") {
        status.push(`${label}: unavailable (${value.reason}); no quota sample.`);
        continue;
      }
      if (value.state === "stale") {
        status.push(`${label}: stale since ${iso(value.failedAt)} (${value.reason}); it repeats the ${iso(value.fetchedAt)} observation, so no quota sample.`);
        continue;
      }
      const scope = value.accountScope ?? null;
      const candidates = value.windows.flatMap((window) => {
        const candidate = sample({
          provider, scope, windowId: window.id, at: value.fetchedAt, reset: window.resetsAt, percent: window.usedPercent
        });
        return candidate && candidate.at <= now + 60_000 && candidate.at >= now - RETENTION_MS ? [candidate] : [];
      });
      let added = 0;
      for (const candidate of candidates) {
        // A cached limits result repeats an observation already recorded: it is not a new one.
        const last = this.lastSampleAt.get(sampleKey(candidate));
        if (last !== undefined && candidate.at <= last) continue;
        this.samples.push(candidate);
        this.rememberSample(candidate);
        added += 1;
      }
      if (added > 0) this.dirty = true;
      if (candidates.length === 0) {
        status.push(`${label}: no quota window reported a usage percentage; no quota sample.`);
      } else if (added === 0) {
        status.push(`${label}: the ${iso(value.fetchedAt)} observation (cached) is already recorded; no new sample.`);
      } else {
        status.push(scope
          ? `${label}: ${added} quota window${added === 1 ? "" : "s"} sampled.`
          : `${label}: ${added} quota window${added === 1 ? "" : "s"} sampled with an unknown account (changed or unreadable login); these samples are not compared with others.`);
      }
    }
    return status;
  }

  /** Returns rejected records, whose consumed source positions make them lost. */
  private mergeEvents(candidates: readonly unknown[], now: number): number {
    let invalid = 0;
    for (const candidate of candidates) {
      const event = usageEvent(candidate);
      if (!event) {
        invalid += 1;
        continue;
      }
      if (event.to < now - RETENTION_MS) continue;
      const existing = this.eventIndex.get(event.id);
      // Streaming updates repeat one message ID with growing usage: keep the maxima.
      const merged = existing ? {
        ...existing,
        from: Math.min(existing.from, event.from),
        to: Math.max(existing.to, event.to),
        input: Math.max(existing.input, event.input),
        output: Math.max(existing.output, event.output),
        cached: Math.max(existing.cached, event.cached)
      } : event;
      if (existing && sameUsage(existing, merged)) continue;
      this.eventIndex.set(event.id, merged);
      this.eventsChanged = true;
    }
    if (invalid > 0) this.runCoverage.push(`${invalid} invalid usage records from local logs were ignored in the last run.`);
    return invalid;
  }

  private prune(now: number): void {
    const cutoff = now - RETENTION_MS;
    const samples = this.samples.filter((candidate) => candidate.at >= cutoff);
    if (samples.length !== this.samples.length) this.dirty = true;
    this.samples = samples;
    for (const [id, event] of this.eventIndex) {
      if (event.to < cutoff) {
        this.eventIndex.delete(id);
        this.eventsChanged = true;
      }
    }
    const health = this.health.filter((entry) => entry.at >= cutoff);
    if (health.length !== this.health.length) this.dirty = true;
    this.health = health;
    if (this.eventIndex.size > MAX_EVENTS) {
      const excess = [...this.eventIndex.values()].sort(byTime).slice(0, this.eventIndex.size - MAX_EVENTS);
      for (const event of excess) this.eventIndex.delete(event.id);
      // Time up to the newest dropped record is no longer fully recorded.
      const dropped = excess[excess.length - 1].to;
      this.health = this.health.filter((entry) => entry.at > dropped);
      this.runCoverage.push(`${excess.length} oldest usage records were dropped to keep the history file bounded.`);
      this.eventsChanged = true;
    }
    this.notices = this.notices.filter((notice) => notice.at >= cutoff);
  }

  private rebuildEvents(): void {
    if (!this.eventsChanged) return;
    this.events = [...this.eventIndex.values()].sort(byTime);
    this.eventsChanged = false;
    this.dirty = true;
  }

  private rememberSample(candidate: HistorySample): void {
    const key = sampleKey(candidate);
    this.lastSampleAt.set(key, Math.max(this.lastSampleAt.get(key) ?? candidate.at, candidate.at));
  }

  private snapshot(): UsageHistory {
    return {
      version: 1,
      startedAt: this.startedAt,
      collectedAt: this.collectedAt,
      samples: this.samples,
      events: this.events,
      coverage: this.coverage(),
      providerStatus: this.providerStatus,
      error: this.errorText(),
      health: this.health
    };
  }

  private coverage(): string[] {
    return [...STATIC_COVERAGE, ...this.notices.map((notice) => notice.text), ...this.collectorCoverage, ...this.runCoverage];
  }

  private errorText(): string | null {
    return [this.loadError, this.collectError, this.saveError].filter(Boolean).join(" ") || null;
  }

  private block(text: string): void {
    this.writable = false;
    this.loadError = text;
  }

  /** Moves an unreadable file aside (never deletes or overwrites it) and restarts history. */
  private async quarantine(reason: string, now: number): Promise<void> {
    const name = preservedName(now);
    try {
      await rename(this.filePath, join(this.directory, name));
    } catch (error) {
      this.block(`Usage history file is unreadable (${reason}) and could not be preserved (${errorCode(error)}); it was left untouched and new history is not being saved.`);
      return;
    }
    const text = `Usage history was unreadable (${reason}); it was preserved as ${name} and history restarted at ${iso(now)}.`;
    this.loadError = text;
    this.notices.push({ at: now, text });
    this.dirty = true;
  }

  private save(): Promise<void> {
    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  private async write(): Promise<void> {
    if (!this.writable || !this.dirty) return;
    const stored: StoredHistory = {
      format: FORMAT,
      version: STORE_VERSION,
      // Errors describe this app run only and are recomputed after the next start.
      history: { ...this.snapshot(), error: null },
      collector: this.collectorState,
      notices: this.notices
    };
    const body = JSON.stringify(stored);
    const temporary = join(this.directory, `.${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.filePath);
      this.dirty = false;
      this.saveError = null;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      this.saveError = `Usage history could not be saved (${errorCode(error)}); collection continues in memory and the last saved copy is unchanged.`;
      return;
    }
    await syncDirectory(this.directory);
  }
}

interface Restored {
  history: UsageHistory;
  collector: CollectorState;
  notices: Notice[];
  invalid: number;
}

function restore(value: Record<string, unknown>): Restored | null {
  const history = value.history;
  if (
    value.format !== FORMAT
    || value.version !== STORE_VERSION
    || !isRecord(history)
    || history.version !== 1
    || !isTime(history.startedAt)
    || !isTime(history.collectedAt)
    || !Array.isArray(history.samples)
    || !Array.isArray(history.events)
    || !Array.isArray(history.health)
    || !isStringArray(history.coverage)
    || !isStringArray(history.providerStatus)
    || !isRecord(value.collector)
    || (value.notices !== undefined && !Array.isArray(value.notices))
  ) return null;

  let invalid = 0;
  const keep = <T>(candidate: T | null): candidate is T => {
    if (candidate === null) invalid += 1;
    return candidate !== null;
  };
  const samples = history.samples.map(sample).filter(keep);
  const events = history.events.map(usageEvent).filter(keep);
  const health = history.health
    .map(collectionHealth).filter(keep).sort((left, right) => left.at - right.at);
  const notices = ((value.notices ?? []) as unknown[]).map(notice).filter(keep);
  const collector = collectorState(value.collector);
  if (!collector) return null;
  invalid += collector.invalid;
  return {
    history: {
      version: 1,
      startedAt: history.startedAt,
      collectedAt: history.collectedAt,
      samples,
      events,
      coverage: history.coverage,
      providerStatus: history.providerStatus,
      error: null,
      health
    },
    collector: collector.state,
    notices,
    invalid
  };
}

/**
 * The collector's own sanitizer is the single schema: only its known accounting fields survive.
 * Every cursor table entry or top-level field it drops or alters (including unknown, possibly
 * secret-bearing fields) counts as invalid, so the original file is preserved before rewriting.
 */
function collectorState(value: Record<string, unknown>): { state: CollectorState; invalid: number } | null {
  if ((value.files !== undefined && !isRecord(value.files)) || (value.hermes !== undefined && !isRecord(value.hermes))) return null;
  const state = sanitizeCollectorState(value);
  let invalid = Object.keys(value).filter((key) => !["version", "files", "hermes"].includes(key)).length;
  for (const table of ["files", "hermes"] as const) {
    const kept: Record<string, unknown> = state[table];
    for (const [key, entry] of Object.entries((value[table] ?? {}) as Record<string, unknown>)) {
      if (!Object.hasOwn(kept, key) || !isDeepStrictEqual(compact(kept[key]), compact(entry))) invalid += 1;
    }
  }
  return { state, invalid };
}

/** Drops empty-object fields (e.g. a reader state with nothing pending), which carry no data. */
function compact(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, compact(entry)])
    .filter(([, entry]) => !(isRecord(entry) && Object.keys(entry).length === 0)));
}

function sample(value: unknown): HistorySample | null {
  if (!isRecord(value)) return null;
  const { provider, scope, windowId, at, reset, percent } = value;
  if (
    !isText(provider, 64)
    || !(scope === null || isText(scope, 128))
    || !isText(windowId, 200)
    || !isTime(at)
    || !(reset === null || isTime(reset))
    || typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100
  ) return null;
  return { provider, scope, windowId, at, reset, percent };
}

function usageEvent(value: unknown): UsageEvent | null {
  if (!isRecord(value)) return null;
  const { id, provider, app, profile, session, from, to, input, output, cached, timing } = value;
  if (
    !isText(id, 200)
    || !isText(provider, 64)
    || !isText(app, 120)
    || typeof profile !== "string" || profile.length > 256
    || typeof session !== "string" || session.length > 256
    || !isTime(from) || !isTime(to) || from > to
    || !isCount(input) || !isCount(output) || !isCount(cached)
    || (timing !== "event" && timing !== "poll-delta")
  ) return null;
  return { id, provider, app, profile, session, from, to, input, output, cached, timing };
}

function collectionHealth(value: unknown): UsageCollectionHealth | null {
  if (!isRecord(value) || !isTime(value.at) || typeof value.complete !== "boolean") return null;
  if (value.lost === undefined) return { at: value.at, complete: value.complete };
  return value.lost === true && value.complete === false ? { at: value.at, complete: false, lost: true } : null;
}

function notice(value: unknown): Notice | null {
  return isRecord(value) && isTime(value.at) && isText(value.text, 1_000) ? { at: value.at, text: value.text } : null;
}

function sameUsage(left: UsageEvent, right: UsageEvent): boolean {
  return left.from === right.from && left.to === right.to && left.input === right.input
    && left.output === right.output && left.cached === right.cached;
}

function sampleKey(candidate: HistorySample): string {
  return `${candidate.provider} ${candidate.windowId}`;
}

function byTime(left: UsageEvent, right: UsageEvent): number {
  return left.to - right.to || left.from - right.from || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function preservedName(now: number): string {
  return `usage-history.corrupt-${new Date(now).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort durability; not every platform supports it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function iso(value: number): string {
  return Number.isFinite(value) ? new Date(value).toISOString() : "an unknown time";
}

function errorCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
