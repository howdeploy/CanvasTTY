import type { LocaleId } from "../../../../shared/contracts";
import { t, type TranslationKey } from "../../lib/i18n";

export function SettingsViewSelector<T extends string>({ name, value, options, locale, onChange }: { name: string; value: T; options: readonly (readonly [T, TranslationKey])[]; locale: LocaleId; onChange(value: T): void }): React.JSX.Element {
  return <div className="settings-view-selector">
    <div className="settings-view-selector__tabs" role="tablist" aria-label={t(locale, "settingsView")}>{options.map(([id, label], index) => <button key={id} id={`settings-view-tab-${name}-${id}`} type="button" role="tab" tabIndex={id === value ? 0 : -1} aria-selected={id === value} aria-controls={`settings-view-${name}-${id}`} className={`agent-settings-button${id === value ? " agent-settings-button--primary" : ""}`} onClick={() => onChange(id)} onKeyDown={event => {
      const next = event.key === "ArrowRight" ? (index + 1) % options.length : event.key === "ArrowLeft" ? (index - 1 + options.length) % options.length : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : undefined;
      if (next === undefined) return; event.preventDefault(); const nextId = options[next]![0]; onChange(nextId); document.getElementById(`settings-view-tab-${name}-${nextId}`)?.focus();
    }}>{t(locale, label)}</button>)}</div>
    <label className="agent-settings-field settings-view-selector__select"><span>{t(locale, "settingsView")}</span><select value={value} onChange={event => onChange(event.target.value as T)}>{options.map(([id, label]) => <option key={id} value={id}>{t(locale, label)}</option>)}</select></label>
  </div>;
}
