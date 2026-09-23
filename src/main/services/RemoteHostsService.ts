import { remoteProbeLimiter } from "./RemoteProbeCache.ts";
import { execFile } from "node:child_process";
import { remoteHostInvalidReason } from "../../shared/contracts.ts";
import type { RemoteHost } from "../../shared/contracts";

/** Outcome of one remote host connectivity probe. */
export interface RemoteHostStatus {
  hostId: string;
  reachable: boolean;
  detail: string;
}

/** Outcome of one runner invocation: ssh's exit status plus captured output. */
export interface RemoteRunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Transport the probe runs over; injectable so tests never touch the network. */
export type RemoteHostRunner = (
  host: RemoteHost,
  command: string[],
  timeoutMs: number
) => Promise<RemoteRunnerResult>;

const PROBE_COMMAND: readonly string[] = ["echo", "canvastty-probe"];
const PROBE_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const DETAIL_MAX_LENGTH = 300;

// The ssh argument list every remote command shares. BatchMode keeps the
// invocation non-interactive, ConnectTimeout bounds the handshake, and
// accept-new avoids blocking on an unseen host key without silently trusting
// a changed one. Exported so probe composers and their tests agree on the
// exact shape. No `-tt` anywhere: no probe needs a tty, and allocating one
// would echo the script and mangle stdout with CRLF.
export function buildSshArguments(
  host: RemoteHost,
  timeoutMs: number,
  command: readonly string[]
): string[] {
  const destination = host.sshUser ? `${host.sshUser}@${host.sshHost}` : host.sshHost;
  const args = [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    "-o", "StrictHostKeyChecking=accept-new"
  ];
  if (host.sshPort !== undefined) args.push("-p", String(host.sshPort));
  args.push(destination, ...command);
  return args;
}

// Runs the probe over the system ssh binary.
export function sshRunner(
  host: RemoteHost,
  command: string[],
  timeoutMs: number
): Promise<RemoteRunnerResult> {
  const args = buildSshArguments(host, timeoutMs, command);
  return remoteProbeLimiter.run(() => new Promise((resolve) => {
    execFile("ssh", args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      const code = error
        ? typeof error.code === "number" ? error.code : null
        : 0;
      resolve({
        code,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : ""
      });
    });
  }));
}

// Inert by design: constructing the service spawns nothing. Only
// checkConnectivity executes ssh, one probe per call.
export class RemoteHostsService {
  private readonly run: RemoteHostRunner;

  constructor(runner: RemoteHostRunner = sshRunner) {
    this.run = runner;
  }

  async checkConnectivity(host: RemoteHost): Promise<RemoteHostStatus> {
    const hostId = host && typeof host === "object" && typeof (host as { id?: unknown }).id === "string"
      ? (host as { id: string }).id
      : "unknown";
    const invalidReason = remoteHostInvalidReason(host);
    if (invalidReason !== null) {
      return { hostId, reachable: false, detail: invalidReason };
    }
    try {
      const { code, stderr } = await this.run(host, [...PROBE_COMMAND], PROBE_TIMEOUT_MS);
      if (code === 0) {
        return { hostId, reachable: true, detail: excerpt(stderr) || "ok" };
      }
      const reason = excerpt(stderr);
      return {
        hostId,
        reachable: false,
        detail: reason || `ssh exited with code ${code === null ? "unknown" : code}`
      };
    } catch (error) {
      return { hostId, reachable: false, detail: excerpt(error instanceof Error ? error.message : String(error)) };
    }
  }
}

function excerpt(value: string): string {
  return value.trim().slice(0, DETAIL_MAX_LENGTH);
}
