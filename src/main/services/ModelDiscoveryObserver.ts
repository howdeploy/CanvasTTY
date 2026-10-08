import { discoverySignal, type DiscoverySignal } from '../../shared/modelDiscovery.ts';
import type { ProviderDirectory } from './providerDirectory.ts';
import type { ModelRouteCandidate } from './ModelRouter.ts';

interface Router { pluginId: string; serviceId: string }
interface DiscoveryTrust {
  enabled(): boolean;
  providers(): Router[];
  running(pluginId: string, serviceId: string): boolean;
}
export function acceptDiscoverySignal(trust: DiscoveryTrust, pluginId: string, serviceId: string, value: unknown): DiscoverySignal | null {
  if (!trust.enabled() || !trust.providers().some(row => row.pluginId === pluginId && row.serviceId === serviceId)
    || !trust.running(pluginId, serviceId)) return null;
  return discoverySignal(value);
}

/** Cached model names only. CLI presence/listing is not proof of account entitlement; actual routing revalidates access. */
export function discoveryCandidates(directory: ProviderDirectory): ModelRouteCandidate[] {
  const result: ModelRouteCandidate[] = [], seen = new Set<string>();
  for (const provider of directory.providers) {
    for (const model of provider.model.known ?? []) {
      if (typeof model !== 'string' || !model || model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model)) continue;
      const key = JSON.stringify([provider.id, model]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ id: `directory-${result.length}`, provider: provider.id, model,
        available: provider.installed === true && provider.available && provider.model.supported
          && provider.signIn !== 'signed_out' && provider.signIn !== 'expired' });
      if (result.length >= 512) return result;
    }
  }
  return result;
}

/** No listing commands, network refresh, account configuration or tasks originate here. */
export class ModelDiscoveryObserver {
  private active = true;
  private pending = false;
  private readonly deps: DiscoveryTrust & {
    directory(): ProviderDirectory;
    call(pluginId: string, serviceId: string, method: 'canvastty.model.observe', params: { candidates: ModelRouteCandidate[] }): Promise<unknown>;
  };
  constructor(deps: ModelDiscoveryObserver['deps']) { this.deps = deps; }
  async refresh(): Promise<void> {
    if (!this.active || this.pending || !this.deps.enabled()) return;
    const routers = this.deps.providers().filter(row => this.deps.running(row.pluginId, row.serviceId)).slice(0, 16);
    if (!routers.length) return;
    this.pending = true;
    try {
      const candidates = discoveryCandidates(this.deps.directory());
      for (const router of routers) {
        if (!this.active || !this.deps.enabled()) break;
        if (!this.deps.providers().some(row => row.pluginId === router.pluginId && row.serviceId === router.serviceId)
          || !this.deps.running(router.pluginId, router.serviceId)) continue;
        await this.deps.call(router.pluginId, router.serviceId, 'canvastty.model.observe', { candidates }).catch(() => undefined);
      }
    } finally { this.pending = false; }
  }
  dispose(): void { this.active = false; }
}
