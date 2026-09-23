import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RemoteHost } from "../../shared/contracts.ts";

/** RAM-backed on Linux; a secret written here never reaches the server's disk. */
const HANDOFF_DIRECTORY = "/dev/shm";
/** An unused handoff file is removed even if the launch never starts. */
const HANDOFF_TTL_SECONDS = 120;
const NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const MAX_VALUE_BYTES = 16_384;

export interface RemoteSecretFile { path: string; names: string[] }

export type SecretDeliveryRunner = (host: RemoteHost, script: string, input: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export function newRemoteSecretFile(names: readonly string[]): RemoteSecretFile {
  if (!names.length || names.some(name => !NAME.test(name))) throw new Error("Invalid forwarded credential name.");
  return { path: `${HANDOFF_DIRECTORY}/canvastty-${randomUUID()}`, names: [...names] };
}

/** One line per variable: NAME:base64(value). ':' never occurs in base64, so values survive shell reads intact. */
function payload(file: RemoteSecretFile, secrets: Readonly<Record<string, string>>): string {
  return file.names.map(name => {
    const value = secrets[name];
    if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error("Invalid forwarded credential value.");
    return `${name}:${Buffer.from(value, "utf8").toString("base64")}\n`;
  }).join("");
}

/** Secrets travel on the SSH channel's stdin, never in argv, and land in a 0600 file only the SSH user can read. */
export async function deliverRemoteSecrets(host: RemoteHost, file: RemoteSecretFile, secrets: Readonly<Record<string, string>>, run: SecretDeliveryRunner = sshWithInput, timeoutMs = 20_000): Promise<void> {
  const script = `umask 077; [ -d ${HANDOFF_DIRECTORY} ] && [ -w ${HANDOFF_DIRECTORY} ] || { echo CTTY_NO_SHM; exit 4; }; cat > ${file.path} && { nohup sh -c "sleep ${HANDOFF_TTL_SECONDS}; rm -f ${file.path}" >/dev/null 2>&1 </dev/null & } && echo CTTY_OK`;
  const result = await run(host, script, payload(file, secrets), timeoutMs);
  if (result.stdout.includes("CTTY_NO_SHM")) throw new Error("The server has no writable /dev/shm for credential forwarding.");
  if (result.code !== 0 || !result.stdout.includes("CTTY_OK")) throw new Error("The launch credential could not be forwarded to the server.");
}

/** Shell prefix for the remote PTY command: load the variables, delete the file, then continue. */
export function consumeRemoteSecretsPrefix(file: RemoteSecretFile): string {
  if (!/^\/dev\/shm\/canvastty-[0-9a-f-]{36}$/u.test(file.path)) throw new Error("Invalid credential handoff path.");
  return `f=${file.path}; [ -f "$f" ] || { echo "CanvasTTY could not receive the launch credential." >&2; exit 1; }; `
    + `while IFS=: read -r n v; do export "$n=$(printf %s "$v" | base64 -d)"; done < "$f"; rm -f "$f"; `;
}

function sshWithInput(host: RemoteHost, script: string, input: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const destination = host.sshUser ? `${host.sshUser}@${host.sshHost}` : host.sshHost;
  const args = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`, "-o", "StrictHostKeyChecking=accept-new",
    ...(host.sshPort !== undefined ? ["-p", String(host.sshPort)] : []), destination, `sh -c '${script}'`];
  return new Promise(resolve => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", chunk => { if (stdout.length < 4096) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { if (stderr.length < 4096) stderr += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout, stderr }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
