import type { InstalledPlugin } from './contracts.ts';

export interface DiscoverySignal { pendingCount: number; revision: string }
export interface DiscoveryTarget { pluginId: string; serviceId: string; contributionId: string }
export interface DiscoveryNotice extends DiscoveryTarget, DiscoverySignal {}

/** Only counts and an opaque revision cross the notification bridge, never plugin copy, URLs or task data. */
export function discoverySignal(value: unknown): DiscoverySignal | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.pendingCount) && Number(row.pendingCount) >= 0 && Number(row.pendingCount) <= 512
    && typeof row.revision === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(row.revision)
    ? { pendingCount: Number(row.pendingCount), revision: row.revision } : null;
}

/** Runtime reports additionally verify that the declared service is actually running. */
export function discoveryTargets(plugins: InstalledPlugin[], enabled: boolean): DiscoveryTarget[] {
  if (!enabled) return [];
  return plugins.flatMap(plugin => {
    if (!plugin.enabled || !plugin.nativeCodeTrusted || !plugin.manifest.permissions.includes('model:route')) return [];
    const contribution = plugin.manifest.contributions.find(row => row.id === plugin.manifest.settingsContribution && row.kind === 'canvas-app');
    if (!contribution) return [];
    return (plugin.manifest.services ?? []).filter(row => row.modelRouter).map(row => ({
      pluginId: plugin.manifest.id, serviceId: row.id, contributionId: contribution.id
    }));
  }).slice(0, 16);
}

/** One stored revision per service; the next actionable transition is visible again. */
export function discoveryDismissalKey(notice: DiscoveryTarget): string {
  return `canvastty.model-discovery.dismissed:${encodeURIComponent(notice.pluginId)}:${encodeURIComponent(notice.serviceId)}`;
}
