import type { HistorySample, UsageCollectionHealth, UsageEvent, UsageHistory } from "./usageHistory.ts";

/**
 * Pure usage report over the collector's history.
 *
 * Measured quota change comes only from comparable consecutive observations of one
 * provider window of one account. Local token logs are evidence, never proof of which
 * account paid, so every measured change stays unattributed.
 *
 * Alongside the measurement the report computes, automatically, an explicitly
 * CONDITIONAL estimate: for each eligible cluster of measured change it answers "if the
 * logged same-provider activity explains this change, how does it split by token weight?"
 * Change that cannot be evaluated that way is listed as unestimable with its reason, and
 * external contribution always stays unknown in the range 0..measured.
 */

export const QUOTA_MAX_GAP_MS = 5 * 60_000;
/** Two missed one-minute collector polls. */
export const HISTORY_STALE_AFTER_MS = 3 * 60_000;
/**
 * Provider-side accounting may show local work in the next observation: a cluster with no
 * local evidence that starts within this time after the last evidence of the preceding
 * cluster is evaluated together with it.
 */
export const ATTRIBUTION_LAG_MS = 60_000;
/** Hermes counters are baselined on first sight, so activity right after collection starts is not recorded. */
export const BASELINE_WARMUP_MS = 2 * 60_000;
/** One missed poll plus reading time before an interval's local logs count as collected. */
export const EVIDENCE_MARGIN_MS = 2 * 60_000;
/** Claude Code holds the newest message until its transcript idles for 5 minutes. */
const EVIDENCE_SETTLE_MS: Readonly<Record<string, number>> = { claude: 5 * 60_000 };
/**
 * Claude reports one window's resets_at with sub-second jitter between polls. Within a
 * comparable chain every reset must stay within this bound of the chain's first reset,
 * so small jitter never accumulates into a drift across a real boundary.
 */
const RESET_TOLERANCE_MS: Readonly<Record<string, number>> = { claude: 1_000 };
export const USAGE_PERIODS = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000
} as const;
export type UsagePeriod = keyof typeof USAGE_PERIODS;
export type WeightBasis = "uncached" | "all";

export type IntervalReason =
  | "conflicting-observations"
  | "account-unknown"
  | "account-changed"
  | "window-changed"
  | "invalid-percentage"
  | "invalid-time"
  | "reset-unknown"
  | "reset-boundary"
  | "collection-gap"
  | "counter-decreased";
export type CoverageKind = "measured" | IntervalReason | "period-boundary" | "no-observations" | "before-collection";

/** Why measured change is not conditionally estimated. The order is the evaluation order. */
export const UNESTIMABLE_REASONS = [
  "unplaceable-poll-delta",
  "evidence-conflict",
  "no-local-evidence",
  "baseline-warmup",
  "coverage-unrecorded",
  "records-lost",
  "pending-maturity",
  "source-backlog",
  "collection-incomplete"
] as const;
export type UnestimableReason = typeof UNESTIMABLE_REASONS[number];

export interface ComparableSample extends HistorySample {
  conflict?: boolean;
}

export interface TokenTotals {
  events: number;
  input: number;
  cached: number;
  output: number;
}

export interface SessionWeight extends TokenTotals {
  provider: string;
  app: string;
  profile: string;
  session: string;
  /** Token weight under the report's weight basis. */
  weight: number;
}

export interface ConditionalSession extends SessionWeight {
  /** Conditional percentage points, never a measurement. */
  points: number;
}
export interface ConditionalProfile { profile: string; points: number; sessions: ConditionalSession[] }
export interface ConditionalApp { app: string; points: number; profiles: ConditionalProfile[] }

export interface AccountAttribution {
  /** Measured change whose source is not proven. Always the full measured delta. */
  unattributed: number;
  /** Measured change in clusters that passed every eligibility check. */
  eligible: { delta: number; clusters: number; intervals: number; ms: number };
  /** Measured change that cannot be estimated, by reason; with `eligible` it sums to the measured delta. */
  unestimable: { reason: UnestimableReason; delta: number; clusters: number }[];
  /** IF the logged same-provider activity explains the eligible change: its split by token weight. */
  conditional: { points: number; sessions: ConditionalSession[]; apps: ConditionalApp[] };
  /** Contribution of anything not logged here (other devices, web, other tools) is unknown. */
  externalRange: { min: 0; max: number };
  /** Unknown-provider local activity inside eligible clusters: it may or may not have used this quota. */
  unknownProviderOverlap: { events: number; tokens: number };
  candidateSessions: SessionWeight[];
}

export interface AccountSeries {
  scope: string | null;
  latest: { at: number; percent: number; reset: number | null } | null;
  resetsSeen: number[];
  measuredDelta: number;
  measuredIntervals: number;
  measuredMs: number;
  attribution: AccountAttribution;
}

export interface WindowReport {
  provider: string;
  windowId: string;
  latest: { at: number; percent: number; reset: number | null; scope: string | null } | null;
  staleness: { stale: boolean; ageMs: number | null; resetPassed: boolean };
  accounts: AccountSeries[];
  coverage: Record<CoverageKind, number>;
  unknownIntervals: { reason: IntervalReason; count: number; ms: number }[];
  boundaryIntervals: number;
  resetBoundaries: number;
  ambiguousPollDeltas: { events: number; tokens: number };
  /** Same-provider evidence in the period that lies in unmeasured time. */
  unmatchedEvidence: { events: number; tokens: number };
}

export interface ProviderReport {
  provider: string;
  quotaStatus: "observed" | "no-samples" | "provider-unknown";
  windows: WindowReport[];
}

export interface EvidenceSession { session: string; totals: TokenTotals; firstAt: number; lastAt: number }
export interface EvidenceProfile { profile: string; totals: TokenTotals; sessions: EvidenceSession[] }
export interface EvidenceApp { app: string; totals: TokenTotals; profiles: EvidenceProfile[] }
export interface EvidenceProvider { provider: string; totals: TokenTotals; apps: EvidenceApp[] }

export interface LocalCoverage {
  /** "recorded": per-run health is stored; "limited": health is absent, so coverage is unknown. */
  level: "recorded" | "limited";
  /** Local logs are known to be fully read up to this time. */
  completeThrough: number | null;
  /** First recorded run; earlier time has no recorded health and is never treated as covered. */
  recordedSince: number | null;
  latestRunComplete: boolean | null;
  backlog: boolean;
  /** Sources that failed in the latest run; reported, not a permanent block. */
  sourceProblems: string[];
}

export interface UsageReport {
  now: number;
  period: UsagePeriod;
  from: number;
  to: number;
  collection: {
    startedAt: number | null;
    collectedAt: number | null;
    ageMs: number | null;
    stale: boolean;
    error: string | null;
    coverage: string[];
    providerStatus: string[];
  };
  issues: {
    invalidSamples: number;
    duplicateSamples: number;
    conflictingSamples: number;
    invalidEvents: number;
    duplicateEvents: number;
    mergedEventUpdates: number;
    conflictingEvents: number;
  };
  providers: ProviderReport[];
  evidence: {
    providers: EvidenceProvider[];
    total: TokenTotals;
    /** Poll deltas that straddle the period edge: known tokens, unknown placement. */
    outsidePeriod: TokenTotals;
  };
  attribution: {
    method: "conditional-token-weight";
    weightBasis: WeightBasis;
    coverage: LocalCoverage;
  };
}

export interface UsageReportOptions {
  now: number;
  period: UsagePeriod;
  weightBasis?: unknown;
}

export type ParsedUsageHistory = { ok: true; history: UsageHistory } | { ok: false; error: string };

const UNKNOWN_PROVIDER = "unknown";
const PROVIDER_ORDER = ["codex", "claude"];
const BACKLOG_PATTERN = /read budget reached/i;
const SOURCE_PROBLEM_PATTERN = /not collected this time|not accessible|cannot be opened/i;

export function isUsagePeriod(value: unknown): value is UsagePeriod {
  return typeof value === "string" && Object.hasOwn(USAGE_PERIODS, value);
}

export function resetToleranceMs(provider: string): number {
  return Object.hasOwn(RESET_TOLERANCE_MS, provider) ? RESET_TOLERANCE_MS[provider] : 0;
}

/** Time after an interval ends before its local logs are treated as collected. */
export function evidenceMaturityMs(provider: string): number {
  return (Object.hasOwn(EVIDENCE_SETTLE_MS, provider) ? EVIDENCE_SETTLE_MS[provider] : 0) + EVIDENCE_MARGIN_MS;
}

/**
 * Compare consecutive quota observations, anchored to the chain reset so jitter cannot drift.
 */
export function compareQuotaSamples(
  a: ComparableSample,
  b: ComparableSample,
  chainReset: number | null = null
): { delta: number | null; reason: IntervalReason | null } {
  const tolerance = resetToleranceMs(a.provider);
  const reason: IntervalReason | null = a.conflict || b.conflict ? "conflicting-observations"
    : !a.scope || !b.scope ? "account-unknown"
    : a.scope !== b.scope || a.provider !== b.provider ? "account-changed"
    : a.windowId !== b.windowId ? "window-changed"
    : ![a.percent, b.percent].every((x) => Number.isFinite(x) && x >= 0 && x <= 100) ? "invalid-percentage"
    : !Number.isFinite(a.at) || !Number.isFinite(b.at) || b.at <= a.at ? "invalid-time"
    : a.reset === null || b.reset === null ? "reset-unknown"
    : Math.abs(a.reset - b.reset) > tolerance || (chainReset !== null && Math.abs(b.reset - chainReset) > tolerance)
      || b.at >= Math.min(a.reset, b.reset) ? "reset-boundary"
    : b.at - a.at > QUOTA_MAX_GAP_MS ? "collection-gap"
    : b.percent < a.percent ? "counter-decreased" : null;
  return { delta: reason ? null : b.percent - a.percent, reason };
}

/** Input already contains cache reads (and Claude cache writes); reasoning is already part of output. */
export function eventWeight(event: Pick<UsageEvent, "input" | "cached" | "output">, basis: WeightBasis): number {
  return basis === "all" ? event.input + event.output : Math.max(0, event.input - event.cached) + event.output;
}

export function parseUsageHistory(value: unknown): ParsedUsageHistory {
  if (!isRecord(value)) return { ok: false, error: "Usage history payload is not an object." };
  if (value.version !== 1) return { ok: false, error: `Unsupported usage history version: ${String(value.version)}.` };
  if (!Array.isArray(value.samples) || !Array.isArray(value.events)) {
    return { ok: false, error: "Usage history payload has no sample/event lists." };
  }
  const health = sanitizeHealth(value.health);
  return {
    ok: true,
    history: {
      version: 1,
      startedAt: typeof value.startedAt === "number" ? value.startedAt : Number.NaN,
      collectedAt: typeof value.collectedAt === "number" ? value.collectedAt : Number.NaN,
      samples: value.samples as HistorySample[],
      events: value.events as UsageEvent[],
      coverage: strings(value.coverage),
      providerStatus: strings(value.providerStatus),
      error: typeof value.error === "string" ? value.error : null,
      health: health ?? []
    }
  };
}

export function buildUsageReport(history: UsageHistory, options: UsageReportOptions): UsageReport {
  if (!isUsagePeriod(options.period)) throw new Error(`Unsupported usage period: ${String(options.period)}`);
  if (!Number.isFinite(options.now)) throw new Error("Report time must be finite.");
  const now = options.now;
  const to = now;
  const from = now - USAGE_PERIODS[options.period];
  const weightBasis: WeightBasis = options.weightBasis === "all" ? "all" : "uncached";

  const issues: UsageReport["issues"] = {
    invalidSamples: 0, duplicateSamples: 0, conflictingSamples: 0,
    invalidEvents: 0, duplicateEvents: 0, mergedEventUpdates: 0, conflictingEvents: 0
  };
  const streams = sampleStreams(Array.isArray(history.samples) ? history.samples : [], issues);
  const conflicts: UsageEvent[] = [];
  const events = dedupeEvents(Array.isArray(history.events) ? history.events : [], issues, conflicts);
  const startedAt = finite(history.startedAt);
  const collectedAt = finite(history.collectedAt);
  const coverageText = strings(history.coverage);
  const error = typeof history.error === "string" ? history.error : null;
  const localCoverage = assessLocalCoverage(history.health, coverageText);
  const healthIndex = indexHealth(history.health);

  const inPeriod: UsageEvent[] = [];
  const straddling: UsageEvent[] = [];
  const outsidePeriod = emptyTotals();
  for (const event of events) {
    const where = placement(event, from, to);
    if (where === "inside") inPeriod.push(event);
    else if (where === "straddles") {
      straddling.push(event);
      addTotals(outsidePeriod, event);
    }
  }
  const unknownActivity = inPeriod.filter((event) => event.provider === UNKNOWN_PROVIDER).sort((left, right) => left.to - right.to);

  const providerIds = new Set<string>([...streams.keys()].map((key) => (JSON.parse(key) as [string, string])[0]));
  for (const event of inPeriod) providerIds.add(event.provider);
  const providers: ProviderReport[] = sortProviders([...providerIds]).map((provider) => {
    const evidence = providerEvidence(provider, inPeriod, straddling, conflicts);
    const windows = [...streams.entries()]
      .filter(([key]) => (JSON.parse(key) as [string, string])[0] === provider)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, observations]) => windowReport(
        provider, (JSON.parse(key) as [string, string])[1], observations, evidence,
        {
          now, from, to, startedAt, collectedAt, weightBasis, localCoverage, healthIndex,
          maturityMs: evidenceMaturityMs(provider),
          unknownActivity: provider === UNKNOWN_PROVIDER ? [] : unknownActivity
        }
      ));
    const quotaStatus: ProviderReport["quotaStatus"] = provider === UNKNOWN_PROVIDER ? "provider-unknown"
      : windows.length ? "observed" : "no-samples";
    return { provider, quotaStatus, windows };
  });

  return {
    now,
    period: options.period,
    from,
    to,
    collection: {
      startedAt,
      collectedAt,
      ageMs: collectedAt === null ? null : Math.max(0, now - collectedAt),
      stale: collectedAt === null || now - collectedAt > HISTORY_STALE_AFTER_MS,
      error,
      coverage: coverageText,
      providerStatus: strings(history.providerStatus)
    },
    issues,
    providers,
    evidence: { providers: evidenceTree(inPeriod), total: sumTotals(inPeriod), outsidePeriod },
    attribution: { method: "conditional-token-weight", weightBasis, coverage: localCoverage }
  };
}

/**
 * Local logs are complete up to a run that read every log to its end. Without recorded
 * per-run health, source text is diagnostic only and never certifies coverage.
 */
function assessLocalCoverage(
  rawHealth: unknown,
  coverage: string[]
): LocalCoverage {
  const sourceProblems = coverage.filter((line) => SOURCE_PROBLEM_PATTERN.test(line));
  const health = sanitizeHealth(rawHealth);
  // A recording collector writes the list even before its first run: an empty list covers nothing.
  if (health) {
    const latest = health.at(-1);
    const complete = health.filter((entry) => entry.complete);
    return {
      level: "recorded",
      completeThrough: complete.at(-1)?.at ?? null,
      recordedSince: health[0]?.at ?? null,
      latestRunComplete: latest?.complete ?? null,
      // Which problem made the latest run incomplete is only known from its coverage text.
      backlog: latest?.complete === false && coverage.some((line) => BACKLOG_PATTERN.test(line)),
      sourceProblems
    };
  }
  const backlog = coverage.some((line) => BACKLOG_PATTERN.test(line));
  return {
    level: "limited",
    completeThrough: null,
    recordedSince: null,
    latestRunComplete: null,
    backlog,
    sourceProblems
  };
}

/** Recorded run times, ascending, for the per-cluster coverage check. */
interface HealthIndex {
  first: number;
  complete: number[];
  lost: number[];
}

function indexHealth(rawHealth: unknown): HealthIndex {
  const health = sanitizeHealth(rawHealth) ?? [];
  return {
    first: health[0]?.at ?? Number.POSITIVE_INFINITY,
    complete: health.filter((entry) => entry.complete).map((entry) => entry.at),
    lost: health.filter((entry) => entry.lost).map((entry) => entry.at)
  };
}

/** Index of the first value >= target in an ascending list. */
function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Recorded coverage of a cluster from its start until its logs matured. The first complete run
 * at or after maturity has read every record written in the cluster, so an earlier backlog or
 * failure is drained by then. A run that lost records between the cluster start and that run
 * may have lost the cluster's own records, which no later run recovers. Time before the first
 * recorded run has unknown runs and is never covered.
 */
function recordedCoverage(index: HealthIndex, start: number, matureAt: number): "unrecorded" | "lost" | "covered" | "open" {
  if (start < index.first) return "unrecorded";
  const covering: number | undefined = index.complete[lowerBound(index.complete, matureAt)];
  const lost: number | undefined = index.lost[lowerBound(index.lost, start)];
  if (lost !== undefined && (covering === undefined || lost <= covering)) return "lost";
  return covering === undefined ? "open" : "covered";
}

interface WindowContext {
  now: number;
  from: number;
  to: number;
  startedAt: number | null;
  collectedAt: number | null;
  weightBasis: WeightBasis;
  localCoverage: LocalCoverage;
  healthIndex: HealthIndex;
  maturityMs: number;
  /** Unknown-provider events in the period, sorted by `to`. */
  unknownActivity: UsageEvent[];
}

interface Interval {
  a: ComparableSample;
  b: ComparableSample;
  delta: number | null;
  reason: IntervalReason | null;
}

/** Same-provider evidence, indexed for interval lookup. */
interface ProviderEvidence {
  /** Records placed at their `to` time, inside the period, sorted by `to`. */
  points: UsageEvent[];
  /** Poll deltas with a real span that touch the period, sorted by `from`. */
  polls: UsageEvent[];
  longestPoll: number;
  inPeriod: UsageEvent[];
  /** Records excluded for a conflicting id, sorted by `to`: a cluster holding one lacks part of its evidence. */
  conflicts: UsageEvent[];
}

function isSpan(event: UsageEvent): boolean {
  return event.timing === "poll-delta" && event.from < event.to;
}

function providerEvidence(provider: string, inPeriod: UsageEvent[], straddling: UsageEvent[], conflicts: UsageEvent[]): ProviderEvidence {
  const own = inPeriod.filter((event) => event.provider === provider);
  const points = own.filter((event) => !isSpan(event)).sort((left, right) => left.to - right.to);
  const polls = [...own, ...straddling.filter((event) => event.provider === provider)]
    .filter(isSpan)
    .sort((left, right) => left.from - right.from);
  const longestPoll = polls.reduce((longest, event) => Math.max(longest, event.to - event.from), 0);
  const conflicted = conflicts.filter((event) => event.provider === provider).sort((left, right) => left.to - right.to);
  return { points, polls, longestPoll, inPeriod: own, conflicts: conflicted };
}

/** First index whose item satisfies a predicate that is monotone over the list. */
function firstIndex<T>(list: readonly T[], predicate: (item: T) => boolean): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (predicate(list[middle])) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Per-account accumulation across comparable runs, finalized into AccountAttribution. */
interface AttributionDraft {
  eligible: AccountAttribution["eligible"];
  unestimable: Map<UnestimableReason, { delta: number; clusters: number }>;
  sessions: Map<string, ConditionalSession>;
  candidates: Map<string, SessionWeight>;
  unknownOverlap: Set<UsageEvent>;
}

function windowReport(
  provider: string,
  windowId: string,
  observations: ComparableSample[],
  evidence: ProviderEvidence,
  context: WindowContext
): WindowReport {
  const { from, to } = context;
  const coverage = emptyCoverage();
  const unknown = new Map<IntervalReason, { count: number; ms: number }>();
  const accounts = new Map<string, AccountSeries>();
  const drafts = new Map<AccountSeries, AttributionDraft>();
  const tolerance = resetToleranceMs(provider);
  let boundaryIntervals = 0;
  let resetBoundaries = 0;

  const account = (scope: string | null): AccountSeries => {
    const key = JSON.stringify(scope);
    let series = accounts.get(key);
    if (!series) {
      series = {
        scope, latest: null, resetsSeen: [], measuredDelta: 0, measuredIntervals: 0, measuredMs: 0,
        attribution: emptyAttribution()
      };
      accounts.set(key, series);
      drafts.set(series, {
        eligible: { delta: 0, clusters: 0, intervals: 0, ms: 0 },
        unestimable: new Map(), sessions: new Map(), candidates: new Map(), unknownOverlap: new Set()
      });
    }
    return series;
  };
  for (const observation of observations) {
    if (observation.conflict || observation.at < from || observation.at > to) continue;
    const series = account(observation.scope);
    series.latest = { at: observation.at, percent: observation.percent, reset: observation.reset };
    const reset = observation.reset;
    if (reset !== null && !series.resetsSeen.some((seen) => Math.abs(seen - reset) <= tolerance)) series.resetsSeen.push(reset);
  }
  for (const series of accounts.values()) series.resetsSeen.sort((left, right) => left - right);

  // Tile the whole period: gaps before/after observations, then each consecutive pair.
  const uncovered = (start: number, end: number): void => {
    if (end <= start) return;
    const before = context.startedAt === null ? start : Math.min(end, Math.max(start, context.startedAt));
    coverage["before-collection"] += before - start;
    coverage["no-observations"] += end - before;
  };
  const first = observations[0];
  const last = observations.at(-1);
  if (!first || !last) uncovered(from, to);
  else {
    uncovered(from, Math.min(first.at, to));
    uncovered(Math.max(last.at, from), to);
  }

  const measured: (Interval | null)[] = [];
  let chainReset = first?.reset ?? null;
  for (let index = 1; index < observations.length; index += 1) {
    const a = observations[index - 1];
    const b = observations[index];
    const { delta, reason } = compareQuotaSamples(a, b, chainReset);
    // A broken chain restarts at b; its reset anchors the next chain.
    if (reason !== null) chainReset = b.reset;
    const inside = a.at >= from && b.at <= to;
    const overlapMs = Math.min(b.at, to) - Math.max(a.at, from);
    let kept: Interval | null = null;
    if (inside && reason === null && delta !== null) {
      coverage.measured += b.at - a.at;
      kept = { a, b, delta, reason };
      const series = account(a.scope);
      series.measuredDelta += delta;
      series.measuredIntervals += 1;
      series.measuredMs += b.at - a.at;
    } else if (overlapMs > 0) {
      if (!inside) boundaryIntervals += 1;
      const kind: CoverageKind = reason ?? "period-boundary";
      coverage[kind] += overlapMs;
      if (reason) {
        const entry = unknown.get(reason) ?? { count: 0, ms: 0 };
        entry.count += 1;
        entry.ms += overlapMs;
        unknown.set(reason, entry);
        if (reason === "reset-boundary") resetBoundaries += 1;
      }
    }
    measured.push(kept);
  }

  const matched = new Set<UsageEvent>();
  const ambiguous = new Set<UsageEvent>();
  for (const run of comparableRuns(measured)) {
    const series = account(run[0].a.scope);
    attributeRun(run, evidence, drafts.get(series)!, context, matched, ambiguous);
  }
  for (const [series, draft] of drafts) series.attribution = finalizeAttribution(series, draft);

  const unmatchedEvidence = { events: 0, tokens: 0 };
  for (const event of evidence.inPeriod) {
    if (matched.has(event) || ambiguous.has(event)) continue;
    unmatchedEvidence.events += 1;
    unmatchedEvidence.tokens += event.input + event.output;
  }
  const ambiguousPollDeltas = { events: ambiguous.size, tokens: 0 };
  for (const event of ambiguous) ambiguousPollDeltas.tokens += event.input + event.output;

  const latestObservation = [...observations].reverse().find((observation) => observation.at <= to && !observation.conflict) ?? null;
  const latest = latestObservation && {
    at: latestObservation.at, percent: latestObservation.percent, reset: latestObservation.reset, scope: latestObservation.scope
  };
  const ageMs = latest ? Math.max(0, context.now - latest.at) : null;

  return {
    provider,
    windowId,
    latest,
    staleness: {
      stale: ageMs === null || ageMs > QUOTA_MAX_GAP_MS,
      ageMs,
      resetPassed: latest !== null && latest.reset !== null && latest.reset <= context.now
    },
    accounts: [...accounts.values()].sort((left, right) => (
      (right.latest?.at ?? 0) - (left.latest?.at ?? 0) || String(left.scope).localeCompare(String(right.scope))
    )),
    coverage,
    unknownIntervals: [...unknown.entries()].map(([reason, entry]) => ({ reason, ...entry })),
    boundaryIntervals,
    resetBoundaries,
    ambiguousPollDeltas,
    unmatchedEvidence
  };
}

/** Maximal chains of adjacent comparable intervals; each chain has exactly one account. */
function comparableRuns(intervals: (Interval | null)[]): Interval[][] {
  const runs: Interval[][] = [];
  let current: Interval[] = [];
  for (const interval of intervals) {
    if (interval) current.push(interval);
    else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

interface Cluster {
  first: number;
  last: number;
  delta: number;
  blocked: boolean;
  weight: number;
  lastEvidenceAt: number;
  sessions: Map<string, SessionWeight>;
}

/**
 * Intervals are half-open (a.at, b.at]. Event-timed records belong to the interval that
 * contains their time. A poll delta is placed only when it lies wholly inside the chain;
 * the intervals it spans are then evaluated together. A poll delta that crosses the edge
 * of the chain cannot be placed and blocks every interval it overlaps.
 */
function attributeRun(
  run: Interval[],
  evidence: ProviderEvidence,
  draft: AttributionDraft,
  context: WindowContext,
  matched: Set<UsageEvent>,
  ambiguous: Set<UsageEvent>
): void {
  const start = run[0].a.at;
  const end = run[run.length - 1].b.at;
  const parent = run.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]];
    return index;
  };
  /** Interval (a, b] that contains a time inside the run. */
  const containing = (time: number): number => firstIndex(run, (interval) => interval.b.at >= time);
  const blocked = new Set<number>();
  const placed: { event: UsageEvent; index: number }[] = [];

  const { points, polls } = evidence;
  for (let index = firstIndex(points, (event) => event.to > start); index < points.length && points[index].to <= end; index += 1) {
    placed.push({ event: points[index], index: containing(points[index].to) });
  }
  for (let index = firstIndex(polls, (event) => event.from >= start - evidence.longestPoll); index < polls.length && polls[index].from < end; index += 1) {
    const event = polls[index];
    if (event.to <= start) continue;
    if (event.from < start || event.to > end) {
      ambiguous.add(event);
      for (let overlapped = firstIndex(run, (interval) => interval.b.at > event.from); overlapped < run.length && run[overlapped].a.at < event.to; overlapped += 1) {
        blocked.add(overlapped);
      }
      continue;
    }
    // Wholly inside: the intervals it spans are evaluated together.
    const firstSpanned = firstIndex(run, (interval) => interval.b.at > event.from);
    const lastSpanned = containing(event.to);
    for (let spanned = firstSpanned + 1; spanned <= lastSpanned; spanned += 1) parent[root(spanned)] = root(firstSpanned);
    placed.push({ event, index: firstSpanned });
  }

  // Spans only join contiguous ranges, so clusters are contiguous and ordered by first index.
  const byRoot = new Map<number, Cluster>();
  const clusters: Cluster[] = [];
  run.forEach((interval, index) => {
    const key = root(index);
    let cluster = byRoot.get(key);
    if (!cluster) {
      cluster = { first: index, last: index, delta: 0, blocked: false, weight: 0, lastEvidenceAt: Number.NEGATIVE_INFINITY, sessions: new Map() };
      byRoot.set(key, cluster);
      clusters.push(cluster);
    }
    cluster.last = index;
    cluster.delta += interval.delta ?? 0;
    if (blocked.has(index)) cluster.blocked = true;
  });
  for (const { event, index } of placed) {
    matched.add(event);
    const cluster = byRoot.get(root(index))!;
    const weight = eventWeight(event, context.weightBasis);
    cluster.weight += weight;
    cluster.lastEvidenceAt = Math.max(cluster.lastEvidenceAt, event.to);
    const key = sessionKey(event);
    const session = cluster.sessions.get(key) ?? { ...sessionIdentity(event), ...emptyTotals(), weight: 0 };
    addTotals(session, event);
    session.weight += weight;
    cluster.sessions.set(key, session);
  }

  // Provider accounting lag: an evidence-free cluster right after evidence joins it.
  const merged: Cluster[] = [];
  for (const cluster of clusters) {
    const previous = merged.at(-1);
    if (previous && previous.weight > 0 && !previous.blocked && cluster.weight <= 0 && !cluster.blocked
      && run[cluster.first].a.at - previous.lastEvidenceAt < ATTRIBUTION_LAG_MS) {
      previous.last = cluster.last;
      previous.delta += cluster.delta;
      continue;
    }
    merged.push(cluster);
  }

  const warmupEnd = context.startedAt === null ? Number.POSITIVE_INFINITY : context.startedAt + BASELINE_WARMUP_MS;
  const { localCoverage, healthIndex } = context;
  for (const cluster of merged) {
    for (const [key, session] of cluster.sessions) {
      const total = draft.candidates.get(key) ?? { ...sessionIdentity(session), ...emptyTotals(), weight: 0 };
      total.events += session.events;
      total.input += session.input;
      total.cached += session.cached;
      total.output += session.output;
      total.weight += session.weight;
      draft.candidates.set(key, total);
    }
    const clusterStart = run[cluster.first].a.at;
    const clusterEnd = run[cluster.last].b.at;
    const matureAt = clusterEnd + context.maturityMs;
    const recorded = recordedCoverage(healthIndex, clusterStart, matureAt);
    const reason: UnestimableReason | null = cluster.blocked ? "unplaceable-poll-delta"
      : hasConflict(evidence.conflicts, clusterStart, clusterEnd) ? "evidence-conflict"
      : cluster.weight <= 0 ? "no-local-evidence"
      : clusterStart < warmupEnd ? "baseline-warmup"
      : recorded === "unrecorded" ? "coverage-unrecorded"
      : recorded === "lost" ? "records-lost"
      : recorded === "covered" ? null
      : context.collectedAt === null || matureAt > context.collectedAt ? "pending-maturity"
      : localCoverage.backlog ? "source-backlog"
      : "collection-incomplete";
    if (reason) {
      if (cluster.delta > 0) {
        const entry = draft.unestimable.get(reason) ?? { delta: 0, clusters: 0 };
        entry.delta += cluster.delta;
        entry.clusters += 1;
        draft.unestimable.set(reason, entry);
      }
      continue;
    }
    if (cluster.delta <= 0) continue;
    draft.eligible.delta += cluster.delta;
    draft.eligible.clusters += 1;
    draft.eligible.intervals += cluster.last - cluster.first + 1;
    draft.eligible.ms += clusterEnd - clusterStart;
    for (const [key, session] of cluster.sessions) {
      if (session.weight <= 0) continue;
      const existing = draft.sessions.get(key) ?? { ...sessionIdentity(session), ...emptyTotals(), weight: 0, points: 0 };
      const share = cluster.delta * session.weight / cluster.weight;
      existing.points += share;
      existing.events += session.events;
      existing.input += session.input;
      existing.cached += session.cached;
      existing.output += session.output;
      existing.weight += session.weight;
      draft.sessions.set(key, existing);
    }
    const unknownFrom = firstIndex(context.unknownActivity, (event) => event.to > clusterStart);
    for (let index = unknownFrom; index < context.unknownActivity.length && context.unknownActivity[index].to <= clusterEnd; index += 1) {
      draft.unknownOverlap.add(context.unknownActivity[index]);
    }
  }
}

/** A record excluded for a conflicting id lies in (start, end]: the cluster's evidence is incomplete. */
function hasConflict(conflicts: UsageEvent[], start: number, end: number): boolean {
  for (let index = firstIndex(conflicts, (event) => event.to > start); index < conflicts.length; index += 1) {
    const event = conflicts[index];
    if (isSpan(event) ? event.from < end : event.to <= end) return true;
  }
  return false;
}

function finalizeAttribution(series: AccountSeries, draft: AttributionDraft): AccountAttribution {
  const sessions = [...draft.sessions.values()].sort((left, right) => right.points - left.points);
  const apps = new Map<string, Map<string, ConditionalSession[]>>();
  for (const session of sessions) {
    const profiles = apps.get(session.app) ?? new Map<string, ConditionalSession[]>();
    const list = profiles.get(session.profile) ?? [];
    list.push(session);
    profiles.set(session.profile, list);
    apps.set(session.app, profiles);
  }
  const sum = (items: { points: number }[]): number => items.reduce((total, item) => total + item.points, 0);
  const byPoints = <T extends { points: number }>(items: T[]): T[] => items.sort((left, right) => right.points - left.points);
  const tree: ConditionalApp[] = byPoints([...apps.entries()].map(([app, profiles]) => {
    const profileList = byPoints([...profiles.entries()].map(([profile, list]) => ({
      profile, points: sum(list), sessions: list
    })));
    return { app, points: sum(profileList), profiles: profileList };
  }));
  const unknownProviderOverlap = { events: draft.unknownOverlap.size, tokens: 0 };
  for (const event of draft.unknownOverlap) unknownProviderOverlap.tokens += event.input + event.output;
  return {
    unattributed: series.measuredDelta,
    eligible: draft.eligible,
    unestimable: UNESTIMABLE_REASONS.filter((reason) => draft.unestimable.has(reason))
      .map((reason) => ({ reason, ...draft.unestimable.get(reason)! })),
    conditional: { points: draft.eligible.delta, sessions, apps: tree },
    externalRange: { min: 0, max: series.measuredDelta },
    unknownProviderOverlap,
    candidateSessions: [...draft.candidates.values()].sort((left, right) => right.weight - left.weight)
  };
}

function emptyAttribution(): AccountAttribution {
  return {
    unattributed: 0,
    eligible: { delta: 0, clusters: 0, intervals: 0, ms: 0 },
    unestimable: [],
    conditional: { points: 0, sessions: [], apps: [] },
    externalRange: { min: 0, max: 0 },
    unknownProviderOverlap: { events: 0, tokens: 0 },
    candidateSessions: []
  };
}

function sanitizeHealth(value: unknown): UsageCollectionHealth[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((entry): entry is UsageCollectionHealth => isRecord(entry) && typeof entry.at === "number" && Number.isFinite(entry.at)
      && typeof entry.complete === "boolean")
    // A malformed loss marker is kept as a loss: dropping it could only overstate coverage.
    .map((entry): UsageCollectionHealth => {
      const lost: unknown = entry.lost;
      return lost !== undefined && lost !== false ? { at: entry.at, complete: false, lost: true } : { at: entry.at, complete: entry.complete };
    })
    .sort((left, right) => left.at - right.at);
}

function sampleStreams(raw: unknown[], issues: UsageReport["issues"]): Map<string, ComparableSample[]> {
  const byStream = new Map<string, HistorySample[]>();
  for (const item of raw) {
    const sample = sanitizeSample(item);
    if (!sample) {
      issues.invalidSamples += 1;
      continue;
    }
    const key = JSON.stringify([sample.provider, sample.windowId]);
    const list = byStream.get(key) ?? [];
    list.push(sample);
    byStream.set(key, list);
  }
  const streams = new Map<string, ComparableSample[]>();
  for (const [key, list] of byStream) {
    list.sort((left, right) => left.at - right.at);
    const collapsed: ComparableSample[] = [];
    for (let index = 0; index < list.length;) {
      let end = index + 1;
      while (end < list.length && list[end].at === list[index].at) end += 1;
      const group = list.slice(index, end);
      const head = group[0];
      if (group.every((item) => item.scope === head.scope && item.reset === head.reset && Object.is(item.percent, head.percent))) {
        issues.duplicateSamples += group.length - 1;
        collapsed.push({ ...head });
      } else {
        issues.conflictingSamples += group.length;
        collapsed.push({ ...head, conflict: true });
      }
      index = end;
    }
    streams.set(key, collapsed);
  }
  return streams;
}

function sanitizeSample(raw: unknown): HistorySample | null {
  if (!isRecord(raw)) return null;
  const { provider, windowId, at, scope, reset, percent } = raw;
  if (typeof provider !== "string" || !provider || typeof windowId !== "string" || !windowId) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return {
    provider,
    windowId,
    at,
    scope: typeof scope === "string" && scope ? scope : null,
    reset: typeof reset === "number" && Number.isFinite(reset) ? reset : null,
    percent: typeof percent === "number" ? percent : Number.NaN
  };
}

function sanitizeEvent(raw: unknown): UsageEvent | null {
  if (!isRecord(raw)) return null;
  const { id, provider, app, profile, session, from, to, input, output, cached, timing } = raw;
  if (typeof id !== "string" || !id || typeof provider !== "string" || !provider) return null;
  if (typeof app !== "string" || !app || typeof session !== "string" || !session) return null;
  if (typeof profile !== "string") return null;
  if (timing !== "event" && timing !== "poll-delta") return null;
  if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  if (![input, output, cached].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return null;
  // Only accounting fields survive; anything else a payload carries is dropped here.
  return {
    id, provider, app, profile, session, from, to,
    input: input as number, output: output as number, cached: cached as number, timing
  };
}

/** One record per id. Streaming updates keep the largest record; identity clashes keep none and go to `conflicts`. */
function dedupeEvents(raw: unknown[], issues: UsageReport["issues"], conflicts: UsageEvent[]): UsageEvent[] {
  const byId = new Map<string, UsageEvent[]>();
  for (const item of raw) {
    const event = sanitizeEvent(item);
    if (!event) {
      issues.invalidEvents += 1;
      continue;
    }
    const list = byId.get(event.id) ?? [];
    list.push(event);
    byId.set(event.id, list);
  }
  const result: UsageEvent[] = [];
  for (const list of byId.values()) {
    const head = list[0];
    if (list.some((event) => sessionKey(event) !== sessionKey(head) || event.timing !== head.timing)) {
      issues.conflictingEvents += list.length;
      conflicts.push(...list);
      continue;
    }
    let best = head;
    for (const event of list.slice(1)) {
      if (JSON.stringify(event) === JSON.stringify(head)) issues.duplicateEvents += 1;
      else issues.mergedEventUpdates += 1;
      if (event.input + event.output > best.input + best.output) best = event;
    }
    result.push(best);
  }
  return result;
}

function placement(event: UsageEvent, from: number, to: number): "inside" | "straddles" | "outside" {
  if (event.timing === "poll-delta" && event.from < event.to) {
    if (from <= event.from && event.to <= to) return "inside";
    return event.from < to && event.to > from ? "straddles" : "outside";
  }
  return from < event.to && event.to <= to ? "inside" : "outside";
}

function evidenceTree(events: UsageEvent[]): EvidenceProvider[] {
  const providers = new Map<string, Map<string, Map<string, Map<string, UsageEvent[]>>>>();
  for (const event of events) {
    const apps = providers.get(event.provider) ?? new Map<string, Map<string, Map<string, UsageEvent[]>>>();
    const profiles = apps.get(event.app) ?? new Map<string, Map<string, UsageEvent[]>>();
    const sessions = profiles.get(event.profile) ?? new Map<string, UsageEvent[]>();
    const list = sessions.get(event.session) ?? [];
    list.push(event);
    sessions.set(event.session, list);
    profiles.set(event.profile, sessions);
    apps.set(event.app, profiles);
    providers.set(event.provider, apps);
  }
  const byTokens = <T extends { totals: TokenTotals }>(items: T[]): T[] => items.sort((left, right) => (
    right.totals.input + right.totals.output - (left.totals.input + left.totals.output)
  ));
  return sortProviders([...providers.keys()]).map((provider) => {
    const apps = byTokens([...providers.get(provider)!.entries()].map(([app, profiles]) => {
      const profileList = byTokens([...profiles.entries()].map(([profile, sessions]) => {
        const sessionList = byTokens([...sessions.entries()].map(([session, items]) => ({
          session,
          totals: sumTotals(items),
          firstAt: items.reduce((earliest, item) => Math.min(earliest, item.from), Number.POSITIVE_INFINITY),
          lastAt: items.reduce((latest, item) => Math.max(latest, item.to), Number.NEGATIVE_INFINITY)
        })));
        return { profile, totals: mergeTotals(sessionList), sessions: sessionList };
      }));
      return { app, totals: mergeTotals(profileList), profiles: profileList };
    }));
    return { provider, totals: mergeTotals(apps), apps };
  });
}

function sortProviders(providers: string[]): string[] {
  const rank = (provider: string): number => {
    const index = PROVIDER_ORDER.indexOf(provider);
    return provider === UNKNOWN_PROVIDER ? PROVIDER_ORDER.length + 1 : index >= 0 ? index : PROVIDER_ORDER.length;
  };
  return providers.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

function sessionIdentity(value: Pick<UsageEvent, "provider" | "app" | "profile" | "session">): Pick<UsageEvent, "provider" | "app" | "profile" | "session"> {
  return { provider: value.provider, app: value.app, profile: value.profile, session: value.session };
}

function sessionKey(value: Pick<UsageEvent, "provider" | "app" | "profile" | "session">): string {
  return JSON.stringify([value.provider, value.app, value.profile, value.session]);
}

function emptyTotals(): TokenTotals {
  return { events: 0, input: 0, cached: 0, output: 0 };
}

function addTotals(target: TokenTotals, event: Pick<UsageEvent, "input" | "cached" | "output">): void {
  target.events += 1;
  target.input += event.input;
  target.cached += event.cached;
  target.output += event.output;
}

function sumTotals(events: UsageEvent[]): TokenTotals {
  const totals = emptyTotals();
  for (const event of events) addTotals(totals, event);
  return totals;
}

function mergeTotals(items: { totals: TokenTotals }[]): TokenTotals {
  const totals = emptyTotals();
  for (const { totals: item } of items) {
    totals.events += item.events;
    totals.input += item.input;
    totals.cached += item.cached;
    totals.output += item.output;
  }
  return totals;
}

function emptyCoverage(): Record<CoverageKind, number> {
  return {
    measured: 0,
    "conflicting-observations": 0,
    "account-unknown": 0,
    "account-changed": 0,
    "window-changed": 0,
    "invalid-percentage": 0,
    "invalid-time": 0,
    "reset-unknown": 0,
    "reset-boundary": 0,
    "collection-gap": 0,
    "counter-decreased": 0,
    "period-boundary": 0,
    "no-observations": 0,
    "before-collection": 0
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
