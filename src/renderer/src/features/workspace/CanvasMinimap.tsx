import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type {
  CameraState,
  FileCard,
  LocaleId,
  MinimapInteractionMode,
  ProviderId,
  SessionBounds,
  Size
} from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { t } from "../../lib/i18n";
import { useCameraSelector, type CameraStore } from "./cameraStore";
import { browserLayerId, filesLayerId, noteLayerId, pluginLayerId, terminalLayerId } from "./canvasSelectionGesture";
import { minimapContentEqual, type MinimapContent } from "./minimapContent";
import {
  cameraWorldViewport,
  minimapCameraForPointerDrag,
  minimapAreaForBounds,
  minimapEdgePointForBounds,
  MINIMAP_SURFACE_SIZE,
  minimapWorldBounds,
  minimapWorldPoint
} from "./minimapGeometry";

interface CanvasMinimapProps extends MinimapContent {
  viewport: RefObject<HTMLDivElement | null>;
  camera: CameraStore;
  locale: LocaleId;
  interactionMode: MinimapInteractionMode;
  onCameraChange(camera: CameraState): void;
  fileCards?: readonly FileCard[];
}

interface MinimapEntity {
  id: string;
  kind: "terminal" | "plugin" | "browser" | "note" | "files";
  bounds: SessionBounds;
  provider?: ProviderId;
}

interface MinimapDragState {
  pointerId: number;
  startClient: { x: number; y: number };
  startCamera: CameraState;
  moved: boolean;
}

export const CanvasMinimap = memo(CanvasMinimapView, (previous, next) => (
  previous.viewport === next.viewport
  && previous.camera === next.camera
  && previous.locale === next.locale
  && previous.interactionMode === next.interactionMode
  && previous.onCameraChange === next.onCameraChange
  && sameFileCards(previous.fileCards, next.fileCards)
  && minimapContentEqual(previous, next)
));

function CanvasMinimapView({
  viewport,
  camera,
  homeBounds,
  canvasRegions,
  sessions,
  stickyNotes,
  pluginCanvas,
  fileCards = [],
  browserCanvas,
  layerOrder,
  locale,
  interactionMode,
  onCameraChange
}: CanvasMinimapProps): React.JSX.Element {
  const surface = useRef<HTMLSpanElement>(null);
  const dragState = useRef<MinimapDragState | null>(null);
  const [viewportSize, setViewportSize] = useState<Size>({ width: 1, height: 1 });

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = (): void => {
      const bounds = element.getBoundingClientRect();
      setViewportSize({
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height)
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport]);

  const entities = useMemo<MinimapEntity[]>(() => [
    ...sessions.map((session) => ({
      id: terminalLayerId(session.id), kind: "terminal" as const, bounds: session, provider: session.provider
    })),
    ...stickyNotes.map((note) => ({ id: noteLayerId(note.id), kind: "note" as const, bounds: note })),
    ...pluginCanvas.map((instance) => ({ id: pluginLayerId(instance.id), kind: "plugin" as const, bounds: instance })),
    ...fileCards.map((card) => ({ id: filesLayerId(card.id), kind: "files" as const, bounds: card })),
    ...(browserCanvas ? [{ id: browserLayerId, kind: "browser" as const, bounds: browserCanvas }] : [])
  ], [browserCanvas, fileCards, pluginCanvas, sessions, stickyNotes]);
  const layerIndices = useMemo(
    () => new Map(layerOrder.map((id, index) => [id, index + 1])),
    [layerOrder]
  );
  const worldBounds = useMemo(
    () => minimapWorldBounds([homeBounds, ...canvasRegions, ...entities.map((entity) => entity.bounds)]),
    [canvasRegions, entities, homeBounds]
  );
  const homeArea = useMemo(
    () => minimapAreaForBounds(homeBounds, worldBounds),
    [homeBounds, worldBounds]
  );

  const navigate = (clientX: number, clientY: number): void => {
    const element = surface.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const target = minimapWorldPoint({
      x: (clientX - bounds.left) / bounds.width,
      y: (clientY - bounds.top) / bounds.height
    }, worldBounds);
    const current = camera.get();
    onCameraChange({
      zoom: current.zoom,
      x: viewportSize.width / 2 - target.x * current.zoom,
      y: viewportSize.height / 2 - target.y * current.zoom
    });
  };

  const dragNavigate = (pointerId: number, clientX: number, clientY: number): void => {
    const state = dragState.current;
    const element = surface.current;
    if (!state || state.pointerId !== pointerId || !element) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const pointerDelta = {
      x: clientX - state.startClient.x,
      y: clientY - state.startClient.y
    };
    if (!state.moved) {
      if (Math.abs(pointerDelta.x) <= 3 && Math.abs(pointerDelta.y) <= 3) return;
      state.moved = true;
    }
    const next = minimapCameraForPointerDrag(
      interactionMode,
      state.startCamera,
      pointerDelta,
      { width: bounds.width, height: bounds.height },
      worldBounds
    );
    if (!next) return;
    onCameraChange(next);
  };

  return (
    <button
      className="canvas-minimap"
      type="button"
      data-interactive="true"
      data-interaction-mode={interactionMode}
      aria-label={t(locale, "minimap")}
      title={t(locale, "minimap")}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (interactionMode === "drag") {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragState.current = {
            pointerId: event.pointerId,
            startClient: { x: event.clientX, y: event.clientY },
            startCamera: camera.get(),
            moved: false
          };
        } else {
          dragState.current = null;
          navigate(event.clientX, event.clientY);
        }
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        dragNavigate(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        dragState.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        dragState.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onKeyDown={(event) => {
        const distance = event.shiftKey ? 180 : 72;
        const delta = event.key === "ArrowLeft"
          ? { x: distance, y: 0 }
          : event.key === "ArrowRight"
            ? { x: -distance, y: 0 }
            : event.key === "ArrowUp"
              ? { x: 0, y: distance }
              : event.key === "ArrowDown"
                ? { x: 0, y: -distance }
                : null;
        if (!delta) return;
        event.preventDefault();
        const current = camera.get();
        onCameraChange({ ...current, x: current.x + delta.x, y: current.y + delta.y });
      }}
    >
      <span className="canvas-minimap__surface" ref={surface} aria-hidden="true">
        {canvasRegions.map((region) => {
          const area = minimapAreaForBounds(region, worldBounds);
          return area ? (
            <i
              className="canvas-minimap__region"
              key={region.id}
              style={{ ...areaStyle(area), "--minimap-region-color": region.color } as CSSProperties}
            />
          ) : null;
        })}
        {homeArea && <i className="canvas-minimap__home" style={areaStyle(homeArea)} />}
        <span className="canvas-minimap__windows">
          {entities.map((entity) => {
            const area = minimapAreaForBounds(entity.bounds, worldBounds);
            if (!area) return null;
            const iconSize = Math.min(16,
              area.width * MINIMAP_SURFACE_SIZE.width - 4,
              area.height * MINIMAP_SURFACE_SIZE.height - 4
            );
            return (
              <i
                className={`canvas-minimap__entity canvas-minimap__entity--${entity.kind}`}
                key={entity.id}
                style={{
                  ...areaStyle(area),
                  zIndex: layerIndices.get(entity.id) ?? 1,
                  "--minimap-icon-size": `${iconSize}px`
                } as CSSProperties}
              >
                {entity.provider && iconSize >= 8 && <ProviderIcon provider={entity.provider} size="small" />}
              </i>
            );
          })}
        </span>
        <MinimapViewport camera={camera} viewportSize={viewportSize} worldBounds={worldBounds} />
      </span>
    </button>
  );
}

// Only this layer subscribes to pan/zoom; the workspace rectangles and icons do not render per camera event.
function MinimapViewport({ camera, viewportSize, worldBounds }: {
  camera: CameraStore;
  viewportSize: Size;
  worldBounds: SessionBounds;
}): React.JSX.Element {
  const current = useCameraSelector(camera, (value) => value);
  const worldViewport = cameraWorldViewport(current, viewportSize);
  const area = minimapAreaForBounds(worldViewport, worldBounds);
  const coversOverview = area !== null && area.x <= 0 && area.y <= 0
    && area.x + area.width >= 1 && area.y + area.height >= 1;
  const edge = minimapEdgePointForBounds(worldViewport, worldBounds);
  return (
    <>
      {area && <i className="canvas-minimap__viewport" style={areaStyle(area)} />}
      {coversOverview && <i className="canvas-minimap__viewport canvas-minimap__viewport--covers-overview" />}
      {edge && <i className="canvas-minimap__viewport-edge" style={pointStyle(edge)} />}
    </>
  );
}

function pointStyle(point: { x: number; y: number }): CSSProperties {
  return { left: `${point.x * 100}%`, top: `${point.y * 100}%` };
}

function areaStyle(area: { x: number; y: number; width: number; height: number }): CSSProperties {
  return {
    left: `${area.x * 100}%`,
    top: `${area.y * 100}%`,
    width: `${area.width * 100}%`,
    height: `${area.height * 100}%`
  };
}

/** File cards carry no provider, so `minimapContentEqual` does not see them; compare their bounds here. */
function sameFileCards(
  previous: readonly FileCard[] | undefined,
  next: readonly FileCard[] | undefined
): boolean {
  const left = previous ?? [];
  const right = next ?? [];
  return left === right || (
    left.length === right.length
    && left.every((card, index) => (
      card.id === right[index].id
      && card.position.x === right[index].position.x
      && card.position.y === right[index].position.y
      && card.size.width === right[index].size.width
      && card.size.height === right[index].size.height
    ))
  );
}
