import type { SettingsLocation } from "../../../../shared/settingsLocation";
import { DataAccessSettings } from "./ExecutionPolicySettings";
import { useEffect, useState } from "react";
import type { AppSettings } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { ApiProfilesSettings } from "./ApiProfilesSettings";
import { ProviderAccountsSettings } from "./ProviderAccountsSettings";
import { ProviderSecretsSettings } from "./ProviderSecretsSettings";
import { SettingsViewSelector } from "./SettingsViewSelector";

export function ConnectionsSettings({ settings, active, location, onPersist }: { settings: AppSettings; active: boolean; location?: Extract<SettingsLocation, { section: "connections" }>; onPersist(patch: Partial<AppSettings>): Promise<void> }): React.JSX.Element {
  const [view, setView] = useState<"accounts" | "api" | "data">("accounts");
  const [apiVisited, setApiVisited] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  useEffect(() => { if (view === "api") setApiVisited(true); }, [view]);
  useEffect(() => { if (location) setView(location.view); }, [location]);
  return <div className="settings-section">
    <SettingsViewSelector<"accounts" | "api" | "data"> name="connections" locale={settings.locale} value={view} onChange={setView} options={[["accounts", "accounts"], ["api", "apiProfiles"], ["data", "dataAccess"]]} />
    <div id="settings-view-connections-accounts" role="tabpanel" aria-label={t(settings.locale, "accounts")} hidden={view !== "accounts"} inert={view !== "accounts" || !active}><ProviderAccountsSettings recordId={location?.view === "accounts" ? location.recordId : undefined} selectionRequest={location} settings={settings} active={active && view === "accounts"} onPersist={onPersist} onOpenApi={() => setView("api")} /></div>
    {(apiVisited || view === "api") && <div id="settings-view-connections-api" role="tabpanel" aria-label={t(settings.locale, "apiProfiles")} hidden={view !== "api"} inert={view !== "api" || !active}>
      <p className="agent-settings-hint connection-view-intro">{t(settings.locale, "apiProfilesDescription")}</p>
      <ApiProfilesSettings recordId={location?.view === "api" ? location.recordId : undefined} selectionRequest={location} settings={settings} active={active && view === "api"} onPersist={onPersist} />
      <details className="connection-assessment connection-legacy" onToggle={event => setLegacyOpen(event.currentTarget.open)}><summary>{t(settings.locale, "legacyKeys")}</summary>{active && view === "api" && legacyOpen && <ProviderSecretsSettings locale={settings.locale} onChanged={() => onPersist({})} />}</details>
    </div>}
    <div id="settings-view-connections-data" role="tabpanel" aria-label={t(settings.locale, "dataAccess")} hidden={view !== "data"} inert={view !== "data" || !active}><DataAccessSettings settings={settings} onPersist={onPersist} /></div>
  </div>;
}
