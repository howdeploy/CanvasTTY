import type { LocaleId } from "../../../shared/contracts";
import { updateNoticeAction, type UpdateNotice as UpdateNoticeStatus, type UpdateNoticeAction } from "../lib/updateNotice";

interface UpdateNoticeProps {
  status: UpdateNoticeStatus | null;
  locale: LocaleId;
  pending: boolean;
  onOpen(): void;
  onAction(action: UpdateNoticeAction): void;
  onDismiss(): void;
}

export function UpdateNotice({ status, locale, pending, onOpen, onAction, onDismiss }: UpdateNoticeProps): React.JSX.Element | null {
  if (!status) return null;
  const ru = locale === "ru";
  const action = updateNoticeAction(status);
  const message = status.type === "downloading"
    ? (ru ? `Скачивание… ${status.percent === undefined ? "" : `${Math.round(status.percent)}%`}` : `Downloading… ${status.percent === undefined ? "" : `${Math.round(status.percent)}%`}`)
    : status.type === "ready"
      ? (ru ? `Версия ${status.version} загружена` : `Version ${status.version} downloaded`)
      : (ru ? `Доступна версия ${status.version}` : `Version ${status.version} available`);
  const actionLabel = action === "download"
    ? (ru ? "Скачать" : "Download")
    : action === "install"
      ? (ru ? "Установить" : "Install")
      : (ru ? "Релиз" : "Release");

  return (
    <aside className="update-notice" role="status" aria-live="polite">
      <div className="update-notice__copy">
        <button type="button" className="update-notice__details" onClick={onOpen} aria-label={ru ? `Открыть сведения об обновлении: ${message}` : `Open update details: ${message}`}>{message}</button>
        {status.type === "downloading" && <progress max={100} value={status.percent} aria-label={ru ? "Прогресс загрузки обновления" : "Update download progress"} />}
      </div>
      {action && <button type="button" className="update-notice__action" disabled={pending} onClick={() => onAction(action)} aria-label={action === "install" ? (ru ? "Установить обновление и перезапустить CanvasTTY" : "Install update and restart CanvasTTY") : undefined}>{actionLabel}</button>}
      {status.type !== "downloading" && <button type="button" className="update-notice__dismiss" onClick={onDismiss} aria-label={ru ? "Закрыть уведомление об обновлении" : "Dismiss update notification"}>×</button>}
    </aside>
  );
}
