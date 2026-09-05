import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProviderId,
  AppSettings,
  BrowserCanvasState,
  BrowserSnapshot,
  CameraState,
  CanvasOverlayPlacement,
  CanvasRegion,
  HomeGridSize,
  HomeWidgetPlacement,
  InstalledPlugin,
  LimitsSnapshot,
  Point,
  ProviderId,
  SessionBounds,
  SessionSnapshot,
  StickyNote
} from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { displayCanvasNavigationBinding } from "../../lib/shortcuts";
import { BrowserCard } from "../browser/BrowserCard";
import type { LimitsLoadState } from "../home/homeModel";
import { homeGridPixelSize, homeLayoutFitsGrid } from "../home/homeLayout";
import { HomeZone } from "../home/HomeZone";
import { StickyNoteCard } from "../notes/StickyNoteCard";
import { stickyNoteAtPoint } from "../notes/stickyNoteBounds";
import { PluginCanvasCard } from "../plugins/PluginCanvasCard";
import { TerminalCard } from "../terminal/TerminalCard";
import { CanvasCommandPalette } from "./CanvasCommandPalette";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { CanvasMinimap } from "./CanvasMinimap";
import { CanvasRegionCard } from "./CanvasRegionCard";
import { CanvasRegionMenu } from "./CanvasRegionMenu";
import {
  clampCanvasMenuPosition,
  routeCanvasContextMenu,
  type CanvasContextHit,
  type CanvasContextMenuKind
} from "./canvasContextRouting";
import {
  CANVAS_REGION_COLORS,
  boundsInsideRegion,
  canvasRegionAtPoint,
  translateBounds
} from "./canvasRegions";
import {
  bringCanvasLayerToFront,
  canvasLayerIsOccluded,
  canvasLayerZIndex,
  reconcileCanvasLayerOrder
} from "./canvasStacking";
import {
  browserCanvasWidgetId,
  canvasWidgetTarget,
  pluginCanvasWidgetId,
  terminalCanvasWidgetId
} from "./canvasWidgetFocus";
import { useCanvasPointerNavigation } from "./useCanvasPointerNavigation";
import { useCanvasWheelNavigation } from "./useCanvasWheelNavigation";
import { useCanvasWidgetFocus } from "./useCanvasWidgetFocus";

const CANVAS_OVERLAY_PLACEMENTS: CanvasOverlayPlacement[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right"
];

type CanvasMenuState = {
  kind: CanvasContextMenuKind;
  position: Point;
  worldPoint: Point;
  targetId?: string;
};

type RegionEditorState = {
  mode: "create";
  focus: "title" | "color";
  position: Point;
  worldPoint: Point;
} | {
  mode: "edit";
  focus: "title" | "color";
  position: Point;
  regionId: string;
};

type RegionMovePreview = {
  regionId: string;
  startBounds: SessionBounds;
  currentBounds: SessionBounds;
  sessionBounds: ReadonlyMap<string, SessionBounds>;
  pluginBounds: ReadonlyMap<string, SessionBounds>;
  browserBounds: SessionBounds | null;
  noteBounds: ReadonlyMap<string, SessionBounds>;
};

interface WorkspaceCanvasProps {
  settings: AppSettings;
  mediaData: string | null;
  sessions: SessionSnapshot[];
  limits: LimitsSnapshot | null;
  limitsLoadState: LimitsLoadState;
  plugins: InstalledPlugin[];
  browser: BrowserSnapshot;
  browserViewVisible: boolean;
  homeEditing: boolean;
  camera: CameraState;
  onCameraChange(camera: CameraState): void;
  onGoHome(): void;
  onOpenSettings(): void;
  onOpenAgent(provider: AgentProviderId, position?: Point): void;
  onOpenTerminal(position?: Point): void;
  onOpenBrowser(position?: Point): void;
  onOpenTerminalUrl(url: string): void;
  onFocusSession(session: SessionSnapshot): void;
  activeSessionId: string | null;
  browserSelected: boolean;
  renamingSessionId: string | null;
  onSelectSession(id: string): void;
  onSelectBrowser(): void;
  onClearCanvasSelection(): void;
  onRenameSession(id: string, title: string): Promise<void>;
  onRenameEnd(): void;
  onRequestMedia(): Promise<void>;
  onRemoveMedia(): Promise<void>;
  onHomeLayoutChange(layout: HomeWidgetPlacement[]): void;
  onHomeGridSizeChange(gridSize: HomeGridSize): void;
  onFinishHomeEdit(): void;
  onResetHomeLayout(): void;
  onPluginError(message: string): void;
  onPluginCanvasBoundsChange(id: string, bounds: SessionBounds): void;
  onDisposePluginCanvas(id: string): void;
  onFocusPluginCanvas(id: string): void;
  onSessionBoundsChange(id: string, bounds: SessionBounds): void;
  onRestartSession(id: string): Promise<void>;
  onDisposeSession(id: string): void;
  onBrowserBoundsChange(bounds: BrowserCanvasState): void;
  onFocusBrowser(): void;
  onCloseBrowser(): void;
  onCreateCanvasRegion(region: CanvasRegion): void;
  onChangeCanvasRegion(region: CanvasRegion): void;
  onCanvasRegionBoundsChange(id: string, bounds: SessionBounds, interaction: "move" | "resize"): void;
  onDeleteCanvasRegion(id: string): void;
  onCreateStickyNote(note: StickyNote): void;
  onStickyNoteBoundsChange(id: string, bounds: SessionBounds): void;
  onStickyNoteTextChange(id: string, text: string): void;
  onDeleteStickyNote(id: string): void;
}

export function WorkspaceCanvas(props: WorkspaceCanvasProps): React.JSX.Element {
  const {
    settings, mediaData, sessions, limits, limitsLoadState, plugins, browser,
    browserViewVisible, homeEditing, camera, onCameraChange, onGoHome,
    onOpenSettings, onOpenAgent, onOpenTerminal, onOpenBrowser, onOpenTerminalUrl, onFocusSession,
    activeSessionId, browserSelected, renamingSessionId, onSelectSession,
    onSelectBrowser, onClearCanvasSelection, onRenameSession, onRenameEnd,
    onRequestMedia, onRemoveMedia, onHomeLayoutChange, onHomeGridSizeChange,
    onFinishHomeEdit, onResetHomeLayout, onPluginError, onPluginCanvasBoundsChange,
    onDisposePluginCanvas, onFocusPluginCanvas, onSessionBoundsChange,
    onRestartSession, onDisposeSession, onBrowserBoundsChange, onFocusBrowser,
    onCloseBrowser, onCreateCanvasRegion, onChangeCanvasRegion,
    onCanvasRegionBoundsChange, onDeleteCanvasRegion, onCreateStickyNote,
    onStickyNoteBoundsChange, onStickyNoteTextChange, onDeleteStickyNote
  } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<CanvasMenuState | null>(null);
  const [regionEditor, setRegionEditor] = useState<RegionEditorState | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [noteEditRequest, setNoteEditRequest] = useState<{ id: string; version: number } | null>(null);
  const [regionMovePreview, setRegionMovePreview] = useState<RegionMovePreview | null>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const commitCamera = useCallback((next: CameraState): void => {
    cameraRef.current = next;
    onCameraChange(next);
  }, [onCameraChange]);

  const updateRegionMovePreview = useCallback((regionId: string, bounds: SessionBounds | null): void => {
    setRegionMovePreview((current) => {
      if (bounds === null) return current?.regionId === regionId ? null : current;
      if (current?.regionId === regionId) return { ...current, currentBounds: copyBounds(bounds) };
      const region = settings.canvasRegions.find((candidate) => candidate.id === regionId);
      if (!region) return null;
      const startRegion = { ...region, ...copyBounds(bounds) };
      return {
        regionId,
        startBounds: copyBounds(bounds),
        currentBounds: copyBounds(bounds),
        sessionBounds: containedBounds(sessions, startRegion),
        pluginBounds: containedBounds(settings.pluginCanvas, startRegion),
        browserBounds: settings.browserCanvas && boundsInsideRegion(settings.browserCanvas, startRegion)
          ? copyBounds(settings.browserCanvas)
          : null,
        noteBounds: containedBounds(settings.stickyNotes, startRegion)
      };
    });
  }, [sessions, settings.browserCanvas, settings.canvasRegions, settings.pluginCanvas, settings.stickyNotes]);
  const previewDelta = regionMovePreview ? {
    x: regionMovePreview.currentBounds.position.x - regionMovePreview.startBounds.position.x,
    y: regionMovePreview.currentBounds.position.y - regionMovePreview.startBounds.position.y
  } : null;
  const renderedCanvasRegions = useMemo(() => settings.canvasRegions.map((region) => (
    regionMovePreview?.regionId === region.id
      ? { ...region, ...copyBounds(regionMovePreview.currentBounds) }
      : region
  )), [regionMovePreview, settings.canvasRegions]);
  const renderedSessions = useMemo(() => sessions.map((session) => {
    const start = regionMovePreview?.sessionBounds.get(session.id);
    return start && previewDelta ? { ...session, ...translateBounds(start, previewDelta) } : session;
  }), [previewDelta, regionMovePreview, sessions]);
  const renderedPluginCanvas = useMemo(() => settings.pluginCanvas.map((instance) => {
    const start = regionMovePreview?.pluginBounds.get(instance.id);
    return start && previewDelta ? { ...instance, ...translateBounds(start, previewDelta) } : instance;
  }), [previewDelta, regionMovePreview, settings.pluginCanvas]);
  const renderedBrowserCanvas = useMemo(() => (
    settings.browserCanvas && regionMovePreview?.browserBounds && previewDelta
      ? { ...settings.browserCanvas, ...translateBounds(regionMovePreview.browserBounds, previewDelta) }
      : settings.browserCanvas
  ), [previewDelta, regionMovePreview, settings.browserCanvas]);
  const renderedStickyNotes = useMemo(() => settings.stickyNotes.map((note) => {
    const start = regionMovePreview?.noteBounds.get(note.id);
    return start && previewDelta ? { ...note, ...translateBounds(start, previewDelta) } : note;
  }), [previewDelta, regionMovePreview, settings.stickyNotes]);

  const renderablePluginIds = useMemo(() => new Set(settings.pluginCanvas.filter((instance) => {
    const plugin = plugins.find((candidate) => candidate.manifest.id === instance.pluginId && candidate.enabled);
    return plugin?.manifest.contributions.some((candidate) => (
      candidate.id === instance.contributionId && candidate.kind === "canvas-app"
    ));
  }).map((instance) => instance.id)), [plugins, settings.pluginCanvas]);
  const activeLayerIds = useMemo(() => [
    ...renderedSessions.map((session) => terminalLayerId(session.id)),
    ...renderedPluginCanvas.filter((instance) => renderablePluginIds.has(instance.id)).map((instance) => pluginLayerId(instance.id)),
    ...(renderedBrowserCanvas ? [browserLayerId] : []),
    ...renderedStickyNotes.map((note) => noteLayerId(note.id))
  ], [renderablePluginIds, renderedBrowserCanvas, renderedPluginCanvas, renderedSessions, renderedStickyNotes]);
  const [layerOrder, setLayerOrder] = useState<string[]>(activeLayerIds);
  useEffect(() => {
    setLayerOrder((current) => reconcileCanvasLayerOrder(current, activeLayerIds));
  }, [activeLayerIds]);
  const raiseLayer = useCallback((id: string): void => {
    setLayerOrder((current) => bringCanvasLayerToFront(current, id));
  }, []);
  const boundsByLayer = useMemo(() => {
    const result = new Map<string, SessionBounds>();
    for (const session of renderedSessions) result.set(terminalLayerId(session.id), session);
    for (const instance of renderedPluginCanvas) {
      if (renderablePluginIds.has(instance.id)) result.set(pluginLayerId(instance.id), instance);
    }
    if (renderedBrowserCanvas) result.set(browserLayerId, renderedBrowserCanvas);
    for (const note of renderedStickyNotes) result.set(noteLayerId(note.id), note);
    return result;
  }, [renderablePluginIds, renderedBrowserCanvas, renderedPluginCanvas, renderedSessions, renderedStickyNotes]);
  const browserOccluded = renderedBrowserCanvas !== null
    && canvasLayerIsOccluded(browserLayerId, layerOrder, boundsByLayer);

  const focusController = useCanvasWidgetFocus({
    viewport,
    settings,
    activeSessionId,
    browserSelected,
    widgetTreeVersion: [
      browserViewVisible ? "browser-visible" : "browser-hidden",
      settings.browserCanvas ? "browser-card" : "no-browser-card",
      sessions.map((session) => session.id).join(","),
      plugins.map((plugin) => [
        plugin.manifest.id,
        plugin.enabled ? "enabled" : "disabled",
        plugin.manifest.contributions.map((contribution) => contribution.id).join(",")
      ].join(":")).join(";"),
      settings.pluginCanvas.map((instance) => instance.id).join(","),
      settings.stickyNotes.map((note) => note.id).join(","),
      settings.homeLayout.map((placement) => placement.widgetId).join(",")
    ].join("|")
  });
  const wheelNavigation = useCanvasWheelNavigation({
    viewport,
    settings,
    cameraRef,
    widgetFocusRef: focusController.stateRef,
    commitCamera
  });
  const pointerNavigation = useCanvasPointerNavigation({
    viewport,
    settings,
    cameraRef,
    canvasOverrideActiveRef: wheelNavigation.canvasOverrideActiveRef,
    commitCamera
  });
  const widgetFocus = focusController.state;
  const routeWidgetWheelToCanvas = wheelNavigation.routeWidgetWheelToCanvas;
  const canvasOverrideActive = wheelNavigation.canvasOverrideActive;
  const homeBounds: SessionBounds = {
    position: { x: 0, y: 0 },
    size: homeGridPixelSize(settings.homeGridSize)
  };
  const homeLayoutValid = homeLayoutFitsGrid(settings.homeLayout, settings.homeGridSize);
  const editedRegion = regionEditor?.mode === "edit"
    ? settings.canvasRegions.find((region) => region.id === regionEditor.regionId) ?? null
    : null;
  const contextRegion = contextMenu?.kind === "region"
    ? settings.canvasRegions.find((region) => region.id === contextMenu.targetId) ?? null
    : null;

  const viewportPoint = useCallback((clientX: number, clientY: number): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    return { x: clientX - (bounds?.left ?? 0), y: clientY - (bounds?.top ?? 0) };
  }, []);
  const menuPosition = useCallback((clientX: number, clientY: number): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return { x: 12, y: 12 };
    return clampCanvasMenuPosition(
      viewportPoint(clientX, clientY),
      { width: bounds.width, height: bounds.height },
      { width: 300 * settings.uiScale, height: 380 * settings.uiScale }
    );
  }, [settings.uiScale, viewportPoint]);
  const worldPoint = useCallback((clientX: number, clientY: number): Point => {
    const point = viewportPoint(clientX, clientY);
    return {
      x: (point.x - camera.x) / camera.zoom,
      y: (point.y - camera.y) / camera.zoom
    };
  }, [camera.x, camera.y, camera.zoom, viewportPoint]);
  const viewportCenterWorldPoint = useCallback((): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    return {
      x: ((bounds?.width ?? 1) / 2 - camera.x) / camera.zoom,
      y: ((bounds?.height ?? 1) / 2 - camera.y) / camera.zoom
    };
  }, [camera.x, camera.y, camera.zoom]);
  const centerMenuPosition = useCallback((): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    return {
      x: Math.max(12, (bounds?.width ?? 320) / 2 - 150 * settings.uiScale),
      y: Math.max(12, (bounds?.height ?? 420) / 2 - 120 * settings.uiScale)
    };
  }, [settings.uiScale]);
  const createNote = useCallback((point: Point): void => {
    const note = stickyNoteAtPoint(point, crypto.randomUUID());
    onCreateStickyNote(note);
    setNoteEditRequest((current) => ({ id: note.id, version: (current?.version ?? 0) + 1 }));
    setContextMenu(null);
    setCommandPaletteOpen(false);
  }, [onCreateStickyNote]);
  const launchAt = useCallback((provider: ProviderId, point?: Point): void => {
    if (provider === "terminal") onOpenTerminal(point);
    else onOpenAgent(provider, point);
    setContextMenu(null);
    setCommandPaletteOpen(false);
  }, [onOpenAgent, onOpenTerminal]);

  useEffect(() => {
    if (homeEditing || !browserViewVisible) {
      setContextMenu(null);
      setRegionEditor(null);
      setCommandPaletteOpen(false);
      return;
    }
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setContextMenu(null);
        setRegionEditor(null);
        setCommandPaletteOpen((current) => !current);
      } else if (event.key === ",") {
        event.preventDefault();
        setContextMenu(null);
        setRegionEditor(null);
        setCommandPaletteOpen(false);
        onOpenSettings();
      }
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [browserViewVisible, homeEditing, onOpenSettings]);

  const allWindowBounds: SessionBounds[] = [
    ...renderedSessions,
    ...renderedPluginCanvas.filter((instance) => renderablePluginIds.has(instance.id)),
    ...(renderedBrowserCanvas ? [renderedBrowserCanvas] : []),
    ...renderedStickyNotes
  ];

  return (
    <div
      ref={viewport}
      className={`workspace pattern-${settings.pattern} ${pointerNavigation.panning ? "workspace--panning" : ""} ${canvasOverrideActive ? "workspace--canvas-override" : ""}`}
      onPointerDownCapture={(event) => {
        const element = event.target as HTMLElement;
        if (event.button === 0) {
          const layerId = element.closest<HTMLElement>("[data-canvas-layer-id]")?.dataset.canvasLayerId;
          if (layerId) raiseLayer(layerId);
        }
        if (contextMenu && !element.closest(".canvas-menu")) setContextMenu(null);
        if (regionEditor && !element.closest(".canvas-region-editor")) setRegionEditor(null);
        if (pointerNavigation.handlePointerDownCapture(event)) return;
        const target = canvasWidgetTarget(event.target);
        if (target.focusableWidgetId !== null) {
          focusController.cancelHover();
          focusController.focus(target.focusableWidgetId, "explicit");
        }
        if (!element.closest(".terminal-card, .browser-card")) onClearCanvasSelection();
      }}
      onClickCapture={(event) => {
        if (!pointerNavigation.handleClickCapture(event)) focusController.handleClick(event);
      }}
      onAuxClickCapture={pointerNavigation.handleAuxClickCapture}
      onPointerOverCapture={focusController.handlePointerOver}
      onPointerOutCapture={focusController.handlePointerOut}
      onPointerDown={pointerNavigation.handlePointerDown}
      onPointerMove={pointerNavigation.handlePointerMove}
      onPointerUp={pointerNavigation.handlePointerEnd}
      onPointerCancel={pointerNavigation.handlePointerEnd}
      onPointerLeave={pointerNavigation.handlePointerLeave}
      onContextMenu={(event) => {
        const element = event.target as HTMLElement;
        const regionId = element.closest<HTMLElement>("[data-canvas-region-id]")?.dataset.canvasRegionId;
        const noteId = element.closest<HTMLElement>("[data-sticky-note-id]")?.dataset.stickyNoteId;
        const hit: CanvasContextHit = element.closest("textarea, input, [contenteditable='true'], .terminal-card, .plugin-canvas-card, .browser-card")
          ? "native"
          : noteId
            ? "note"
            : regionId
              ? "region"
              : element.closest(".home-zone, .canvas-overlays, .canvas-menu, .canvas-region-editor, [data-interactive='true']")
                ? "blocked"
                : "empty";
        const kind = routeCanvasContextMenu(hit, homeEditing);
        if (!kind) return;
        event.preventDefault();
        setRegionEditor(null);
        setCommandPaletteOpen(false);
        setContextMenu({
          kind,
          position: menuPosition(event.clientX, event.clientY),
          worldPoint: worldPoint(event.clientX, event.clientY),
          targetId: kind === "region" ? regionId : kind === "note" ? noteId : undefined
        });
      }}
    >
      <div className="workspace__scene" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        <div className={`workspace__regions ${homeEditing ? "workspace__windows--hidden" : ""}`} aria-hidden={homeEditing}>
          {renderedCanvasRegions.map((region) => (
            <CanvasRegionCard
              key={region.id}
              region={region}
              zoom={camera.zoom}
              snapEnabled={settings.snapToGrid}
              snapTargets={[
                homeBounds,
                ...renderedCanvasRegions
                  .filter((candidate) => candidate.id !== region.id)
                  .map((candidate) => ({ position: candidate.position, size: candidate.size }))
              ]}
              onBoundsChange={onCanvasRegionBoundsChange}
              onMovePreview={updateRegionMovePreview}
            />
          ))}
        </div>
        <HomeZone
          settings={settings}
          mediaData={mediaData}
          sessions={sessions}
          limits={limits}
          limitsLoadState={limitsLoadState}
          plugins={plugins}
          editing={homeEditing}
          onOpenSettings={onOpenSettings}
          onOpenAgent={onOpenAgent}
          onOpenTerminal={onOpenTerminal}
          onOpenBrowser={() => {
            if (settings.browserCanvas) {
              raiseLayer(browserLayerId);
              focusController.focusBrowser();
            }
            onOpenBrowser();
          }}
          onFocusSession={(session) => {
            raiseLayer(terminalLayerId(session.id));
            focusController.focus(terminalCanvasWidgetId(session.id), "explicit");
            onFocusSession(session);
          }}
          onRequestMedia={onRequestMedia}
          onRemoveMedia={onRemoveMedia}
          onLayoutChange={onHomeLayoutChange}
          onGridSizeChange={onHomeGridSizeChange}
          onPluginError={onPluginError}
          captureCanvasWheelOverWidgets={routeWidgetWheelToCanvas}
          focusedWidgetId={widgetFocus.id}
          onWidgetFocus={(id) => {
            focusController.cancelHover();
            focusController.focus(id, "explicit");
          }}
          onWidgetHoverChange={(id, active) => {
            if (active) focusController.scheduleHover(id);
            else focusController.cancelHover(id);
          }}
          onPluginCanvasWheel={wheelNavigation.applyCanvasWheel}
        />
        <div className={`workspace__windows ${homeEditing ? "workspace__windows--hidden" : ""}`} aria-hidden={homeEditing}>
          {renderedSessions.map((session) => (
            <TerminalCard
              key={session.id}
              session={session}
              locale={settings.locale}
              palette={settings.palette}
              zoom={camera.zoom}
              stackIndex={canvasLayerZIndex(layerOrder, terminalLayerId(session.id))}
              snapEnabled={settings.snapToGrid}
              focusActivation={settings.focusActivation}
              invertTerminalWheel={settings.invertTerminalWheel}
              captureCanvasWheelOverWidgets={routeWidgetWheelToCanvas || widgetFocus.id !== terminalCanvasWidgetId(session.id)}
              focused={widgetFocus.id === terminalCanvasWidgetId(session.id)}
              focusChangeSource={widgetFocus.source}
              selected={activeSessionId === session.id}
              renaming={renamingSessionId === session.id}
              snapTargets={[
                homeBounds,
                ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
                ...allWindowBounds.filter((candidate) => candidate !== session)
              ]}
              onActivate={(selectedSession) => {
                raiseLayer(terminalLayerId(selectedSession.id));
                focusController.focus(terminalCanvasWidgetId(selectedSession.id), "explicit");
                onFocusSession(selectedSession);
              }}
              onSelect={onSelectSession}
              onRename={onRenameSession}
              onRenameEnd={onRenameEnd}
              onBoundsChange={onSessionBoundsChange}
              onRestart={onRestartSession}
              onDispose={onDisposeSession}
              onOpenUrl={onOpenTerminalUrl}
            />
          ))}
          {renderedPluginCanvas.map((instance) => {
            const plugin = plugins.find((candidate) => candidate.manifest.id === instance.pluginId && candidate.enabled);
            const contribution = plugin?.manifest.contributions.find((candidate) => candidate.id === instance.contributionId);
            if (!plugin || !contribution || contribution.kind !== "canvas-app") return null;
            return (
              <PluginCanvasCard
                key={instance.id}
                instance={instance}
                plugin={plugin}
                contribution={contribution}
                locale={settings.locale}
                palette={settings.palette}
                zoom={camera.zoom}
                stackIndex={canvasLayerZIndex(layerOrder, pluginLayerId(instance.id))}
                snapEnabled={settings.snapToGrid}
                sessions={sessions}
                limits={limits}
                snapTargets={[
                  homeBounds,
                  ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
                  ...allWindowBounds.filter((candidate) => candidate !== instance)
                ]}
                onActivate={() => {
                  raiseLayer(pluginLayerId(instance.id));
                  focusController.focus(pluginCanvasWidgetId(instance.id), "explicit");
                  onFocusPluginCanvas(instance.id);
                }}
                onBoundsChange={onPluginCanvasBoundsChange}
                onDispose={onDisposePluginCanvas}
                onOpenLauncher={(provider) => launchAt(provider)}
                onError={onPluginError}
                captureCanvasWheelOverWidgets={routeWidgetWheelToCanvas || widgetFocus.id !== pluginCanvasWidgetId(instance.id)}
                onWidgetFocus={() => {
                  raiseLayer(pluginLayerId(instance.id));
                  focusController.cancelHover();
                  focusController.focus(pluginCanvasWidgetId(instance.id), "explicit");
                }}
                onWidgetHoverChange={(active) => {
                  if (active) focusController.scheduleHover(pluginCanvasWidgetId(instance.id));
                  else focusController.cancelHover(pluginCanvasWidgetId(instance.id));
                }}
                onCanvasWheel={wheelNavigation.applyCanvasWheel}
              />
            );
          })}
          {renderedBrowserCanvas && (
            <BrowserCard
              browser={browser}
              bounds={renderedBrowserCanvas}
              locale={settings.locale}
              zoom={camera.zoom}
              camera={camera}
              visible={browserViewVisible && !homeEditing && contextMenu === null
                && regionEditor === null && !commandPaletteOpen && !browserOccluded}
              stackIndex={canvasLayerZIndex(layerOrder, browserLayerId)}
              uiScale={settings.uiScale}
              snapEnabled={settings.snapToGrid}
              focusActivation={settings.focusActivation}
              focused={widgetFocus.id === browserCanvasWidgetId}
              selected={browserSelected}
              showAgentPresence={settings.browserShowAgentPresence}
              snapTargets={[
                homeBounds,
                ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
                ...allWindowBounds.filter((candidate) => candidate !== renderedBrowserCanvas)
              ]}
              onBoundsChange={onBrowserBoundsChange}
              onActivate={() => {
                raiseLayer(browserLayerId);
                focusController.focusBrowser();
                onFocusBrowser();
              }}
              onSelect={() => {
                raiseLayer(browserLayerId);
                onSelectBrowser();
              }}
              onWidgetFocus={() => {
                raiseLayer(browserLayerId);
                focusController.focusBrowser();
              }}
              onWidgetHoverChange={focusController.hoverBrowser}
              onClose={onCloseBrowser}
              onError={onPluginError}
            />
          )}
          {renderedStickyNotes.map((note) => (
            <StickyNoteCard
              key={note.id}
              note={note}
              locale={settings.locale}
              zoom={camera.zoom}
              stackIndex={canvasLayerZIndex(layerOrder, noteLayerId(note.id))}
              editRequest={noteEditRequest?.id === note.id ? noteEditRequest.version : 0}
              snapEnabled={settings.snapToGrid}
              snapTargets={[
                homeBounds,
                ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
                ...allWindowBounds.filter((candidate) => candidate !== note)
              ]}
              onBoundsChange={onStickyNoteBoundsChange}
              onTextChange={onStickyNoteTextChange}
              onClose={onDeleteStickyNote}
            />
          ))}
        </div>
      </div>

      {homeEditing && (
        <div className="home-editor-toolbar" data-interactive="true">
          <strong>{t(settings.locale, "homeEditor")}</strong>
          <button type="button" onClick={onResetHomeLayout}>{t(settings.locale, "resetHome")}</button>
          <button className="home-editor-toolbar__done" type="button" disabled={!homeLayoutValid}
            title={homeLayoutValid ? undefined : t(settings.locale, "homeLayoutOutside")}
            onClick={onFinishHomeEdit}>{t(settings.locale, "doneEditing")}</button>
        </div>
      )}

      {contextMenu && (
        <CanvasContextMenu
          kind={contextMenu.kind}
          position={contextMenu.position}
          locale={settings.locale}
          launcherItems={settings.canvasLauncherItems}
          currentRegionColor={contextRegion?.color ?? null}
          onCreateRegion={() => {
            setRegionEditor({ mode: "create", focus: "title", position: contextMenu.position, worldPoint: contextMenu.worldPoint });
            setContextMenu(null);
          }}
          onCreateNote={() => createNote(contextMenu.worldPoint)}
          onLaunch={(provider) => launchAt(provider, contextMenu.worldPoint)}
          onOpenBrowser={() => {
            onOpenBrowser(contextMenu.worldPoint);
            setContextMenu(null);
          }}
          onOpenSettings={() => {
            onOpenSettings();
            setContextMenu(null);
          }}
          onRenameRegion={() => {
            if (!contextMenu.targetId) return;
            setRegionEditor({ mode: "edit", focus: "title", position: contextMenu.position, regionId: contextMenu.targetId });
            setContextMenu(null);
          }}
          onChangeRegionColor={(color) => {
            if (!contextRegion) return;
            onChangeCanvasRegion({ ...contextRegion, color });
            setContextMenu(null);
          }}
          onDeleteRegion={() => {
            if (contextMenu.targetId) onDeleteCanvasRegion(contextMenu.targetId);
            setContextMenu(null);
          }}
          onEditNote={() => {
            if (contextMenu.targetId) {
              raiseLayer(noteLayerId(contextMenu.targetId));
              setNoteEditRequest((current) => ({ id: contextMenu.targetId!, version: (current?.version ?? 0) + 1 }));
            }
            setContextMenu(null);
          }}
          onBringNoteToFront={() => {
            if (contextMenu.targetId) raiseLayer(noteLayerId(contextMenu.targetId));
            setContextMenu(null);
          }}
          onDeleteNote={() => {
            if (contextMenu.targetId) onDeleteStickyNote(contextMenu.targetId);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {regionEditor && (regionEditor.mode === "create" || editedRegion) && (
        <CanvasRegionMenu
          key={regionEditor.mode === "create" ? "create" : `edit:${regionEditor.regionId}:${regionEditor.focus}`}
          mode={regionEditor.mode}
          focus={regionEditor.focus}
          position={regionEditor.position}
          initialTitle={regionEditor.mode === "create" ? t(settings.locale, "canvasRegionDefaultName") : editedRegion!.title}
          initialColor={regionEditor.mode === "create" ? CANVAS_REGION_COLORS[0] : editedRegion!.color}
          locale={settings.locale}
          onSubmit={(title, color) => {
            if (regionEditor.mode === "create") {
              onCreateCanvasRegion(canvasRegionAtPoint(title, color, regionEditor.worldPoint, crypto.randomUUID()));
            } else if (editedRegion) {
              onChangeCanvasRegion({ ...editedRegion, title, color });
            }
            setRegionEditor(null);
          }}
          onClose={() => setRegionEditor(null)}
        />
      )}

      {commandPaletteOpen && (
        <CanvasCommandPalette
          locale={settings.locale}
          sessions={sessions}
          launcherItems={settings.canvasLauncherItems}
          onFocusSession={(session) => {
            raiseLayer(terminalLayerId(session.id));
            focusController.focus(terminalCanvasWidgetId(session.id), "explicit");
            onFocusSession(session);
          }}
          onLaunch={(provider) => launchAt(provider, viewportCenterWorldPoint())}
          onCreateRegion={() => {
            setCommandPaletteOpen(false);
            setRegionEditor({ mode: "create", focus: "title", position: centerMenuPosition(), worldPoint: viewportCenterWorldPoint() });
          }}
          onCreateNote={() => createNote(viewportCenterWorldPoint())}
          onOpenBrowser={() => onOpenBrowser(viewportCenterWorldPoint())}
          onOpenSettings={onOpenSettings}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}

      <div className="canvas-overlays">
        {CANVAS_OVERLAY_PLACEMENTS.map((placement) => (
          <div className={`canvas-overlay-slot canvas-overlay-slot--${placement}`} key={placement}>
            {settings.minimapPlacement === placement && (
              <CanvasMinimap viewport={viewport} camera={camera} homeBounds={homeBounds}
                canvasRegions={renderedCanvasRegions} sessions={renderedSessions} stickyNotes={renderedStickyNotes}
                pluginCanvas={renderedPluginCanvas} browserCanvas={renderedBrowserCanvas}
                locale={settings.locale} interactionMode={settings.minimapInteractionMode}
                onCameraChange={commitCamera} />
            )}
            {settings.canvasControlsPlacement === placement && (
              <div className="canvas-controls" data-interactive="true">
                <button type="button" onClick={onGoHome} title={t(settings.locale, "home")}><UiIcon name="home" size={17} /></button>
                <button type="button" onClick={() => wheelNavigation.zoomBy(0.82)} title={t(settings.locale, "zoomOut")}><UiIcon name="zoom-out" size={17} /></button>
                <button type="button" onClick={() => wheelNavigation.zoomBy(1.22)} title={t(settings.locale, "zoomIn")}><UiIcon name="zoom-in" size={17} /></button>
              </div>
            )}
            {settings.showShortcutHints && settings.shortcutHintsPlacement === placement && (
              <aside className="shortcut-hints" aria-label={t(settings.locale, "keyboardShortcuts")}>
                <div><kbd>{settings.shortcuts.home}</kbd><span>{t(settings.locale, "homeShortcut")}</span></div>
                <div><kbd>{settings.shortcuts.renameWindow}</kbd><span>{t(settings.locale, "renameWindow")}</span></div>
                {settings.canvasWheelCaptureMode === "key" && settings.canvasWheelOverride !== null && (
                  <div><kbd>{displayCanvasNavigationBinding(settings.canvasWheelOverride, window.canvasTTY.window.isMacOS)}</kbd>
                    <span>{t(settings.locale, "canvasWheelOverrideHint")}</span></div>
                )}
                {settings.canvasNavigationOverride !== null && (
                  <div><kbd>{displayCanvasNavigationBinding(settings.canvasNavigationOverride, window.canvasTTY.window.isMacOS)}</kbd>
                    <span>{t(settings.locale, "canvasNavigationOverrideHint")}</span></div>
                )}
              </aside>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function copyBounds(bounds: SessionBounds): SessionBounds {
  return {
    position: { ...bounds.position },
    size: { ...bounds.size }
  };
}

function containedBounds<T extends SessionBounds & { id: string }>(
  items: readonly T[],
  region: CanvasRegion
): ReadonlyMap<string, SessionBounds> {
  return new Map(items
    .filter((item) => boundsInsideRegion(item, region))
    .map((item) => [item.id, copyBounds(item)]));
}

const browserLayerId = "browser";

function terminalLayerId(id: string): string {
  return `terminal:${id}`;
}

function pluginLayerId(id: string): string {
  return `plugin:${id}`;
}

function noteLayerId(id: string): string {
  return `note:${id}`;
}
