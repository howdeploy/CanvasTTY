import type { RemoteHost } from "../../shared/contracts.ts";

export interface RemoteAgentLaunch {
  command: string;
  args: string[];
  /** Remote agent launches add nothing on top of the PTY environment, so this
   * stays unset; it exists so the launch merges like a TerminalLaunch. */
  environment?: Record<string, string>;
}

// Characters that would break the single-quoted word the remote command composes
// around the workspace: a single quote closes the quoting early, and control
// characters (a newline especially) would splice extra commands into the line.
const UNSAFE_QUOTED_CHARACTERS = /['\u0000-\u001f\u007f]/u;
// The provider CLI name runs unquoted after `exec `, so it must be inert shell
// text: letters, digits, `.`, `_`, `/`, and inner `-` only, and never a leading
// dash (that would read as a flag). Provider definitions only ever hold names
// like `codex` or `mcode`, but this stays defensive instead of trusting them.
const SAFE_UNQUOTED_COMMAND = /^[A-Za-z0-9_/][A-Za-z0-9._/-]*$/u;

// Pure launch composer for remote agent sessions:
//   ssh -tt [-p port] [user@]host "cd '<remoteWorkspace>' && exec <command>"
// -tt forces PTY allocation on the remote side (node-pty provides the local
// half) so the provider TUI stays interactive, unlike the plain -t a one-shot
// command would get. The remote command is ONE argv element: ssh joins its
// command arguments with spaces and hands the result to the remote shell, so
// the cd/exec pair must arrive as a single word to run as one shell line. Both
// inputs come from validated settings and provider definitions, but quoting is
// enforced here anyway — anything that could escape the single-quoted cd
// argument or act as shell syntax in the unquoted exec word throws instead of
// spawning. No fs, no process access: every output is derivable from the
// inputs, which keeps this trivially testable.
export function remoteAgentLaunch(
  host: RemoteHost,
  remoteWorkspace: string,
  command: string,
  options: { args?: string[]; environment?: Record<string, string>; unsetEnvironment?: readonly string[]; absoluteExecutable?: boolean; accountHome?: string } = {}
): RemoteAgentLaunch {
  if (typeof remoteWorkspace !== "string"
    || remoteWorkspace.length === 0
    || UNSAFE_QUOTED_CHARACTERS.test(remoteWorkspace)) {
    throw new Error(`Remote workspace ${JSON.stringify(remoteWorkspace)} cannot be safely quoted for ssh.`);
  }
  if (typeof command !== "string" || (options.absoluteExecutable ? !command.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(command) : !SAFE_UNQUOTED_COMMAND.test(command))) {
    throw new Error(`Remote agent command ${JSON.stringify(command)} is not safe to run unquoted over ssh.`);
  }
  const words = options.args ?? [];
  if (words.some((word) => typeof word !== "string" || word.includes("\0"))) throw new Error("Invalid remote provider argument.");
  const unset = options.unsetEnvironment ?? [];
  const environment = Object.entries(options.environment ?? {});
  if ([...unset, ...environment.map(([name]) => name)].some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) throw new Error("Invalid remote environment variable.");
  const environmentArgs = [...unset.flatMap((name) => ["-u", name]), ...environment.map(([name, value]) => `${name}=${value}`)];
  const invocation = options.absoluteExecutable || words.length || environmentArgs.length
    ? [...(environmentArgs.length ? ["env", ...environmentArgs] : []), command, ...words].map(shellQuote).join(" ") : command;
  const home = options.accountHome;
  if (home !== undefined && (!home.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(home))) throw new Error("Invalid remote account directory.");
  // Verify only directory identity, never read or copy authentication files.
  const homeCheck = home === undefined ? "" : `[ -d ${shellQuote(home)} ] && [ "$(CDPATH= cd ${shellQuote(home)} && pwd -P)" = ${shellQuote(home)} ] || { echo 'CanvasTTY account directory is missing or noncanonical.' >&2; exit 1; }; `;
  return {
    command: "ssh",
    args: [
      "-tt",
      ...(host.sshPort ? ["-p", String(host.sshPort)] : []),
      ...(host.sshUser ? [`${host.sshUser}@${host.sshHost}`] : [host.sshHost]),
      `${homeCheck}cd '${remoteWorkspace}' && exec ${invocation}`
    ]
  };
}

function shellQuote(word: string): string {
  if (word.includes("\0")) throw new Error("Invalid remote argument.");
  return `'${word.replaceAll("'", "'\\''")}'`;
}
