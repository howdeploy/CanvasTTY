import { discoverySignal, type DiscoveryNotice, type DiscoveryTarget } from '../../../shared/modelDiscovery.ts';
import type { PluginServiceReport } from '../../../shared/contracts.ts';

interface NoticeIO {
  report(pluginId: string): Promise<Pick<PluginServiceReport, 'services'>>;
  request(pluginId: string, serviceId: string, method: string, params: unknown): Promise<unknown>;
  changed(notices: DiscoveryNotice[]): void;
}
/** An effect owns one controller. Disposal invalidates every in-flight result on opt-out, trust changes or unmount. */
export class DiscoveryNoticeController {
  private disposed = false;
  private pending = false;
  private again = false;
  private previous = '[]';
  private readonly targets: DiscoveryTarget[];
  private readonly io: NoticeIO;
  constructor(targets: DiscoveryTarget[], io: NoticeIO) { this.targets = targets; this.io = io; }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.pending) { this.again = true; return; }
    this.pending = true;
    try {
      const notices: DiscoveryNotice[] = [];
      for (const target of this.targets) {
        if (this.disposed) return;
        try {
          const running = async (): Promise<boolean> => (await this.io.report(target.pluginId)).services
            .some(row => row.serviceId === target.serviceId && row.state === 'running');
          if (!await running() || this.disposed) continue;
          const reply = await this.io.request(target.pluginId, target.serviceId, 'discoveryList', {});
          const signal = discoverySignal(reply);
          if (!this.disposed && signal && signal.pendingCount > 0 && (reply as { enabled?: unknown }).enabled === true && await running()) notices.push({ ...target, ...signal });
        } catch { /* Disconnected, stopped or older services cannot leave an actionable stale notice. */ }
      }
      const encoded = JSON.stringify(notices);
      if (!this.disposed && encoded !== this.previous) { this.previous = encoded; this.io.changed(notices); }
    } finally {
      this.pending = false;
      if (this.again && !this.disposed) { this.again = false; void this.refresh(); }
    }
  }
  dispose(): void { this.disposed = true; }
}
