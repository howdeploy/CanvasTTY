import { useEffect, useRef, useState } from "react";
import type { CheckpointEntry, CheckpointErrorCode, LocaleId } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { focusCardOptions } from "./cardDialogFocus";
import { checkpointsText, type CheckpointsText } from "./checkpointsText";

export interface CheckpointsDialogProps {
  sessionId: string;
  /** The card's title or folder, shown under the dialog title. */
  cardTitle: string;
  locale: LocaleId;
  onClose(): void;
}

type TextKey = { [Key in keyof CheckpointsText]: CheckpointsText[Key] extends string ? Key : never }[keyof CheckpointsText];

const ERROR_TEXT: Record<CheckpointErrorCode, TextKey> = {
  "not-git-root": "errorNotGitRoot",
  "unknown-checkpoint": "errorUnknown",
  submodules: "errorSubmodules",
  filters: "errorFilters",
  "worktree-conflict": "errorWorktreeConflict",
  "no-safety-point": "errorNoSafetyPoint",
  "restore-in-progress": "errorRestoreInProgress",
  "agent-running": "errorAgentRunning",
  "pending-launch": "errorPendingLaunch",
  "isolated-environment": "errorIsolatedEnvironment",
  "missing-session": "errorMissingSession",
  failed: "errorFailed"
};

type Preview = { text: string; changedFiles: string[]; truncated: boolean };

/** Diff lines rendered at first, and added by each "Show more" (a preview can be 2 MiB: tens of thousands of lines). */
const DIFF_LINES_STEP = 2000;
/** File names listed at most. */
const MAX_FILES_SHOWN = 500;
// Bidirectional formatting controls can make a shown diff or file name read differently from what it is.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** A call that failed outright: the person sees the localized generic refusal, the details go to the log. */
function failedCall(error: unknown): { ok: false; code: "failed" } {
  console.error("Rollback points request failed", error);
  return { ok: false, code: "failed" };
}

/**
 * A card's rollback points (docs/agent-orchestration.md): rendered by App inside the themed tree as a native modal
 * dialog. Restoring needs an inline confirmation; main-process refusals arrive as codes and are localized here.
 */
export function CheckpointsDialog({ sessionId, cardTitle, locale, onClose }: CheckpointsDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mountedRef = useRef(true);
  const previewRequestRef = useRef(0);
  const [entries, setEntries] = useState<CheckpointEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<CheckpointErrorCode | null>(null);
  const [restored, setRestored] = useState(false);
  // Bumped after a restore: the files changed, so the selected point's preview is read again.
  const [previewNonce, setPreviewNonce] = useState(0);
  const [shownLines, setShownLines] = useState(DIFF_LINES_STEP);
  const text = checkpointsText(locale);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });

  const load = async (): Promise<void> => {
    const result = await window.canvasTTY.terminal.checkpoints(sessionId).catch(failedCall);
    if (!mountedRef.current) return;
    if (!result.ok) {
      setEntries([]);
      setError(result.code);
      return;
    }
    setEntries(result.checkpoints);
    setSelectedId((current) => result.checkpoints.some((entry) => entry.id === current) ? current : result.checkpoints[0]?.id ?? null);
  };

  useEffect(() => {
    mountedRef.current = true;
    const element = dialogRef.current;
    if (element && !element.open) element.showModal();
    void load();
    return () => {
      mountedRef.current = false;
      element?.close();
    };
  }, [sessionId]);

  useEffect(() => {
    setPreview(null);
    setConfirming(false);
    if (!selectedId) return;
    const request = ++previewRequestRef.current;
    setPreviewLoading(true);
    void window.canvasTTY.terminal.previewCheckpoint(sessionId, selectedId)
      .catch(failedCall)
      .then((result) => {
        if (!mountedRef.current || request !== previewRequestRef.current) return;
        setPreviewLoading(false);
        setShownLines(DIFF_LINES_STEP);
        if (result.ok) {
          setPreview({ text: result.text.replace(BIDI_CONTROLS, ""), changedFiles: result.changedFiles.map((path) => path.replace(BIDI_CONTROLS, "")),
            truncated: result.truncated });
        }
        else setError(result.code);
      });
  }, [sessionId, selectedId, previewNonce]);

  const restore = async (): Promise<void> => {
    if (!selectedId || restoring) return;
    setRestoring(true);
    setError(null);
    setRestored(false);
    const result = await window.canvasTTY.terminal.restoreCheckpoint(sessionId, selectedId)
      .catch(failedCall);
    if (!mountedRef.current) return;
    setRestoring(false);
    setConfirming(false);
    if (result.ok) {
      setRestored(true);
      await load();
      if (mountedRef.current) setPreviewNonce((nonce) => nonce + 1);
    } else setError(result.code);
  };

  // Escape and the backdrop step back from the confirmation first; nothing closes while files are restored.
  const dismiss = (): void => {
    if (restoring) return;
    if (confirming) setConfirming(false);
    else onClose();
  };

  const selected = entries?.find((entry) => entry.id === selectedId) ?? null;
  const diff = preview?.text ? diffLines(preview.text, shownLines) : null;

  return (
    <dialog ref={dialogRef} className="card-dialog checkpoints-dialog" aria-labelledby="checkpoints-dialog-title"
      data-interactive="true" data-canvas-wheel-priority="local"
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      // Chromium closes a modal dialog anyway on a second Escape without a click in between (its cancel event is then not
      // cancelable): during a restore it is shown again, otherwise that close is the person's.
      onClose={(event) => { if (restoring) event.currentTarget.showModal(); else onClose(); }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <div className="card-dialog__panel">
        <header className="card-dialog__header">
          <div>
            <h2 id="checkpoints-dialog-title">{text.title}</h2>
            <p title={cardTitle}>{cardTitle}</p>
          </div>
          <button type="button" className="card-dialog__icon-button" disabled={restoring} onClick={onClose}
            aria-label={t(locale, "close")} title={t(locale, "close")}>
            <UiIcon name="close" size="1.35em" />
          </button>
        </header>

        {entries === null && (
          <p className="checkpoints-dialog__status" role="status">
            <UiIcon name="working" size="1.1em" /><span>{text.loading}</span>
          </p>
        )}
        {entries !== null && entries.length === 0 && !error && (
          <div className="checkpoints-dialog__empty">
            <strong>{text.empty}</strong>
            <p>{text.emptyDetail}</p>
          </div>
        )}
        {entries !== null && entries.length > 0 && (
          <div className="checkpoints-dialog__body">
            <ol className="checkpoints-dialog__list" aria-label={text.title}>
              {entries.map((entry) => {
                const active = entry.id === selectedId;
                return (
                  <li key={entry.id}>
                    <button type="button" aria-current={active ? "true" : undefined} disabled={restoring}
                      className={`checkpoints-dialog__entry${active ? " checkpoints-dialog__entry--active" : ""}`}
                      onClick={() => { setError(null); setRestored(false); setSelectedId(entry.id); }}>
                      <strong>{time.format(entry.at)}</strong>
                      <span>{text[entry.kind === "before-restore" ? "kindBeforeRestore" : "kindBeforeTurn"]}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <section className="checkpoints-dialog__preview" aria-label={selected ? time.format(selected.at) : text.title}>
              {previewLoading && (
                <p className="checkpoints-dialog__status" role="status">
                  <UiIcon name="working" size="1.1em" /><span>{text.loading}</span>
                </p>
              )}
              {preview && <>
                <h3>{text.changedFiles}</h3>
                {preview.changedFiles.length === 0
                  ? <p className="card-dialog__muted">{text.noChanges}</p>
                  : (
                    <ul className="checkpoints-dialog__files">
                      {preview.changedFiles.slice(0, MAX_FILES_SHOWN).map((path) => (
                        <li key={path}><UiIcon name="file" size="1.05em" /><code>{path}</code></li>
                      ))}
                      {preview.changedFiles.length > MAX_FILES_SHOWN && (
                        <li className="card-dialog__muted">{text.moreFiles(preview.changedFiles.length - MAX_FILES_SHOWN)}</li>
                      )}
                    </ul>
                  )}
                {diff && <>
                  <p className="card-dialog__muted">{text.diffLegend}</p>
                  <pre className="checkpoints-dialog__diff">{diff.lines}</pre>
                  {diff.hidden > 0 && (
                    <button type="button" className="card-dialog__secondary checkpoints-dialog__more"
                      onClick={() => setShownLines((count) => count + DIFF_LINES_STEP)}>
                      {text.showMore(diff.hidden)}
                    </button>
                  )}
                </>}
                {preview.truncated && <p className="card-dialog__muted">{text.truncated}</p>}
              </>}
            </section>
          </div>
        )}

        {confirming ? (
          <footer className="card-dialog__footer card-dialog__footer--confirm" role="alertdialog" aria-label={text.confirm}>
            <p>{text.confirm}</p>
            <div className="card-dialog__actions">
              {restoring && <span className="card-dialog__busy" role="status" aria-label={text.restoring}><UiIcon name="working" size="1.2em" /></span>}
              <button type="button" className="card-dialog__secondary" disabled={restoring} onClick={() => setConfirming(false)}>{t(locale, "back")}</button>
              <button type="button" className="card-dialog__danger" autoFocus disabled={restoring} onClick={() => void restore()}>
                {text.restore}
              </button>
            </div>
          </footer>
        ) : (
          <footer className="card-dialog__footer">
            {/* The outcome sits in the footer's reserved line, so the dialog never grows when it appears. */}
            <p className={`checkpoints-dialog__message${error ? " card-dialog__error" : restored ? " checkpoints-dialog__success" : ""}`}
              role={error ? "alert" : "status"}>
              {error ? text[ERROR_TEXT[error]] : restored ? text.restored : ""}
            </p>
            <div className="card-dialog__actions">
              <button type="button" className="card-dialog__primary" disabled={!selected || !preview || restoring}
                onClick={() => { setError(null); setRestored(false); setConfirming(true); }}>
                {text.restore}
              </button>
            </div>
          </footer>
        )}
      </div>
    </dialog>
  );
}

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | null;

/**
 * The kind of each line of a unified diff, by position: a file's header block (from "diff --git" to its first "@@") is
 * meta, so "--- a/x" there is a header while "--x" inside a hunk is a removed line.
 */
export function diffLineKinds(lines: readonly string[]): DiffLineKind[] {
  let header = false;
  return lines.map((line) => {
    if (line.startsWith("diff --git ")) { header = true; return "meta"; }
    if (line.startsWith("@@")) { header = false; return "hunk"; }
    if (header) return "meta";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    if (line.startsWith("\\")) return "meta";
    return null;
  });
}

/**
 * The first `limit` lines of a unified diff (from the current files to the point: what the restore does), the ones
 * the restore brings back and removes in the theme's success and danger colors; `hidden` lines are not rendered yet.
 */
function diffLines(diff: string, limit: number): { lines: React.JSX.Element[]; hidden: number } {
  const all = diff.split("\n");
  const lines = all.slice(0, limit);
  const kinds = diffLineKinds(lines);
  return {
    hidden: all.length - lines.length,
    lines: lines.map((line, index) => (
      <span key={index} className={kinds[index] ? `checkpoints-dialog__line--${kinds[index]}` : undefined}>
        {line}{index < all.length - 1 ? "\n" : ""}
      </span>
    ))
  };
}

/** App's entry to the dialog (loaded with this module on demand); focus returns to the card's options button on close. */
export function CheckpointsHost({ request, locale, onClose }: {
  request: { sessionId: string; cardTitle: string };
  locale: LocaleId;
  onClose(): void;
}): React.JSX.Element {
  return (
    <CheckpointsDialog key={request.sessionId} sessionId={request.sessionId} cardTitle={request.cardTitle} locale={locale}
      onClose={() => {
        onClose();
        focusCardOptions(request.sessionId);
      }} />
  );
}
