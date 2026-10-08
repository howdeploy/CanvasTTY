import { useEffect, useRef, useState } from "react";
import type { LocaleId, MaterialKind, RemarkAnchor } from "../../../../shared/contracts";
import { REMARK_TEXT_LIMIT } from "../../../../shared/materials";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { remarkAnchorKey, remarkAnchorLabel } from "./materialRemarksModel";

interface RemarkEditorProps {
  locale: LocaleId;
  anchor: RemarkAnchor;
  referenceName: string | null;
  picking: boolean;
  onPickReference(): void;
  onClearReference(): void;
  onSave(text: string): Promise<boolean>;
  onCancel(): void;
}

export function RemarkEditor({
  locale,
  anchor,
  referenceName,
  picking,
  onPickReference,
  onClearReference,
  onSave,
  onCancel
}: RemarkEditorProps): React.JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const anchorKey = remarkAnchorKey(anchor);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    setSaving(false);
  }, [anchorKey, referenceName]);

  const save = async (): Promise<void> => {
    if (!text.trim() || saving) return;
    setSaving(true);
    const saved = await onSave(text);
    if (!saved) setSaving(false);
  };

  return (
    <form
      className="material-remark-editor"
      data-canvas-wheel-priority="local"
      onPointerDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <span className="material-remark-editor__anchor">{remarkAnchorLabel(anchor, locale)}</span>
      <textarea
        ref={input}
        value={text}
        maxLength={REMARK_TEXT_LIMIT}
        rows={3}
        placeholder={t(locale, "remarkPlaceholder")}
        aria-label={t(locale, "remarkPlaceholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <div className="material-remark-editor__reference">
        {referenceName ? (
          <span className="material-remark-editor__chip">
            <UiIcon name="crosshair" size="1em" />
            {referenceName}
            <button type="button" onClick={onClearReference} aria-label={t(locale, "remarkClearReference")} title={t(locale, "remarkClearReference")}>
              <UiIcon name="close" size="1em" />
            </button>
          </span>
        ) : (
          <button type="button" className={picking ? "material-remark-editor__picking" : ""} onClick={onPickReference}>
            <UiIcon name="crosshair" size="1.05em" />
            {t(locale, picking ? "remarkPickingReference" : "remarkAddReference")}
          </button>
        )}
      </div>
      <div className="material-remark-editor__actions">
        <button type="button" onClick={onCancel}>{t(locale, "cancel")}</button>
        <button type="submit" className="material-remark-editor__save" disabled={!text.trim() || saving}>
          {t(locale, "remarkSave")}
        </button>
      </div>
    </form>
  );
}

export function RemarkDrawHint({
  locale,
  kind,
  onWhole,
  onCancel
}: {
  locale: LocaleId;
  kind: MaterialKind;
  onWhole(): void;
  onCancel(): void;
}): React.JSX.Element {
  return (
    <div className="material-remark-hint">
      <span>{t(locale, drawHintKey(kind))}</span>
      <button type="button" onClick={onWhole}>{t(locale, "remarkWhole")}</button>
      <button type="button" onClick={onCancel}>{t(locale, "cancel")}</button>
    </div>
  );
}

function drawHintKey(kind: MaterialKind): "remarkDrawLinesHint" | "remarkDrawTimeHint" | "remarkDrawPageHint" | "remarkDrawHint" {
  switch (kind) {
    case "text": return "remarkDrawLinesHint";
    case "video":
    case "audio": return "remarkDrawTimeHint";
    case "pdf": return "remarkDrawPageHint";
    default: return "remarkDrawHint";
  }
}
