import { PROVIDER_LABELS } from "../../../shared/contracts.ts";
import type { AgentProviderId, AppSettings, LimitProviderId, ProviderId } from "../../../shared/contracts";
import type { TranslationKey } from "./i18n";

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  limitsLabel?: string;
  dangerKey?: TranslationKey;
  installUrl?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  terminal: { id: "terminal", label: PROVIDER_LABELS.terminal },
  codex: { id: "codex", label: PROVIDER_LABELS.codex, dangerKey: "dangerCodex", installUrl: "https://learn.chatgpt.com/docs/codex/cli" },
  claude: { id: "claude", label: PROVIDER_LABELS.claude, dangerKey: "dangerClaude", installUrl: "https://code.claude.com/docs/en/setup" },
  qwen: { id: "qwen", label: PROVIDER_LABELS.qwen, dangerKey: "dangerQwen", installUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/" },
  kimi: { id: "kimi", label: PROVIDER_LABELS.kimi, dangerKey: "dangerKimi", installUrl: "https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started" },
  opencode: { id: "opencode", label: PROVIDER_LABELS.opencode, limitsLabel: "OpenCode Go", dangerKey: "dangerOpenCode", installUrl: "https://opencode.ai/en/docs" },
  hermes: { id: "hermes", label: PROVIDER_LABELS.hermes, dangerKey: "dangerHermes", installUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/installation" },
  grok: { id: "grok", label: PROVIDER_LABELS.grok, dangerKey: "dangerGrok", installUrl: "https://docs.x.ai/build/overview" },
  omp: { id: "omp", label: PROVIDER_LABELS.omp, dangerKey: "dangerOmp", installUrl: "https://github.com/can1357/oh-my-pi" },
  pi: { id: "pi", label: PROVIDER_LABELS.pi, dangerKey: "dangerPi", installUrl: "https://pi.dev/docs/latest" },
  cursor: { id: "cursor", label: PROVIDER_LABELS.cursor, dangerKey: "dangerCursor", installUrl: "https://cursor.com/docs/cli/installation" },
  minimax: { id: "minimax", label: PROVIDER_LABELS.minimax, dangerKey: "dangerMinimax", installUrl: "https://github.com/MiniMax-AI/minimax-code/blob/main/docs/installation.md" },
  devin: { id: "devin", label: PROVIDER_LABELS.devin, dangerKey: "dangerDevin", installUrl: "https://docs.devin.ai/cli" },
  antigravity: { id: "antigravity", label: PROVIDER_LABELS.antigravity, dangerKey: "dangerAntigravity", installUrl: "https://antigravity.google/docs/cli/install/" }
};

export const AGENT_PROVIDERS: AgentProviderId[] = ["codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi", "cursor", "minimax", "devin", "antigravity"];
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
