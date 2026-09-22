import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type {
  BrowserCanvasState,
  CameraState,
  CanvasRegion,
  LocaleId,
  MinimapInteractionMode,
  PluginCanvasInstance,
  SessionBounds,
  SessionSnapshot,
  Size,
  StickyNote
} from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import {
  cameraWorldViewport,
  minimapCameraForPointerDrag,
  minimapAreaForBounds,
  minimapEdgePointForBounds,
  minimapPointForBounds,
  minimapWorldBounds,
  minimapWorldPoint
} from "./minimapGeometry";

interface CanvasMinimapProps {
  viewport: RefObject<HTMLDivElement | null>;
  camera: CameraState;
  homeBounds: SessionBounds;
  canvasRegions: readonly CanvasRegion[];
  sessions: readonly SessionSnapshot[];
  stickyNotes: readonly StickyNote[];
  pluginCanvas: readonly PluginCanvasInstance[];
  browserCanvas: BrowserCanvasState | null;
  locale: LocaleId;
  interactionMode: MinimapInteractionMode;
  onCameraChange(camera: CameraState): void;
}

interface MinimapEntity {
  id: string;
  kind: "terminal" | "plugin" | "browser" | "note";
  bounds: SessionBounds;
}

interface MinimapDragState {
  pointerId: number;
  startClient: { x: number; y: number };
  startCamera: CameraState;
  moved: boolean;
}

export function CanvasMinimap({
  viewport,
  camera,
  homeBounds,
  canvasRegions,
  sessions,
  stickyNotes,
  pluginCanvas,
  browserCanvas,
  locale,
  interactionMode,
  onCameraChange
}: CanvasMinimapProps): React.JSX.Element {
  const surface = useRef<HTMLSpanElement>(null);
  const cameraRef = useRef(camera);
  const dragState = useRef<MinimapDragState | null>(null);
  const [viewportSize, setViewportSize] = useState<Size>({ width: 1, height: 1 });
  cameraRef.current = camera;

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

  const worldViewport = useMemo(
    () => cameraWorldViewport(camera, viewportSize),
    [camera, viewportSize]
  );
  const worldBounds = useMemo(() => minimapWorldBounds(worldViewport), [worldViewport]);
  const viewportPoint = useMemo(
    () => minimapPointForBounds(worldViewport, worldBounds),
    [worldBounds, worldViewport]
  );
  const homeEdge = useMemo(
    () => minimapEdgePointForBounds(homeBounds, worldBounds),
    [homeBounds, worldBounds]
  );
  const homeArea = useMemo(
    () => minimapAreaForBounds(homeBounds, worldBounds),
    [homeBounds, worldBounds]
  );
  const entities = useMemo<MinimapEntity[]>(() => [
    ...sessions.map((session) => ({ id: session.id, kind: "terminal" as const, bounds: session })),
    ...stickyNotes.map((note) => ({ id: note.id, kind: "note" as const, bounds: note })),
    ...pluginCanvas.map((instance) => ({ id: instance.id, kind: "plugin" as const, bounds: instance })),
    ...(browserCanvas ? [{ id: "browser", kind: "browser" as const, bounds: browserCanvas }] : [])
  ], [browserCanvas, pluginCanvas, sessions, stickyNotes]);

  const applyCamera = (next: CameraState): void => {
    cameraRef.current = next;
    onCameraChange(next);
  };

  const navigate = (clientX: number, clientY: number): void => {
    const element = surface.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const target = minimapWorldPoint({
      x: (clientX - bounds.left) / bounds.width,
      y: (clientY - bounds.top) / bounds.height
    }, worldBounds);
    const current = cameraRef.current;
    applyCamera({
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
    applyCamera(next);
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
            startCamera: cameraRef.current,
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
        const current = cameraRef.current;
        applyCamera({ ...current, x: current.x + delta.x, y: current.y + delta.y });
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
        {entities.map((entity) => (
          <i
            className={`canvas-minimap__entity canvas-minimap__entity--${entity.kind}`}
            key={`${entity.kind}:${entity.id}`}
            style={pointStyle(minimapPointForBounds(entity.bounds, worldBounds))}
          />
        ))}
        <i className="canvas-minimap__viewport" style={pointStyle(viewportPoint)} />
        {homeEdge && (
          <i className="canvas-minimap__home-edge" style={pointStyle(homeEdge)} />
        )}
      </span>
    </button>
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
