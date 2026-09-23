import { startupArguments } from './AgentStartup.ts';
import type { ContextLaunchCapture, PreparedLaunchContext } from './ContextLaunchService.ts';
import { createHash } from 'node:crypto';
import type { ApiProfile, AppSettings, ContainerInventorySnapshot, ContainerProfile, CreateSessionRequest, DataClass, ProviderAccount, RemoteHost, RemoteHostUtilization, SessionMetadata } from '../../shared/contracts.ts';
import { DEFAULT_AGENT_BUDGETS, dataClassSatisfies, hostEffectiveMaxDataClass, providerPermittedOnHost, remoteHostInvalidReason, remotePathForHost } from '../../shared/contracts.ts';
import { assertContainerProfile } from '../../shared/containerProfiles.ts';
import { assertContainerPlacementRequest } from '../../shared/containerPlacement.ts';
import type { ContainerAutoLaunchRequest, ContainerPlacementExclusion, ContainerPlacementExclusionCode, ContainerPlacementPreview, ContainerPlacementTuple } from '../../shared/containerPlacement.ts';
import { accountApiProfile, accountConfiguredForRuntime } from '../../shared/providerAccountPolicy.ts';
import { validApiProfileCredential } from '../../shared/apiProfileCredentials.ts';
import { comparePlacementCandidates, degrade } from './HostPlacement.ts';
import type { PlacementCandidate } from './HostPlacement.ts';
import type { SessionLaunchPolicy } from './SessionLaunchPolicy.ts';
import { ProbeLimiter } from './RemoteProbeCache.ts';

export type ContainerPlacementSettings = Pick<AppSettings, 'containerProfiles' | 'remoteHosts' | 'providerAccounts' | 'apiProfiles' | 'defaultDataClass' | 'pathPolicies' | 'agentBudgets' | 'maxAccountsPerProviderPerHost' | 'requiresSandboxProfiles'>;
export interface ContainerPlacementSources {
  settings(): ContainerPlacementSettings;
  sessions(): readonly SessionMetadata[];
  policy: Pick<SessionLaunchPolicy, 'check'> & Partial<Pick<SessionLaunchPolicy, 'evaluateFixed'>>;
  /** Undefined denotes this computer. Only already statically eligible hosts are queried. */
  metrics(host: RemoteHost | undefined): Promise<RemoteHostUtilization | null>;
  /** Read-only, on demand; the source owns its bounded cache and engine verification. */
  inventory(profileIds: string[]): Promise<readonly ContainerInventorySnapshot[]>;
}
export interface ResolvedContainerRoute {
  context?: PreparedLaunchContext;
  request: CreateSessionRequest;
  decision: ContainerPlacementPreview & { kind: 'selected' };
  bindingDigest: string;
  /** Pass only the main-owned pending session's id. No async work or alternative selection. */
  assertCurrent(excludeSessionId?: string): void;
}
interface Candidate {
  tuple: ContainerPlacementTuple; profile: ContainerProfile; host?: RemoteHost;
  request: CreateSessionRequest; binding: string; capture?: ContextLaunchCapture; context?: PreparedLaunchContext;
}
interface Plan { preview: ContainerPlacementPreview; selected?: Candidate }
const MAX_CANDIDATES = 128, MAX_EXCLUSIONS = 64;
const LOCAL_HOST: RemoteHost = { id: 'local', label: 'Local', sshHost: 'localhost' };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Chooses one profile/host/account tuple before any workspace or launch reservation.
 * Availability is a hint only: the fixed launch and every later prepare boundary must
 * retain assertCurrent and the existing account/container ownership checks. */
export class ContainerPlacementService {
  private readonly sources: ContainerPlacementSources;
  private readonly limiter = new ProbeLimiter();
  constructor(sources: ContainerPlacementSources) { this.sources = sources; }

  async preview(request: ContainerAutoLaunchRequest, capture?: ContextLaunchCapture): Promise<ContainerPlacementPreview> { return (await this.plan(request, capture)).preview; }
  async resolve(request: ContainerAutoLaunchRequest, capture?: ContextLaunchCapture, parentFloor?: DataClass): Promise<ResolvedContainerRoute> {
    const plan = await this.plan(request, capture, parentFloor);
    if (plan.preview.kind !== 'selected' || !plan.selected) throw new Error('Container auto-placement has no eligible route.');
    const selected = plan.selected;
    // Separate copy prevents a caller changing its request during async preparation
    // from changing what the recheck authorizes. The returned request is also checked.
    const resolvedRequest = structuredClone(selected.request);
    const frozenRequest = digest(resolvedRequest);
    const result: ResolvedContainerRoute = { context: selected.context, request: resolvedRequest, decision: plan.preview, bindingDigest: selected.binding,
      assertCurrent: (excludeSessionId) => {
        capture?.assertCurrent();
        if (digest(resolvedRequest) !== frozenRequest || this.currentRejection(selected, excludeSessionId)) throw new Error('Selected container route changed or is no longer eligible; launch again.');
      } };
    result.assertCurrent();
    return result;
  }

  private async plan(input: ContainerAutoLaunchRequest, capture?: ContextLaunchCapture, parentFloor?: DataClass): Promise<Plan> {
    assertContainerPlacementRequest(input);
    try { return await this.buildPlan(input, capture, parentFloor); }
    catch { throw new Error('Container auto-placement could not verify current configuration.'); }
  }
  private async buildPlan(input: ContainerAutoLaunchRequest, capture?: ContextLaunchCapture, parentFloor?: DataClass): Promise<Plan> {
    const request = structuredClone(input);
    capture?.assertCurrent();
    const settings = structuredClone(this.sources.settings());
    const exclusions: ContainerPlacementExclusion[] = [];
    let exclusionsTruncated = false;
    const reject = (code: ContainerPlacementExclusionCode, tuple: Partial<ContainerPlacementTuple> = {}): void => {
      if (exclusions.length >= MAX_EXCLUSIONS) { exclusionsTruncated = true; return; }
      exclusions.push({ ...boundedTuple(tuple), code });
    };
    const empty = (reason: 'no-eligible-route' | 'too-many-candidates' = 'no-eligible-route'): Plan => ({ preview: { kind: 'none', reason, exclusions, exclusionsTruncated } });
    // Persisted settings are bounded too; do not quietly select from a truncated set.
    if (settings.containerProfiles.length > 64 || settings.providerAccounts.length > 512 || settings.remoteHosts.length > 512 || settings.apiProfiles.length > 512) return empty('too-many-candidates');
    const ids = request.containerPlacement.profileIds ?? settings.containerProfiles.map(p => p.id);
    const candidates: Candidate[] = [];
    for (const id of ids) {
      const profiles = settings.containerProfiles.filter(p => p.id === id);
      if (profiles.length !== 1) { reject('profile-invalid', { profileId: id }); continue; }
      const profile = profiles[0], tuple = { profileId: id, hostId: profile.hostId };
      const profileRejection = this.profileRejection(profile, request, settings);
      if (profileRejection) { reject(profileRejection, tuple); continue; }
      const host = profile.hostId === 'local' ? undefined : settings.remoteHosts.find(h => h.id === profile.hostId);
      const accounts: Array<ProviderAccount | undefined> = request.provider === 'terminal' ? [undefined] : settings.providerAccounts.filter(a =>
        (request.accountId === undefined || a.id === request.accountId) && accountConfiguredForRuntime(a, request.provider as ProviderAccount['provider']) && (a.hostId ?? 'local') === profile.hostId);
      if (!accounts.length) { reject('account-unavailable', tuple); continue; }
      for (const account of accounts) {
        const fullTuple = { ...tuple, ...(account ? { accountId: account.id } : {}) };
        const accountRejection = this.accountRejection(account, profile, settings);
        if (accountRejection) { reject(accountRejection, fullTuple); continue; }
        const { containerPlacement: _placement, ...base } = request;
        const fixed: CreateSessionRequest = { ...base, ...(parentFloor ? { disclosureClass: parentFloor } : {}), isolation: { mode: 'container', profileId: id },
          ...(host ? { hostId: host.id } : {}), ...(account ? { accountId: account.id } : {}) };
        const staticRejection = this.capacityRejection(fixed, host);
        if (staticRejection) { reject(staticRejection, fullTuple); continue; }
        let classified: CreateSessionRequest, context: PreparedLaunchContext | undefined;
        try {
          if (capture && !this.sources.policy.evaluateFixed) throw new Error('Context placement policy is unavailable.');
          const evaluated = this.sources.policy.evaluateFixed?.(fixed, this.sources.sessions(), undefined, capture);
          classified = evaluated?.request ?? this.sources.policy.check(fixed, this.sources.sessions()); context = evaluated?.context;
          startupArguments(classified.provider, { task: fixed.initialPrompt, context: context?.text || undefined });
        }
        catch { reject('launch-policy', fullTuple); continue; }
        if (account && (typeof classified.model !== 'string' || !classified.model.trim() || classified.model.length > 100 || /[\u0000-\u001f\u007f]/u.test(classified.model))) { reject('account-policy', fullTuple); continue; }
        if (classified.accountId !== account?.id || classified.hostId !== host?.id || classified.isolation?.mode !== 'container' || classified.isolation.profileId !== id) { reject('account-policy', fullTuple); continue; }
        if (host && (!classified.dataClass || !dataClassSatisfies(classified.dataClass, hostEffectiveMaxDataClass(host)))) { reject('host-policy', fullTuple); continue; }
        const candidate: Candidate = { tuple: fullTuple, profile, host, request: structuredClone(classified), binding: '', capture, context };
        candidate.binding = this.fingerprint(candidate, settings);
        // A synchronous caller-provided policy must not silently move to edited settings.
        const changed = this.currentRejection(candidate);
        if (changed) { reject(changed, fullTuple); continue; }
        candidates.push(candidate);
        if (candidates.length > MAX_CANDIDATES) return empty('too-many-candidates');
      }
    }
    if (!candidates.length) return empty();
    capture?.assertCurrent();
    const hosts = new Map(candidates.map(c => [c.tuple.hostId, c.host]));
    const profileIds = [...new Set(candidates.map(c => c.tuple.profileId))];
    const [inventory, metrics] = await Promise.all([
      degrade(() => this.sources.inventory(profileIds), [] as readonly ContainerInventorySnapshot[]),
      Promise.all([...hosts].map(async ([id, host]) => [id, await degrade(() => this.limiter.run(() => this.sources.metrics(host)), null)] as const))
    ]);
    capture?.assertCurrent();
    const metricMap = new Map(metrics), eligible: Array<{ candidate: Candidate; rank: PlacementCandidate }> = [];
    for (const candidate of candidates) {
      const changed = this.currentRejection(candidate);
      if (changed) { reject(changed, candidate.tuple); continue; }
      const fact = imageFact(inventory, candidate.profile);
      if (fact) { reject(fact, candidate.tuple); continue; }
      const metrics = metricMap.get(candidate.tuple.hostId);
      if (!validMetrics(metrics, candidate.tuple.hostId)) { reject('metrics-unavailable', candidate.tuple); continue; }
      const host = candidate.host;
      if (host && (host.minFreeMemoryMb !== undefined && (metrics.memoryAvailableMb === null || metrics.memoryAvailableMb < host.minFreeMemoryMb)
        || host.maxLoadPerCore !== undefined && (metrics.load1 === null || metrics.cores === null || metrics.load1 / metrics.cores > host.maxLoadPerCore))) { reject('resources', candidate.tuple); continue; }
      eligible.push({ candidate, rank: { host: host ?? LOCAL_HOST, metrics, activeSessions: this.activeSessions(candidate.tuple.hostId), providerInstalled: true, apiReachable: null, remoteWorkspace: null } });
    }
    eligible.sort((a, b) => comparePlacementCandidates(a.rank, b.rank) || lexical(a.candidate.tuple.profileId, b.candidate.tuple.profileId) || lexical(a.candidate.tuple.accountId ?? '', b.candidate.tuple.accountId ?? ''));
    const selected = eligible[0]?.candidate;
    return selected ? { selected, preview: { kind: 'selected', ...selected.tuple, dataClass: selected.request.dataClass!, ...(selected.request.model ? { model: selected.request.model } : {}), exclusions, exclusionsTruncated } } : empty();
  }

  private profileRejection(profile: ContainerProfile, request: CreateSessionRequest, settings: ContainerPlacementSettings): ContainerPlacementExclusionCode | undefined {
    try { assertContainerProfile(profile); } catch { return 'profile-invalid'; }
    if (!profile.commands[request.provider]) return 'provider-command';
    if (request.provider !== 'terminal' && profile.network !== 'bridge') return 'network-disabled';
    if (profile.hostId === 'local') return;
    const hosts = settings.remoteHosts.filter(h => h.id === profile.hostId), host = hosts[0];
    if (hosts.length !== 1 || !host || remoteHostInvalidReason(host) !== null) return 'host-invalid';
    if (request.provider !== 'terminal' && !providerPermittedOnHost(host, request.provider)) return 'host-policy';
    if (remotePathForHost(host, request.cwd) === null) return 'workspace-unmapped';
  }
  private accountRejection(account: ProviderAccount | undefined, profile: ContainerProfile, settings: ContainerPlacementSettings): ContainerPlacementExclusionCode | undefined {
    if (!account) return;
    if (settings.providerAccounts.filter(a => a.id === account.id).length !== 1 || account.binding?.kind !== 'api-profile' || account.bindingRequired || (account.hostId ?? 'local') !== profile.hostId) return 'account-binding';
    const profiles = settings.apiProfiles.filter(p => p.id === (account.binding as { profileId: string }).profileId), api = profiles[0];
    if (profiles.length !== 1 || !api || !validApiProfileCredential(api) || (api.hostId ?? 'local') !== profile.hostId) return 'credential-reference';
    try { if (!accountApiProfile(account, settings.apiProfiles)) return 'account-binding'; } catch { return 'account-policy'; }
    // The launch adapter requires a concrete model even for unrestricted accounts.
    if (api.defaultModel !== undefined && (typeof api.defaultModel !== 'string' || api.defaultModel.length > 100 || /[\u0000-\u001f\u007f]/u.test(api.defaultModel))) return 'account-policy';
  }
  private currentRejection(candidate: Candidate, excludeSessionId?: string): ContainerPlacementExclusionCode | undefined {
    try {
      const settings = this.sources.settings();
      if (this.fingerprint(candidate, settings) !== candidate.binding) return 'configuration-changed';
      const profile = settings.containerProfiles.find(p => p.id === candidate.tuple.profileId);
      if (!profile || this.profileRejection(profile, candidate.request, settings)) return 'configuration-changed';
      const account = candidate.tuple.accountId ? settings.providerAccounts.find(a => a.id === candidate.tuple.accountId) : undefined;
      if (candidate.tuple.accountId && !account || this.accountRejection(account, profile, settings)) return 'configuration-changed';
      const capacity = this.capacityRejection(candidate.request, candidate.host, excludeSessionId);
      if (capacity) return capacity;
      const evaluated = this.sources.policy.evaluateFixed?.(candidate.request, this.sources.sessions(), excludeSessionId, candidate.capture);
      const current = evaluated?.request ?? this.sources.policy.check(candidate.request, this.sources.sessions(), excludeSessionId);
      if (evaluated?.context?.digest !== candidate.context?.digest) return 'configuration-changed';
      if (digest(current) !== digest(candidate.request)) return 'configuration-changed';
    } catch { return 'launch-policy'; }
  }
  private capacityRejection(request: CreateSessionRequest, host?: RemoteHost, excludeSessionId?: string): ContainerPlacementExclusionCode | undefined {
    try {
      const active = this.sources.sessions().filter(s => s.id !== excludeSessionId && s.exitCode === null);
      if (host && active.filter(s => s.hostId === host.id).length >= (host.maxSessions ?? 4)) return 'capacity';
      if (request.provider === 'terminal') return;
      const budgets = this.sources.settings().agentBudgets ?? DEFAULT_AGENT_BUDGETS;
      const limit = host ? budgets.maxRemoteAgentsPerHost : budgets.maxLocalAgents;
      if (!Number.isInteger(limit) || limit < 1 || active.filter(s => s.provider !== 'terminal' && s.hostId === host?.id).length >= limit) return 'capacity';
    } catch { return 'capacity'; }
  }
  private activeSessions(hostId: string): number { return this.sources.sessions().filter(s => s.exitCode === null && (s.hostId ?? 'local') === hostId).length; }
  private fingerprint(candidate: Candidate, settings: ContainerPlacementSettings): string {
    const profiles = settings.containerProfiles.filter(p => p.id === candidate.tuple.profileId);
    const accounts = settings.providerAccounts.filter(a => a.id === candidate.tuple.accountId);
    const account = accounts[0];
    const apis: ApiProfile[] = account?.binding?.kind === 'api-profile' ? settings.apiProfiles.filter(p => p.id === (account.binding as { profileId: string }).profileId) : [];
    return digest({ request: candidate.request, profiles, hosts: candidate.host ? settings.remoteHosts.filter(h => h.id === candidate.tuple.hostId) : [], accounts, apis,
      policy: [settings.defaultDataClass, settings.pathPolicies, settings.agentBudgets, settings.maxAccountsPerProviderPerHost, settings.requiresSandboxProfiles] });
  }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function lexical(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function boundedTuple(tuple: Partial<ContainerPlacementTuple>): Partial<ContainerPlacementTuple> {
  return Object.fromEntries(Object.entries(tuple).filter(([, value]) => typeof value === 'string' && ID.test(value)));
}
function validMetrics(metrics: RemoteHostUtilization | null | undefined, hostId: string): metrics is RemoteHostUtilization {
  return !!metrics && metrics.hostId === hostId && metrics.reachable === true
    && (metrics.load1 === null || Number.isFinite(metrics.load1) && metrics.load1 >= 0)
    && (metrics.cores === null || Number.isInteger(metrics.cores) && metrics.cores > 0)
    && (metrics.memoryAvailableMb === null || Number.isFinite(metrics.memoryAvailableMb) && metrics.memoryAvailableMb >= 0);
}
function imageFact(inventory: readonly ContainerInventorySnapshot[], profile: ContainerProfile): ContainerPlacementExclusionCode | undefined {
  if (!Array.isArray(inventory) || inventory.length > 64) return 'unavailable';
  const matches = inventory.flatMap(snapshot => snapshot && Array.isArray(snapshot.profiles) && snapshot.profiles.length <= 64
    ? snapshot.profiles.filter((p: ContainerInventorySnapshot['profiles'][number]) => p?.profileId === profile.id).map((p: ContainerInventorySnapshot['profiles'][number]) => ({ snapshot, p })) : []);
  if (matches.length !== 1) return 'unavailable';
  const { snapshot, p } = matches[0];
  if (snapshot.available !== true || snapshot.hostId !== profile.hostId || snapshot.runtime !== profile.runtime) return 'unavailable';
  if (p.imageAvailable !== true || typeof p.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.imageId)) return 'image-unavailable';
}
