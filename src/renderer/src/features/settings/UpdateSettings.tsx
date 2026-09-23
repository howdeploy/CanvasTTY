import { useEffect, useState } from "react";
import type { LocaleId, UpdateStatus } from "../../../../shared/contracts";

export function UpdateSettings({ locale }: { locale: LocaleId }): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ type: "idle" });
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const ru = locale === "ru";

  useEffect(() => {
    let live = true;
    let eventSeen = false;
    const unsubscribe = window.canvasTTY.update.onStatus(next => {
      eventSeen = true;
      if (live) setStatus(next);
    });
    void window.canvasTTY.update.status().then(next => {
      if (live && !eventSeen) setStatus(next);
    });
    void window.canvasTTY.appVersion().then(version => { if (live) setCurrentVersion(version); });
    return () => { live = false; unsubscribe(); };
  }, []);

  const busy = status.type === "checking" || status.type === "downloading" || status.type === "installing";
  const version = status.type === "available" || status.type === "ready" ? status.version : null;
  const invoke = (action: () => Promise<void>): void => { void action().catch(() => undefined); };

  return (
    <section className="update-settings" aria-live="polite">
      <h3>{ru ? "Обновления CanvasTTY" : "CanvasTTY updates"}</h3>
      <p>{ru ? "Текущая версия" : "Current version"}: {currentVersion || "…"}</p>
      {status.type === "checking" && <p>{ru ? "Проверяем обновления…" : "Checking for updates…"}</p>}
      {status.type === "upToDate" && <p>{ru ? "Установлена последняя версия." : "You have the latest version."}</p>}
      {status.type === "available" && <>
        <p>{ru ? "Доступна версия" : "Available version"}: {version}</p>
        {status.notes && <p className="update-settings__notes">{status.notes}</p>}
      </>}
      {status.type === "downloading" && <>
        <p>{ru ? "Скачиваем…" : "Downloading…"} {status.percent !== undefined ? `${Math.round(status.percent)}%` : ""}</p>
        <progress max={100} value={status.percent} aria-label={ru ? "Прогресс загрузки" : "Download progress"} />
      </>}
      {status.type === "ready" && <p>{ru ? `Версия ${version} готова к установке.` : `Version ${version} is ready to install.`}</p>}
      {status.type === "installing" && <p>{ru ? "Устанавливаем обновление…" : "Installing update…"}</p>}
      {status.type === "error" && <p role="alert">{ru ? "Ошибка обновления" : "Update error"}: {status.message}</p>}
      <div className="update-settings__actions">
        <button type="button" disabled={busy || status.type === "ready"} onClick={() => invoke(window.canvasTTY.update.check)}>
          {ru ? "Проверить обновления" : "Check for updates"}
        </button>
        {status.type === "available" && (status.manualUrl
          ? <button type="button" onClick={() => invoke(() => window.canvasTTY.external.openUrl(status.manualUrl!))}>
              {ru ? "Открыть релиз" : "Open release"}
            </button>
          : <button type="button" onClick={() => invoke(window.canvasTTY.update.download)}>{ru ? "Скачать" : "Download"}</button>)}
        {status.type === "ready" && <button type="button" onClick={() => invoke(window.canvasTTY.update.install)}>
          {ru ? "Установить и перезапустить" : "Restart to update"}
        </button>}
      </div>
    </section>
  );
}
