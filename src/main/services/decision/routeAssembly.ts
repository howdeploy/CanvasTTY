import { createHash } from 'node:crypto';
import { CANVAS_LAUNCHER_ITEMS, providerPermittedOnHost, reasoningEffortsFor, type AgentProviderId, type AppSettings, type ReasoningEffort } from '../../../shared/contracts.ts';
import { MAX_DECISION_ROUTES, routeTupleKey, type DecisionRoute } from '../../../shared/decisions.ts';
import { accountConfiguredForRuntime, accountForwardsKey, accountSupportsRuntime, validAccountBinding } from '../../../shared/providerAccountPolicy.ts';

export interface RouteAssemblySources {
  /** Local CLI detection from the provider registry. */
  localCli(provider: AgentProviderId): boolean;
  /** Cached remote discovery only; assembly never probes a server. */
  remoteAvailable(hostId: string, provider: AgentProviderId): boolean;
}

type AssemblySettings = Pick<AppSettings, 'providerAccounts' | 'apiProfiles' | 'remoteHosts'>;

const MAX_MODELS_PER_ACCOUNT = 3;
// Every merged tuple is policy-checked per recommendation; keep that work bounded.
const MAX_MERGED_ROUTES = 64;

/** Every launchable agent/account/computer/model/effort tuple, in launcher order. Launch policy,
 * capacity and data class are still checked per candidate at recommendation time. */
export function assembleDecisionRoutes(settings: AssemblySettings, sources: RouteAssemblySources, efforts: readonly ReasoningEffort[]): DecisionRoute[] {
  const bases: Array<Omit<DecisionRoute, 'id' | 'effort'>> = [];
  for (const provider of CANVAS_LAUNCHER_ITEMS) {
    if (provider === 'terminal') continue;
    const accounts = settings.providerAccounts.filter(account => accountConfiguredForRuntime(account, provider));
    if (accounts.length === 0) {
      // Without accounts the ordinary CLI login runs wherever the CLI was found.
      if (sources.localCli(provider)) bases.push({ provider, hostId: 'local', transport: 'pty' });
      for (const host of settings.remoteHosts) {
        if (providerPermittedOnHost(host, provider) && sources.remoteAvailable(host.id, provider)) bases.push({ provider, hostId: host.id, transport: 'pty' });
      }
      continue;
    }
    for (const account of accounts) {
      if (account.bindingRequired || !validAccountBinding(account.binding) || !accountSupportsRuntime(account, provider, settings.apiProfiles)) continue;
      // A key kept in this app is forwarded to any server; other accounts stay on their bound host.
      const forwards = accountForwardsKey(account, provider, settings.apiProfiles);
      const hostIds = forwards ? ['local', ...settings.remoteHosts.filter(host => providerPermittedOnHost(host, provider)).map(host => host.id)] : [account.hostId ?? 'local'];
      const models = (account.models ?? []).filter(model => !model.includes('*')).slice(0, MAX_MODELS_PER_ACCOUNT);
      for (const hostId of hostIds) {
        // Other remote API accounts run only inside a saved container, which routing does not choose.
        if (hostId === 'local' ? !sources.localCli(provider) : !forwards && account.binding.kind === 'api-profile' || !sources.remoteAvailable(hostId, provider)) continue;
        for (const model of models.length ? models : [undefined]) bases.push({ provider, accountId: account.id, hostId, transport: 'pty', ...(model ? { model } : {}) });
      }
    }
  }
  const routes: DecisionRoute[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    const supported = reasoningEffortsFor(base.provider).filter(effort => efforts.includes(effort));
    for (const effort of supported.length ? supported : [undefined]) {
      const route = { ...base, ...(effort ? { effort } : {}) };
      const key = routeTupleKey(route);
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ id: `auto-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`, ...route });
      if (routes.length >= MAX_DECISION_ROUTES) return routes;
    }
  }
  return routes;
}

/** Configured routes win; automatic tuples fill in anything not configured. */
export function mergeDecisionRoutes(configured: readonly DecisionRoute[], automatic: readonly DecisionRoute[]): Array<DecisionRoute & { automatic: boolean }> {
  const keys = new Set(configured.map(routeTupleKey));
  return [
    ...configured.map(route => ({ ...route, automatic: false })),
    ...automatic.filter(route => !keys.has(routeTupleKey(route))).map(route => ({ ...route, automatic: true }))
  ].slice(0, MAX_MERGED_ROUTES);
}
