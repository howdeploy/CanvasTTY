import { createHash } from 'node:crypto';
import type { UsageEvent } from '../../shared/usageHistory.ts';

/*
 * Pure parsers for agent session logs. Records are parsed in memory, but only accounting
 * fields are ever copied out: no message, prompt or tool content leaves these functions.
 *
 * Token semantics shared by every source: `input` is the whole prompt (uncached + cache
 * reads + cache writes), `cached` is the cache-read subset of `input`, and `output` already
 * includes reasoning tokens, which are therefore never added a second time.
 */

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Optional counter: absent/null is 0; anything but a safe non-negative integer is invalid. */
export function tokens(value: unknown): number | null {
  return value === undefined || value === null ? 0 : required(value);
}
function required(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function fingerprint(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
export function identifier(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value) ? value : '';
}
function timestamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

export interface LogContext {
  profile: string;
  /** Used when a log does not name its session (e.g. the id is derived from the file name). */
  session: string;
}

/** [input including cached, cached input, output including reasoning] */
export type CodexTokens = [number, number, number];
/** Per-rollout reader state. JSON-serializable: it is persisted in collector cursors. */
export interface CodexFileState {
  /** Session of the first session_meta line; later session_meta lines are copied history. */
  session?: string;
  app?: string;
  /** Rollout written for another accounted app (Hermes' codex app-server runtime). */
  external?: string;
  /** Last valid cumulative total_token_usage of this file. */
  total?: CodexTokens;
  /** Copied parent history is being replayed; its counters only rebaseline until this time. */
  copyUntil?: number;
}
/** A forked rollout replays the parent's lines in one burst right after the second session_meta. */
export const CODEX_COPY_WINDOW = 5_000;

function codexTokens(value: unknown): { tokens: CodexTokens; reasoning: number } | null {
  const u = record(value);
  const input = required(u.input_tokens), output = required(u.output_tokens);
  const cached = tokens(u.cached_input_tokens), reasoning = tokens(u.reasoning_output_tokens);
  if (input === null || output === null || cached === null || reasoning === null || cached > input) return null;
  return { tokens: [input, cached, output], reasoning };
}
function codexApp(originator: string): string {
  if (/vscode|ide|jetbrains/i.test(originator)) return 'Codex IDE';
  if (/desktop/i.test(originator)) return 'Codex Desktop';
  if (/exec/i.test(originator)) return 'Codex Exec';
  return /cli/i.test(originator) ? 'Codex CLI' : 'Codex';
}
const covers = (a: CodexTokens, b: CodexTokens): boolean => a.every((value, index) => value >= b[index]);

/**
 * Codex token_count carries cumulative totals, which are differenced, never summed. A reading
 * without a comparable previous total (resumed, forked or compacted lineage, or an interrupted
 * cursor) is not incremental: only its last_token_usage is new. A decrease rebaselines.
 * Event ids combine the file's lineage (its first session_meta id) with the counters, so copies
 * of one rollout deduplicate by id even when they rewrote timestamps, while independent sessions
 * with equal counters stay distinct. Parent history replayed into a fork is suppressed by the
 * copy window instead.
 */
export function codexUsage(raw: unknown, state: CodexFileState, context: LogContext): UsageEvent | null {
  const r = record(raw), p = record(r.payload), at = timestamp(r.timestamp);
  if (r.type === 'session_meta') {
    const id = identifier(p.id);
    if (!state.session) {
      const originator = typeof p.originator === 'string' ? p.originator : '';
      state.session = id || context.session;
      state.app = codexApp(originator);
      if (/hermes/i.test(originator)) state.external = 'Hermes';
    } else if (id && id !== state.session && Number.isFinite(at)) {
      state.copyUntil = at + CODEX_COPY_WINDOW;
    }
    return null;
  }
  if (r.type !== 'event_msg' || p.type !== 'token_count') return null;
  const info = record(p.info), total = codexTokens(info.total_token_usage);
  if (!total) return null;
  const last = codexTokens(info.last_token_usage);
  const previous = state.total;
  state.total = total.tokens;
  const copied = state.copyUntil !== undefined && !(Number.isFinite(at) && at > state.copyUntil);
  if (!copied) delete state.copyUntil;
  if (copied || state.external || !Number.isFinite(at)) return null;
  const fresh = last && last.tokens.every((value, index) => value === total.tokens[index]);
  const delta = previous && covers(total.tokens, previous) ? total.tokens.map((value, index) => value - previous[index])
    : fresh ? total.tokens
    : !previous && last && covers(total.tokens, last.tokens) ? last.tokens
    : null;
  if (!delta || (!delta[0] && !delta[2])) return null;
  const session = state.session || context.session;
  const counters = [total.tokens, total.reasoning, last?.tokens ?? null, last?.reasoning ?? null];
  return {
    id: fingerprint(JSON.stringify(['codex', session, ...counters])),
    provider: 'codex', app: state.app ?? 'Codex', profile: context.profile, session,
    from: at, to: at, input: delta[0], output: delta[2], cached: Math.min(delta[1], delta[0]), timing: 'event',
  };
}

interface ClaudeMessage {
  id: string;
  session: string;
  from: number;
  to: number;
  /** [uncached input, cache read, cache write, output] */
  usage: [number, number, number, number];
}
/** Per-transcript reader state. JSON-serializable: it is persisted in collector cursors. */
export interface ClaudeFileState {
  /** Newest assistant message; streamed entries of one message repeat its id with growing usage. */
  pending?: ClaudeMessage;
}

function claudeMessage(raw: unknown, context: LogContext): ClaudeMessage | null {
  const r = record(raw), m = record(r.message), u = record(m.usage), at = timestamp(r.timestamp);
  const id = identifier(m.id);
  if (r.type !== 'assistant' || !id || !Number.isFinite(at) || !Object.keys(u).length) return null;
  if (m.model === '<synthetic>' || r.isApiErrorMessage === true) return null;
  const usage = [required(u.input_tokens), tokens(u.cache_read_input_tokens), tokens(u.cache_creation_input_tokens), required(u.output_tokens)];
  if (usage.some(value => value === null)) return null;
  return { id, session: identifier(r.sessionId) || context.session, from: at, to: at, usage: usage as ClaudeMessage['usage'] };
}
function claudeEvent(message: ClaudeMessage, context: LogContext): UsageEvent | null {
  const [input, read, write, output] = message.usage;
  if (!input && !read && !write && !output) return null;
  return {
    id: fingerprint(`claude:${message.id}`), provider: 'claude', app: 'Claude Code', profile: context.profile,
    session: message.session, from: message.from, to: message.to, input: input + read + write, output, cached: read, timing: 'event',
  };
}

/**
 * Claude Code writes one entry per streamed content block, all sharing the API message id, with
 * usage that can grow until the last one; copied/resumed transcripts repeat the same ids. The
 * message is emitted once, with per-counter maxima, when a different message starts or on flush.
 */
export function claudeUsage(raw: unknown, state: ClaudeFileState, context: LogContext): UsageEvent | null {
  const message = claudeMessage(raw, context);
  if (!message) return null;
  const pending = state.pending;
  if (pending?.id === message.id) {
    pending.from = Math.min(pending.from, message.from);
    pending.to = Math.max(pending.to, message.to);
    pending.usage = pending.usage.map((value, index) => Math.max(value, message.usage[index])) as ClaudeMessage['usage'];
    return null;
  }
  state.pending = message;
  return pending ? claudeEvent(pending, context) : null;
}
/** Emits the pending message once its transcript went idle. */
export function claudeFlush(state: ClaudeFileState, context: LogContext): UsageEvent | null {
  const pending = state.pending;
  delete state.pending;
  return pending ? claudeEvent(pending, context) : null;
}
