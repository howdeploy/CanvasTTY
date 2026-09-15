import type { AgentProviderId, AppSettings, LimitProviderId, ProviderId } from "../../../shared/contracts";
import type { TranslationKey } from "./i18n";

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  limitsLabel?: string;
  dangerKey?: TranslationKey;
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  terminal: { id: "terminal", label: "Terminal" },
  codex: { id: "codex", label: "Codex", dangerKey: "dangerCodex" },
  claude: { id: "claude", label: "Claude", dangerKey: "dangerClaude" },
  qwen: { id: "qwen", label: "Qwen Code", dangerKey: "dangerQwen" },
  kimi: { id: "kimi", label: "Kimi", dangerKey: "dangerKimi" },
  opencode: { id: "opencode", label: "OpenCode", limitsLabel: "OpenCode Go", dangerKey: "dangerOpenCode" },
  hermes: { id: "hermes", label: "Hermes", dangerKey: "dangerHermes" },
  grok: { id: "grok", label: "Grok Build", dangerKey: "dangerGrok" },
  omp: { id: "omp", label: "OMP", dangerKey: "dangerOmp" },
  pi: { id: "pi", label: "Pi", dangerKey: "dangerPi" }
};

export const AGENT_PROVIDERS: AgentProviderId[] = ["codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi"];
export const LIMIT_PROVIDERS: LimitProviderId[] = ["codex", "claude", "qwen", "kimi", "opencode", "grok"];

export function resolveHomeLauncherProviders(
  settings: Pick<Partial<AppSettings>, "homeLauncherProviders">
): AgentProviderId[] {
  if (!Array.isArray(settings.homeLauncherProviders)) return [...AGENT_PROVIDERS];
  const selected = new Set(settings.homeLauncherProviders);
  return AGENT_PROVIDERS.filter((provider) => selected.has(provider));
}

export function setHomeLauncherProviderEnabled(
  current: readonly AgentProviderId[],
  provider: AgentProviderId,
  enabled: boolean
): AgentProviderId[] {
  const selected = new Set(current);
  if (enabled) selected.add(provider);
  else selected.delete(provider);
  return AGENT_PROVIDERS.filter((candidate) => selected.has(candidate));
}

export function resolveHomeLimitProviders(
  settings: Pick<Partial<AppSettings>, "homeLimitProviders">
): LimitProviderId[] {
  if (!Array.isArray(settings.homeLimitProviders)) return [...LIMIT_PROVIDERS];
  const selected = new Set(settings.homeLimitProviders);
  return LIMIT_PROVIDERS.filter((provider) => selected.has(provider));
}

export function setHomeLimitProviderEnabled(
  current: readonly LimitProviderId[],
  provider: LimitProviderId,
  enabled: boolean
): LimitProviderId[] {
  const selected = new Set(current);
  if (enabled) selected.add(provider);
  else selected.delete(provider);
  return LIMIT_PROVIDERS.filter((candidate) => selected.has(candidate));
}

export function homeLauncherColumnCount(providers: readonly AgentProviderId[]): number {
  return providers.length + 2;
}
