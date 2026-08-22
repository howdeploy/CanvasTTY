import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { AgentProviderId } from "../../shared/contracts.ts";

export const PROVIDER_CLI_IDS: readonly AgentProviderId[] = Object.freeze([
  "codex",
  "claude",
  "kimi",
  "opencode",
  "hermes",
  "grok"
]);

export type ProviderCliLauncher = "native" | "batch";
export type ProviderCliRejectionReason = "missing" | "not-file" | "not-executable" | "unsupported-launcher";

export interface ProviderCliCheck {
  path: string;
  result: "selected" | ProviderCliRejectionReason;
}

export interface AvailableProviderCli {
  state: "available";
  provider: AgentProviderId;
  executable: string;
  launcher: ProviderCliLauncher;
  commandPrompt?: string;
  environment: Readonly<Record<string, string>>;
  checked: readonly ProviderCliCheck[];
}

export interface UnavailableProviderCli {
  state: "unavailable";
  provider: AgentProviderId;
  reason: "cli-not-found";
  checked: readonly ProviderCliCheck[];
  diagnostic: string;
}

export type ProviderCliResolution = AvailableProviderCli | UnavailableProviderCli;

export interface ProviderCliRegistry {
  get(provider: AgentProviderId): ProviderCliResolution;
  snapshot(): Readonly<Record<AgentProviderId, ProviderCliResolution>>;
}

interface ProviderCliRegistryOptions {
  platform?: NodeJS.Platform;
  environment?: Readonly<NodeJS.ProcessEnv>;
  homeDirectory?: string;
  startupDirectory?: string;
  overrides?: Partial<Record<AgentProviderId, string>>;
  platformRoot?: string;
  inspectCandidate?: (path: string, platform: NodeJS.Platform) => ProviderCliRejectionReason | null;
  directoryExists?: (path: string) => boolean;
}

const WINDOWS_NATIVE_EXTENSIONS = [".exe", ".com"] as const;
const WINDOWS_BATCH_EXTENSIONS = [".cmd", ".bat"] as const;

export function createProviderCliRegistry(options: ProviderCliRegistryOptions = {}): ProviderCliRegistry {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const startupDirectory = options.startupDirectory ?? process.cwd();
  const inspectCandidate = options.inspectCandidate ?? inspectProviderCandidate;
  const directoryExists = options.directoryExists ?? isDirectory;
  const pathKey = environmentPathKey(environment);
  const inputDirectories = pathEntries(environment[pathKey], platform, startupDirectory);
  const platformDirectories = defaultPlatformDirectories(platform, options.platformRoot);
  const sharedDirectories = sharedUserDirectories(platform, environment, homeDirectory);
  const childDirectories = uniquePaths(
    [...inputDirectories, ...platformDirectories, ...sharedDirectories].filter(directoryExists),
    platform
  );
  const childPath = childDirectories.join(platform === "win32" ? ";" : ":");
  const resolutions = Object.fromEntries(PROVIDER_CLI_IDS.map((provider) => {
    const providerDirectories = uniquePaths([
      ...inputDirectories,
      ...platformDirectories,
      ...knownProviderDirectories(provider, platform, environment, homeDirectory),
      ...sharedDirectories
    ], platform);
    return [provider, resolveProviderCli({
      provider,
      platform,
      environment,
      override: normalizeOverride(options.overrides?.[provider], platform, startupDirectory),
      directories: providerDirectories,
      pathKey,
      childPath,
      inspectCandidate
    })];
  })) as Record<AgentProviderId, ProviderCliResolution>;

  for (const provider of PROVIDER_CLI_IDS) Object.freeze(resolutions[provider]);
  Object.freeze(resolutions);
  return Object.freeze({
    get(provider: AgentProviderId): ProviderCliResolution {
      return resolutions[provider];
    },
    snapshot(): Readonly<Record<AgentProviderId, ProviderCliResolution>> {
      return resolutions;
    }
  });
}

interface ResolveProviderCliInput {
  provider: AgentProviderId;
  platform: NodeJS.Platform;
  environment: Readonly<NodeJS.ProcessEnv>;
  override?: string;
  directories: string[];
  pathKey: string;
  childPath: string;
  inspectCandidate: (path: string, platform: NodeJS.Platform) => ProviderCliRejectionReason | null;
}

function resolveProviderCli(input: ResolveProviderCliInput): ProviderCliResolution {
  const candidates = input.override
    ? [input.override, ...providerCandidates(input.provider, input.directories, input.platform)]
    : providerCandidates(input.provider, input.directories, input.platform);
  const checked: ProviderCliCheck[] = [];

  for (const candidate of uniquePaths(candidates, input.platform)) {
    const absoluteCandidate = candidate;
    const rejection = input.inspectCandidate(absoluteCandidate, input.platform);
    if (rejection) {
      checked.push({ path: absoluteCandidate, result: rejection });
      continue;
    }
    const launcher = launcherKind(absoluteCandidate, input.platform);
    if (!launcher) {
      checked.push({ path: absoluteCandidate, result: "unsupported-launcher" });
      continue;
    }
    const commandPrompt = launcher === "batch"
      ? resolveWindowsCommandPrompt(input.environment, input.inspectCandidate)
      : undefined;
    if (launcher === "batch" && !commandPrompt) {
      checked.push({ path: absoluteCandidate, result: "unsupported-launcher" });
      continue;
    }
    checked.push({ path: absoluteCandidate, result: "selected" });
    const environmentPath = childPathWithExecutable(input.childPath, absoluteCandidate, input.platform);
    return Object.freeze({
      state: "available",
      provider: input.provider,
      executable: absoluteCandidate,
      launcher,
      ...(commandPrompt ? { commandPrompt } : {}),
      environment: Object.freeze({ [input.pathKey]: environmentPath }),
      checked: freezeChecks(checked)
    });
  }

  const unavailable: UnavailableProviderCli = {
    state: "unavailable",
    provider: input.provider,
    reason: "cli-not-found",
    checked: freezeChecks(checked),
    diagnostic: providerCliDiagnostic(input.provider, checked)
  };
  return Object.freeze(unavailable);
}

export function providerCliDiagnostic(provider: AgentProviderId, checked: readonly ProviderCliCheck[]): string {
  const paths = checked.length === 0
    ? "  (no candidate paths were available)"
    : checked.map((candidate) => `  - ${candidate.path}: ${candidate.result}`).join("\n");
  return [
    `${providerLabel(provider)} CLI was not found.`,
    "CanvasTTY resolves provider CLIs once at startup; install the CLI and restart CanvasTTY.",
    "Checked paths:",
    paths
  ].join("\n");
}

export interface ProviderChildProcessLaunch {
  command: string;
  args: string[];
  environment: Readonly<Record<string, string>>;
  windowsVerbatimArguments?: boolean;
}

export function providerChildProcessLaunch(
  resolution: AvailableProviderCli,
  args: string[]
): ProviderChildProcessLaunch {
  if (resolution.launcher === "native") {
    return { command: resolution.executable, args, environment: resolution.environment };
  }
  if (!resolution.commandPrompt) throw new Error("A Windows batch provider requires cmd.exe.");
  return {
    command: resolution.commandPrompt,
    args: ["/d", "/s", "/c", windowsBatchShellCommand(resolution.executable, args)],
    environment: resolution.environment,
    windowsVerbatimArguments: true
  };
}

export function providerTerminalBatchCommandLine(executable: string, args: string[]): string {
  return `/d /s /c ${windowsBatchShellCommand(executable, args)}`;
}

function windowsBatchShellCommand(executable: string, args: string[]): string {
  const shellCommand = [escapeCommandPromptCommand(executable), ...args.map(escapeCommandPromptArgument)].join(" ");
  return `"${shellCommand}"`;
}

const COMMAND_PROMPT_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommandPromptCommand(value: string): string {
  return value.replace(COMMAND_PROMPT_META_CHARACTERS, "^$1");
}

function escapeCommandPromptArgument(value: string): string {
  let escaped = value.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  return `"${escaped}"`.replace(COMMAND_PROMPT_META_CHARACTERS, "^$1");
}

function providerCandidates(provider: AgentProviderId, directories: string[], platform: NodeJS.Platform): string[] {
  const path = platform === "win32" ? win32 : posix;
  const extensions = platform === "win32"
    ? [...WINDOWS_NATIVE_EXTENSIONS, ...WINDOWS_BATCH_EXTENSIONS]
    : [""];
  return directories.flatMap((directory) => extensions.map((extension) => path.join(directory, `${provider}${extension}`)));
}

function launcherKind(path: string, platform: NodeJS.Platform): ProviderCliLauncher | null {
  if (platform !== "win32") return "native";
  const extension = win32.extname(path).toLowerCase();
  if (WINDOWS_NATIVE_EXTENSIONS.includes(extension as (typeof WINDOWS_NATIVE_EXTENSIONS)[number])) return "native";
  if (WINDOWS_BATCH_EXTENSIONS.includes(extension as (typeof WINDOWS_BATCH_EXTENSIONS)[number])) return "batch";
  return null;
}

function inspectProviderCandidate(path: string, platform: NodeJS.Platform): ProviderCliRejectionReason | null {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return "missing";
  }
  if (!stats.isFile()) return "not-file";
  if (platform !== "win32") {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      return "not-executable";
    }
  }
  return null;
}

function defaultPlatformDirectories(platform: NodeJS.Platform, platformRoot = "/"): string[] {
  if (platform === "darwin") {
    return [posix.join(platformRoot, "opt", "homebrew", "bin"), posix.join(platformRoot, "usr", "local", "bin")];
  }
  if (platform === "win32") return [];
  return [posix.join(platformRoot, "usr", "local", "bin"), posix.join(platformRoot, "usr", "bin"), posix.join(platformRoot, "bin")];
}

function knownProviderDirectories(
  provider: AgentProviderId,
  platform: NodeJS.Platform,
  environment: Readonly<NodeJS.ProcessEnv>,
  homeDirectory: string
): string[] {
  const path = platform === "win32" ? win32 : posix;
  const directories: string[] = [];
  if (platform === "win32" && provider === "codex") {
    const localAppData = environment.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local");
    directories.push(path.join(localAppData, "Programs", "OpenAI", "Codex", "bin"));
  }
  if (provider === "kimi") directories.push(path.join(homeDirectory, ".kimi-code", "bin"));
  if (provider === "grok") directories.push(path.join(homeDirectory, ".grok", "bin"));
  return directories;
}

function sharedUserDirectories(
  platform: NodeJS.Platform,
  environment: Readonly<NodeJS.ProcessEnv>,
  homeDirectory: string
): string[] {
  const path = platform === "win32" ? win32 : posix;
  const directories = [
    path.join(homeDirectory, ".local", "bin"),
    path.join(homeDirectory, ".npm-global", "bin"),
    path.join(homeDirectory, ".bun", "bin"),
    path.join(homeDirectory, ".cargo", "bin")
  ];
  if (platform === "win32") {
    const appData = environment.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming");
    directories.push(path.join(appData, "npm"));
  }
  return directories;
}

function resolveWindowsCommandPrompt(
  environment: Readonly<NodeJS.ProcessEnv>,
  inspectCandidate: ResolveProviderCliInput["inspectCandidate"]
): string | null {
  const configured = environment.ComSpec || environment.COMSPEC;
  if (configured && inspectCandidate(configured, "win32") === null) return configured;
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  if (!systemRoot) return null;
  const candidate = win32.join(systemRoot, "System32", "cmd.exe");
  return inspectCandidate(candidate, "win32") === null ? candidate : null;
}

function pathEntries(value: string | undefined, platform: NodeJS.Platform, startupDirectory: string): string[] {
  if (!value) return [];
  const path = platform === "win32" ? win32 : posix;
  return value.split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((entry) => path.isAbsolute(entry) ? path.normalize(entry) : path.resolve(startupDirectory, entry));
}

function normalizeOverride(
  override: string | undefined,
  platform: NodeJS.Platform,
  startupDirectory: string
): string | undefined {
  if (!override) return undefined;
  const path = platform === "win32" ? win32 : posix;
  return path.isAbsolute(override) ? path.normalize(override) : path.resolve(startupDirectory, override);
}

function childPathWithExecutable(childPath: string, executable: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? win32 : posix;
  const entries = childPath ? childPath.split(platform === "win32" ? ";" : ":") : [];
  return uniquePaths([...entries, path.dirname(executable)], platform).join(platform === "win32" ? ";" : ":");
}

function freezeChecks(checks: ProviderCliCheck[]): readonly ProviderCliCheck[] {
  checks.forEach(Object.freeze);
  return Object.freeze(checks);
}

function uniquePaths(paths: string[], platform: NodeJS.Platform): string[] {
  const path = platform === "win32" ? win32 : posix;
  const seen = new Set<string>();
  return paths.filter((entry) => {
    const normalized = platform === "win32" ? path.normalize(entry).toLowerCase() : path.normalize(entry);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function environmentPathKey(environment: Readonly<NodeJS.ProcessEnv>): string {
  return Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function providerLabel(provider: AgentProviderId): string {
  if (provider === "opencode") return "OpenCode";
  return `${provider[0].toUpperCase()}${provider.slice(1)}`;
}
