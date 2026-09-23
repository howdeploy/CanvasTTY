import type { ApiProfile, AppSettings, ProviderAccount } from "./contracts.ts";
import { API_PROFILE_PROTOCOLS, CANVAS_LAUNCHER_ITEMS, DATA_CLASSES } from "./contracts.ts";
import { assertExecutionSettingsPatch, sshTargetIdentity } from "./executionSettings.ts";
import { validApiProfileCredential } from "./apiProfileCredentials.ts";
import { accountApiProfile, accountRouteBinding, accountServiceCount, accountServiceKey, assertAccountAliases, canonicalApiUrl, validAccountBinding, validAssessment } from "./providerAccountPolicy.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function accountInvalidReason(value: unknown): string | undefined {
  if (!object(value) || typeof value.id !== "string" || !ID.test(value.id) || !text(value.label, 80)
    || !CANVAS_LAUNCHER_ITEMS.includes(value.provider as never) || value.provider === "terminal") return "Account identity is invalid.";
  if (value.tier !== undefined && !text(value.tier, 40)) return "Account tier must be a non-empty label of at most 40 characters.";
  if (value.models !== undefined && (!Array.isArray(value.models) || value.models.length > 64 || value.models.some(model => !text(model, 100)) || new Set(value.models.map(model => String(model).toLowerCase())).size !== value.models.length)) return "Account models must contain at most 64 unique model names (100 characters each).";
  if (value.hostId !== undefined && (typeof value.hostId !== "string" || !ID.test(value.hostId))) return "Account host binding is invalid.";
  if (value.binding !== undefined && !validAccountBinding(value.binding)) return "Account authentication binding is invalid.";
  if (value.shared !== undefined && typeof value.shared !== "boolean" || value.bindingRequired !== undefined && typeof value.bindingRequired !== "boolean" || value.assessmentInvalid !== undefined && typeof value.assessmentInvalid !== "boolean") return "Account flags are invalid.";
  if (value.maxDataClass !== undefined && !DATA_CLASSES.includes(value.maxDataClass as never)) return "Account data-class limit is invalid.";
  if (value.assessment !== undefined && !validAssessment(value.assessment)) return "Account assessment is incomplete.";
  return undefined;
}
export function apiProfileInvalidReason(value: unknown): string | undefined {
  if (!object(value) || typeof value.id !== "string" || !ID.test(value.id) || !text(value.name, 80) || !API_PROFILE_PROTOCOLS.includes(value.protocol as never) || !validApiProfileCredential(value as unknown as ApiProfile)) return "API profile identity or credential reference is invalid.";
  if (value.baseUrl !== undefined) { try { canonicalApiUrl(value.baseUrl); } catch { return "API URL must use HTTPS (or literal loopback HTTP), without credentials, query or fragment."; } }
  if (value.defaultModel !== undefined && !text(value.defaultModel, 200)) return "API model must be a non-empty name of at most 200 characters.";
  if (value.hostId !== undefined && (typeof value.hostId !== "string" || !ID.test(value.hostId))) return "API profile host is invalid.";
  if (value.assessment !== undefined && !validAssessment(value.assessment)) return "API profile assessment is incomplete.";
  return undefined;
}
function editedRows<T extends { id: string }>(next: readonly T[], before: readonly T[], invalidReason: (value: unknown) => string | undefined): Set<string> {
  if (!Array.isArray(next) || next.length > 512) throw new Error("Connection catalog must contain at most 512 rows.");
  const ids = new Set<string>(), changed = new Set<string>();
  for (const row of next) {
    if (!object(row) || typeof row.id !== "string" || ids.has(row.id)) throw new Error("Connection catalog contains an invalid or duplicate identity.");
    ids.add(row.id);
    if (same(row, before.find(old => old.id === row.id))) continue;
    const reason = invalidReason(row); if (reason) throw new Error(reason);
    changed.add(row.id);
  }
  return changed;
}
/** Validate edited rows before migration normalizers can narrow/drop them. Unchanged
 * legacy-disabled rows remain available for repair. No credential values occur here. */
export function validatedConnectionsPatch(current: AppSettings, patch: Partial<AppSettings>): Partial<AppSettings> {
  assertExecutionSettingsPatch(current, patch);
  if (patch.maxAccountsPerProviderPerHost !== undefined && patch.maxAccountsPerProviderPerHost !== 1 && patch.maxAccountsPerProviderPerHost !== 2) throw new Error("Account capacity limit must be exactly one or two.");
  if (patch.apiProfiles !== undefined && !Array.isArray(patch.apiProfiles) || patch.providerAccounts !== undefined && !Array.isArray(patch.providerAccounts)) throw new Error("Connection catalog must be an array.");
  const profiles = patch.apiProfiles ?? current.apiProfiles;
  const accounts = patch.providerAccounts ?? current.providerAccounts;
  const hosts = patch.remoteHosts ?? current.remoteHosts;
  const changedTargets = new Set(hosts.filter(host => current.remoteHosts.some(old => old.id === host.id && sshTargetIdentity(old) !== sshTargetIdentity(host))).map(host => host.id));
  const changedProfiles = editedRows(profiles, current.apiProfiles, apiProfileInvalidReason);
  const changedAccounts = editedRows(accounts, current.providerAccounts, accountInvalidReason);
  const relevant = new Set(changedAccounts);
  for (const a of accounts) if (a.binding?.kind === "api-profile" && changedProfiles.has(a.binding.profileId)) relevant.add(a.id);
  const removedProfiles = current.apiProfiles.filter(p => !profiles.some(next => next.id === p.id));
  if (removedProfiles.some(p => accounts.some(a => a.binding?.kind === "api-profile" && a.binding.profileId === p.id))) throw new Error("API profile is referenced by an account. Repair or remove that binding first.");
  const removedHosts = current.remoteHosts.filter(h => !hosts.some(next => next.id === h.id));
  if (removedHosts.some(h => accounts.some(a => a.hostId === h.id) || profiles.some(p => p.hostId === h.id) || (patch.containerProfiles ?? current.containerProfiles).some(p => p.hostId === h.id))) throw new Error("Host is referenced by an account, API profile or container. Repair those bindings first.");
  for (const p of profiles) if (changedProfiles.has(p.id) && p.hostId && p.hostId !== "local" && !hosts.some(h => h.id === p.hostId)) throw new Error("API profile host is not saved.");
  assertAccountAliases(accounts, profiles, relevant);
  const limit = patch.maxAccountsPerProviderPerHost ?? current.maxAccountsPerProviderPerHost;
  for (const a of accounts) {
    if (!relevant.has(a.id)) continue;
    if (a.hostId && a.hostId !== "local" && !hosts.some(h => h.id === a.hostId)) throw new Error("Account host is not saved.");
    if (a.binding?.kind === "api-profile") accountApiProfile(a, profiles);
    if (a.assessmentInvalid === false) {
      if (!validAssessment(a.assessment) || a.assessment.evidence.binding !== accountRouteBinding(a, profiles)
        || Date.parse(a.assessment.evidence.reviewedAt) > Date.now() + 86400000) throw new Error("Reviewed assessment needs complete current route evidence and a valid review date.");
    }
    if (!a.binding || a.bindingRequired || a.models?.length === 0) continue;
    const count = accountServiceCount(a, accounts, profiles);
    const old = current.providerAccounts.find(row => row.id === a.id);
    let previousCount = 0;
    try { if (old?.binding && !old.bindingRequired && old.models?.length !== 0 && (old.hostId ?? "local") === (a.hostId ?? "local") && accountServiceKey(old, current.apiProfiles) === accountServiceKey(a, profiles)) previousCount = accountServiceCount(old, current.providerAccounts, current.apiProfiles); } catch { /* Broken legacy route cannot authorize new capacity. */ }
    if (count > limit && (count > previousCount || limit < current.maxAccountsPerProviderPerHost)) throw new Error(`Account service capacity exceeds the host limit (${limit}).`);
  }
  if (limit < current.maxAccountsPerProviderPerHost) for (const a of accounts) {
    if (!a.binding || a.bindingRequired || a.models?.length === 0) continue;
    let count = 0; try { count = accountServiceCount(a, accounts, profiles); } catch { continue; }
    if (count > limit) throw new Error(`Account service capacity exceeds the host limit (${limit}).`);
  }
  const changedModels = new Set(profiles.filter(p => changedProfiles.has(p.id) && current.apiProfiles.some(old => old.id === p.id && old.defaultModel !== p.defaultModel)).map(p => p.id));
  let invalidated = false;
  const nextAccounts = accounts.map(a => {
    const before = current.providerAccounts.find(old => old.id === a.id);
    const explicitReview = changedAccounts.has(a.id) && a.assessmentInvalid === false;
    let routeChanged = false;
    try { routeChanged = !!before && accountRouteBinding(before, current.apiProfiles) !== accountRouteBinding(a, profiles); } catch { routeChanged = !!before; }
    const modelChanged = before && !same(before.models, a.models) || a.binding?.kind === "api-profile" && changedModels.has(a.binding.profileId);
    const targetChanged = changedTargets.has(a.hostId ?? "local");
    if (targetChanged && a.assessment || !explicitReview && (before?.assessmentInvalid || a.assessment && (routeChanged || modelChanged))) {
      invalidated = true;
      return { ...a, assessmentInvalid: true, ...(a.assessment === undefined && before?.assessment ? { assessment: before.assessment } : {}) };
    }
    return a;
  });
  let profilesInvalidated = false;
  const nextProfiles = profiles.map(p => {
    const before = current.apiProfiles.find(old => old.id === p.id);
    const routeChanged = before && ["baseUrl", "protocol", "secretRef", "remoteCredential", "hostId", "defaultModel"].some(key => !same(before[key as keyof ApiProfile], p[key as keyof ApiProfile]));
    if (before?.assessmentInvalid || p.assessment && (routeChanged || changedTargets.has(p.hostId ?? "local"))) {
      profilesInvalidated = true;
      return { ...p, assessmentInvalid: true, ...(p.assessment === undefined && before?.assessment ? { assessment: before.assessment } : {}) };
    }
    return p;
  });
  return { ...patch, ...(invalidated ? { providerAccounts: nextAccounts } : {}), ...(profilesInvalidated ? { apiProfiles: nextProfiles } : {}) };

}
