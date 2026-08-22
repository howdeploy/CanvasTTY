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
    ...(profile === "yolo" && provider !== "opencode" ? dangerousArguments(provider) : []),
    ...agentBrowserArgs
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

function dangerousArguments(provider: Exclude<ProviderId, "terminal" | "opencode">): string[] {
  if (provider === "codex") return ["--dangerously-bypass-approvals-and-sandbox"];
  if (provider === "claude") return ["--dangerously-skip-permissions"];
  if (provider === "grok") return ["--always-approve"];
  return ["--yolo"];
}

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
