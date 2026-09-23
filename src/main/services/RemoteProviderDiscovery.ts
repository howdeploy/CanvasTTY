import { remoteHostInvalidReason } from "../../shared/contracts.ts";
import type { AgentProviderId, RemoteHost } from "../../shared/contracts";
import type { RemoteHostRunner } from "./RemoteHostsService.ts";
import { PROVIDER_CLI_DEFINITIONS, PROVIDER_CLI_IDS } from "./providerCliRegistry.ts";

// Which provider CLIs exist on one remote host, answered with a single ssh
// round-trip. Discovery is read-only presence checking: whether the user is
// logged into a provider on that host is the user's business, so nothing here
// reads, copies, or transmits credentials of any kind.

/** One provider's presence on the remote host. */
export interface RemoteProviderStatus {
  provider: AgentProviderId;
  installed: boolean;
  /** The command name that resolved (first declared spelling wins). */
  command?: string;
  /** The absolute path `command -v` reported for `command`. */
  path?: string;
}

/** The result of probing one remote host for provider CLIs. */
export interface RemoteDiscoveryResult {
  hostId: string;
  reachable: boolean;
  providers: RemoteProviderStatus[];
  detail?: string;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DETAIL_MAX_LENGTH = 300;
// Wraps the probe in `sh -lc '<script>'`: a login shell sources the profile,
// so PATH covers ~/.local/bin, version managers, and the other places these
// CLIs install. The script itself is POSIX sh and contains no single quotes,
// so wrapping it in one quoted argument survives ssh's argv joining and the
// remote shell intact.

// Inert by design: constructing the service spawns nothing. Each discover()
// call runs exactly one ssh invocation.
export class RemoteProviderDiscovery {
  private readonly run: RemoteHostRunner;

  constructor(runner: RemoteHostRunner) {
    this.run = runner;
  }

  async discover(host: RemoteHost, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RemoteDiscoveryResult> {
    const hostId = host && typeof host === "object" && typeof (host as { id?: unknown }).id === "string"
      ? (host as { id: string }).id
      : "unknown";
    const invalidReason = remoteHostInvalidReason(host);
    if (invalidReason !== null) {
      return { hostId, reachable: false, providers: [], detail: invalidReason };
    }
    try {
      const { code, stdout, stderr } = await this.run(
        host,
        [`sh -lc '${remoteProbeScript(dedupedCommandNames())}'`],
        timeoutMs
      );
      if (code !== 0) {
        return {
          hostId,
          reachable: false,
          providers: [],
          detail: excerpt(stderr) || `ssh exited with code ${code === null ? "unknown" : code}`
        };
      }
      const resolved = parseResolvedCommands(stdout);
      return {
        hostId,
        reachable: true,
        providers: PROVIDER_CLI_IDS.map((provider) => providerStatus(provider, resolved))
      };
    } catch (error) {
      return {
        hostId,
        reachable: false,
        providers: [],
        detail: excerpt(error instanceof Error ? error.message : String(error))
      };
    }
  }
}

// Every command name across all providers, deduped in declaration order, so
// one loop checks each name exactly once no matter how providers share
// spellings. PROVIDER_CLI_DEFINITIONS stays the only place that knows which
// commands belong to which provider.
function dedupedCommandNames(): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const id of PROVIDER_CLI_IDS) {
    for (const command of PROVIDER_CLI_DEFINITIONS[id].commands) {
      if (!seen.has(command)) {
        seen.add(command);
        names.push(command);
      }
    }
  }
  return names;
}

function remoteProbeScript(commandNames: readonly string[]): string {
  // Double quotes throughout: the whole script is wrapped in single quotes,
  // so a single quote anywhere (printf's usual '%s=%s\n' spelling included)
  // would terminate that quoting on the remote side.
  return `for c in ${commandNames.join(" ")}; do p=$(command -v "$c" 2>/dev/null) && printf "%s=%s\\n" "$c" "$p"; done; exit 0`;
}

// Parses `name=/path` lines; anything else (login banners, profile noise,
// truncated or empty-path lines) is ignored. First occurrence of a name wins.
function parseResolvedCommands(stdout: string): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    const path = line.slice(separator + 1);
    if (name.length === 0 || path.length === 0 || resolved.has(name)) continue;
    resolved.set(name, path);
  }
  return resolved;
}

function providerStatus(provider: AgentProviderId, resolved: Map<string, string>): RemoteProviderStatus {
  for (const command of PROVIDER_CLI_DEFINITIONS[provider].commands) {
    const path = resolved.get(command);
    if (path !== undefined && path.startsWith("/") && !/[\u0000-\u001f\u007f]/u.test(path)
      && !(provider === "cursor" && command === "agent" && !/(?:^|\/)(?:\.cursor|cursor-agent|cursor)\//u.test(path))) {
      return { provider, installed: true, command, path };
    }
  }
  return { provider, installed: false };
}

function excerpt(value: string): string {
  return value.trim().slice(0, DETAIL_MAX_LENGTH);
}
