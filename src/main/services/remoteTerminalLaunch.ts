import type { RemoteHost } from "../../shared/contracts.ts";

export interface RemoteTerminalLaunch {
  command: string;
  args: string[];
  /** Remote shell launches add nothing on top of the PTY environment, so this
   * stays unset; it exists so the launch merges like a TerminalLaunch. */
  environment?: Record<string, string>;
}

// Pure launch composer for remote shell sessions: `ssh -tt [user@]host $SHELL`.
// -tt forces PTY allocation on the remote side (node-pty already provides the
// local half), and the trailing shell command mirrors what the local terminal
// branch of resolveTerminalLaunch would run, executed by the remote host.
// hostId values are schema-validated strings (remoteHostInvalidReason rejects
// whitespace), so composing them into argv is safe. No fs, no process access:
// every output is derivable from the inputs, which keeps this trivially testable.
export function remoteTerminalLaunch(
  host: RemoteHost,
  environment: Readonly<NodeJS.ProcessEnv>
): RemoteTerminalLaunch {
  return {
    command: "ssh",
    args: [
      "-tt",
      ...(host.sshPort ? ["-p", String(host.sshPort)] : []),
      ...(host.sshUser ? [`${host.sshUser}@${host.sshHost}`] : [host.sshHost]),
      environment.SHELL || "/bin/bash"
    ]
  };
}
