import type { AgentCliAvailability, AgentProviderId, AppSettings } from "./contracts.ts";

type RouteSettings = Pick<AppSettings, "providerAccounts"> & { containerProfiles?: AppSettings["containerProfiles"] };

/** A provider can launch without a local CLI when an account is bound to a remote
 * computer or a saved container profile supplies its command. */
export function hasConfiguredRemoteRoute(settings: RouteSettings, provider: AgentProviderId): boolean {
  return settings.providerAccounts.some((account) => account.provider === provider && account.hostId !== undefined && account.hostId !== "local")
    || (settings.containerProfiles ?? []).some((profile) => Boolean(profile.commands[provider]));
}

/** Launchers show a provider when its local CLI was found or another configured route exists. */
export function launchableProviders(
  providers: Iterable<AgentProviderId>,
  cliAvailability: Partial<AgentCliAvailability> | null | undefined,
  settings: RouteSettings
): Set<AgentProviderId> {
  const result = new Set<AgentProviderId>();
  for (const provider of providers) {
    if (cliAvailability?.[provider] || hasConfiguredRemoteRoute(settings, provider)) result.add(provider);
  }
  return result;
}
