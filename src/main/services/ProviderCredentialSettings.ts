import type { ProviderSecretRef } from "../../shared/contracts.ts";
import type { SettingsStore } from "./SettingsStore.ts";

/** A same-reference key rotation can change the billing/data route. Persist its
 * stale markers first; if that write fails, do not mutate the credential. */
export async function mutateProviderCredential<T>(settings: Pick<SettingsStore, "get" | "update">, ref: ProviderSecretRef, mutate: () => Promise<T>): Promise<T> {
  const current = settings.get();
  const affected = new Set(current.apiProfiles.filter(profile => profile.secretRef === ref).map(profile => profile.id));
  const accounts = current.providerAccounts.map(account => account.binding?.kind === "api-profile" && affected.has(account.binding.profileId) && account.assessment ? { ...account, assessmentInvalid: true } : account);
  const profiles = current.apiProfiles.map(profile => affected.has(profile.id) && profile.assessment ? { ...profile, assessmentInvalid: true } : profile);
  if (accounts.some((row, index) => row !== current.providerAccounts[index]) || profiles.some((row, index) => row !== current.apiProfiles[index])) await settings.update({ providerAccounts: accounts, apiProfiles: profiles });
  return mutate();
}
