import type { AgentProviderId, AppSettings } from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { homeLauncherColumnCount, PROVIDERS, resolveHomeLauncherProviders } from "../../lib/providers";
export default function HomeLauncherDock({ settings, onOpenTerminal, onOpenAgent, onOpenBrowser, onOpenExplorer }: {
  settings: AppSettings; onOpenTerminal(): void; onOpenAgent(provider: AgentProviderId): void; onOpenBrowser(): void; onOpenExplorer(): void;
}): React.JSX.Element {
  const locale = settings.locale, launcherProviders = resolveHomeLauncherProviders(settings);
  return (
        <section
          className="tile launcher-dock"
          style={{ "--launcher-columns": homeLauncherColumnCount(launcherProviders) } as React.CSSProperties}
        >
          <button className="launcher-button launcher-button--terminal" type="button" onClick={() => onOpenTerminal()} title={t(locale, "terminal")}>
            <ProviderIcon provider="terminal" size="large" /><span>{t(locale, "terminal")}</span>
          </button>
          {launcherProviders.map((provider) => (
            <button className="launcher-button" type="button" key={provider} onClick={() => onOpenAgent(provider)} title={PROVIDERS[provider].label}>
              <ProviderIcon provider={provider} size="large" /><span>{PROVIDERS[provider].label}</span>
            </button>
          ))}
          <button
            className="launcher-button launcher-button--browser"
            type="button"
            onClick={onOpenBrowser}
            title={t(locale, "browser")}
            aria-label={t(locale, "browser")}
          >
            <UiIcon name="browser" size="3.23em" /><span>{t(locale, "browser")}</span>
          </button>
          <button className="launcher-button launcher-button--files" type="button" onClick={onOpenExplorer}
            title={locale === "ru" ? "Файлы — проводник и предпросмотр" : "Files — explorer and previews"}
            aria-label={locale === "ru" ? "Открыть проводник" : "Open file explorer"}>
            <UiIcon name="folder-open" size="3.23em" /><span>{locale === "ru" ? "Файлы" : "Files"}</span>
          </button>
        </section>
  );
}
