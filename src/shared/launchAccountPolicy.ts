import type { ApiProfile, DataClass, ProviderAccount } from "./contracts.ts";
import { CANVAS_LAUNCHER_ITEMS, DATA_CLASSES, accountSupportsModel, dataClassSatisfies } from "./contracts.ts";
import { accountConfiguredForRuntime, accountLaunchModel, accountRouteMaxDataClass, accountServiceCount, accountSupportsRuntime, assertAccountAliases } from "./providerAccountPolicy.ts";

/** Select using all eligibility constraints together, never a model-only first match. */
export function selectLaunchAccount(accounts: readonly ProviderAccount[], provider: ProviderAccount["provider"], model: string | undefined, accountId: string | undefined, dataClass?: DataClass, binding?: { hostId?: string; forPlacement?: boolean; limit: 1 | 2 }, profiles: readonly ApiProfile[] = []): ProviderAccount | undefined {
  const configured = accounts.filter((account) => accountConfiguredForRuntime(account, provider));
  const hostKey = (account: ProviderAccount): string => account.hostId ?? "local";
  const requestedHost = binding?.hostId ?? "local";
  const eligible = (account: ProviderAccount): ProviderAccount => {
    if (!CANVAS_LAUNCHER_ITEMS.includes(account.provider) || account.provider === ("terminal" as string)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(account.id) || typeof account.label !== "string" || !account.label.trim() || account.label.length > 80
      || (account.shared !== undefined && typeof account.shared !== "boolean")
      || (account.models !== undefined && (!Array.isArray(account.models) || account.models.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 100)))
      || (account.maxDataClass !== undefined && !DATA_CLASSES.includes(account.maxDataClass))
      || (account.hostId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(account.hostId))) throw new Error("Configured provider account is invalid; repair its settings before launching.");
    if (account.bindingRequired) throw new Error(`Account ${account.id} host binding requires repair.`);
    if (binding && !binding.forPlacement && hostKey(account) !== requestedHost) throw new Error(`Account ${account.id} is bound to host ${hostKey(account)}, not ${requestedHost}.`);
    if (!accountSupportsRuntime(account, provider, profiles)) throw new Error(account.binding?.kind === "api-profile" ? `Account ${account.id} has no supported binding for ${provider}.` : `Account ${account.id} belongs to provider ${account.provider}, not ${provider}.`);
    assertAccountAliases(accounts, profiles, new Set([account.id]));
    if (!accountSupportsModel(account, accountLaunchModel(account, model, profiles))) {
      const alternatives = configured.filter((candidate) => {
        if (candidate.bindingRequired || (binding && !binding.forPlacement && hostKey(candidate) !== requestedHost)) return false;
        try { return accountSupportsRuntime(candidate, provider, profiles) && accountSupportsModel(candidate, accountLaunchModel(candidate, model, profiles))
          && (dataClass === undefined || dataClassSatisfies(dataClass, accountRouteMaxDataClass(candidate, profiles, model))); } catch { return false; }
      }).map((candidate) => candidate.label);
      throw new Error(`Account ${account.label}${account.tier ? ` (tier ${account.tier})` : ""} does not cover model ${model ?? "default"}; eligible accounts: ${alternatives.join(", ") || "none"}.`);
    }
    const cap = accountRouteMaxDataClass(account, profiles, model);
    if (dataClass !== undefined && !dataClassSatisfies(dataClass, cap)) throw new Error(`Account ${account.label} handles at most ${cap}; this task is ${dataClass}.`);
    if (binding) {
      if (binding.limit !== 1 && binding.limit !== 2) throw new Error("Invalid account capacity limit.");
      const count = accountServiceCount(account, accounts, profiles);
      if (count > binding.limit) throw new Error(`Configured ${provider} accounts on host ${hostKey(account)} exceed the account limit (${binding.limit}).`);
    }
    return account;
  };
  if (accountId !== undefined) {
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error(`Account ${accountId} is not configured.`);
    return eligible(account);
  }
  if (configured.length === 0) return undefined;
  let reason: unknown;
  let modelOnly = true;
  for (const account of configured) {
    try { return eligible(account); } catch (error) { reason ??= error; if (!(error instanceof Error) || !error.message.includes("does not cover model")) modelOnly = false; }
  }
  if (modelOnly && model !== undefined) throw new Error(`No ${provider} account covers model ${model}.`);
  throw reason ?? new Error(`No eligible ${provider} account is configured.`);
}
