import type { AgentBudgets, AppSettings, RemoteHost, SessionMetadata } from "./contracts.ts";
import { DATA_CLASSES, isValidPathPolicyPattern, remoteHostInvalidReason } from "./contracts.ts";

export const AGENT_BUDGET_MAXIMUMS: Readonly<AgentBudgets> = { maxLocalAgents: 64, maxRemoteAgentsPerHost: 64, maxChildren: 64, maxDepth: 8 };
export function agentBudgetsInvalidReason(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Agent limits must be a complete object.";
  for (const [key, max] of Object.entries(AGENT_BUDGET_MAXIMUMS)) {
    const number = (value as Record<string, unknown>)[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > max) return `${key} must be an integer from 1 to ${max}.`;
  }
  return undefined;
}
/** Validation before migration: malformed submitted rows must never disappear. */
export function assertExecutionSettingsPatch(current: AppSettings, patch: Partial<AppSettings>): void {
  if (patch.remoteHosts !== undefined) {
    if (!Array.isArray(patch.remoteHosts) || patch.remoteHosts.length > 512) throw new Error("Host catalog must contain at most 512 hosts.");
    const ids = new Set<string>();
    for (const host of patch.remoteHosts) {
      if (!host || typeof host !== "object" || typeof host.id !== "string" || ids.has(host.id)) throw new Error("Host catalog contains an invalid or duplicate identity.");
      ids.add(host.id);
      if (JSON.stringify(current.remoteHosts.find(old => old.id === host.id)) === JSON.stringify(host)) continue;
      const reason = remoteHostInvalidReason(host); if (reason) throw new Error(reason);
    }
  }
  if (patch.agentBudgets !== undefined) { const reason = agentBudgetsInvalidReason(patch.agentBudgets); if (reason) throw new Error(reason); }
  if (patch.defaultDataClass !== undefined && !DATA_CLASSES.includes(patch.defaultDataClass)) throw new Error("Default class must be D0-D3.");
  if (patch.pathPolicies !== undefined) {
    if (!Array.isArray(patch.pathPolicies) || patch.pathPolicies.length > 64) throw new Error("Path policies must contain at most 64 rows.");
    const patterns = new Set<string>();
    for (const row of patch.pathPolicies) {
      if (!row || !isValidPathPolicyPattern(row.pattern) || !DATA_CLASSES.includes(row.dataClass) || patterns.has(row.pattern)) throw new Error("Path policies require valid unique patterns and D0-D3 classes.");
      patterns.add(row.pattern);
    }
  }
}

/** Route binding v1 bytes stay stable; the settings transaction marks affected evidence stale. */
export function sshTargetIdentity(host: RemoteHost): string { return JSON.stringify([host.sshHost, host.sshUser ?? null, host.sshPort ?? null]); }
export function hostDependents(settings: AppSettings, hostId: string): string[] {
  return [...settings.providerAccounts.filter(a => a.hostId === hostId).map(a => a.label), ...settings.apiProfiles.filter(p => p.hostId === hostId).map(p => p.name), ...settings.containerProfiles.filter(p => p.hostId === hostId).map(p => p.label)];
}
export function assertUnusedHostMutation(current: AppSettings, patch: Partial<AppSettings>, sessions: readonly Pick<SessionMetadata, "hostId" | "exitCode" | "title">[]): void {
  if (!Array.isArray(patch.remoteHosts)) return;
  const removed = current.remoteHosts.filter(host => { const next = patch.remoteHosts!.find(item => item?.id === host.id); return !next || sshTargetIdentity(host) !== sshTargetIdentity(next); });
  for (const host of removed) {
    const active = sessions.filter(session => session.hostId === host.id && session.exitCode === null);
    if (active.length) throw new Error(`Server ${host.label} cannot be removed or retargeted while used by active sessions: ${active.map(session => session.title).join(", ")}.`);
  }
}
