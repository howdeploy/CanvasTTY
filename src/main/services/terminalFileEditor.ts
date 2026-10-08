import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { parseTerminalFileLink } from "../../shared/terminalFileLink.ts";

const run = promisify(execFile);

interface VSCodeLauncher {
  command: string;
  prefix: string[];
  runAsNode: boolean;
}

export function vscodeLaunchCandidates(
  platform: NodeJS.Platform,
  environment: Readonly<NodeJS.ProcessEnv>,
  homeDirectory: string
): VSCodeLauncher[] {
  const paths = platform === "win32" ? win32 : posix;
  const env = (name: string): string | undefined => platform === "win32"
    ? Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    : environment[name];
  const pathFolders = (env("PATH") ?? "").split(paths.delimiter).filter((folder) => paths.isAbsolute(folder));
  if (platform === "win32") {
    const roots = [
      ...(env("LOCALAPPDATA") ? [win32.join(env("LOCALAPPDATA")!, "Programs", "Microsoft VS Code")] : []),
      ...["ProgramFiles", "ProgramFiles(x86)"].flatMap((key) =>
        env(key) ? [win32.join(env(key)!, "Microsoft VS Code")] : []),
      ...pathFolders.flatMap((folder) => [win32.dirname(folder), folder])
    ];
    return [...new Set(roots)].map((root) => ({
      command: win32.join(root, "Code.exe"),
      prefix: [win32.join(root, "resources", "app", "out", "cli.js")],
      runAsNode: true
    }));
  }
  const commands = [
    ...(platform === "darwin" ? [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      posix.join(homeDirectory, "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
    ] : []),
    ...pathFolders.map((folder) => posix.join(folder, "code"))
  ];
  return [...new Set(commands)].map((command) => ({ command, prefix: [], runAsNode: false }));
}

export async function terminalFileEditorArguments(reference: unknown, cwd: string): Promise<string[]> {
  const location = parseTerminalFileLink(reference);
  if (!location) throw new Error("Invalid file link.");
  const expanded = location.path.startsWith("~/") ? resolve(homedir(), location.path.slice(2)) : location.path;
  const path = await realpath(resolve(cwd, expanded));
  if (!(await stat(path)).isFile()) throw new Error("The link must point to an existing file.");
  return ["--reuse-window", "--goto", `${path}:${location.line}:${location.column}`];
}

export async function openTerminalFile(reference: unknown, cwd: string): Promise<void> {
  const args = await terminalFileEditorArguments(reference, cwd);
  const candidates = vscodeLaunchCandidates(process.platform, process.env, homedir());
  let launcher: VSCodeLauncher | undefined;
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate.command)).isFile()) continue;
      await access(candidate.command, constants.X_OK);
      if (candidate.prefix.length > 0) {
        if (!(await stat(candidate.prefix[0])).isFile()) continue;
        await access(candidate.prefix[0], constants.R_OK);
      }
      launcher = candidate;
      break;
    } catch {
      continue;
    }
  }
  if (!launcher) throw new Error("VS Code was not found. Install VS Code or add its code command to PATH.");
  const env = { ...process.env };
  delete env.VSCODE_IPC_HOOK_CLI;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_DEV;
  if (launcher.runAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  await run(launcher.command, [...launcher.prefix, ...args], {
    env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true
  });
}
