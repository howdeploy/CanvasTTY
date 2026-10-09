import { useEffect, useRef, useState } from "react";
import { summaryScaleForZoom, useCameraSelector, type CameraStore } from "../workspace/cameraStore";
import type {
  InstalledPlugin,
  LimitsSnapshot,
  LocaleId,
  PaletteId,
  PluginCanvasAppContribution,
  PluginCanvasInstance,
  Point,
  ProviderId,
  SessionBounds,
  SessionSnapshot
} from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { snapMove, snapResize, type ResizeDirection } from "../workspace/snap";
import { constrainMascotResize, constrainPluginResize, fitMascotBounds } from "./pluginBounds";
import { PluginFrame } from "./PluginFrame";
import type { PluginCanvasWheelInput } from "./pluginInputBridge";
import { pluginCanvasWidgetId } from "../workspace/canvasWidgetFocus";
import { surfaceIsLive, surfaceLifecycle, useSurfaceOffscreen, useWindowHidden } from "../workspace/surfaceLifecycle";

interface PluginCanvasCardProps {
  instance: PluginCanvasInstance;
  plugin: InstalledPlugin;
  contribution: PluginCanvasAppContribution;
  locale: LocaleId;
  palette: PaletteId;
  /** The canvas camera: drags read its zoom when they move; rendering subscribes to what it needs. */
  camera: CameraStore;
  stackIndex: number;
  snapEnabled: boolean;
  sessions: readonly SessionSnapshot[];
  limits: LimitsSnapshot | null;
  /** The current layout's snap targets for this card; asked once when a drag or resize starts. */
  getSnapTargets(): readonly SessionBounds[];
  onActivate(instance: PluginCanvasInstance): void;
  onBoundsChange(id: string, bounds: SessionBounds): void;
  onDispose(id: string): void;
  onOpenLauncher(provider: ProviderId): void;
  onError(message: string): void;
  captureCanvasWheelOverWidgets: boolean;
  onWidgetFocus(): void;
  onWidgetHoverChange(active: boolean): void;
  onCanvasWheel(event: PluginCanvasWheelInput): void;
  /** True while this card is part of the marquee selection. */
  groupSelected?: boolean;
  /** An ancestor hides the card with CSS (HOME editing hides the whole window layer). */
  hidden?: boolean;
}

interface DragState {
  pointerId: number;
  startClient: Point;
  startBounds: SessionBounds;
  /** Taken at the start: the other cards do not move while this one is dragged. */
  snapTargets: readonly SessionBounds[];
}

interface ResizeState extends DragState {
  direction: ResizeDirection;
}

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

export function PluginCanvasCard({
  instance,
  plugin,
  contribution,
  locale,
  palette,
  camera,
  stackIndex,
  snapEnabled,
  sessions,
  limits,
  getSnapTargets,
  onActivate,
  onBoundsChange,
  onDispose,
  onOpenLauncher,
  onError,
  captureCanvasWheelOverWidgets,
  onWidgetFocus,
  onWidgetHoverChange,
  onCanvasWheel,
  groupSelected = false,
  hidden = false
}: PluginCanvasCardProps): React.JSX.Element {
  const dragState = useRef<DragState | null>(null);
  const mascotDragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const isMascot = plugin.sourceUrl.startsWith("mascot:");
  const mascotAspectRatio = contribution.defaultSize.width / contribution.defaultSize.height;
  const initialBounds = isMascot
    ? fitMascotBounds({ position: instance.position, size: instance.size }, mascotAspectRatio)
    : constrainPluginResize({ position: instance.position, size: instance.size }, "se", contribution.minSize);
  const [position, setPosition] = useState(initialBounds.position);
  const [size, setSize] = useState(initialBounds.size);
  const liveBounds = useRef<SessionBounds>(initialBounds);
  // Renders when the summary scale changes, not on every camera move.
  const summaryScale = useCameraSelector(camera, (current) => summaryScaleForZoom(current.zoom));
  const summaryMode = !isMascot && summaryScale > 1;
  // The plugin document is suspended whenever nobody can see it: its timers drop to one wake-up a second
  // and its animation frames wait, but the document (and all its state) stays loaded.
  const offscreen = useSurfaceOffscreen(camera, { position, size });
  const windowHidden = useWindowHidden();
  const lifecycle = surfaceLifecycle({ summary: summaryMode, hidden, offscreen, windowHidden });
  useEffect(() => {
    const bounds = isMascot
      ? fitMascotBounds({ position: instance.position, size: instance.size }, mascotAspectRatio)
      : constrainPluginResize({ position: instance.position, size: instance.size }, "se", contribution.minSize);
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
    if (bounds.size.width !== instance.size.width || bounds.size.height !== instance.size.height
      || bounds.position.x !== instance.position.x || bounds.position.y !== instance.position.y) {
      onBoundsChange(instance.id, bounds);
    }
  }, [contribution.minSize, instance.id, instance.position, instance.size, isMascot, mascotAspectRatio, onBoundsChange]);

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current,
      snapTargets: snapEnabled ? getSnapTargets() : []
    };
  };

  const drag = (event: React.PointerEvent<HTMLElement>): void => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // A buttonless move is a hover, not a drag.
    if (event.buttons === 0) return;
    const rawPosition = {
      x: state.startBounds.position.x + (event.clientX - state.startClient.x) / camera.get().zoom,
      y: state.startBounds.position.y + (event.clientY - state.startClient.y) / camera.get().zoom
    };
    applyBounds({
      position: snapEnabled ? snapMove(rawPosition, state.startBounds.size, state.snapTargets) : rawPosition,
      size: state.startBounds.size
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    onBoundsChange(instance.id, liveBounds.current);
  };

  // A group drag takes pointer capture without a pointerup; drop local state so a
  // later hover cannot act on it.
  const cancelDrag = (): void => {
    dragState.current = null;
  };

  const cancelResize = (): void => {
    resizeState.current = null;
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeState.current = {
      pointerId: event.pointerId,
      direction,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current,
      snapTargets: snapEnabled ? getSnapTargets() : []
    };
  };

  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // A buttonless move is a hover, not a resize.
    if (event.buttons === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - state.startClient.x) / camera.get().zoom;
    const deltaY = (event.clientY - state.startClient.y) / camera.get().zoom;
    const raw: SessionBounds = {
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
    };
    const constrained = isMascot
      ? constrainMascotResize(raw, state.direction, state.startBounds.size, mascotAspectRatio)
      : constrainPluginResize(raw, state.direction, contribution.minSize);
    const snapped = snapEnabled
      ? snapResize(constrained, state.direction, state.snapTargets, isMascot
        ? { min: { width: 128, height: 140 }, max: { width: 1_600, height: 1_100 } }
        : undefined)
      : constrained;
    applyBounds(isMascot
      ? constrainMascotResize(snapped, state.direction, constrained.size, mascotAspectRatio)
      : snapped);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = null;
    onBoundsChange(instance.id, liveBounds.current);
  };

  const applyBounds = (bounds: SessionBounds): void => {
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  };

  const dragMascot = (event: { phase: "start" | "move" | "end"; x: number; y: number; pointerId: number }): void => {
    if (event.phase === "start") {
      onWidgetFocus();
      mascotDragState.current = {
        pointerId: event.pointerId,
        startClient: { x: event.x, y: event.y },
        startBounds: liveBounds.current,
        snapTargets: snapEnabled ? getSnapTargets() : []
      };
      return;
    }
    const state = mascotDragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.phase === "end") {
      mascotDragState.current = null;
      onBoundsChange(instance.id, liveBounds.current);
      return;
    }
    const rawPosition = {
      x: state.startBounds.position.x + (event.x - state.startClient.x) / camera.get().zoom,
      y: state.startBounds.position.y + (event.y - state.startClient.y) / camera.get().zoom
    };
    applyBounds({
      position: snapEnabled ? snapMove(rawPosition, state.startBounds.size, state.snapTargets) : rawPosition,
      size: state.startBounds.size
    });
  };

  return (
    <article
      className={`plugin-canvas-card ${isMascot ? "plugin-canvas-card--mascot" : ""} ${summaryMode ? "plugin-canvas-card--summary" : ""} ${groupSelected ? "plugin-canvas-card--selected" : ""}`}
      data-interactive="true"
      data-canvas-layer-id={`plugin:${instance.id}`}
      data-canvas-widget-id={pluginCanvasWidgetId(instance.id)}
      data-canvas-widget-focusable="true"
      data-wheel-owner={summaryMode ? undefined : "local"}
      data-surface-lifecycle={lifecycle}
      style={{
        width: size.width,
        height: size.height,
        zIndex: stackIndex,
        transform: `translate(${position.x}px, ${position.y}px)`,
        "--summary-scale": summaryScale
      } as React.CSSProperties}
    >
      <header
        className="plugin-canvas-card__header"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={cancelDrag}
      >
        <span><strong>{instance.title}</strong><small>{plugin.manifest.name}</small></span>
        <button type="button" onClick={() => onDispose(instance.id)} title={t(locale, "close")} aria-label={t(locale, "close")}>
          <UiIcon name="close" size="1.23em" />
        </button>
      </header>
      <PluginFrame
        key={plugin.selectedModules.join(",")}
        className="plugin-canvas-card__frame"
        plugin={plugin}
        contribution={contribution}
        locale={locale}
        palette={palette}
        sessions={sessions}
        limits={limits}
        captureCanvasWheelOverWidgets={captureCanvasWheelOverWidgets}
        onCanvasWheel={onCanvasWheel}
        onFocus={onWidgetFocus}
        onHoverChange={onWidgetHoverChange}
        canvasInstanceId={instance.id}
        onOpenLauncher={onOpenLauncher}
        onError={onError}
        onMascotDrag={isMascot ? dragMascot : undefined}
        suspended={!surfaceIsLive(lifecycle)}
      />
      <button
        className="plugin-canvas-card__summary"
        type="button"
        onClick={() => onActivate(instance)}
        aria-label={instance.title}
      >
        <span><strong>{instance.title}</strong><small>{plugin.manifest.name}</small></span>
      </button>
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
