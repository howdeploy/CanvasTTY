import { DATA_CLASS_RANK, dataClassSatisfies, providerMaxDataClass, type AgentProviderId, type ApiProfile, type DataClass, type ProviderAccount } from "./contracts.ts";
import { accountApiProfile, accountRouteMaxDataClass } from "./providerAccountPolicy.ts";

export interface AmbientPrivacyNotice { cap: DataClass; dataClass: DataClass }

export type AmbientPrivacyDecision =
  | { kind: "allow" }
  | { kind: "warn"; notice: AmbientPrivacyNotice }
  | { kind: "block"; notice: AmbientPrivacyNotice };

/** An ambient CLI login (no configured account) only has the provider's static,
 * conservative consumer-route estimate. A person who launches that agent directly
 * is warned when only defaults exceed it; explicit classifications (chosen class,
 * path policy, capsule, disclosed context) and automatic delegation stay enforced. */
export function ambientPrivacyDecision(input: {
  provider: AgentProviderId;
  dataClass: DataClass;
  defaultDataClass: DataClass;
  initialPrompt?: string;
  /** The conversation already holds task text (restart, restore, pre-spawn recheck). */
  taskPrompt?: boolean;
  delegated: boolean;
}): AmbientPrivacyDecision {
  const cap = providerMaxDataClass(input.provider);
  if (dataClassSatisfies(input.dataClass, cap)) return { kind: "allow" };
  const notice = { cap, dataClass: input.dataClass };
  const promptFloor: DataClass = input.initialPrompt?.trim() || input.taskPrompt ? "D2" : "D0";
  const implicit = DATA_CLASS_RANK[promptFloor] > DATA_CLASS_RANK[input.defaultDataClass] ? promptFloor : input.defaultDataClass;
  if (!input.delegated && DATA_CLASS_RANK[input.dataClass] <= DATA_CLASS_RANK[implicit]) return { kind: "warn", notice };
  return { kind: "block", notice };
}

export type PrivacyLaunchInput = Pick<Parameters<typeof ambientPrivacyDecision>[0], "defaultDataClass" | "initialPrompt" | "taskPrompt" | "delegated">;

/** A CLI-home account without a reviewed assessment signs in through the same consumer route
 * as the ambient login, so it carries only the same static estimate and follows the same rule.
 * A reviewed assessment, an API route, a shared account and the person's own limit on the
 * account are explicit choices and always block. */
export function accountPrivacyDecision(account: ProviderAccount, provider: AgentProviderId, dataClass: DataClass, input: PrivacyLaunchInput, profiles: readonly ApiProfile[] = [], model?: string): AmbientPrivacyDecision {
  const cap = accountRouteMaxDataClass(account, profiles, model);
  if (dataClassSatisfies(dataClass, cap)) return { kind: "allow" };
  const notice = { cap, dataClass };
  if (accountEstimateOnly(account, provider, dataClass, profiles, model) && ambientPrivacyDecision({ provider, dataClass, ...input }).kind === "warn") return { kind: "warn", notice };
  return { kind: "block", notice };
}

/** The account's cap for this class is only the provider's static estimate, not an explicit choice. */
export function accountEstimateOnly(account: ProviderAccount, provider: AgentProviderId, dataClass: DataClass, profiles: readonly ApiProfile[] = [], model?: string): boolean {
  return account.assessment === undefined && account.shared !== true && !accountApiProfile(account, profiles)
    && accountRouteMaxDataClass(account, profiles, model) === providerMaxDataClass(provider)
    && (account.maxDataClass === undefined || dataClassSatisfies(dataClass, account.maxDataClass));
}

export function ambientPrivacyBlockMessage(provider: AgentProviderId, notice: AmbientPrivacyNotice): string {
  return `Provider ${provider} handles at most ${notice.cap}; this task is ${notice.dataClass}. `
    + "Choose an account with a reviewed data-handling assessment, or lower the project class in Settings → Connections → Data access.";
}
