import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { ProviderId, ShortcutBindings } from "../../shared/contracts.ts";
import { normalizeThreadId } from "../../agent-runtime/runtime-protocol.mjs";
import { openCodeAutoEnvironment, openCodeYoloEnvironment } from "./openCodeConfig.ts";
import { autoKind, CLAUDE_SANDBOX_SETTINGS, profileArguments, type LaunchProfile } from "../../shared/autoMode.ts";
import { providerEffortArguments, providerModelArguments, type ReasoningEffort } from "../../shared/launchModel.ts";
import {
  providerTerminalBatchCommandLine,
  windowsCommandPromptPath,
  type ProviderCliResolution
} from "./providerCliRegistry.ts";

export interface TerminalLaunch {
  command: string;
  args: string[] | string;
  environment?: Record<string, string>;
}

interface LaunchResolutionOptions {
  shortcuts?: ShortcutBindings;
  platform?: NodeJS.Platform;
  environment?: Readonly<NodeJS.ProcessEnv>;
  fileExists?: (path: string) => boolean;
  resourcesPath?: string;
  providerCli?: ProviderCliResolution;
  resumePrevious?: boolean;
  resumeThreadId?: string;
  /** A launch contributor runs the CLI on another model: "auto" becomes accept-edits (autoModeArguments). */
  thirdPartyModel?: boolean;
  /** OpenCode "auto": CanvasTTY's base protection is on and its guard runs in this launch, so shell commands may run
   *  without OpenCode asking (hard denies still deny). Without it, auto still asks for them. */
  shellGuarded?: boolean;
  /** The CLI's --model and reasoning effort for this run (launchModel.ts); checked again here. */
  model?: string;
  effort?: ReasoningEffort;
  /**
   * The launch runs inside CanvasTTY's isolation layer. macOS refuses a sandbox inside another one, so Claude Code's own
   * sandbox block is left out there (its commands would all fail); the layer contains them instead. A CLI without an
   * auto mode of its own gets its "auto" (its approval bypass) only here.
   */
  isolated?: boolean;
  /** The folder the CLI runs in (OpenCode's project configuration is read from it). */
  cwd?: string;
  initialPrompt?: string;
  initialImagePath?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WINDOWS_NATIVE_EXTENSIONS = [".exe", ".com"];

export function resolveTerminalLaunch(
  provider: ProviderId,
  profile: LaunchProfile,
  agentBrowserArgs: string[] = [],
  options: LaunchResolutionOptions = {}
): TerminalLaunch {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const fileExists = options.fileExists ?? existsSync;

  if (provider === "terminal") {
    return platform === "win32"
      ? resolveWindowsShell(environment, fileExists)
      : { command: environment.SHELL || "/bin/bash", args: ["-l"] };
  }

  const providerCli = options.providerCli;
  if (!providerCli || providerCli.provider !== provider) {
    throw new Error(`${provider} CLI resolution was not provided.`);
  }
  if (providerCli.state === "unavailable") throw new Error(providerCli.diagnostic);

  const kind = autoKind(provider);
  const containedAuto = profile === "auto" && kind === "contained";
  if (containedAuto && options.isolated !== true) {
    throw new Error(`${provider} has no auto mode of its own; its auto runs only inside CanvasTTY's agent isolation.`);
  }
  const launchEnvironment = provider !== "opencode" ? undefined
    : profile === "yolo" ? openCodeYoloEnvironment({ ...environment, ...providerCli.environment })
      : profile === "auto" || profile === "acceptEdits" ? openCodeAutoEnvironment({ ...environment, ...providerCli.environment }, {
        // Accept-edits: edits run, every shell command asks.
        shellGuarded: profile === "auto" && options.shellGuarded === true,
        ...(options.thirdPartyModel ? { thirdPartyModel: true } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {})
      })
        : undefined;
  // Claude Code's own sandbox where CanvasTTY's layer does not run (and the CLI has one on this platform).
  const claudeSandbox = provider === "claude" && (profile === "auto" || profile === "acceptEdits") && options.isolated !== true
    && (platform === "darwin" || platform === "linux");
  const providerArgs = [
    ...(provider === "codex" && agentBrowserArgs.includes("-c") ? ["--no-daemon"] : []),
    ...((profile === "yolo" || containedAuto) && provider !== "opencode" ? DANGEROUS_ARGUMENTS[provider] : []),
    ...(provider === "codex" && options.isolated === true && profile !== "yolo"
      ? codexInsideIsolation(profile, options.thirdPartyModel === true)
      : profile !== "normal" && profile !== "yolo" && !containedAuto ? profileArguments(provider, profile, options.thirdPartyModel === true) : []),
    // Claude Code keeps only the last inline --settings: a plugin's (after the hooks') would silently drop the hooks.
    // Its sandbox joins the same one.
    ...(provider === "claude"
      ? mergeClaudeInlineSettings(claudeSandbox ? [...agentBrowserArgs, "--settings", JSON.stringify({ sandbox: CLAUDE_SANDBOX_SETTINGS })] : agentBrowserArgs)
      : agentBrowserArgs),
    ...providerModelArguments(provider, options.model),
    ...providerEffortArguments(provider, options.effort),
    ...(options.resumePrevious ? resolveResumeArguments(provider, options.resumeThreadId) : []),
    ...(provider === "codex" && options.initialPrompt && options.initialImagePath
      ? [options.initialPrompt.replace(/[\r\n]+/g, " "), "--image", options.initialImagePath] : [])
  ];
  const combinedEnvironment = {
    ...providerCli.environment,
    ...launchEnvironment
  };
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const bundledDirectory = provider === "codex" && (platform === "darwin" || platform === "linux") && resourcesPath
    ? posix.join(resourcesPath, "codex-native-tui") : undefined;
  const bundledFrontend = bundledDirectory ? posix.join(bundledDirectory, "canvastty-codex-tui") : undefined;
  const bundledLauncher = bundledDirectory ? posix.join(bundledDirectory, "codex-tui-launch.mjs") : undefined;
  const qaFrontend = environment.CANVASTTY_CODEX_TUI_QA;
  const frontend = qaFrontend || (bundledFrontend && bundledLauncher
    && (fileExists(bundledFrontend) || fileExists(bundledLauncher)) ? bundledFrontend : undefined);
  if (provider === "codex" && frontend) {
    const launcher = qaFrontend ? environment.CANVASTTY_CODEX_TUI_LAUNCHER_QA : bundledLauncher;
    if ((platform !== "darwin" && platform !== "linux") || providerCli.launcher !== "native"
      || !posix.isAbsolute(frontend) || !fileExists(frontend)
      || !launcher || !posix.isAbsolute(launcher) || !fileExists(launcher)) {
      throw new Error("Codex native TUI requires existing absolute frontend and launcher paths on macOS or Linux.");
    }
    return {
      command: process.execPath,
      args: [launcher, "--backend", providerCli.executable, "--frontend", frontend, "--", ...providerArgs],
      environment: {
        ...combinedEnvironment, ELECTRON_RUN_AS_NODE: "1",
        ...(options.shortcuts ? { CANVASTTY_CODEX_KEYBOARD: JSON.stringify({
          submit: options.shortcuts.codexSubmit,
          submitAlternate: options.shortcuts.codexSubmitAlternate,
          submitSuper: options.shortcuts.codexSubmitSuper,
          newline: options.shortcuts.codexNewline,
          selectAll: options.shortcuts.codexSelectAll
        }) } : {})
      }
    };
  }
  if (providerCli.launcher === "native") {
    return {
      command: providerCli.executable,
      args: providerArgs,
      environment: combinedEnvironment
    };
  }
  if (!providerCli.commandPrompt) throw new Error("A Windows batch provider requires cmd.exe.");
  return {
    command: providerCli.commandPrompt,
    args: providerTerminalBatchCommandLine(providerCli.executable, providerArgs),
    environment: combinedEnvironment
  };
}

/**
 * Codex inside CanvasTTY's isolation layer. macOS refuses a sandbox inside another one, so Codex's own seatbelt could
 * not start and every command would fail once before being re-requested. The layer already confines the files, so
 * Codex runs with its own sandbox off (`-s danger-full-access`, never the bypass flag) and the same approvals as the
 * mode outside the layer: auto keeps `--approve-for-me`'s reviewer (`approvals_reviewer="auto_review"`,
 * `approval_policy="on-request"`, verified with `codex debug prompt-input` under a fake HOME: `--approve-for-me` itself
 * refuses to be combined with `--sandbox`); accept-edits and normal keep on-request; plan is read-only through the
 * layer (the project is not writable in plan).
 */
export function codexInsideIsolation(profile: LaunchProfile, thirdPartyModel: boolean): string[] {
  const base = ["--sandbox", "danger-full-access", "--ask-for-approval", "on-request"];
  if (profile === "auto" && !thirdPartyModel) return [...base, "-c", 'approvals_reviewer="auto_review"'];
  return base;
}

function resolveResumeArguments(
  provider: Exclude<ProviderId, "terminal">,
  resumeThreadId?: string
): string[] {
  if (provider === "codex") {
    if (resumeThreadId) {
      if (!UUID_REGEX.test(resumeThreadId)) {
        throw new Error(`Invalid Codex thread ID format: "${resumeThreadId}". Expected a canonical UUID.`);
      }
      return ["resume", resumeThreadId.toLowerCase()];
    }
    return ["resume"];
  }
  if (provider === "hermes" && !resumeThreadId) return ["sessions", "browse"];
  const byId = RESUME_BY_ID_ARGUMENTS[provider];
  if (byId && resumeThreadId) {
    const threadId = normalizeThreadId(provider, resumeThreadId);
    if (!threadId) throw new Error(`Invalid ${provider} session ID format: "${resumeThreadId}".`);
    return byId(threadId);
  }
  return RESUME_ARGUMENTS[provider];
}

// Exact provider ids, from hooks or local history. Providers without a verified
// by-id flag continue to use RESUME_ARGUMENTS.
const RESUME_BY_ID_ARGUMENTS: Partial<Record<Exclude<ProviderId, "terminal" | "codex">, (id: string) => string[]>> = {
  claude: (id) => ["--resume", id],
  opencode: (id) => ["--session", id],
  hermes: (id) => ["--resume", id],
  grok: (id) => ["--resume", id],
  qwen: (id) => ["--resume", id],
  kimi: (id) => ["--session", id],
  pi: (id) => ["--session", id],
  omp: (id) => ["--session", id],
  minimax: (id) => ["--session", id],
  cursor: (id) => ["--resume", id]
};

export function canResumeThreadById(provider: ProviderId): boolean {
  return provider === "codex" || (provider !== "terminal" && RESUME_BY_ID_ARGUMENTS[provider] !== undefined);
}

/** Without an id, Codex and Hermes open their own resume pickers, so the person chooses; nothing is guessed. */
export function resumeWithoutIdOpensPicker(provider: ProviderId): boolean {
  return provider === "codex" || provider === "hermes";
}

/** The CLI has a "latest conversation in this folder" flag. */
export function canResumeLatestConversation(provider: ProviderId): boolean {
  return provider !== "terminal" && provider !== "codex" && RESUME_ARGUMENTS[provider].length > 0;
}

// Per-provider instead of a fallthrough: the old `return ["--continue"]` default would
// have handed an unverified flag to whatever provider was added next. A missing entry is
// now a compile error.
const RESUME_ARGUMENTS: Record<Exclude<ProviderId, "terminal" | "codex">, string[]> = {
  claude: ["--continue"],
  qwen: ["--continue"],
  kimi: ["--continue"],
  opencode: ["--continue"],
  hermes: ["--continue"],
  grok: ["--continue"],
  omp: ["--continue"],
  pi: ["--continue"],
  cursor: ["--continue"],
  minimax: ["--continue"],
  devin: ["--continue"],
  // Antigravity resumes only via the interactive /resume command or
  // `--conversation <id>`; there is no latest-session launch flag, so
  // restore starts a fresh session.
  antigravity: []
};

const DANGEROUS_ARGUMENTS: Record<Exclude<ProviderId, "terminal" | "opencode">, string[]> = {
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  claude: ["--dangerously-skip-permissions"],
  qwen: ["--yolo"],
  kimi: ["--yolo"],
  hermes: ["--yolo"],
  grok: ["--always-approve"],
  // Measured on omp 18.1.19: `omp --help` documents `--auto-approve` ("Auto-approve all
  // tool calls"); the undocumented `--yolo` also parses but is not relied on here.
  omp: ["--auto-approve"],
  // pi 0.85.1 has no permission system, so it has no auto-approve flag. `-a, --approve`
  // only skips its one prompt (trust project-local settings for this run).
  pi: ["--approve"],
  // cursor-agent rejects Claude Code's --dangerously-skip-permissions; its own
  // bypass is `-f, --force` ("Force allow commands unless explicitly denied").
  cursor: ["--force"],
  // Measured on @minimax-ai/code 0.5.1: the CLI has no permission bypass flag.
  // Permission modes (default/auto/bypassPermissions/off) are settings.json and
  // TUI state (/permission, Alt+M) only, so YOLO launches the stock CLI.
  minimax: [],
  // Devin CLI documents --permission-mode; `dangerous` (aliases yolo/bypass)
  // auto-approves every tool call. `smart` (an AI gatekeeper that approves only
  // clearly-safe actions) is a supervised mode, deliberately NOT mapped here.
  devin: ["--permission-mode", "dangerous"],
  // Documented on antigravity.google/docs/cli: --dangerously-skip-permissions
  // and --sandbox exist; no --yolo spelling.
  antigravity: ["--dangerously-skip-permissions"]
};

function resolveWindowsShell(
  environment: Readonly<NodeJS.ProcessEnv>,
  fileExists: (path: string) => boolean
): TerminalLaunch {
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  if (systemRoot) {
    const windowsPowerShell = win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    if (fileExists(windowsPowerShell)) {
      return { command: windowsPowerShell, args: ["-NoLogo", "-NoProfile"] };
    }
  }

  const modernPowerShell = findWindowsNativeCommand("pwsh", environment, fileExists);
  if (modernPowerShell) return { command: modernPowerShell, args: ["-NoLogo", "-NoProfile"] };

  return { command: resolveWindowsCommandPrompt(environment, fileExists), args: ["/d"] };
}

function resolveWindowsCommandPrompt(
  environment: Readonly<NodeJS.ProcessEnv>,
  fileExists: (path: string) => boolean
): string {
  // The same lookup as batch provider launches: no PATH search for cmd.exe.
  const commandPrompt = windowsCommandPromptPath(environment, fileExists);
  if (commandPrompt) return commandPrompt;
  throw new Error("No supported Windows shell was found (PowerShell, pwsh, or cmd.exe).");
}

function findWindowsNativeCommand(
  command: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  fileExists: (path: string) => boolean
): string | null {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path");
  if (!pathKey) return null;
  const directories = (environment[pathKey] ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const directory of directories) {
    for (const extension of WINDOWS_NATIVE_EXTENSIONS) {
      const candidate = win32.join(directory, `${command}${extension}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Claude Code 2.1 applies only the last `--settings` it is given (measured with 2.1.281: a hook in an earlier inline
 * JSON never ran). Every inline JSON value, in either form (`--settings <json>` or `--settings=<json>`), is merged
 * into the first one, in order: hook lists are concatenated per event, objects such as `env` are merged key by key
 * (later wins), other keys are replaced. A settings file path is left alone; plugins cannot pass one (a settings file
 * among their launch files is read and checked by the launch pipeline, then passed inline).
 */
export function mergeClaudeInlineSettings(given: readonly string[]): string[] {
  const args = given.flatMap((argument) => argument.startsWith(SETTINGS_EQUALS) && parseInlineSettings(argument.slice(SETTINGS_EQUALS.length))
    ? ["--settings", argument.slice(SETTINGS_EQUALS.length)]
    : [argument]);
  const positions: number[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === "--settings" && parseInlineSettings(args[index + 1]!)) positions.push(index);
  }
  if (positions.length < 2) return args;
  const merged: Record<string, unknown> = {};
  for (const position of positions) {
    for (const [key, value] of Object.entries(parseInlineSettings(args[position + 1]!)!)) {
      const current = merged[key];
      if (key === "hooks" && plainObject(current) && plainObject(value)) {
        const hooks: Record<string, unknown> = { ...current };
        for (const [event, list] of Object.entries(value)) {
          const earlier = hooks[event];
          hooks[event] = Array.isArray(earlier) && Array.isArray(list) ? [...earlier, ...list] : list;
        }
        merged[key] = hooks;
      } else if (plainObject(current) && plainObject(value)) merged[key] = { ...current, ...value };
      else merged[key] = value;
    }
  }
  const drop = new Set(positions.slice(1).flatMap((position) => [position, position + 1]));
  const next = args.filter((_argument, index) => !drop.has(index));
  next[positions[0]! + 1] = JSON.stringify(merged);
  return next;
}

const SETTINGS_EQUALS = "--settings=";

export function parseInlineSettings(value: string): Record<string, unknown> | null {
  if (!value.trimStart().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// What a plugin launch contributor may never append. A trusted plugin already runs as the
// user, so this is not a sandbox: it keeps an ordinary launch from being turned into an
// unattended one behind the profile the person chose, and leaves conversation selection
// to the core's restore rules. Every provider's bypass flag is listed for every provider.
const CORE_OWNED_FLAGS = new Set<string>([
  ...Object.values(DANGEROUS_ARGUMENTS).flat().filter((argument) => argument.startsWith("-")),
  "--full-auto", "--approve-for-me", "--ask-for-approval", "--sandbox", "--permission-mode", "--approval-mode",
  // cursor-agent: --force/-f skip approvals, --approve-mcps approves every MCP server; Grok's --always-approve.
  "--force", "--approve-mcps", "--always-approve", "--auto", "--agent", "--mode", "--plan", "--yolo",
  "--continue", "--resume", "--session", "--last", "--conversation", "--fork-session"
]);
const CORE_OWNED_SHORT_FLAGS: Partial<Record<ProviderId, string[]>> = {
  claude: ["-c", "-r"],
  cursor: ["-c", "-r", "-f"],
  qwen: ["-c", "-r", "-y"],
  opencode: ["-c", "-s"],
  codex: ["-a", "-s"]
};
// Config keys (`-c key=value`, `--config=key=value`, or a `key=value` argument that is a `-c` value) that decide
// approvals or the sandbox. `hooks.…` would replace CanvasTTY's own Codex hooks (and their per-run trust);
// `approvals_reviewer` is auto's. Only the key is read: a value is the plugin's text (a rule that mentions
// these words is not a setting).
const CORE_OWNED_CONFIG_KEY = /dangerously|approval_policy|approvals_reviewer|sandbox_mode|sandbox_workspace_write|bypass|^hooks(?:\.|$)/i;
/** A flag whose own name asks to skip approvals, whatever the agent calls it. */
const CORE_OWNED_FLAG_WORDS = /dangerously|bypass/i;
/** `key=value` as a config override writes it: a dotted key of plain name characters, then `=`. */
const CONFIG_PAIR = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)=/;
const CORE_OWNED_SUBCOMMANDS: Partial<Record<ProviderId, string[]>> = {
  codex: ["resume", "fork", "exec"]
};

/** Claude settings keys that decide approvals, the hooks or the sandbox; a plugin's settings may carry e.g. `env` only. */
// `allowedHttpHookUrls` and `httpHookAllowedEnvVars` would silently switch off CanvasTTY's HTTP lifecycle hooks.
const CLAUDE_CORE_SETTINGS = ["permissions", "hooks", "disableAllHooks", "sandbox", "defaultMode", "apiKeyHelper",
  "allowedHttpHookUrls", "httpHookAllowedEnvVars"];
// Claude 2.1.281 --help: `--bare` and `--safe-mode` skip hooks; `--allowedTools` approves tools without asking;
// `--permission-prompt-tool` / `--permission-prompts` decide who answers permission prompts.
const CLAUDE_CORE_OWNED_FLAGS = new Set(["--bare", "--safe-mode", "--allowedTools", "--allowed-tools", "--permission-prompt-tool", "--permission-prompts"]);

/** The core-owned key a plugin's Claude settings object sets, or null. */
export function claudeCoreSettingsKey(settings: Record<string, unknown>): string | null {
  return CLAUDE_CORE_SETTINGS.find((key) => key in settings) ?? null;
}

export function coreOwnedLaunchArgument(provider: ProviderId, argument: string): boolean {
  const flag = argument.split("=", 1)[0]!;
  if (provider === "claude") {
    if (CLAUDE_CORE_OWNED_FLAGS.has(flag)) return true;
    // `--settings=<value>` in one argument: inline JSON is checked like a separate value; a file cannot be checked here.
    const equals = argument.startsWith(SETTINGS_EQUALS);
    const inline = parseInlineSettings(equals ? argument.slice(SETTINGS_EQUALS.length) : argument);
    if (equals && !inline) return true;
    if (inline && claudeCoreSettingsKey(inline)) return true;
  }
  if (argument.startsWith("-")) {
    if (CORE_OWNED_FLAGS.has(flag) || CORE_OWNED_SHORT_FLAGS[provider]?.includes(flag) || CORE_OWNED_FLAG_WORDS.test(flag)) return true;
    // A config override written into the flag itself: `--config=key=value`, `-ckey=value`.
    const inlineConfig = argument.startsWith("--config=") ? argument.slice("--config=".length)
      : /^-c[^=-]/u.test(argument) ? argument.slice(2) : null;
    return inlineConfig !== null && coreOwnedConfigPair(inlineConfig);
  }
  return Boolean(CORE_OWNED_SUBCOMMANDS[provider]?.includes(argument)) || coreOwnedConfigPair(argument);
}

/** A `key=value` argument whose key is core-owned; any other text (a rule, a prompt) is the plugin's own. */
function coreOwnedConfigPair(argument: string): boolean {
  const key = CONFIG_PAIR.exec(argument)?.[1];
  return key !== undefined && CORE_OWNED_CONFIG_KEY.test(key);
}
