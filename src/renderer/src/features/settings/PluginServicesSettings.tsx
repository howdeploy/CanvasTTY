import { useEffect, useState } from "react";
import type {
  InstalledPlugin,
  LocaleId,
  PluginServiceReport,
  PluginServiceState
} from "../../../../shared/contracts";
import { t, type TranslationKey } from "../../lib/i18n";
import { pluginName } from "../../../../shared/pluginLocalizedText.ts";
import { pollWhileOpen } from "./settingsPolling";

interface PluginServicesSettingsProps {
  locale: LocaleId;
  plugins: InstalledPlugin[];
  open?: boolean;
  onSetNativeCodeTrusted(pluginId: string, trusted: boolean): Promise<void>;
  onSetDecisionsMayAllow(pluginId: string, allowed: boolean): Promise<void>;
}

/**
 * "Native code": the separate trust confirmation for plugin services. Installing a plugin never
 * runs its services; each plugin's services start only after this confirmation, and an update,
 * a module change or disabling the plugin revokes it.
 */
export function PluginServicesSettings({
  locale,
  plugins,
  open = true,
  onSetNativeCodeTrusted,
  onSetDecisionsMayAllow
}: PluginServicesSettingsProps): React.JSX.Element | null {
  const rows = plugins.filter((plugin) => plugin.manifest.services?.length);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, PluginServiceReport>>({});
  const trustedKey = rows.map((plugin) => `${plugin.manifest.id}:${plugin.nativeCodeTrusted}`).join(",");

  useEffect(() => {
    let cancelled = false;
    const stop = pollWhileOpen(open, 3_000, async () => {
      const entries = await Promise.all(rows.map(async (plugin) => (
        [plugin.manifest.id, await window.canvasTTY.plugins.serviceReport(plugin.manifest.id)] as const
      )));
      if (!cancelled) setReports(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
      stop();
    };
    // Rows are derived from plugins; the key captures what changes the report.
  }, [trustedKey, open]);

  if (rows.length === 0) return null;

  const setTrusted = async (plugin: InstalledPlugin, trusted: boolean): Promise<void> => {
    setBusy(plugin.manifest.id);
    setError(null);
    try {
      await onSetNativeCodeTrusted(plugin.manifest.id, trusted);
      setConfirming(null);
    } catch {
      setError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setBusy(null);
    }
  };

  const setMayAllow = async (plugin: InstalledPlugin, allowed: boolean): Promise<void> => {
    setBusy(plugin.manifest.id);
    setError(null);
    try {
      await onSetDecisionsMayAllow(plugin.manifest.id, allowed);
      setConfirming(null);
    } catch {
      setError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="setting-group agent-hooks plugin-services">
      <h3>{t(locale, "pluginNativeCode")}</h3>
      <p className="setting-group__description">{t(locale, "pluginNativeCodeDescription")}</p>
      <div className="agent-hooks__list">
        {rows.map((plugin) => {
          const pluginId = plugin.manifest.id;
          const trusted = plugin.nativeCodeTrusted;
          const report = reports[pluginId];
          return (
            <article className="agent-hooks__row" key={pluginId}>
              <div className="agent-hooks__row-main">
                <span className="agent-hooks__copy">
                  <strong>{pluginName(plugin.manifest, locale)}</strong>
                  <small>{t(locale, "pluginNativeCodeServices")}</small>
                </span>
                <button
                  className={`agent-hooks__toggle${trusted ? " agent-hooks__toggle--on" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked={trusted}
                  aria-label={`${t(locale, "pluginNativeCode")}: ${pluginName(plugin.manifest, locale)}`}
                  disabled={!plugin.enabled || busy !== null}
                  onClick={() => {
                    if (trusted) void setTrusted(plugin, false);
                    else setConfirming(pluginId);
                  }}
                >
                  <span aria-hidden="true" />
                  {t(locale, trusted ? "on" : "off")}
                </button>
              </div>
              <dl className="agent-hooks__meta">
                {(plugin.manifest.services ?? []).map((service) => {
                  const status = report?.services.find((candidate) => candidate.serviceId === service.id);
                  return (
                    <div key={service.id}>
                      <dt>{service.title}</dt>
                      <dd>
                        <code>{service.entry}</code>
                        {" · "}
                        {t(locale, stateKey(status?.state ?? "stopped"))}
                        {status?.lastError ? ` · ${status.lastError}` : ""}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {trusted && plugin.manifest.services?.some((service) => service.decide) && (
                <div className="agent-hooks__row-main">
                  <span className="agent-hooks__copy">
                    <strong>{t(locale, "pluginDecisionsMayAllow")}</strong>
                    <span>{t(locale, "pluginDecisionsMayAllowDescription")}</span>
                  </span>
                  <button
                    className={`agent-hooks__toggle${plugin.decisionsMayAllow ? " agent-hooks__toggle--on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={plugin.decisionsMayAllow}
                    aria-label={`${t(locale, "pluginDecisionsMayAllow")}: ${pluginName(plugin.manifest, locale)}`}
                    disabled={busy !== null}
                    onClick={() => {
                      if (plugin.decisionsMayAllow) void setMayAllow(plugin, false);
                      else setConfirming(`${pluginId}:allow`);
                    }}
                  >
                    <span aria-hidden="true" />
                    {t(locale, plugin.decisionsMayAllow ? "on" : "off")}
                  </button>
                </div>
              )}
              {confirming === `${pluginId}:allow` && (
                <div className="agent-hooks__confirm">
                  <p>{t(locale, "pluginDecisionsMayAllowConfirm")}</p>
                  <div>
                    <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                    <button
                      className="agent-hooks__trust"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void setMayAllow(plugin, true)}
                    >{t(locale, "pluginDecisionsMayAllowEnable")}</button>
                  </div>
                </div>
              )}
              {!plugin.enabled && <p className="agent-hooks__disabled">{t(locale, "pluginHookDisabledPlugin")}</p>}
              {confirming === pluginId && (
                <div className="agent-hooks__confirm">
                  <p>{t(locale, "pluginNativeCodeConfirm")}</p>
                  <div>
                    <button
                      type="button"
                      onClick={() => void window.canvasTTY.githubAuth.openUrl(plugin.sourceUrl)}
                    >{t(locale, "pluginHookReviewRepository")}</button>
                    <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                    <button
                      className="agent-hooks__trust"
                      type="button"
                      disabled={!plugin.enabled || busy !== null}
                      onClick={() => void setTrusted(plugin, true)}
                    >{t(locale, "pluginHookTrustAndEnable")}</button>
                  </div>
                </div>
              )}
              {report && report.log.length > 0 && (
                <details className="plugin-services__log">
                  <summary>{t(locale, "pluginNativeCodeLog")}</summary>
                  <pre>{report.log.slice(-60).map((entry) => (
                    `${new Date(entry.at).toLocaleTimeString()} ${entry.serviceId} ${entry.source}: ${entry.message}`
                  )).join("\n")}</pre>
                </details>
              )}
            </article>
          );
        })}
      </div>
      {error && <p className="agent-hooks__error" role="alert">{error}</p>}
    </section>
  );
}

function stateKey(state: PluginServiceState): TranslationKey {
  return ({
    stopped: "pluginServiceStopped",
    starting: "pluginServiceStarting",
    running: "pluginServiceRunning",
    backoff: "pluginServiceRestarting",
    failed: "pluginServiceFailed"
  } as const)[state];
}
