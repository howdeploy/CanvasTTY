import { ProbeCache, remoteProbeKey } from "./RemoteProbeCache.ts";
import type { ProbeCacheOptions } from "./RemoteProbeCache.ts";
import { PROVIDER_API_ENDPOINTS, providerApiUrl, remoteHostInvalidReason } from "../../shared/contracts.ts";
import type { AgentProviderId, RemoteHost } from "../../shared/contracts";
import type { RemoteHostRunner } from "./RemoteHostsService.ts";

// Which provider API endpoints answer from one remote host, answered with a
// single ssh round-trip. A host can be perfectly reachable by ssh and still
// sit where some provider APIs are network-blocked (a Russian server reaching
// Chinese providers but not OpenAI/Anthropic, for example), so placement asks
// the host itself whether the network path to each provider's beacon endpoint
// works. The answer is a heuristic, not truth: see PROVIDER_API_ENDPOINTS in
// shared/contracts for what a reply does and does not prove. Nothing here
// sends credentials — the probe only opens connections to public HTTPS roots.

/** The result of probing one remote host for provider API reachability.
 *  `providers` keys are provider ids (only the probed subset appears) and
 *  true means the network path to that provider's endpoint answered. */
export interface RemoteProviderAccessResult {
  collectedAt: number;
  hostId: string;
  reachable: boolean;
  providers: Record<string, boolean>;
  detail?: string;
}

// Every provider with a beacon endpoint, in declaration order: the default
// probe list when the caller does not narrow it.
const ALL_PROVIDER_IDS: readonly AgentProviderId[] =
  Object.keys(PROVIDER_API_ENDPOINTS) as AgentProviderId[];

const DEFAULT_TIMEOUT_MS = 15_000;
const DETAIL_MAX_LENGTH = 300;

// Inert by design: constructing the service spawns nothing. Each probe()
// cache miss runs one ssh invocation; concurrent identical reads share it.
export class RemoteProviderAccess {
  private readonly run: RemoteHostRunner;
  private readonly cache: ProbeCache<RemoteProviderAccessResult>;
  private readonly now: () => number;

  constructor(runner: RemoteHostRunner, options: ProbeCacheOptions = {}) {
    this.cache = new ProbeCache(options);
    this.run = runner;
    this.now = options.now ?? Date.now;
  }

  /** Probes `host` for reachability of every provider API endpoint (or only
   *  `probeProviders`, when given) in ONE ssh round-trip. Never rejects: an
   *  unreachable or invalid host reports `reachable: false` with no provider
   *  claims. */
  async probe(
    host: RemoteHost,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    probeProviders?: AgentProviderId[]
  ): Promise<RemoteProviderAccessResult> {
    const hostId = host && typeof host === "object" && typeof (host as { id?: unknown }).id === "string"
      ? (host as { id: string }).id
      : "unknown";
    const invalidReason = remoteHostInvalidReason(host);
    if (invalidReason !== null) {
      return { hostId, collectedAt: this.now(), reachable: false, providers: {}, detail: invalidReason };
    }
    const providers = probedProviderIds(probeProviders).sort();
    return this.cache.read(remoteProbeKey(host, [timeoutMs, providers]), () => this.probeUncached(host, timeoutMs, providers))
      .catch((error: unknown) => ({ hostId, collectedAt: this.now(), reachable: false, providers: {}, detail: excerpt(error instanceof Error ? error.message : String(error)) }));
  }

  private async probeUncached(host: RemoteHost, timeoutMs: number, providers: AgentProviderId[]): Promise<RemoteProviderAccessResult> {
    const hostId = host.id;
    try {
      const { code, stdout, stderr } = await this.run(
        host,
        [`sh -lc '${providerProbeScript(providers)}'`],
        timeoutMs
      );
      if (code !== 0) {
        return {
          hostId,
          collectedAt: this.now(),
          reachable: false,
          providers: {},
          detail: excerpt(stderr) || `ssh exited with code ${code === null ? "unknown" : code}`
        };
      }
      const answered = parseAnsweredProviders(stdout);
      const reachability: Record<string, boolean> = {};
      for (const provider of providers) {
        reachability[provider] = answered.has(provider);
      }
      return { hostId, collectedAt: this.now(), reachable: true, providers: reachability };
    } catch (error) {
      return {
        hostId,
        collectedAt: this.now(),
        reachable: false,
        providers: {},
        detail: excerpt(error instanceof Error ? error.message : String(error))
      };
    }
  }
}

// Narrows an explicit probe list to known provider ids, deduplicated in first
// mention order; absent input means "probe everything" (an explicitly empty
// list probes nothing and only answers whether ssh itself worked).
function probedProviderIds(probeProviders: AgentProviderId[] | undefined): AgentProviderId[] {
  if (probeProviders === undefined) return [...ALL_PROVIDER_IDS];
  // Widened to string keys so untyped JS callers passing an unknown id are
  // filtered out here instead of reaching the script.
  const endpoints = PROVIDER_API_ENDPOINTS as Record<string, string>;
  const seen = new Set<string>();
  const providers: AgentProviderId[] = [];
  for (const provider of probeProviders) {
    if (endpoints[provider] === undefined || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

// The POSIX sh probe body. Every provider endpoint is probed in a background
// subshell (`&` + `wait`). Placement narrows this to its single requested provider.
// curl is preferred: 403/451 are conservatively blocked, and 000 means transport
// failure. Other HTTP replies establish endpoint reachability only: 401 does
// not authenticate an account, and no reply proves subscription entitlement. When curl is
// absent, wget stands in and exit status 0 counts as reachable. Each block
// degrades alone behind 2>/dev/null and || true, and the script always exits
// 0: only ssh-level failures make the host unreachable, never a blocked
// endpoint. Double quotes throughout — the whole script is wrapped in single
// quotes, so a single quote anywhere would terminate that quoting on the
// remote side.
function providerProbeScript(providers: readonly AgentProviderId[]): string {
  const blocks = providers.map((provider) => [
    "(",
    "  if command -v curl >/dev/null 2>&1; then",
    `    code=$(curl -s -o /dev/null -m 6 -w "%{http_code}" "${providerApiUrl(provider)}" 2>/dev/null) || code=000`,
    '    case "$code" in',
    "      000|403|451) : ;;",
    `      [0-9][0-9][0-9]) printf "${provider}=1\\n" ;;`,
    "    esac",
    "  elif command -v wget >/dev/null 2>&1; then",
    `    wget -q -T 6 -O /dev/null "${providerApiUrl(provider)}" >/dev/null 2>&1 && printf "${provider}=1\\n"`,
    "  fi",
    ") &"
  ].join("\n"));
  return `${blocks.join("\n")}\nwait\nexit 0`;
}

// Parses `provider=1` lines; anything else (login banners, profile noise, a
// provider that stayed silent) is ignored, and only ids the script actually
// probed are turned into claims by the caller.
function parseAnsweredProviders(stdout: string): Set<string> {
  const answered = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    if (line.slice(separator + 1) !== "1") continue;
    answered.add(line.slice(0, separator));
  }
  return answered;
}

function excerpt(value: string): string {
  return value.trim().slice(0, DETAIL_MAX_LENGTH);
}
