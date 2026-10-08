import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { redactionRegistryFromWorkerSnapshot } from "./safety/SecretRedaction.ts";

interface WorkerReply { requestId: number; ok: boolean; value?: unknown; error?: string }

/**
 * Raw output is kept outside the V8 heap: one-byte text as latin1 bytes, other text as UTF-16. The worker runs with a
 * small heap limit, and 16M retained characters as heap strings left most of that limit (and its garbage-collection
 * slack) to the history alone.
 */
type Chunk = { data: Buffer; wide: boolean; length: number; start: number; owner: History; sessionNext: Chunk | null; globalPrevious: Chunk | null; globalNext: Chunk | null };
type AnsiState = "text" | "escape" | "csi" | "osc" | "osc-escape" | "string" | "string-escape";
/** A masked piece of history, ending at a boundary SecretRedaction proved no match crosses. */
type MaskedSegment = { text: string; sourceEnd: number; newlines: number };
/**
 * The masked copy that search and context read. It is built when a query arrives (never per PTY append): segments
 * up to `frontier` stay valid while output grows, so a query masks only what arrived since the previous one. A new
 * secret set starts a new copy. Pruned raw output drops whole segments from the head.
 */
type MaskedStore = {
  revision: number;
  segments: MaskedSegment[];
  head: number;
  frontier: number;
  /** Absolute offset and line number of the first retained segment (what context reports as its base). */
  viewStart: number;
  lineStart: number;
  /** The masked text after `frontier`, for the source up to `upTo`. */
  tail: { upTo: number; text: string; newlines: number } | null;
  /** Characters held in segments from `head` on. */
  chars: number;
};
type History = {
  head: Chunk | null;
  tail: Chunk | null;
  rawEnd: number;
  nextOffset: number;
  baseOffset: number;
  baseLine: number;
  pruned: boolean;
  /** Constant-space ECMA-48 decoder state; control-string contents are never retained. */
  ansiState: AnsiState;
  masked: MaskedStore | null;
  spill: SpillState | null;
};
type SpillState = { directory: string; file: string | null; fileChars: number; queue: Buffer[]; queuedChars: number };

const MAX_GLOBAL_CHARS = 16_000_000;
const MAX_CHUNK_CHARS = 16_384;
/** Source characters masked per step; far beyond any held value's reach (see windowChars). */
const MASK_WINDOW_CHARS = 1_048_576;
/** Segments shorter than this absorb the next one, so frequent queries do not leave thousands of tiny parts. */
const MIN_SEGMENT_CHARS = 65_536;
/**
 * Masked copies of every session together: a segment straddling a session's pruned start is kept whole, so the copies
 * can exceed the raw history slightly; past this, copies of sessions not being queried are dropped and rebuilt later.
 */
const MAX_MASKED_CHARS = 24_000_000;
const ASCII_NEEDLE = /^[\u0000-\u007f]*$/u;
/** Non-ASCII characters whose lower case holds ASCII letters (dotted I, Kelvin): a line holding one is folded. */
const ASCII_FOLDING_CHARS = /[\u0130\u212a]/u;
const ASCII_FOLD_CHARS = /[A-Z\u0130\u212a]/u;
const WIDE_CHARS = /[^\u0000-\u00ff]/u;
const GAP_MARKER = "[CanvasTTY: terminal output is missing here]\n";
/** Encrypted crash-recovery spill: flushed at most this often, or when this much is queued. */
const SPILL_FLUSH_MS = 1_000;
const SPILL_FLUSH_CHARS = 262_144;
const SPILL_FILE_CHARS = 2_097_152;
const histories = new Map<string, History>();
let globalHead: Chunk | null = null;
let globalTail: Chunk | null = null;
let globalLength = 0;
let secretRevision = -1;
let redactor = redactionRegistryFromWorkerSnapshot([]);
let spill: { root: string; key: Buffer; files: Array<{ path: string; chars: number; owner: string }>; chars: number; sequence: number; timer: NodeJS.Timeout | null } | null = null;

if (typeof process.send !== "function") throw new Error("Terminal output history worker requires an IPC parent.");

process.on("message", (message: any) => {
  if (message?.type === "batch" && Array.isArray(message.items)) {
    // Output, gaps and removals arrive in batches with one acknowledgement each.
    let error: string | undefined;
    for (const item of message.items) {
      const result = handleRequest(item);
      if (!result.reply.ok && error === undefined) error = result.reply.error;
    }
    process.send?.(error === undefined ? { requestId: message.requestId, ok: true } : { requestId: message.requestId, ok: false, error });
    return;
  }
  const result = handleRequest(message);
  process.send?.(result.reply);
  if (result.disconnect) process.disconnect?.();
});

function handleRequest(message: any): { reply: WorkerReply; disconnect: boolean } {
  const id = typeof message?.requestId === "number" ? message.requestId : 0;
  try {
    let value: unknown;
    let disconnect = false;
    switch (message?.type) {
      case "spill":
        configureSpill(message.directory, message.key, message.recover === true);
        value = true;
        break;
      case "secrets":
        if (Number.isSafeInteger(message.revision) && message.revision >= 0 && Array.isArray(message.values)
          && message.values.length <= 32_768 && message.values.every((entry: unknown) => typeof entry === "string" && entry.length <= 65_536)) {
          if (message.revision !== secretRevision) {
            secretRevision = message.revision;
            redactor = redactionRegistryFromWorkerSnapshot(message.values);
            for (const history of histories.values()) history.masked = null;
          }
          value = { revision: secretRevision };
        } else throw new Error("Invalid terminal-history redaction snapshot.");
        break;
      case "append":
        append(message.sessionId, message.data, message.outputOffset);
        value = true;
        break;
      case "gap":
        markGap(message.sessionId, message.outputOffset);
        value = true;
        break;
      case "remove":
        remove(message.sessionId);
        value = true;
        break;
      case "search":
        value = search(message.query, message.sessionIds);
        break;
      case "context":
        value = context(message.sessionId, message.offset);
        break;
      case "close":
        disconnect = true;
        value = true;
        break;
      default:
        throw new Error("Unknown terminal-history operation.");
    }
    return { reply: { requestId: id, ok: true, value }, disconnect };
  } catch (error) {
    return { reply: { requestId: id, ok: false, error: error instanceof Error ? error.message : "Terminal history operation failed." }, disconnect: false };
  }
}

function historyFor(sessionId: string): History {
  let history = histories.get(sessionId);
  if (!history) {
    history = { head: null, tail: null, rawEnd: 0, nextOffset: 0, baseOffset: 0, baseLine: 0, pruned: false, ansiState: "text", masked: null, spill: null };
    histories.set(sessionId, history);
  }
  return history;
}

function append(sessionId: unknown, data: unknown, outputOffset: unknown): void {
  if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 256
    || typeof data !== "string" || data.length > 1_000_000 || !Number.isSafeInteger(outputOffset) || (outputOffset as number) < 0) {
    throw new Error("Invalid terminal output history chunk.");
  }
  const history = historyFor(sessionId);
  const end = outputOffset as number;
  const start = end - data.length;
  if (end <= history.rawEnd) return; // A startup seed and the live PTY stream can cover the same output.
  let suffix = data;
  if (start < history.rawEnd) suffix = data.slice(history.rawEnd - start);
  if (start > history.rawEnd) openGap(sessionId, history);
  const clean = stripAnsi(suffix, history.ansiState);
  history.ansiState = clean.state;
  history.rawEnd = end;
  if (clean.text) appendText(sessionId, history, clean.text);
}

function markGap(sessionId: unknown, outputOffset: unknown): void {
  if (typeof sessionId !== "string" || !Number.isSafeInteger(outputOffset) || (outputOffset as number) < 0) throw new Error("Invalid terminal history gap.");
  const history = historyFor(sessionId);
  if ((outputOffset as number) > history.rawEnd) {
    openGap(sessionId, history);
    history.rawEnd = outputOffset as number;
  }
}

/** Lost output: the history says so where it happened, and search reports the session as incomplete. */
function openGap(sessionId: string, history: History): void {
  history.ansiState = "text";
  history.pruned = true;
  if (history.nextOffset > 0) appendText(sessionId, history, history.tail && lastChar(history.tail) !== "\n" ? `\n${GAP_MARKER}` : GAP_MARKER);
}

function lastChar(chunk: Chunk): string {
  return chunk.wide ? chunk.data.toString("utf16le", chunk.data.length - 2) : chunk.data.toString("latin1", chunk.data.length - 1);
}

function appendText(sessionId: string, history: History, text: string): void {
  for (let cursor = 0; cursor < text.length;) {
    const part = text.length <= MAX_CHUNK_CHARS && cursor === 0 ? text : text.slice(cursor, cursor + MAX_CHUNK_CHARS);
    const wide = WIDE_CHARS.test(part);
    const chunk: Chunk = { data: Buffer.from(part, wide ? "utf16le" : "latin1"), wide, length: part.length, start: history.nextOffset,
      owner: history, sessionNext: null, globalPrevious: globalTail, globalNext: null };
    if (history.tail) history.tail.sessionNext = chunk;
    else history.head = chunk;
    history.tail = chunk;
    if (globalTail) globalTail.globalNext = chunk;
    else globalHead = chunk;
    globalTail = chunk;
    history.nextOffset += part.length;
    globalLength += part.length;
    cursor += part.length;
    queueSpill(sessionId, history, chunk);
  }
  // A whole append is queued by now, so a record never claims PTY output it does not hold.
  if (history.spill && history.spill.queuedChars >= SPILL_FLUSH_CHARS) flushHistorySpill(history.spill);
  while (globalLength > MAX_GLOBAL_CHARS && globalHead) pruneChunk(globalHead);
}

function pruneChunk(chunk: Chunk): void {
  const owner = chunk.owner;
  owner.baseOffset = chunk.start + chunk.length;
  owner.baseLine += countNewlines(decode(chunk));
  owner.pruned = true;
  globalLength -= chunk.length;
  // Global eviction always removes the oldest remaining block of its session.
  owner.head = chunk.sessionNext;
  if (!owner.head) owner.tail = null;
  globalHead = chunk.globalNext;
  if (globalHead) globalHead.globalPrevious = null;
  else globalTail = null;
  chunk.sessionNext = null;
  chunk.globalNext = null;
}

function remove(sessionId: unknown): void {
  if (typeof sessionId !== "string") return;
  const history = histories.get(sessionId);
  if (!history) return;
  for (let chunk = history.head; chunk;) {
    const next = chunk.sessionNext;
    globalLength -= chunk.length;
    if (chunk.globalPrevious) chunk.globalPrevious.globalNext = chunk.globalNext;
    else globalHead = chunk.globalNext;
    if (chunk.globalNext) chunk.globalNext.globalPrevious = chunk.globalPrevious;
    else globalTail = chunk.globalPrevious;
    chunk.globalPrevious = null;
    chunk.globalNext = null;
    chunk.sessionNext = null;
    chunk = next;
  }
  histories.delete(sessionId);
  dropSpill(sessionId);
}

function decode(chunk: Chunk): string { return chunk.data.toString(chunk.wide ? "utf16le" : "latin1"); }

/** The retained source text in [from, to), joined from at most one window's chunks. */
function collectText(history: History, from: number, to: number): string {
  const parts: string[] = [];
  for (let chunk = history.head; chunk && chunk.start < to; chunk = chunk.sessionNext) {
    const chunkEnd = chunk.start + chunk.length;
    if (chunkEnd <= from) continue;
    const text = decode(chunk);
    parts.push(from > chunk.start || to < chunkEnd ? text.slice(Math.max(0, from - chunk.start), Math.min(chunk.length, to - chunk.start)) : text);
  }
  return parts.length === 1 ? parts[0]! : parts.join("");
}

/** Bring a history's masked copy up to its newest output; returns the parts search and context read. */
function maskedView(history: History): { parts: string[]; start: number; line: number; store: MaskedStore } {
  let store = history.masked;
  if (!store || store.revision !== secretRevision) store = history.masked = freshStore(history);
  while (store.head < store.segments.length && store.segments[store.head]!.sourceEnd <= history.baseOffset) {
    const dropped = store.segments[store.head++]!;
    store.chars -= dropped.text.length;
    store.viewStart += dropped.text.length;
    store.lineStart += dropped.newlines;
  }
  if (store.head > 64 && store.head * 2 > store.segments.length) {
    store.segments = store.segments.slice(store.head);
    store.head = 0;
  }
  if (store.frontier < history.baseOffset) {
    // Output newer than the last query was pruned before it was masked: continue from what is retained.
    const restart = freshStore(history);
    store.viewStart += Math.max(0, restart.viewStart - store.frontier);
    store.frontier = restart.frontier;
    store.lineStart = Math.max(store.lineStart, restart.lineStart);
    store.tail = null;
  }
  const window = windowChars();
  while (store.frontier < history.nextOffset) {
    const end = Math.min(history.nextOffset, store.frontier + window);
    const text = collectText(history, store.frontier, end);
    let cut = 0;
    let masked = "";
    const stable = redactor.redactStablePrefix(text);
    if (stable.sourceLength > 0) {
      cut = stable.sourceLength;
      masked = stable.maskedText;
    } else if (text.length >= window) {
      // A whole window without a line start that is safe to cut at (one line of megabytes).
      const forced = redactor.forcedBoundary(text, text.length - 1);
      if (forced !== null) {
        cut = forced;
        masked = redactor.redact(text.slice(0, forced));
      }
    }
    if (cut <= 0) break;
    const previous = store.segments.length > store.head ? store.segments[store.segments.length - 1]! : null;
    if (previous && previous.text.length < MIN_SEGMENT_CHARS) {
      previous.text += masked;
      previous.sourceEnd = store.frontier + cut;
      previous.newlines += countNewlines(masked);
    } else store.segments.push({ text: masked, sourceEnd: store.frontier + cut, newlines: countNewlines(masked) });
    store.chars += masked.length;
    store.frontier += cut;
    store.tail = null;
  }
  if (store.frontier < history.nextOffset) {
    if (store.tail?.upTo !== history.nextOffset) {
      const text = redactor.redact(collectText(history, store.frontier, history.nextOffset));
      store.tail = { upTo: history.nextOffset, text, newlines: countNewlines(text) };
    }
  } else store.tail = null;
  const parts: string[] = [];
  for (let index = store.head; index < store.segments.length; index++) parts.push(store.segments[index]!.text);
  if (store.tail?.text) parts.push(store.tail.text);
  return { parts, start: store.viewStart, line: store.lineStart, store };
}

/** Where masking may begin: at the retained start, or after its first line break when older output was cut off. */
function freshStore(history: History): MaskedStore {
  let frontier = history.baseOffset;
  let lineStart = history.baseLine;
  if (history.baseOffset > 0 && history.head) {
    // Pruning cuts at arbitrary characters; a key cut in half there would no longer be recognised.
    const lookahead = collectText(history, history.baseOffset, Math.min(history.nextOffset, history.baseOffset + 65_536));
    const newline = lookahead.indexOf("\n");
    if (newline >= 0) {
      frontier += newline + 1;
      lineStart += 1;
    }
  }
  return { revision: secretRevision, segments: [], head: 0, frontier, viewStart: frontier, lineStart, tail: null, chars: 0 };
}

function windowChars(): number { return Math.max(MASK_WINDOW_CHARS, 2 * redactor.lookahead() + 65_536); }

/** Drop other sessions' masked copies (oldest sessions first) while all copies exceed their budget. */
function boundMaskedCopies(keep: History): void {
  let total = 0;
  for (const history of histories.values()) total += history.masked?.chars ?? 0;
  for (const history of histories.values()) {
    if (total <= MAX_MASKED_CHARS) return;
    if (history === keep || !history.masked) continue;
    total -= history.masked.chars;
    history.masked = null;
  }
}

type Match = { sessionId: string; line: number; text: string; offset: number };

function search(query: unknown, requested: unknown): { matches: Match[]; prunedSessionIds: string[] } {
  if (typeof query !== "string" || query.length > 200 || !query.trim() || query.includes("\n") || query.includes("\r")) return { matches: [], prunedSessionIds: [] };
  if (requested !== undefined && requested !== null && (!Array.isArray(requested) || requested.length > 256 || requested.some((id) => typeof id !== "string"))) throw new Error("Invalid terminal output search scope.");
  const allowed = Array.isArray(requested) ? new Set<string>(requested) : null;
  const matches: Match[] = [];
  const needle = query.toLocaleLowerCase();
  const asciiNeedle = ASCII_NEEDLE.test(needle);
  const prunedSessionIds = [...histories].filter(([id, history]) => (!allowed || allowed.has(id)) && history.pruned).map(([id]) => id);
  for (const [sessionId, history] of histories) {
    if (allowed && !allowed.has(sessionId)) continue;
    const view = maskedView(history);
    boundMaskedCopies(history);
    searchView(view.parts, view.line, needle, asciiNeedle, (line, text, offset) => {
      matches.push({ sessionId, line, text, offset });
      return matches.length < 100;
    });
    if (matches.length >= 100) break;
  }
  return { matches, prunedSessionIds };
}

/**
 * Report each line holding the needle once, in order. Parts are scanned in place with a case-insensitive pattern;
 * no line or whole-session copy is made except for parts that hold characters whose lower case differs from what
 * the pattern folds (they take the line-by-line path).
 */
function searchView(parts: string[], firstLine: number, needle: string, asciiNeedle: boolean, report: (line: number, text: string, offset: number) => boolean): void {
  if (!asciiNeedle || parts.some(part => ASCII_FOLDING_CHARS.test(part))) {
    // Unicode folding (and the few non-ASCII letters that fold to ASCII) goes line by line, as before.
    forEachLine(parts, (text, line, offset) => {
      const folded = asciiNeedle && !ASCII_FOLD_CHARS.test(text) ? text : text.toLocaleLowerCase();
      return !folded.includes(needle) || report(line, text.slice(0, 500), offset);
    }, firstLine);
    return;
  }
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gi");
  const starts: number[] = [];
  let total = 0;
  for (const part of parts) { starts.push(total); total += part.length; }
  let line = firstLine;
  let counted = 0;
  let lastLineStart = -1;
  const reportAt = (position: number): boolean => {
    if (position > counted) {
      line += countNewlinesIn(parts, starts, counted, position);
      counted = position;
    }
    const lineStart = lineStartAt(parts, starts, position);
    if (lineStart === lastLineStart) return true;
    lastLineStart = lineStart;
    const lineEnd = lineEndAt(parts, starts, position, total);
    return report(line, sliceParts(parts, starts, lineStart, Math.min(lineEnd, lineStart + 500)), lineStart);
  };
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const base = starts[index]!;
    pattern.lastIndex = 0;
    for (let found = pattern.exec(part); found; found = pattern.exec(part)) {
      if (!reportAt(base + found.index)) return;
      // One result per line: continue after this line.
      const next = part.indexOf("\n", found.index);
      if (next < 0) break;
      pattern.lastIndex = next + 1;
    }
    // A match may run over the joint with the next part.
    if (index + 1 < parts.length && needle.length > 1) {
      const from = Math.max(base, base + part.length - needle.length + 1);
      const at = sliceParts(parts, starts, from, Math.min(total, base + part.length + needle.length - 1)).toLowerCase().indexOf(needle);
      if (at >= 0 && from + at < base + part.length && !reportAt(from + at)) return;
    }
  }
}

function partIndexAt(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

function lineStartAt(parts: string[], starts: number[], position: number): number {
  let index = partIndexAt(starts, position);
  let local = position - starts[index]! - 1;
  for (; index >= 0; index--) {
    if (local >= 0) {
      const found = parts[index]!.lastIndexOf("\n", local);
      if (found >= 0) return starts[index]! + found + 1;
    }
    if (index > 0) local = parts[index - 1]!.length - 1;
  }
  return 0;
}

function lineEndAt(parts: string[], starts: number[], position: number, total: number): number {
  for (let index = partIndexAt(starts, position); index < parts.length; index++) {
    const part = parts[index]!;
    const found = part.indexOf("\n", Math.max(0, position - starts[index]!));
    if (found >= 0) return starts[index]! + found;
  }
  return total;
}

function sliceParts(parts: string[], starts: number[], from: number, to: number): string {
  if (to <= from) return "";
  const pieces: string[] = [];
  for (let index = partIndexAt(starts, from); index < parts.length && starts[index]! < to; index++) {
    const part = parts[index]!;
    pieces.push(part.slice(Math.max(0, from - starts[index]!), Math.min(part.length, to - starts[index]!)));
  }
  return pieces.join("");
}

function countNewlinesIn(parts: string[], starts: number[], from: number, to: number): number {
  if (to <= from) return 0;
  let count = 0;
  for (let index = partIndexAt(starts, from); index < parts.length && starts[index]! < to; index++) {
    const part = parts[index]!;
    count += countNewlines(part, Math.max(0, from - starts[index]!), Math.min(part.length, to - starts[index]!));
  }
  return count;
}

function context(sessionId: unknown, offset: unknown): { text: string; firstLine: number; targetLine: number; historyTruncated: boolean; historyBaseOffset: number } {
  if (typeof sessionId !== "string" || !Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error("Invalid terminal output context request.");
  const history = histories.get(sessionId);
  if (!history) return { text: "", firstLine: 0, targetLine: 0, historyTruncated: false, historyBaseOffset: 0 };
  const view = maskedView(history);
  const starts: number[] = [];
  let total = 0;
  for (const part of view.parts) { starts.push(total); total += part.length; }
  const target = Math.min(total, offset as number);
  // The start of the line holding the character 4 000 before the target (a line break there counts as its end).
  const start = total === 0 ? 0 : lineStartAt(view.parts, starts, Math.min(total, Math.max(0, target - 4_000) + 1));
  const end = Math.min(total, target + 4_000);
  const firstLine = view.line + countNewlinesIn(view.parts, starts, 0, start);
  const targetLine = firstLine + countNewlinesIn(view.parts, starts, start, target);
  return { text: sliceParts(view.parts, starts, start, end), firstLine, targetLine, historyTruncated: history.pruned, historyBaseOffset: view.start };
}

/** Walk masked parts line by line; whole-session strings are never joined. */
function forEachLine(parts: string[], visit: (text: string, line: number, offset: number) => boolean, firstLine: number): boolean {
  let line = firstLine;
  let lineStart = 0;
  let pendingLine = "";
  for (const part of parts) {
    let cursor = 0;
    for (;;) {
      const end = part.indexOf("\n", cursor);
      if (end < 0) break;
      const text = pendingLine + part.slice(cursor, end);
      if (!visit(text, line, lineStart)) return false;
      lineStart += text.length + 1;
      line++;
      pendingLine = "";
      cursor = end + 1;
    }
    pendingLine += part.slice(cursor);
  }
  if (pendingLine && !visit(pendingLine, line, lineStart)) return false;
  return true;
}

function countNewlines(text: string, start = 0, end = text.length): number {
  let count = 0;
  for (let at = text.indexOf("\n", start); at >= 0 && at < end; at = text.indexOf("\n", at + 1)) count++;
  return count;
}

// ---- crash-recovery spill ----

/**
 * Output is also appended, encrypted with a key that exists only in the host's memory, to bounded files in a
 * private directory. A restarted worker reads them back, so a crash does not lose the older searchable history.
 * The files are useless once the host is gone; the host deletes them on quit and a fresh start wipes them.
 */
function configureSpill(directory: unknown, key: unknown, recover: boolean): void {
  if (typeof directory !== "string" || !directory || !(key instanceof Uint8Array) || key.length !== 32) throw new Error("Invalid terminal history spill.");
  spill = { root: directory, key: Buffer.from(key), files: [], chars: 0, sequence: 0, timer: null };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!recover) {
    for (const entry of readdirSync(directory)) rmSync(join(directory, entry), { recursive: true, force: true });
    return;
  }
  const files: Array<{ path: string; owner: string; sequence: number }> = [];
  for (const owner of readdirSync(directory)) {
    if (!/^[0-9a-f]{32}$/u.test(owner)) continue;
    for (const name of readdirSync(join(directory, owner))) {
      const match = /^(\d{1,15})\.bin$/u.exec(name);
      if (match) files.push({ path: join(directory, owner, name), owner, sequence: Number(match[1]) });
    }
  }
  files.sort((left, right) => left.sequence - right.sequence);
  for (const file of files) {
    let chars = 0;
    try { chars = replaySpillFile(file.path); }
    catch { /* An unreadable or truncated file holds no recoverable output. */ }
    spill.files.push({ path: file.path, chars, owner: file.owner });
    spill.chars += chars;
    spill.sequence = Math.max(spill.sequence, file.sequence + 1);
  }
  for (const history of histories.values()) history.spill = null; // new output goes to new files
  pruneSpill();
}

function replaySpillFile(path: string): number {
  const data = readFileSync(path);
  let chars = 0;
  for (let at = 0; at + 32 <= data.length;) {
    const length = data.readUInt32LE(at);
    if (at + 32 + length > data.length) break;
    const decipher = createDecipheriv("aes-256-gcm", spill!.key, data.subarray(at + 4, at + 16));
    decipher.setAuthTag(data.subarray(at + 16, at + 32));
    const plain = Buffer.concat([decipher.update(data.subarray(at + 32, at + 32 + length)), decipher.final()]);
    at += 32 + length;
    for (let entry = 0; entry < plain.length;) {
      const headerEnd = plain.indexOf(10, entry);
      if (headerEnd < 0) break;
      const header = JSON.parse(plain.subarray(entry, headerEnd).toString("utf8")) as { id: string; s: number; p: number; a: AnsiState; w: boolean; n: number; g?: boolean };
      if (typeof header.id !== "string" || !Number.isSafeInteger(header.s) || !Number.isSafeInteger(header.p) || !Number.isSafeInteger(header.n)) break;
      const text = plain.subarray(headerEnd + 1, headerEnd + 1 + header.n).toString(header.w ? "utf16le" : "latin1");
      entry = headerEnd + 1 + header.n;
      chars += replayEntry(header, text);
    }
  }
  return chars;
}

function replayEntry(header: { id: string; s: number; p: number; a: AnsiState; g?: boolean }, text: string): number {
  const history = historyFor(header.id);
  if (header.s < history.nextOffset) return 0;
  if (header.s > history.nextOffset) {
    // Older output of this session was pruned before the crash.
    if (!history.head && history.nextOffset === 0) { history.nextOffset = header.s; history.baseOffset = header.s; }
    history.pruned = true;
  }
  if (header.g) history.pruned = true;
  const spilling = spill;
  spill = null; // replayed text is already on disk
  try { if (text) appendText(header.id, history, text); }
  finally { spill = spilling; }
  history.rawEnd = Math.max(history.rawEnd, header.p);
  history.ansiState = header.a;
  return text.length;
}

/** Queue a retained chunk's own bytes, with where it belongs; nothing is copied until the flush encrypts it. */
function queueSpill(sessionId: string, history: History, chunk: Chunk): void {
  if (!spill) return;
  const state = history.spill ??= { directory: join(spill.root, ownerKey(sessionId)), file: null, fileChars: 0, queue: [], queuedChars: 0 };
  state.queue.push(Buffer.from(`${JSON.stringify({ id: sessionId, s: chunk.start, p: history.rawEnd, a: history.ansiState, w: chunk.wide, n: chunk.data.length,
    ...(history.pruned ? { g: true } : {}) })}\n`, "utf8"), chunk.data);
  state.queuedChars += chunk.length;
  if (!spill.timer) {
    spill.timer = setTimeout(flushSpill, SPILL_FLUSH_MS);
    spill.timer.unref?.();
  }
}

function flushSpill(): void {
  if (!spill) return;
  if (spill.timer) clearTimeout(spill.timer);
  spill.timer = null;
  for (const history of histories.values()) if (history.spill?.queue.length) flushHistorySpill(history.spill);
}

/** One authenticated record per flush: length, IV, tag, then the queued entries (a header line and its bytes each). */
function flushHistorySpill(state: SpillState): void {
  if (!spill || !state.queue.length) return;
  try {
    if (!state.file || state.fileChars >= SPILL_FILE_CHARS) {
      mkdirSync(state.directory, { recursive: true, mode: 0o700 });
      state.file = join(state.directory, `${spill.sequence++}.bin`);
      state.fileChars = 0;
      spill.files.push({ path: state.file, chars: 0, owner: state.directory });
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", spill.key, iv);
    const pieces: Buffer[] = [Buffer.alloc(4), iv, Buffer.alloc(16)];
    let length = 0;
    for (const piece of state.queue) {
      const encrypted = cipher.update(piece);
      pieces.push(encrypted);
      length += encrypted.length;
    }
    const final = cipher.final();
    pieces.push(final);
    length += final.length;
    pieces[0]!.writeUInt32LE(length);
    pieces[2] = cipher.getAuthTag();
    appendFileSync(state.file, Buffer.concat(pieces), { mode: 0o600 });
    const entry = spill.files.find(file => file.path === state.file);
    if (entry) entry.chars += state.queuedChars;
    state.fileChars += state.queuedChars;
    spill.chars += state.queuedChars;
  } catch {
    // Recovery is best effort; search keeps working from memory.
  }
  state.queue = [];
  state.queuedChars = 0;
  pruneSpill();
}

/** Keep about as much on disk as in memory: drop the oldest files first. */
function pruneSpill(): void {
  if (!spill) return;
  while (spill.chars > MAX_GLOBAL_CHARS + SPILL_FILE_CHARS && spill.files.length > 1) {
    const oldest = spill.files.shift()!;
    spill.chars -= oldest.chars;
    try { unlinkSync(oldest.path); } catch { /* already gone */ }
    for (const history of histories.values()) if (history.spill?.file === oldest.path) history.spill.file = null;
  }
}

function dropSpill(sessionId: string): void {
  if (!spill) return;
  const directory = join(spill.root, ownerKey(sessionId));
  spill.files = spill.files.filter(file => {
    if (!file.path.startsWith(`${directory}/`) && !file.path.startsWith(`${directory}\\`)) return true;
    spill!.chars -= file.chars;
    return false;
  });
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
}

function ownerKey(sessionId: string): string { return createHash("sha256").update(sessionId).digest("hex").slice(0, 32); }

/** Strip ECMA-48 terminal controls with constant-space state across PTY chunks. */
function stripAnsi(source: string, initialState: AnsiState): { text: string; state: AnsiState } {
  // PTYs mostly emit ordinary text: keep the batch as it is when it holds no control at all.
  const input = source;
  if (initialState === "text" && !CONTROL_START.test(input)) return { text: input, state: "text" };
  if (initialState === "text") {
    // Colour and cursor sequences are the bulk of controls: drop complete ones natively. When they were the only
    // controls, this is exactly what the decoder below yields; otherwise it decodes the original batch.
    const withoutCsi = input.replace(COMPLETE_CSI, "");
    if (!CONTROL_START.test(withoutCsi)) return { text: withoutCsi, state: "text" };
  }
  let state = initialState;
  const visible: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    if (state === "text") {
      // Jump over ordinary text natively instead of visiting each character.
      CONTROL_SCAN.lastIndex = cursor;
      const found = CONTROL_SCAN.exec(input);
      const at = found ? found.index : input.length;
      if (at > cursor) visible.push(input.slice(cursor, at));
      if (!found) break;
      const code = input.charCodeAt(at);
      state = code === 0x1b ? "escape" : code === 0x9b ? "csi" : code === 0x9d ? "osc" : code === 0x9c ? "text" : "string";
      cursor = at + 1;
      continue;
    }
    const code = input.charCodeAt(cursor++);
    switch (state) {
      case "escape":
        if (code === 0x5b) state = "csi";
        else if (code === 0x5d) state = "osc";
        else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) state = "string";
        else state = "text"; // Unsupported two-byte ESC controls are discarded.
        break;
      case "csi":
        if (code >= 0x40 && code <= 0x7e) state = "text";
        break;
      case "osc":
        if (code === 0x07 || code === 0x9c) state = "text";
        else if (code === 0x1b) state = "osc-escape";
        break;
      case "osc-escape":
        if (code === 0x5c) state = "text";
        else state = code === 0x1b ? "osc-escape" : "osc";
        break;
      case "string":
        if (code === 0x9c) state = "text";
        else if (code === 0x1b) state = "string-escape";
        break;
      case "string-escape":
        if (code === 0x5c) state = "text";
        else state = code === 0x1b ? "string-escape" : "string";
        break;
    }
  }
  return { text: visible.length === 1 ? visible[0]! : visible.join(""), state };
}
const CONTROL_START = /[\u001b\u0090\u0098\u009b\u009c\u009d\u009e\u009f]/u;
/** ESC [ or CSI, parameter bytes, intermediate bytes, a final byte (ECMA-48 5.4). */
const COMPLETE_CSI = /(?:\u001b\[|\u009b)[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]/gu;
const CONTROL_SCAN = /[\u001b\u0090\u0098\u009b\u009c\u009d\u009e\u009f]/gu;
