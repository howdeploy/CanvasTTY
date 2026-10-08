import { execFile } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, posix, win32 } from "node:path";
import { CLAUDE_HTTP_HOOK } from "../../../agent-runtime/runtime-protocol.mjs";
import type { AgentNetworkMode } from "../isolation/networkPolicy.ts";

/**
 * When Claude Code's lifecycle hooks may go over HTTP to the gateway's loopback listener instead of through the
 * command helper. Every way an HTTP hook fails lets Claude go on (measured with 2.1.281): a refused connection, an
 * error status, a timeout, an unreadable answer. For lifecycle events that costs only the card's status, but some
 * settings make the hooks fail on every call, so a launch uses HTTP only when none of them applies:
 *
 * - Claude's own sandbox (the "auto" profile turns it on) sends HTTP hooks through its proxy, which answers 403;
 * - `HTTP_PROXY` and friends route them through that proxy;
 * - `allowedHttpHookUrls` blocks them, and `httpHookAllowedEnvVars` empties the headers that carry the capability;
 * - a plugin environment (container, remote host) has another 127.0.0.1 and none of CanvasTTY's variables;
 * - Linux strict-network isolation cannot reach the host's loopback HTTP listener (the helper's Unix socket still works);
 * - Windows keeps its current-user named pipe; older Claude versions are untested.
 *
 * Otherwise the command helper runs exactly as before.
 */
export interface ClaudeHttpLaunchFacts {
  /** The Claude executable this launch runs. */
  executable: string;
  profile: string;
  /** A plugin environment wraps the launch (container, remote host). */
  environmentWrapped: boolean;
  /** The launch's environment as Claude will see it. */
  env: Readonly<Record<string, string | undefined>>;
  /** Claude's arguments (inline `--settings` values are read). */
  args: readonly string[];
  cwd: string;
  /** Strict network modes may isolate loopback from the host gateway on Linux. */
  networkMode?: AgentNetworkMode;
}

export type ClaudeHttpVerdict = { ok: true } | { ok: false; reason: string };

export interface ClaudeHttpHookPolicyOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** Claude Code's managed settings files for this platform (tests replace them). */
  managedSettingsPaths?: readonly string[];
  readText?: (path: string) => string | null;
  /** What is at a path (tests replace the file system). */
  entry?: (path: string) => "file" | "directory" | null;
  version?: (executable: string) => string | null;
}

const PROXY_ENV = /^(?:https?|all)_proxy$/iu;
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_PROJECT_DEPTH = 32;

export class ClaudeHttpHookPolicy {
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly managedSettingsPaths: readonly string[];
  private readonly readText: (path: string) => string | null;
  private readonly entry: (path: string) => "file" | "directory" | null;
  private readonly version: (executable: string) => string | null;

  constructor(options: ClaudeHttpHookPolicyOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? homedir();
    this.managedSettingsPaths = options.managedSettingsPaths ?? managedSettingsFiles(this.platform);
    this.readText = options.readText ?? readSmallText;
    this.entry = options.entry ?? entryAt;
    const versions = new ClaudeVersions();
    this.version = options.version ?? ((executable) => versions.get(executable));
  }

  verdict(facts: ClaudeHttpLaunchFacts): ClaudeHttpVerdict {
    if (this.platform === "win32") return { ok: false, reason: "Windows keeps the named-pipe helper" };
    if (this.platform === "linux" && facts.networkMode !== undefined && facts.networkMode !== "open") {
      return { ok: false, reason: "Linux strict network isolation cannot reach the loopback HTTP hook listener" };
    }
    if (facts.environmentWrapped) return { ok: false, reason: "a plugin environment runs the agent" };
    if (facts.profile === "auto") return { ok: false, reason: "Claude's sandbox (auto profile) proxies HTTP hooks" };
    const version = this.version(facts.executable);
    if (!version || compareVersions(version, CLAUDE_HTTP_HOOK.minimumVersion) < 0) {
      return { ok: false, reason: version ? `Claude ${version} is older than ${CLAUDE_HTTP_HOOK.minimumVersion}` : "Claude's version is not known yet" };
    }
    const proxy = Object.keys(facts.env).find((key) => PROXY_ENV.test(key) && Boolean(facts.env[key]));
    if (proxy) return { ok: false, reason: `${proxy} would route HTTP hooks through a proxy` };
    for (const settings of this.settingsSources(facts)) {
      const reason = blockingSetting(settings);
      if (reason) return { ok: false, reason };
    }
    return { ok: true };
  }

  /** Every settings object Claude reads for this launch that CanvasTTY can see: inline, managed, user, project. */
  private *settingsSources(facts: ClaudeHttpLaunchFacts): Generator<unknown> {
    // The paths Claude reads on the platform this policy decides for (the host's in the app).
    const { join, dirname } = pathRules(this.platform);
    for (let index = 0; index < facts.args.length; index++) {
      const argument = facts.args[index]!;
      const value = argument === "--settings" ? facts.args[index + 1] : argument.startsWith("--settings=") ? argument.slice(11) : undefined;
      if (value === undefined) continue;
      // A settings file argument is read like the files below.
      yield value.trimStart().startsWith("{") ? parseJson(value) : parseJson(this.readText(value));
    }
    for (const path of this.managedSettingsPaths) yield parseJson(this.readText(path));
    const configDir = facts.env.CLAUDE_CONFIG_DIR || join(this.home, ".claude");
    yield parseJson(this.readText(join(configDir, "settings.json")));
    // Up to the repository root; never above HOME (its .claude is the user settings above, and nothing above it is a
    // project). Every step is a synchronous stat on the launch path, so a folder without `.claude` costs one.
    let folder = facts.cwd;
    for (let depth = 0; depth < MAX_PROJECT_DEPTH; depth++) {
      if (this.entry(join(folder, ".claude")) === "directory") {
        yield parseJson(this.readText(join(folder, ".claude", "settings.json")));
        yield parseJson(this.readText(join(folder, ".claude", "settings.local.json")));
      }
      if (this.entry(join(folder, ".git")) !== null || folder === this.home) break;
      const parent = dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
  }
}

/** Why these settings stop Claude's HTTP hooks from reaching the gateway, or null. */
export function blockingSetting(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.sandbox) && value.sandbox.enabled === true) return "Claude's sandbox is enabled in its settings";
  if (value.allowedHttpHookUrls !== undefined) return "Claude's settings restrict HTTP hook URLs";
  if (value.httpHookAllowedEnvVars !== undefined) return "Claude's settings restrict HTTP hook headers";
  if (isRecord(value.env)) {
    const proxy = Object.keys(value.env).find((key) => PROXY_ENV.test(key));
    if (proxy) return `Claude's settings set ${proxy}`;
  }
  return null;
}

/** `a` against `b` as dotted numbers: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10));
  const right = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (Number.isFinite(left[index]) ? left[index]! : 0) - (Number.isFinite(right[index]) ? right[index]! : 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const VERSION_RE = /^(\d{1,4}\.\d{1,4}\.\d{1,6})(?:[-+][\w.]+)?$/u;

/**
 * Claude's version per executable. The native installer's layout names it (`…/claude/versions/2.1.281`), so most
 * launches know it at once; otherwise `claude --version` runs once in the background and the launches before its
 * answer keep the helper.
 */
export class ClaudeVersions {
  private readonly known = new Map<string, string | null>();
  private readonly pending = new Set<string>();

  get(executable: string): string | null {
    let real: string;
    let key: string;
    try {
      real = realpathSync(executable);
      const info = statSync(real);
      key = `${real}\0${info.size}\0${info.mtimeMs}`;
    } catch {
      return null;
    }
    const cached = this.known.get(key);
    if (cached !== undefined) return cached;
    const fromPath = VERSION_RE.exec(basename(real));
    if (fromPath && basename(dirname(real)) === "versions") {
      this.known.set(key, fromPath[1]!);
      return fromPath[1]!;
    }
    if (!this.pending.has(key)) {
      this.pending.add(key);
      execFile(real, ["--version"], { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true }, (error, stdout) => {
        this.pending.delete(key);
        const version = error ? null : /(\d{1,4}\.\d{1,4}\.\d{1,6})/u.exec(String(stdout))?.[1] ?? null;
        this.known.set(key, version);
      });
    }
    return null;
  }
}

const pathRules = (platform: NodeJS.Platform): typeof posix => platform === "win32" ? win32 : posix;

function managedSettingsFiles(platform: NodeJS.Platform): string[] {
  const { join } = pathRules(platform);
  const root = platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : platform === "win32" ? "C:\\Program Files\\ClaudeCode"
      : "/etc/claude-code";
  const files = [join(root, "managed-settings.json")];
  try {
    for (const name of readdirSync(join(root, "managed-settings.d")).sort()) {
      if (name.endsWith(".json")) files.push(join(root, "managed-settings.d", name));
    }
  } catch { /* no drop-in folder */ }
  return files;
}

/** A missing file costs one stat and no thrown error (the common case on the launch path). */
function readSmallText(path: string): string | null {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > MAX_SETTINGS_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function entryAt(path: string): "file" | "directory" | null {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    return info?.isDirectory() ? "directory" : info ? "file" : null;
  } catch {
    return null;
  }
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
