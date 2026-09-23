import { assertDelegationRoute } from '../../../../shared/delegationLaunch.ts';
import type { AgentLaunchOptions, AgentProviderId, AppSettings, DataClass, LaunchProfileId, ProviderAccount } from "../../../../shared/contracts.ts";
import { ACP_PROVIDERS, DATA_CLASSES, dataClassSatisfies, hostEffectiveMaxDataClass, providerPermittedOnHost, reasoningEffortsFor, remotePathForHost, type ReasoningEffort } from "../../../../shared/contracts.ts";
import { ACCOUNT_HOME_ENV, accountConfiguredForRuntime, accountForwardsKey, accountSupportsRuntime, validAccountBinding } from "../../../../shared/providerAccountPolicy.ts";
import { selectLaunchAccount } from "../../../../shared/launchAccountPolicy.ts";
import { accountPrivacyDecision, ambientPrivacyBlockMessage, ambientPrivacyDecision, type AmbientPrivacyNotice } from "../../../../shared/ambientPrivacy.ts";
import type { CapsuleSummary } from '../../../../shared/capsules.ts';
import { assertContextLaunchSelection, type CurrentContextInput } from '../../../../shared/contextRuntime.ts';
import type { ContextCategory } from '../../../../shared/contextProfiles.ts';

export interface LaunchDraft {
  provider: AgentProviderId; cwd: string; transport: "pty" | "acp"; profile: LaunchProfileId;
  isolation: "direct" | "worktree" | "container"; containerProfileId: string; accountId: string; model: string;
  /** Empty keeps the CLI/account default reasoning effort. */
  effort?: ReasoningEffort | "";
  /** Chosen computer for an account whose key is forwarded; other accounts stay on their bound host. */
  hostId?: string;
  containerRoute: 'fixed' | 'auto';
  allowSubagents?: boolean;
  ref: string; dataClass: DataClass | "";
  initialPrompt?: string; contextEnabled?: boolean; contextTaskId?: string; contextCategories?: ContextCategory[]; currentContext?: CurrentContextInput[];
  capsule?: { files: string[]; task: string; prepared?: CapsuleSummary; capturedInput?: string };
}
export function capsuleCaptureInput(draft: LaunchDraft, settings: AppSettings): string { return JSON.stringify([draft.cwd, draft.capsule?.files, draft.capsule?.task, draft.dataClass || settings.defaultDataClass]); }
/** A settings handoff keeps the provider active. Confirmed lastDirectory changes never reset its draft. */
export function reconcileLaunchDraft(current: LaunchDraft | null, provider: AgentProviderId | null, settings: AppSettings): LaunchDraft | null {
  if (!provider) return null;
  if (current?.provider === provider) return current;
  return { provider, allowSubagents: false, cwd: settings.lastDirectory, transport: "pty", profile: "normal", isolation: settings.requiresSandboxProfiles?.includes("normal") ? "worktree" : "direct", containerRoute: 'fixed', containerProfileId: "", accountId: "", model: "", ref: "HEAD", dataClass: "" };
}
/** A configured account replaces the CLI login, so for a fixed route the only compatible account is
 * the only valid choice. Derived for the current route, never stored, so it cannot outlive a mode change. */
export function launchAccountId(draft: LaunchDraft, settings: AppSettings): string {
  if (draft.accountId || (draft.isolation === "container" && draft.containerRoute === "auto")) return draft.accountId;
  if (!settings.providerAccounts.some(account => accountConfiguredForRuntime(account, draft.provider))) return "";
  const accounts = compatibleLaunchAccounts(draft, settings);
  return accounts.length === 1 ? accounts[0].id : "";
}
export function compatibleLaunchAccounts(draft: LaunchDraft, settings: AppSettings): ProviderAccount[] {
  return settings.providerAccounts.filter(account => {
    try {
      if (!accountSupportsRuntime(account, draft.provider, settings.apiProfiles)) return false;
      if (account.bindingRequired || !validAccountBinding(account.binding)) return false;
      if (account.binding?.kind === "cli-home" && !ACCOUNT_HOME_ENV[draft.provider]) return false;
      if (account.binding?.kind === "api-profile" && (account.hostId ?? "local") !== "local" && draft.isolation !== 'container') return false;
      if ((draft.transport === "acp" || draft.isolation === "worktree") && (account.hostId ?? "local") !== "local") return false;
      if (draft.isolation === "container") {
        if (account.binding?.kind !== "api-profile") return false;
        if (draft.containerRoute === 'auto') return settings.containerProfiles.some(p => p.commands[draft.provider] && p.hostId === (account.hostId ?? 'local'));
        const profile = settings.containerProfiles.find(p => p.id === draft.containerProfileId);
        if (!profile || (account.hostId ?? "local") !== profile.hostId) return false;
      }
      return true;
    } catch { return false; }
  });
}
/** The computer a launch runs on: a forwarded-key account may pick any saved server. */
export function launchHostId(draft: LaunchDraft, settings: AppSettings): string {
  const account = settings.providerAccounts.find(a => a.id === draft.accountId);
  if (account && accountForwardsKey(account, draft.provider, settings.apiProfiles)) {
    return draft.hostId && (draft.hostId === "local" || settings.remoteHosts.some(host => host.id === draft.hostId)) ? draft.hostId : "local";
  }
  return account?.hostId ?? "local";
}
/** Serialize explicit UI choices, using the same account eligibility function as main.
 * Main still applies canonical path classification, resource budgets and adapter checks at launch. */
export function launchOptions(input: LaunchDraft, settings: AppSettings): AgentLaunchOptions {
  const draft = { ...input, accountId: launchAccountId(input, settings) };
  const { provider, cwd, profile, transport } = draft;
  const selectedAccount = settings.providerAccounts.find(a => a.id === draft.accountId);
  assertDelegationRoute({ provider, transport, allowSubagents: draft.allowSubagents,
    hostId: launchHostId(draft, settings) === 'local' ? undefined : launchHostId(draft, settings),
    isolation: draft.isolation === 'container' ? { mode: 'container', profileId: draft.containerProfileId } : { mode: draft.isolation }
  }, selectedAccount);
  const capsule = draft.isolation === 'container' ? draft.capsule : undefined;
  const initialPrompt = !capsule && draft.initialPrompt?.trim() ? draft.initialPrompt : undefined;
  const context = settings.contextProfilesEnabled && (draft.contextEnabled ?? true)
    ? { enabled: true, ...(draft.contextTaskId ? { taskId: draft.contextTaskId } : {}), ...(draft.contextCategories ? { categories: draft.contextCategories } : {}), ...(draft.currentContext?.length ? { current: draft.currentContext } : {}) }
    : { enabled: false };
  assertContextLaunchSelection(context);
  const taskFields = { context, ...(draft.allowSubagents ? { allowSubagents: true } : {}), ...(initialPrompt !== undefined ? { initialPrompt } : {}) };
  const selectedClass = draft.dataClass || settings.defaultDataClass;
  const taskClass = initialPrompt && (selectedClass === 'D0' || selectedClass === 'D1') ? 'D2' : draft.dataClass || undefined;
  const model = draft.model.trim() || undefined;
  if (model && model.length > 100) throw new Error("Model must be at most 100 characters.");
  if (!['fixed', 'auto'].includes(draft.containerRoute)) throw new Error('Choose a supported container route.');
  if (draft.isolation === 'container' && draft.containerRoute === 'auto') {
    if (transport !== 'pty') throw new Error('Automatic container placement requires PTY.');
    if (draft.capsule) throw new Error('Selected-file capsules require a fixed local container profile.');
    if (draft.dataClass && !DATA_CLASSES.includes(draft.dataClass)) throw new Error('Task class must be D0-D3.');
    if (draft.accountId && !compatibleLaunchAccounts(draft, settings).some(a => a.id === draft.accountId)) throw new Error('Selected account needs a compatible container on its fixed server.');
    // No arbitrary first account: the main planner filters complete fixed tuples,
    // including the effective model/class, before any availability probe.
    return { provider, cwd, profile, transport, ...taskFields, containerPlacement: {}, ...(draft.accountId ? { accountId: draft.accountId } : {}), ...(model ? { model } : {}), ...(taskClass ? { dataClass: taskClass } : {}) };
  }
  if (capsule && (!capsule.prepared || capsule.capturedInput !== capsuleCaptureInput(draft, settings))) throw new Error('Prepare the selected-file capsule after editing its source, files or task.');
  if (capsule && (transport !== 'pty' || !['opencode', 'omp', 'minimax'].includes(provider))) throw new Error('Selected-file capsules require a supported API container agent.');
  const dataClass = capsule?.prepared?.dataClass ?? taskClass;
  if (dataClass && !DATA_CLASSES.includes(dataClass)) throw new Error("Task class must be D0-D3.");
  if (transport === "acp" && !ACP_PROVIDERS.includes(provider)) throw new Error("ACP is not supported by this agent.");
  // The effort control is hidden for ACP and containers, so a stale choice is dropped there.
  const effort = draft.effort && transport === "pty" && draft.isolation !== "container" ? draft.effort : undefined;
  if (effort && !reasoningEffortsFor(provider).includes(effort)) throw new Error("This agent does not support the selected reasoning effort.");
  if (!draft.accountId && settings.providerAccounts.some(account => accountConfiguredForRuntime(account, provider))) throw new Error("Choose a configured account, or repair its settings.");
  const account = draft.accountId ? selectedAccount : undefined;
  const chosenHost = launchHostId(draft, settings), forwarded = !!account && accountForwardsKey(account, provider, settings.apiProfiles);
  const hostId = chosenHost !== "local" ? chosenHost : undefined;
  if (capsule && hostId) throw new Error('Selected-file capsules currently require a local container.');
  selectLaunchAccount(settings.providerAccounts, provider, model, draft.accountId || undefined, dataClass ?? settings.defaultDataClass, { hostId, limit: settings.maxAccountsPerProviderPerHost }, settings.apiProfiles,
    draft.isolation === "container" ? undefined : { defaultDataClass: settings.defaultDataClass, initialPrompt, delegated: false });
  if (!account) {
    const privacy = ambientPrivacyDecision({ provider, dataClass: dataClass ?? settings.defaultDataClass, defaultDataClass: settings.defaultDataClass, initialPrompt, delegated: false });
    if (privacy.kind === "block") throw new Error(ambientPrivacyBlockMessage(provider, privacy.notice));
  }
  if (account && (!validAccountBinding(account.binding) || account.bindingRequired)) throw new Error("Selected account needs a supported authentication binding. Repair it in settings.");
  if (account?.binding?.kind === "cli-home" && !ACCOUNT_HOME_ENV[provider]) throw new Error("This agent has no verified account-home adapter. Choose a supported API account or another agent.");
  if (hostId && !forwarded && account?.binding?.kind === "api-profile" && draft.isolation !== "container") throw new Error("Remote API accounts require a container on their fixed server.");
  if (transport === "acp" && (hostId || draft.isolation === "container")) throw new Error("ACP requires local direct or worktree execution.");
  if (draft.isolation === "worktree" && hostId) throw new Error("Worktree execution is available only on the local computer.");
  if (settings.requiresSandboxProfiles?.includes(profile) && draft.isolation === "direct") throw new Error("This launch profile requires a worktree or container.");
  if (hostId) {
    const host = settings.remoteHosts.find(item => item.id === hostId);
    if (!host) throw new Error("Account server is missing. Repair its fixed binding in settings.");
    if (!providerPermittedOnHost(host, provider)) throw new Error("This agent is not allowed on its account server.");
    if (!dataClassSatisfies(dataClass ?? settings.defaultDataClass, hostEffectiveMaxDataClass(host))) throw new Error("The task class exceeds the server data limit.");
    if (!remotePathForHost(host, cwd)) throw new Error("Map this exact project folder on the account server before launching.");
  }
  if (draft.isolation === "container") {
    const container = settings.containerProfiles.find(item => item.id === draft.containerProfileId);
    if (!container || !container.commands[provider]) throw new Error("Choose a compatible container profile.");
    if (account?.binding?.kind !== "api-profile" || (account.hostId ?? "local") !== container.hostId) throw new Error("Choose an API account bound to the container server.");
  }
  return { provider, cwd, profile, transport, ...taskFields, ...(draft.accountId ? { accountId: draft.accountId } : {}), ...(hostId ? { hostId } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(dataClass ? { dataClass } : {}),
    isolation: draft.isolation === "container" ? { mode: "container", profileId: draft.containerProfileId, ...(capsule?.prepared ? { capsuleId: capsule.prepared.id } : {}) } : draft.isolation === "worktree" ? { mode: "worktree", ref: draft.ref.trim() || "HEAD" } : { mode: "direct" } };
}

/** Non-blocking notice for a direct launch through the CLI login or an account with only its estimate; null when nothing exceeds it. */
export function launchPrivacyNotice(options: AgentLaunchOptions | null, settings: AppSettings): AmbientPrivacyNotice | null {
  if (!options || options.provider === "terminal") return null;
  const dataClass = options.dataClass ?? settings.defaultDataClass;
  const input = { defaultDataClass: settings.defaultDataClass, initialPrompt: options.initialPrompt, delegated: false };
  const account = options.accountId ? settings.providerAccounts.find(a => a.id === options.accountId) : undefined;
  if (options.accountId && !account) return null;
  const privacy = account ? accountPrivacyDecision(account, options.provider, dataClass, input, settings.apiProfiles, options.model) : ambientPrivacyDecision({ provider: options.provider, dataClass, ...input });
  return privacy.kind === "warn" ? privacy.notice : null;
}
