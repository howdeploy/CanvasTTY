import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isPathInside } from '../../../agent-runtime/path-inside.mjs';
import { lexShell, shellQuote, type Segment, type Word } from './shellParse.ts';

/**
 * The hard facts base protection decides on, computed by code from one tool call and the working folder.
 * Nothing is executed and nothing is read except `realpath` of the paths involved. Only the facts a deny rule
 * needs are computed: elevation, a pipe into a shell, download-and-run, disk commands, a fork bomb, writes or
 * deletes outside the working folder (deleting the folder itself included), and any use of CanvasTTY's own private
 * data (its access tokens, secret stores and control sockets).
 */

/** One tool call, source-neutral: a shell command or the files a file tool writes. */
export interface ToolAction {
  kind: 'shell' | 'edit' | null;
  /** The shell command; null when none could be read. */
  command: string | null;
  /** The command's own working directory, if the agent said one. */
  commandCwd: string | null;
  /** Paths a file tool writes. */
  paths: string[];
}

export type Where = 'inside' | 'outside' | 'unresolved';
export interface Target {
  raw: string;
  abs: string | null;
  where: Where;
  /** A block device (/dev/disk2, /dev/sda, \\.\PhysicalDrive0). */
  device: boolean;
  /** Names the working folder itself (not through a glob): deleting it is deleting the project. */
  root: boolean;
}

export interface HardFacts {
  elevation: boolean;
  pipeToShell: boolean;
  downloadExec: boolean;
  disk: boolean;
  forkBomb: boolean;
  writesOutside: boolean;
  deletesOutside: boolean;
  /** Absolute targets written outside the working folder (for the temporary-folder advice). */
  outsideWrites: string[];
  /** Names, reads or connects to CanvasTTY's own private data: tokens, secret stores, control/runtime sockets. */
  appPrivate: boolean;
  /**
   * Deletes or moves a path held in a variable or command output that cannot be resolved here, so where it points
   * (inside the project or not) is unknown.
   */
  unknownTarget: boolean;
}

/**
 * CanvasTTY's own private data, as the running app knows it (its userData folder differs per platform and per
 * profile, so it is passed in, never guessed). `appRoots`: the app's data folders; `paths`: the private files and
 * folders in them (tokens, connection records, secret stores, account homes); `markers`: names that, together with
 * an app root's own name, identify those paths inside interpreter code that builds a path piece by piece.
 */
export interface PrivateData { appRoots: readonly string[]; paths: readonly string[]; markers: readonly string[] }

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** realpath of the longest existing ancestor plus the rest (a symlink out of the project resolves outside). */
export function realish(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync.native(current);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch { /* go up */ }
    const parent = dirname(current);
    if (parent === current) return path;
    rest.push(basename(current));
    current = parent;
  }
  return path;
}

const DEVICE = /^(?:\/dev\/(?:r?disk\d|sd[a-z]|hd[a-z]|nvme\d|mmcblk\d|xvd[a-z]|vd[a-z]|md\d|dm-\d|loop\d|mapper\/)|\\\\\.\\(?:physicaldrive|[a-z]:))/iu;
const HARMLESS_DEVICE = /^\/dev\/(?:null|zero|u?random|stdin|stdout|stderr|tty|fd\/\d+)$|^(?:nul|con)$/iu;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[A-Za-z]:$|\\\\)/u;

export interface PathContext {
  root: string; rootReal: string; home: string; temp: string; agentRoots: string[];
  /** CanvasTTY's private paths and data folders (as given and resolved), and the temporary folders its sockets live in. */
  privatePaths: string[]; appRoots: string[]; appNames: string[]; markers: string[]; tempRoots: string[];
  /**
   * Shell variables this command set before using them (`OUT=/x; rm -rf "$OUT"`, `export OUT=/x`): the value, or
   * null when it cannot be known (a substitution, an unknown variable). Filled in order while the command is read.
   */
  shellVars: Map<string, string | null>;
}

/**
 * `agentRoots`: the agent's own config folders (Claude's ~/.claude or the run's CLAUDE_CONFIG_DIR). Their plan and
 * memory folders belong to the agent, so writing there is not a write outside the project.
 */
function pathContext(root: string, home = homedir(), agentRoots?: readonly string[], privateData?: PrivateData): PathContext {
  const both = (paths: readonly string[]): string[] => [...new Set(paths.filter(path => path && isAbsolute(path)).flatMap(path => [resolve(path), realish(resolve(path))]))];
  const temp = tmpdir();
  return {
    root, rootReal: realish(resolve(root)), home, temp, agentRoots: (agentRoots ?? [join(home, '.claude')]).map(dir => realish(resolve(dir))),
    privatePaths: both(privateData?.paths ?? []), appRoots: both(privateData?.appRoots ?? []),
    appNames: [...new Set((privateData?.appRoots ?? []).map(path => basename(path).toLowerCase()).filter(name => name.length >= 4))],
    markers: (privateData?.markers ?? []).map(marker => marker.toLowerCase()).filter(marker => marker.length >= 6),
    tempRoots: both([temp, '/tmp', '/private/tmp', '/var/tmp']),
    shellVars: new Map()
  };
}

const AGENT_SERVICE_DIR = /^(?:plans|projects[\\/][^\\/]+[\\/]memory)(?:[\\/]|$)/u;

/** The path is inside an agent config folder's `plans/` or `projects/<project>/memory/` (already resolved, so no `..`). */
function isAgentServicePath(abs: string, ctx: PathContext): boolean {
  return ctx.agentRoots.some(dir => {
    return isPathInside(dir, abs, { allowRoot: false }) && AGENT_SERVICE_DIR.test(relative(dir, abs));
  });
}

const HOME_VARS = new Set(['HOME', 'USERPROFILE', 'ENV:USERPROFILE', 'ENV:HOME']);
const TEMP_VARS = new Set(['TMPDIR', 'TEMP', 'TMP', 'ENV:TEMP', 'ENV:TMP']);

/** Expands only what is certain (~, HOME, PWD, TMPDIR, variables this command set); anything else is unresolved. */
function expand(word: Word | string, cwd: string | null, ctx: PathContext): string | null {
  if (typeof word !== 'string' && word.substitution) return null;
  let text = typeof word === 'string' ? word : word.text;
  const vars = typeof word === 'string' ? [] : word.vars;
  for (const name of vars) {
    let value: string | null = null;
    if (ctx.shellVars.has(name)) value = ctx.shellVars.get(name) ?? null;
    else if (HOME_VARS.has(name)) value = ctx.home;
    else if (name === 'PWD' || name === 'ENV:PWD') value = cwd;
    else if (TEMP_VARS.has(name)) value = ctx.temp;
    if (value === null) return null;
    text = text.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])|%${name}%|\\$env:${name.replace(/^ENV:/u, '')}`, 'iu'), value);
  }
  if (typeof word !== 'string' ? word.tilde : text.startsWith('~')) {
    if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) text = ctx.home + text.slice(1);
    else return null;
  }
  return text;
}

/**
 * Where a word points. `noFollow`: the operation acts on the last path component itself (rm, unlink, mv of a
 * symlink removes or renames the link, not what it points to), so only the folders above it are resolved.
 */
function resolveTarget(word: Word | string, cwd: string | null, ctx: PathContext, noFollow = false): Target {
  const raw = typeof word === 'string' ? word : word.text;
  const blank: Target = { raw, abs: null, where: 'unresolved', device: DEVICE.test(raw), root: false };
  const globbed = typeof word !== 'string' && word.glob;
  let text = expand(word, cwd, ctx);
  if (text === null || text === '') return blank;
  if (globbed) {
    // A glob acts on everything under the folder before its first wildcard.
    const first = text.search(/[*?[]/u);
    const cut = text.slice(0, first).lastIndexOf('/');
    text = cut < 0 ? '.' : text.slice(0, cut) || '/';
  }
  if (DEVICE.test(text)) return { ...blank, device: true, where: 'outside', abs: text };
  if (WINDOWS_ABSOLUTE.test(text) && sep === '/') return { ...blank, abs: text, where: 'outside' };
  if (!isAbsolute(text) && cwd === null) return blank;
  const full = resolve(cwd ?? ctx.root, text);
  const abs = noFollow && !/[\\/]$/u.test(text) && basename(full) !== '..' && basename(full) !== '.' && dirname(full) !== full ? join(realish(dirname(full)), basename(full)) : realish(full);
  const inside = isPathInside(ctx.rootReal, abs);
  return { raw, abs, where: inside ? 'inside' : 'outside', device: false, root: relative(ctx.rootReal, abs) === '' && !globbed };
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'hush']);
/** Multi-call binaries: `busybox rm …` runs the applet `rm`. */
const MULTICALL = new Set(['busybox', 'toybox']);
/** Shell words that may stand before a command in the same segment; the command after them runs. */
const LEADING_RESERVED = new Set(['!', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', '{']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'pypy', 'pypy3', 'node', 'nodejs', 'ruby', 'perl', 'php', 'lua', 'luajit', 'rscript', 'tsx', 'ts-node', 'deno', 'bun', 'osascript', 'jshell', 'groovy', 'julia', 'elixir', 'swift']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const EVAL_WORDS = new Set(['eval', 'iex', 'invoke-expression']);
const ELEVATION = new Set(['sudo', 'doas', 'pkexec', 'run0', 'runas', 'gsudo', 'please']);
const WRAPPERS = new Set(['nohup', 'time', 'nice', 'ionice', 'timeout', 'gtimeout', 'stdbuf', 'command', 'builtin', 'exec', 'caffeinate', 'watch', 'chronic', 'unbuffer', 'setsid']);
/** Per wrapper, the flags whose next word is their value (so the value is not taken for the command). */
const WRAPPER_VALUE_FLAGS: Record<string, readonly string[]> = {
  env: ['-u', '--unset', '-C', '--chdir', '-P', '-S', '--split-string'],
  time: ['-f', '--format', '-o', '--output'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  gtimeout: ['-s', '--signal', '-k', '--kill-after'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  exec: ['-a'],
  caffeinate: ['-t', '-w'],
  watch: ['-n', '--interval', '-q', '--equexit'],
  setsid: [],
  xargs: ['-n', '-P', '-I', '-L', '-d', '-s', '-E', '-a', '--arg-file', '--max-args', '--max-procs', '--replace', '--max-lines', '--delimiter', '--max-chars', '--eof']
};
const DISK = new Set(['mkfs', 'mke2fs', 'mkswap', 'newfs', 'newfs_apfs', 'newfs_hfs', 'newfs_msdos', 'wipefs', 'fdisk', 'sfdisk', 'gdisk', 'sgdisk', 'cfdisk', 'parted', 'blkdiscard', 'diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'new-partition', 'set-disk', 'mdadm', 'lvremove', 'vgremove', 'pvremove', 'cryptsetup', 'asr', 'fdformat', 'gpt']);
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh', 'aria2c', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer', 'certutil', 'bitsadmin', 'lwp-download']);
const DELETERS = new Set(['rm', 'unlink', 'shred', 'trash', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'rimraf', 'srm']);
const COPIERS = new Set(['cp', 'install', 'ln', 'copy', 'xcopy', 'robocopy', 'copy-item', 'cpi', 'mklink', 'ditto', 'rsync']);
const MOVERS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
const CREATORS = new Set(['touch', 'mkdir', 'md', 'truncate', 'tee', 'new-item', 'ni', 'set-content', 'add-content', 'ac', 'out-file', 'mkfifo', 'mktemp', 'gzip', 'gunzip', 'bzip2', 'xz', 'unxz', 'zstd']);
const MODE_CHANGERS = new Set(['chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'attrib', 'icacls', 'takeown']);
/** Git subcommands with no form that changes a repository. Those with both kinds of forms are judged by gitEffect. */
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'cat-file', 'ls-tree', 'merge-base', 'count-objects', 'var', 'help', 'version', 'annotate', 'name-rev', 'show-ref', 'for-each-ref', 'check-ignore', 'ls-remote']);
const WINDOWS_BUILTINS = new Set(['del', 'erase', 'rd', 'copy', 'xcopy', 'robocopy', 'move', 'ren', 'rename', 'format', 'cipher', 'attrib', 'icacls', 'takeown', 'mklink', 'md', 'mkdir', 'rmdir']);

/** A program's name for the tables: basename, lower case, without a Windows executable suffix. */
function programName(argv0: string): string {
  const name = argv0.replace(/\\/gu, '/').split('/').pop() ?? argv0;
  return name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/u, '');
}

const isFlag = (value: string, windows = false): boolean => value.startsWith('-') && value !== '-' || windows && /^\/[A-Za-z?]{1,3}(?::.*)?$/u.test(value);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Acc {
  ctx: PathContext;
  writes: Target[];
  deletes: Target[];
  flags: { elevation: boolean; pipeToShell: boolean; downloadExec: boolean; disk: boolean; forkBomb: boolean; appPrivate: boolean; unknownTarget: boolean };
  depth: number;
  budget: number;
  /** Nesting of argv inside wrappers (nohup, env, xargs, su -c, busybox …): bounded like substitutions. */
  argvDepth: number;
  /** Paths still to be checked against CanvasTTY's private data (each costs a realpath). */
  privateBudget: number;
}

interface Stdin { pipeIn: boolean; heredoc: string | null }

function wordOf(text: string): Word { return { text, quoted: false, vars: [], substitution: false, inner: [], glob: false, tilde: false }; }

/** Analyses one shell command string (recursively for `bash -c`, `eval`, substitutions). */
function analyzeText(command: string, cwd: string | null, acc: Acc): string | null {
  if (acc.depth > 4 || --acc.budget < 0) return cwd;
  acc.depth++;
  try {
    const lexed = lexShell(command);
    if (/(\w+|:)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1/u.test(command)) acc.flags.forkBomb = true;
    // PowerShell download-and-run: iex (iwr …), Invoke-Expression (New-Object Net.WebClient).DownloadString(…).
    if (/\b(?:iex|invoke-expression)\b/iu.test(command) && /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|net\.webclient|start-bitstransfer|curl|wget)\b/iu.test(command)) acc.flags.downloadExec = true;
    let current = cwd;
    const downloadedHere: Target[] = [];
    for (const segment of lexed.segments) current = analyzeSegment(segment, current, acc, downloadedHere);
    return current;
  } finally { acc.depth--; }
}

function analyzeSegment(segment: Segment, cwd: string | null, acc: Acc, downloadedHere: Target[]): string | null {
  const words = [...segment.words];
  const assignments: Word[] = [];
  // Leading NAME=value assignments and the shell's own words before a command (`do rm …`, `then rm …`, `! rm …`).
  for (;;) {
    const first = words[0];
    if (!first || first.quoted && !ASSIGNMENT.test(first.text)) break;
    if (ASSIGNMENT.test(first.text)) assignments.push(first);
    else if (!LEADING_RESERVED.has(first.text)) break;
    words.shift();
  }
  // Assignments alone set the shell's variables for the rest of the command; before a command they only set its
  // environment (`OUT=/x rm "$OUT"` expands the old OUT).
  if (!words.length) for (const word of assignments) assignVariable(word, cwd, acc.ctx);
  // `for NAME in WORDS`: the loop body sees each word in turn. The variable takes a word that points outside the
  // project when there is one (the body is judged by its worst case), else the first; unknown when any is.
  if (words[0]?.text === 'for' && !words[0].quoted && words[1] && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(words[1].text) && words[2]?.text === 'in') {
    const values = words.slice(3).map(word => ({ word, value: word.substitution ? null : expand(word, cwd, acc.ctx) }));
    let chosen: string | null = values.length && values.every(entry => entry.value !== null) ? values[0]!.value : null;
    if (chosen !== null) {
      const outside = values.find(entry => resolveTarget({ ...entry.word, text: entry.value!, vars: [] }, cwd, acc.ctx).where === 'outside');
      if (outside) chosen = outside.value;
    }
    acc.ctx.shellVars.set(words[1].text, chosen);
    return cwd;
  }
  checkPrivate(segment, words, cwd, acc);
  for (const word of segment.words) inspectWord(word, acc);
  for (const redirect of segment.redirects) {
    if (redirect.fdDup || !redirect.target) continue;
    inspectWord(redirect.target, acc);
    if (redirect.op.includes('<<') || !redirect.op.includes('>')) continue;
    if (HARMLESS_DEVICE.test(redirect.target.text)) continue;
    const target = resolveTarget(redirect.target, cwd, acc.ctx);
    if (target.device) { acc.flags.disk = true; continue; }
    acc.writes.push(target);
  }
  if (!words.length) return cwd;
  return analyzeArgv(words, cwd, acc, { pipeIn: segment.pipeIn, heredoc: segment.heredoc }, downloadedHere);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Shell builtins whose NAME=value operands set variables for the rest of the command. */
const DECLARERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);

/** Records `NAME=value`: its value when it is certain, else null (the variable is then unknown, never left stale). */
function assignVariable(word: Word, cwd: string | null, ctx: PathContext): void {
  const at = word.text.indexOf('=');
  const name = word.text.slice(0, at);
  const value = word.text.slice(at + 1);
  const valueWord: Word = { ...word, text: value, vars: word.vars.filter(variable => value.includes(variable)), tilde: value.startsWith('~') };
  ctx.shellVars.set(name, word.glob ? null : expand(valueWord, cwd, ctx));
}

/** A target named only through a variable or a substitution that could not be resolved. */
function heldElsewhere(word: Word, target: Target): boolean {
  return target.where === 'unresolved' && (word.substitution || word.vars.length > 0);
}

function inspectWord(word: Word, acc: Acc): void {
  // A substitution runs its own command.
  if (word.substitution) for (const inner of word.inner) analyzeText(inner, null, acc);
}

function fetchesIn(text: string): boolean {
  return /(?:^|[\s;|&(`])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch|http|aria2c|lwp-download)(?:\.exe)?(?=\s|$)/iu.test(text);
}

/** Words → what the command does. Returns the working directory after it (for `cd`). */
/** More wrappers around one command than any real one has: what runs is not followed, and the call is refused. */
const MAX_ARGV_DEPTH = 32;

function analyzeArgv(argvWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[]): string | null {
  if (acc.argvDepth >= MAX_ARGV_DEPTH) {
    acc.flags.unknownTarget = true;
    return cwd;
  }
  acc.argvDepth++;
  try { return analyzeArgvOnce(argvWords, cwd, acc, stdin, downloadedHere); }
  finally { acc.argvDepth--; }
}

function analyzeArgvOnce(argvWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[]): string | null {
  const argv = argvWords.map(word => word.text);
  const argv0 = argv[0]!;
  const program = programName(argv0);
  const args = argv.slice(1);
  const argWords = argvWords.slice(1);
  const innerFetch = argvWords.some(word => word.inner.some(inner => fetchesIn(inner)));

  // An argv0 that is itself a substitution or a variable: nobody can tell what runs.
  if (argvWords[0]!.substitution || argvWords[0]!.vars.length) {
    if (innerFetch) acc.flags.downloadExec = true;
    return cwd;
  }

  if (ELEVATION.has(program) || program === 'su' || (program === 'start-process' && args.some(arg => /^-verb$/iu.test(arg)) && args.some(arg => /^runas$/iu.test(arg)))) {
    acc.flags.elevation = true;
    const inner = program === 'su' ? args.indexOf('-c') : argWords.findIndex(word => !isFlag(word.text));
    if (program === 'su' && inner >= 0 && args[inner + 1]) analyzeText(args[inner + 1]!, cwd, acc);
    else if (program !== 'su' && inner >= 0) analyzeArgv(argWords.slice(inner), cwd, acc, stdin, downloadedHere);
    return cwd;
  }

  // Wrappers run their argument as a command.
  if (WRAPPERS.has(program) || program === 'env' || program === 'xargs') {
    if (program === 'command' && (args[0] === '-v' || args[0] === '-V')) return cwd;
    const takesValue = new Set(WRAPPER_VALUE_FLAGS[program] ?? []);
    let i = 0;
    let runDir = cwd;
    for (; i < argWords.length; i++) {
      const text = argWords[i]!.text;
      if (program === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(text)) continue;
      if (text === '--') { i++; break; }
      if (text.startsWith('-')) {
        // `env -S 'rm -rf x'` splits its value into the command it runs.
        const split = program === 'env' ? /^(?:-S|--split-string)(?:=|$)(.*)$/u.exec(text) : null;
        if (split) {
          const value = split[1] ? split[1] : argWords[i + 1]?.text;
          if (value !== undefined) analyzeText([value, ...args.slice(split[1] ? i + 1 : i + 2)].join(' '), runDir, acc);
          return cwd;
        }
        // `env -C DIR` runs the command in DIR.
        if (program === 'env' && /^(?:-C|--chdir)$/u.test(text)) runDir = argWords[i + 1] ? resolveTarget(argWords[i + 1]!, cwd, acc.ctx).abs : null;
        if (program === 'env' && text.startsWith('--chdir=')) runDir = resolveTarget(text.slice('--chdir='.length), cwd, acc.ctx).abs;
        if (takesValue.has(text)) i++;
        continue;
      }
      if ((program === 'timeout' || program === 'gtimeout') && /^\d/u.test(text)) continue;
      if (program === 'nice' && /^-?\d+$/u.test(text)) continue;
      break;
    }
    if (i >= argWords.length) return cwd;
    return analyzeArgv(argWords.slice(i), runDir, acc, program === 'xargs' ? { pipeIn: false, heredoc: null } : stdin, downloadedHere);
  }
  if (program === 'script') return runScriptCommand(argWords, cwd, acc, stdin, downloadedHere);
  if (MULTICALL.has(program)) {
    const applet = argWords.findIndex(word => !word.text.startsWith('-'));
    return applet >= 0 ? analyzeArgv(argWords.slice(applet), cwd, acc, stdin, downloadedHere) : cwd;
  }

  if (program === 'cd' || program === 'pushd' || program === 'chdir' || program === 'set-location' || program === 'sl') {
    const dest = argWords.filter(word => !isFlag(word.text))[0];
    if (!dest) return acc.ctx.home;
    if (dest.text === '-') return null;
    return resolveTarget(dest, cwd, acc.ctx).abs;
  }
  if (program === 'popd') return null;
  if (DECLARERS.has(program)) {
    for (const word of argWords) if (ASSIGNMENT.test(word.text)) assignVariable(word, cwd, acc.ctx);
    return cwd;
  }

  if (EVAL_WORDS.has(program)) {
    const generated = program !== 'eval' || argWords.some(word => word.substitution || word.vars.length) || stdin.pipeIn;
    if (generated) {
      if (stdin.pipeIn || innerFetch) acc.flags.pipeToShell = true;
      return cwd;
    }
    return analyzeText(args.join(' '), cwd, acc);
  }

  if (program === 'source' || program === '.') {
    const file = argWords.filter(word => !isFlag(word.text))[0];
    if (file?.substitution && innerFetch) acc.flags.downloadExec = true;
    else if (file) runScript(resolveTarget(file, cwd, acc.ctx), acc, downloadedHere);
    return cwd;
  }

  if (SHELLS.has(program) || POWERSHELLS.has(program) || program === 'cmd') return runShell(program, argWords, cwd, acc, stdin, downloadedHere, innerFetch);
  if (INTERPRETERS.has(program)) return runInterpreter(program, argWords, cwd, acc, stdin, downloadedHere, innerFetch);

  // A program named by path: running a file this command just downloaded.
  if (/[\\/]/u.test(argv0)) runScript(resolveTarget(argvWords[0]!, cwd, acc.ctx), acc, downloadedHere);

  classifyProgram(program, argWords, cwd, acc, stdin, downloadedHere);
  return cwd;
}

/**
 * `script` records a terminal session: util-linux runs `-c CMD` (`script -qc 'rm …' /dev/null`), BSD runs the words
 * after the log file (`script -q /dev/null rm …`). The log file itself is written.
 */
function runScriptCommand(argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[]): string | null {
  const args = argWords.map(word => word.text);
  const values = new Set(['-E', '--echo', '-I', '--log-in', '-O', '--log-out', '-B', '--log-io', '-T', '--log-timing', '-m', '--logging-format', '-o', '--output-limit', '-t']);
  const operands: Word[] = [];
  let command: string | null = null;
  for (let i = 0; i < argWords.length; i++) {
    const text = args[i]!;
    if (operands.length) { operands.push(argWords[i]!); continue; }
    if (text === '--command' || /^-[a-zA-Z]*c$/u.test(text)) { command = args[i + 1] ?? null; i++; continue; }
    if (text.startsWith('--command=')) { command = text.slice('--command='.length); continue; }
    if (/^-[a-zA-Z]*c./u.test(text) && !text.startsWith('--')) { command = text.slice(text.indexOf('c') + 1); continue; }
    if (values.has(text)) { i++; continue; }
    if (text.startsWith('-')) continue;
    operands.push(argWords[i]!);
  }
  const log = operands[0];
  if (log && !HARMLESS_DEVICE.test(log.text)) acc.writes.push(resolveTarget(log, cwd, acc.ctx));
  if (command !== null) analyzeText(command, cwd, acc);
  else if (operands.length > 1) analyzeArgv(operands.slice(1), cwd, acc, stdin, downloadedHere);
  return cwd;
}

/** `perl -i` / `ruby -i` edit their file operands in place (`-pi -e 's/a/b/' f`, `-i.bak`, `-i -pe …`). */
function inPlaceEdit(argWords: Word[], cwd: string | null, acc: Acc): boolean {
  const args = argWords.map(word => word.text);
  if (!args.some(arg => /^-[a-zA-Z]*i/u.test(arg) && !arg.startsWith('--'))) return false;
  const operands: Word[] = [];
  let script = false;
  for (let i = 0; i < argWords.length; i++) {
    const text = args[i]!;
    if (text === '--') { operands.push(...argWords.slice(i + 1)); break; }
    // A cluster ending in e/E takes the next word as the program (`-e`, `-pe`), unless an `i` before it makes the
    // rest its backup suffix (`-pie` is -p and -i with suffix "e").
    if (/^-[a-zA-Z]*[eE]$/u.test(text) && !text.slice(1, -1).includes('i')) { script = true; i++; continue; }
    if (/^-[IMmrx]$/u.test(text)) { i++; continue; }
    if (text.startsWith('-')) continue;
    operands.push(argWords[i]!);
  }
  // Without -e the first operand is the program file.
  for (const word of operands.slice(script ? 0 : 1)) acc.writes.push(resolveTarget(word, cwd, acc.ctx));
  return true;
}

function runScript(file: Target, acc: Acc, downloadedHere: Target[]): void {
  if (downloadedHere.some(item => item.abs && item.abs === file.abs)) acc.flags.downloadExec = true;
}

function runShell(program: string, argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[], innerFetch: boolean): string | null {
  const args = argWords.map(word => word.text);
  const powershell = POWERSHELLS.has(program);
  for (let i = 0; i < argWords.length; i++) {
    const text = args[i]!;
    const inline = program === 'cmd' ? /^\/[ck]$/iu.test(text) : powershell ? /^-(?:c|command)$/iu.test(text) : /^-[a-z]*c[a-z]*$/u.test(text) && !text.startsWith('--');
    if (inline) {
      const rest = program === 'cmd' || powershell ? args.slice(i + 1).join(' ') : args[i + 1];
      if (innerFetch) acc.flags.downloadExec = true;
      if (rest !== undefined && !(argWords[i + 1]?.substitution && program !== 'cmd')) analyzeText(rest, cwd, acc);
      return cwd;
    }
    if (powershell && /^-(?:f|file)$/iu.test(text)) {
      const file = argWords[i + 1];
      if (file) runScript(resolveTarget(file, cwd, acc.ctx), acc, downloadedHere);
      return cwd;
    }
    if (text.toLowerCase() === '-s' && !powershell) break;
    if (isFlag(text, program === 'cmd')) { if (/^--?(?:rcfile|init-file|o)$/u.test(text)) i++; continue; }
    if (powershell && /^-/u.test(text)) continue;
    // The first operand is a script file; the rest are its arguments. `bash <(curl …)`: a download run as a script.
    const file = argWords[i]!;
    if (file.substitution) { if (innerFetch) acc.flags.downloadExec = true; return cwd; }
    runScript(resolveTarget(file, cwd, acc.ctx), acc, downloadedHere);
    return cwd;
  }
  // No script: the shell reads stdin.
  if (stdin.pipeIn) acc.flags.pipeToShell = true;
  else if (stdin.heredoc !== null) analyzeText(stdin.heredoc, cwd, acc);
  return cwd;
}

function runInterpreter(program: string, argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[], innerFetch: boolean): string | null {
  const args = argWords.map(word => word.text);
  if (args.length === 1 && /^(?:--?version|-v|-V)$/u.test(args[0]!)) return cwd;
  const python = program.startsWith('python') || program.startsWith('pypy');
  if ((program === 'perl' || program === 'ruby') && inPlaceEdit(argWords, cwd, acc)) return cwd;
  for (let i = 0; i < argWords.length; i++) {
    const text = args[i]!;
    if (python && text === '-m') return cwd;
    if (/^(?:-c|-e|--eval|-p|--print|-r|-E)$/u.test(text) || program === 'deno' && text === 'eval' || program === 'osascript' && text === '-e') {
      if (innerFetch) acc.flags.downloadExec = true;
      if (args[i + 1] !== undefined && codeNamesPrivate(args[i + 1]!, acc.ctx)) acc.flags.appPrivate = true;
      if (argWords[i + 1] && fetchesIn(args[i + 1]!) && /\b(?:exec|eval|system|spawn|child_process|subprocess|os\.system)\b/u.test(args[i + 1]!)) acc.flags.downloadExec = true;
      return cwd;
    }
    if (text.startsWith('-')) { if (/^(?:-W|-X|--require|-r|--import|--loader|-I)$/u.test(text)) i++; continue; }
    if ((program === 'deno' || program === 'bun') && ['run', 'x', 'test', 'task', 'check', 'lint', 'fmt', 'compile', 'build', 'install', 'add'].includes(text)) continue;
    const file = argWords[i]!;
    if (file.substitution) { if (innerFetch) acc.flags.downloadExec = true; return cwd; }
    if (/^https?:\/\//iu.test(file.text)) { acc.flags.downloadExec = true; return cwd; }
    runScript(resolveTarget(file, cwd, acc.ctx), acc, downloadedHere);
    return cwd;
  }
  if (stdin.pipeIn) acc.flags.pipeToShell = true;
  // A program read from a heredoc (`python3 - <<EOF`): its paths and names count like inline code.
  if (stdin.heredoc !== null && (privateCandidates(stdin.heredoc, acc.ctx).some(text => privateHit(text, cwd, acc, false)) || codeNamesPrivate(stdin.heredoc, acc.ctx))) acc.flags.appPrivate = true;
  return cwd;
}

// ---------------------------------------------------------------------------
// CanvasTTY's own private data
// ---------------------------------------------------------------------------

/** The folders CanvasTTY's gateways put their sockets in, under a temporary folder (`ctty-control-XXXX`, …). */
const SOCKET_DIR = /^ctty-(?:control|runtime|orch|user|\d+)-/u;
/** Variables that carry a control descriptor, a gateway address or a capability. */
const PRIVATE_ENV = /^(?:ENV:)?CANVASTTY_(?:CONTROL_CONNECTION|[A-Z_]*_(?:CAPABILITY|ADDRESS))$/u;
/** CanvasTTY's own control CLI reads its descriptor itself: an orchestrator may name it. */
const CONTROL_CLI = /^canvastty-control(?:\.mjs)?$/u;
/** Programs that walk folders by themselves: naming a folder that holds private data reads it. */
const RECURSIVE = new Set(['rg', 'ag', 'ack', 'find', 'fd', 'tar', 'bsdtar', 'zip', '7z', 'rsync', 'ditto', 'scp', 'rclone']);
const GLOB_CHAR = /[*?[]/u;
const MAX_PRIVATE_CHECKS = 256;
const MAX_SCANNED_TEXT = 64 * 1024;

const parts = (path: string): string[] => path.split(/[\\/]+/u).filter(Boolean);

/** A glob component (`token-*`, `ctty-control-????`) against one real name. */
function componentMatches(pattern: string, name: string): boolean {
  if (!GLOB_CHAR.test(pattern)) return pattern === name;
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close < 0) { source += '\\['; continue; }
      source += `[${pattern.slice(i + 1, close).replace(/^!/u, '^').replace(/[\\\]]/gu, '\\$&')}]`;
      i = close;
    } else source += char.replace(/[.+^${}()|\\\]]/gu, '\\$&');
  }
  try { return new RegExp(`^${source}$`, 'u').test(name); } catch { return true; }
}

/**
 * Whether one path (absolute, maybe a glob) is CanvasTTY's private data: inside a private path, a folder of the app
 * that holds one when the command walks folders, or a gateway's socket folder under a temporary folder.
 */
function privatePath(abs: string, glob: boolean, recursive: boolean, ctx: PathContext): boolean {
  if (!glob) {
    // A broad project (for example HOME) cannot reopen a more specific host-private subtree below it.
    // A validated worktree below plugin-data still owns its exact project files, not private siblings.
    if (ctx.privatePaths.some(path => isPathInside(ctx.rootReal, path) && isPathInside(path, abs))) return true;
    // The project, and the agent's own config folder (an account home it was launched with), are its own.
    if (isPathInside(ctx.rootReal, abs) || ctx.agentRoots.some(dir => isPathInside(dir, abs))) return false;
    if (ctx.privatePaths.some(path => isPathInside(path, abs))) return true;
    if (recursive && ctx.privatePaths.some(path => isPathInside(abs, path)) && ctx.appRoots.some(root => isPathInside(root, abs))) return true;
    return ctx.tempRoots.some(temp => isPathInside(temp, abs, { allowRoot: false }) && SOCKET_DIR.test(parts(relative(temp, abs))[0] ?? ''));
  }
  // A glob: the folders before its first wildcard resolved, the rest matched name by name.
  const all = parts(abs);
  const first = all.findIndex(part => GLOB_CHAR.test(part));
  const prefix = realish((abs.startsWith('/') ? '/' : '') + all.slice(0, first).join('/'));
  // A sandbox may deliberately hand the agent one project root inside CanvasTTY's private plugin-data parent. A glob
  // fixed below that exact project must not be treated as a match for the private ancestor, or ordinary project
  // searches would be denied. Skip only those ancestor paths; keep checking every private path inside the project.
  const scopedProjectGlob = !all.slice(first).includes('..') && isPathInside(ctx.rootReal, prefix);
  const pattern = [...parts(prefix), ...all.slice(first)];
  const matchesFrom = (target: string[]): number => {
    let i = 0;
    while (i < pattern.length && i < target.length && componentMatches(pattern[i]!, target[i]!)) i++;
    return i;
  };
  for (const path of ctx.privatePaths) {
    if (scopedProjectGlob && path !== ctx.rootReal && isPathInside(path, ctx.rootReal)) continue;
    const target = parts(path);
    const matched = matchesFrom(target);
    if (matched >= target.length) return true;
    if (matched === pattern.length && recursive && ctx.appRoots.some(root => parts(root).length <= pattern.length)) return true;
  }
  return ctx.tempRoots.some(temp => {
    const target = parts(temp);
    if (matchesFrom(target) < target.length || pattern.length <= target.length) return false;
    const next = pattern[target.length]!;
    return SOCKET_DIR.test(next) || next.startsWith('ctty') && GLOB_CHAR.test(next);
  });
}

/** Expands `~`, $HOME and $TMPDIR in a path found inside a word or in code; null when it is not a path. */
function codePath(text: string, ctx: PathContext): string | null {
  let value = text.trim().replace(/^file:\/\//iu, '/');
  value = value.replace(/^(?:\$HOME|\$\{HOME\})(?=[\\/]|$)/u, ctx.home).replace(/^(?:\$TMPDIR|\$\{TMPDIR\})(?=[\\/]|$)/u, ctx.temp);
  if (value === '~' || value.startsWith('~/')) value = ctx.home + value.slice(1);
  return isAbsolute(value) && value.length > 1 ? value : null;
}

/** Paths inside a word or a program text: after `=` or `:` (`--unix-socket=P`, `UNIX-CONNECT:P`), quoted strings, bare tokens. */
function privateCandidates(text: string, ctx: PathContext): string[] {
  if (text.length > MAX_SCANNED_TEXT) text = text.slice(0, MAX_SCANNED_TEXT);
  const found = new Set<string>();
  const add = (value: string | undefined): void => { const path = value ? codePath(value, ctx) : null; if (path && found.size < 64) found.add(path); };
  for (const match of text.matchAll(/[=:]((?:~|\$\{?(?:HOME|TMPDIR)\}?|[A-Za-z]:[\\/]|\\\\|\/)[^\s,;'"`()<>|&]*)/gu)) {
    // An HTTP(S) authority is not a UNC path. Keep scanning other paths in the same text.
    if (match[0].startsWith('://') && /(?:^|[^A-Za-z0-9+.-])https?$/iu.test(text.slice(0, match.index))) continue;
    add(match[1]);
  }
  for (const match of text.matchAll(/(['"`])([^'"`\n]{1,4096}?)\1/gu)) add(match[2]);
  for (const token of text.split(/[\s,;()[\]{}<>|&'"`=]+/u)) if (/^(?:~|\$\{?(?:HOME|TMPDIR)\}?|[A-Za-z]:[\\/]|\\\\|\/)/u.test(token)) add(token);
  return [...found];
}

/** Interpreter code that builds a private path from pieces: an app folder's name together with a private name. */
function codeNamesPrivate(code: string, ctx: PathContext): boolean {
  const lower = code.slice(0, MAX_SCANNED_TEXT).toLowerCase();
  if (/ctty-(?:control|runtime|orch)-/u.test(lower)) return true;
  return ctx.appNames.some(name => lower.includes(name)) && ctx.markers.some(marker => lower.includes(marker));
}

function privateHit(text: string, cwd: string | null, acc: Acc, recursive: boolean, glob = GLOB_CHAR.test(text)): boolean {
  if (--acc.privateBudget < 0) return false;
  if (!isAbsolute(text) && cwd === null) return false;
  return privatePath(glob ? resolve(cwd ?? acc.ctx.rootReal, text) : realish(resolve(cwd ?? acc.ctx.rootReal, text)), glob, recursive, acc.ctx);
}

/** The command is CanvasTTY's control CLI (`canvastty-control.mjs …`, `node "$CANVASTTY_CONTROL_CLI" …`). */
function runsControlCli(words: readonly Word[]): boolean {
  const cli = (word: Word | undefined): boolean => Boolean(word && (word.vars.length === 1 && word.vars[0] === 'CANVASTTY_CONTROL_CLI' && /^\$\{?CANVASTTY_CONTROL_CLI\}?$/u.test(word.text) || !word.vars.length && !word.substitution && CONTROL_CLI.test(programName(word.text))));
  if (cli(words[0])) return true;
  if (!words[0] || !INTERPRETERS.has(programName(words[0].text))) return false;
  return cli(words.slice(1).find(word => !word.text.startsWith('-')));
}

/**
 * One segment against CanvasTTY's private data: every word (and each path inside it), every redirection, and the
 * variables that carry a descriptor or a capability. Whatever program reads, copies, encodes or connects to them,
 * the command uses them. CanvasTTY's own control CLI is the one program that may name its descriptor.
 */
function checkPrivate(segment: Segment, words: Word[], cwd: string | null, acc: Acc): void {
  if (acc.flags.appPrivate || acc.privateBudget <= 0) return;
  if (runsControlCli(words)) return;
  const recursive = words.some(word => RECURSIVE.has(programName(word.text)) || /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--archive)$/u.test(word.text))
    || programName(words[0]?.text ?? '') === 'cp' && words.some(word => /^-[a-zA-Z]*a/u.test(word.text));
  const targets = [...segment.words, ...segment.redirects.filter(redirect => !redirect.fdDup && redirect.target).map(redirect => redirect.target!)];
  for (const word of targets) {
    if (word.vars.some(name => PRIVATE_ENV.test(name))) { acc.flags.appPrivate = true; return; }
    if (word.substitution) continue;
    const text = expand(word, cwd, acc.ctx);
    if (text === null || text === '') continue;
    const candidates = new Set([text, ...(text.length > 1 && /[=:'"\s]/u.test(text) ? privateCandidates(text, acc.ctx) : [])]);
    for (const candidate of candidates) {
      if (!privateHit(candidate, cwd, acc, recursive, candidate === text ? word.glob : GLOB_CHAR.test(candidate))) continue;
      acc.flags.appPrivate = true;
      return;
    }
  }
}

function classifyProgram(program: string, argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[]): void {
  const args = argWords.map(word => word.text);
  const windows = WINDOWS_BUILTINS.has(program) || args.some(arg => /^\/[sq]$/iu.test(arg));
  const positional = argWords.filter(word => !isFlag(word.text, windows));
  const target = (word: Word | string, noFollow = false): Target => resolveTarget(word, cwd, acc.ctx, noFollow);
  const sub = positional[0]?.text;

  // Disks.
  if (DISK.has(program) || program.startsWith('mkfs') || program.startsWith('newfs')) { acc.flags.disk = true; return; }
  if (program === 'diskutil') {
    if (/^(?:erase|zero|random|secure|partition|reformat|apfs|cs|appleraid|ar|resetfusion|repairdisk|mergepartitions|splitpartition|resizevolume|addpartition)/iu.test(sub ?? '') || /^(?:deletecontainer|deletevolume|erasevolume)$/iu.test(positional[1]?.text ?? '')) acc.flags.disk = true;
    return;
  }
  if (program === 'format' && positional.some(word => /^[A-Za-z]:\\?$/u.test(word.text))) { acc.flags.disk = true; return; }
  if (program === 'cipher' && args.some(arg => /^\/w/iu.test(arg))) { acc.flags.disk = true; return; }
  if (program === 'dd') {
    for (const arg of args) {
      const m = /^of=(.*)$/u.exec(arg);
      if (!m) continue;
      const t = target(m[1]!);
      if (t.device || /^\/dev\//u.test(m[1]!) && !HARMLESS_DEVICE.test(m[1]!)) acc.flags.disk = true;
      else acc.writes.push(t);
    }
    return;
  }

  if (program === 'git') { classifyGit(argWords, cwd, acc); return; }
  // `uv run X`, `bundle exec X` and friends run their argument as a command.
  if ((['uv', 'poetry', 'pipenv', 'conda'].includes(program) && sub === 'run') || (program === 'bundle' && sub === 'exec')) {
    const start = argWords.findIndex(word => word.text === sub);
    const inner = argWords.slice(start + 1).findIndex(word => !word.text.startsWith('-'));
    if (inner >= 0) analyzeArgv(argWords.slice(start + 1 + inner), cwd, acc, stdin, downloadedHere);
    return;
  }

  // Deleting.
  if (DELETERS.has(program)) {
    for (const word of positional.filter(word => !/^-/u.test(word.text))) {
      const t = target(word, true);
      if (heldElsewhere(word, t)) acc.flags.unknownTarget = true;
      if (program === 'shred' && t.device) acc.flags.disk = true;
      acc.deletes.push(t);
    }
    return;
  }
  if (program === 'find') {
    const starts: Word[] = [];
    let i = 0;
    // Options before the start folders: -H -L -P (symlinks), -E -X -d -s -x (BSD), -O<level>, -D <debug> (GNU), -f <path> (BSD).
    for (; i < argWords.length; i++) {
      const text = argWords[i]!.text;
      if (/^-(?:[HLPEXdsx]+|O\d*)$/u.test(text)) continue;
      if (text === '-D') { i++; continue; }
      if (text === '-f' && argWords[i + 1]) { starts.push(argWords[i + 1]!); i++; continue; }
      break;
    }
    for (; i < argWords.length && !/^[-(!]/u.test(argWords[i]!.text); i++) starts.push(argWords[i]!);
    if (!starts.length) starts.push(wordOf('.'));
    const exec = args.findIndex(arg => /^-(?:exec|execdir|ok|okdir)$/u.test(arg));
    const printTo = args.findIndex(arg => /^-f(?:print0?|printf|ls)$/u.test(arg));
    if (printTo >= 0 && args[printTo + 1]) acc.writes.push(target(args[printTo + 1]!));
    // The start folders are the scope of the deletion, not deleted themselves.
    if (args.includes('-delete')) {
      for (const start of starts) {
        const t = target(start);
        if (heldElsewhere(start, t)) acc.flags.unknownTarget = true;
        acc.deletes.push({ ...t, root: false });
      }
      return;
    }
    if (exec >= 0) {
      const end = args.findIndex((arg, index) => index > exec && (arg === ';' || arg === '+' || arg === '\\;'));
      const inner = argWords.slice(exec + 1, end < 0 ? undefined : end).map(word => word.text === '{}' ? starts[0]! : word);
      if (inner.length) analyzeArgv(inner, cwd, acc, { pipeIn: false, heredoc: null }, downloadedHere);
    }
    return;
  }

  // Writing.
  const targetDir = targetDirectory(program, argWords);
  if (COPIERS.has(program)) {
    const files = positional.filter(word => !/^-/u.test(word.text));
    const dest = targetDir ?? (files.length > 1 ? files[files.length - 1]! : program === 'install' && args.includes('-d') ? files[0] : undefined);
    // rsync to `host:path` is a remote copy, not a local write.
    if (dest && !(program === 'rsync' && /^[^/\\]*:/u.test(dest.text) && !/^[A-Za-z]:[\\/]/u.test(dest.text))) acc.writes.push(target(dest));
    return;
  }
  if (MOVERS.has(program)) {
    // A move changes both ends (a moved symlink is the link itself; the destination may be a folder it enters).
    const files = positional.filter(word => !/^-/u.test(word.text) && word !== targetDir);
    files.forEach((word, index) => {
      const t = target(word, targetDir !== undefined || index < files.length - 1);
      if (heldElsewhere(word, t)) acc.flags.unknownTarget = true;
      acc.writes.push(t);
    });
    if (targetDir) {
      const t = target(targetDir);
      if (heldElsewhere(targetDir, t)) acc.flags.unknownTarget = true;
      acc.writes.push(t);
    }
    return;
  }
  if (CREATORS.has(program)) {
    const files = positional.filter(word => !/^-/u.test(word.text));
    if (program === 'truncate') { const size = args.findIndex(arg => arg === '-s'); if (size >= 0) files.splice(files.findIndex(word => word.text === args[size + 1]), 1); }
    if (program === 'mktemp') acc.writes.push(files.length ? target(files[0]!) : target(acc.ctx.temp));
    else for (const word of files) acc.writes.push(target(word));
    return;
  }
  if (MODE_CHANGERS.has(program)) {
    const files = positional.filter(word => !/^-/u.test(word.text)).slice(program === 'attrib' || program === 'icacls' || program === 'takeown' ? 0 : 1);
    for (const word of files) acc.writes.push(target(word));
    return;
  }
  if (program === 'sed' || program === 'gsed') {
    if (!args.some(arg => /^-[a-zA-Z]*i/u.test(arg) || arg.startsWith('--in-place'))) return;
    const explicitScript = args.some(arg => arg === '-e' || arg === '-f' || arg.startsWith('--expression'));
    for (const word of positional.filter(word => !/^-/u.test(word.text)).slice(explicitScript ? 0 : 1)) acc.writes.push(target(word));
    return;
  }
  if (program === 'tar' || program === 'bsdtar' || program === 'unzip' || program === '7z' || program === 'unrar') {
    const tar = program === 'tar' || program === 'bsdtar';
    // tar: the old bundled first word (`xzf`) or any short cluster with x (`-C dir -xzf`), --extract, --get.
    const extract = program === 'unzip' || program === 'unrar' || program === '7z' && sub === 'x'
      || tar && (/^[a-zA-Z]*x/u.test(args[0] ?? '') || args.some(arg => /^-[a-zA-Z]*x[a-zA-Z]*$/u.test(arg) || arg === '--extract' || arg === '--get'));
    let dest: string | undefined = '.';
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (tar && (arg === '-C' || arg === '--directory') || program === 'unzip' && arg === '-d') dest = args[i + 1];
      else if (tar && arg.startsWith('--directory=')) dest = arg.slice('--directory='.length);
      else if (tar && /^-C./u.test(arg)) dest = arg.slice(2);
      else if (program === '7z' && arg.startsWith('-o') && arg.length > 2) dest = arg.slice(2);
      else continue;
      break;
    }
    if (extract && dest) acc.writes.push(target(dest));
    const fileFlag = args.findIndex(arg => /^-?[a-zA-Z]*f$/u.test(arg) || arg === '--file');
    if (!extract && fileFlag >= 0 && args[fileFlag + 1]) acc.writes.push(target(args[fileFlag + 1]!));
    return;
  }
  if (FETCHERS.has(program)) classifyFetch(program, argWords, cwd, acc, downloadedHere);
}

/** curl and wget short options that take a value (the rest of the cluster, or the next word). */
const CURL_VALUE_LETTERS = new Set([...'oAbcCdDeEFHKmPQrtTuUwxXyYz']);
const WGET_VALUE_LETTERS = new Set([...'OPoaeiBtTwQUlADIXR']);
/**
 * Per program, how each option that names a file it writes is read: `output` (the download itself), `dir` (the
 * folder downloads land in), `side` (a file written besides the download: cookie jar, headers, trace, log),
 * `format` (curl's --write-out, whose `%output{FILE}` writes FILE). Short letters and long names alike; a long
 * name also takes `--name=value`.
 */
const FETCH_FILE_OPTIONS: Record<'curl' | 'wget', Record<string, 'output' | 'dir' | 'side' | 'format'>> = {
  curl: {
    o: 'output', '--output': 'output', '--output-dir': 'dir', c: 'side', '--cookie-jar': 'side', D: 'side', '--dump-header': 'side',
    '--trace': 'side', '--trace-ascii': 'side', '--stderr': 'side', '--libcurl': 'side', '--etag-save': 'side', '--hsts': 'side',
    '--alt-svc': 'side', w: 'format', '--write-out': 'format'
  },
  wget: {
    O: 'output', '--output-document': 'output', P: 'dir', '--directory-prefix': 'dir', o: 'side', '--output-file': 'side', a: 'side',
    '--append-output': 'side', '--save-cookies': 'side', '--rejected-log': 'side', '--warc-file': 'side'
  }
};
/** Long options of curl and wget whose next word is their value (so it is not taken for a URL or a flag). */
const FETCH_LONG_VALUES: Record<'curl' | 'wget', ReadonlySet<string>> = {
  curl: new Set(['--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--form', '--user', '--user-agent', '--referer', '--cookie', '--config', '--request', '--proxy', '--resolve', '--connect-to', '--max-time', '--connect-timeout', '--retry', '--upload-file', '--url', '--cacert', '--cert', '--key', '--netrc-file', '--range', '--interface', '--variable', '--json', '--etag-compare']),
  wget: new Set(['--user', '--password', '--header', '--user-agent', '--referer', '--load-cookies', '--post-data', '--post-file', '--input-file', '--tries', '--timeout', '--wait', '--execute', '--level', '--accept', '--reject', '--domains', '--base', '--config'])
};

/** `-t DIR`, `-tDIR`, `--target-directory DIR`, `--target-directory=DIR` of GNU cp, mv, install and ln. */
function targetDirectory(program: string, argWords: readonly Word[]): Word | undefined {
  if (!['cp', 'mv', 'install', 'ln'].includes(program)) return undefined;
  for (let i = 0; i < argWords.length; i++) {
    const text = argWords[i]!.text;
    if (text === '-t' || text === '--target-directory') return argWords[i + 1];
    if (text.startsWith('--target-directory=')) return { ...argWords[i]!, text: text.slice('--target-directory='.length), tilde: text.slice('--target-directory='.length).startsWith('~') };
    if (/^-t./u.test(text)) return { ...argWords[i]!, text: text.slice(2), tilde: text.slice(2).startsWith('~') };
  }
  return undefined;
}

/**
 * Where a download lands and what else it writes. curl and wget are read option by option (a flag of its own, a
 * short cluster like `-fsSLo FILE` or `-c@FILE`, `--long VALUE` and `--long=VALUE`); curl's -o and -O files land
 * in the --output-dir of their own operation (curl resets it at `--next` / `-:`) wherever it stands in that
 * operation (curl joins the folder even to an absolute -o path), each URL of -O or --remote-name-all under its own
 * name; --output-dir alone writes no file. Other fetchers: `-o`/`--output`/`-OutFile` and their folder
 * flags.
 */
function classifyFetch(program: string, argWords: Word[], cwd: string | null, acc: Acc, downloadedHere: Target[]): void {
  const args = argWords.map(word => word.text);
  const target = (word: Word | string): Target => resolveTarget(word, cwd, acc.ctx);
  const urls = args.filter(arg => /^[a-z]+:\/\//iu.test(arg) || /^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/iu.test(arg));
  const land = (t: Target): void => { acc.writes.push(t); downloadedHere.push(t); };
  const urlName = (url: string): string => url.replace(/[?#].*$/u, '').split('/').pop() || 'index.html';
  // Standard output (`-`) and /dev/null, NUL and the like write no file.
  const sink = (value: Word | string): boolean => { const text = typeof value === 'string' ? value : value.text; return text === '-' || HARMLESS_DEVICE.test(text); };
  if (program !== 'curl' && program !== 'wget') {
    let explicit = false;
    let outputDir: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!, next = argWords[i + 1];
      const long = /^(--output|--output-document|--directory-prefix|--output-dir)=(.*)$/u.exec(arg);
      if (long) {
        if (long[1] === '--output-dir') outputDir = expand(long[2]!, cwd, acc.ctx);
        else { explicit = true; if (!sink(long[2]!)) land(target(long[2]!)); }
        continue;
      }
      if (arg === '--output-dir' && next) { outputDir = expand(next, cwd, acc.ctx); i++; continue; }
      if ((arg === '-o' || arg === '--output' || arg === '--output-document' || /^-outfile$/iu.test(arg) || arg === '-P' || arg === '--directory-prefix') && next) {
        explicit = true;
        if (!sink(next)) land(target(next));
        i++; continue;
      }
      if (arg === '-O' || arg === '--remote-name' || arg === '--remote-name-all') { explicit = true; land(target(outputDir ? join(outputDir, urlName(urls[0] ?? '')) : urlName(urls[0] ?? ''))); }
    }
    if (outputDir && !explicit) acc.writes.push(target(outputDir));
    return;
  }
  const options = FETCH_FILE_OPTIONS[program];
  // curl resets its per-transfer options at `--next` (`-:`): each operation keeps its own outputs, -O count and
  // --output-dir. wget has no such boundary, so its whole line is one operation.
  let outputs: Array<Word | string> = [];
  let dir: Word | string | null = null;
  let remoteNames = 0;
  let remoteAll = false;
  let opStart = 0;
  const take = (kind: 'output' | 'dir' | 'side' | 'format', value: Word | string): void => {
    if (kind === 'output') outputs.push(value);
    else if (kind === 'dir') dir = value;
    else if (kind === 'side') { if (!sink(value)) acc.writes.push(target(value)); }
    // `%output{FILE}` and `%output{>>FILE}` send the rest of the format to FILE.
    else for (const match of (typeof value === 'string' ? value : value.text).matchAll(/%output\{(?:>>)?([^}]*)\}/gu)) if (match[1] && !sink(match[1])) acc.writes.push(target(match[1]));
  };
  // The curl operation that ends before word `end`: its -o and -O files land in its own --output-dir, joined as
  // curl joins them (`--output-dir D -o F` writes D/F, even for an absolute F). --output-dir with no -o or -O
  // writes nothing: the response goes to standard output.
  const finishCurl = (end: number): void => {
    const opDir: Word | string | null = dir;
    const landing = (file: Word | string): Target => {
      if (opDir === null) return target(file);
      const dirText = expand(opDir, cwd, acc.ctx);
      const fileText = typeof file === 'string' ? file : expand(file, cwd, acc.ctx);
      // A folder or name that cannot be expanded leaves the place unknown.
      if (dirText === null) return target(opDir);
      if (fileText === null) return target(file);
      return target(join(dirText, fileText));
    };
    for (const file of outputs) if (!sink(file)) land(landing(file));
    // Each -O takes the next URL's name; --remote-name-all names them all.
    const opUrls = args.slice(opStart, end).filter(arg => urls.includes(arg));
    const named = remoteAll ? opUrls : opUrls.slice(0, remoteNames);
    if ((remoteAll || remoteNames > 0) && named.length === 0) named.push('');
    for (const url of named) land(landing(urlName(url)));
    outputs = []; dir = null; remoteNames = 0; remoteAll = false;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = argWords[i + 1];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg : arg.slice(0, eq);
      const kind = options[name];
      if (program === 'curl' && arg === '--next') { finishCurl(i); opStart = i + 1; continue; }
      if (name === '--remote-name') { remoteNames++; continue; }
      if (name === '--remote-name-all') { if (program === 'curl') remoteAll = true; else remoteNames++; continue; }
      if (eq >= 0) { if (kind) take(kind, arg.slice(eq + 1)); continue; }
      if (kind) { if (next) take(kind, next); i++; continue; }
      if (FETCH_LONG_VALUES[program].has(name)) i++;
      continue;
    }
    if (!/^-[^-]/u.test(arg)) continue;
    // A short option of its own or a cluster: `-c FILE`, `-cFILE`, `-sSc FILE`, `-fsSLo FILE`, `-qO FILE`, `-:`.
    const takes = program === 'curl' ? CURL_VALUE_LETTERS : WGET_VALUE_LETTERS;
    for (let k = 1; k < arg.length; k++) {
      const letter = arg[k]!;
      if (program === 'curl' && letter === ':') { finishCurl(i); opStart = i; continue; }
      if (program === 'curl' && letter === 'O') { remoteNames++; continue; }
      if (!takes.has(letter)) continue;
      const attached = arg.slice(k + 1);
      const value: Word | string | undefined = attached || next;
      if (!attached) i++;
      const kind = options[letter];
      if (kind && value !== undefined) take(kind, value);
      break;
    }
  }
  if (program === 'curl') { finishCurl(args.length); return; }
  // wget: -O sets the file (-P does not apply to it); otherwise the URL's name lands in -P's folder or here.
  let landed = false;
  for (const file of outputs) {
    landed = true;
    if (!sink(file)) land(target(file));
  }
  if (landed || args.includes('--spider')) return;
  land(dir === null ? target(urlName(urls[0] ?? '')) : target(dir));
}

function classifyGit(argWords: Word[], cwd: string | null, acc: Acc): void {
  const args = argWords.map(word => word.text);
  let i = 0, dir = cwd;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-C') { dir = args[i + 1] ? resolveTarget(argWords[i + 1]!, cwd, acc.ctx).abs : null; i++; continue; }
    // The repository another --work-tree or --git-dir names is changed exactly like one -C names.
    if (arg === '--work-tree' || arg === '--git-dir') { dir = args[i + 1] ? resolveTarget(argWords[i + 1]!, cwd, acc.ctx).abs : null; i++; continue; }
    if (arg.startsWith('--work-tree=') || arg.startsWith('--git-dir=')) { dir = resolveTarget(arg.slice(arg.indexOf('=') + 1), cwd, acc.ctx).abs; continue; }
    if (arg === '-c') { gitConfigCommand(args[i + 1] ?? '', dir, acc); i++; continue; }
    if (arg === '--namespace' || arg === '--exec-path') { i++; continue; }
    if (arg.startsWith('-')) continue;
    break;
  }
  const sub = args[i] ?? '';
  const restWords = argWords.slice(i + 1);
  const rest = restWords.map(word => word.text);
  if (GIT_READ.has(sub)) return;
  // `git -C <folder outside>` that changes or cleans that repository changes files outside.
  const other = dir !== cwd && dir !== null ? resolveTarget(dir, cwd, acc.ctx) : null;
  const elsewhere = other?.where === 'outside' ? { ...other, root: false } : null;
  const effect = gitEffect(sub, rest);
  if (effect === 'read') return;
  if (effect === 'delete') {
    if (elsewhere) acc.deletes.push(elsewhere);
    return;
  }
  if (sub === 'clean' || sub === 'rm') {
    for (const word of restWords.filter(word => !word.text.startsWith('-'))) acc.deletes.push(resolveTarget(word, dir, acc.ctx, true));
    if (elsewhere) acc.deletes.push(elsewhere);
    return;
  }
  if (sub === 'clone') {
    const positional = restWords.filter(word => !word.text.startsWith('-'));
    const url = positional[0]?.text ?? '';
    acc.writes.push(resolveTarget(positional[1] ?? wordOf(url.replace(/[?#].*$/u, '').replace(/\.git$/u, '').split(/[/:]/u).pop() || 'repo'), dir, acc.ctx));
    return;
  }
  if (sub === 'worktree' && rest[0] === 'add') {
    const dest = restWords.slice(1).find(word => !word.text.startsWith('-'));
    if (dest) acc.writes.push(resolveTarget(dest, dir, acc.ctx));
    // `worktree add` also records the new worktree in the repository's own .git/worktrees administrative area,
    // wherever the new worktree folder itself lands.
    if (elsewhere) acc.writes.push(elsewhere);
    return;
  }
  if (elsewhere) acc.writes.push(elsewhere);
}

/**
 * Config keys whose value git runs as a shell command: a `!` alias, and the hooks, pagers, editors, filters and
 * helpers a `git -c key=value` can set for this one run. Such a value is read like any other command.
 */
const GIT_COMMAND_KEYS = /^(?:core\.(?:fsmonitor|sshcommand|pager|editor|askpass)|sequence\.editor|pager\..+|diff\..+\.(?:textconv|command)|diff\.external|filter\..+\.(?:clean|smudge|process)|merge\..+\.driver|(?:diff|merge)tool\..+\.cmd|credential\.helper|credential\..+\.helper|gpg\.program|gpg\..+\.program|uploadpack\.packobjectshook)$/u;

function gitConfigCommand(setting: string, cwd: string | null, acc: Acc): void {
  const at = setting.indexOf('=');
  if (at <= 0) return;
  const key = setting.slice(0, at).toLowerCase();
  const value = setting.slice(at + 1);
  if (key.startsWith('alias.')) { if (value.startsWith('!')) analyzeText(value.slice(1), cwd, acc); return; }
  if (GIT_COMMAND_KEYS.test(key)) analyzeText(value.replace(/^!/u, ''), cwd, acc);
}

/** Flags whose next word is their value, per subcommand, so a value is never taken for a name. */
const GIT_VALUE_FLAGS: Record<string, readonly string[]> = {
  branch: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '--column'],
  tag: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '--column', '-m', '--message', '-F', '--file', '-u', '--local-user', '--cleanup'],
  config: ['-f', '--file', '--blob', '--type', '--default', '--comment']
};

/**
 * For the subcommands that have read-only and changing forms: whether this form reads, changes ('write') or
 * deletes ('delete': saved stashes, branches, tags, remotes, reflog entries) the repository; null for any other
 * subcommand (then the caller's own rules apply). Parsed only; nothing is run.
 */
function gitEffect(sub: string, rest: readonly string[]): 'read' | 'write' | 'delete' | null {
  const values = new Set(GIT_VALUE_FLAGS[sub] ?? []);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (values.has(arg)) { i++; continue; }
    if (!arg.startsWith('-')) positional.push(arg);
  }
  const has = (...flags: string[]): boolean => rest.some(arg => flags.some(flag => arg === flag || flag.startsWith('--') && arg.startsWith(`${flag}=`)));
  switch (sub) {
    case 'stash': {
      const action = positional[0];
      if (action === 'list' || action === 'show') return 'read';
      return action === 'drop' || action === 'clear' ? 'delete' : 'write';
    }
    case 'pull': return 'write';
    case 'fetch':
    case 'push': return has('--dry-run') ? 'read' : 'write';
    case 'branch':
      if (has('-d', '-D', '--delete')) return 'delete';
      if (has('-m', '-M', '--move', '-c', '-C', '--copy', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '-f', '--force', '-t', '--track')) return 'write';
      return positional.length > 0 && !has('-l', '--list') ? 'write' : 'read';
    case 'tag':
      if (has('-d', '--delete')) return 'delete';
      if (has('-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-f', '--force', '-m', '--message', '-F', '--file')) return 'write';
      return positional.length > 0 && !has('-l', '--list', '-v', '--verify') ? 'write' : 'read';
    case 'config': {
      const action = positional[0];
      if (action === 'get' || action === 'list') return 'read';
      if (action === 'set' || action === 'unset' || action === 'rename-section' || action === 'remove-section' || action === 'edit') return 'write';
      if (has('--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit')) return 'write';
      if (has('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list')) return 'read';
      return positional.length >= 2 ? 'write' : 'read';
    }
    case 'remote': {
      const action = positional[0];
      if (action === undefined || action === 'show' || action === 'get-url') return 'read';
      return action === 'remove' || action === 'rm' ? 'delete' : 'write';
    }
    case 'reflog': {
      const action = positional[0];
      return action === 'expire' || action === 'delete' ? 'delete' : 'read';
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// The whole call
// ---------------------------------------------------------------------------

/** Converts an argv array (Codex style `["bash","-lc","…"]`) into one command string. */
export function commandFromArgv(argv: readonly string[]): string { return argv.map(shellQuote).join(' '); }

export function analyzeAction(action: ToolAction, root: string, options: { home?: string; agentRoots?: readonly string[]; privateData?: PrivateData } = {}): HardFacts {
  const ctx = pathContext(root, options.home, options.agentRoots, options.privateData);
  const acc: Acc = { ctx, writes: [], deletes: [], depth: 0, budget: 64, argvDepth: 0, privateBudget: MAX_PRIVATE_CHECKS,
    flags: { elevation: false, pipeToShell: false, downloadExec: false, disk: false, forkBomb: false, appPrivate: false, unknownTarget: false } };
  const commandCwd = action.commandCwd ? resolveTarget(action.commandCwd, ctx.rootReal, ctx) : null;
  const cwd = commandCwd ? commandCwd.abs : ctx.rootReal;
  if (action.kind === 'shell' && action.command) analyzeText(action.command, cwd, acc);
  else if (action.kind === 'edit') {
    acc.writes.push(...action.paths.map(path => resolveTarget(path, cwd, ctx)));
    if (action.paths.some(path => { const text = codePath(path, ctx) ?? path; return privateHit(text, cwd, acc, false, false); })) acc.flags.appPrivate = true;
  }
  const outside = acc.writes.filter(t => t.where === 'outside' && !t.device && !(t.abs && isAgentServicePath(t.abs, ctx)));
  return {
    ...acc.flags,
    writesOutside: outside.length > 0,
    // Deleting the working folder itself counts as deleting outside it.
    deletesOutside: acc.deletes.some(t => t.where === 'outside' || t.root),
    outsideWrites: outside.map(t => t.abs).filter((abs): abs is string => abs !== null)
  };
}
