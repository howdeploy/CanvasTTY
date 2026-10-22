/**
 * A bounded, conservative shell lexer for base protection. It never runs anything and never expands anything:
 * it only tells code what a command *could* do. Whatever it cannot read with certainty is a fact against the
 * command (a substitution, an unresolved variable, an unterminated quote), never for it.
 *
 * It reads POSIX shells (sh, bash, zsh), and well enough the parts of cmd.exe and PowerShell that
 * matter: `&`, `&&`, `||`, `|`, `;`, redirections, and Windows paths (a backslash escapes only a shell
 * metacharacter, so `C:\Windows` stays a path).
 */

export interface Word {
  /** The word after quote removal; substitutions and variables stay as written. */
  text: string;
  /** Any part was quoted. */
  quoted: boolean;
  /** Variable references outside single quotes (`$X`, `${X}`, `%X%`, `$env:X`). */
  vars: string[];
  /** `$(…)`, `` `…` ``, `<(…)`, `>(…)`, `$((…))` inside the word. */
  substitution: boolean;
  /** The inner text of each substitution, for a second look (download-and-run). */
  inner: string[];
  /** An unquoted glob character (`*`, `?`, `[`). */
  glob: boolean;
  /** Starts with an unquoted `~`. */
  tilde: boolean;
  /** An unquoted `{` (a brace expansion such as `a.{bin,json}` may follow). */
  brace?: boolean;
}

export interface Redirect { op: string; target: Word | null; fdDup: boolean }

export interface Segment {
  words: Word[];
  redirects: Redirect[];
  /** stdin comes from the previous segment's pipe. */
  pipeIn: boolean;
  pipeOut: boolean;
  /** A heredoc or here-string feeds stdin; the body is kept for shells that read it as a script. */
  heredoc: string | null;
}

export interface Lexed {
  segments: Segment[];
  /** `( … )` or `{ …; }` grouping. */
  grouping: boolean;
  /** A trailing or inner `&`. */
  background: boolean;
  /** An unterminated quote or substitution: the command cannot be read with certainty. */
  unterminated: boolean;
  /** A `#` comment (the text is not kept). */
  comment: boolean;
}

const SPACE = new Set([' ', '\t', '\r']);
const ESCAPABLE = new Set([' ', '\t', '\n', '\'', '"', '$', '`', '\\', ';', '&', '|', '<', '>', '(', ')', '{', '}', '*', '?', '[', ']', '#', '~', '!']);

function emptyWord(): Word { return { text: '', quoted: false, vars: [], substitution: false, inner: [], glob: false, tilde: false }; }

/** The index just past the `)` that closes the `(` at `open`, honouring quotes; -1 when it never closes. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') { i++; continue; }
    if (c === '\'') { const end = text.indexOf('\'', i + 1); if (end < 0) return -1; i = end; continue; }
    if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) if (text[j] === '\\') j++;
      if (j >= text.length) return -1;
      i = j; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

const MAX_INPUT = 65_536;

export function lexShell(input: string): Lexed {
  const text = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
  const out: Lexed = { segments: [], grouping: false, background: false, unterminated: input.length > MAX_INPUT, comment: false };
  let segment: Segment = { words: [], redirects: [], pipeIn: false, pipeOut: false, heredoc: null };
  let word: Word | null = null;
  let pendingRedirect: Redirect | null = null;
  const heredocs: Array<{ delimiter: string; strip: boolean; segment: Segment }> = [];

  const finishWord = (): void => {
    if (!word) return;
    const done = word; word = null;
    if (pendingRedirect) { pendingRedirect.target = done; pendingRedirect = null; return; }
    // `{` and `}` alone group commands.
    if (!done.quoted && (done.text === '{' || done.text === '}')) { out.grouping = true; return; }
    segment.words.push(done);
  };
  const finishSegment = (pipeOut: boolean): void => {
    finishWord();
    if (pendingRedirect) { pendingRedirect = null; out.unterminated = true; }
    segment.pipeOut = pipeOut;
    if (segment.words.length || segment.redirects.length) out.segments.push(segment);
    else if (pipeOut) out.unterminated = true;
    segment = { words: [], redirects: [], pipeIn: pipeOut, pipeOut: false, heredoc: null };
  };
  const current = (): Word => (word ??= emptyWord());

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n') {
      finishSegment(false);
      // Heredoc bodies follow the line that opened them.
      while (heredocs.length) {
        const doc = heredocs.shift()!;
        const lines: string[] = [];
        let closed = false;
        while (i + 1 < text.length) {
          const end = text.indexOf('\n', i + 1);
          const line = text.slice(i + 1, end < 0 ? text.length : end);
          i = end < 0 ? text.length : end;
          if ((doc.strip ? line.replace(/^\t+/u, '') : line) === doc.delimiter) { closed = true; break; }
          lines.push(line);
        }
        if (!closed) out.unterminated = true;
        doc.segment.heredoc = lines.join('\n');
      }
      continue;
    }
    if (SPACE.has(c)) { finishWord(); continue; }
    if (c === '#' && !word) {
      out.comment = true;
      const end = text.indexOf('\n', i);
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    if (c === '\\') {
      const next = text[i + 1];
      if (next === '\n') { i++; continue; }
      if (next !== undefined && ESCAPABLE.has(next)) { current().text += next; current().quoted = true; i++; continue; }
      current().text += c;
      continue;
    }
    if (c === '\'') {
      const end = text.indexOf('\'', i + 1);
      const w = current(); w.quoted = true;
      if (end < 0) { w.text += text.slice(i + 1); out.unterminated = true; i = text.length; continue; }
      w.text += text.slice(i + 1, end); i = end;
      continue;
    }
    if (c === '"') {
      const w = current(); w.quoted = true;
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text[j]!;
        if (d === '\\' && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1]!)) { if (text[j + 1] !== '\n') w.text += text[j + 1]; j++; continue; }
        if (d === '$' || d === '`') { const used = dollar(text, j, w, out); if (used > j) { j = used - 1; continue; } }
        w.text += d;
      }
      if (j >= text.length) out.unterminated = true;
      i = j;
      continue;
    }
    if (c === '$' || c === '`') {
      const w = current();
      const used = dollar(text, i, w, out);
      if (used > i) { i = used - 1; continue; }
      w.text += c;
      continue;
    }
    if ((c === '<' || c === '>') && text[i + 1] === '(') {
      const end = closeParen(text, i + 1);
      const w = current();
      w.substitution = true;
      if (end < 0) { out.unterminated = true; w.text += text.slice(i); w.inner.push(text.slice(i + 2)); i = text.length; continue; }
      w.text += text.slice(i, end); w.inner.push(text.slice(i + 2, end - 1)); i = end - 1;
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && text[i + 1] === '>')) {
      // An fd number right before the operator belongs to it (`2>`).
      let fd = '';
      const before = word as Word | null;
      if (before && !before.quoted && /^\d{1,2}$/u.test(before.text) && !pendingRedirect) { fd = before.text; word = null; }
      finishWord();
      let op = c;
      let j = i + 1;
      if (c === '&') { op = '&>'; j = i + 2; if (text[j] === '>') { op = '&>>'; j++; } }
      else if (c === '>') { if (text[j] === '>') { op = '>>'; j++; } else if (text[j] === '|') { op = '>|'; j++; } else if (text[j] === '&') { op = '>&'; j++; } }
      else if (text[j] === '<') { op = '<<'; j++; if (text[j] === '<') { op = '<<<'; j++; } else if (text[j] === '-') { op = '<<-'; j++; } }
      else if (text[j] === '&') { op = '<&'; j++; } else if (text[j] === '>') { op = '<>'; j++; }
      i = j - 1;
      const redirect: Redirect = { op: `${fd}${op}`, target: null, fdDup: op === '>&' || op === '<&' };
      segment.redirects.push(redirect);
      if (redirect.fdDup) {
        // `>&2`, `2>&1`, `>&-`: a descriptor, not a file (a word target after `>&` is bash's `&>`).
        const m = /^(\d+|-)/u.exec(text.slice(i + 1));
        if (m) { i += m[0].length; continue; }
        redirect.fdDup = false;
      }
      if (op === '<<' || op === '<<-') {
        // The delimiter word follows; its body starts on the next line.
        let k = i + 1;
        while (SPACE.has(text[k] ?? '')) k++;
        const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/u.exec(text.slice(k));
        if (m) { heredocs.push({ delimiter: m[2]!, strip: op === '<<-', segment }); i = k + m[0].length - 1; redirect.target = { ...emptyWord(), text: m[2]!, quoted: true }; continue; }
        out.unterminated = true;
        continue;
      }
      pendingRedirect = redirect;
      continue;
    }
    if (c === ';') { finishSegment(false); if (text[i + 1] === ';') i++; continue; }
    if (c === '&') {
      if (text[i + 1] === '&') { finishSegment(false); i++; continue; }
      out.background = true; finishSegment(false); continue;
    }
    if (c === '|') {
      if (text[i + 1] === '|') { finishSegment(false); i++; continue; }
      if (text[i + 1] === '&') i++;
      finishSegment(true); continue;
    }
    if (c === '(' || c === ')') {
      // `name()` of a function definition, or a subshell group.
      out.grouping = true;
      finishSegment(false);
      continue;
    }
    const w = current();
    if (!w.quoted && w.text === '' && c === '~') w.tilde = true;
    if (c === '*' || c === '?' || c === '[') w.glob = true;
    if (c === '{') w.brace = true;
    // cmd.exe variables: %NAME%.
    if (c === '%') {
      const m = /^%([A-Za-z_][A-Za-z0-9_()]*)%/u.exec(text.slice(i));
      if (m) { w.vars.push(m[1]!.toUpperCase()); w.text += m[0]; i += m[0].length - 1; continue; }
    }
    w.text += c;
  }
  finishSegment(false);
  if (pendingRedirect) out.unterminated = true;
  if (heredocs.length) out.unterminated = true;
  return out;
}

/**
 * Reads a `$…` or backquote construct at `i` into `w`. Returns the index after it, or `i` when the `$` is a
 * plain character.
 */
function dollar(text: string, i: number, w: Word, out: Lexed): number {
  const c = text[i]!;
  if (c === '`') {
    const end = text.indexOf('`', i + 1);
    w.substitution = true;
    if (end < 0) { out.unterminated = true; w.inner.push(text.slice(i + 1)); w.text += text.slice(i); return text.length; }
    w.inner.push(text.slice(i + 1, end)); w.text += text.slice(i, end + 1);
    return end + 1;
  }
  const next = text[i + 1];
  if (next === '(') {
    const end = closeParen(text, i + 1);
    w.substitution = true;
    if (end < 0) { out.unterminated = true; w.inner.push(text.slice(i + 2)); w.text += text.slice(i); return text.length; }
    w.inner.push(text.slice(i + 2, end - 1)); w.text += text.slice(i, end);
    return end;
  }
  if (next === '{') {
    const end = text.indexOf('}', i + 2);
    if (end < 0) { out.unterminated = true; w.text += text.slice(i); w.vars.push('?'); return text.length; }
    const name = text.slice(i + 2, end);
    w.vars.push(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ? name : `{${name.slice(0, 40)}}`);
    w.text += text.slice(i, end + 1);
    return end + 1;
  }
  if (next === '\'') {
    // $'…' ANSI-C quoting: escapes can build any text, so it counts as an unresolved value.
    const end = text.indexOf('\'', i + 2);
    w.quoted = true; w.vars.push('$\'');
    if (end < 0) { out.unterminated = true; w.text += text.slice(i + 2); return text.length; }
    w.text += text.slice(i + 2, end);
    return end + 1;
  }
  const env = /^\$env:([A-Za-z_][A-Za-z0-9_]*)/iu.exec(text.slice(i));
  if (env) { w.vars.push(`ENV:${env[1]!.toUpperCase()}`); w.text += env[0]; return i + env[0].length; }
  const name = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/u.exec(text.slice(i));
  if (name) { w.vars.push(name[1]!); w.text += name[0]; return i + name[0].length; }
  return i;
}

/** POSIX single-quoting of one argv element, for turning an argv array back into a command string. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}

