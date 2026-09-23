import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { ProviderId } from "../../shared/contracts.ts";
import { openCodeYoloEnvironment } from "./openCodeConfig.ts";
import {
  providerTerminalBatchCommandLine,
  type ProviderCliResolution
} from "./providerCliRegistry.ts";

export interface TerminalLaunch {
  command: string;
  args: string[] | string;
  environment?: Record<string, string>;
}

interface LaunchResolutionOptions {
  platform?: NodeJS.Platform;
  environment?: Readonly<NodeJS.ProcessEnv>;
  fileExists?: (path: string) => boolean;
  providerCli?: ProviderCliResolution;
  resumePrevious?: boolean;
}

const WINDOWS_NATIVE_EXTENSIONS = [".exe", ".com"];

export function resolveTerminalLaunch(
  provider: ProviderId,
  profile: "normal" | "yolo",
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

  const launchEnvironment = profile === "yolo" && provider === "opencode"
    ? openCodeYoloEnvironment({ ...environment, ...providerCli.environment })
    : undefined;
  const providerArgs = [
    ...(profile === "yolo" && provider !== "opencode" ? DANGEROUS_ARGUMENTS[provider] : []),
    ...agentBrowserArgs,
    ...(options.resumePrevious ? RESUME_ARGUMENTS[provider] : [])
  ];
  const combinedEnvironment = {
    ...providerCli.environment,
    ...launchEnvironment
  };
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

// Per-provider instead of a fallthrough: the old `return ["--continue"]` default would
// have handed an unverified flag to whatever provider was added next. A missing entry is
// now a compile error.
const RESUME_ARGUMENTS: Record<Exclude<ProviderId, "terminal">, string[]> = {
  codex: ["resume", "--last"],
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
  // The Cursor CLI follows Claude Code conventions; its permission bypass is the
  // same flag Claude Code documents.
  cursor: ["--dangerously-skip-permissions"],
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
  const configured = environment.ComSpec || environment.COMSPEC;
  if (configured && fileExists(configured)) return configured;
  const fromPath = findWindowsNativeCommand("cmd", environment, fileExists);
  if (fromPath) return fromPath;
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  const systemCommandPrompt = systemRoot ? win32.join(systemRoot, "System32", "cmd.exe") : null;
  if (systemCommandPrompt && fileExists(systemCommandPrompt)) return systemCommandPrompt;
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
