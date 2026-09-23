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
  command: string
): RemoteAgentLaunch {
  if (typeof remoteWorkspace !== "string"
    || remoteWorkspace.length === 0
    || UNSAFE_QUOTED_CHARACTERS.test(remoteWorkspace)) {
    throw new Error(`Remote workspace ${JSON.stringify(remoteWorkspace)} cannot be safely quoted for ssh.`);
  }
  if (typeof command !== "string" || !SAFE_UNQUOTED_COMMAND.test(command)) {
    throw new Error(`Remote agent command ${JSON.stringify(command)} is not safe to run unquoted over ssh.`);
  }
  return {
    command: "ssh",
    args: [
      "-tt",
      ...(host.sshPort ? ["-p", String(host.sshPort)] : []),
      ...(host.sshUser ? [`${host.sshUser}@${host.sshHost}`] : [host.sshHost]),
      `cd '${remoteWorkspace}' && exec ${command}`
    ]
  };
}
