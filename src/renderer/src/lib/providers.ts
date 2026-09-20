import { PROVIDER_LABELS } from "../../../shared/contracts.ts";
import type { AgentProviderId, AppSettings, LimitProviderId, ProviderId } from "../../../shared/contracts";
import type { TranslationKey } from "./i18n";

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  limitsLabel?: string;
  dangerKey?: TranslationKey;
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  terminal: { id: "terminal", label: PROVIDER_LABELS.terminal },
  codex: { id: "codex", label: PROVIDER_LABELS.codex, dangerKey: "dangerCodex" },
  claude: { id: "claude", label: PROVIDER_LABELS.claude, dangerKey: "dangerClaude" },
  qwen: { id: "qwen", label: PROVIDER_LABELS.qwen, dangerKey: "dangerQwen" },
  kimi: { id: "kimi", label: PROVIDER_LABELS.kimi, dangerKey: "dangerKimi" },
  opencode: { id: "opencode", label: PROVIDER_LABELS.opencode, limitsLabel: "OpenCode Go", dangerKey: "dangerOpenCode" },
  hermes: { id: "hermes", label: PROVIDER_LABELS.hermes, dangerKey: "dangerHermes" },
  grok: { id: "grok", label: PROVIDER_LABELS.grok, dangerKey: "dangerGrok" },
  omp: { id: "omp", label: PROVIDER_LABELS.omp, dangerKey: "dangerOmp" },
  pi: { id: "pi", label: PROVIDER_LABELS.pi, dangerKey: "dangerPi" }
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

/** One row still reads as a dock up to this many tiles; a fuller set splits into two. */
const LAUNCHER_SINGLE_ROW_LIMIT = 6;

export function homeLauncherColumnCount(providers: readonly AgentProviderId[]): number {
  // Terminal and Browser are always present alongside the selected agents.
  const total = providers.length + 2;
  return total <= LAUNCHER_SINGLE_ROW_LIMIT ? total : Math.ceil(total / 2);
}
