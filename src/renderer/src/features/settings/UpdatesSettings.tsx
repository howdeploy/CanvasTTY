import type { LocaleId, UpdaterState } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { updaterPresentation } from "./updaterPresentation";

interface UpdatesSettingsProps {
  state: UpdaterState;
  locale: LocaleId;
  currentVersion: string;
}

/**
 * The Updates section: the whole self-update flow in one place. Status text,
 * then only the actions that are real for that state. Check and Download share
 * the main-process "check" intent on purpose (autoDownload is off, so the second
 * request for a known release is what pulls it down); Install is its own intent.
 */
export function UpdatesSettings({ state, locale, currentVersion }: UpdatesSettingsProps): React.JSX.Element {
  const view = updaterPresentation(state, locale, currentVersion);
  const requestCheck = (): void => {
    void window.canvasTTY.updater.check();
  };
  const requestInstall = (): void => {
    window.canvasTTY.updater.install();
  };

  return (
    <section className="setting-group setting-group--stacked settings-updates" aria-labelledby="settings-updates-title">
      <div className="setting-group__copy">
        <h3 id="settings-updates-title">{t(locale, "updates")}</h3>
        <p className="setting-group__description">{t(locale, "updatesDescription")}</p>
      </div>
      <div className="settings-updates__card" data-tone={view.tone} role="status" aria-live="polite">
        <span className="settings-updates__icon" aria-hidden="true">
          <UiIcon name={view.tone === "busy" ? "working" : view.tone === "ready" ? "download" : "info"} size="1.15em" />
        </span>
        <div className="settings-updates__status">
          <strong className="settings-updates__title">{view.title}</strong>
          <span className="settings-updates__detail">{view.detail}</span>
          {view.progress !== null && (
            <progress className="settings-updates__progress" value={view.progress} max={100}>{view.progress}%</progress>
          )}
        </div>
        <div className="settings-updates__actions">
          {view.actions.check !== "hidden" && (
            <button
              className="settings-updates__button"
              type="button"
              disabled={view.actions.check === "disabled"}
              onClick={requestCheck}
            >{t(locale, "checkForUpdates")}</button>
          )}
          {view.actions.download && (
            <button
              className="settings-updates__button settings-updates__button--primary"
              type="button"
              onClick={requestCheck}
            >{t(locale, "updateDownload")}</button>
          )}
          {view.actions.install && (
            <button
              className="settings-updates__button settings-updates__button--primary"
              type="button"
              onClick={requestInstall}
            >{t(locale, "updateInstall")}</button>
          )}
        </div>
      </div>
    </section>
  );
}
