import { useRef } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import { useDialogFocus } from "../../lib/useDialogFocus";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";

interface TerminalLinkDialogProps {
  locale: LocaleId;
  url: string | null;
  onClose(): void;
  onOpenCanvas(url: string): void;
  onOpenExternal(url: string): void;
}

export function TerminalLinkDialog({
  locale,
  url,
  onClose,
  onOpenCanvas,
  onOpenExternal
}: TerminalLinkDialogProps): React.JSX.Element | null {
  const canvasButton = useRef<HTMLButtonElement>(null);

  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, !!url, { onEscape: onClose, initialFocus: canvasButton });

  if (!url) return null;

  return (
    <div className="dialog-backdrop terminal-link-dialog__backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialog} className="terminal-link-dialog" role="dialog" aria-modal="true" aria-labelledby="terminal-link-dialog-title">
        <button className="terminal-link-dialog__close" type="button" onClick={onClose} aria-label={t(locale, "close")}>
          <UiIcon name="close" size={18} />
        </button>
        <div className="terminal-link-dialog__icon"><UiIcon name="browser" size={28} /></div>
        <div className="terminal-link-dialog__copy">
          <h2 id="terminal-link-dialog-title">{t(locale, "terminalLinkTitle")}</h2>
          <p>{t(locale, "terminalLinkDescription")}</p>
          <code title={url}>{url}</code>
        </div>
        <div className="terminal-link-dialog__actions">
          <button ref={canvasButton} type="button" onClick={() => onOpenCanvas(url)}>
            <UiIcon name="app-window" size={19} />
            {t(locale, "terminalLinkCanvas")}
          </button>
          <button type="button" onClick={() => onOpenExternal(url)}>
            <UiIcon name="browser" size={19} />
            {t(locale, "terminalLinkExternal")}
          </button>
        </div>
      </section>
    </div>
  );
}
