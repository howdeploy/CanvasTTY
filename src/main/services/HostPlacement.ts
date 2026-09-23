import {
  dataClassSatisfies,
  hostEffectiveMaxDataClass,
  providerPermittedOnHost,
  remotePathForHost
} from "../../shared/contracts.ts";
import type { AgentProviderId, DataClass, RemoteHost } from "../../shared/contracts";
import type { RemoteHostMetrics } from "./RemoteHostMetrics.ts";
import type { RemoteDiscoveryResult } from "./RemoteProviderDiscovery.ts";
import type { RemoteProviderAccessResult } from "./RemoteProviderAccess.ts";

// Automatic host placement for agent sessions: given the configured hosts and
// a placement request, decide which remote host the session should land on —
// or that it must stay local. This module is the decision layer ONLY: it owns
// no IPC surface, no renderer UI, no scheduler, no timer, and no learned
// model. Every input (utilization metrics, provider discovery, provider API
// access, active-session counts) is fetched on demand through the injected
// sources exactly once per place() call, in parallel across hosts, and a
// source that throws degrades that one host instead of ever failing the
// decision. A host only serves a provider when the host both MAY run it
// (providerAccess policy) and CAN reach its API endpoint.

/** What is being placed: the provider CLI the session needs plus the local
 *  project directory the remote session should work on. */
export interface PlacementRequest {
  provider: AgentProviderId;
  localWorkspace: string;
  /** Confidentiality tier of the task's data (Roadmap D5). When present, a
   *  host only serves the request when its own ceiling
   *  (hostEffectiveMaxDataClass) covers the class — the effective ceiling is
   *  min(provider tier, host ceiling). Absent disables class filtering
   *  entirely (backward compatibility). */
  dataClass?: DataClass;
}

/** Everything placement knows about one host after probing it. */
export interface PlacementCandidate {
  host: RemoteHost;
  metrics: RemoteHostMetrics | null;
  providerInstalled: boolean;
  /** Network path to the requested provider's API endpoint: true/false from
   *  an access probe, or null when no access data exists. A filter signal
   *  only — it never ranks candidates. */
  apiReachable: boolean | null;
  remoteWorkspace: string | null;
  activeSessions: number;
}

/** Either a concrete remote landing spot, or the local fallback with a
 *  concrete reason naming the deepest stage every host failed at. */
export type PlacementDecision =
  | { kind: "remote"; host: RemoteHost; remoteWorkspace: string }
  | { kind: "local"; reason: string };

/** Per-host facts placement needs, fetched on demand. `access` is optional:
 *  without it placement cannot exclude a host on network grounds (no data,
 *  no filtering), which keeps the surface backward compatible. All members
 *  are injectable so tests (and only tests) run without ssh or live hosts. */
export interface HostPlacementDataSources {
  metrics(host: RemoteHost): Promise<RemoteHostMetrics | null>;
  discovery(host: RemoteHost): Promise<RemoteDiscoveryResult | null>;
  activeSessions(hostId: string): number;
  access?(host: RemoteHost): Promise<RemoteProviderAccessResult | null>;
}

const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_PRIORITY = 50;

// Inert by design: constructing the service spawns nothing and starts no
// timer. Each place() call probes every host through the injected sources —
// one metrics probe, one discovery probe, one access probe when the source
// is present, and one session count per host.
export class HostPlacementService {
  private readonly sources: HostPlacementDataSources;

  constructor(sources: HostPlacementDataSources) {
    this.sources = sources;
  }

  async place(hosts: readonly RemoteHost[], request: PlacementRequest): Promise<PlacementDecision> {
    if (hosts.length === 0) {
      return { kind: "local", reason: "no configured hosts" };
    }
    // Promise.all over hosts: every host is probed whether or not an earlier
    // one would already win, and a degraded probe stays inside its candidate.
    const candidates = await Promise.all(hosts.map((host) => this.probe(host, request)));
    const eligible = candidates.filter((candidate) => isEligible(candidate, request));
    if (eligible.length === 0) {
      return { kind: "local", reason: localFallbackReason(candidates, request) };
    }
    eligible.sort(comparePlacementCandidates);
    const best = eligible[0];
    return { kind: "remote", host: best.host, remoteWorkspace: best.remoteWorkspace };
  }

  // Collects everything placement knows about one host. A throwing source
  // degrades only its own fact — metrics to null (unreachable), discovery to
  // null (not installed), access to null (no network data, so the host is
  // never excluded on network grounds), a throwing session counter to "full"
  // — so the host drops out conservatively and the call never rejects.
  private async probe(host: RemoteHost, request: PlacementRequest): Promise<PlacementCandidate> {
    const accessSource = this.sources.access;
    const [metrics, discovery, access] = await Promise.all([
      degrade(() => this.sources.metrics(host), null),
      degrade(() => this.sources.discovery(host), null),
      accessSource ? degrade(() => accessSource(host), null) : Promise.resolve(null)
    ]);
    let activeSessions: number;
    try {
      activeSessions = this.sources.activeSessions(host.id);
    } catch {
      activeSessions = Number.POSITIVE_INFINITY;
    }
    return {
      host,
      metrics,
      providerInstalled: providerInstalled(discovery, request.provider),
      apiReachable: apiReachableFor(access, request.provider),
      remoteWorkspace: remotePathForHost(host, request.localWorkspace),
      activeSessions
    };
  }
}

// The hard filters, all of which must hold, ordered exactly as the fallback
// reasons report them: reachability and provider presence first, then the
// two-provider-permission questions (the host's policy must allow the
// provider AND its API endpoint must not be known-blocked), then the host's
// data-class ceiling (Roadmap D5: a class-capped host never receives data
// above its label, however idle it is), then workspace mapping, then
// capacity. A host without a maxSessions value carries the default cap of 4.
// Like apiReachable, the host class is a FILTER signal only — it never ranks
// candidates.
function isEligible(
  candidate: PlacementCandidate,
  request: PlacementRequest
): candidate is PlacementCandidate & { remoteWorkspace: string } {
  return candidate.metrics?.reachable === true
    && candidate.providerInstalled === true
    && providerPermittedOnHost(candidate.host, request.provider)
    && candidate.apiReachable !== false
    && (request.dataClass === undefined
      || dataClassSatisfies(request.dataClass, hostEffectiveMaxDataClass(candidate.host)))
    && candidate.remoteWorkspace !== null
    && candidate.activeSessions < (candidate.host.maxSessions ?? DEFAULT_MAX_SESSIONS);
}

// Names the deepest stage at least one host reached, so a local fallback is
// always a concrete diagnosis instead of a shrug.
function localFallbackReason(candidates: readonly PlacementCandidate[], request: PlacementRequest): string {
  const provider = request.provider;
  const reachableInstalled = candidates.filter((candidate) =>
    candidate.metrics?.reachable === true && candidate.providerInstalled === true);
  if (reachableInstalled.length === 0) {
    return `no reachable host with ${provider} installed`;
  }
  const permittedReachable = reachableInstalled.filter((candidate) =>
    providerPermittedOnHost(candidate.host, provider) && candidate.apiReachable !== false);
  if (permittedReachable.length === 0) {
    return `provider ${provider} is not permitted or reachable on any eligible host`;
  }
  const requiredClass = request.dataClass;
  const classEligible = requiredClass === undefined
    ? permittedReachable
    : permittedReachable.filter((candidate) =>
      dataClassSatisfies(requiredClass, hostEffectiveMaxDataClass(candidate.host)));
  if (classEligible.length === 0) {
    return `no eligible host handles data class ${requiredClass}`;
  }
  const mapped = classEligible.filter((candidate) => candidate.remoteWorkspace !== null);
  if (mapped.length === 0) {
    return "workspace not mapped on any eligible host";
  }
  return "all eligible hosts full";
}

// Deterministic ranking, most significant key first:
//   1. activeSessions ascending — spread sessions before piling onto a host;
//   2. load1 normalized by cores (load1 / cores) ascending — per-core idleness,
//      not raw load; a load that cannot be computed (no metrics, null load1,
//      or null/zero cores) sorts LAST among candidates tied on sessions;
//   3. metrics.memoryAvailableMb DESCENDING — headroom wins, null last;
//   4. host.priority ascending, undefined counting as 50;
//   5. host.id ascending — the final stable tie-break, so candidates
//      identical through key 4 always compare the same way.
// Nothing else participates; a new signal starts here and in the tests.
// apiReachable is deliberately NOT here: it is a hard-filter signal (a host
// whose network path to the provider is blocked never becomes a candidate),
// never a ranking one. The host's data-class ceiling (hostEffectiveMaxDataClass)
// is equally excluded: a stricter-but-sufficient cap filters, it never demotes.
export function comparePlacementCandidates(a: PlacementCandidate, b: PlacementCandidate): number {
  if (a.activeSessions !== b.activeSessions) {
    return a.activeSessions - b.activeSessions;
  }
  const loadA = normalizedLoad(a);
  const loadB = normalizedLoad(b);
  if (loadA === null || loadB === null) {
    if (loadA !== loadB) {
      return loadA === null ? 1 : -1;
    }
  } else if (loadA !== loadB) {
    return loadA - loadB;
  }
  const memoryA = a.metrics?.memoryAvailableMb ?? null;
  const memoryB = b.metrics?.memoryAvailableMb ?? null;
  if (memoryA === null || memoryB === null) {
    if (memoryA !== memoryB) {
      return memoryA === null ? 1 : -1;
    }
  } else if (memoryA !== memoryB) {
    return memoryB - memoryA;
  }
  const priorityA = a.host.priority ?? DEFAULT_PRIORITY;
  const priorityB = b.host.priority ?? DEFAULT_PRIORITY;
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }
  if (a.host.id !== b.host.id) {
    return a.host.id < b.host.id ? -1 : 1;
  }
  return 0;
}

// load1 divided by cores, or null when the division is meaningless. A host
// that reported no metrics, no load, or no core count carries no load signal
// at all — it must not count as a zero-load host.
function normalizedLoad(candidate: PlacementCandidate): number | null {
  const metrics = candidate.metrics;
  if (metrics === null || metrics.load1 === null || metrics.cores === null || metrics.cores <= 0) {
    return null;
  }
  return metrics.load1 / metrics.cores;
}

// The requested provider's endpoint reachability from an access result, or
// null when there is nothing to learn: no result at all (source omitted or
// throwing, host unreachable), or a result whose probe did not cover the
// provider. Null is fail-open by design — missing data never excludes a
// host; only a definite false does.
function apiReachableFor(access: RemoteProviderAccessResult | null, provider: AgentProviderId): boolean | null {
  if (access === null) return null;
  const value = access.providers[provider];
  return value === true || value === false ? value : null;
}

function providerInstalled(discovery: RemoteDiscoveryResult | null, provider: AgentProviderId): boolean {
  if (discovery === null) return false;
  return discovery.providers.some((status) => status.provider === provider && status.installed === true);
}

// Runs one source call, falling back to `fallback` when it throws — including
// when it throws synchronously before producing a promise. Placement treats a
// broken source as missing data about one host, never as a failed decision.
async function degrade<T>(probe: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await probe();
  } catch {
    return fallback;
  }
}
