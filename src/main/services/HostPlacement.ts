import { DATA_CLASSES, dataClassSatisfies, hostEffectiveMaxDataClass, providerPermittedOnHost, remotePathForHost, remoteHostInvalidReason } from "../../shared/contracts.ts";
import type { AgentProviderId, DataClass, RemoteHost } from "../../shared/contracts";
import type { RemoteHostMetrics } from "./RemoteHostMetrics.ts";
import type { RemoteDiscoveryResult } from "./RemoteProviderDiscovery.ts";
import type { RemoteProviderAccessResult } from "./RemoteProviderAccess.ts";
import { ProbeCache, ProbeLimiter, remoteProbeKey } from "./RemoteProbeCache.ts";

export interface PlacementRequest {
  provider: AgentProviderId;
  /** A main-owned pending reservation, excluded only from its own preflight. */
  excludeSessionId?: string;
  localWorkspace: string;
  dataClass?: DataClass;
  /** Main-only effective floor for already projected exact candidates on each host. */
  hostDataClasses?: Readonly<Record<string, DataClass>>;
  /** Fixed account bindings, already filtered by model/privacy. No rebinding. */
  eligibleHostIds?: readonly string[];
}
export interface PlacementCandidate {
  host: RemoteHost;
  metrics: RemoteHostMetrics | null;
  providerInstalled: boolean;
  /** Endpoint reachability only; never proof of account authentication. */
  apiReachable: boolean | null;
  remoteWorkspace: string | null;
  activeSessions: number;
}
export type PlacementDecision =
  | { kind: "remote"; host: RemoteHost; remoteWorkspace: string }
  | { kind: "local"; reason: string };
export interface HostPlacementCapacity {
  activeSessions(hostId: string): number;
  /** Live agent budget, independent of the host's all-session capacity. */
  hasAgentCapacity?(hostId: string): boolean;
}
export type HostPlacementDataSources = {
  metrics(host: RemoteHost): Promise<RemoteHostMetrics | null>;
  discovery(host: RemoteHost, providers?: AgentProviderId[]): Promise<RemoteDiscoveryResult | null>;
  access?(host: RemoteHost, providers?: AgentProviderId[]): Promise<RemoteProviderAccessResult | null>;
} & (HostPlacementCapacity | { capacity(excludeSessionId?: string): HostPlacementCapacity });
const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_PRIORITY = 50;
type Rejection = { stage: number; reason: string };
type HostFacts = Pick<PlacementCandidate, "metrics" | "providerInstalled" | "apiReachable">;

/** On-demand only. Static prohibitions precede network activity. Fact probes are
 * bounded and coalesced across simultaneous placements; live capacity is not cached. */
export class HostPlacementService {
  private readonly sources: HostPlacementDataSources;
  private readonly limiter = new ProbeLimiter();
  private readonly facts = new ProbeCache<HostFacts>();
  constructor(sources: HostPlacementDataSources) { this.sources = sources; }

  async checkShell(host: RemoteHost, excludeSessionId?: string): Promise<void> {
    const checkCapacity = (): void => {
      if (remoteHostInvalidReason(host) !== null) throw new Error("Remote host configuration is invalid.");
      if (this.sessionCount(this.capacity(excludeSessionId), host.id) >= (host.maxSessions ?? DEFAULT_MAX_SESSIONS)) throw new Error("Selected remote host is full.");
    };
    checkCapacity();
    const metrics = await degrade(() => this.limiter.run(() => this.sources.metrics(host)), null);
    checkCapacity();
    if (metrics?.reachable !== true || !resourcesSatisfied({ host, metrics, providerInstalled: true, apiReachable: null, remoteWorkspace: null, activeSessions: 0 })) throw new Error("Remote host resource constraints are not met or required metrics are unavailable.");
  }

  async place(hosts: readonly RemoteHost[], request: PlacementRequest): Promise<PlacementDecision> {
    if (hosts.length === 0) return { kind: "local", reason: "no configured hosts" };
    const rejected: Rejection[] = [];
    const initialCapacity = this.capacity(request.excludeSessionId);
    const candidates = await Promise.all(hosts.slice(0, 512).map(async (host): Promise<PlacementCandidate | null> => {
      const rejection = this.staticRejection(host, request, initialCapacity);
      if (rejection) { rejected.push(rejection); return null; }
      const facts = await degrade(() => this.facts.read(remoteProbeKey(host, request.provider), () => this.probe(host, request.provider)), null);
      if (!facts) { rejected.push({ stage: 1, reason: `no reachable host with ${request.provider} installed` }); return null; }
      return { host, ...facts, remoteWorkspace: remotePathForHost(host, request.localWorkspace), activeSessions: 0 };
    }));
    const eligible: Array<PlacementCandidate & { remoteWorkspace: string }> = [];
    const currentCapacity = this.capacity(request.excludeSessionId);
    for (const candidate of candidates) {
      if (!candidate) continue;
      // Re-read after all async work: a concurrent launch may have filled a host.
      candidate.activeSessions = this.sessionCount(currentCapacity, candidate.host.id);
      const staticRejection = this.staticRejection(candidate.host, request, currentCapacity, candidate.activeSessions);
      let rejection = staticRejection;
      if (!rejection && (candidate.metrics?.reachable !== true || !candidate.providerInstalled)) rejection = { stage: 1, reason: `no reachable host with ${request.provider} installed` };
      if (!rejection && candidate.apiReachable === false) rejection = { stage: 2, reason: `provider ${request.provider} is not permitted or reachable on any eligible host` };
      if (!rejection && !resourcesSatisfied(candidate)) rejection = { stage: 6, reason: "host resource constraints are not met or required metrics are unavailable" };
      if (rejection) rejected.push(rejection);
      else if (candidate.remoteWorkspace !== null) eligible.push(candidate as PlacementCandidate & { remoteWorkspace: string });
    }
    eligible.sort(comparePlacementCandidates);
    const best = eligible[0];
    if (best) return { kind: "remote", host: best.host, remoteWorkspace: best.remoteWorkspace };
    rejected.sort((a, b) => b.stage - a.stage || a.reason.localeCompare(b.reason));
    return { kind: "local", reason: rejected[0]?.reason ?? "no eligible host" };
  }

  private staticRejection(host: RemoteHost, request: PlacementRequest, capacity: HostPlacementCapacity, activeSessions?: number): Rejection | null {
    if (remoteHostInvalidReason(host) !== null) return { stage: 0, reason: "no valid configured host" };
    if (request.eligibleHostIds && !request.eligibleHostIds.includes(host.id)) return { stage: 0, reason: "no eligible account is bound to this host" };
    if (!providerPermittedOnHost(host, request.provider)) return { stage: 2, reason: `provider ${request.provider} is not permitted or reachable on any eligible host` };
    const dataClass = request.hostDataClasses === undefined ? request.dataClass : request.hostDataClasses[host.id];
    if (request.hostDataClasses !== undefined && !DATA_CLASSES.includes(dataClass as DataClass)) return { stage: 0, reason: 'host has no valid projected data class' };
    if (dataClass !== undefined && !dataClassSatisfies(dataClass, hostEffectiveMaxDataClass(host))) return { stage: 3, reason: `no eligible host handles data class ${dataClass}` };
    if (remotePathForHost(host, request.localWorkspace) === null) return { stage: 4, reason: "workspace not mapped on any eligible host" };
    if ((activeSessions ?? this.sessionCount(capacity, host.id)) >= (host.maxSessions ?? DEFAULT_MAX_SESSIONS) || !this.agentCapacity(capacity, host.id)) return { stage: 5, reason: "all eligible hosts full" };
    return null;
  }
  private capacity(excludeSessionId?: string): HostPlacementCapacity {
    try { return "capacity" in this.sources ? this.sources.capacity(excludeSessionId) : this.sources; }
    catch { return { activeSessions: () => Infinity, hasAgentCapacity: () => false }; }
  }
  private sessionCount(capacity: HostPlacementCapacity, id: string): number {
    try { const count = capacity.activeSessions(id); return Number.isInteger(count) && count >= 0 ? count : Infinity; }
    catch { return Infinity; }
  }
  private agentCapacity(capacity: HostPlacementCapacity, id: string): boolean {
    try { return capacity.hasAgentCapacity?.(id) ?? true; }
    catch { return false; }
  }
  private async probe(host: RemoteHost, provider: AgentProviderId): Promise<HostFacts> {
    const accessSource = this.sources.access;
    const [metrics, discovery, access] = await Promise.all([
      degrade(() => this.limiter.run(() => this.sources.metrics(host)), null),
      degrade(() => this.limiter.run(() => this.sources.discovery(host, [provider])), null),
      accessSource ? degrade(() => this.limiter.run(() => accessSource(host, [provider])), null) : Promise.resolve(null)
    ]);
    return { metrics, providerInstalled: providerInstalled(discovery, provider), apiReachable: apiReachableFor(access, provider) };
  }
}
function resourcesSatisfied(candidate: PlacementCandidate): boolean {
  const { host, metrics } = candidate;
  if (host.minFreeMemoryMb !== undefined && (metrics?.memoryAvailableMb == null || !Number.isFinite(metrics.memoryAvailableMb) || metrics.memoryAvailableMb < host.minFreeMemoryMb)) return false;
  if (host.maxLoadPerCore !== undefined) {
    const load = normalizedLoad(candidate);
    if (load === null || !Number.isFinite(load) || load < 0 || load > host.maxLoadPerCore) return false;
  }
  return true;
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
// throwing), or a result whose probe did not cover the provider. An explicit
// transport failure excludes the host. Absent data remains unknown for legacy
// sources; none of these signals proves account authentication.
function apiReachableFor(access: RemoteProviderAccessResult | null, provider: AgentProviderId): boolean | null {
  if (access === null) return null;
  if (!access.reachable) return false;
  const value = access.providers[provider];
  return value === true || value === false ? value : null;
}

function providerInstalled(discovery: RemoteDiscoveryResult | null, provider: AgentProviderId): boolean {
  if (discovery === null || !discovery.reachable) return false;
  return discovery.providers.some((status) => status.provider === provider && status.installed === true);
}

// Runs one source call, falling back to `fallback` when it throws — including
// when it throws synchronously before producing a promise. Placement treats a
// broken source as missing data about one host, never as a failed decision.
export async function degrade<T>(probe: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await probe();
  } catch {
    return fallback;
  }
}
