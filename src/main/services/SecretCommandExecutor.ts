import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AgentIsolation, WrappedLaunch } from "./isolation/AgentIsolation.ts";
import type { SecretApiExecutionRequest, SecretApiExecutionResult } from "./SecretGrantService.ts";
import { SECRET_API_REQUEST_WORKER_SOURCE } from "./SecretApiRequestWorker.mjs";

const MAX_WORKER_OUTPUT_BYTES = 256 * 1_024;
const MAX_RESPONSE_BYTES = 32 * 1_024;
const SUPPORTED_SECRET_IDS = new Set([
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GOOGLE_API_KEY",
  "ZAI_API_KEY", "MINIMAX_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"
]);

/** Secrets enter only the fixed, host-bundled API worker, never a model-selected executable. */
export function secretApiRequestExecutor(isolation: AgentIsolation) {
  return async (request: SecretApiExecutionRequest): Promise<SecretApiExecutionResult> => {
    if (!SUPPORTED_SECRET_IDS.has(request.secretId)) throw new Error(`Provider API requests are not supported for ${request.secretId}.`);
    if (!isolation.containment()) throw new Error("Provider API requests require enabled operating-system isolation.");
    if (request.signal.aborted) throw new Error("Provider API request was canceled.");

    const environment: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "SystemRoot", "WINDIR"]) {
      const value = process.env[key];
      if (value) environment[key] = value;
    }
    environment.ELECTRON_RUN_AS_NODE = "1";

    let launch: WrappedLaunch | null = null;
    try {
      launch = isolation.wrap({
        sessionId: `secret-api-${randomUUID()}`,
        provider: request.provider,
        profile: request.launchProfile,
        cwd: request.cwd,
        networkProjectRoot: request.networkProjectRoot,
        command: process.execPath,
        // Node's fetch ignores HTTP(S)_PROXY unless enabled explicitly. The OS isolation wrapper
        // owns proxy variables in strict network modes, so force the bundled runtime to honor them.
        args: ["--use-env-proxy", "-e", SECRET_API_REQUEST_WORKER_SOURCE],
        env: environment
      });
      const wrapped = launch;
      const payload = JSON.stringify({
        secretId: request.secretId,
        secret: request.secret,
        profile: request.apiProfile,
        method: request.method,
        path: request.path,
        ...(request.body ? { body: request.body } : {})
      });
      return await new Promise<SecretApiExecutionResult>((resolve, reject) => {
        const spawnedChild = spawn(wrapped.command, wrapped.args, {
          cwd: request.cwd,
          env: wrapped.env,
          stdio: ["pipe", "pipe", "ignore"],
          detached: process.platform !== "win32"
        });
        let output = "";
        const decoder = new StringDecoder("utf8");
        let outputBytes = 0;
        let failure: Error | null = null;
        let settled = false;
        const finishError = (error: Error): void => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const terminate = (message: string): void => {
          failure ??= new Error(message);
          try {
            if (spawnedChild.pid && process.platform !== "win32") process.kill(-spawnedChild.pid, "SIGKILL");
            else spawnedChild.kill("SIGKILL");
          } catch { /* already exited */ }
        };
        const abort = (): void => terminate("Provider API request was canceled or timed out.");
        const timeout = setTimeout(() => terminate("Provider API request timed out."), request.timeoutMs);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
        spawnedChild.stdout.on("data", (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > MAX_WORKER_OUTPUT_BYTES) return terminate("Provider API response exceeded its limit.");
          output += decoder.write(chunk);
        });
        spawnedChild.stdin.on("error", (error) => { failure ??= error; });
        spawnedChild.once("error", (error) => { failure = error; });
        spawnedChild.once("close", (exitCode) => {
          clearTimeout(timeout);
          request.signal.removeEventListener("abort", abort);
          if (failure) return finishError(failure);
          if (exitCode !== 0) return finishError(new Error("Provider API request failed."));
          output += decoder.end();
          try {
            const envelope = JSON.parse(output) as { ok?: unknown; result?: unknown };
            if (envelope.ok !== true || !envelope.result || typeof envelope.result !== "object") {
              throw new Error("invalid worker result");
            }
            const result = envelope.result as Partial<SecretApiExecutionResult>;
            if (!Number.isInteger(result.status) || (result.status as number) < 100 || (result.status as number) > 599
              || typeof result.body !== "string" || typeof result.truncated !== "boolean"
              || Buffer.byteLength(result.body, "utf8") > MAX_RESPONSE_BYTES) {
              throw new Error("invalid worker result");
            }
            settled = true;
            resolve({ status: result.status as number, body: result.body, truncated: result.truncated });
          } catch {
            finishError(new Error("Provider API request failed."));
          }
        });
        spawnedChild.stdin.end(payload);
      });
    } finally {
      try { launch?.cleanup(); }
      finally {
        for (const key of Object.keys(environment)) delete environment[key];
        if (launch) for (const key of Object.keys(launch.env)) delete launch.env[key];
      }
    }
  };
}
