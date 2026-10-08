import { useEffect, useState } from 'react';
import type { InstalledPlugin, LocaleId, PluginCanvasAppContribution } from '../../../shared/contracts';
import { discoveryDismissalKey, discoveryTargets, type DiscoveryNotice, type DiscoveryTarget } from '../../../shared/modelDiscovery';
import { DiscoveryNoticeController } from '../lib/modelDiscoveryNotice';

interface Props {
  plugins: InstalledPlugin[];
  enabled: boolean;
  locale: LocaleId;
  onReview(plugin: InstalledPlugin, contribution: PluginCanvasAppContribution): Promise<void>;
  onError(message: string): void;
}

export function ModelDiscoveryNotice({ plugins, enabled, locale, onReview, onError }: Props): React.JSX.Element | null {
  const targets = discoveryTargets(plugins, enabled);
  const targetKey = JSON.stringify(targets);
  const [notices, setNotices] = useState<DiscoveryNotice[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setNotices([]);
    const current: DiscoveryTarget[] = JSON.parse(targetKey);
    if (!current.length) return;
    const controller = new DiscoveryNoticeController(current, {
      report: id => window.canvasTTY.plugins.serviceReport(id),
      request: (id, service, method, params) => window.canvasTTY.plugins.serviceRequest(id, service, method, params),
      changed: setNotices
    });
    const off = window.canvasTTY.plugins.onServiceEvent(event => {
      if (event.event === 'model.discovery' && current.some(row => row.pluginId === event.pluginId && row.serviceId === event.serviceId)) void controller.refresh();
    });
    void controller.refresh();
    // Local RPC only: also recovers events dropped while this window or a service was restarting.
    const timer = setInterval(() => void controller.refresh(), 15_000);
    return () => { controller.dispose(); off(); clearInterval(timer); };
  }, [targetKey]);

  const notice = notices.find(row => {
    if (!targets.some(target => target.pluginId === row.pluginId && target.serviceId === row.serviceId)) return false;
    const key = discoveryDismissalKey(row);
    let revision: string | undefined = dismissed[key];
    try { revision ??= localStorage.getItem(key) ?? undefined; } catch { /* In-memory dismissal still works. */ }
    return revision !== row.revision;
  });
  if (!notice) return null;
  const plugin = plugins.find(row => row.manifest.id === notice.pluginId)!;
  const contribution = plugin.manifest.contributions.find(row => row.id === notice.contributionId && row.kind === 'canvas-app') as PluginCanvasAppContribution;
  const ru = locale === 'ru';
  const dismiss = (): void => {
    const key = discoveryDismissalKey(notice);
    setDismissed(previous => ({ ...previous, [key]: notice.revision }));
    try { localStorage.setItem(key, notice.revision); } catch { /* A storage failure must not block dismissal. */ }
  };
  return <aside className="model-discovery-notice" role="status" aria-live="polite">
    <div className="model-discovery-notice__copy">
      <strong>{ru ? 'Новые модели: нужно ваше решение' : 'New models need your decision'}</strong>
      <span>{plugin.manifest.name} · {ru ? `Ожидают решения: ${notice.pendingCount}` : `${notice.pendingCount} awaiting review`}</span>
    </div>
    <button type="button" className="update-notice__action" disabled={busy} onClick={() => {
      setBusy(true);
      void onReview(plugin, contribution).catch(() => onError(ru ? 'Не удалось открыть настройки плагина' : 'Could not open plugin settings')).finally(() => setBusy(false));
    }}>{ru ? 'Рассмотреть' : 'Review'}</button>
    <button type="button" className="update-notice__dismiss" onClick={dismiss} aria-label={ru ? 'Скрыть уведомление о новых моделях' : 'Dismiss new model notification'}>×</button>
  </aside>;
}
