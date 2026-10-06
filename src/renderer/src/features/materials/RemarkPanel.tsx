import { useEffect, useState } from "react";
import type { LocaleId, MaterialHandoff, MaterialRemark } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { PROVIDERS } from "../../lib/providers";
import { deliveryKey, remarkNeedsWork, remarkStatusClass, remarkStatusKey } from "./materialRemarksModel";

export type RemarkAction = "send" | "delete";

interface RemarkPanelProps {
  locale: LocaleId;
  remark: MaterialRemark;
  handoff: MaterialHandoff | null;
  referenceName: string | null;
  stale: boolean;
  onAction(action: RemarkAction): void;
  onClose(): void;
}

export function RemarkPanel({
  locale,
  remark,
  handoff,
  referenceName,
  stale,
  onAction,
  onClose
}: RemarkPanelProps): React.JSX.Element {
  const needsWork = remarkNeedsWork(remark);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => setConfirmingDelete(false), [remark.id, remark.status]);
  return (
    <section
      className="material-remark-panel"
      data-canvas-wheel-priority="local"
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={`#${remark.number}`}
    >
      <header>
        <span className={`material-remark-panel__number ${remarkStatusClass(remark.status)}`}>#{remark.number}</span>
        <strong>{t(locale, remarkStatusKey(remark.status))}</strong>
        {stale && <small>{t(locale, "remarkOlderVersion")}</small>}
        <button type="button" onClick={onClose} aria-label={t(locale, "close")} title={t(locale, "close")}>
          <UiIcon name="close" size="1.1em" />
        </button>
      </header>
      <p className="material-remark-panel__text">{remark.text}</p>
      {referenceName && (
        <p className="material-remark-panel__meta"><UiIcon name="crosshair" size="1em" />{t(locale, "remarkReference")}: {referenceName}</p>
      )}
      {handoff && (
        <p className="material-remark-panel__meta">
          <UiIcon name="send" size="1em" />
          {`${t(locale, "handoffTitle")} #${handoff.number} → ${PROVIDERS[handoff.provider]?.label ?? handoff.provider} · ${t(locale, deliveryKey(handoff.delivery))}`}
        </p>
      )}
      {remark.report && (
        <p className="material-remark-panel__report">
          <strong>{t(locale, "remarkAgentSays")}</strong>
          {remark.report.note ?? t(locale, "remarkAgentNoNote")}
        </p>
      )}
      <div className="material-remark-panel__actions">
        {needsWork && (
          <button type="button" className="material-remark-panel__primary" onClick={() => onAction("send")}>
            <UiIcon name="send" size="1.05em" />{t(locale, "handoffSendToAgent")}
          </button>
        )}
        {confirmingDelete ? (
          <>
            <button type="button" className="material-remark-panel__danger" onClick={() => onAction("delete")}>
              <UiIcon name="trash" size="1.05em" />{t(locale, "remarkDeleteConfirm")}
            </button>
            <button type="button" onClick={() => setConfirmingDelete(false)}>{t(locale, "cancel")}</button>
          </>
        ) : (
          <button type="button" className="material-remark-panel__danger" onClick={() => setConfirmingDelete(true)}>
            <UiIcon name="trash" size="1.05em" />{t(locale, "remarkDelete")}
          </button>
        )}
      </div>
    </section>
  );
}
