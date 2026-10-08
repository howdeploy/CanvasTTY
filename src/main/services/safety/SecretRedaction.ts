/**
 * The secret redaction registry (EP-8): every text the core hands to another agent (canvastty_agents
 * observe/result, the control CLI's screen, result and failure details) passes through `redact` first.
 * Always on; nothing switches it off. It never touches what a person or an agent writes *to* an agent.
 *
 * 1. Known values: keys from the provider secret vault as this process reads them, plugin `secretEnv` values
 *    of open cards, and values a trusted plugin service registers. Each is removed where it stands, also when
 *    the terminal's wrapping put a line break, indentation or a box side between its characters, and in its
 *    JSON-escaped form. They are found by a linear search over the text with those gaps taken out, never by a
 *    pattern built from the value: a pattern for a key of a few thousand characters exceeds what the regular
 *    expression engine accepts, and the error broke every masking call. A value that holds wrap characters of
 *    its own is also searched exactly as written, so it is masked even when too few characters remain without
 *    them for the wrap-tolerant search, or when its own gaps are wider than a wrap gap.
 * 2. JSON string values under key-like names (`"apiKey"`, `"token"`, `"authorization"`, …), across lines too.
 * 3. Generic shapes: PEM private keys, `sk-…`, GitHub, Slack, AWS, Google, xAI tokens, JWTs, `Bearer …`,
 *    `Authorization:` values, URL credentials, secret-looking query values and assignments, and long
 *    high-entropy runs.
 *
 * Each match becomes `<redacted:…>`. Idempotent: a marker is never masked again. Values live in memory only
 * and are never logged, sent or shown.
 */

/** Shorter values are not keys, and removing them would only garble ordinary text. */
const MIN_SECRET_CHARS = 8;
/** Long enough for a PEM key or a service-account JSON; the search costs the same for any length. */
const MAX_SECRET_CHARS = 65_536;
const MAX_NATIVE_INDEXOF_PATTERN_CHARS = 128;
const MAX_VALUES_PER_OWNER = 64;
const MAX_OWNERS = 512;
/** What wrapping may put between two characters of a key: whitespace and line breaks, box-drawing sides. */
const MAX_WRAP_GAP = 64;
/**
 * redactTail masks a window that starts about this far before the tail it returns, so that masking, which can
 * shorten the text, still leaves at least the tail after the window's start.
 */
const TAIL_MARGIN_CHARS = 16_384;
/**
 * How much further back than the margin redactTail looks for a line start no match can cross (see
 * safeWindowStart); where there is none, it masks the whole text.
 */
const TAIL_SEARCH_CHARS = 65_536;
/** How far back forcedBoundary looks for a cut, and how far around it it checks that no match crosses. */
const FORCED_SEARCH_CHARS = 65_536;
const FORCED_REACH_CHARS = 262_144;
/** The longest value JSON_SECRET_VALUE takes, the one rule whose value may run over a line break. */
const JSON_VALUE_MAX_CHARS = 2_048;
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/gu;
const PRIVATE_KEY_FOOTER = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/gu;
const PRIVATE_KEY_HEADER_TEXT = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/u;
const JSON_SECRET_VALUE = /("(?:[A-Za-z0-9_.-]{0,40}(?:api[_-]?key|token|secret|password|authorization))"\s*:\s*")(?!<redacted:)[^"]{1,2048}("?)/giu;

/** The search forms of the held values. */
type KnownForms = {
  /** Each value and its JSON-escaped form without wrap characters, when at least MIN_SECRET_CHARS remain. */
  bare: readonly string[];
  /** Each value and JSON-escaped form that holds wrap characters, exactly as written. */
  exact: readonly string[];
  /** A held value holds a PEM armour line (`-----`): masking it can change where a private-key block ends. */
  armour: boolean;
};
const NO_FORMS: KnownForms = { bare: [], exact: [], armour: false };

/** An owner's kind for a log line (`plugin`, `session`, `vault`), without its id. */
function ownerKind(owner: string): string {
  return owner.split(':')[0] || 'an owner';
}

export class SecretRedactionRegistry {
  private readonly owners = new Map<string, Set<string>>();
  private forms: KnownForms = NO_FORMS;
  /** The longest text one held value can match: its characters plus a full wrap gap between each two. */
  private knownSpan = 0;
  private dirty = false;
  private workerRevision=0;

  /** Host-private mirror for the trusted search worker. Never send this snapshot to a renderer or plugin. */
  snapshotForWorker():{revision:number;values:string[]}{
    return {revision:this.workerRevision,values:[...new Set([...this.owners.values()].flatMap(values=>[...values]))]};
  }

  /**
   * Adds values under an owner (`vault`, `session:<id>`, `plugin:<id>`); short or oversized values are ignored.
   * An owner holds its 64 most recently added values: adding a held value again makes it the newest, so a key that
   * is still read (the vault adds each key it reads) is never the one dropped for a new value. A drop or a refused
   * owner is logged (never the value), not silent.
   */
  add(owner: string, values: Iterable<string>): void {
    let set = this.owners.get(owner);
    for (const value of values) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed.length < MIN_SECRET_CHARS || trimmed.length > MAX_SECRET_CHARS) continue;
      if (!set) {
        if (this.owners.size >= MAX_OWNERS) {
          console.warn(`CanvasTTY secret masking holds ${MAX_OWNERS} owners; values of ${ownerKind(owner)} are not masked.`);
          return;
        }
        set = new Set();
        this.owners.set(owner, set);
      }
      if (set.delete(trimmed)) {
        set.add(trimmed);
        continue;
      }
      if (set.size >= MAX_VALUES_PER_OWNER) {
        set.delete(set.values().next().value!);
        console.warn(`CanvasTTY secret masking holds ${MAX_VALUES_PER_OWNER} values per owner; the least recently added value of ${ownerKind(owner)} is no longer masked.`);
      }
      set.add(trimmed);
      this.dirty = true;
      this.workerRevision++;
    }
  }

  /** Forgets an owner's values (a card closed, a plugin stopped). */
  clear(owner: string): void {
    if (this.owners.delete(owner)){this.dirty = true;this.workerRevision++;}
  }

  redact(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
    const forms = this.knownForms();
    // With no held values there is no structural text for a known match to erase, so reuse the direct generic
    // pipeline instead of allocating and merging empty-registry source-range streams on ordinary output.
    if (forms.bare.length === 0 && forms.exact.length === 0) return redactJsonAndCredentials(text);
    return redactKnownAndCredentials(text, forms);
  }

  /**
   * Masks a prefix that can be separated from any later text without changing whole-text redaction. The boundary
   * is a line start that `safeWindowStart` proves no current rule crosses, with enough lookahead to rule out a
   * held value that might only finish in a later append. Callers retain and rescan the returned raw suffix.
   *
   * A line without a safe boundary, an open PEM block, or an unusually long held value can leave a large suffix
   * pending. That is intentional: callers must use whole-suffix redaction in that worst case rather than masking
   * chunks independently and risking a partial secret.
   */
  redactStablePrefix(text: string): { sourceLength: number; maskedText: string } {
    if (typeof text !== 'string' || text.length === 0) return { sourceLength: 0, maskedText: '' };
    const forms = this.knownForms();
    // Known-value masking can remove a PEM footer before the generic PEM pass. A boundary inferred from the raw
    // footer would then separate text that the complete masking pass treats as one open private-key block.
    if (forms.armour && PRIVATE_KEY_HEADER_TEXT.test(text)) return { sourceLength: 0, maskedText: '' };
    if (text.length <= this.knownSpan) return { sourceLength: 0, maskedText: '' };
    const desired = Math.min(text.length - this.knownSpan, openPrivateKeyStart(text) ?? text.length);
    const boundary = safeWindowStart(text, desired, forms, this.knownSpan);
    if (boundary === null || boundary <= 0) return { sourceLength: 0, maskedText: '' };
    return { sourceLength: boundary, maskedText: this.redact(text.slice(0, boundary)) };
  }

  /** How much text after a cut redactStablePrefix and forcedBoundary need to judge it: window sizing for callers. */
  lookahead(): number {
    this.knownForms();
    return Math.max(this.knownSpan, FORCED_REACH_CHARS) + 4_096;
  }

  /**
   * For text with no safe line start (one line of megabytes): a cut at or before `desired` that leaves at least
   * the checked reach after it, at most
   * FORCED_SEARCH_CHARS back, after whitespace or between two non-ASCII characters, outside every private-key block,
   * and crossed by no match of a held value, a JSON value, a rule (its whole match, labels included) or a random run
   * within FORCED_REACH_CHARS of it. Masking the text before the cut and the text from it on separately then masks
   * everything whole-text masking does there; only a single match longer than the reach could still be split. Null
   * when there is no such cut.
   */
  forcedBoundary(text: string, desired: number): number | null {
    if (typeof text !== 'string' || desired <= 0) return null;
    const forms = this.knownForms();
    if (forms.armour && PRIVATE_KEY_HEADER_TEXT.test(text)) return null;
    const open = openPrivateKeyStart(text);
    const reach = Math.max(FORCED_REACH_CHARS, this.knownSpan + 4_096);
    // Text after the cut must be long enough to show any match that would cross it.
    const limit = Math.min(desired, text.length - reach, open ?? Number.MAX_SAFE_INTEGER);
    const floor = Math.max(1, limit - FORCED_SEARCH_CHARS);
    const blocks = privateKeyBlocks(text, limit + 1);
    let spans: Array<[number, number]> = [];
    let windowStart = -1;
    for (let cut = limit; cut >= floor; cut--) {
      const before = text.charCodeAt(cut - 1);
      if (!(WHITESPACE.test(text[cut - 1]!) || (before > 0x7e && text.charCodeAt(cut) > 0x7e))) continue;
      if (blocks.some(([from, to]) => from < cut && cut < to)) continue;
      // The checked window keeps `reach` characters on both sides of every cut it judges.
      if (windowStart < 0 || (windowStart > 0 && cut - reach < windowStart)) {
        windowStart = Math.max(0, cut - 2 * reach);
        spans = matchSpans(text.slice(windowStart, Math.min(text.length, cut + reach)), forms, windowStart);
      }
      if (spans.some(([from, to]) => from < cut && cut < to)) continue;
      return cut;
    }
    return null;
  }

  /**
   * The same text as `redact(text)` cut to its last `maxChars` characters, without masking the whole text: a
   * card's 240 000-character scrollback costs as much as its last `maxChars` plus a margin (wider when a held
   * value could wrap over it). The window starts at a line start that no match of any rule or held value
   * crosses (safeWindowStart), so everything after it masks exactly as in the whole text; where no such line
   * start is near, or masking left less than the tail after it, the whole text is masked.
   */
  redactTail(text: string, maxChars: number): string {
    if (typeof text !== 'string' || text.length === 0 || maxChars <= 0) return '';
    const forms = this.knownForms();
    const margin = Math.max(TAIL_MARGIN_CHARS, 2 * this.knownSpan + 4_096);
    if (text.length <= maxChars + margin) return lastChars(this.redact(text), maxChars);
    // Masking a held value that holds PEM armour can move where a private-key block ends; only the whole text
    // tells where.
    if (forms.armour && PRIVATE_KEY_HEADER_TEXT.test(text)) return lastChars(this.redact(text), maxChars);
    const start = safeWindowStart(text, text.length - maxChars - margin, forms, this.knownSpan);
    if (start === null) return lastChars(this.redact(text), maxChars);
    const masked = this.redact(text.slice(start));
    if (masked.length < maxChars) return lastChars(this.redact(text), maxChars);
    return lastChars(masked, maxChars);
  }

  /** The search forms of every held value; rebuilt only after a change. */
  private knownForms(): KnownForms {
    if (!this.dirty) return this.forms;
    const bare = new Set<string>();
    const exact = new Set<string>();
    let longest = 0;
    let armour = false;
    for (const values of this.owners.values()) {
      for (const value of values) {
        if (value.includes('-----')) armour = true;
        for (const form of [value, JSON.stringify(value).slice(1, -1)]) {
          longest = Math.max(longest, form.length);
          const stripped = withoutWrapCharacters(form);
          // Without its wrap characters, a value that is mostly spaces would leave a fragment that garbles
          // ordinary text; such a value is found as written (below).
          if (stripped.length >= MIN_SECRET_CHARS) bare.add(stripped);
          // Every held form is at least MIN_SECRET_CHARS long as written: the value was trimmed and checked in
          // add(), and escaping only lengthens it.
          if (stripped !== form) exact.add(form);
        }
      }
    }
    const longestFirst = (a: string, b: string): number => b.length - a.length;
    this.forms = { bare: [...bare].sort(longestFirst), exact: [...exact].sort(longestFirst), armour };
    // A form of n characters matches at most n characters plus a full wrap gap between each two.
    this.knownSpan = longest * (MAX_WRAP_GAP + 1);
    this.dirty = false;
    return this.forms;
  }
}

/** Reuses every existing masking rule in the trusted worker, preserving the registry's per-owner capacity. */
export function redactionRegistryFromWorkerSnapshot(values:readonly string[]):SecretRedactionRegistry{
  const registry=new SecretRedactionRegistry();
  for(let i=0;i<values.length;i+=MAX_VALUES_PER_OWNER)registry.add(`worker:${i}`,[...values.slice(i,i+MAX_VALUES_PER_OWNER)]);
  return registry;
}

/** Whitespace (as `\s` has it) and the box-drawing block: what terminal wrapping may put inside a key. */
function isWrapCharacter(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code < 0xa0) return false;
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff || (code >= 0x2500 && code <= 0x257f);
}

function withoutWrapCharacters(text: string): string {
  const pattern = /[\s\u2500-\u257f]/u;
  if (!pattern.test(text)) return text;
  // Global replacement creates a string fragment for every gap. Build flat, bounded pieces instead of
  // retaining millions of newline fragments in the search worker's heap.
  const buffer = new Uint16Array(16_384);
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += buffer.length) {
    const chunk = text.slice(start, start + buffer.length);
    if (!pattern.test(chunk)) {
      parts.push(chunk);
      continue;
    }
    let length = 0;
    for (let at = 0; at < chunk.length; at++) {
      const code = chunk.charCodeAt(at);
      if (!isWrapCharacter(code)) buffer[length++] = code;
    }
    if (length > 0) parts.push(String.fromCharCode(...buffer.subarray(0, length)));
  }
  return parts.join("");
}

/** All held-value matches in start order, keeping only the longest valid match at each start. */
type KnownMatch = { start: number; end: number; kind?: string; priority?: number };
type MatchStream = { iterator: Generator<KnownMatch>; current: KnownMatch };

function* knownMatches(text: string, forms: KnownForms): Generator<KnownMatch> {
  if (forms.bare.length === 0 && forms.exact.length === 0) return;
  const bareText = forms.bare.length ? withoutWrapCharacters(text) : '';
  const hasWrapCharacters = forms.bare.length > 0 && bareText !== text;

  const streams = forms.exact.map(form => candidateOccurrences(text, form));
  if (hasWrapCharacters) streams.push(wrappedMatches(text, bareText, forms.bare));
  else for (const form of forms.bare) streams.push(candidateOccurrences(text, form));
  yield* mergeMatches(streams);
}

/** Merge already ordered hit streams by source start, choosing the longest at each start. */
function* mergeMatches(streams: Generator<KnownMatch>[]): Generator<KnownMatch> {
  const occurrences = orderedOccurrences(streams);
  let next = occurrences.next();
  while (!next.done) {
    const start = next.value.start;
    let end = next.value.end;
    next = occurrences.next();
    while (!next.done && next.value.start === start) {
      end = Math.max(end, next.value.end);
      next = occurrences.next();
    }
    yield { start, end };
  }
}

/** Merge hit streams into start order without discarding same-start candidates. */
function* orderedOccurrences(streams: Generator<KnownMatch>[]): Generator<KnownMatch> {
  if (streams.length === 1) {
    yield* streams[0]!;
    return;
  }
  const heap: MatchStream[] = [];
  const push = (stream: MatchStream): void => {
    let index = heap.length;
    heap.push(stream);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]!.current.start <= stream.current.start) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = stream;
  };
  const pop = (): MatchStream => {
    const first = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && heap[right]!.current.start < heap[left]!.current.start ? right : left;
        if (heap[child]!.current.start >= last.current.start) break;
        heap[index] = heap[child]!;
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  const enqueueFirst = (iterator: Generator<KnownMatch>): void => {
    const next = iterator.next();
    if (!next.done) push({ iterator, current: next.value });
  };
  const advance = (stream: MatchStream): void => {
    const next = stream.iterator.next();
    if (!next.done) {
      stream.current = next.value;
      push(stream);
    }
  };

  for (const iterator of streams) enqueueFirst(iterator);
  while (heap.length > 0) {
    const first = pop();
    const current = first.current;
    advance(first);
    yield current;
  }
}

function* candidateOccurrences(text: string, pattern: string): Generator<KnownMatch> {
  if (pattern.length > MAX_NATIVE_INDEXOF_PATTERN_CHARS) {
    yield* kmpOccurrences(text, pattern);
    return;
  }
  yield* exactOccurrences(text, pattern);
}

function* exactOccurrences(text: string, pattern: string): Generator<KnownMatch> {
  for (let from = 0; from <= text.length - pattern.length;) {
    const start = text.indexOf(pattern, from);
    if (start < 0) return;
    yield { start, end: start + pattern.length };
    // Advancing by one preserves overlapping hits for the leftmost/longest merger.
    from = start + 1;
  }
}

/** Keep worst-case scan cost linear for long patterns whose repetitive near-matches fool native indexOf. */
function* kmpOccurrences(text: string, pattern: string): Generator<KnownMatch> {
  const firstCode = pattern.charCodeAt(0);
  const patternLength = pattern.length;
  const searchPrefix = pattern.slice(0, MAX_NATIVE_INDEXOF_PATTERN_CHARS);
  const prefixLength = searchPrefix.length;
  const firstStart = text.indexOf(searchPrefix);
  if (firstStart < 0) return;

  const failure = kmpFailure(pattern);
  for (let i = firstStart + prefixLength - 1, k = prefixLength - 1; i < text.length; i++) {
    // Skip ordinary spans in native code when no KMP prefix is active. The bounded prefix stays code-unit based.
    if (k === 0) {
      const start = text.indexOf(searchPrefix, i);
      if (start < 0) return;
      i = start + prefixLength - 1;
      k = prefixLength - 1;
    }
    const textCode = text.charCodeAt(i);
    let patternCode = k === 0 ? firstCode : pattern.charCodeAt(k);
    while (k > 0 && textCode !== patternCode) {
      k = failure[k - 1]!;
      patternCode = k === 0 ? firstCode : pattern.charCodeAt(k);
    }
    if (textCode === patternCode) k++;
    if (k === patternLength) {
      yield { start: i - k + 1, end: i + 1 };
      k = failure[k - 1]!;
    }
  }
}

/** Prefix lengths for Knuth-Morris-Pratt. Long candidate patterns use this to retain linear scan cost. */
function kmpFailure(pattern: string): Int32Array {
  const failure = new Int32Array(pattern.length);
  for (let i = 1, k = 0; i < pattern.length; i++) {
    while (k > 0 && pattern.charCodeAt(i) !== pattern.charCodeAt(k)) k = failure[k - 1]!;
    if (pattern.charCodeAt(i) === pattern.charCodeAt(k)) k++;
    failure[i] = k;
  }
  return failure;
}

/**
 * Find wrap-tolerant matches from one shared compact-text merge and one source-offset ring. All bare starts are
 * processed monotonically; a ring as long as the longest form plus one retains every start through the farthest
 * end considered at that start, including overlapping candidates at later starts.
 */
function* wrappedMatches(text: string, bareText: string, patterns: readonly string[]): Generator<KnownMatch> {
  const occurrences = orderedOccurrences(patterns.map(pattern => candidateOccurrences(bareText, pattern)));
  let next = occurrences.next();
  if (next.done) return;

  const longestPattern = patterns[0]!.length; // knownForms sorts patterns longest first
  const ringLength = longestPattern + 1;
  const positions = new Uint32Array(ringLength);
  const oversizedAfter = new Uint32Array(ringLength);
  let raw = 0;
  let bare = 0;
  let previous = -1;
  let oversizedGaps = 0;

  const translate = (start: number, end: number): KnownMatch | null => {
    while (bare < end) {
      const code = text.charCodeAt(raw);
      if (!isWrapCharacter(code)) {
        if (previous >= 0 && raw - previous - 1 > MAX_WRAP_GAP) oversizedGaps++;
        const slot = bare % ringLength;
        positions[slot] = raw;
        oversizedAfter[slot] = oversizedGaps;
        bare++;
        previous = raw;
      }
      raw++;
    }
    const startSlot = start % ringLength;
    const endSlot = (end - 1) % ringLength;
    // Exclude the gap before the first matched character; only interior gaps can invalidate this candidate.
    if (oversizedAfter[endSlot]! - oversizedAfter[startSlot]! > 0) return null;
    return { start: positions[startSlot]!, end: positions[endSlot]! + 1 };
  };

  while (!next.done) {
    const compactStart = next.value.start;
    let rawStart = -1;
    let rawEnd = -1;
    while (!next.done && next.value.start === compactStart) {
      // Check every candidate before selecting the longest. A longer form can cross an oversized gap while a
      // shorter form at the same start remains valid.
      const translated = translate(next.value.start, next.value.end);
      if (translated) {
        rawStart = translated.start;
        rawEnd = Math.max(rawEnd, translated.end);
      }
      next = occurrences.next();
    }
    if (rawEnd >= 0) yield { start: rawStart, end: rawEnd };
  }
}
function lastChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/**
 * Where the window of redactTail may start: the start of a line at or before `desired`, and not more than
 * TAIL_SEARCH_CHARS before it, that no match of a held value or of a rule crosses. From such a line start on,
 * masking the window yields exactly what masking the whole text yields there: every pass (held values, JSON
 * values, each rule) finds the same matches after it, and a lookbehind at it sees a line break in the whole text
 * and the start in the window, which every rule treats alike. Null when there is none.
 *
 * Which matches can run over a line break, and what rules each out at a line start `b`:
 * - a private-key block, from its header to its END or the end of the text: `b` lies in no such block;
 * - a wrapped token or high-entropy run, which goes on over a line break right after a run character, and a
 *   separator's whitespace (`Authorization:`, `Bearer`, `name =`, `"key":`): the last character before `b` that is
 *   not whitespace is none those continue after (a letter, digit, `+ = _ - : " '`, or `>` of `=>`);
 * - a JSON value under a key-like name, up to JSON_VALUE_MAX_CHARS characters of anything but `"`: no such
 *   value is open at `b` (the last `"` before `b` is not preceded by `:`, or lies further back);
 * - a held value, which can hold line breaks: none of their matches crosses `b` or covers the characters the
 *   two checks above read (masking one there could change what they see).
 * Masking before `b` only puts `<redacted:…>` markers there, whose last character `>` none of the above
 * continues after, so the checks hold for every pass, not only on the text as it came.
 */
function safeWindowStart(text: string, desired: number, forms: KnownForms, knownSpan: number): number | null {
  const floor = Math.max(0, desired - TAIL_SEARCH_CHARS);
  const blocks = privateKeyBlocks(text, desired + 1);
  const seen = new Map<number, boolean>();
  let b = lineStartBefore(text, desired - 1, floor);
  while (b > floor) {
    const block = blocks.find(([from, to]) => from < b && b < to);
    if (block) {
      b = lineStartBefore(text, block[0] - 1, floor);
      continue;
    }
    // The last character before `b` that is not whitespace; every line start in the whitespace before it
    // shares it, so the search goes on from its line.
    let last = b - 1;
    while (last >= 0 && WHITESPACE.test(text[last]!)) last--;
    if (isLineStartUncrossed(text, b, last, forms, knownSpan, seen)) return b;
    b = last < 0 ? 0 : lineStartBefore(text, Math.min(last, b - 2), floor);
  }
  return null;
}

/**
 * The start of the line holding `from`, searching no further back than `floor` (which it returns when there is
 * none). A line ends at `\n`, and also at a lone `\r`: a terminal that redraws one row (progress bars, spinners)
 * writes no `\n` at all, and no rule's match runs over a `\r` that a `\n` would end (every class that crosses a
 * line break excludes both or is checked explicitly by isLineStartUncrossed), so the same checks hold there.
 */
function lineStartBefore(text: string, from: number, floor: number): number {
  for (let at = Math.min(from, text.length - 1); at >= floor; at--) {
    const code = text.charCodeAt(at);
    if (code === 0x0a || (code === 0x0d && text.charCodeAt(at + 1) !== 0x0a)) return at + 1;
  }
  return floor;
}

/** The private-key blocks the PEM rule masks that start before `limit`: from each header to its END or the end. */
function privateKeyBlocks(text: string, limit: number): Array<[number, number]> {
  if (!text.includes('-----BEGIN ')) return [];
  const blocks: Array<[number, number]> = [];
  PRIVATE_KEY_HEADER.lastIndex = 0;
  for (;;) {
    const header = PRIVATE_KEY_HEADER.exec(text);
    if (!header || header.index >= limit) return blocks;
    PRIVATE_KEY_FOOTER.lastIndex = header.index + header[0].length;
    const footer = PRIVATE_KEY_FOOTER.exec(text);
    const end = footer ? footer.index + footer[0].length : text.length;
    blocks.push([header.index, end]);
    PRIVATE_KEY_HEADER.lastIndex = end;
  }
}

/** The latest PEM header with no footer yet. Its block remains open when another PTY batch arrives. */
function openPrivateKeyStart(text: string): number | null {
  if (!text.includes('-----BEGIN ')) return null;
  PRIVATE_KEY_HEADER.lastIndex = 0;
  for (;;) {
    const header = PRIVATE_KEY_HEADER.exec(text);
    if (!header) return null;
    PRIVATE_KEY_FOOTER.lastIndex = header.index + header[0].length;
    const footer = PRIVATE_KEY_FOOTER.exec(text);
    if (!footer) return header.index;
    PRIVATE_KEY_HEADER.lastIndex = footer.index + footer[0].length;
  }
}

const WHITESPACE = /\s/u;

/** Whether the `"` at `quote` follows a `:` (whitespace between); answers are kept per search in `seen`. */
function opensJsonValue(text: string, quote: number, seen: Map<number, boolean>): boolean {
  let answer = seen.get(quote);
  if (answer === undefined) {
    let before = quote - 1;
    while (before >= 0 && WHITESPACE.test(text[before]!)) before--;
    answer = before >= 0 && text[before] === ':';
    seen.set(quote, answer);
  }
  return answer;
}
/** Characters after which a wrapped run or a separator's whitespace may go on over a line break. */
const CONTINUED_AFTER = /[A-Za-z0-9+=_\-:"']/u;

/** Characters a header scheme or token may continue with after a separator's whitespace (bearer, authorization). */
const TOKEN_CONTINUATION = /[A-Za-z0-9._~+/=-]/u;
const HEADER_SCHEME = /(?:^|[^A-Za-z])(?:bearer|basic|token|bot)$/iu;

/**
 * Whether a line ending in a letter or digit can still be crossed at `b`. A run of twelve or more (a wrapped token,
 * a random run) only goes on when the next line, after whitespace and at most a box side, starts with a run of four
 * or more that holds a digit, or of eight (a `Bearer` token); a name's separator (`=`, `:`) may come on the next
 * line; and an `Authorization` scheme takes any value. Every other next line ends the match at the line break.
 */
function continuesOverLineBreak(text: string, b: number, last: number): boolean {
  const code = text.charCodeAt(last);
  const alphanumeric = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
  if (!alphanumeric) return true;
  if (HEADER_SCHEME.test(text.slice(Math.max(0, last - 6), last + 1))) return true;
  let next = b;
  while (next < text.length && (WHITESPACE.test(text[next]!) || text[next] === '|' || isBoxDrawing(text.charCodeAt(next)))) next++;
  if (next >= text.length) return true; // what follows is not known yet
  if (text[next] === ':' || text[next] === '=') return true;
  // Wrapped tokens and random runs go on only from a run of twelve or more: every token shape is longer than that,
  // and shorter runs are never judged random.
  let run = 0;
  for (let at = last; at >= 0 && run < 12 && isEntropyRunCharacter(text.charCodeAt(at)); at--) run++;
  if (run < 12) return false;
  let end = next;
  let digit = false;
  while (end < text.length && end - next < 8 && TOKEN_CONTINUATION.test(text[end]!)) {
    const value = text.charCodeAt(end);
    if (value >= 0x30 && value <= 0x39) digit = true;
    end++;
  }
  return end - next >= 8 || (end - next >= 4 && digit);
}

function isBoxDrawing(code: number): boolean { return code >= 0x2500 && code <= 0x257f; }

function isLineStartUncrossed(text: string, b: number, last: number, forms: KnownForms, knownSpan: number, seen: Map<number, boolean>): boolean {
  if (last >= 0 && ((CONTINUED_AFTER.test(text[last]!) && continuesOverLineBreak(text, b, last)) || (text[last] === '>' && text[last - 1] === '='))) return false;
  let quote = text.lastIndexOf('"', b - 1);
  if (quote >= 0 && b - quote <= JSON_VALUE_MAX_CHARS + 2) {
    if (opensJsonValue(text, quote, seen)) return false;
  } else quote = b;
  if (forms.bare.length === 0 && forms.exact.length === 0) return true;
  // Held-value matches that start before `b` lie within knownSpan of it.
  const checkFrom = Math.max(0, Math.min(last, quote));
  const from = Math.max(0, checkFrom - knownSpan);
  const window = text.slice(from, Math.min(text.length, b + knownSpan));
  for (const match of knownMatches(window, forms)) {
    if (from + match.start >= b) break;
    if (from + match.end > checkFrom) return false;
  }
  return true;
}

/** Every candidate match in `window` as whole source spans (labels and separators included), shifted by `offset`. */
function matchSpans(window: string, forms: KnownForms, offset: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of knownMatches(window, forms)) spans.push([offset + match.start, offset + match.end]);
  const json = new RegExp(JSON_SECRET_VALUE.source, JSON_SECRET_VALUE.flags);
  for (let match = json.exec(window); match; match = json.exec(window)) spans.push([offset + match.index, offset + match.index + match[0].length]);
  for (const rule of RULES) {
    if (!rule.pattern) continue;
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    for (let match = pattern.exec(window); match; match = pattern.exec(window)) {
      spans.push([offset + match.index, offset + match.index + match[0].length]);
      if (match[0].length === 0) pattern.lastIndex++;
    }
  }
  for (const range of wrappedEntropyRanges(window)) spans.push([offset + range.start, offset + range.end]);
  for (const range of unwrappedEntropyRanges(window)) spans.push([offset + range.start, offset + range.end]);
  return spans;
}

type Rule = { kind: string; pattern?: RegExp; transform?: (text: string) => string; replace?: (match: string, ...groups: string[]) => string };

const marker = (kind: string): string => `<redacted:${kind}>`;
const NOT_MASKED = '(?!<redacted:)';
/** A terminal line break, with the indentation or box side the next line may start with. */
const LINE_BREAK = '\\r?\\n[ \\t\\u2500-\\u257f|]{0,8}';
const WRAPPED = `(?:${LINE_BREAK}(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{4,})*`;

const RULES: readonly Rule[] = [
  // PEM private-key blocks, including a block cut off before its END line.
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/gu },
  // The same token shapes the repository secret audit checks (scripts/audit-secrets.mjs). A key the terminal
  // wrapped goes on over the line break when the next line's run holds a digit (ordinary words rarely do).
  { kind: 'anthropic', pattern: new RegExp(`(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}${WRAPPED}`, 'gu') },
  { kind: 'openai', pattern: new RegExp(`(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}${WRAPPED}`, 'gu') },
  { kind: 'github', pattern: new RegExp(`(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})${WRAPPED}`, 'gu') },
  { kind: 'slack', pattern: new RegExp(`(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{16,}${WRAPPED}`, 'gu') },
  { kind: 'aws', pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/gu },
  { kind: 'jwt', pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu },
  { kind: 'xai', pattern: new RegExp(`(?<![A-Za-z0-9])xai-[A-Za-z0-9_-]{20,}${WRAPPED}`, 'gu') },
  { kind: 'google', pattern: new RegExp(`(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}${WRAPPED}`, 'gu') },
  // Header values: `Authorization: Bearer …`, `Authorization: Basic …`, and a bare `Bearer …`.
  { kind: 'authorization', pattern: new RegExp(`(\\bAuthorization\\s*[:=]\\s*["']?)${NOT_MASKED}(?:(?:Bearer|Basic|Token|Bot)\\s+)?${NOT_MASKED}[^\\s"'<>]{4,}`, 'giu'), replace: (_match, prefix) => `${prefix}${marker('authorization')}` },
  { kind: 'bearer', pattern: new RegExp(`\\bBearer\\s+${NOT_MASKED}[A-Za-z0-9._~+/=-]{8,}`, 'gu'), replace: () => `Bearer ${marker('bearer')}` },
  // URL userinfo (`https://user:secret@host`, or a token alone as the user).
  { kind: 'url-credentials', pattern: /(\b[a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/@<>"']+)@/giu,
    replace: (match, scheme, userinfo) => userinfo!.includes(':') || userinfo!.length >= 16 ? `${scheme}${marker('url-credentials')}@` : match },
  // Query values of secret-looking parameters.
  { kind: 'url-secret', pattern: new RegExp(`([?&](?:[A-Za-z0-9]+[_-])*(?:token|key|secret|password|sig|signature)=)${NOT_MASKED}[^&#\\s"'<>]+`, 'giu'), replace: (_match, prefix) => `${prefix}${marker('url-secret')}` },
  // Assignments whose name contains TOKEN / SECRET / PASSWORD / CREDENTIAL(S) or ends in KEY (`monkey` and
  // `keyboard` stay). The name may be quoted and the separator is `:`, `=` or `=>`. Every repetition is bounded.
  { kind: 'assignment', pattern: new RegExp(`(["']?\\b(?:[A-Za-z0-9_.-]{0,100}(?:[Tt]oken|TOKEN|[Ss]ecret|SECRET|[Pp]assw(?:or)?d|PASSW(?:OR)?D|[Cc]redentials?|CREDENTIALS?)|(?:[A-Za-z0-9]{1,40}[_.-]){0,8}(?:[A-Za-z0-9]{0,40}Key|[A-Z0-9]{1,40}KEY|(?:[Aa][Pp][Ii][_-]?)?(?:key|KEY)))(?![A-Za-z0-9])["']?\\s*(?:=>|[:=])\\s*)(?:"${NOT_MASKED}[^"\\r\\n]{4,}"|'${NOT_MASKED}[^'\\r\\n]{4,}'|\`${NOT_MASKED}[^\`\\r\\n]{4,}\`|${NOT_MASKED}[^\\s"'\`<>,;]{4,})`, 'gu'),
    replace: (_match, prefix) => `${prefix}${marker('assignment')}` },
  // A random run the terminal wrapped over lines, judged as one run.
  { kind: 'high-entropy', transform: text => maskEntropyRanges(text, wrappedEntropyRanges(text)) },
  // A long run that mixes upper case, lower case and digits with high entropy. Pure hex (a commit SHA) has no
  // upper case and survives; paths never form one run because `/` and `.` end it.
  { kind: 'high-entropy', transform: text => maskEntropyRanges(text, unwrappedEntropyRanges(text)) }
];

/**
 * Redact registered values and credential shapes against their original source ranges together. Applying the
 * registry first can destroy a structural label (for example `PRIVATE KEY`, `password`, or `Authorization`)
 * before its shape is recognized. Applying generic rules first has the inverse problem: a generic match can
 * split a longer registered value. Keeping both sets of source ranges lets the renderer mask their union.
 */
function redactKnownAndCredentials(text: string, forms: KnownForms): string {
  const streams: Generator<KnownMatch>[] = [];
  if (forms.bare.length > 0 || forms.exact.length > 0) {
    streams.push((function* (): Generator<KnownMatch> {
      for (const match of knownMatches(text, forms)) yield { ...match, kind: 'secret', priority: 0 };
    })());
  }
  streams.push(jsonSecretRanges(text));
  for (let index = 0; index < RULES.length; index++) {
    const rule = RULES[index]!;
    if (rule.pattern) streams.push(ruleSecretRanges(text, rule, 10 + index));
  }
  streams.push(wrappedEntropyRanges(text));
  streams.push(unwrappedEntropyRanges(text));

  let result = '';
  let copied = 0;
  let active: KnownMatch | null = null;
  let chosen: KnownMatch | null = null;
  for (const candidate of orderedOccurrences(streams)) {
    if (!candidate.kind || candidate.end <= candidate.start) continue;
    if (active && candidate.start < active.end) {
      active.end = Math.max(active.end, candidate.end);
      if (preferMask(candidate, chosen!)) chosen = candidate;
      continue;
    }
    if (active && chosen) {
      result += text.slice(copied, active.start) + marker(chosen.kind!);
      copied = active.end;
    }
    active = { start: candidate.start, end: candidate.end };
    chosen = candidate;
  }
  if (!active || !chosen) return text;
  return result + text.slice(copied, active.start) + marker(chosen.kind!) + text.slice(active.end);
}

/** Prefer the most complete source match, while preserving JSON's earlier guard against later generic rules. */
function preferMask(candidate: KnownMatch, current: KnownMatch): boolean {
  const candidateIsJson = candidate.priority === 1;
  const currentIsJson = current.priority === 1;
  const candidateIsGeneric = (candidate.priority ?? 0) >= 10;
  const currentIsGeneric = (current.priority ?? 0) >= 10;
  if (candidateIsJson && currentIsGeneric) return !privateKeyContainsJson(current, candidate);
  if (currentIsJson && candidateIsGeneric) return privateKeyContainsJson(candidate, current);
  const candidateLength = candidate.end - candidate.start;
  const currentLength = current.end - current.start;
  if (candidateLength !== currentLength) return candidateLength > currentLength;
  return (candidate.priority ?? Number.MAX_SAFE_INTEGER) < (current.priority ?? Number.MAX_SAFE_INTEGER);
}

/** PEM masking runs after the JSON-value pass and can still consume a nested JSON marker inside its body. */
function privateKeyContainsJson(privateKey: KnownMatch, json: KnownMatch): boolean {
  return privateKey.kind === 'private-key' && privateKey.start <= json.start && privateKey.end >= json.end
    && (privateKey.start < json.start || privateKey.end > json.end);
}

function* jsonSecretRanges(text: string): Generator<KnownMatch> {
  const pattern = new RegExp(JSON_SECRET_VALUE.source, JSON_SECRET_VALUE.flags);
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const prefix = match[1] ?? '';
    const closing = match[2] ?? '';
    const start = match.index + prefix.length;
    const end = match.index + match[0].length - closing.length;
    if (end > start) yield { start, end, kind: 'secret', priority: 1 };
  }
}

function* ruleSecretRanges(text: string, rule: Rule, priority: number): Generator<KnownMatch> {
  const originalPattern = rule.pattern!;
  const flags = originalPattern.flags.includes('g') ? originalPattern.flags : `${originalPattern.flags}g`;
  const pattern = new RegExp(originalPattern.source, flags);
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    let start = match.index;
    let end = match.index + match[0].length;
    switch (rule.kind) {
      case 'authorization':
        // Its replacement keeps the Authorization label and masks an optional Bearer/Basic/etc. scheme too.
        start += (match[1] ?? '').length;
        break;
      case 'bearer': {
        const prefix = /^Bearer\s+/u.exec(match[0]);
        start += prefix?.[0].length ?? 0;
        break;
      }
      case 'url-credentials': {
        const scheme = match[1] ?? '';
        const userinfo = match[2] ?? '';
        // Keep the existing rule's allowance for a short, plain user name without a password.
        if (!userinfo.includes(':') && userinfo.length < 16) continue;
        start += scheme.length;
        end = start + userinfo.length;
        break;
      }
      case 'url-secret':
        start += (match[1] ?? '').length;
        break;
      case 'assignment': {
        // JSON_SECRET_VALUE runs first in the public pipeline. When it recognizes the same quoted key/value,
        // its marker blocks this later assignment match and preserves the JSON quotes.
        const jsonMatch = new RegExp(JSON_SECRET_VALUE.source, JSON_SECRET_VALUE.flags).exec(match[0]);
        if (jsonMatch?.index === 0 && jsonMatch[0].length === match[0].length) continue;
        start += (match[1] ?? '').length;
        break;
      }
    }
    if (end > start) yield { start, end, kind: rule.kind, priority };
  }
}

function* wrappedEntropyRanges(text: string): Generator<KnownMatch> {
  for (let at = 0; at < text.length;) {
    if (!isEntropyRunCharacter(text.charCodeAt(at)) || (at > 0 && isEntropyRunCharacter(text.charCodeAt(at - 1)))) {
      at++;
      continue;
    }
    const firstEnd = entropyRunEnd(text, at);
    if (firstEnd - at < 12) {
      at = firstEnd;
      continue;
    }
    let end = firstEnd;
    let joinedLength = firstEnd - at;
    let continuations = 0;
    while (true) {
      let next = end;
      if (text.charCodeAt(next) === 0x0d && text.charCodeAt(next + 1) === 0x0a) next += 2;
      else if (text.charCodeAt(next) === 0x0a) next++;
      else break;
      let decoration = 0;
      while (decoration < 8 && next < text.length) {
        const code = text.charCodeAt(next);
        if (!(code === 0x20 || code === 0x09 || code === 0x7c || (code >= 0x2500 && code <= 0x257f))) break;
        next++;
        decoration++;
      }
      const nextEnd = entropyRunEnd(text, next);
      if (nextEnd - next < 4 || !hasDigit(text, next, nextEnd)) break;
      joinedLength += nextEnd - next;
      continuations++;
      end = nextEnd;
    }
    if (continuations > 0) {
      if (joinedLength >= 32 && looksRandomRange(text, at, end, true)) {
        yield { start: at, end, kind: 'high-entropy', priority: 10 + RULES.length };
      }
      // A low-entropy wrapped candidate consumes its continuation too.
      at = end;
    } else at = firstEnd;
  }
}

function* unwrappedEntropyRanges(text: string): Generator<KnownMatch> {
  for (let at = 0; at < text.length;) {
    if (!isEntropyRunCharacter(text.charCodeAt(at)) || (at > 0 && isEntropyRunCharacter(text.charCodeAt(at - 1)))) {
      at++;
      continue;
    }
    const end = entropyRunEnd(text, at);
    if (end - at >= 32 && looksRandomRange(text, at, end, false)) {
      yield { start: at, end, kind: 'high-entropy', priority: 11 + RULES.length };
    }
    at = end;
  }
}

function looksRandomRange(value: string, from: number, to: number, skipWrap: boolean): boolean {
  let upper = 0, lower = 0, digits = 0;
  for (let i = from; i < to && (upper < 2 || lower < 2 || digits < 2); i++) {
    const code = value.charCodeAt(i);
    if (skipWrap && (code === 0x7c || isWrapCharacter(code))) continue;
    if (code >= 0x41 && code <= 0x5a) upper++;
    else if (code >= 0x61 && code <= 0x7a) lower++;
    else if (code >= 0x30 && code <= 0x39) digits++;
  }
  if (upper < 2 || lower < 2 || digits < 2) return false;
  const counts = new Map<number, number>();
  let length = 0;
  for (let i = from; i < to; i++) {
    const code = value.charCodeAt(i);
    if (skipWrap && (code === 0x7c || isWrapCharacter(code))) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
    length++;
  }
  let entropy = 0;
  for (const count of counts.values()) { const p = count / length; entropy -= p * Math.log2(p); }
  return entropy >= 4.2;
}

const isEntropyRunCharacter = (code: number): boolean => code >= 0x30 && code <= 0x39
  || code >= 0x41 && code <= 0x5a || code >= 0x61 && code <= 0x7a
  || code === 0x2b || code === 0x3d || code === 0x5f || code === 0x2d;

function entropyRunEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && isEntropyRunCharacter(text.charCodeAt(end))) end++;
  return end;
}

function hasDigit(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x30 && code <= 0x39) return true;
  }
  return false;
}

/** Render the same bounded entropy scans used when registered values overlap credential shapes. */
function maskEntropyRanges(text: string, ranges: Iterable<KnownMatch>): string {
  let result = '';
  let copied = 0;
  for (const { start, end } of ranges) {
    result += text.slice(copied, start) + marker('high-entropy');
    copied = end;
  }
  return copied === 0 ? text : result + text.slice(copied);
}

/** The generic shapes alone (no registered values). */
export function redactCredentials(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
  let result = text;
  for (const rule of RULES) {
    if (rule.transform) {
      result = rule.transform(result);
      continue;
    }
    if (!rule.pattern) continue;
    result = result.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // Arguments after the match: the capture groups, then the numeric offset and the whole input.
      const end = rest.findIndex(value => typeof value === 'number');
      const groups = (end < 0 ? [] : rest.slice(0, end)).map(value => typeof value === 'string' ? value : '');
      return rule.replace ? rule.replace(match, ...groups) : marker(rule.kind);
    });
  }
  return result;
}

/** The registry's pre-range pipeline when it has no held values to mask. */
function redactJsonAndCredentials(text: string): string {
  const withJsonValues = text.replace(JSON_SECRET_VALUE, (_match, prefix: string, closing: string) => `${prefix}${marker('secret')}${closing}`);
  return redactCredentials(withJsonValues);
}
