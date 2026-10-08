import { useLayoutEffect, useRef, useState } from "react";
import type { LocaleId, MaterialRemark, Point, RemarkAnchor, Size } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { anchorPercentages, containedRect, dragAnchor, remarkStatusClass, remarkStatusKey, type BoxRect, type RemarkMode } from "./materialRemarksModel";

interface ImageAnnotatorProps {
  locale: LocaleId;
  natural: Size | null;
  remarks: readonly MaterialRemark[];
  staleVersionIds: ReadonlySet<string>;
  mode: RemarkMode;
  draftAnchor: RemarkAnchor | null;
  referenceAnchor: RemarkAnchor | null;
  selectedRemarkId: string | null;
  onDraw(anchor: RemarkAnchor): void;
  onSelectRemark(id: string): void;
}

interface DragState {
  pointerId: number;
  start: Point;
  rect: BoxRect;
}

export function ImageAnnotator({
  locale,
  natural,
  remarks,
  staleVersionIds,
  mode,
  draftAnchor,
  referenceAnchor,
  selectedRemarkId,
  onDraw,
  onSelectRemark
}: ImageAnnotatorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [preview, setPreview] = useState<RemarkAnchor | null>(null);
  const rect = containedRect(box, natural);

  useLayoutEffect(() => {
    const parent = host.current?.parentElement;
    if (!parent) return;
    const update = (): void => setBox({ width: parent.clientWidth, height: parent.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const clientRect = (element: HTMLElement): BoxRect => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
  };

  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (mode === "view" || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, rect: clientRect(event.currentTarget) };
    setPreview(null);
  };

  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId || event.buttons === 0) return;
    event.stopPropagation();
    setPreview(dragAnchor(state.start, { x: event.clientX, y: event.clientY }, state.rect));
  };

  const end = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = null;
    setPreview(null);
    const anchor = dragAnchor(state.start, { x: event.clientX, y: event.clientY }, state.rect);
    if (anchor) onDraw(anchor);
  };

  const cancel = (): void => {
    drag.current = null;
    setPreview(null);
  };

  const shown = preview ?? (mode === "pick" ? null : draftAnchor);
  return (
    <div
      ref={host}
      className={`material-annotator material-annotator--${mode}`}
      data-canvas-card-control={mode === "view" ? undefined : "true"}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
    >
      {remarks.map((remark) => {
        const position = anchorPercentages(remark.target.anchor);
        if (!position) return null;
        const stale = staleVersionIds.has(remark.target.versionId);
        return (
          <button
            key={remark.id}
            type="button"
            className={[
              "material-remark",
              remarkStatusClass(remark.status),
              remark.target.anchor.kind === "point" ? "material-remark--point" : "",
              stale ? "material-remark--stale" : "",
              selectedRemarkId === remark.id ? "material-remark--selected" : ""
            ].filter(Boolean).join(" ")}
            style={position}
            title={`#${remark.number} · ${t(locale, remarkStatusKey(remark.status))}${stale ? ` · ${t(locale, "remarkOlderVersion")}` : ""}`}
            aria-label={`#${remark.number}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelectRemark(remark.id);
            }}
          >
            <span>{remark.number}</span>
          </button>
        );
      })}
      {referenceAnchor && anchorPercentages(referenceAnchor) && (
        <span className="material-remark material-remark--reference" style={anchorPercentages(referenceAnchor)!} aria-hidden="true" />
      )}
      {shown && anchorPercentages(shown) && (
        <span
          className={`material-remark material-remark--draft ${shown.kind === "point" ? "material-remark--point" : ""}`}
          style={anchorPercentages(shown)!}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
