import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CanvasMaterial,
  HandoffBlock,
  HandoffDraft,
  HandoffPreview,
  LocaleId,
  MaterialFailure,
  MaterialHandoff,
  MaterialRemark,
  SessionSnapshot
} from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { useModalFocus } from "../../lib/useModalFocus";
import { PROVIDERS } from "../../lib/providers";
import { sessionStatusLabel } from "../../lib/sessionStatus";
import { HANDOFF_NOTE_LIMIT, handoffAttachesImages, handoffBlockFor, handoffDraftKey } from "../../../../shared/materials";
import {
  deliveryKey,
  handoffReasonKey,
  pasteNoteKey,
  remarkNeedsWork,
  remarksByMaterial
} from "./materialRemarksModel";

interface HandoffDialogProps {
  locale: LocaleId;
  initialRemarkIds: string[] | null;
  sessions: readonly SessionSnapshot[];
  materials: readonly CanvasMaterial[];
  remarks: readonly MaterialRemark[];
  handoffs: readonly MaterialHandoff[];
  lastSessionId: string | null;
  onClose(): void;
  onSent(handoff: MaterialHandoff): void;
  onFocusSession(session: SessionSnapshot): void;
}

type SendFailure = { reason: HandoffBlock | MaterialFailure };

export function HandoffDialog({
  locale,
  initialRemarkIds,
  sessions,
  materials,
  remarks,
  handoffs,
  lastSessionId,
  onClose,
  onSent,
  onFocusSession
}: HandoffDialogProps): React.JSX.Element | null {
  const open = initialRemarkIds !== null;
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus(dialogRef, open);
  const agents = useMemo(() => sessions.filter((session) => session.provider !== "terminal"), [sessions]);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editable, setEditable] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState("");
  const [resultsFolder, setResultsFolder] = useState<string | null>(null);
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [previewDraft, setPreviewDraft] = useState<HandoffDraft | null>(null);
  const [previewFailure, setPreviewFailure] = useState<SendFailure | null>(null);
  const [sending, setSending] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const [sendFailure, setSendFailure] = useState<SendFailure | null>(null);
  const previewRequest = useRef(0);

  useEffect(() => {
    if (!open) return;
    const eligible = agents.filter((session) => handoffBlockFor(session) === null);
    const preferred = eligible.find((session) => session.id === lastSessionId) ?? eligible[0] ?? agents[0] ?? null;
    setDraftId(crypto.randomUUID());
    setSessionId(preferred?.id ?? null);
    setSelected(new Set(initialRemarkIds.filter((id) => {
      const remark = remarks.find((candidate) => candidate.id === id);
      return remark ? remarkNeedsWork(remark) : false;
    })));
    setEditable(new Set());
    setNote("");
    setResultsFolder(null);
    setPreview(null);
    setPreviewFailure(null);
    setSending(false);
    setSentId(null);
    setSendFailure(null);
  }, [open]);

  const selectable = useMemo(() => remarks.filter((remark) => remarkNeedsWork(remark) || selected.has(remark.id)), [remarks, selected]);
  const involved = useMemo(() => {
    const ids = new Set<string>();
    for (const remark of remarks) {
      if (!selected.has(remark.id)) continue;
      ids.add(remark.target.materialId);
      if (remark.reference) ids.add(remark.reference.materialId);
    }
    return materials.filter((material) => ids.has(material.id) && material.location !== null);
  }, [materials, remarks, selected]);
  const draft = useMemo(() => sessionId ? {
    id: draftId,
    sessionId,
    remarkIds: [...selected],
    editableMaterialIds: [...editable].filter((id) => involved.some((material) => material.id === id)),
    note,
    resultsFolder
  } : null, [draftId, editable, involved, note, resultsFolder, selected, sessionId]);

  const draftKey = draft ? handoffDraftKey(draft) : null;

  useEffect(() => {
    if (sending) return;
    if (!open || sentId || !draft || draft.remarkIds.length === 0) {
      setPreview(null);
      return;
    }
    const request = ++previewRequest.current;
    const timer = window.setTimeout(() => {
      void window.canvasTTY.materials.previewHandoff(draft).then((result) => {
        if (request !== previewRequest.current) return;
        if (result.ok) {
          setPreview(result.preview);
          setPreviewDraft(draft);
          setPreviewFailure(null);
        } else {
          setPreview(null);
          setPreviewFailure({ reason: result.reason });
        }
      }, () => request === previewRequest.current && setPreviewFailure({ reason: "unavailable" }));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [draftKey, open, sentId, sending]);

  if (!open) return null;

  const sent = sentId ? handoffs.find((handoff) => handoff.id === sentId) ?? null : null;
  const recipient = sessions.find((session) => session.id === (sent?.sessionId ?? sessionId)) ?? null;
  const send = async (): Promise<void> => {
    if (!draft || sending) return;
    setSending(true);
    setSendFailure(null);
    try {
      const result = await window.canvasTTY.materials.sendHandoff(draft);
      if (result.ok) {
        setSentId(result.handoff.id);
        onSent(result.handoff);
      } else {
        setSendFailure({ reason: result.reason });
        setDraftId(crypto.randomUUID());
      }
    } catch {
      setSendFailure({ reason: "unavailable" });
      setDraftId(crypto.randomUUID());
    } finally {
      setSending(false);
    }
  };
  const toggle = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const byMaterial = [...remarksByMaterial(selectable)].map(([materialId, group]) => [materials.find((material) => material.id === materialId), group] as const);

  return (
    <div className="dialog-backdrop handoff-dialog__backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !sending) onClose();
    }}>
      <section ref={dialogRef} className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title" tabIndex={-1}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            if (!sending) onClose();
          }
        }}>
        <header className="handoff-dialog__header">
          <span className="handoff-dialog__icon"><UiIcon name="send" size={22} /></span>
          <h2 id="handoff-dialog-title">{t(locale, "handoffDialogTitle")}</h2>
          <button className="handoff-dialog__close" type="button" onClick={onClose} disabled={sending} aria-label={t(locale, "close")}>
            <UiIcon name="close" size={18} />
          </button>
        </header>
        {sent ? (
          <HandoffOutcome locale={locale} handoff={sent} recipient={recipient} onClose={onClose} onFocusSession={onFocusSession} />
        ) : (
          <div className="handoff-dialog__body">
            <div className="handoff-dialog__form" data-canvas-wheel-priority="local">
              <h3>{t(locale, "handoffRecipient")}</h3>
              {agents.length === 0 ? (
                <p className="handoff-dialog__empty">{t(locale, "handoffNoAgents")}</p>
              ) : (
                <div className="handoff-dialog__sessions" role="radiogroup" aria-label={t(locale, "handoffRecipient")}>
                  {agents.map((session) => {
                    const block = handoffBlockFor(session);
                    return (
                      <button
                        key={session.id}
                        type="button"
                        role="radio"
                        aria-checked={session.id === sessionId}
                        disabled={block !== null}
                        className={`handoff-dialog__session ${session.id === sessionId ? "handoff-dialog__session--selected" : ""}`}
                        onClick={() => setSessionId(session.id)}
                      >
                        <ProviderIcon provider={session.provider} size="small" />
                        <span>
                          <strong>{session.title}</strong>
                          <small>{block ? t(locale, handoffReasonKey(block)) : `${sessionStatusLabel(locale, session.status, session.provider)} · ${session.cwd}`}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <h3>{t(locale, "handoffRemarks")}</h3>
              {byMaterial.map(([material, group]) => (
                <div className="handoff-dialog__group" key={material?.id ?? "missing"}>
                  <span className="handoff-dialog__group-title">{material?.name ?? t(locale, "handoffMissingMaterial")}</span>
                  {group.map((remark) => (
                    <label className="handoff-dialog__check" key={remark.id}>
                      <input type="checkbox" checked={selected.has(remark.id)} onChange={() => setSelected((current) => toggle(current, remark.id))} />
                      <span><strong>#{remark.number}</strong> {remark.text}</span>
                    </label>
                  ))}
                </div>
              ))}
              {involved.length > 0 && (
                <>
                  <h3>{t(locale, "handoffWorkingFiles")}</h3>
                  {involved.map((material) => (
                    <label className="handoff-dialog__check" key={material.id}>
                      <input type="checkbox" checked={editable.has(material.id)} onChange={() => setEditable((current) => toggle(current, material.id))} />
                      <span><strong>{material.name}</strong> <small>{t(locale, "handoffMayEdit")}</small></span>
                    </label>
                  ))}
                </>
              )}
              <h3>{t(locale, "handoffResults")}</h3>
              <div className="handoff-dialog__folder">
                {resultsFolder ? (
                  <>
                    <code title={resultsFolder}>{resultsFolder}</code>
                    <button type="button" onClick={() => setResultsFolder(null)} aria-label={t(locale, "handoffClearFolder")}><UiIcon name="close" size={14} /></button>
                  </>
                ) : (
                  <button type="button" disabled={!sessionId} onClick={() => {
                    if (sessionId) void window.canvasTTY.materials.pickResultsFolder(sessionId).then(setResultsFolder);
                  }}>
                    <UiIcon name="folder-open" size={16} />{t(locale, "handoffPickFolder")}
                  </button>
                )}
              </div>
              <p className="handoff-dialog__hint">{t(locale, "handoffResultsHint")}</p>
              <h3 id="handoff-note-label">{t(locale, "handoffNote")}</h3>
              <textarea
                aria-labelledby="handoff-note-label"
                value={note}
                maxLength={HANDOFF_NOTE_LIMIT}
                rows={3}
                placeholder={t(locale, "handoffNotePlaceholder")}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <div className="handoff-dialog__preview">
              <h3>{t(locale, "handoffPreview")}</h3>
              {preview ? (
                <>
                  <pre data-canvas-wheel-priority="local" data-wheel-owner="local">{preview.text}</pre>
                  <p className="handoff-dialog__images">
                    <UiIcon name="image" size={15} />
                    {preview.images === 0
                      ? t(locale, "handoffNoImages")
                      : `${t(locale, "handoffImages")}: ${preview.images} · ${t(locale, preview.imageMode === "attach" ? "handoffImagesAttach" : "handoffImagesPaths")}`}
                  </p>
                  <p className="handoff-dialog__files">{t(locale, "handoffFiles")}: {preview.files.join(", ")}</p>
                  {preview.warnings.map((warning) => (
                    <p className="handoff-dialog__warning" key={warning}><UiIcon name="attention" size={15} />{t(locale, warningKey(warning))}</p>
                  ))}
                </>
              ) : (
                <p className="handoff-dialog__empty">
                  {previewFailure ? t(locale, handoffReasonKey(previewFailure.reason))
                    : agents.length === 0 ? t(locale, "handoffNoAgents")
                      : selected.size === 0 ? t(locale, "handoffBlockNoRemarks") : t(locale, "loading")}
                </p>
              )}
              {sendFailure && (
                <p className="handoff-dialog__error" role="alert"><UiIcon name="error" size={15} />{t(locale, handoffReasonKey(sendFailure.reason))}</p>
              )}
              <p className="handoff-dialog__honest">{t(locale, "handoffHonesty")}</p>
              <div className="handoff-dialog__actions">
                <button type="button" onClick={onClose} disabled={sending}>{t(locale, "cancel")}</button>
                <button type="button" className="handoff-dialog__send" disabled={!preview || !draft || previewDraft === null || handoffDraftKey(previewDraft) !== draftKey || sending} onClick={() => void send()}>
                  <UiIcon name="send" size={17} />{t(locale, sending ? "handoffSending" : "handoffSend")}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function HandoffOutcome({
  locale,
  handoff,
  recipient,
  onClose,
  onFocusSession
}: {
  locale: LocaleId;
  handoff: MaterialHandoff;
  recipient: SessionSnapshot | null;
  onClose(): void;
  onFocusSession(session: SessionSnapshot): void;
}): React.JSX.Element {
  const delivery = handoff.delivery;
  const tone = delivery.state === "failed" ? "error" : delivery.state === "pasted" ? "warn" : "ok";
  const time = (value: number | null): string => value === null ? "" : new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={`handoff-outcome handoff-outcome--${tone}`}>
      <strong>{t(locale, deliveryKey(delivery))}</strong>
      <p>{`${t(locale, "handoffTitle")} #${handoff.number} → ${PROVIDERS[handoff.provider]?.label ?? handoff.provider} · ${handoff.sessionTitle}`}</p>
      {delivery.imagesExpected > 0 && (
        <p>{handoffAttachesImages(handoff.provider)
          ? `${t(locale, "handoffImagesAttached")}: ${delivery.imagesAttached} / ${delivery.imagesExpected}`
          : `${t(locale, "handoffImagePaths")} ${delivery.imagesExpected}`}</p>
      )}
      {delivery.turnStartedAt !== null && <p>{`${t(locale, "deliveryTurnStarted")} · ${time(delivery.turnStartedAt)}`}</p>}
      {delivery.turnEndedAt !== null && <p>{`${t(locale, "deliveryTurnEnded")} · ${time(delivery.turnEndedAt)}`}</p>}
      {delivery.state === "pasted" && (
        <p>{t(locale, pasteNoteKey(delivery.note, recipient !== null && (recipient.exitCode !== null || recipient.status === "done" || recipient.status === "failed")))}</p>
      )}
      {delivery.stateSaved === false && <p>{t(locale, "handoffStateNotSaved")}</p>}
      {delivery.error && delivery.state === "failed" && <p>{delivery.error}</p>}
      <p className="handoff-dialog__honest">{t(locale, "handoffHonesty")}</p>
      <div className="handoff-dialog__actions">
        {recipient && (
          <button type="button" onClick={() => {
            onFocusSession(recipient);
            onClose();
          }}><UiIcon name="terminal" size={17} />{t(locale, "handoffOpenTerminal")}</button>
        )}
        <button type="button" className="handoff-dialog__send" onClick={onClose}>{t(locale, "close")}</button>
      </div>
    </div>
  );
}

function warningKey(warning: HandoffPreview["warnings"][number]): "handoffWarningResultsOutside" | "handoffWarningStatusUnknown" {
  return warning === "results-outside-workdir" ? "handoffWarningResultsOutside" : "handoffWarningStatusUnknown";
}
