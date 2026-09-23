import { assertDelegationRoute } from '../../shared/delegationLaunch.ts';
import type { ContextLaunchCapture, ContextLaunchService, PreparedLaunchContext } from './ContextLaunchService.ts';
import { selectLaunchAccount } from "../../shared/launchAccountPolicy.ts";
export { selectLaunchAccount } from "../../shared/launchAccountPolicy.ts";
import { assertContainerProfile } from "../../shared/containerProfiles.ts";
import { assertIsolationRequest } from "../../shared/isolation.ts";
import { accountConfiguredForRuntime, accountLaunchModel, accountRouteMaxDataClass } from "../../shared/providerAccountPolicy.ts";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { ApiProfile, AppSettings, CreateSessionRequest, DataClass, ProviderAccount, SessionMetadata } from "../../shared/contracts.ts";
import { DATA_CLASSES, DATA_CLASS_RANK, DEFAULT_AGENT_BUDGETS, dataClassForPath, dataClassSatisfies, hostEffectiveMaxDataClass, isValidRemoteHost, providerMaxDataClass, providerPermittedOnHost } from "../../shared/contracts.ts";

type LaunchSettings = Pick<AppSettings, "defaultDataClass" | "pathPolicies" | "providerAccounts" | "remoteHosts" | "agentBudgets" | "maxAccountsPerProviderPerHost"> & { apiProfiles?: ApiProfile[]; requiresSandboxProfiles?: AppSettings["requiresSandboxProfiles"]; containerProfiles?: AppSettings["containerProfiles"] };
type LaunchRequest = Pick<CreateSessionRequest, "isolation" | "provider" | "cwd" | "profile" | "model" | "accountId" | "dataClass" | "allowSubagents" | "role" | "parentSessionId" | "hostId" | "transport"> & { dataClassInherited?: boolean; initialPrompt?: string; disclosureClass?: DataClass };

/** Synchronous, live policy check at the actual process-launch boundary.
 * Path classification describes the task's cwd; it does not sandbox file reads.
 */
export class SessionLaunchPolicy {
  private readonly settings: () => LaunchSettings;
  private readonly repositoryRoot: (cwd: string) => string;
  private readonly context?: ContextLaunchService;
  private readonly capsulePolicy?: (request: LaunchRequest) => DataClass;

  constructor(settings: () => LaunchSettings, options: { context?: ContextLaunchService; repositoryRoot?: (cwd: string) => string; capsulePolicy?: (request: LaunchRequest) => DataClass } = {}) {
    this.settings = settings;
    this.context = options.context;
    this.repositoryRoot = options.repositoryRoot ?? resolveRepositoryRoot;
    this.capsulePolicy = options.capsulePolicy;
  }

  /** Used before async placement as well as immediately before launch. */
  classify<T extends LaunchRequest>(request: T, forPlacement = false): T & { dataClass: DataClass } {
    assertLaunchPolicyFields(request);
    assertDelegationRoute(request);
    assertIsolationRequest(request.isolation);
    const settings = this.settings();
    if (request.isolation?.mode === "container") {
      const profileId = request.isolation.profileId;
      const profile = settings.containerProfiles?.find(item => item.id === profileId);
      if (!profile) throw new Error("Selected container profile is not configured.");
      assertContainerProfile(profile);
      if (forPlacement || profile.hostId !== (request.hostId ?? "local")) throw new Error("Container launch requires the profile's exact execution host.");
      if (!profile.commands[request.provider]) throw new Error("Container profile has no supported command for this provider.");
    }
    if (request.hostId !== undefined && request.isolation?.mode === "worktree") throw new Error("Worktree isolation is supported only on the local computer.");
    if (settings.requiresSandboxProfiles?.includes(request.profile) && (!request.isolation || request.isolation.mode === "direct")) throw new Error("This launch profile requires a worktree or container.");
    let dataClass = request.dataClassInherited ? settings.defaultDataClass : request.dataClass ?? settings.defaultDataClass;
    assertDataClass(dataClass);
    if (request.isolation?.mode === 'container' && request.isolation.capsuleId) {
      if (!this.capsulePolicy) throw new Error('Registered capsule policy is unavailable.');
      const payloadClass = this.capsulePolicy(request); assertDataClass(payloadClass);
      dataClass = !request.dataClassInherited && request.dataClass && DATA_CLASS_RANK[request.dataClass] > DATA_CLASS_RANK[payloadClass] ? request.dataClass : payloadClass;
    } else if (settings.pathPolicies.length > 0) {
      const policyCwd = realpathSync(request.cwd);
      const root = this.repositoryRoot(policyCwd);
      if (typeof root !== "string" || !isAbsolute(root) || !isWithin(root, policyCwd)) {
        throw new Error("Cannot resolve repository root for launch policy.");
      }
      const pathClass = dataClassForPath(settings.pathPolicies, policyCwd, dataClass, root);
      if (DATA_CLASS_RANK[pathClass] > DATA_CLASS_RANK[dataClass]) dataClass = pathClass;
    }
    if (request.provider !== "terminal" && request.initialPrompt?.trim() && !(request.isolation?.mode === 'container' && request.isolation.capsuleId)) dataClass = maxClass(dataClass, 'D2');
    if (request.disclosureClass !== undefined) { assertDataClass(request.disclosureClass); dataClass = maxClass(dataClass, request.disclosureClass); }
    if (request.provider === "terminal") return { ...request, dataClass };
    let account: ProviderAccount | undefined;
    if (forPlacement) {
      const candidates = this.placementAccounts({ ...request, dataClass });
      if (request.accountId !== undefined) account = candidates?.[0];
    } else {
      account = selectLaunchAccount(settings.providerAccounts, request.provider, request.model, request.accountId, dataClass, {
        hostId: request.hostId, limit: settings.maxAccountsPerProviderPerHost ?? 1
      }, settings.apiProfiles);
    }
    if (!account && (!forPlacement || this.placementAccounts({ ...request, dataClass }) === undefined)) {
      const providerCap = providerMaxDataClass(request.provider);
      if (!dataClassSatisfies(dataClass, providerCap)) throw new Error(`Provider ${request.provider} handles at most ${providerCap}; this task is ${dataClass}.`);
    }
    assertDelegationRoute(request, account);
    const launchModel = account ? accountLaunchModel(account, request.model, settings.apiProfiles ?? []) : undefined;
    return { ...request, dataClass, ...(launchModel ? { model: launchModel } : {}), ...(account ? { accountId: account.id } : {}),
      ...(forPlacement && account ? { hostId: account.hostId === "local" ? undefined : account.hostId } : {}) };

  }

  /** One exact account/host route: mandatory payload first, optional context filtered to its actual cap. */
  evaluateFixed<T extends LaunchRequest>(request: T, sessions: readonly SessionMetadata[], excludeId?: string, capture?: ContextLaunchCapture): { request: T & { dataClass: DataClass }; context?: PreparedLaunchContext } {
    const base = this.check(request, sessions, excludeId);
    if (!capture || base.provider === 'terminal') return { request: base };
    if (!this.context) throw new Error('Context launch policy is unavailable.');
    const settings = this.settings();
    const account = settings.providerAccounts.find(a => a.id === base.accountId);
    let cap = account ? accountRouteMaxDataClass(account, settings.apiProfiles, base.model) : providerMaxDataClass(base.provider);
    if (base.hostId !== undefined) {
      const host = settings.remoteHosts.find(h => h.id === base.hostId);
      if (!host) throw new Error('Context route host is unavailable.');
      const hostCap = hostEffectiveMaxDataClass(host); if (DATA_CLASS_RANK[hostCap] < DATA_CLASS_RANK[cap]) cap = hostCap;
    }
    const context = this.context.project(capture, { provider: base.provider, accountId: base.accountId, hostId: base.hostId, policyModel: base.model, maxDataClass: cap });
    const floor = maxClass(base.disclosureClass ?? 'D0', context?.includedDataClass ?? 'D0');
    const final = this.check({ ...base, disclosureClass: floor }, sessions, excludeId);
    if (final.accountId !== base.accountId || final.model !== base.model || final.hostId !== base.hostId) throw new Error('Context evaluation changed its fixed route.');
    return { request: final, context };
  }

  /** Exact eligible native tuples, before network probes. */
  fixedPlacementRequests<T extends LaunchRequest>(request: T): T[] {
    const base = this.classify(request, true);
    const accounts = this.placementAccounts(base);
    const settings = this.settings();
    return accounts ? accounts.map(a => ({ ...request, accountId: a.id, hostId: a.hostId === 'local' ? undefined : a.hostId }))
      : [undefined, ...settings.remoteHosts.map(h => h.id)].map(hostId => ({ ...request, hostId }));
  }

  /** Eligible fixed bindings for async placement. Configuration validation is
   * shared with the final launch check; selection happens after host ranking. */
  placementAccounts(request: LaunchRequest & { dataClass?: DataClass }): ProviderAccount[] | undefined {
    if (request.provider === "terminal") return undefined;
    const settings = this.settings();
    const selected = selectLaunchAccount(settings.providerAccounts, request.provider, request.model, request.accountId, request.dataClass, undefined, settings.apiProfiles);
    if (!selected) return undefined;
    const limit = settings.maxAccountsPerProviderPerHost ?? 1;
    const accepted = settings.providerAccounts.filter((account) => {
      if (!accountConfiguredForRuntime(account, request.provider as ProviderAccount["provider"]) || (request.accountId !== undefined && account.id !== request.accountId)) return false;
      try { return !!selectLaunchAccount(settings.providerAccounts, request.provider as ProviderAccount["provider"], request.model, account.id, request.dataClass, { forPlacement: true, limit }, settings.apiProfiles); }
      catch { return false; }
    });
    if (accepted.length === 0) throw new Error("No eligible account binding satisfies the per-host account limit.");
    return accepted;
  }

  check<T extends LaunchRequest>(request: T, sessions: readonly SessionMetadata[], excludeId?: string): T & { dataClass: DataClass } {
    const launch = this.classify(request);
    const settings = this.settings();
    const budgets = settings.agentBudgets ?? DEFAULT_AGENT_BUDGETS;
    for (const [key, value] of Object.entries(budgets)) {
      if (!Number.isInteger(value) || value < 1 || value > (key === "maxDepth" ? 8 : 64)) throw new Error("Invalid agent concurrency budget.");
    }
    const active = sessions.filter((session) => session.id !== excludeId && session.exitCode === null);
    if (launch.accountId !== undefined && active.some((session) => session.accountId === launch.accountId && session.hostId !== launch.hostId)) {
      throw new Error(`Account ${launch.accountId} is still running on another host; stop those sessions before moving its binding.`);
    }
    if (launch.hostId !== undefined) {
      const host = settings.remoteHosts.find((candidate) => candidate.id === launch.hostId);
      if (!host || !isValidRemoteHost(host)) throw new Error(`Remote host ${launch.hostId} is not configured or invalid.`);
      const hostCap = hostEffectiveMaxDataClass(host);
      if (!dataClassSatisfies(launch.dataClass, hostCap)) throw new Error(`Remote host ${host.id} handles at most ${hostCap}; this task is ${launch.dataClass}.`);
      if (launch.provider !== "terminal" && !providerPermittedOnHost(host, launch.provider)) throw new Error(`Provider ${launch.provider} is not allowed on host ${host.id}.`);
      if (host.maxSessions !== undefined && active.filter((session) => session.hostId === host.id).length >= host.maxSessions) {
        throw new Error(`Remote host ${host.id} has reached its session limit (${host.maxSessions}).`);
      }
    }
    if (launch.provider === "terminal") return launch;
    const local = launch.hostId === undefined;
    const limit = local ? budgets.maxLocalAgents : budgets.maxRemoteAgentsPerHost;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid agent concurrency budget.");
    const running = active.filter((session) => session.provider !== "terminal" && session.hostId === launch.hostId);
    if (running.length >= limit) throw new Error(`${local ? "Local agents" : `Agents on host ${launch.hostId}`} reached the concurrency limit (${limit}).`);
    if (launch.parentSessionId !== undefined) {
      const parent = sessions.find((session) => session.id === launch.parentSessionId);
      if (!parent || parent.exitCode !== null) throw new Error("Parent agent is not running.");
      if (parent.role !== "orchestrator" && parent.allowSubagents !== true) throw new Error("Agent delegation is disabled for this parent.");
      if (active.filter((session) => session.parentSessionId === parent.id).length >= budgets.maxChildren) {
        throw new Error(`Session ${parent.id} reached its active child limit (${budgets.maxChildren}).`);
      }
      let depth = 1;
      let ancestor: SessionMetadata | undefined = parent;
      const seen = new Set<string>();
      while (ancestor?.parentSessionId !== undefined) {
        if (seen.has(ancestor.id)) throw new Error("Agent ancestry contains a cycle.");
        seen.add(ancestor.id);
        ancestor = sessions.find((session) => session.id === ancestor!.parentSessionId);
        if (!ancestor) throw new Error("Agent ancestor does not exist.");
        depth += 1;
      }
      if (!Number.isInteger(budgets.maxDepth) || depth > budgets.maxDepth) throw new Error(`Agent delegation exceeds maximum depth (${budgets.maxDepth}).`);
    }
    return launch;
  }
}

export function assertDataClass(value: unknown): asserts value is DataClass {
  if (!DATA_CLASSES.includes(value as DataClass)) throw new Error("Unknown data class; expected D0, D1, D2 or D3.");
}

export function assertLaunchPolicyFields(request: Pick<LaunchRequest, "model" | "accountId" | "dataClass" | "allowSubagents">): void {
  if (request.dataClass !== undefined) assertDataClass(request.dataClass);
  if (request.model !== undefined && (typeof request.model !== "string" || request.model.trim().length === 0 || request.model.length > 100)) throw new Error("Agent model must be a non-blank string of at most 100 characters.");
  if (request.accountId !== undefined && (typeof request.accountId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(request.accountId))) throw new Error("Agent account id must be an account id.");
  if (request.allowSubagents !== undefined && typeof request.allowSubagents !== "boolean") throw new Error("allowSubagents must be a boolean.");
}


function isWithin(root: string, cwd: string): boolean {
  const path = relative(root, cwd);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

export function resolveRepositoryRoot(cwd: string): string {
  try {
    const canonicalCwd = realpathSync(cwd);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    const root = execFileSync("git", ["-C", canonicalCwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 2_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"], env: environment }).trim();
    if (!isAbsolute(root) || !isWithin(root, canonicalCwd)) throw new Error("invalid root");
    return root;
  } catch {
    throw new Error("Cannot resolve repository root for launch policy.");
  }
}

export function maxClass(a: DataClass, b: DataClass): DataClass { return DATA_CLASS_RANK[a] >= DATA_CLASS_RANK[b] ? a : b; }
