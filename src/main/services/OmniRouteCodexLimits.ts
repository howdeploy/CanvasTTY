import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { LimitUnavailableReason, LimitWindow } from "../../shared/contracts";
import { providerChildProcessLaunch } from "./providerCliRegistry.ts";

type Environment = Readonly<Record<string, string | undefined>>;
interface Target { executable: string; baseUrl: string; connectionId: string }
type Run = (target: Target, args: string[]) => Promise<unknown>;

export class OmniRouteQuotaError extends Error {
  readonly reason: LimitUnavailableReason;
  constructor(reason: LimitUnavailableReason) { super(reason); this.reason = reason; }
}

/** Explicit opt-in: the inference profile alone does not identify an upstream account. */
export async function readOmniRouteCodexLimits(environment: Environment, run: Run = runJson): Promise<LimitWindow[] | null> {
  const executable = environment.CANVASTTY_OMNIROUTE_BIN;
  const baseUrl = environment.CANVASTTY_OMNIROUTE_URL;
  const connectionId = environment.CANVASTTY_OMNIROUTE_CODEX_CONNECTION;
  if (!executable && !baseUrl && !connectionId) return null;
  if (!executable || !isAbsolute(executable) || !baseUrl || !connectionId || !/^[a-zA-Z0-9._-]{1,128}$/.test(connectionId)) {
    throw new OmniRouteQuotaError("protocol-error");
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new OmniRouteQuotaError("protocol-error"); }
  // The installed CLI owns local management authentication; never send it to a remote host.
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new OmniRouteQuotaError("unsupported-protocol");
  }
  const target = { executable, baseUrl: url.origin, connectionId };
  const providers = await run(target, ["api", "providers", "get-api-providers"]);
  const connections = Array.isArray(providers) ? providers : record(providers) ? providers.connections ?? providers.providers : null;
  if (!Array.isArray(connections) || !connections.some((value) => record(value)
    && value.id === connectionId && value.provider === "codex" && value.isActive === true)) {
    throw new OmniRouteQuotaError("not-authenticated");
  }
  const usage = await run(target, ["api", "usage", "get-api-usage-connection-id-", "--connection-id", connectionId]);
  if (!record(usage) || !record(usage.quotas)) throw new OmniRouteQuotaError("protocol-error");
  const windows: LimitWindow[] = [];
  for (const [key, value] of Object.entries(usage.quotas)) {
    if (!record(value) || value.unlimited === true || !finite(value.used) || !finite(value.total)
      || value.used < 0 || value.total <= 0) continue;
    const reset = typeof value.resetAt === "string" ? Date.parse(value.resetAt) : NaN;
    windows.push({
      id: `omniroute:${key}`, bucketId: `omniroute:${key}`, slot: "primary", isDefaultBucket: key === "session" || key === "weekly",
      label: typeof value.displayName === "string" ? value.displayName.slice(0, 80) : null,
      usedPercent: Math.min(100, value.used / value.total * 100), used: value.used, limit: value.total,
      windowMinutes: finite(value.windowSeconds) && value.windowSeconds > 0 ? value.windowSeconds / 60 : null,
      resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null
    });
    if (windows.length === 12) break;
  }
  if (!windows.length) throw new OmniRouteQuotaError("protocol-error");
  return windows;
}

function runJson(target: Target, args: string[]): Promise<unknown> {
  const launch = providerChildProcessLaunch({ executable: target.executable,
    launcher: process.platform === "win32" && /\.(cmd|bat)$/i.test(target.executable) ? "batch" : "native",
    commandPrompt: process.env.ComSpec, environment: {} },
    ["--base-url", target.baseUrl, "--output", "json", ...args]);
  return new Promise((resolve, reject) => {
    execFile(launch.command, launch.args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576,
      windowsHide: true, ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) }, (error, stdout) => {
      if (error) return reject(new OmniRouteQuotaError(error.killed ? "timeout" : error.code === "ENOENT" ? "cli-not-found" : "protocol-error"));
      // OmniRoute may print boot diagnostics before its JSON. Never log diagnostics or API error bodies.
      const text = stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      for (const match of text.matchAll(/(?:^|\n)[ \t]*(?=[\[{])/g)) {
        try { resolve(JSON.parse(text.slice(match.index).trim())); return; } catch { /* try the next JSON line */ }
      }
      reject(new OmniRouteQuotaError("protocol-error"));
    });
  });
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
