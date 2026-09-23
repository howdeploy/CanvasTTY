import { ACP_PROVIDERS, type CreateSessionRequest, type ProviderAccount } from './contracts.ts';

/** Measured local MCP adapters. This describes routing, not installed CLI or account entitlement. */
export const DELEGATION_PTY_PROVIDERS = ['claude', 'codex', 'qwen', 'opencode', 'hermes', 'kimi'] as const;
type DelegationRoute = Pick<CreateSessionRequest, 'provider' | 'role' | 'allowSubagents' | 'hostId' | 'transport' | 'isolation' | 'containerPlacement'>;
export function requestsDelegation(route: Pick<DelegationRoute, 'role' | 'allowSubagents'>): boolean {
  return route.role === 'orchestrator' || route.allowSubagents === true;
}
export function assertDelegationRoute(route: DelegationRoute, account?: ProviderAccount): void {
  if (!requestsDelegation(route)) return;
  if (route.hostId !== undefined || route.containerPlacement !== undefined || route.isolation?.mode === 'container') throw new Error('Delegation requires local direct or worktree execution. Remote and container parents are unsupported.');
  if (route.transport === 'acp') {
    if (!ACP_PROVIDERS.includes(route.provider as typeof ACP_PROVIDERS[number])) throw new Error('Delegation has no ACP adapter for this agent.');
  } else {
    if (!(DELEGATION_PTY_PROVIDERS as readonly string[]).includes(route.provider)) throw new Error('Delegation has no verified native MCP adapter for this agent.');
    if (account?.binding?.kind === 'cli-home' && ['kimi', 'hermes', 'grok'].includes(route.provider)) throw new Error('Delegation is unavailable for this custom account home in PTY. Use a supported ACP route or another agent.');
  }
}
