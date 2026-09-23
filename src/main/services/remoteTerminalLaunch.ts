import type { RemoteHost } from "../../shared/contracts.ts";

export interface RemoteTerminalLaunch {
  command: string;
  args: string[];
  /** Remote shell launches add nothing on top of the PTY environment, so this
   * stays unset; it exists so the launch merges like a TerminalLaunch. */
  environment?: Record<string, string>;
}

// Pure launch composer for remote shell sessions: `ssh -tt [-p port] [user@]host`.
// -tt forces PTY allocation on the remote side (node-pty already provides the
// local half). The remote account's own login shell runs: the local $SHELL may
// not exist on the server (for example /bin/zsh from macOS on a Linux host).
// When the project folder is mapped on that host, the shell starts inside it.
// hostId values are schema-validated strings (remoteHostInvalidReason rejects
// whitespace), so composing them into argv is safe. No fs, no process access:
// every output is derivable from the inputs, which keeps this trivially testable.
export function remoteTerminalLaunch(host: RemoteHost, remoteDirectory?: string | null): RemoteTerminalLaunch {
  const args = [
    "-tt",
    ...(host.sshPort ? ["-p", String(host.sshPort)] : []),
    host.sshUser ? `${host.sshUser}@${host.sshHost}` : host.sshHost
  ];
  if (remoteDirectory) {
    if (/[\u0000-\u001f\u007f]/u.test(remoteDirectory)) throw new Error("Remote workspace cannot be safely quoted for ssh.");
    args.push(`cd ${shellQuote(remoteDirectory)} && exec "\${SHELL:-/bin/sh}" -l`);
  }
  return { command: "ssh", args };
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}
