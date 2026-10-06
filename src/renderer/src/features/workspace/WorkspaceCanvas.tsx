import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { BUNDLED_CANVAS_BACKGROUND_IDS } from "../../../../shared/contracts";
import type {
  AgentProviderId,
  AgentChatHistoryItem,
  AppSettings,
  BrowserCanvasState,
  BrowserSnapshot,
  CameraState,
  CanvasMaterial,
  CanvasOverlayPlacement,
  CanvasRegion,
  HomeGridSize,
  HomeWidgetPlacement,
  InstalledPlugin,
  LimitsSnapshot,
  MaterialHandoff,
  MaterialRemark,
  Point,
  ProviderId,
  RadialLauncherItemId,
  RemarkAnchor,
  RemarkDraft,
  SessionBounds,
  SessionSnapshot,
  Size,
  StickyNote
} from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { displayCanvasNavigationBinding, isRenameInputTarget, isShortcutCaptureTarget, matchesPhysicalOrLayoutKey, matchesShortcut, shouldKeepNativeKeyboardInput } from "../../lib/shortcuts";
import { BrowserCard } from "../browser/BrowserCard";
import { attentionQueueRenderedAt, attentionSessions } from "../home/attentionQueue";
import type { LimitsLoadState } from "../home/homeModel";
import { homeGridPixelSize, homeLayoutFitsGrid } from "../home/homeLayout";
import { HomeZone } from "../home/HomeZone";
import { SessionFailureDetails, sessionFailureDetails } from "../home/SessionFailureDetails";
import { sessionStatusLabel } from "../../lib/sessionStatus";
import { sessionStatusTone } from "../../lib/sessionStatusTone";
import { RadialLauncher } from "../launcher/QuickRadialMenu";
import { StickyNoteCard } from "../notes/StickyNoteCard";
const MaterialCard = lazy(() => import("../materials/MaterialCard").then((module) => ({ default: module.MaterialCard })));
import { remarkDrawable, remarkPickable, type MaterialCommand } from "../materials/materialCardModel";
import { remarkNeedsWork } from "../materials/materialRemarksModel";
import { RemarkPopover } from "../materials/RemarkPopover";
import { useRemarkDraft } from "../materials/useRemarkDraft";
import { stickyNoteAtPoint } from "../notes/stickyNoteBounds";
import { PluginCanvasCard } from "../plugins/PluginCanvasCard";
import { TerminalCard } from "../terminal/TerminalCard";
import { shouldTogglePixelSkinMasterView } from "../terminal/terminalShortcuts";
import { isPixelSkinThemeId } from "../skins/skinCatalog";
import { isPixelSkinPackId, usePixelSkinPackAssets } from "../skins/SkinAssets";
import { CanvasCommandPalette } from "./CanvasCommandPalette";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { CanvasMinimap } from "./CanvasMinimap";
import { AgentChatHistoryHud } from "./AgentChatHistoryHud";
import { CanvasRegionCard } from "./CanvasRegionCard";
import { CanvasRegionMenu } from "./CanvasRegionMenu";
import { cameraFittingContent } from "./canvasCameraGeometry";
import { fixedCameraStore, sceneTransform, useCameraSelector, type CameraStore } from "./cameraStore";
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
  boundsEqual,
  boundsOverlap,
  bringCanvasLayerToFront,
  canvasLayerIsOccluded,
  canvasLayerZIndex,
  canvasScreenRect,
  keepLiveIds,
  pruneToLive,
  reconcileCanvasLayerOrder,
  snapTargetGetters
} from "./canvasStacking";
import type { SnapLayout } from "./canvasStacking";
import {
  acceptsTextInput,
  browserCanvasWidgetId,
  canvasWidgetInDirection,
  canvasWidgetTarget,
  pluginCanvasWidgetId,
  terminalCanvasWidgetId,
  type CanvasFocusCandidate,
  type CanvasFocusDirection
} from "./canvasWidgetFocus";
import { boundsIntersect } from "./minimapGeometry";
import {
  browserLayerId,
  materialLayerId,
  noteLayerId,
  parseCanvasLayerId,
  pluginLayerId,
  terminalLayerId
} from "./canvasSelectionGesture";
import { snapMove } from "./snap";
import { useCanvasPointerNavigation } from "./useCanvasPointerNavigation";
import { useCanvasWheelNavigation } from "./useCanvasWheelNavigation";
import { useCanvasWidgetFocus } from "./useCanvasWidgetFocus";
import { useRemarkPopoverRect } from "./useRemarkPopoverRect";
import { webglContextPool } from "../terminal/webglContextPool";

const CANVAS_OVERLAY_PLACEMENTS: readonly CanvasOverlayPlacement[] = [
  "top-left",  "top-right",
  "bottom-left",
  "bottom-right"
];

const EMPTY_MARQUEE_SELECTION: ReadonlySet<string> = new Set<string>();
const NO_SNAP_TARGETS = (): readonly SessionBounds[] => [];
/** The fullscreen layer is outside the scene: its card always draws at scale 1. */
const FULLSCREEN_CAMERA = fixedCameraStore({ x: 0, y: 0, zoom: 1 });

const CANVAS_FOCUS_ARROWS: Readonly<Record<string, CanvasFocusDirection | undefined>> = {
  focusUp: "up",
  focusDown: "down",
  focusLeft: "left",
  focusRight: "right"
};

/** What the workspace does for a terminal card; the card gets stable functions that call the latest of these. */
interface TerminalCardHandlers {
  activate(selectedSession: SessionSnapshot, fullscreen: boolean): void;
  select(id: string, fullscreen: boolean): void;
  toggleFullscreen(id: string): void;
  rename(id: string, title: string): Promise<void>;
  renameEnd(): void;
  boundsChange(id: string, bounds: SessionBounds): void;
  restart(id: string, resume?: boolean): Promise<void>;
  dispose(id: string, keepEnvironmentData?: boolean): void;
  openUrl(url: string): void;
}

/** A group drag's commit basis, frozen once when the press activates: the pressed layer's start
 * bounds plus every member's, so nothing the gesture itself previews can feed back into it. */
type GroupDragBasis = {
  layerId: string;
  anchor: SessionBounds;
  members: ReadonlyMap<string, SessionBounds>;
};

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
  materialBounds: ReadonlyMap<string, SessionBounds>;
};

interface WorkspaceCanvasProps {
  settings: AppSettings;
  /**
   * False for the first frame after startup: restored terminals (xterm), plugin canvas iframes and the browser card
   * mount right after that frame was painted, so HOME and the canvas show without waiting for them. Their layout
   * (layers, snap targets, the HOME session list) is known from the start. Defaults to true.
   */
  surfacesMounted?: boolean;
  mediaData: string | null;
  sessions: SessionSnapshot[];
  limits: LimitsSnapshot | null;
  limitsLoadState: LimitsLoadState;
  plugins: InstalledPlugin[];
  browser: BrowserSnapshot;
  browserViewVisible: boolean;
  homeEditing: boolean;
  /** The canvas camera; the workspace does not render when it moves (see cameraStore). */
  camera: CameraStore;
  onCameraChange(camera: CameraState): void;
  onGoHome(): void;
  onOpenSettings(): void;
  onOpenShortcutReference(): void;
  onOpenAgent(provider: AgentProviderId, position?: Point): void;
  onOpenTerminal(position?: Point): void;
  onOpenBrowser(position?: Point): void;
  onOpenTerminalUrl(url: string): void;
  onFocusSession(session: SessionSnapshot): void;
  onResumeHistory(item: AgentChatHistoryItem, position: Point): Promise<SessionSnapshot>;
  activeSessionId: string | null;
  browserSelected: boolean;
  renamingSessionId: string | null;
  fullscreenSessionId: string | null;
  onToggleFullscreen(id: string): void;
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
  onRestartSession(id: string, resume?: boolean): Promise<void>;
  onDisposeSession(id: string, keepEnvironmentData?: boolean): void;
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
  materials: readonly CanvasMaterial[];
  onAddMaterialFiles(files: File[], point: Point): void;
  onPickMaterials(point: Point): void;
  onPasteMaterials(point: Point): void;
  onMaterialBoundsChange(id: string, bounds: SessionBounds): void;
  onMaterialBoundsChangeBatch(entries: { id: string; bounds: SessionBounds }[]): void;
  onRemoveMaterial(id: string): void;
  onMaterialCommand(id: string, command: MaterialCommand): void;
  remarks: readonly MaterialRemark[];
  handoffs: readonly MaterialHandoff[];
  onAddRemark(draft: RemarkDraft): Promise<boolean>;
  onRemarkAction(remarkId: string, action: "delete"): void;
  onSendMaterialRemarks(materialId: string): void;
  onSendAllRemarks(): void;
}

export function WorkspaceCanvas(props: WorkspaceCanvasProps): React.JSX.Element {
  const {
    settings, mediaData, sessions, limits, limitsLoadState, plugins, browser,
    browserViewVisible, homeEditing, camera, onCameraChange, onGoHome,
    onOpenSettings, onOpenAgent, onOpenTerminal, onOpenBrowser, onOpenTerminalUrl, onFocusSession,
    activeSessionId, browserSelected, renamingSessionId, fullscreenSessionId, onToggleFullscreen, onSelectSession,
    onSelectBrowser, onClearCanvasSelection, onRenameSession, onRenameEnd,
    onRequestMedia, onRemoveMedia, onHomeLayoutChange, onHomeGridSizeChange,
    onFinishHomeEdit, onResetHomeLayout, onPluginError, onPluginCanvasBoundsChange,
    onDisposePluginCanvas, onFocusPluginCanvas, onSessionBoundsChange,
    onRestartSession, onDisposeSession, onBrowserBoundsChange, onFocusBrowser,
    onCloseBrowser, onCreateCanvasRegion, onChangeCanvasRegion,
    onCanvasRegionBoundsChange, onDeleteCanvasRegion, onCreateStickyNote,
    onStickyNoteBoundsChange, onStickyNoteTextChange, onDeleteStickyNote,
    materials, onAddMaterialFiles, onPickMaterials, onPasteMaterials, onMaterialBoundsChange,
    onMaterialBoundsChangeBatch, onRemoveMaterial, onMaterialCommand, remarks, handoffs, onAddRemark, onRemarkAction,
    onSendMaterialRemarks, onSendAllRemarks, surfacesMounted = true
  } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<CanvasMenuState | null>(null);
  const [regionEditor, setRegionEditor] = useState<RegionEditorState | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [radialLauncher, setRadialLauncher] = useState<{
    anchor: Point;
    pointerAnchor: Point;
    canvasPosition: Point;
    pointerId: number;
  } | null>(null);
  const suppressNextContextMenu = useRef(false);
  const pendingRadialContextMenu = useRef<CanvasMenuState | null>(null);
  const [noteEditRequest, setNoteEditRequest] = useState<{ id: string; version: number } | null>(null);
  const [materialRemoveRequest, setMaterialRemoveRequest] = useState<{ id: string; version: number } | null>(null);
  const [regionMovePreview, setRegionMovePreview] = useState<RegionMovePreview | null>(null);
  const [marqueeSelection, setMarqueeSelection] = useState<ReadonlySet<string>>(EMPTY_MARQUEE_SELECTION);
  const [masterPixelSkinSessionIds, setMasterPixelSkinSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const overlays = useRef<HTMLDivElement>(null);
  const lastPointerClient = useRef<Point | null>(null);
  const [overlayRects, setOverlayRects] = useState<SessionBounds[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // The navigation hooks read the camera through a ref; this one always reads the store.
  const cameraRef = useMemo<MutableRefObject<CameraState>>(() => ({
    get current() { return camera.get(); },
    set current(next: CameraState) { camera.set(next); }
  }), [camera]);
  const commitCamera = useCallback((next: CameraState): void => {
    onCameraChange(next);
  }, [onCameraChange]);
  const scene = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The scene follows the camera without a React render: the transform is written straight to the DOM,
    // synchronously, before anything that measures the scene (the browser card) renders.
    const apply = (): void => {
      if (scene.current) scene.current.style.transform = sceneTransform(camera.get());
    };
    apply();
    return camera.subscribe(() => {
      apply();
      // What each terminal card covers on screen decides which ones draw with WebGL. The pool waits for the
      // camera to settle, so a pan only restarts its timer.
      webglContextPool().viewportChanged();
    });
  }, [camera]);
  useEffect(() => {
    webglContextPool().viewportChanged();
  }, [homeEditing, fullscreenSessionId]);

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
        noteBounds: containedBounds(settings.stickyNotes, startRegion),
        materialBounds: containedBounds(materials, startRegion)
      };
    });
  }, [materials, sessions, settings.browserCanvas, settings.canvasRegions, settings.pluginCanvas, settings.stickyNotes]);

  // A press can lose its pointer (window blur, leaving Edit HOME) before it reaches a
  // pointer-up, so the scene drops any live preview instead of leaving it stuck.
  const clearRegionMovePreview = useCallback((): void => {
    setRegionMovePreview(null);
  }, []);

  useEffect(() => {
    window.addEventListener("blur", clearRegionMovePreview);
    return () => window.removeEventListener("blur", clearRegionMovePreview);
  }, [clearRegionMovePreview]);

  useEffect(() => {
    if (homeEditing) clearRegionMovePreview();
  }, [clearRegionMovePreview, homeEditing]);

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
  const { remarkDraft, selectedRemarkId, materialNames, remarkActions, remarkingFor } = useRemarkDraft({
    materials,
    remarks,
    onAddRemark,
    onRemarkAction,
    onSendMaterialRemarks
  });
  const renderedMaterials = useMemo(() => materials.map((material) => {
    const start = regionMovePreview?.materialBounds.get(material.id);
    return start && previewDelta ? { ...material, ...translateBounds(start, previewDelta) } : material;
  }), [materials, previewDelta, regionMovePreview]);

  const renderablePluginIds = useMemo(() => new Set(settings.pluginCanvas.filter((instance) => {
    const plugin = plugins.find((candidate) => candidate.manifest.id === instance.pluginId && candidate.enabled);
    return plugin?.manifest.contributions.some((candidate) => (
      candidate.id === instance.contributionId && candidate.kind === "canvas-app"
    ));
  }).map((instance) => instance.id)), [plugins, settings.pluginCanvas]);
  const minimapPluginCanvas = useMemo(
    () => renderedPluginCanvas.filter((instance) => renderablePluginIds.has(instance.id)),
    [renderedPluginCanvas, renderablePluginIds]
  );
  const activeLayerIds = useMemo(() => [
    ...renderedSessions.map((session) => terminalLayerId(session.id)),
    ...renderedPluginCanvas.filter((instance) => renderablePluginIds.has(instance.id)).map((instance) => pluginLayerId(instance.id)),
    ...(renderedBrowserCanvas ? [browserLayerId] : []),
    ...renderedStickyNotes.map((note) => noteLayerId(note.id)),
    ...renderedMaterials.map((material) => materialLayerId(material.id))
  ], [renderablePluginIds, renderedBrowserCanvas, renderedMaterials, renderedPluginCanvas, renderedSessions, renderedStickyNotes]);
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
    for (const material of renderedMaterials) result.set(materialLayerId(material.id), material);
    return result;
  }, [renderablePluginIds, renderedBrowserCanvas, renderedMaterials, renderedPluginCanvas, renderedSessions, renderedStickyNotes]);
  // Every window on the canvas, in the order they are rendered: terminals, plugin canvases, browser, notes, materials.
  const allWindowBounds = useMemo((): SessionBounds[] => [
    ...renderedSessions,
    ...renderedPluginCanvas.filter((instance) => renderablePluginIds.has(instance.id)),
    ...(renderedBrowserCanvas ? [renderedBrowserCanvas] : []),
    ...renderedStickyNotes,
    ...renderedMaterials
  ], [renderablePluginIds, renderedBrowserCanvas, renderedMaterials, renderedPluginCanvas, renderedSessions, renderedStickyNotes]);
  const focusCandidates: CanvasFocusCandidate[] = [
    ...renderedSessions.map((session) => ({ id: terminalCanvasWidgetId(session.id), bounds: session })),
    ...renderedPluginCanvas
      .filter((instance) => renderablePluginIds.has(instance.id))
      .map((instance) => ({ id: pluginCanvasWidgetId(instance.id), bounds: instance })),
    ...(renderedBrowserCanvas ? [{ id: browserCanvasWidgetId, bounds: renderedBrowserCanvas }] : [])
  ];

  const homeBounds = useMemo((): SessionBounds => ({
    position: { x: 0, y: 0 },
    size: homeGridPixelSize(settings.homeGridSize)
  }), [settings.homeGridSize]);
  // Snap targets are built only for the card whose drag or resize starts, from the layout of that moment.
  const snapLayout = useRef<SnapLayout>({ fixed: [], windows: [], byLayer: new Map() });
  snapLayout.current = {
    get fixed() {
      return [homeBounds, ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size }))];
    },
    windows: allWindowBounds,
    byLayer: boundsByLayer
  };
  const [snapTargets] = useState(() => snapTargetGetters(() => snapLayout.current));
  useEffect(() => {
    snapTargets.prune(new Set(boundsByLayer.keys()));
  }, [boundsByLayer, snapTargets]);

  const selectMarquee = useCallback((bounds: SessionBounds | null): void => {
    if (bounds === null) {
      setMarqueeSelection(EMPTY_MARQUEE_SELECTION);
      return;
    }
    // Every rendered layer, not just terminals: the selection holds `data-canvas-layer-id` values.
    const ids = [...boundsByLayer]
      .filter(([, layerBounds]) => boundsIntersect(bounds, layerBounds))
      .map(([layerId]) => layerId);
    // Presentation-only: the marquee never moves logical input focus or the active
    // session, and a group drag is read from the selection alone.
    setMarqueeSelection(ids.length === 0 ? EMPTY_MARQUEE_SELECTION : new Set(ids));
  }, [boundsByLayer]);

  const groupDragBasis = useRef<GroupDragBasis | null>(null);

  const beginGroupDrag = useCallback((layerId: string): void => {
    const anchor = boundsByLayer.get(layerId);
    if (!anchor) return;
    // Frozen here, once: the preview moves the rendered bounds, so the commit must not
    // read them back, and a layer that appears mid-gesture is not part of this drag.
    const members = new Map<string, SessionBounds>();
    for (const memberLayerId of [layerId, ...marqueeSelection]) {
      const memberBounds = boundsByLayer.get(memberLayerId);
      if (memberBounds) members.set(memberLayerId, memberBounds);
    }
    groupDragBasis.current = { layerId, anchor, members };
  }, [boundsByLayer, marqueeSelection]);

  const commitGroupDrag = useCallback((layerId: string, delta: Point): void => {
    const basis = groupDragBasis.current;
    groupDragBasis.current = null;
    if (!basis || basis.layerId !== layerId) return;
    const { anchor, members } = basis;
    // The pressed card is the only one that snaps: one `snapMove` call yields a rigid
    // world delta applied to every member, so relative offsets survive. Members are
    // excluded from the targets, otherwise a card would snap onto its own neighbours.
    const targets = [
      homeBounds,
      ...renderedCanvasRegions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
      ...[...boundsByLayer]
        .filter(([candidateLayerId]) => !members.has(candidateLayerId))
        .map(([, candidateBounds]) => candidateBounds)
    ];
    const movedAnchor = translateBounds(anchor, delta);
    const anchorPosition = settings.snapToGrid
      ? snapMove(movedAnchor.position, anchor.size, targets)
      : movedAnchor.position;
    const rigid = {
      x: anchorPosition.x - anchor.position.x,
      y: anchorPosition.y - anchor.position.y
    };
    const materialBatch: { id: string; bounds: SessionBounds }[] = [];
    for (const [memberLayerId, memberBounds] of members) {
      const moved = translateBounds(memberBounds, rigid);
      const ref = parseCanvasLayerId(memberLayerId);
      if (!ref) continue;
      // Commit each window by its own identity, including individual Browser cards.
      if (ref.kind === "terminal" && ref.targetId !== null) onSessionBoundsChange(ref.targetId, moved);
      else if (ref.kind === "plugin" && ref.targetId !== null) onPluginCanvasBoundsChange(ref.targetId, moved);
      else if (ref.kind === "note" && ref.targetId !== null) onStickyNoteBoundsChange(ref.targetId, moved);
      else if (ref.kind === "material" && ref.targetId !== null) materialBatch.push({ id: ref.targetId, bounds: moved });
      else if (ref.kind === "browser" && settings.browserCanvas) onBrowserBoundsChange({ ...settings.browserCanvas, ...moved });
    }
    if (materialBatch.length > 0) onMaterialBoundsChangeBatch(materialBatch);
  }, [boundsByLayer, homeBounds, onBrowserBoundsChange, onMaterialBoundsChangeBatch, onPluginCanvasBoundsChange,
    onSessionBoundsChange, onStickyNoteBoundsChange, renderedCanvasRegions, settings.browserCanvas, settings.snapToGrid]);

  const focusController = useCanvasWidgetFocus({
    viewport,
    settings,
    activeSessionId,
    browserSelected,
    widgetTreeVersion: [
      browserViewVisible ? "browser-visible" : "browser-hidden",
      renderedBrowserCanvas ? "browser-card" : "no-browser-card",
      sessions.map((session) => session.id).join(","),
      plugins.map((plugin) => [
        plugin.manifest.id,
        plugin.enabled ? "enabled" : "disabled",
        plugin.manifest.contributions.map((contribution) => contribution.id).join(",")
      ].join(":")).join(";"),
      settings.pluginCanvas.map((instance) => instance.id).join(","),
      settings.stickyNotes.map((note) => note.id).join(","),
      materials.map((material) => material.id).join(","),
      settings.homeLayout.map((placement) => placement.widgetId).join(",")
    ].join("|")
  });
  // One owner for "bring this session to the front": HOME rows, attention and chat history
  // must both raise the card's layer, focus it, and apply the layer raise through onFocusSession.
  const focusSessionFromHome = useCallback((session: SessionSnapshot): void => {
    raiseLayer(terminalLayerId(session.id));
    focusController.focus(terminalCanvasWidgetId(session.id), "explicit");
    onFocusSession(session);
  }, [focusController, onFocusSession, raiseLayer]);
  const attention = useMemo(() => attentionSessions(renderedSessions), [renderedSessions]);
  // The page area is a native child view, so it composites above every DOM layer including this
  // HUD; the page can only yield by hiding. Slot boxes are measured instead of their children:
  // they are content-sized, which keeps this effect keyed to what can move or resize a slot and
  // not to every row inside the dynamic panels.
  useEffect(() => {
    const root = overlays.current;
    if (!root) return;
    const slots = [...root.querySelectorAll<HTMLElement>(".canvas-overlay-slot")];
    const measure = (): void => {
      const rootRect = root.getBoundingClientRect();
      const next = slots.map((slot) => {
        const rect = slot.getBoundingClientRect();
        return {
          position: { x: rect.left - rootRect.left, y: rect.top - rootRect.top },
          size: { width: rect.width, height: rect.height }
        };
      });
      // Compared by value: a re-render that leaves the layout alone must not publish new state,
      // otherwise the observer and the state update could ping-pong forever.
      setOverlayRects((current) => (
        next.length === current.length && next.every((rect, index) => boundsEqual(rect, current[index]))
          ? current
          : next
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const slot of slots) observer.observe(slot);
    return () => observer.disconnect();
  }, [
    attention.length,
    settings.attentionQueuePlacement,
    settings.attentionQueueVisible,
    settings.agentChatHistoryVisible,
    settings.agentChatHistoryPlacement,
    settings.canvasControlsPlacement,
    settings.minimapPlacement,
    settings.shortcutHintsPlacement,
    settings.showShortcutHints,
    settings.uiScale,
    remarkDraft?.picking
  ]);
  const browserOccluded = renderedBrowserCanvas !== null
    && canvasLayerIsOccluded(browserLayerId, layerOrder, boundsByLayer);
  const selectedRemark = selectedRemarkId ? remarks.find((remark) => remark.id === selectedRemarkId) ?? null : null;
  const popoverMaterial = remarkDraft
    ? renderedMaterials.find((material) => material.id === remarkDraft.materialId) ?? null
    : selectedRemark
      ? renderedMaterials.find((material) => material.id === selectedRemark.target.materialId) ?? null
      : null;
  const popoverRect = useRemarkPopoverRect(
    camera,
    !homeEditing && !remarkDraft?.picking ? popoverMaterial : null,
    viewport,
    settings.uiScale
  );
  // A boolean derived from the camera: the workspace renders only when it flips.
  const browserUnderOverlay = useCameraSelector(camera, (current) => {
    if (renderedBrowserCanvas === null) return false;
    const browserScreenRect = canvasScreenRect(renderedBrowserCanvas, current);
    return overlayRects.some((rect) => boundsOverlap(browserScreenRect, rect))
      || (popoverRect !== null && boundsOverlap(browserScreenRect, popoverRect));
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
    commitCamera,
    selectedLayerIds: marqueeSelection,
    onMarqueeSelection: selectMarquee,
    onGroupDragStart: beginGroupDrag,
    onGroupDrag: commitGroupDrag
  });
  // Live preview of a travelled group drag: every selected layer of every kind moves together.
  const withGroupNudge = <T extends SessionBounds>(layerId: string, item: T): T => (
    marqueeSelection.has(layerId) && pointerNavigation.groupNudge
      ? { ...item, ...translateBounds(item, pointerNavigation.groupNudge) }
      : item
  );
  const widgetFocus = focusController.state;
  const routeWidgetWheelToCanvas = wheelNavigation.routeWidgetWheelToCanvas;
  // TerminalCard is memoized: its callbacks are the same functions on every render and call the latest
  // handlers through this ref, so a pan (a workspace render per pointer move) renders no card.
  const terminalCardHandlers = useRef<TerminalCardHandlers | null>(null);
  terminalCardHandlers.current = {
    activate(selectedSession, fullscreen) {
      if (!fullscreen) raiseLayer(terminalLayerId(selectedSession.id));
      focusController.focus(terminalCanvasWidgetId(selectedSession.id), "explicit");
      onFocusSession(selectedSession);
    },
    select(id, fullscreen) {
      if (!fullscreen) raiseLayer(terminalLayerId(id));
      focusController.cancelHover();
      focusController.focus(terminalCanvasWidgetId(id), "explicit");
      onSelectSession(id);
    },
    toggleFullscreen: onToggleFullscreen,
    rename: onRenameSession,
    renameEnd: onRenameEnd,
    boundsChange: onSessionBoundsChange,
    restart: onRestartSession,
    dispose: onDisposeSession,
    openUrl: onOpenTerminalUrl
  };
  const terminalCardCallbacks = useMemo(() => {
    const latest = terminalCardHandlers;
    const shared = {
      onRename: (id: string, title: string) => latest.current!.rename(id, title),
      onRenameEnd: () => latest.current!.renameEnd(),
      onRestart: (id: string, resume?: boolean) => latest.current!.restart(id, resume),
      onDispose: (id: string, keepEnvironmentData?: boolean) => latest.current!.dispose(id, keepEnvironmentData),
      onOpenUrl: (url: string) => latest.current!.openUrl(url)
    };
    return {
      canvas: {
        ...shared,
        onActivate: (selectedSession: SessionSnapshot) => latest.current!.activate(selectedSession, false),
        onSelect: (id: string) => latest.current!.select(id, false),
        onBoundsChange: (id: string, bounds: SessionBounds) => latest.current!.boundsChange(id, bounds)
      },
      fullscreen: {
        ...shared,
        onActivate: (selectedSession: SessionSnapshot) => latest.current!.activate(selectedSession, true),
        onSelect: (id: string) => latest.current!.select(id, true),
        onBoundsChange: () => {}
      }
    };
  }, []);
  const fullscreenToggles = useRef(new Map<string, () => void>());
  const toggleFullscreenFor = (id: string): (() => void) => {
    let toggle = fullscreenToggles.current.get(id);
    if (!toggle) {
      toggle = () => terminalCardHandlers.current!.toggleFullscreen(id);
      fullscreenToggles.current.set(id, toggle);
    }
    return toggle;
  };
  // Closed sessions leave nothing behind in per-session state.
  const liveSessionIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  useEffect(() => {
    pruneToLive(fullscreenToggles.current, liveSessionIds);
    setMasterPixelSkinSessionIds((current) => keepLiveIds(current, liveSessionIds));
  }, [liveSessionIds]);
  const canvasOverrideActive = wheelNavigation.canvasOverrideActive;
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
    const current = camera.get();
    return {
      x: (point.x - current.x) / current.zoom,
      y: (point.y - current.y) / current.zoom
    };
  }, [camera, viewportPoint]);
  const viewportCenterWorldPoint = useCallback((): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    const current = camera.get();
    return {
      x: ((bounds?.width ?? 1) / 2 - current.x) / current.zoom,
      y: ((bounds?.height ?? 1) / 2 - current.y) / current.zoom
    };
  }, [camera]);
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
  const pickMaterialsAt = useCallback((point: Point): void => {
    onPickMaterials(point);
    setContextMenu(null);
    setCommandPaletteOpen(false);
  }, [onPickMaterials]);
  const pasteMaterialsAt = useCallback((point: Point): void => {
    onPasteMaterials(point);
    setContextMenu(null);
    setCommandPaletteOpen(false);
  }, [onPasteMaterials]);
  const pastePoint = useCallback((): Point => {
    const pointer = lastPointerClient.current;
    const bounds = viewport.current?.getBoundingClientRect();
    return pointer && bounds && pointer.x >= bounds.left && pointer.x <= bounds.right
      && pointer.y >= bounds.top && pointer.y <= bounds.bottom
      ? worldPoint(pointer.x, pointer.y)
      : viewportCenterWorldPoint();
  }, [viewportCenterWorldPoint, worldPoint]);
  const openMaterialMenu = useCallback((id: string, client: Point): void => {
    setRegionEditor(null);
    setCommandPaletteOpen(false);
    setContextMenu({
      kind: "material",
      position: menuPosition(client.x, client.y),
      worldPoint: worldPoint(client.x, client.y),
      targetId: id
    });
  }, [menuPosition, worldPoint]);
  const launchAt = useCallback((provider: ProviderId, point?: Point): void => {
    if (provider === "terminal") onOpenTerminal(point);
    else onOpenAgent(provider, point);
    setContextMenu(null);
    setCommandPaletteOpen(false);
  }, [onOpenAgent, onOpenTerminal]);

  const activateRadialItem = useCallback((item: RadialLauncherItemId, fromPointerRelease = false): void => {
    const launcher = radialLauncher;
    if (!launcher) return;
    suppressNextContextMenu.current = fromPointerRelease;
    if (fromPointerRelease) {
      window.setTimeout(() => {
        suppressNextContextMenu.current = false;
      }, 0);
    }
    pendingRadialContextMenu.current = null;
    setRadialLauncher(null);
    if (item === "note") createNote(launcher.canvasPosition);
    else if (item === "browser") onOpenBrowser(launcher.canvasPosition);
    else if (item === "settings") onOpenSettings();
    else launchAt(item, launcher.canvasPosition);
  }, [createNote, launchAt, onOpenBrowser, onOpenSettings, radialLauncher]);

  const closeRadialLauncher = useCallback((reason: "release" | "cancel" = "cancel"): void => {
    setRadialLauncher(null);
    if (reason === "release" && pendingRadialContextMenu.current) {
      setContextMenu(pendingRadialContextMenu.current);
    }
    pendingRadialContextMenu.current = null;
  }, []);

  const openRadialLauncher = useCallback((event: React.PointerEvent<HTMLDivElement>): boolean => {
    if (!settings.radialLauncherEnabled || event.button !== 2 || shouldKeepCanvasContextMenu(event.target)) return false;
    const anchor = viewportPoint(event.clientX, event.clientY);
    pendingRadialContextMenu.current = null;
    setContextMenu(null);
    setRegionEditor(null);
    setCommandPaletteOpen(false);
    setRadialLauncher({
      anchor,
      pointerAnchor: { x: event.clientX, y: event.clientY },
      canvasPosition: worldPoint(event.clientX, event.clientY),
      pointerId: event.pointerId
    });
    event.stopPropagation();
    return true;
  }, [settings.radialLauncherEnabled, viewportPoint, worldPoint]);

  useEffect(() => {
    if (!settings.radialLauncherEnabled) closeRadialLauncher();
  }, [closeRadialLauncher, settings.radialLauncherEnabled]);

  const canvasViewportSize = useCallback((): Size => {
    const bounds = viewport.current?.getBoundingClientRect();
    return { width: bounds?.width ?? 1360, height: bounds?.height ?? 820 };
  }, []);

  /** Frames the HOME zone and every window; an empty canvas just goes HOME. */
  const fitCanvas = useCallback((): void => {
    const fitted = cameraFittingContent([homeBounds, ...allWindowBounds], canvasViewportSize());
    if (fitted === null) {
      onGoHome();
      return;
    }
    commitCamera(fitted);
  }, [allWindowBounds, canvasViewportSize, commitCamera, homeBounds, onGoHome]);

  const focusDirection = useCallback((direction: CanvasFocusDirection): void => {
    const target = canvasWidgetInDirection(
      focusCandidates,
      focusController.state.id,
      direction,
      viewportCenterWorldPoint()
    );
    if (target === null) return;
    const session = renderedSessions.find((candidate) => terminalCanvasWidgetId(candidate.id) === target);
    if (session) {
      raiseLayer(terminalLayerId(session.id));
      focusController.focus(target, "explicit");
      onFocusSession(session);
      return;
    }
    const instance = renderedPluginCanvas.find((candidate) => pluginCanvasWidgetId(candidate.id) === target);
    if (instance) {
      raiseLayer(pluginLayerId(instance.id));
      focusController.focus(target, "explicit");
      onFocusPluginCanvas(instance.id);
      return;
    }
    if (renderedBrowserCanvas && target === browserCanvasWidgetId) {
      raiseLayer(browserLayerId);
      focusController.focus(target, "explicit");
      onFocusBrowser();
      return;
    }
  }, [focusCandidates, focusController, onFocusBrowser, onFocusPluginCanvas, onFocusSession,
    renderedBrowserCanvas, renderedPluginCanvas, renderedSessions, raiseLayer, viewportCenterWorldPoint]);

  const fitCanvasRef = useRef(fitCanvas);
  fitCanvasRef.current = fitCanvas;
  const pasteMaterialsRef = useRef(() => onPasteMaterials(pastePoint()));
  pasteMaterialsRef.current = () => onPasteMaterials(pastePoint());
  const focusDirectionRef = useRef(focusDirection);
  focusDirectionRef.current = focusDirection;

  useEffect(() => {
    if (homeEditing || !browserViewVisible) {
      setContextMenu(null);
      setRegionEditor(null);
      setCommandPaletteOpen(false);
      setRadialLauncher(null);
      return;
    }
    const handleShortcut = (event: KeyboardEvent): void => {
      if (activeSessionId !== null
        && (isPixelSkinThemeId(settings.terminalBorderSkin) || isPixelSkinPackId(settings.terminalBorderSkin))
        && shouldTogglePixelSkinMasterView(
          event,
          sessionsRef.current.some((session) => session.id === activeSessionId),
          [settings.shortcuts.home, settings.shortcuts.renameWindow], settings.shortcuts.toggleDetail
        )
        && !isShortcutCaptureTarget(event.target)
        && !isRenameInputTarget(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        setMasterPixelSkinSessionIds((current) => {
          const next = new Set(current);
          if (next.has(activeSessionId)) next.delete(activeSessionId);
          else next.add(activeSessionId);
          return next;
        });
        return;
      }
      if (shouldKeepNativeKeyboardInput(event.target, window.canvasTTY.window.isMacOS, event)) return;
      const focusAction = (Object.keys(CANVAS_FOCUS_ARROWS) as Array<"focusUp" | "focusDown" | "focusLeft" | "focusRight">)
        .find((action) => matchesShortcut(event, settings.shortcuts[action]));
      const direction = focusAction ? CANVAS_FOCUS_ARROWS[focusAction] : undefined;
      if (direction && !event.repeat
        && !isShortcutCaptureTarget(event.target) && !isRenameInputTarget(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        focusDirectionRef.current(direction);
        return;
      }
      if (isShortcutCaptureTarget(event.target) || isRenameInputTarget(event.target) || event.repeat) return;
      if (matchesShortcut(event, settings.shortcuts.commandPalette)) {
        event.preventDefault();
        setContextMenu(null);
        setRegionEditor(null);
        setCommandPaletteOpen((current) => !current);
      } else if (matchesShortcut(event, settings.shortcuts.openSettings)) {
        event.preventDefault();
        setContextMenu(null);
        setRegionEditor(null);
        setCommandPaletteOpen(false);
        onOpenSettings();
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && matchesPhysicalOrLayoutKey(event, "KeyV", "v") && !event.shiftKey && !acceptsTextInput(event.target)) {
        event.preventDefault();
        pasteMaterialsRef.current();
      }
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [activeSessionId, browserViewVisible, homeEditing, onOpenSettings,
    settings.shortcuts, settings.terminalBorderSkin]);

  const themeBackground = (BUNDLED_CANVAS_BACKGROUND_IDS as readonly string[]).includes(settings.canvasBackground)
    ? settings.canvasBackground : undefined;
  const packBackground = usePixelSkinPackAssets(
    isPixelSkinPackId(settings.canvasBackground) ? settings.canvasBackground : null
  )?.background;

  return (
    <div
      ref={viewport}
      data-theme-background={themeBackground ?? (packBackground ? "custom" : undefined)}
      style={packBackground ? { backgroundImage: `url("${packBackground}")` } : undefined}
      className={`workspace pattern-${settings.pattern} ${pointerNavigation.panning ? "workspace--panning" : ""} ${wheelNavigation.zooming ? "workspace--zooming" : ""} ${wheelNavigation.wheelPanning ? "workspace--wheel-panning" : ""} ${canvasOverrideActive ? "workspace--canvas-override" : ""}`}
      onPointerDownCapture={(event) => {
        if (openRadialLauncher(event)) return;
        const element = event.target as HTMLElement;
        if (event.button === 0) {
          const layerId = element.closest<HTMLElement>("[data-canvas-layer-id]")?.dataset.canvasLayerId;
          if (layerId) raiseLayer(layerId);
        }
        if (remarkDraft?.picking && event.button === 0) {
          const materialId = element.closest<HTMLElement>("[data-material-id]")?.dataset.materialId;
          const material = materialId ? renderedMaterials.find((candidate) => candidate.id === materialId) : null;
          if (material && remarkPickable(material) && !element.closest(".material-annotator")) {
            event.preventDefault();
            event.stopPropagation();
            remarkActions.draw(material.id, { kind: "whole" });
            return;
          }
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
      onPointerMove={(event) => {
        lastPointerClient.current = { x: event.clientX, y: event.clientY };
        pointerNavigation.handlePointerMove(event);
      }}
      onPointerMoveCapture={pointerNavigation.handlePointerMoveCapture}
      onPointerUp={pointerNavigation.handlePointerEnd}
      onPointerUpCapture={pointerNavigation.handlePointerEndCapture}
      onPointerCancel={pointerNavigation.handlePointerCancel}
      onPointerCancelCapture={pointerNavigation.handlePointerCancel}
      onPointerLeave={pointerNavigation.handlePointerLeave}
      onContextMenu={(event) => {
        if (suppressNextContextMenu.current) {
          suppressNextContextMenu.current = false;
          event.preventDefault();
          return;
        }
        const element = event.target as HTMLElement;
        const regionId = element.closest<HTMLElement>("[data-canvas-region-id]")?.dataset.canvasRegionId;
        const noteId = element.closest<HTMLElement>("[data-sticky-note-id]")?.dataset.stickyNoteId;
        const materialId = element.closest<HTMLElement>("[data-material-id]")?.dataset.materialId;
        const hit: CanvasContextHit = element.closest("textarea, input, [contenteditable='true'], .terminal-card, .plugin-canvas-card, .browser-card")
          ? "native"
          : noteId
            ? "note"
            : materialId
              ? "material"
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
        const nextContextMenu: CanvasMenuState = {
          kind,
          position: menuPosition(event.clientX, event.clientY),
          worldPoint: worldPoint(event.clientX, event.clientY),
          targetId: kind === "region" ? regionId : kind === "note" ? noteId : kind === "material" ? materialId : undefined
        };
        if (radialLauncher) {
          pendingRadialContextMenu.current = nextContextMenu;
          return;
        }
        setContextMenu(nextContextMenu);
      }}
      onDragOver={(event) => {
        if (homeEditing || !acceptsMaterialDrop(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (homeEditing || !acceptsMaterialDrop(event)) return;
        event.preventDefault();
        onAddMaterialFiles(Array.from(event.dataTransfer.files), worldPoint(event.clientX, event.clientY));
      }}
    >
      <div ref={scene} className="workspace__scene">
        <div className={`workspace__regions ${homeEditing ? "workspace__windows--hidden" : ""}`} aria-hidden={homeEditing}>
          {renderedCanvasRegions.map((region) => (
            <CanvasRegionCard
              key={region.id}
              region={region}
              camera={camera}
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
          onOpenBrowser={() => onOpenBrowser()}
          onFocusSession={focusSessionFromHome}
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
          {surfacesMounted && renderedSessions.filter((session) => fullscreenSessionId !== session.id).map((session) => (
            <TerminalCard
              key={session.id}
              session={withGroupNudge(terminalLayerId(session.id), session)}
              shortcuts={settings.shortcuts}
              locale={settings.locale}
              palette={settings.palette}
              borderSkin={settings.terminalBorderSkin}
              skinDetail={settings.terminalSkinDetail}
              camera={camera}
              stackIndex={canvasLayerZIndex(layerOrder, terminalLayerId(session.id))}
              snapEnabled={settings.snapToGrid}
              focusActivation={settings.focusActivation}
              invertTerminalWheel={settings.invertTerminalWheel}
              copyOnSelect={settings.copyOnSelect}
              captureCanvasWheelOverWidgets={routeWidgetWheelToCanvas || widgetFocus.id !== terminalCanvasWidgetId(session.id)}
              focused={widgetFocus.id === terminalCanvasWidgetId(session.id)}
              focusChangeSource={widgetFocus.source}
              focusRevision={widgetFocus.id === terminalCanvasWidgetId(session.id) ? widgetFocus.revision : 0}
              selected={activeSessionId === session.id}
              forceMasterDetail={masterPixelSkinSessionIds.has(session.id)}
              groupSelected={marqueeSelection.has(terminalLayerId(session.id))}
              renaming={renamingSessionId === session.id}
              fullscreen={fullscreenSessionId === session.id}
              hidden={homeEditing}
              onToggleFullscreen={toggleFullscreenFor(session.id)}
              getSnapTargets={snapTargets.forLayer(terminalLayerId(session.id))}
              {...terminalCardCallbacks.canvas}
              restoreEnabled={settings.sessionRestoreMode !== "off"}
            />
          ))}
          {surfacesMounted && renderedPluginCanvas.map((instance) => {
            const plugin = plugins.find((candidate) => candidate.manifest.id === instance.pluginId && candidate.enabled);
            const contribution = plugin?.manifest.contributions.find((candidate) => candidate.id === instance.contributionId);
            if (!plugin || !contribution || contribution.kind !== "canvas-app") return null;
            return (
              <PluginCanvasCard
                key={instance.id}
                instance={withGroupNudge(pluginLayerId(instance.id), instance)}
                plugin={plugin}
                contribution={contribution}
                locale={settings.locale}
                palette={settings.palette}
                camera={camera}
                stackIndex={canvasLayerZIndex(layerOrder, pluginLayerId(instance.id))}
                snapEnabled={settings.snapToGrid}
                sessions={sessions}
                limits={limits}
                getSnapTargets={snapTargets.forLayer(pluginLayerId(instance.id))}
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
                groupSelected={marqueeSelection.has(pluginLayerId(instance.id))}
                hidden={homeEditing}
              />
            );
          })}
          {surfacesMounted && renderedBrowserCanvas && (
            <BrowserCard
              browser={browser}
              bounds={withGroupNudge(browserLayerId, renderedBrowserCanvas)}
              locale={settings.locale}
              camera={camera}
              visible={browserViewVisible && !homeEditing && contextMenu === null
                && regionEditor === null && !commandPaletteOpen && radialLauncher === null
                && !browserOccluded && !browserUnderOverlay}
              stackIndex={canvasLayerZIndex(layerOrder, browserLayerId)}
              uiScale={settings.uiScale}
              snapEnabled={settings.snapToGrid}
              focusActivation={settings.focusActivation}
              focused={widgetFocus.id === browserCanvasWidgetId}
              selected={browserSelected}
              showAgentPresence={settings.browserShowAgentPresence}
              getSnapTargets={snapTargets.forLayer(browserLayerId)}
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
              groupSelected={marqueeSelection.has(browserLayerId)}
            />
          )}
          {renderedStickyNotes.map((note) => (
            <StickyNoteCard
              key={note.id}
              note={withGroupNudge(noteLayerId(note.id), note)}
              locale={settings.locale}
              camera={camera}
              stackIndex={canvasLayerZIndex(layerOrder, noteLayerId(note.id))}
              editRequest={noteEditRequest?.id === note.id ? noteEditRequest.version : 0}
              snapEnabled={settings.snapToGrid}
              getSnapTargets={snapTargets.forLayer(noteLayerId(note.id))}
              onBoundsChange={onStickyNoteBoundsChange}
              onTextChange={onStickyNoteTextChange}
              onClose={onDeleteStickyNote}
              groupSelected={marqueeSelection.has(noteLayerId(note.id))}
            />
          ))}
          <Suspense fallback={null}>
            {renderedMaterials.map((material) => (
              <MaterialCard
                key={material.id}
                material={withGroupNudge(materialLayerId(material.id), material)}
              locale={settings.locale}
              camera={camera}
              stackIndex={canvasLayerZIndex(layerOrder, materialLayerId(material.id))}
              snapEnabled={settings.snapToGrid}
              getSnapTargets={snapTargets.forLayer(materialLayerId(material.id))}
              groupSelected={marqueeSelection.has(materialLayerId(material.id))}
              removeRequest={materialRemoveRequest?.id === material.id ? materialRemoveRequest.version : 0}
              remarking={remarkingFor(material)}
              remarkActions={remarkActions}
              onBoundsChange={onMaterialBoundsChange}
              onRemove={onRemoveMaterial}
              onOpenMenu={openMaterialMenu}
              onAction={onMaterialCommand}
            />
          ))}
          </Suspense>
        </div>
      </div>

      {/* Fullscreen layer: rendered outside workspace__scene to avoid camera transformation */}
      <div className="workspace__fullscreen-layer">
        {surfacesMounted && renderedSessions
          .filter((session) => fullscreenSessionId === session.id)
          .map((session) => (
            <TerminalCard
              key={session.id}
              session={withGroupNudge(terminalLayerId(session.id), session)}
              shortcuts={settings.shortcuts}
              locale={settings.locale}
              palette={settings.palette}
              borderSkin={settings.terminalBorderSkin}
              skinDetail={settings.terminalSkinDetail}
              camera={FULLSCREEN_CAMERA}
              stackIndex={9999}
              snapEnabled={false}
              focusActivation={settings.focusActivation}
              invertTerminalWheel={settings.invertTerminalWheel}
              copyOnSelect={settings.copyOnSelect}
              captureCanvasWheelOverWidgets={false}
              focused={widgetFocus.id === terminalCanvasWidgetId(session.id)}
              focusChangeSource={widgetFocus.source}
              focusRevision={widgetFocus.id === terminalCanvasWidgetId(session.id) ? widgetFocus.revision : 0}
              selected={activeSessionId === session.id}
              forceMasterDetail={true}
              groupSelected={false}
              renaming={renamingSessionId === session.id}
              fullscreen={true}
              onToggleFullscreen={toggleFullscreenFor(session.id)}
              getSnapTargets={NO_SNAP_TARGETS}
              {...terminalCardCallbacks.fullscreen}
              restoreEnabled={settings.sessionRestoreMode !== "off"}
            />
          ))}
      </div>

      {popoverMaterial && (popoverRect || remarkDraft?.picking) && (
        <RemarkPopover
          locale={settings.locale}
          material={popoverMaterial}
          rect={popoverRect}
          remarkDraft={remarkDraft}
          selectedRemark={selectedRemark}
          handoffs={handoffs}
          materialNames={materialNames}
          remarkActions={remarkActions}
        />
      )}

      {pointerNavigation.marquee && (
        <div
          className="canvas-marquee"
          aria-hidden="true"
          style={{
            left: pointerNavigation.marquee.left,
            top: pointerNavigation.marquee.top,
            width: pointerNavigation.marquee.width,
            height: pointerNavigation.marquee.height
          }}
        />
      )}

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
          materialHasLocation={Boolean(materials.find((material) => material.id === contextMenu.targetId)?.location)}
          onAddFiles={() => pickMaterialsAt(contextMenu.worldPoint)}
          onPasteFiles={() => pasteMaterialsAt(contextMenu.worldPoint)}
          onPinMaterial={() => {
            if (contextMenu.targetId) onMaterialCommand(contextMenu.targetId, "pin");
            setContextMenu(null);
          }}
          onSendMaterial={remarks.some((remark) => remark.target.materialId === contextMenu.targetId && remarkNeedsWork(remark)) ? () => {
            if (contextMenu.targetId) onSendMaterialRemarks(contextMenu.targetId);
            setContextMenu(null);
          } : null}
          onRevealMaterial={() => {
            if (contextMenu.targetId) onMaterialCommand(contextMenu.targetId, "reveal");
            setContextMenu(null);
          }}
          onCopyMaterialPath={() => {
            if (contextMenu.targetId) onMaterialCommand(contextMenu.targetId, "copy-path");
            setContextMenu(null);
          }}
          onBringMaterialToFront={() => {
            if (contextMenu.targetId) raiseLayer(materialLayerId(contextMenu.targetId));
            setContextMenu(null);
          }}
          onRemoveMaterial={() => {
            const id = contextMenu.targetId;
            if (id) {
              raiseLayer(materialLayerId(id));
              setMaterialRemoveRequest((current) => ({ id, version: (current?.version ?? 0) + 1 }));
            }
            setContextMenu(null);
          }}
          onSendRemarks={remarks.some((remark) => remarkNeedsWork(remark)) ? () => {
            setCommandPaletteOpen(false);
            onSendAllRemarks();
          } : null}
          onClose={() => setContextMenu(null)}
        />
      )}

      {radialLauncher && (
        <RadialLauncher
          anchor={radialLauncher.anchor}
          pointerAnchor={radialLauncher.pointerAnchor}
          items={settings.radialLauncherItems}
          locale={settings.locale}
          pointerId={radialLauncher.pointerId}
          onActivate={activateRadialItem}
          onClose={closeRadialLauncher}
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
          onAddFiles={() => pickMaterialsAt(viewportCenterWorldPoint())}
          onPasteFiles={() => pasteMaterialsAt(viewportCenterWorldPoint())}
          onFitCanvas={fitCanvas}
          onOpenBrowser={() => onOpenBrowser(viewportCenterWorldPoint())}
          onOpenSettings={onOpenSettings}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}

      <div className="canvas-overlays" ref={overlays}>
        {remarkDraft?.picking && (
          <div className="canvas-overlay-slot canvas-overlay-slot--top-center">
            <div className="material-reference-banner" role="status" data-interactive="true">
              <UiIcon name="crosshair" size={16} />
              <span>{t(settings.locale, "remarkPickBanner")}</span>
              <button type="button" onClick={remarkActions.clearReference}>{t(settings.locale, "cancel")}</button>
            </div>
          </div>
        )}
        {CANVAS_OVERLAY_PLACEMENTS.map((placement) => (
          <div className={`canvas-overlay-slot canvas-overlay-slot--${placement}`} key={placement}>
            {settings.agentChatHistoryVisible && settings.agentChatHistoryPlacement === placement && (
              <AgentChatHistoryHud settings={settings} sessions={sessions} onFocusSession={focusSessionFromHome} onResume={async (item) => {
                const session = await props.onResumeHistory(item, viewportCenterWorldPoint());
                focusSessionFromHome(session);
              }} />
            )}
            {/* The canvas scene is transformed and therefore its own stacking context, so anything
                inside it paints under this layer and scales with the camera. The queue is a
                screen-anchored HUD: it belongs here, alongside the other corner overlays. */}
            {attentionQueueRenderedAt(settings, placement, attention.length) && (
              <section className="attention-queue" aria-label={t(settings.locale, "needsAttention")}
                title={t(settings.locale, "needsAttentionHint")}>
                <span className="attention-queue__title">{t(settings.locale, "needsAttention")}</span>
                <span className="attention-queue__caption">{t(settings.locale, "needsAttentionCaption")}</span>
                {attention.map((session) => {
                  const failureDetails = sessionFailureDetails(session, settings.locale);
                  return (
                    <div style={{ position: "relative" }} key={session.id}>
                      <button
                        className="attention-queue__item"
                        data-session-tone={sessionStatusTone(session.status)}
                        type="button"
                        title={failureDetails ? undefined : session.title}
                        onClick={() => focusSessionFromHome(session)}
                      >
                        <span>{session.title}</span>
                        <span>{sessionStatusLabel(settings.locale, session.status, session.provider)}</span>
                      </button>
                      {failureDetails && <SessionFailureDetails details={failureDetails} locale={settings.locale} />}
                    </div>
                  );
                })}
              </section>
            )}
            {settings.minimapPlacement === placement && (
              <CanvasMinimap viewport={viewport} camera={camera} homeBounds={homeBounds}
                canvasRegions={renderedCanvasRegions} sessions={renderedSessions} stickyNotes={renderedStickyNotes}
                materials={renderedMaterials}
                pluginCanvas={minimapPluginCanvas}
                browserCanvas={renderedBrowserCanvas} layerOrder={layerOrder}
                locale={settings.locale} interactionMode={settings.minimapInteractionMode}
                onCameraChange={commitCamera} />
            )}
            {settings.canvasControlsPlacement === placement && (
              <div className="canvas-controls" data-interactive="true">
                <button type="button" onClick={onGoHome} title={t(settings.locale, "home")}><UiIcon name="home" size={17} /></button>
                <button type="button" onClick={fitCanvas} title={t(settings.locale, "fitCanvas")} aria-label={t(settings.locale, "fitCanvas")}><UiIcon name="maximize" size={17} /></button>
                <button type="button" onClick={() => wheelNavigation.zoomBy(0.82)} title={t(settings.locale, "zoomOut")}><UiIcon name="zoom-out" size={17} /></button>
                <button type="button" onClick={() => wheelNavigation.zoomBy(1.22)} title={t(settings.locale, "zoomIn")}><UiIcon name="zoom-in" size={17} /></button>
              </div>
            )}
            {settings.showShortcutHints && settings.shortcutHintsPlacement === placement && (
              <aside className="shortcut-hints" aria-label={t(settings.locale, "keyboardShortcuts")}>
                <div><kbd>{settings.shortcuts.home}</kbd><span>{t(settings.locale, "homeShortcut")}</span></div>
                <div><kbd>{settings.shortcuts.renameWindow}</kbd><span>{t(settings.locale, "renameWindow")}</span></div>
                <div><kbd>{settings.shortcuts.toggleFullscreen.replace("Meta", window.canvasTTY.window.isMacOS ? "Command" : "Super")}</kbd><span>{t(settings.locale, "toggleFullscreen")}</span></div>
                <div><kbd>{settings.shortcuts.focusUp}</kbd><span>{t(settings.locale, "keyboardFocusUp")}</span></div>
                <div><kbd>Shift + drag</kbd><span>{t(settings.locale, "marqueeSelectionHint")}</span></div>
                {settings.canvasWheelCaptureMode === "key" && settings.canvasWheelOverride !== null && (
                  <div><kbd>{displayCanvasNavigationBinding(settings.canvasWheelOverride, window.canvasTTY.window.isMacOS)}</kbd>
                    <span>{t(settings.locale, "canvasWheelOverrideHint")}</span></div>
                )}
                {settings.canvasNavigationOverride !== null && (
                  <div><kbd>{displayCanvasNavigationBinding(settings.canvasNavigationOverride, window.canvasTTY.window.isMacOS)}</kbd>
                    <span>{t(settings.locale, "canvasNavigationOverrideHint")}</span></div>
                )}
                <button className="shortcut-hints__more" type="button" data-interactive="true"
                  aria-haspopup="dialog" onClick={props.onOpenShortcutReference}>
                  {t(settings.locale, "keyboardShortcuts")}
                  <UiIcon name="app-window" size={14} />
                </button>
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

function shouldKeepCanvasContextMenu(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    "textarea, input, select, [contenteditable='true'], .terminal-card, .plugin-canvas-card, .browser-card, .home-zone, .canvas-overlays, .canvas-menu, .canvas-region-editor, [data-canvas-region-id], [data-sticky-note-id], [data-material-id], [data-interactive='true']"
  ));
}

function acceptsMaterialDrop(event: React.DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes("Files")
    && !(event.target instanceof Element && event.target.closest(
      "[data-canvas-layer-id], .home-zone, .canvas-overlays, .canvas-menu, .canvas-region-editor, .home-editor-toolbar"
    ));
}
