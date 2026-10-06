import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasMaterial, LocaleId, Point, SessionBounds, Size } from "../../../../shared/contracts";
import { constrainMaterialResize, MATERIAL_MAX_SIZE, MATERIAL_MIN_SIZE, materialUrl } from "../../../../shared/materials";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { materialLayerId } from "../workspace/canvasSelectionGesture";
import { SUMMARY_ZOOM, summaryScaleForZoom, useCameraSelector, type CameraStore } from "../workspace/cameraStore";
import { snapMove, snapResize, type ResizeDirection } from "../workspace/snap";
import { ImageAnnotator } from "./ImageAnnotator";
import {
  formatBytes,
  latestVersionNumber,
  materialIcon,
  materialRemovalLosesData,
  materialSubtitle,
  materialWidgetAttributes,
  remarkDrawable,
  type MaterialCommand,
  type MaterialIconName
} from "./materialCardModel";
import { remarkNeedsWork, type MaterialRemarkActions, type MaterialRemarking } from "./materialRemarksModel";
import { RemarkChips } from "./RemarkChips";

interface MaterialCardProps {
  material: CanvasMaterial;
  locale: LocaleId;
  camera: CameraStore;
  stackIndex: number;
  snapEnabled: boolean;
  getSnapTargets(): readonly SessionBounds[];
  groupSelected?: boolean;
  removeRequest: number;
  remarking: MaterialRemarking;
  remarkActions: MaterialRemarkActions;
  onBoundsChange(id: string, bounds: SessionBounds): void;
  onRemove(id: string): void;
  onOpenMenu(id: string, client: Point): void;
  onAction(id: string, action: MaterialCommand): void;
}

interface DragState {
  pointerId: number;
  startClient: Point;
  startBounds: SessionBounds;
}

interface ResizeState extends DragState {
  direction: ResizeDirection;
}

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

export function MaterialCard({
  material,
  locale,
  camera,
  stackIndex,
  snapEnabled,
  getSnapTargets,
  groupSelected = false,
  removeRequest,
  remarking,
  remarkActions,
  onBoundsChange,
  onRemove,
  onOpenMenu,
  onAction
}: MaterialCardProps): React.JSX.Element {
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const liveBounds = useRef<SessionBounds>({ position: material.position, size: material.size });
  const [position, setPosition] = useState(material.position);
  const [size, setSize] = useState(material.size);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const summaryMode = useCameraSelector(camera, (current) => current.zoom < SUMMARY_ZOOM);
  const summaryScale = useCameraSelector(camera, (current) => summaryScaleForZoom(current.zoom));
  const version = latestVersionNumber(material);
  const openRemarks = remarking.remarks.filter(remarkNeedsWork).length;
  const cardRemarks = material.state === "ready"
    ? remarking.remarks.filter((remark) => remark.target.anchor.kind === "whole")
    : remarking.remarks;
  const staleVersionIds = useMemo(
    () => new Set(material.versions.filter((candidate) => !candidate.current).map((candidate) => candidate.id)),
    [material.versions]
  );
  const subtitle = materialSubtitle(material, locale);

  useEffect(() => {
    if (dragState.current !== null || resizeState.current !== null) return;
    const bounds = { position: material.position, size: material.size };
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  }, [material.position, material.size]);

  const requestRemoval = (): void => {
    if (materialRemovalLosesData(material) || remarking.remarks.length > 0 || remarking.referencedBy > 0) setConfirmingRemoval(true);
    else onRemove(material.id);
  };
  const requestRemovalRef = useRef(requestRemoval);
  requestRemovalRef.current = requestRemoval;

  useEffect(() => {
    if (removeRequest > 0) requestRemovalRef.current();
  }, [removeRequest]);

  const applyBounds = (bounds: SessionBounds): void => {
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  };

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current
    };
  };

  const drag = (event: React.PointerEvent<HTMLElement>): void => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId || event.buttons === 0) return;
    const rawPosition = {
      x: state.startBounds.position.x + (event.clientX - state.startClient.x) / camera.get().zoom,
      y: state.startBounds.position.y + (event.clientY - state.startClient.y) / camera.get().zoom
    };
    applyBounds({
      position: snapEnabled ? snapMove(rawPosition, state.startBounds.size, getSnapTargets()) : rawPosition,
      size: state.startBounds.size
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragState.current = null;
    onBoundsChange(material.id, liveBounds.current);
  };

  const cancelDrag = (): void => {
    if (dragState.current === null) return;
    dragState.current = null;
    applyBounds({ position: material.position, size: material.size });
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeState.current = {
      pointerId: event.pointerId,
      direction,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current
    };
  };

  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId || event.buttons === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - state.startClient.x) / camera.get().zoom;
    const deltaY = (event.clientY - state.startClient.y) / camera.get().zoom;
    const constrained = constrainMaterialResize({
      position: {
        x: state.startBounds.position.x + (state.direction.includes("w") ? deltaX : 0),
        y: state.startBounds.position.y + (state.direction.includes("n") ? deltaY : 0)
      },
      size: {
        width: state.startBounds.size.width
          + (state.direction.includes("e") ? deltaX : 0)
          - (state.direction.includes("w") ? deltaX : 0),
        height: state.startBounds.size.height
          + (state.direction.includes("s") ? deltaY : 0)
          - (state.direction.includes("n") ? deltaY : 0)
      }
    }, state.direction);
    applyBounds(snapEnabled
      ? snapResize(constrained, state.direction, getSnapTargets(), { min: MATERIAL_MIN_SIZE, max: MATERIAL_MAX_SIZE })
      : constrained);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = null;
    onBoundsChange(material.id, liveBounds.current);
  };

  const cancelResize = (): void => {
    if (resizeState.current === null) return;
    resizeState.current = null;
    applyBounds({ position: material.position, size: material.size });
  };

  const drawing = remarking.mode === "draw";
  const toggleRemark = (): void => {
    if (drawing) {
      remarkActions.cancel();
      return;
    }
    remarkActions.start(material.id, remarkDrawable(material) ? null : { kind: "whole" });
  };

  return (
    <article
      className={[
        "material-card",
        `material-card--${material.kind}`,
        summaryMode ? "material-card--summary" : "",
        groupSelected ? "material-card--selected" : "",
        remarking.mode !== "view" ? `material-card--${remarking.mode}` : ""
      ].filter(Boolean).join(" ")}
      data-interactive="true"
      data-material-id={material.id}
      data-canvas-layer-id={materialLayerId(material.id)}
      {...materialWidgetAttributes()}
      style={{
        zIndex: stackIndex,
        width: size.width,
        height: size.height,
        transform: `translate(${position.x}px, ${position.y}px)`,
        "--summary-scale": summaryScale
      } as React.CSSProperties}
    >
      <header
        className="material-card__header"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={cancelDrag}
      >
        <span className="material-card__title" title={material.location ?? material.name}>
          <UiIcon name={materialIcon(material.kind)} size="1.35em" />
          <span>
            <strong>{material.name}</strong>
            {subtitle && <small>{subtitle}</small>}
          </span>
        </span>
        <span className="material-card__actions">
          {version !== null && (
            <span className="material-card__badge" title={t(locale, "materialVersions")}>v{version}</span>
          )}
          {openRemarks > 0 && (
            <button
              type="button"
              className="material-card__send"
              title={t(locale, "handoffSendToAgent")}
              aria-label={t(locale, "handoffSendToAgent")}
              onClick={() => remarkActions.send(material.id)}
            >
              <UiIcon name="send" size="1.1em" />
              <span>{openRemarks}</span>
            </button>
          )}
          {remarkDrawable(material) && (
            <button
              type="button"
              className={drawing ? "material-card__active" : ""}
              title={t(locale, drawing ? "remarkCancel" : "remarkAdd")}
              aria-label={t(locale, drawing ? "remarkCancel" : "remarkAdd")}
              aria-pressed={drawing}
              onClick={toggleRemark}
            >
              <UiIcon name="remark-add" size="1.2em" />
            </button>
          )}
          <button
            type="button"
            title={t(locale, "materialActions")}
            aria-label={t(locale, "materialActions")}
            onClick={(event) => onOpenMenu(material.id, { x: event.clientX, y: event.clientY })}
          >
            <UiIcon name="ellipsis" size="1.23em" />
          </button>
          <button
            className="material-card__close"
            type="button"
            title={t(locale, "materialRemove")}
            aria-label={t(locale, "materialRemove")}
            onClick={requestRemoval}
          >
            <UiIcon name="close" size="1.23em" />
          </button>
        </span>
      </header>
      {cardRemarks.length > 0 && !confirmingRemoval && (
        <RemarkChips
          locale={locale}
          label={t(locale, material.state === "ready" ? "materialWholeRemarks" : "materialRemarks")}
          remarks={cardRemarks}
          onSelect={remarkActions.select}
        />
      )}
      <div className="material-card__body">
        {confirmingRemoval ? (
          <MaterialNotice
            icon="error"
            title={t(locale, "materialRemoveConfirm")}
            hint={[
              t(locale, material.location === null ? "materialRemoveCaptureHint" : "materialRemoveVersionsHint"),
              remarking.remarks.length > 0 ? `${t(locale, "materialRemoveRemarks")} ${remarking.remarks.length}.` : "",
              remarking.referencedBy > 0 ? t(locale, "materialRemoveReferences") : ""
            ].filter(Boolean).join(" ")}
          >
            <button type="button" className="material-card__danger" onClick={() => onRemove(material.id)}>
              {t(locale, "materialRemove")}
            </button>
            <button type="button" onClick={() => setConfirmingRemoval(false)}>{t(locale, "cancel")}</button>
          </MaterialNotice>
        ) : (
          <MaterialBody material={material} locale={locale} remarking={remarking} remarkActions={remarkActions}
            staleVersionIds={staleVersionIds} onAction={onAction} />
        )}
      </div>
      <div className="material-card__summary" aria-hidden={!summaryMode}>
        <span>
          <strong>{material.name}</strong>
          <small>{t(locale, materialKindLabel(material.kind))}</small>
        </span>
      </div>
      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`}
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, direction)}
          onPointerMove={resize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={cancelResize}
        />
      ))}
    </article>
  );
}

function MaterialBody({
  material,
  locale,
  remarking,
  remarkActions,
  staleVersionIds,
  onAction
}: {
  material: CanvasMaterial;
  locale: LocaleId;
  remarking: MaterialRemarking;
  remarkActions: MaterialRemarkActions;
  staleVersionIds: ReadonlySet<string>;
  onAction(id: string, action: MaterialCommand): void;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<Size | null>(null);
  const source = materialUrl(material.id, null, material.liveRevision);

  useEffect(() => setFailed(false), [source]);

  if (material.state === "missing") {
    return (
      <MaterialNotice icon="error" title={t(locale, "materialMissing")} hint={t(locale, "materialMissingHint")}>
        <button type="button" onClick={() => onAction(material.id, "relink")}>{t(locale, "materialLocate")}</button>
      </MaterialNotice>
    );
  }
  if (material.state === "moved") {
    return (
      <MaterialNotice icon="file-search" title={t(locale, "materialMoved")} hint={material.movedTo ?? ""}>
        <button type="button" onClick={() => onAction(material.id, "accept-move")}>{t(locale, "materialUseNewName")}</button>
        <button type="button" onClick={() => onAction(material.id, "relink")}>{t(locale, "materialLocate")}</button>
      </MaterialNotice>
    );
  }
  if (material.state === "unreadable") {
    return (
      <MaterialNotice icon="error" title={t(locale, "materialUnreadable")} hint={t(locale, "materialUnreadableHint")}>
        {material.location && (
          <button type="button" onClick={() => onAction(material.id, "relink")}>{t(locale, "materialLocate")}</button>
        )}
      </MaterialNotice>
    );
  }
  if (!failed && material.kind === "image") {
    return (
      <>
        <img
          className="material-card__image"
          src={source}
          alt={material.name}
          draggable={false}
          onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
        <ImageAnnotator
          locale={locale}
          natural={natural}
          remarks={remarking.remarks}
          staleVersionIds={staleVersionIds}
          mode={remarking.mode}
          draftAnchor={remarking.draftAnchor}
          referenceAnchor={remarking.referenceAnchor}
          selectedRemarkId={remarking.selectedRemarkId}
          onDraw={(anchor) => remarkActions.draw(material.id, anchor)}
          onSelectRemark={(id) => remarkActions.select(id)}
        />
      </>
    );
  }
  if (!failed && material.kind === "video") {
    return <video className="material-card__video" src={source} controls preload="metadata" onError={() => setFailed(true)} />;
  }
  if (!failed && material.kind === "audio") {
    return (
      <div className="material-card__audio">
        <UiIcon name="music" size="2.2em" />
        <audio src={source} controls preload="metadata" onError={() => setFailed(true)} />
      </div>
    );
  }
  const unplaced = remarking.remarks.filter((remark) => remark.target.anchor.kind !== "whole");
  return (
    <MaterialNotice
      icon={materialIcon(material.kind)}
      title={failed ? t(locale, "materialPreviewFailed") : t(locale, "materialNoPreview")}
      hint={[formatBytes(material.byteSize, locale), t(locale, "materialNoPreviewHint")].filter(Boolean).join(" · ")}
    >
      {unplaced.length > 0 && <RemarkChips locale={locale} label={t(locale, "materialRemarks")} remarks={unplaced} onSelect={remarkActions.select} />}
    </MaterialNotice>
  );
}

export function MaterialNotice({
  icon,
  title,
  hint,
  children
}: {
  icon: "error" | "file-search" | MaterialIconName;
  title: string;
  hint: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="material-card__notice" role="status">
      <UiIcon name={icon} size="1.9em" />
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
      {children && <div className="material-card__notice-actions">{children}</div>}
    </div>
  );
}

function materialKindLabel(kind: CanvasMaterial["kind"]): "materialKindImage" | "materialKindText" | "materialKindVideo"
  | "materialKindAudio" | "materialKindPdf" | "materialKindFile" {
  switch (kind) {
    case "image": return "materialKindImage";
    case "text": return "materialKindText";
    case "video": return "materialKindVideo";
    case "audio": return "materialKindAudio";
    case "pdf": return "materialKindPdf";
    default: return "materialKindFile";
  }
}
