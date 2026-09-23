import type { ApiProfile, AppSettings, CanvasTTYApi, ProviderSecretRef } from "../../../../shared/contracts.ts";
import { isProviderSecretRef } from "../../../../shared/apiProfileCredentials.ts";
/** New references are committed to settings before input is cleared. A failed
 * reference write rolls back only the key allocated by this operation. */
export async function saveProfileCredential(profile: ApiProfile, value: string, configured: boolean | undefined, profiles: readonly ApiProfile[], persist: (patch: Partial<AppSettings>) => Promise<void>, secrets: CanvasTTYApi["providerSecrets"]): Promise<ProviderSecretRef> {
  const owner = { profileId: profile.id, hostId: profile.hostId ?? "local" };
  if (owner.hostId !== "local") throw new Error("Use an independently provisioned credential on the selected host.");
  if (!isProviderSecretRef(profile.secretRef) || profile.remoteCredential !== undefined) throw new Error("Save a valid local credential selection first.");
  if (profile.secretRef.startsWith("secret:") && configured !== false) {
    if (configured === undefined) throw new Error("Credential status is unavailable.");
    await secrets.update(profile.secretRef, owner, value);
    await persist({}); // Apply main-confirmed evidence invalidation after same-reference rotation.
    return profile.secretRef;
  }
  const created = await secrets.create(owner, value);
  try { await persist({ apiProfiles: profiles.map(p => p.id === profile.id ? { ...p, secretRef: created.ref } : p) }); }
  catch (failure) { await secrets.remove(created.ref, owner); throw failure; }
  return created.ref;
}
