import type { ApiProfile, DataHandlingAssessment, ProviderAccount } from "../../../../shared/contracts.ts";
import { accountRouteBinding } from "../../../../shared/providerAccountPolicy.ts";
function emptyAssessment(): DataHandlingAssessment {
  return { profile: { training: "unknown", retention: "unknown", thirdPartyProcessing: "unknown", contractualMode: "consumer" }, evidence: { kind: "user-attested", reviewedAt: new Date().toISOString().slice(0, 10), sources: [], note: "", binding: "", models: "*" } };
}

export interface AccountDraft { value: ProviderAccount; modelsMode: "all" | "list" | "disabled"; modelText: string; evidence: DataHandlingAssessment; origin: string; }
export function accountDraft(account: ProviderAccount, isNew = false): AccountDraft {
  return { value: structuredClone(account), modelsMode: account.models === undefined ? "all" : account.models.length ? "list" : "disabled", modelText: account.models?.join("\n") ?? "", evidence: structuredClone(account.assessment ?? emptyAssessment()), origin: isNew ? "" : JSON.stringify(account) };
}
export function draftAccount(draft: AccountDraft): ProviderAccount {
  const { models: _models, tier: _tier, ...base } = draft.value;
  return { ...base, label: base.label.trim(), ...(base.binding?.kind === "cli-home" ? { binding: { ...base.binding, directory: base.binding.directory.trim() } } : {}), ...(draft.value.tier?.trim() ? { tier: draft.value.tier.trim() } : {}),
    ...(draft.modelsMode === "all" ? {} : { models: draft.modelsMode === "disabled" ? [] : draft.modelText.split("\n").map(model => model.trim()).filter(Boolean) }) };
}
/** Only this explicit review action refreshes evidence; ordinary draftAccount
 * keeps the saved snapshot byte-for-byte, including a stale marker. */
export function reviewedDraftAccount(draft: AccountDraft, profiles: readonly ApiProfile[]): ProviderAccount {
  const account = draftAccount(draft), evidence = draft.evidence.evidence;
  return { ...account, assessmentInvalid: false, assessment: { ...draft.evidence, evidence: { ...evidence, binding: accountRouteBinding(account, profiles), sources: evidence.sources.map(source => source.trim()).filter(Boolean), models: evidence.models === "*" ? "*" : evidence.models.map(model => model.trim()).filter(Boolean), note: evidence.note?.trim() } } };
}
