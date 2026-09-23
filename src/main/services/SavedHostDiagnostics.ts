import type { RemoteHost, SavedHostDiagnosticSnapshot } from "../../shared/contracts.ts";
import { CANVAS_LAUNCHER_ITEMS, isValidRemoteHost, providerPermittedOnHost } from "../../shared/contracts.ts";
import type { RemoteProviderDiscovery } from "./RemoteProviderDiscovery.ts";
import type { RemoteProviderAccess } from "./RemoteProviderAccess.ts";
import type { RemoteHostMetricsService } from "./RemoteHostMetrics.ts";
import { remoteProbeKey } from "./RemoteProbeCache.ts";

/** A renderer can request one saved identity, never supply an SSH descriptor. */
export class SavedHostDiagnostics {
  private readonly hosts: () => readonly RemoteHost[];
  private readonly discovery: RemoteProviderDiscovery;
  private readonly access: RemoteProviderAccess;
  private readonly metrics: RemoteHostMetricsService;
  constructor(hosts: () => readonly RemoteHost[], discovery: RemoteProviderDiscovery, access: RemoteProviderAccess, metrics: RemoteHostMetricsService) {
    this.hosts = hosts; this.discovery = discovery; this.access = access; this.metrics = metrics;
  }
  async inspect(id: unknown): Promise<SavedHostDiagnosticSnapshot> {
    if (typeof id !== "string" || !id || id.length > 64) throw new Error("A saved host id is required.");
    const host = this.hosts().find(item => item.id === id);
    if (!host || !isValidRemoteHost(host)) throw new Error("Choose a valid saved host.");
    const identity = remoteProbeKey(host);
    const providers = CANVAS_LAUNCHER_ITEMS.filter(item => item !== "terminal").filter(provider => providerPermittedOnHost(host, provider));
    const [discovery, access, metrics] = await Promise.all([this.discovery.discover(host, undefined, providers), this.access.probe(host, undefined, providers), this.metrics.collect(host)]);
    const current = this.hosts().find(item => item.id === id);
    if (!current || remoteProbeKey(current) !== identity) throw new Error("Saved host changed during inspection. Check it again.");
    return { hostId: id, discovery, access, metrics };
  }
}
