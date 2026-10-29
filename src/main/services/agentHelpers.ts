import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Which program runs the helpers CanvasTTY starts inside agent processes: the MCP servers (canvastty_browser,
 * canvastty_agents), the decision hook and the lifecycle hook. The native `canvastty-helper` (native/canvastty-helper,
 * Go) speaks the same wire protocols as the .mjs helpers at a fraction of their memory and start-up cost: an
 * Electron-as-Node helper holds ~60 MB for an agent's whole life and costs ~160 ms per tool call.
 *
 * CANVASTTY_HELPERS=node forces the JavaScript helpers; =native uses the binary wherever it is present. By default
 * the binary is used on macOS and Linux when it was built for this platform and architecture; Windows keeps the
 * JavaScript helpers until the native named-pipe transport has run on a Windows machine.
 */
export const AGENT_HELPERS_ENV = "CANVASTTY_HELPERS";
/** The executable's base name; hook commands containing it (or a .mjs helper name) are CanvasTTY's own. */
export const NATIVE_HELPER_NAME = "canvastty-helper";

export interface HelperLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentHelperLaunches {
  native: boolean;
  browser: HelperLaunch;
  orchestration: HelperLaunch;
  hook: HelperLaunch;
  permissionGate: HelperLaunch;
  shellCodex: HelperLaunch;
}

export interface AgentHelperLocation {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  execPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Test seam: whether an executable file is at this path. */
  isExecutable?: (path: string) => boolean;
}

const OS_FOLDER: Partial<Record<NodeJS.Platform, string>> = { darwin: "mac", linux: "linux", win32: "win" };

/** Paths are joined by the rules of the platform the location describes (the host's own in the app). */
const pathRules = (platform: NodeJS.Platform): typeof posix => platform === "win32" ? win32 : posix;

/** Where the native helper is for this app, or null when it is not there or not chosen. */
export function nativeHelperPath(location: AgentHelperLocation): string | null {
  const platform = location.platform ?? process.platform;
  const arch = location.arch ?? process.arch;
  const choice = (location.environment ?? process.env)[AGENT_HELPERS_ENV];
  if (choice === "node") return null;
  if (choice !== "native" && platform !== "darwin" && platform !== "linux") return null;
  const os = OS_FOLDER[platform];
  if (!os) return null;
  const file = platform === "win32" ? `${NATIVE_HELPER_NAME}.exe` : NATIVE_HELPER_NAME;
  const { join } = pathRules(platform);
  const path = location.packaged
    ? join(location.resourcesPath, "helpers", file)
    : join(location.appPath, "build", "native-helpers", `${os}-${arch}`, file);
  return (location.isExecutable ?? isExecutableFile)(path) ? path : null;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The launch of each helper: the native binary's subcommands, or Electron running the .mjs helper as Node. */
export function agentHelperLaunches(location: AgentHelperLocation): AgentHelperLaunches {
  const { join } = pathRules(location.platform ?? process.platform);
  const script = (folder: string, name: string) => location.packaged
    ? join(location.resourcesPath, folder, name)
    : join(location.appPath, "src", folder, name);
  const node = (folder: string, name: string): HelperLaunch => ({
    command: location.execPath,
    args: [script(folder, name)],
    env: { ELECTRON_RUN_AS_NODE: "1" }
  });
  const shellCodex = node("agent-runtime", "shell-codex.mjs");
  const native = nativeHelperPath(location);
  if (native) {
    return {
      native: true,
      browser: { command: native, args: ["mcp-browser"] },
      orchestration: { command: native, args: ["mcp-orchestration"] },
      hook: { command: native, args: ["hook"] },
      permissionGate: { command: native, args: ["permission-gate"] },
      shellCodex
    };
  }
  return {
    native: false,
    browser: node("agent-browser", "mcp-helper.mjs"),
    orchestration: node("agent-browser", "orchestration-helper.mjs"),
    hook: node("agent-runtime", "hook-helper.mjs"),
    permissionGate: node("agent-runtime", "permission-gate.mjs"),
    shellCodex
  };
}

/** Whether a provider's hook command (or a file of them) runs CanvasTTY's own lifecycle hook helper. */
export function isOwnLifecycleHookText(text: string): boolean {
  return text.includes("hook-helper.mjs") || /canvastty-helper(?:\.exe)?["'\\ ]{1,8}hook["'\\]/u.test(text);
}
