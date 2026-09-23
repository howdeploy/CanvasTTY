import { assertDelegationRoute } from '../../../../shared/delegationLaunch.ts';
import type { AgentLaunchOptions, AgentProviderId, AppSettings, DataClass, LaunchProfileId, ProviderAccount } from "../../../../shared/contracts.ts";
import { ACP_PROVIDERS, DATA_CLASSES, dataClassSatisfies, hostEffectiveMaxDataClass, providerPermittedOnHost, providerMaxDataClass, remotePathForHost } from "../../../../shared/contracts.ts";
import { ACCOUNT_HOME_ENV, accountConfiguredForRuntime, accountSupportsRuntime, validAccountBinding } from "../../../../shared/providerAccountPolicy.ts";
import { selectLaunchAccount } from "../../../../shared/launchAccountPolicy.ts";
import type { CapsuleSummary } from '../../../../shared/capsules.ts';
import { assertContextLaunchSelection, type CurrentContextInput } from '../../../../shared/contextRuntime.ts';
import type { ContextCategory } from '../../../../shared/contextProfiles.ts';

export interface LaunchDraft {
  provider: AgentProviderId; cwd: string; transport: "pty" | "acp"; profile: LaunchProfileId;
  isolation: "direct" | "worktree" | "container"; containerProfileId: string; accountId: string; model: string;
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
/** Serialize explicit UI choices, using the same account eligibility function as main.
 * Main still applies canonical path classification, resource budgets and adapter checks at launch. */
export function launchOptions(draft: LaunchDraft, settings: AppSettings): AgentLaunchOptions {
  const { provider, cwd, profile, transport } = draft;
  const selectedAccount = settings.providerAccounts.find(a => a.id === draft.accountId);
  assertDelegationRoute({ provider, transport, allowSubagents: draft.allowSubagents,
    hostId: selectedAccount?.hostId === 'local' ? undefined : selectedAccount?.hostId,
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
  if (!draft.accountId && settings.providerAccounts.some(account => accountConfiguredForRuntime(account, provider))) throw new Error("Choose a configured account, or repair its settings.");
  const account = draft.accountId ? selectedAccount : undefined;
  const hostId = account?.hostId && account.hostId !== "local" ? account.hostId : undefined;
  if (capsule && hostId) throw new Error('Selected-file capsules currently require a local container.');
  selectLaunchAccount(settings.providerAccounts, provider, model, draft.accountId || undefined, dataClass ?? settings.defaultDataClass, { hostId, limit: settings.maxAccountsPerProviderPerHost }, settings.apiProfiles);
  if (!account && !dataClassSatisfies(dataClass ?? settings.defaultDataClass, providerMaxDataClass(provider))) throw new Error(`Provider ${provider} handles at most ${providerMaxDataClass(provider)}; this task is ${dataClass ?? settings.defaultDataClass}.`);
  if (account && (!validAccountBinding(account.binding) || account.bindingRequired)) throw new Error("Selected account needs a supported authentication binding. Repair it in settings.");
  if (account?.binding?.kind === "cli-home" && !ACCOUNT_HOME_ENV[provider]) throw new Error("This agent has no verified account-home adapter. Choose a supported API account or another agent.");
  if (hostId && account?.binding?.kind === "api-profile" && draft.isolation !== "container") throw new Error("Remote API accounts require a container on their fixed server.");
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
  return { provider, cwd, profile, transport, ...taskFields, ...(draft.accountId ? { accountId: draft.accountId } : {}), ...(hostId ? { hostId } : {}), ...(model ? { model } : {}), ...(dataClass ? { dataClass } : {}),
    isolation: draft.isolation === "container" ? { mode: "container", profileId: draft.containerProfileId, ...(capsule?.prepared ? { capsuleId: capsule.prepared.id } : {}) } : draft.isolation === "worktree" ? { mode: "worktree", ref: draft.ref.trim() || "HEAD" } : { mode: "direct" } };
}
