import { useState } from "react";
import type {
  AppSettings,
  InstalledPlugin,
  LocaleId,
  PluginAgentHook,
  PluginAgentHookEvent
} from "../../../../shared/contracts";
import { PROVIDERS } from "../../lib/providers";
import { t, type TranslationKey } from "../../lib/i18n";
import { pluginName } from "../../../../shared/pluginLocalizedText.ts";

interface AgentHooksSettingsProps {
  settings: AppSettings;
  plugins: InstalledPlugin[];
  onChange(patch: Partial<AppSettings>): Promise<void>;
  onSetPluginHookEnabled(pluginId: string, hookId: string, enabled: boolean): Promise<void>;
}

interface PluginHookRow {
  plugin: InstalledPlugin;
  hook: PluginAgentHook;
}

export function AgentHooksSettings({
  settings,
  plugins,
  onChange,
  onSetPluginHookEnabled
}: AgentHooksSettingsProps): React.JSX.Element {
  const locale = settings.locale;
  const rows: PluginHookRow[] = plugins.flatMap((plugin) => (
    (plugin.manifest.hooks ?? []).map((hook) => ({ plugin, hook }))
  ));
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setCoreEnabled = async (enabled: boolean): Promise<void> => {
    setBusy("core");
    setError(null);
    try {
      await onChange({ agentLifecycleHooksEnabled: enabled });
    } catch {
      setError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setBusy(null);
    }
  };

  const setPluginHook = async (row: PluginHookRow, enabled: boolean): Promise<void> => {
    const key = hookKey(row.plugin.manifest.id, row.hook.id);
    setBusy(key);
    setError(null);
    try {
      await onSetPluginHookEnabled(row.plugin.manifest.id, row.hook.id, enabled);
      setConfirming(null);
    } catch {
      setError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="setting-group agent-hooks">
      <h3>{t(locale, "agentHooks")}</h3>
      <p className="setting-group__description">{t(locale, "agentHooksDescription")}</p>

      <div className="agent-hooks__core">
        <span>
          <strong>{t(locale, "canvasTTYStatusHooks")}</strong>
          <small>{t(locale, "canvasTTYStatusHooksDescription")}</small>
        </span>
        <HookToggle
          enabled={settings.agentLifecycleHooksEnabled}
          disabled={busy !== null}
          locale={locale}
          onClick={() => void setCoreEnabled(!settings.agentLifecycleHooksEnabled)}
        />
      </div>

      <div className="agent-hooks__subheading">
        <strong>{t(locale, "optionalPluginHooks")}</strong>
        <span>{t(locale, "optionalPluginHooksDescription")}</span>
      </div>
      <p className="agent-hooks__security-note" role="note">{t(locale, "pluginHookSecuritySummary")}</p>

      {rows.length === 0 ? (
        <p className="agent-hooks__empty">{t(locale, "noOptionalPluginHooks")}</p>
      ) : (
        <div className="agent-hooks__list">
          {rows.map((row) => {
            const key = hookKey(row.plugin.manifest.id, row.hook.id);
            const enabled = row.plugin.enabledHooks.includes(row.hook.id);
            const awaitingTrust = confirming === key;
            return (
              <article className="agent-hooks__row" key={key}>
                <div className="agent-hooks__row-main">
                  <span className="agent-hooks__copy">
                    <strong>{row.hook.title}</strong>
                    <small>{pluginName(row.plugin.manifest, locale)}</small>
                    {row.hook.description && <span>{row.hook.description}</span>}
                  </span>
                  <HookToggle
                    enabled={enabled}
                    disabled={!row.plugin.enabled || busy !== null}
                    locale={locale}
                    onClick={() => {
                      if (enabled) void setPluginHook(row, false);
                      else setConfirming(key);
                    }}
                  />
                </div>
                <dl className="agent-hooks__meta">
                  <div><dt>{t(locale, "pluginHookEntry")}</dt><dd><code>{row.hook.entry}</code></dd></div>
                  <div><dt>{t(locale, "pluginHookProviders")}</dt><dd>{providerLabels(row.hook)}</dd></div>
                  <div><dt>{t(locale, "pluginHookEvents")}</dt><dd>{eventLabels(locale, row.hook.events)}</dd></div>
                </dl>
                {!row.plugin.enabled && <p className="agent-hooks__disabled">{t(locale, "pluginHookDisabledPlugin")}</p>}
                {awaitingTrust && (
                  <div className="agent-hooks__confirm">
                    <p>{t(locale, "pluginHookEnableConfirm")}</p>
                    <div>
                      <button
                        type="button"
                        onClick={() => void window.canvasTTY.githubAuth.openUrl(row.plugin.sourceUrl)}
                      >{t(locale, "pluginHookReviewRepository")}</button>
                      <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                      <button
                        className="agent-hooks__trust"
                        type="button"
                        disabled={!row.plugin.enabled || busy !== null}
                        onClick={() => void setPluginHook(row, true)}
                      >{t(locale, "pluginHookTrustAndEnable")}</button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {error && <p className="agent-hooks__error" role="alert">{error}</p>}
    </section>
  );
}

function HookToggle({
  enabled,
  disabled,
  locale,
  onClick
}: {
  enabled: boolean;
  disabled: boolean;
  locale: LocaleId;
  onClick(): void;
}): React.JSX.Element {
  return (
    <button
      className={`agent-hooks__toggle${enabled ? " agent-hooks__toggle--on" : ""}`}
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true" />
      {t(locale, enabled ? "on" : "off")}
    </button>
  );
}

function hookKey(pluginId: string, hookId: string): string {
  return `${pluginId}:${hookId}`;
}

function providerLabels(hook: PluginAgentHook): string {
  return hook.providers.map((provider) => PROVIDERS[provider].label).join(" · ");
}

function eventLabels(locale: LocaleId, events: readonly PluginAgentHookEvent[]): string {
  return events.map((event) => t(locale, eventTranslationKey(event))).join(" · ");
}

function eventTranslationKey(event: PluginAgentHookEvent): TranslationKey {
  return ({
    "session-start": "pluginHookEventSessionStart",
    "prompt-submit": "pluginHookEventPromptSubmit",
    "permission-request": "pluginHookEventPermissionRequest",
    "permission-result": "pluginHookEventPermissionResult",
    "after-tool": "pluginHookEventAfterTool",
    stop: "pluginHookEventStop",
    "session-end": "pluginHookEventSessionEnd"
  } as const)[event];
}
