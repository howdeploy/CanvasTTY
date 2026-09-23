import type { AgentProviderId, ApiProfile, DataClass, DataHandlingAssessment, ProviderAccount } from "./contracts.ts";
import { DATA_CLASS_RANK, providerMaxDataClass } from "./contracts.ts";
import { copyRemoteApiCredential, isProviderSecretRef, validApiProfileCredential, validRemoteApiCredential } from "./apiProfileCredentials.ts";
export { isProviderSecretRef } from "./apiProfileCredentials.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const API_RUNTIMES: readonly AgentProviderId[] = ["minimax", "opencode", "omp"];
export function canonicalApiUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 500 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error("API profile needs an explicit valid HTTPS base URL.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("API profile needs an explicit valid HTTPS base URL."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error("API base URL must use HTTPS (or literal loopback HTTP), without credentials, query or fragment.");
  return url.toString().replace(/\/$/u, "");
}
/** Subscriptions whose vendor CLI can log in from a CanvasTTY terminal on the account's computer. */
export const ACCOUNT_LOGIN_PROVIDERS: readonly AgentProviderId[] = Object.freeze(["codex", "claude"]);
/** Runtimes that read a forwarded key from their environment on a remote server. */
export const KEY_FORWARDING_RUNTIMES: readonly AgentProviderId[] = Object.freeze(["opencode"]);
/** An API key kept in this app's vault is forwarded to a saved server per launch and never stored
 * there, so such an account is not tied to one computer. Subscription logins stay on their host. */
export function accountForwardsKey(account: ProviderAccount, provider: AgentProviderId, profiles: readonly ApiProfile[] = []): boolean {
  if ((account.hostId ?? "local") !== "local" || account.binding?.kind !== "api-profile" || !KEY_FORWARDING_RUNTIMES.includes(provider)) return false;
  const profile = profiles.find((candidate) => candidate.id === (account.binding as { profileId: string }).profileId);
  return !!profile && (profile.hostId ?? "local") === "local" && isProviderSecretRef(profile.secretRef);
}
export function accountRunsOnHost(account: ProviderAccount, provider: AgentProviderId, hostId: string, profiles: readonly ApiProfile[] = []): boolean {
  return (account.hostId ?? "local") === hostId || accountForwardsKey(account, provider, profiles);
}
export function accountApiProfile(account: ProviderAccount, profiles: readonly ApiProfile[]): ApiProfile | undefined {
  if (account.binding?.kind !== "api-profile") return undefined;
  const id = account.binding.profileId;
  const profile = profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Account ${account.id} API profile is missing.`);
  canonicalApiUrl(profile.baseUrl);
  if (!validApiProfileCredential(profile)) throw new Error("API profile credential reference is invalid for its fixed host.");
  if ((profile.hostId ?? "local") !== (account.hostId ?? "local")) throw new Error("API profile and account must belong to the same host.");
  return profile;
}
/** Configured membership is separate from eligibility: a broken binding must
 * not disappear into the ambient-credentials fallback for an affected runtime. */
export function accountConfiguredForRuntime(account: ProviderAccount, runtime: AgentProviderId): boolean {
  return account.provider === runtime || (account.binding?.kind === "api-profile" && API_RUNTIMES.includes(runtime));
}
export function accountSupportsRuntime(account: ProviderAccount, runtime: AgentProviderId, profiles: readonly ApiProfile[] = []): boolean {
  if (account.binding?.kind !== "api-profile") return account.provider === runtime;
  const profile = accountApiProfile(account, profiles);
  return API_RUNTIMES.includes(runtime) && (profile?.protocol === "openai-compatible" || (profile?.protocol === "anthropic-compatible" && runtime !== "omp") || (profile?.protocol === "google" && runtime === "opencode"));
}
export function accountLaunchModel(account: ProviderAccount, model: string | undefined, profiles: readonly ApiProfile[]): string | undefined {
  return model ?? accountApiProfile(account, profiles)?.defaultModel;
}
export function accountServiceKey(account: ProviderAccount, profiles: readonly ApiProfile[]): string {
  const profile = accountApiProfile(account, profiles);
  // A backend is counted once regardless of which compatible CLI consumes it.
  return profile ? `api:${new URL(canonicalApiUrl(profile.baseUrl)).origin}` : `cli:${account.provider}`;
}
/** Count service identities on a fixed host, independently of consuming runtime. */
export function accountServiceCount(account: ProviderAccount, accounts: readonly ProviderAccount[], profiles: readonly ApiProfile[]): number {
  const service = accountServiceKey(account, profiles);
  return accounts.filter(other => {
    if (other.bindingRequired || other.models?.length === 0 || (other.hostId ?? "local") !== (account.hostId ?? "local")) return false;
    try { return accountServiceKey(other, profiles) === service; } catch { return false; }
  }).length;
}
export const ACCOUNT_HOME_ENV: Partial<Record<AgentProviderId, string>> = {
  codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR", grok: "GROK_HOME", hermes: "HERMES_HOME", kimi: "KIMI_CODE_HOME",
  pi: "PI_CODING_AGENT_DIR", omp: "PI_CODING_AGENT_DIR", minimax: "MINIMAX_DATA_DIR", devin: "XDG_DATA_HOME"
};
export function accountRouteBinding(account: ProviderAccount, profiles: readonly ApiProfile[] = []): string {
  const profile = accountApiProfile(account, profiles);
  return JSON.stringify({ version: profile?.remoteCredential ? 2 : 1, account: account.id, host: account.hostId ?? "local",
    service: accountServiceKey(account, profiles), binding: account.binding ?? null,
    ...(profile ? { profile: profile.id, endpoint: canonicalApiUrl(profile.baseUrl), protocol: profile.protocol,
      ...(profile.remoteCredential ? { remoteCredential: copyRemoteApiCredential(profile.remoteCredential) } : { secretRef: profile.secretRef }) } : { provider: account.provider }) });
}
export function validAssessment(value: unknown): value is DataHandlingAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as DataHandlingAssessment, p = a.profile, e = a.evidence;
  if (!p || !e || typeof p !== "object" || typeof e !== "object") return false;
  if (!["none", "opt-in", "opt-out", "may-train", "unknown"].includes(p.training)
    || !["zero", "bounded", "persistent", "unknown"].includes(p.retention)
    || !["yes", "no", "unknown"].includes(p.thirdPartyProcessing)
    || !["consumer", "api", "business", "enterprise", "self-hosted"].includes(p.contractualMode)) return false;
  if (!["user-attested", "provider-documentation", "organization-contract"].includes(e.kind)
    || typeof e.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(e.reviewedAt)
    || !Number.isFinite(Date.parse(e.reviewedAt)) || new Date(e.reviewedAt).toISOString().slice(0, 10) !== e.reviewedAt
    || typeof e.binding !== "string" || e.binding.length === 0 || e.binding.length > 8192
    || !Array.isArray(e.sources) || e.sources.length > 16
    || e.sources.some((s) => typeof s !== "string" || s.length > 1000 || !/^https?:\/\/[^\s]+$/u.test(s))
    || (e.note !== undefined && (typeof e.note !== "string" || e.note.length > 4000))) return false;
  if (e.kind === "provider-documentation" ? e.sources.length === 0 : e.sources.length === 0 && (!e.note || e.note.trim().length < 8)) return false;
  if (e.models !== "*" && (!Array.isArray(e.models) || e.models.length === 0 || e.models.length > 64 || e.models.some((m) => typeof m !== "string" || !m.trim() || m.length > 200))) return false;
  if (a.trustedSelfHosted !== undefined && typeof a.trustedSelfHosted !== "boolean") return false;
  return true;
}
export function copyAssessment(value: DataHandlingAssessment): DataHandlingAssessment {
  // Project an allowlist; settings must never preserve arbitrary pasted fields.
  return { profile: { training: value.profile.training, retention: value.profile.retention, thirdPartyProcessing: value.profile.thirdPartyProcessing, contractualMode: value.profile.contractualMode },
    evidence: { kind: value.evidence.kind, reviewedAt: value.evidence.reviewedAt, sources: [...value.evidence.sources], binding: value.evidence.binding, models: value.evidence.models === "*" ? "*" : [...value.evidence.models], ...(value.evidence.note !== undefined ? { note: value.evidence.note } : {}) },
    ...(value.trustedSelfHosted === true ? { trustedSelfHosted: true } : {}) };
}
export function accountRouteMaxDataClass(account: ProviderAccount, profiles: readonly ApiProfile[] = [], model?: string, now = Date.now()): DataClass {
  const profile = accountApiProfile(account, profiles);
  if (account.assessmentInvalid || !account.assessment && profile?.assessmentInvalid) throw new Error("Account data-handling assessment is invalid; review it before launching.");
  const assessment = account.assessment ?? profile?.assessment;
  let cap: DataClass = profile ? "D0" : providerMaxDataClass(account.provider);
  if (assessment !== undefined) {
    if (!validAssessment(assessment)) throw new Error("Account data-handling assessment is incomplete.");
    if (assessment.evidence.binding !== accountRouteBinding(account, profiles)) throw new Error("Data-handling assessment is stale for this account route; review it again.");
    const reviewed = Date.parse(assessment.evidence.reviewedAt);
    if (reviewed > now + 24 * 60 * 60 * 1000) throw new Error("Data-handling assessment review date cannot be in the future.");
    const effectiveModel = accountLaunchModel(account, model, profiles);
    if (assessment.evidence.models !== "*" && (!effectiveModel || !assessment.evidence.models.includes(effectiveModel))) throw new Error("Data-handling assessment does not cover the selected model.");
    const p = assessment.profile;
    cap = p.contractualMode === "self-hosted" && assessment.trustedSelfHosted === true && p.thirdPartyProcessing === "no" ? "D3"
      : p.training === "unknown" ? "D0" : p.training !== "none" ? "D1"
      : p.retention === "zero" ? "D3" : p.retention === "bounded" ? "D2" : "D0";
  }
  if (account.maxDataClass && DATA_CLASS_RANK[account.maxDataClass] < DATA_CLASS_RANK[cap]) cap = account.maxDataClass;
  if (account.shared && DATA_CLASS_RANK[cap] > 1) cap = "D1";
  return cap;
}
export function validAccountBinding(value: unknown): value is NonNullable<ProviderAccount["binding"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as NonNullable<ProviderAccount["binding"]>;
  if (b.kind === "api-profile") return typeof b.profileId === "string" && ID.test(b.profileId);
  return b.kind === "cli-home" && typeof b.directory === "string" && b.directory.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(b.directory)
    && (/^\//u.test(b.directory) || /^[A-Za-z]:[\\/]/u.test(b.directory));
}
export function assertAccountAliases(accounts: readonly ProviderAccount[], profiles: readonly ApiProfile[], relevant?: ReadonlySet<string>): void {
  const credentials = new Map<string, ProviderAccount>();
  for (const account of accounts) {
    if (account.binding === undefined) continue;
    if (!validAccountBinding(account.binding)) { if (!relevant || relevant.has(account.id)) throw new Error("Account authentication binding is invalid."); else continue; }
    // Alias detection uses references even when the other account has an
    // invalid host binding: that invalid alias must not bypass fixed affinity.
    const binding = account.binding;
    const profile = binding.kind === "api-profile" ? profiles.find((p) => p.id === binding.profileId) : undefined;
    if (binding.kind === "api-profile" && !profile && (!relevant || relevant.has(account.id))) throw new Error(`Account ${account.id} API profile is missing.`);
    const aliases = binding.kind === "api-profile" ? [`profile:${binding.profileId}`, ...(profile && isProviderSecretRef(profile.secretRef) ? [`key:${profile.secretRef}`] : []),
      ...(profile?.hostId && validRemoteApiCredential(profile.remoteCredential) ? [`remote:${profile.hostId}:${JSON.stringify(copyRemoteApiCredential(profile.remoteCredential))}`] : [])]
      : [`home:${account.provider}:${account.hostId ?? "local"}:${binding.directory.replace(/[\\/]+$/u, "")}`];
    for (const alias of aliases) {
      const other = credentials.get(alias);
      if (other && other.id !== account.id && (!relevant || relevant.has(account.id) || relevant.has(other.id))) throw new Error("Duplicate account credential binding; use one account identity across compatible runtimes.");
      credentials.set(alias, account);
    }
  }
}
