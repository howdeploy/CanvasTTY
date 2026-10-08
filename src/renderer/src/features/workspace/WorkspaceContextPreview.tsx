import { useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { backlogText } from "./workspaceBacklogText";
import { MAX_CONTEXT_PREVIEW_CHARS, type WorkspaceContextPreview as Preview } from "./workspaceContextDrop";
import { useDialogFocus } from "./useDialogFocus";
import { findSessionCard } from "./workspaceDom";

interface WorkspaceContextPreviewProps {
  preview: Preview;
  locale: LocaleId;
  onConfirm(text: string): Promise<void>;
  onCancel(): void;
}

export function WorkspaceContextPreview({ preview, locale, onConfirm, onCancel }: WorkspaceContextPreviewProps): React.JSX.Element {
  const bt = (key: Parameters<typeof backlogText>[1]): string => backlogText(locale, key);
  const [text, setText] = useState(preview.text);
  const [allowOutside, setAllowOutside] = useState(false);
  const [sending, setSending] = useState(false);
  const confirming = useRef(false);
  const overLimit = text.length > MAX_CONTEXT_PREVIEW_CHARS;
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, {
    onEscape: () => { if (!confirming.current) onCancel(); },
    fallbackFocus: () => findSessionCard(preview.sessionId)
  });
  const confirm = async (): Promise<void> => {
    if (overLimit || !text.trim() || (outsideApprovalRequired && !allowOutside)) return;
    if (confirming.current) return;
    confirming.current = true;
    setSending(true);
    try {
      await onConfirm(text);
    } finally {
      confirming.current = false;
      setSending(false);
    }
  };
  const cancel = (): void => { if (!confirming.current) onCancel(); };
  const outsideApprovalRequired = preview.outsideProject.length > 0;
  return (
    <div className="workspace-context-preview__backdrop" data-interactive="true" role="presentation">
      <section ref={dialogRef} className="workspace-context-preview" role="dialog" aria-modal="true" aria-label={bt("contextPreview")} tabIndex={-1}>
        <header>
          <div><strong>{bt("contextPreview")}</strong><span>{bt("contextPreviewDescription")}</span></div>
          <button type="button" disabled={sending} onClick={cancel} aria-label={t(locale, "close")}>×</button>
        </header>
        {preview.paths.length > 0 && <div className="workspace-context-preview__paths">
          <strong>{bt("contextFiles")}</strong>
          {preview.paths.map((path) => <code key={path}>{path}</code>)}
        </div>}
        {outsideApprovalRequired && <div className="workspace-context-preview__outside" role="alert">
          <strong>{bt("contextOutsideWarning")}</strong>
          {preview.outsideProject.map((path) => <code key={path}>{path}</code>)}
          <label><input type="checkbox" disabled={sending} checked={allowOutside} onChange={(event) => setAllowOutside(event.target.checked)} />
            {bt("contextAllowOutside")}</label>
        </div>}
        {preview.truncated && <p className="workspace-context-preview__notice">{bt("contextTruncated")}</p>}
        <label className="workspace-context-preview__editor">
          <span>{bt("contextEditablePreview")}</span>
          <textarea value={text} disabled={sending} maxLength={MAX_CONTEXT_PREVIEW_CHARS} aria-invalid={overLimit} onChange={(event) => setText(event.currentTarget.value)} rows={12} />
        </label>
        {overLimit && <p role="alert">{bt("contextTooLong").replace("{limit}", String(MAX_CONTEXT_PREVIEW_CHARS))}</p>}
        <footer>
          <button type="button" disabled={sending} onClick={cancel}>{t(locale, "cancel")}</button>
          <button className="workspace-context-preview__send" type="button"
            disabled={sending || overLimit || !text.trim() || (outsideApprovalRequired && !allowOutside)} onClick={() => void confirm()}>
            {sending ? t(locale, "loading") : bt("contextConfirmSend")}
          </button>
        </footer>
      </section>
    </div>
  );
}
