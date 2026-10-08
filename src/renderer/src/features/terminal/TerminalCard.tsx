import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { summaryScaleForZoom, useCameraSelector, type CameraStore } from "../workspace/cameraStore";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import {
  INITIAL_TERMINAL_COLS,
  INITIAL_TERMINAL_ROWS
} from "../../../../shared/contracts";
import type {
  LocaleId,
  PaletteId,
  PluginCardActionEntry,
  PluginCardActionResult,
  Point,
  FocusActivation,
  SessionBounds,
  SessionSnapshot,
  PixelSkinPreferredDetail,
  ShortcutBindings,
  TerminalBorderSkinId
} from "../../../../shared/contracts";
import { usePluginCardDecorations } from "../plugins/cardDecorations";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { matchesShortcut } from "../../lib/shortcuts";
import { GitRiskNotice } from "./GitRiskNotice";
import type { PluginChangeReviewActionInput } from "./PluginChangesReviewDialog";
import { isCustomTerminalBorderSkinId, terminalBorderSkinFallback } from "../../lib/skinStyles";
import { sessionStatusLabel } from "../../lib/sessionStatus";
import { attachTerminalMouseCoordinateAdapter, attachTerminalScrollbarCoordinateAdapter } from "./terminalMouseCoordinates";
import { attachTerminalCopyOnSelect } from "./terminalCopyOnSelect";
import {
  CODEX_SELECT_ALL_SEQUENCE,
  SHIFT_ENTER_SEQUENCE,
  codexEnterSequence,
  codexShortcutSequence,
  shouldCopyTerminalSelection,
  shouldPasteTerminalClipboard,
  shouldRestartExitedTerminal,
  shouldScrollTerminalPage,
  shouldSearchTerminalOutput,
  shouldSelectCodexDraft,
  shouldSendTerminalLineBreak
} from "./terminalShortcuts";
import { attachTerminalRedrawViewport, fitTerminalPreservingViewport } from "./terminalViewport";
import { attachTerminalOutput, createTerminalDeliveryGate } from "./terminalOutput";
import { surfaceIsLive, surfaceLifecycle, type SurfaceGate } from "../workspace/surfaceLifecycle";
import { createPinnedInputRefresh, limitPinnedTerminalInput, pinnedTerminalInput } from "./terminalPinnedInput";
import { terminalLinkTarget } from "./terminalLinkTarget";
import { terminalFileLinkProvider } from "./terminalFileLinks";
import { parseTerminalFileLink } from "../../../../shared/terminalFileLink";
import {
  constrainResize,
  snapMove,
  snapResize
} from "../workspace/snap";
import { shouldActivateCanvasFromClick } from "../workspace/focus";
import type { ResizeDirection } from "../workspace/snap";
import { terminalCanvasWidgetId } from "../workspace/canvasWidgetFocus";
import { compactPath, renameCommit, visibleTerminalTitle } from "./terminalTitle";
import { canvasCardPropsEqual } from "./terminalCardProps";
import { markBootOnce } from "../../lib/bootMarks";
import { webglContextPool } from "./webglContextPool";
import { skipEmptySelectionRedraws } from "./terminalSelectionRedraw";
import { Canvas2DSkinView } from "../skins/Canvas2DSkinView";
import { isPixelSkinThemeId, pixelSkinStateForSession } from "../skins/skinCatalog";
import { isPixelSkinPackId, usePixelSkinPackSummary } from "../skins/SkinAssets";
import { pixelSkinControlLayout, pixelSkinSurfaceBounds, skinDetailLevel } from "../skins/SkinLayout";
import { TaskSummaryBar } from "../workspace/TaskSummaryBar";
import type { WorkspaceDropPayload } from "../workspace/workspaceContextDrop";
import { backlogTerminalApi } from "../workspace/backlogRendererApi";
import { backlogText } from "../workspace/workspaceBacklogText";
import { taskCardState } from "../workspace/workspaceTaskGraph";

const PluginChangesReviewDialog = lazy(() => import("./PluginChangesReviewDialog").then((module) => ({ default: module.PluginChangesReviewDialog })));

interface TerminalCardProps {
  session: SessionSnapshot;
  shortcuts: ShortcutBindings;
  locale: LocaleId;
  palette: PaletteId;
  borderSkin: TerminalBorderSkinId;
  skinDetail: PixelSkinPreferredDetail;
  /** The canvas camera: drags read its zoom when they move; rendering subscribes to what it needs. */
  camera: CameraStore;
  stackIndex: number;
  snapEnabled: boolean;
  focusActivation: FocusActivation;
  invertTerminalWheel: boolean;
  copyOnSelect: boolean;
  captureCanvasWheelOverWidgets: boolean;
  focused: boolean;
  focusChangeSource: "explicit" | "hover";
  focusRevision: number;
  selected: boolean;
  forceMasterDetail: boolean;
  /** Multi-select group member: gets the selected outline without focus/WebGL side effects. */
  groupSelected?: boolean;
  taskChildren?: readonly SessionSnapshot[];
  broadcastTarget?: boolean;
  externalSearchRequest?: { query: string; line: number; offset: number; requestId: number };
  /**
   * The card is CSS-hidden by an ancestor (HOME editing hides the whole window layer). One of the
   * inputs of the card's surface lifecycle (surfaceLifecycle.ts): a hidden card is suspended.
   */
  hidden?: boolean;
  renaming: boolean;
  fullscreen: boolean;
  /** The current layout's snap targets for this card; asked once when a drag or resize starts. */
  getSnapTargets(): readonly SessionBounds[];
  onToggleFullscreen(): void;
  onActivate(session: SessionSnapshot): void;
  onSelect(id: string): void;
  onRename(id: string, title: string): Promise<void>;
  onRenameEnd(): void;
  onBoundsChange(id: string, bounds: SessionBounds): void;
  onBoundsPreview?(id: string, bounds: SessionBounds | null): void;
  onRestart(id: string, resume?: boolean): Promise<void>;
  /** `keepEnvironmentData` is the answer to "Keep environment data?" for a card in a plugin environment. */
  onDispose(id: string, keepEnvironmentData?: boolean): void;
  /** Saving sessions is on, so the per-card "Don't restore" choice applies. */
  restoreEnabled?: boolean;
  onOpenUrl(url: string): void;
  onOpenInspector(id: string, initialTab?: "timeline" | "report"): void;
  onGatherTask(id: string): void;
  onDropContext(id: string, payload: WorkspaceDropPayload, point: Point): void;
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
const TERMINAL_FOCUS_IN = "\u001b[I";
const TERMINAL_FOCUS_OUT = "\u001b[O";
// The WebGL canvas backing store is layout x devicePixelRatio and xterm 6 has no
// DPR option, so above 1x its raster would be upscaled by the scene transform.
// Its cells are the DOM renderer's width snapped down to whole device pixels, so
// both renderer transitions refit the grid to fill the card with the active cells.
const WEBGL_MAX_SCALE = 1;

const SEARCH_DECORATIONS = {
  matchBackground: "#7b7899",
  matchBorder: "#7b7899",
  matchOverviewRuler: "#7b7899",
  activeMatchBackground: "#9a96c2",
  activeMatchBorder: "#9a96c2",
  activeMatchColorOverviewRuler: "#9a96c2"
} as const;

/**
 * A card renders again only when one of its props changes (snap targets by value): a pan re-renders the
 * workspace on every pointer move, and none of that reaches the cards.
 */
export const TerminalCard = memo(TerminalCardView, canvasCardPropsEqual);

function TerminalCardView({
  session,
  locale,
  palette,
  shortcuts,
  borderSkin: selectedBorderSkin,
  skinDetail,
  camera,
  stackIndex,
  snapEnabled,
  focusActivation,
  invertTerminalWheel,
  copyOnSelect,
  captureCanvasWheelOverWidgets,
  focused,
  focusChangeSource,
  focusRevision,
  selected,
  forceMasterDetail,
  groupSelected,
  taskChildren = [],
  broadcastTarget = false,
  externalSearchRequest,
  hidden = false,
  renaming,
  fullscreen,
  getSnapTargets,
  onToggleFullscreen,
  onActivate,
  onSelect,
  onRename,
  onRenameEnd,
  onBoundsChange,
  onBoundsPreview,
  onRestart,
  onDispose,
  onOpenUrl,
  onOpenInspector,
  onGatherTask,
  onDropContext,
  restoreEnabled = false
}: TerminalCardProps): React.JSX.Element {
  const borderSkin = terminalBorderSkinFallback(selectedBorderSkin);
  const customBorderSkin = isCustomTerminalBorderSkinId(selectedBorderSkin) ? selectedBorderSkin : undefined;
  const pixelSkinTheme = isPixelSkinThemeId(borderSkin) || isPixelSkinPackId(borderSkin) ? borderSkin : null;
  const pixelPack = usePixelSkinPackSummary(isPixelSkinPackId(borderSkin) ? borderSkin : null);
  const pixelArtState = pixelSkinStateForSession(session.status, session.turnCompleted);
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const nativeEditorRef = useRef(session.nativeEditor);
  nativeEditorRef.current = session.nativeEditor;
  const onOpenUrlRef = useRef(onOpenUrl);
  onOpenUrlRef.current = onOpenUrl;
  const renameInput = useRef<HTMLInputElement>(null);
  const renameInFlight = useRef(false);
  // Title the rename field was seeded with; the commit compares against this
  // snapshot so a shell title changing mid-edit cannot turn "no edit" into a rename.
  const renameInitial = useRef("");
  // Set once this rename session ended (commit or Escape) so a trailing blur
  // from the input unmounting cannot commit a second time.
  const renameClosed = useRef(false);
  const suppressFocusReport = useRef(false);
  const sessionExited = useRef(session.exitCode !== null);
  sessionExited.current = session.exitCode !== null;
  const sessionStartedAt = useRef(session.startedAt);
  sessionStartedAt.current = session.startedAt;
  const restartAction = useRef<(resume?: boolean) => Promise<void>>(async () => undefined);
  const invertTerminalWheelRef = useRef(invertTerminalWheel);
  invertTerminalWheelRef.current = invertTerminalWheel;
  const copyOnSelectRef = useRef(copyOnSelect);
  copyOnSelectRef.current = copyOnSelect;
  const captureCanvasWheelRef = useRef(captureCanvasWheelOverWidgets);
  captureCanvasWheelRef.current = captureCanvasWheelOverWidgets;
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const [position, setPosition] = useState(session.position);
  const [size, setSize] = useState(session.size);
  const pixelDetail = pixelSkinTheme
    ? skinDetailLevel(skinDetail, forceMasterDetail || session.role === "orchestrator")
    : "minimal";
  const pixelSurfaceBounds = pixelSkinTheme
    ? pixelSkinSurfaceBounds(pixelSkinTheme, pixelDetail, size.width, size.height, 26,
      pixelPack?.apertures[pixelDetail] ?? pixelPack?.aperture)
    : null;
  const pixelControls = pixelSkinTheme
    ? pixelSkinControlLayout(pixelSkinTheme, pixelDetail, size.width, size.height)
    : null;
  const [restarting, setRestarting] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  // Plugin badges and actions (EP-7); an action's answer shows as a toast on the card, as plain text.
  const pluginDecorations = usePluginCardDecorations(session);
  const [actionRunning, setActionRunning] = useState(false);
  const [actionToast, setActionToast] = useState<PluginCardActionResult | null>(null);
  const [pluginReview, setPluginReview] = useState<{ pluginId: string; actionId: string; review: NonNullable<PluginCardActionResult["review"]> } | null>(null);
  const hasOptions = true;
  const runPluginAction = (action: PluginCardActionEntry): void => {
    setOptionsOpen(false);
    setActionRunning(true);
    void window.canvasTTY.plugins.invokeCardAction(action.pluginId, action.actionId, session.id)
      .then((result) => {
        if (result.review) {
          setActionToast(null);
          setPluginReview({ pluginId: action.pluginId, actionId: action.actionId, review: result.review });
        } else {
          setActionToast({ tone: result.tone, message: result.message ?? `${action.title}: ${t(locale, "cardActionDone")}` });
        }
      })
      .catch((error: unknown) => setActionToast({ tone: "error", message: error instanceof Error ? error.message : String(error) }))
      .finally(() => setActionRunning(false));
  };
  useEffect(() => {
    if (!actionToast) return;
    const timer = window.setTimeout(() => setActionToast(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [actionToast]);
  const liveBounds = useRef<SessionBounds>({ position: session.position, size: session.size });
  // The card renders when these derived values change, not on every camera move: a pan renders no card,
  // and a zoom only at the summary and WebGL thresholds (and while the summary scale grows).
  const summaryScale = useCameraSelector(camera, (current) => summaryScaleForZoom(current.zoom));
  const summaryMode = summaryScale > 1;
  const webglScaleAllowed = useCameraSelector(camera, (current) => current.zoom <= WEBGL_MAX_SCALE);
  const terminalColors = terminalTheme(palette, pixelSkinTheme);
  const terminalBackground = terminalColors.background;
  const terminalForeground = terminalColors.foreground;
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const rendererTransitionRef = useRef<{
    snapshot: HTMLElement;
    frame: number | null;
    render: { dispose(): void } | null;
    fallback: number | null;
    animation: Animation | null;
    visibilityCleanup: (() => void) | null;
  } | null>(null);
  const restoreRendererTransition = (): void => {
    const transition = rendererTransitionRef.current;
    if (!transition) return;
    rendererTransitionRef.current = null;
    if (transition.frame !== null) cancelAnimationFrame(transition.frame);
    if (transition.fallback !== null) window.clearTimeout(transition.fallback);
    transition.visibilityCleanup?.();
    transition.render?.dispose();
    transition.animation?.cancel();
    transition.snapshot.remove();
  };
  const beginRendererTransition = (terminal: Terminal): HTMLElement | null => {
    restoreRendererTransition();
    const element = terminal.element;
    const screen = element?.querySelector<HTMLElement>(".xterm-screen");
    if (!element || !screen || !screen.checkVisibility({ visibilityProperty: true })) return null;
    const webglCanvas = element.dataset.renderer === "webgl"
      ? screen.querySelector<HTMLCanvasElement>("canvas:not([class])") : null;
    if (webglCanvas?.getContext("webgl2")?.isContextLost()) return null;
    const snapshot = screen.cloneNode(true) as HTMLElement;
    // DOM renderer disposal removes its owner class; keep the cloned row styles scoped to the snapshot.
    for (const className of element.classList) {
      if (className.startsWith("xterm-dom-renderer-owner-") || className === "focus") snapshot.classList.add(className);
    }
    snapshot.setAttribute("data-renderer-transition", "true");
    snapshot.setAttribute("aria-hidden", "true");
    snapshot.inert = true;
    Object.assign(snapshot.style, {
      position: "absolute", left: `${screen.offsetLeft}px`, top: `${screen.offsetTop}px`,
      pointerEvents: "none", zIndex: "4", overflow: "hidden",
      backgroundColor: "var(--terminal-background, #202430)"
    });
    // cloneNode copies DOM rows, but canvas pixels must be copied before disposing WebGL.
    const canvases = snapshot.querySelectorAll("canvas");
    try {
      screen.querySelectorAll("canvas").forEach((canvas, index) => {
        const context = canvases[index].getContext("2d");
        if (!context) throw new Error("Renderer snapshot unavailable");
        context.drawImage(canvas, 0, 0);
      });
    } catch {
      return null;
    }
    element.append(snapshot);
    const onVisibilityChange = (): void => {
      if (document.hidden) restoreRendererTransition();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    rendererTransitionRef.current = {
      snapshot,
      frame: null,
      render: null,
      fallback: window.setTimeout(restoreRendererTransition, 250),
      animation: null,
      visibilityCleanup: () => document.removeEventListener("visibilitychange", onVisibilityChange)
    };
    return snapshot;
  };
  const revealRendererTransition = (terminal: Terminal, snapshot: HTMLElement): void => {
    const transition = rendererTransitionRef.current;
    if (!transition || transition.snapshot !== snapshot) return;
    const fadeAfterPaint = (): void => {
      if (rendererTransitionRef.current !== transition) return;
      transition.frame = null;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        restoreRendererTransition();
        return;
      }
      transition.animation = snapshot.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 180, easing: "ease-out", fill: "forwards"
      });
      transition.animation.onfinish = () => {
        if (rendererTransitionRef.current === transition) restoreRendererTransition();
      };
    };
    const ready = (): void => {
      if (rendererTransitionRef.current !== transition || transition.frame !== null) return;
      transition.render?.dispose();
      transition.render = null;
      transition.frame = requestAnimationFrame(() => {
        transition.frame = requestAnimationFrame(fadeAfterPaint);
      });
    };
    transition.render = terminal.onRender(ready);
    terminal.refresh(0, terminal.rows - 1);
  };
  const lifecycle = surfaceLifecycle({ summary: summaryMode, hidden, focused });
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;
  const pinnedInputRefreshRef = useRef<(() => void) | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const historicalRequestEpoch = useRef(0);
  const historicalSearchActive = useRef(false);
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const [historicalOutput, setHistoricalOutput] = useState<{
    text: string;
    firstLine: number;
    targetLine: number;
    loading: boolean;
    historyTruncated?: boolean;
    error?: string;
  } | null>(null);
  // Last OSC 0/2 title the shell reported; display-only, never persisted.
  const [oscTitle, setOscTitle] = useState<string | null>(null);
  const titleSource = { title: session.title, titleCustomized: session.titleCustomized, oscTitle };
  const visibleTitle = visibleTerminalTitle({ ...titleSource, cwdLabel: compactPath(session.cwd) });
  // Same precedence, but the tooltip shows the full path when the cwd is the label.
  const visibleTitleTooltip = visibleTerminalTitle({ ...titleSource, cwdLabel: session.cwd });
  const visibleTitleRef = useRef(visibleTitle);
  visibleTitleRef.current = visibleTitle;
  const taskState = session.parentSessionId ? taskCardState(session) : null;
  const taskStateLabel = taskState === "working" ? "taskStateWorking"
    : taskState === "waiting" ? "taskStateWaiting"
      : taskState === "waiting-response" ? "taskStateWaitingResponse"
        : taskState === "done" ? "taskStateDone" : "taskStateFailed";

  restartAction.current = async (resume = false) => {
    if (restarting || !sessionExited.current) return;
    setRestarting(true);
    try {
      await onRestart(session.id, resume);
      const terminal = terminalRef.current;
      if (terminal) window.canvasTTY.terminal.resize(session.id, terminal.cols, terminal.rows);
    } finally {
      setRestarting(false);
    }
  };

  useEffect(() => {
    const bounds = { position: session.position, size: session.size };
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  }, [session.position, session.size]);

  useEffect(() => {
    const host = terminalHost.current;
    if (!host) return;

    const openFile = (event: MouseEvent, reference: string): void => {
      event.preventDefault();
      event.stopPropagation();
      void window.canvasTTY.terminal.openFile(session.id, reference).catch((error: unknown) => {
        setActionToast({ tone: "error", message: error instanceof Error ? error.message : String(error) });
      });
    };

    const terminal = new Terminal({
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 5_000,
      // Keep the reader's scrollback position while their live input is echoed
      // into the pinned row below it.
      scrollOnUserInput: false,
      allowTransparency: true,
      macOptionClickForcesSelection: copyOnSelectRef.current,
      altClickMovesCursor: !(copyOnSelectRef.current && window.canvasTTY.window.isMacOS),
      // Search decorations (highlighting every match and reporting the match
      // count) are proposed API in xterm; without this flag findNext throws and
      // the counter never leaves 0/0. The flag only unlocks that surface.
      allowProposedApi: true,
      theme: terminalTheme(palette, pixelSkinTheme),
      // OSC 8 hyperlinks are handled by xterm itself rather than WebLinksAddon.
      // Without an explicit handler, xterm shows its own confirm() prompt and
      // attempts window.open(), bypassing CanvasTTY's link destination chooser.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (event, uri, range) => {
          if (parseTerminalFileLink(uri)) {
            openFile(event, uri);
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onOpenUrlRef.current(terminalLinkTarget(uri, range, terminal.buffer.active, terminal.cols));
        }
      }
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      event.stopPropagation();
      onOpenUrlRef.current(uri);
    });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    terminal.loadAddon(webLinksAddon);
    const fileLinks = terminal.registerLinkProvider(terminalFileLinkProvider(terminal, openFile));
    terminal.open(host);
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    const pinnedInput = document.createElement("div");
    pinnedInput.className = "terminal-card__pinned-input";
    pinnedInput.hidden = true;
    pinnedInput.setAttribute("aria-hidden", "true");
    host.append(pinnedInput);
    let pinnedRows = 0;
    let pinnedFitFrame: number | null = null;
    const renderPinnedInput = (): void => {
      const completePinned = pinnedTerminalInput(terminal.buffer.active);
      const maxPinnedRows = Math.max(1, Math.floor(host.clientHeight / (14 * 1.2) / 2));
      const pinned = completePinned ? limitPinnedTerminalInput(completePinned, maxPinnedRows) : null;
      const nextRows = pinned?.rows.length ?? 0;
      pinnedInput.hidden = pinned === null;
      host.classList.toggle("terminal-card__surface--pinned-input", pinned !== null);
      if (pinned) {
        host.style.setProperty("--pinned-input-height", `calc(${nextRows} * 1.2em)`);
        pinnedInput.style.left = `${screen?.offsetLeft ?? 0}px`;
        pinnedInput.style.width = `${screen?.clientWidth ?? host.clientWidth}px`;
        pinnedInput.style.setProperty("--pinned-terminal-columns", String(terminal.cols));
        pinnedInput.style.setProperty("--pinned-row-count", String(nextRows));
        pinnedInput.replaceChildren(...pinned.rows.map((text, rowIndex) => {
          const row = document.createElement("div");
          row.className = "terminal-card__pinned-input-row";
          row.textContent = text;
          if (rowIndex === pinned.cursorRow) {
            const cursorColumn = Math.min(pinned.cursorColumn, Math.max(0, terminal.cols - 1));
            row.classList.add("terminal-card__pinned-input-row--cursor");
            row.dataset.cursorColumn = String(cursorColumn);
            row.style.setProperty("--pinned-cursor-column", String(cursorColumn));
          }
          return row;
        }));
      } else {
        host.style.removeProperty("--pinned-input-height");
        pinnedInput.replaceChildren();
        pinnedInput.style.removeProperty("--pinned-terminal-columns");
        pinnedInput.style.removeProperty("--pinned-row-count");
      }
      if (nextRows !== pinnedRows) {
        pinnedRows = nextRows;
        if (pinnedFitFrame === null) pinnedFitFrame = requestAnimationFrame(() => {
          pinnedFitFrame = null;
          if (surfaceIsLive(lifecycleRef.current)) fitRef.current?.();
        });
      }
    };
    const pinnedRefresh = createPinnedInputRefresh({
      isLive: () => surfaceIsLive(lifecycleRef.current),
      refresh: renderPinnedInput,
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (frame) => cancelAnimationFrame(frame)
    });
    const updatePinnedInput = pinnedRefresh.schedule;
    pinnedInputRefreshRef.current = updatePinnedInput;
    const pinnedScroll = terminal.onScroll(updatePinnedInput);
    const pinnedCursor = terminal.onCursorMove(updatePinnedInput);
    const pinnedOutput = terminal.onWriteParsed(updatePinnedInput);
    setOscTitle(null);
    const detachRedrawViewport = attachTerminalRedrawViewport(terminal);
    const restoreSelectionRedraws = skipEmptySelectionRedraws(terminal);
    let lastReportedGrid = "";
    const reportGrid = (cols: number, rows: number): void => {
      const grid = `${cols}x${rows}`;
      if (grid === lastReportedGrid) return;
      lastReportedGrid = grid;
      window.canvasTTY.terminal.resize(session.id, cols, rows);
    };
    const resize = terminal.onResize(({ cols, rows }) => {
      reportGrid(cols, rows);
      updatePinnedInput();
    });
    const pool = webglContextPool();
    const unsubscribe = attachTerminalOutput(
      window.canvasTTY.terminal,
      session.id,
      (data) => {
        pool.touch(session.id);
        terminal.write(data);
      },
      (error) => {
        console.error("CanvasTTY could not load terminal history.", error);
        terminal.write(`\r\n[CanvasTTY] ${t(locale, "terminalHistoryFailed")}\r\n`);
      },
      // Same locale capture as the notice above: this effect is scoped to the session.
      (missing) => t(locale, "terminalReplayTrimmed").replace("{count}", String(missing))
    );
    const fit = (): void => {
      try {
        fitTerminalPreservingViewport(terminal, () => fitAddon.fit());
        reportGrid(terminal.cols, terminal.rows);
      } catch {
        // A hidden semantic-zoom surface has no measurable rows yet.
      }
    };
    fitRef.current = fit;
    terminal.attachCustomKeyEventHandler((event) => {
      const editor = nativeEditorRef.current;
      if (editor && Object.values(editor).some((binding) => matchesShortcut(event, binding))) {
        const sequence = codexShortcutSequence(event);
        if (sequence !== null) {
          event.preventDefault();
          event.stopPropagation();
          if (matchesShortcut(event, editor.selectAll)) terminal.clearSelection();
          window.canvasTTY.terminal.input(session.id, sequence);
          return false;
        }
      }
      const codexEnter = codexEnterSequence(event, session.provider);
      if (codexEnter !== null) {
        event.preventDefault();
        event.stopPropagation();
        window.canvasTTY.terminal.input(session.id, codexEnter);
        return false;
      }
      const selectCodexDraft = nativeEditorRef.current ? false
        : shouldSelectCodexDraft(event, window.canvasTTY.window.isMacOS, session.provider);
      if (selectCodexDraft) {
        event.preventDefault();
        event.stopPropagation();
        terminal.clearSelection();
        window.canvasTTY.terminal.input(session.id, CODEX_SELECT_ALL_SEQUENCE);
        return false;
      }
      if (matchesShortcut(event, shortcutsRef.current.toggleDetail)
        && terminalHost.current?.closest(".terminal-card")?.getAttribute("data-pixel-skin") === "true") {
        return false;
      }
      if (shouldSearchTerminalOutput(event, shortcutsRef.current)) {
        // The configured search shortcut belongs to scrollback, never the shell.
        event.preventDefault();
        event.stopPropagation();
        if (searchOpenRef.current) {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else {
          setSearchOpen(true);
        }
        return false;
      }
      if (shouldRestartExitedTerminal(event, sessionExited.current, shortcutsRef.current)) {
        event.preventDefault();
        event.stopPropagation();
        void restartAction.current();
        return false;
      }
      if (!nativeEditorRef.current && shouldSendTerminalLineBreak(event)) {
        event.preventDefault();
        event.stopPropagation();
        window.canvasTTY.terminal.input(session.id, SHIFT_ENTER_SEQUENCE);
        return false;
      }
      const pageDirection = shouldScrollTerminalPage(event, shortcutsRef.current);
      if (pageDirection !== 0 && terminal.buffer.active.type === "normal") {
        // In the normal buffer PgUp/PgDn page the scrollback; in the alternate
        // buffer they fall through to the application (vim, less, agent TUI).
        event.preventDefault();
        event.stopPropagation();
        terminal.scrollPages(pageDirection);
        return false;
      }
      if (shouldCopyTerminalSelection(event, terminal.hasSelection() || session.provider === "codex", shortcutsRef.current)) {
        event.preventDefault();
        event.stopPropagation();
        if (terminal.hasSelection()) window.canvasTTY.clipboard.writeText(terminal.getSelection());
        else if (session.provider === "codex") window.canvasTTY.terminal.input(session.id,
          event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === "KeyC"
            ? "\u0003" : "\u001b[99;9u");
        return false;
      }
      if (!shouldPasteTerminalClipboard(event, shortcutsRef.current)) return true;

      event.preventDefault();
      event.stopPropagation();
      const pasteStartedAt = sessionStartedAt.current;
      const acceptsPaste = () => terminalRef.current === terminal && !sessionExited.current
        && sessionStartedAt.current === pasteStartedAt;
      if (!acceptsPaste()) return false;
      void (event.metaKey ? window.canvasTTY.clipboard.hasImage() : Promise.resolve(false))
        .then(async (hasImage) => {
          if (!acceptsPaste()) return;
          if (hasImage) {
            window.canvasTTY.terminal.input(session.id, "\u0016");
            return;
          }
          const text = await window.canvasTTY.clipboard.readText();
          if (text && acceptsPaste()) terminal.paste(text);
        })
        .catch(() => undefined);
      return false;
    });
    const detachMouseCoordinateAdapter = screen
      ? attachTerminalMouseCoordinateAdapter(
        screen,
        () => invertTerminalWheelRef.current ? -1 : 1,
        () => captureCanvasWheelRef.current,
        () => copyOnSelectRef.current && window.canvasTTY.window.isMacOS
      )
      : () => undefined;
    const detachCopyOnSelect = screen
      ? attachTerminalCopyOnSelect(
        screen,
        () => terminal.getSelection(),
        () => copyOnSelectRef.current,
        (text) => window.canvasTTY.clipboard.writeText(text),
        (listener) => {
          const disposable = terminal.onSelectionChange(listener);
          return () => disposable.dispose();
        }
      )
      : () => undefined;
    terminalRef.current = terminal;
    const detachScrollbarCoordinateAdapter = attachTerminalScrollbarCoordinateAdapter(terminal);
    fit();

    const frame = requestAnimationFrame(fit);
    const resizeObserver = new ResizeObserver(() => {
      fit();
      pool.viewportChanged();
    });
    resizeObserver.observe(host);
    // Renderer choice: the pool decides which on-screen cards draw with WebGL; the rest keep the DOM renderer.
    const unregisterWebgl = pool.register(session.id, {
      measure: () => host.checkVisibility({ visibilityProperty: true }) ? host.getBoundingClientRect() : null,
      attach: () => enableWebgl(terminal),
      detach: () => disableWebgl(terminal)
    });

    const input = terminal.onData((data) => {
      // Hover focus routes keyboard input locally without reporting a synthetic focus transition to the TUI.
      if (suppressFocusReport.current && (data === TERMINAL_FOCUS_IN || data === TERMINAL_FOCUS_OUT)) return;
      // onData also carries focus, mouse and device reports. Only text (including
      // bracketed paste) should collapse the history panel.
      const text = data.startsWith("\u001b[200~")
        ? data.slice(6).replace(/\u001b\[201~$/, "") : data;
      if (!text.startsWith("\u001b") && /[^\u0000-\u001f\u007f]/.test(text)) {
        window.dispatchEvent(new CustomEvent("canvastty:terminal-input", { detail: { sessionId: session.id } }));
      }
      window.canvasTTY.terminal.input(session.id, data);
    });
    // The first terminal card whose xterm is attached and forwards keystrokes: at startup this is a restored
    // session (new sessions cannot exist yet), so this doubles as "restored terminal interactive".
    markBootOnce("restoredTerminalInteractive");
    const titleChange = terminal.onTitleChange((title) => setOscTitle(title.trim() ? title : null));
    const searchResults = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (historicalSearchActive.current) return;
      setSearchMatches({
        current: resultCount > 0 && resultIndex >= 0 ? resultIndex + 1 : 0,
        total: resultCount
      });
    });
    return () => {
      // No refit on the way out: the card is going away, its PTY size must not change.
      fitRef.current = null;
      restoreRendererTransition();
      unregisterWebgl();
      cancelAnimationFrame(frame);
      detachMouseCoordinateAdapter();
      detachCopyOnSelect();
      detachScrollbarCoordinateAdapter();
      unsubscribe();
      resizeObserver.disconnect();
      input.dispose();
      pinnedScroll.dispose();
      pinnedCursor.dispose();
      pinnedOutput.dispose();
      pinnedRefresh.dispose();
      if (pinnedFitFrame !== null) cancelAnimationFrame(pinnedFitFrame);
      if (pinnedInputRefreshRef.current === updatePinnedInput) pinnedInputRefreshRef.current = null;
      host.classList.remove("terminal-card__surface--pinned-input");
      host.style.removeProperty("--pinned-input-height");
      pinnedInput.remove();
      titleChange.dispose();
      searchResults.dispose();
      fileLinks.dispose();
      searchAddonRef.current = null;
      resize.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      detachRedrawViewport();
      restoreSelectionRedraws();
      terminal.dispose();
    };
  }, [session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalTheme(palette, pixelSkinTheme);
  }, [palette, pixelSkinTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.macOptionClickForcesSelection = copyOnSelect;
    terminal.options.altClickMovesCursor = !(copyOnSelect && window.canvasTTY.window.isMacOS);
  }, [copyOnSelect]);

  const enableWebgl = (terminal: Terminal): boolean => {
    if (webglAddonRef.current) return true;
    const transitionElement = beginRendererTransition(terminal);
    // WebglAddon takes no transparency argument in 0.19.0: it reads the stored
    // terminal options, and this terminal is constructed with allowTransparency,
    // so cell backgrounds stay transparent and the card's palette background
    // keeps showing through the canvas exactly as it does in the DOM renderer.
    // Preserve the last painted frame for the short snapshot when switching back to DOM. A one-shot
    // readback after compositing is not reliable with preserveDrawingBuffer disabled; the bounded WebGL
    // pool still limits the number of contexts that pay this cost.
    const webgl = new WebglAddon(true);
    webgl.onContextLoss(() => {
      // GPU context gone and not restored: drop the renderer, xterm falls back to the DOM renderer with
      // the buffer intact, and the pool keeps this card off WebGL for a while.
      if (webglAddonRef.current !== webgl) return;
      disableWebgl(terminal);
      webglContextPool().contextLost(session.id);
    });
    try {
      terminal.loadAddon(webgl);
    } catch {
      // WebGL2 unavailable — stay on the DOM renderer.
      webgl.dispose();
      restoreRendererTransition();
      return false;
    }
    webglAddonRef.current = webgl;
    terminal.element?.setAttribute("data-renderer", "webgl");
    fitRef.current?.();
    if (transitionElement) revealRendererTransition(terminal, transitionElement);
    return true;
  };

  const disableWebgl = (terminal: Terminal): void => {
    const webgl = webglAddonRef.current;
    if (!webgl) return;
    const transitionElement = fitRef.current ? beginRendererTransition(terminal) : null;
    webglAddonRef.current = null;
    // The WebGL canvas is the one xterm-screen child without a layer class (the link layer is a 2D canvas).
    const canvas = terminal.element?.querySelector<HTMLCanvasElement>(".xterm-screen > canvas:not([class])");
    webgl.dispose();
    terminal.element?.setAttribute("data-renderer", "dom");
    // WebGL snaps the cell width down to whole device pixels, so its cells can be narrower than the DOM
    // renderer's. A grid fitted while on WebGL may then be too wide for DOM: fit again.
    fitRef.current?.();
    if (transitionElement) revealRendererTransition(terminal, transitionElement);
    // Disposing the addon drops the canvas but not its context, which counts against Chromium's
    // per-renderer limit until it is collected. Lose it now so the slot is really free. getContext
    // returns the canvas's existing context here; it creates nothing.
    try {
      canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Already lost.
    }
  };

  useEffect(() => {
    // The pool gives WebGL to on-screen cards in priority order. Above WEBGL_MAX_SCALE the canvas raster
    // would be an upscale, and in summary mode the terminal is not drawn, so those cards stay on DOM.
    webglContextPool().update(session.id, { eligible: !summaryMode && webglScaleAllowed, focused });
  }, [session.id, focused, summaryMode, webglScaleAllowed]);

  useEffect(() => {
    // Moving or resizing the card changes what it covers on screen.
    webglContextPool().viewportChanged();
  }, [position, size]);

  // The card's surface lifecycle: suspended while it draws no terminal (summary thumbnail, HOME editing).
  // Off-screen and minimized cards stay live on purpose: the main process can replay only its scrollback
  // ring (smaller than xterm's scrollback), so a long unattended stretch would cost the card real history.
  const deliveryGate = useRef<SurfaceGate | null>(null);
  useEffect(() => {
    const gate = createTerminalDeliveryGate(window.canvasTTY.terminal, session.id);
    deliveryGate.current = gate;
    return () => {
      gate.dispose();
      if (deliveryGate.current === gate) deliveryGate.current = null;
    };
  }, [session.id]);
  useEffect(() => {
    deliveryGate.current?.set(lifecycle);
    // The suspended surface hides xterm's screen so its IntersectionObserver pauses painting;
    // output still advances the parser and scrollback. Keep the host's geometry for fitting.
    const terminal = terminalRef.current;
    if (!terminal) return;
    const live = surfaceIsLive(lifecycle);
    terminal.options.cursorBlink = live;
    if (live) {
      pinnedInputRefreshRef.current?.();
      // A terminal first opened while suspended may not have measured its cells yet.
      const frame = requestAnimationFrame(() => fitRef.current?.());
      return () => cancelAnimationFrame(frame);
    }
  }, [session.id, lifecycle]);

  useEffect(() => {
    if (!surfaceIsLive(lifecycle)) restoreRendererTransition();
  }, [lifecycle]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    suppressFocusReport.current = focusChangeSource === "hover";
    if (focused && !renaming && !summaryMode) terminal.focus();
    else if (!focused) {
      terminal.blur();
      renameInput.current?.blur();
    }
    suppressFocusReport.current = false;
  }, [focusChangeSource, focusRevision, focused, renaming, summaryMode]);

  useEffect(() => {
    searchOpenRef.current = searchOpen;
  }, [searchOpen]);

  useEffect(() => {
    // The overlay is the only thing receiving keystrokes while it is open.
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchOpen]);

  useEffect(() => {
    // Semantic zoom replaces the surface with a thumbnail and unmounts the overlay.
    if (summaryMode) closeSearch();
  }, [summaryMode]);

  const bindRenameInput = useCallback((input: HTMLInputElement | null): void => {
    renameInput.current = input;
    if (!input) return;
    // Seed the field exactly once, from the title visible when the rename
    // started. Deliberately not a `defaultValue` prop: React re-syncs that
    // attribute on every render, which would overwrite an untouched field when
    // the shell reports a new OSC title while the user is editing.
    const initial = visibleTitleRef.current;
    renameInitial.current = initial;
    renameClosed.current = false;
    input.value = initial;
    terminalRef.current?.blur();
    input.focus({ preventScroll: true });
    input.select();
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest("button, input")) return;
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
    const nextPosition = snapEnabled
      ? snapMove(rawPosition, state.startBounds.size, state.snapTargets)
      : rawPosition;
    applyLiveBounds({ position: nextPosition, size: state.startBounds.size });
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (!dragState.current || dragState.current.pointerId !== event.pointerId) return;
    dragState.current = null;
    onBoundsChange(session.id, liveBounds.current);
    onBoundsPreview?.(session.id, null);
  };

  // A group drag takes pointer capture without a pointerup; drop local state so a
  // later hover cannot act on it.
  // Pointer capture lost mid-gesture (no pointerup): nothing was committed, so the card goes back to its saved bounds.
  // After a normal pointerup the gesture is already over and this does nothing.
  const cancelDrag = (): void => {
    if (!dragState.current) return;
    dragState.current = null;
    applyLiveBounds({ position: session.position, size: session.size });
    onBoundsPreview?.(session.id, null);
  };

  const cancelResize = (): void => {
    if (!resizeState.current) return;
    resizeState.current = null;
    applyLiveBounds({ position: session.position, size: session.size });
    onBoundsPreview?.(session.id, null);
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

  const resizeCard = (event: React.PointerEvent<HTMLDivElement>): void => {
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
    const constrained = constrainResize(raw, state.direction);
    applyLiveBounds(snapEnabled ? snapResize(constrained, state.direction, state.snapTargets) : constrained);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizeState.current || resizeState.current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    resizeState.current = null;
    onBoundsChange(session.id, liveBounds.current);
    onBoundsPreview?.(session.id, null);
  };

  const applyLiveBounds = (bounds: SessionBounds): void => {
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
    onBoundsPreview?.(session.id, bounds);
  };

  const activateSummary = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.currentTarget.closest<HTMLElement>(".terminal-card")?.focus({ preventScroll: true });
    onSelect(session.id);
    if (shouldActivateCanvasFromClick(focusActivation, 1)) onActivate(session);
  };

  const activateSummaryDouble = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (shouldActivateCanvasFromClick(focusActivation, 2)) onActivate(session);
  };

  const activateCard = (event: React.MouseEvent<HTMLElement>): void => {
    if (!shouldActivateCanvasFromClick(focusActivation, 1) || isCardControl(event.target)) return;
    onActivate(session);
  };

  const activateCardDouble = (event: React.MouseEvent<HTMLElement>): void => {
    if (!shouldActivateCanvasFromClick(focusActivation, 2) || isCardControl(event.target)) return;
    onActivate(session);
  };

  const commitRename = async (): Promise<void> => {
    if (renameInFlight.current || renameClosed.current) return;
    const { kind, title } = renameCommit({
      previousVisible: renameInitial.current,
      submitted: renameInput.current?.value ?? ""
    });
    if (kind === "unchanged") {
      renameClosed.current = true;
      onRenameEnd();
      return;
    }
    renameInFlight.current = true;
    try {
      await onRename(session.id, title);
      renameClosed.current = true;
      onRenameEnd();
    } finally {
      renameInFlight.current = false;
    }
  };

  const cancelRename = (): void => {
    renameClosed.current = true;
    onRenameEnd();
  };

  const runSearch = (query: string, direction: "next" | "previous", incremental: boolean): void => {
    historicalRequestEpoch.current += 1;
    historicalSearchActive.current = false;
    const addon = searchAddonRef.current;
    searchQueryRef.current = query;
    setSearchQuery(query);
    setHistoricalOutput(null);
    if (!addon) return;
    if (!query) {
      addon.clearDecorations();
      setSearchMatches({ current: 0, total: 0 });
      return;
    }
    const options = { incremental, decorations: SEARCH_DECORATIONS };
    if (direction === "next") addon.findNext(query, options);
    else addon.findPrevious(query, options);
  };

  useEffect(() => {
    const epoch = ++historicalRequestEpoch.current;
    historicalSearchActive.current = false;
    setHistoricalOutput(null);
    if (!externalSearchRequest || summaryMode) return;
    const requested = externalSearchRequest;
    historicalSearchActive.current = true;
    searchQueryRef.current = requested.query;
    setSearchOpen(true);
    setSearchQuery(requested.query);
    setSearchMatches({ current: 0, total: 0 });
    searchAddonRef.current?.clearDecorations();
    setHistoricalOutput({ text: "", firstLine: requested.line, targetLine: requested.line, loading: true });
    // A text match in xterm is not the selected occurrence in retained history.
    void backlogTerminalApi().readOutputContext(session.id, requested.offset).then(context => {
      if (historicalRequestEpoch.current === epoch) setHistoricalOutput({ ...context, loading: false });
    }).catch((reason: unknown) => {
      if (historicalRequestEpoch.current !== epoch) return;
      setHistoricalOutput({ text: "", firstLine: requested.line, targetLine: requested.line, loading: false,
        error: reason instanceof Error ? reason.message : String(reason) });
    });
    terminalRef.current?.focus();
    return () => { historicalRequestEpoch.current += 1; historicalSearchActive.current = false; };
  }, [externalSearchRequest, summaryMode, session.id]);

  const closeSearch = (): void => {
    historicalRequestEpoch.current += 1;
    historicalSearchActive.current = false;
    setSearchOpen(false);
    setSearchQuery("");
    setSearchMatches({ current: 0, total: 0 });
    setHistoricalOutput(null);
    searchAddonRef.current?.clearDecorations();
    // Hand the keyboard back to the terminal so the next keystrokes reach the PTY.
    if (!renaming && !summaryMode) terminalRef.current?.focus();
  };

  const toggleSearch = (): void => {
    if (summaryMode) return;
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  };

  const searchCount = `${searchMatches.current}/${searchMatches.total}`;
  const terminalActions = (
    <div
      className={`terminal-card__actions${pixelControls ? " terminal-card__actions--pixel" : ""}`}
      style={pixelControls ? {
        left: pixelControls.left,
        top: pixelControls.top,
        width: pixelControls.width,
        height: pixelControls.height,
        "--pixel-control-size": `${pixelControls.buttonSize}px`,
        "--pixel-control-font-size": `${pixelControls.fontSize}px`
      } as React.CSSProperties : undefined}
    >
      {!summaryMode && (
        <button
          className="terminal-card__action terminal-card__action--search"
          type="button"
          onClick={toggleSearch}
          title={t(locale, "terminalSearch")}
          aria-label={t(locale, "terminalSearch")}
        >
          <UiIcon name="search" size="1.23em" />
        </button>
      )}
      {session.exitCode !== null && (
        <button
          className="terminal-card__action terminal-card__action--restart"
          type="button"
          disabled={restarting}
          onClick={() => void restartAction.current()}
          title={`${t(locale, "restartSession")} · ${shortcuts.terminalRestart}`}
          aria-label={t(locale, "restartSession")}
        >
          <UiIcon name={restarting ? "working" : "reload"} size="1.23em" />
        </button>
      )}
      {session.exitCode !== null && session.provider !== "terminal" && (
        <button className="terminal-card__action terminal-card__action--continue" type="button" disabled={restarting}
          onClick={() => void restartAction.current(true)} title={t(locale, "continueSession")} aria-label={t(locale, "continueSession")}>
          <UiIcon name="arrow" size="1.23em" />
        </button>
      )}
      {hasOptions && (
        <button className="terminal-card__action terminal-card__action--options" type="button" aria-haspopup="menu"
          aria-expanded={optionsOpen} disabled={actionRunning} onClick={() => setOptionsOpen((open) => !open)}
          title={t(locale, "cardOptions")} aria-label={t(locale, "cardOptions")}>
          <UiIcon name="sliders-horizontal" size="1.23em" />
        </button>
      )}
      <button className="terminal-card__action terminal-card__action--fullscreen" type="button"
        onClick={(event) => { event.stopPropagation(); onToggleFullscreen(); }}
        title={fullscreen ? t(locale, "exitFullscreen") : t(locale, "enterFullscreen")}
        aria-label={fullscreen ? t(locale, "exitFullscreen") : t(locale, "enterFullscreen")}>
        <UiIcon name={fullscreen ? "restore" : "maximize"} size="1.23em" />
      </button>
      <button className="terminal-card__action terminal-card__action--close" type="button" onClick={() => {
        if (session.environment) setConfirmClose(true);
        else onDispose(session.id);
      }} title={t(locale, "close")} aria-label={t(locale, "close")}><UiIcon name="close" size="1.23em" /></button>
    </div>
  );
  return (
    <article
      className={`terminal-card terminal-card--${session.provider} ${summaryMode ? "terminal-card--summary" : ""} ${selected || groupSelected ? "terminal-card--selected" : ""} ${session.status === "needs_approval" || session.status === "failed" ? "terminal-card--attention" : ""} ${broadcastTarget ? "terminal-card--broadcast-target" : ""} ${session.role === "orchestrator" && (taskChildren.length > 0 || Boolean(session.taskBudget)) ? "terminal-card--with-task-summary" : ""} terminal-card--with-activity-summary ${fullscreen ? "terminal-card--fullscreen" : ""}`}
      data-interactive="true"
      data-canvas-layer-id={`terminal:${session.id}`}
      data-canvas-widget-id={terminalCanvasWidgetId(session.id)}
      data-canvas-widget-focusable="true"
      data-canvas-zoom-surface="application"
      data-wheel-owner={summaryMode ? undefined : "local"}
      data-session-id={session.id}
      data-border-skin={borderSkin}
      data-pixel-skin={pixelSkinTheme ? "true" : undefined}
      data-custom-border-skin={customBorderSkin}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        onSelect(session.id);
        if (!renaming && !summaryMode && !(event.target as HTMLElement).closest("button, input, .terminal-card__skin-drag")) {
          terminalRef.current?.focus();
        }
      }}
      onKeyDown={(event) => {
        // Fallback for focus parked on the card itself; the terminal textarea is
        // handled by attachCustomKeyEventHandler, which stops propagation first.
        if (summaryMode || !shouldSearchTerminalOutput(event)) return;
        event.preventDefault();
        event.stopPropagation();
        toggleSearch();
      }}
      onClick={activateCard}
      onDoubleClick={activateCardDouble}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")
          && !event.dataTransfer.types.includes("text/plain")
          && !event.dataTransfer.types.includes("text/uri-list")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = sessionExited.current || renaming ? "none" : "copy";
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")
          && !event.dataTransfer.types.includes("text/plain")
          && !event.dataTransfer.types.includes("text/uri-list")) return;
        event.preventDefault();
        event.stopPropagation();
        if (sessionExited.current || renaming) return;
        onDropContext(session.id, {
          files: Array.from(event.dataTransfer.files),
          url: event.dataTransfer.getData("text/uri-list").split("\n").find((line) => line && !line.startsWith("#")) ?? "",
          text: event.dataTransfer.getData("text/plain")
        }, { x: event.clientX, y: event.clientY });
      }}
      style={{
        width: size.width,
        height: size.height,
        zIndex: stackIndex,
        transform: `translate(${position.x}px, ${position.y}px)`,
        "--summary-scale": summaryScale,
        "--summary-content-width": `${Math.max(0, ((pixelSurfaceBounds ? pixelSurfaceBounds.right - pixelSurfaceBounds.left : size.width) - 72) / summaryScale)}px`,
        "--terminal-background": terminalBackground,
        "--terminal-foreground": terminalForeground,
        "--pixel-skin-left-inset": `${pixelSurfaceBounds?.left ?? 28}px`,
        "--pixel-skin-right-inset": `${size.width - (pixelSurfaceBounds?.right ?? (size.width - 28))}px`,
        "--pixel-skin-top-inset": `${pixelSurfaceBounds?.top ?? 70}px`,
        "--pixel-skin-bottom-inset": `${size.height - (pixelSurfaceBounds?.bottom ?? (size.height - 58))}px`
      } as React.CSSProperties}
    >
      {fullscreen && (
        <button
          className="terminal-card__exit-fullscreen"
          type="button"
          onClick={(event) => { event.stopPropagation(); onToggleFullscreen(); }}
          title={t(locale, "exitFullscreen")}
          aria-label={t(locale, "exitFullscreen")}
        >
          <UiIcon name="close" size="1.2em" />
        </button>
      )}
      <header
        className="terminal-card__header"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={cancelDrag}
      >
        <div className="terminal-card__identity">
          <ProviderIcon provider={session.provider} size="small" />
          {renaming ? (
            <input
              ref={bindRenameInput}
              className="terminal-card__rename"
              data-terminal-rename="true"
              autoFocus
              maxLength={80}
              aria-label={t(locale, "renameWindow")}
              onPointerDown={(event) => event.stopPropagation()}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
            />
          ) : (
            <strong title={visibleTitleTooltip}>
              {visibleTitle}
            </strong>
          )}
          {session.role === "orchestrator" && (
            <span className="terminal-card__role" title={t(locale, "orchestratorRoleNote")}>{t(locale, "roleOrchestrator")}</span>
          )}
          {taskState && <span className={`terminal-card__task-status terminal-card__task-status--${taskState}`}
            data-state={taskState} title={backlogText(locale, taskStateLabel)}>{backlogText(locale, taskStateLabel)}</span>}
          {session.profile === "auto" && (
            <span className="terminal-card__role" title={t(locale, session.autoDowngraded ? "autoDowngradedNote" : "autoProfileNote")}>
              {t(locale, session.autoDowngraded ? "autoDowngraded" : "autoProfile")}
            </span>
          )}
          {(session.profile === "acceptEdits" || session.profile === "plan" || session.profile === "yolo") && (
            <span className="terminal-card__role" title={t(locale, session.profile === "acceptEdits" ? "acceptEditsNote" : session.profile === "plan" ? "planNote" : "bypassInsideIsolation")}>
              {t(locale, session.profile === "acceptEdits" ? "acceptEditsProfile" : session.profile === "plan" ? "planProfile" : "bypassProfile")}
            </span>
          )}
          {session.isolation && (
            <span className={`terminal-card__role terminal-card__isolation terminal-card__isolation--${session.isolation.state}`} data-isolation={session.isolation.state}
              title={session.isolation.state === "on" ? [t(locale, "isolationOnNote"), session.isolation.reason].filter(Boolean).join("\n") : session.isolation.reason ?? ""}>
              {t(locale, session.isolation.state === "on" ? "isolationOn" : session.isolation.state === "off" ? "isolationOff"
                : session.isolation.state === "environment" ? "isolationEnvironment" : "isolationUnavailable")}
            </span>
          )}
          {session.configuredMode && (
            <span className="terminal-card__role" title={`${session.configuredMode.mode} · ${session.configuredMode.source}`}>
              {t(locale, "configuredModeBadge")}: {session.configuredMode.mode}
            </span>
          )}
          {session.isolation?.network && <span className="terminal-card__role" title={session.isolation.network.domains.join(", ")}>
            {locale==="ru" ? "Сеть" : "Network"}: {session.isolation.network.mode==="open" ? (locale==="ru" ? "открыта" : "open") : session.isolation.network.mode==="offline" ? (locale==="ru" ? "отключена" : "offline") : (locale==="ru" ? "разрешённые домены" : "allowed domains")}
          </span>}
          {session.reviewRequested && <span className="terminal-card__review-requested" title={backlogText(locale, "reviewRequested")}>
            {backlogText(locale, "reviewRequested")}
          </span>}
          {session.environment && (
            <span className="terminal-card__environment" title={session.environment.detail ?? `${session.environment.pluginId} · ${session.environment.kind}`}>
              {session.environment.label}
            </span>
          )}
          {pluginDecorations.badges.map((badge) => (
            <span key={badge.pluginId} className={`terminal-card__plugin-badge terminal-card__plugin-badge--${badge.tone}`}
              title={badge.tooltip ?? badge.pluginId}>
              {badge.text}
            </span>
          ))}
        </div>
        {!pixelControls && terminalActions}
      </header>
      <TaskSummaryBar parent={session} children={taskChildren} locale={locale} onGather={() => onGatherTask(session.id)} />
      <div className="terminal-card__surface" data-suspended={!surfaceIsLive(lifecycle)} ref={terminalHost} />
      <div className="terminal-card__activity-summary" data-interactive="true" role="group" aria-label={locale === "ru" ? "Расходы сессии" : "Session usage"}>
        <span title={usageDetails(session.usage, locale)}>{locale === "ru" ? "Расход" : "Usage"}: {compactUsage(session.usage, locale)}</span>
        {(session.reviewUsage || session.reviewRequested) && <span title={usageDetails(session.reviewUsage, locale)}>
          {locale === "ru" ? "Проверяющий" : "Reviewer"}: {compactUsage(session.reviewUsage, locale)}
        </span>}
        {session.sessionReport && <button type="button" onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onOpenInspector(session.id, "report")} title={locale === "ru" ? "Открыть готовый отчёт" : "Open the completed report"}>
          {locale === "ru" ? "Отчёт готов" : "Report ready"}
        </button>}
      </div>
      {pixelSkinTheme && (
        <Canvas2DSkinView theme={pixelSkinTheme} status={session.status} artState={pixelArtState}
          width={size.width} height={size.height} detail={pixelDetail} surfaceBounds={pixelSurfaceBounds ?? undefined} />
      )}
      {pixelSkinTheme && (["top", "right", "bottom", "left"] as const).map((edge) => (
        <div key={edge} className={`terminal-card__skin-drag terminal-card__skin-drag--${edge}`}
          aria-hidden="true" onPointerDown={startDrag} onPointerMove={drag} onPointerUp={endDrag}
          onPointerCancel={endDrag} onLostPointerCapture={cancelDrag} />
      ))}
      {pixelControls && terminalActions}
      {optionsOpen && hasOptions && (
        <div className="terminal-card__menu" role="menu" onKeyDown={(event) => { if (event.key === "Escape") setOptionsOpen(false); }}>
          <button className="terminal-card__menu-action" type="button" role="menuitem" onClick={() => {
            setOptionsOpen(false);
            onOpenInspector(session.id);
          }}>{locale === "ru" ? "События и задача…" : "Activity and task…"}</button>
          {restoreEnabled && (
            <label role="menuitemcheckbox" aria-checked={session.skipRestore === true}>
              <input
                type="checkbox"
                autoFocus
                checked={session.skipRestore === true}
                onChange={(event) => {
                  setOptionsOpen(false);
                  void window.canvasTTY.terminal.setRestore(session.id, !event.target.checked);
                }}
              />
              {t(locale, "cardSkipRestore")}
            </label>
          )}
          {pluginDecorations.actions.map((action, index) => (
            <button key={`${action.pluginId}:${action.actionId}`} className="terminal-card__menu-action" type="button" role="menuitem"
              autoFocus={!restoreEnabled && index === 0} title={action.pluginName} onClick={() => runPluginAction(action)}>
              {action.title}
            </button>
          ))}
        </div>
      )}
      {actionToast && !summaryMode && (
        <div className={`terminal-card__note terminal-card__toast terminal-card__toast--${actionToast.tone}`} role="status">
          <span>{actionToast.message}</span>
          <button type="button" onClick={() => setActionToast(null)} aria-label={t(locale, "close")}>
            <UiIcon name="close" size="1em" />
          </button>
        </div>
      )}
      {pluginReview && <Suspense fallback={null}>
        <PluginChangesReviewDialog
          key={`${pluginReview.pluginId}:${pluginReview.actionId}:${session.id}`}
          cardSessionId={session.id}
          reviewActionId={pluginReview.actionId}
          review={pluginReview.review}
          locale={locale}
          invokeAction={(actionId: string, input?: PluginChangeReviewActionInput) => (
            window.canvasTTY.plugins.invokeCardAction(pluginReview.pluginId, actionId, session.id, input)
          )}
          onReviewChange={(review) => setPluginReview((current) => current ? { ...current, review } : current)}
          onActionResult={(result) => {
            setPluginReview(null);
            setActionToast({ tone: result.tone, message: result.message ?? t(locale, "cardActionDone") });
          }}
          onClose={() => setPluginReview(null)}
        />
      </Suspense>}
      {confirmClose && session.environment && (
        <div className="terminal-card__menu terminal-card__confirm" role="alertdialog" aria-label={t(locale, "environmentKeepTitle")}
          onKeyDown={(event) => { if (event.key === "Escape") setConfirmClose(false); }}>
          <strong>{t(locale, "environmentKeepTitle")}</strong>
          <span>{session.environment.label} · {t(locale, "environmentKeepDetail")}</span>
          <div className="terminal-card__confirm-actions">
            <button type="button" autoFocus onClick={() => { setConfirmClose(false); onDispose(session.id, true); }}>{t(locale, "environmentKeep")}</button>
            <button type="button" onClick={() => { setConfirmClose(false); onDispose(session.id, false); }}>{t(locale, "environmentRemove")}</button>
            <button type="button" onClick={() => setConfirmClose(false)}>{t(locale, "cancel")}</button>
          </div>
        </div>
      )}
      {session.gitRisk && !summaryMode && (
        <GitRiskNotice report={session.gitRisk} locale={locale} className="terminal-card__git-risk" />
      )}
      {session.restoreNote && noteDismissed !== session.restoreNote && !summaryMode && (
        <div className="terminal-card__note" role="status">
          <span>{t(locale, session.restoreNote === "fresh-shared-folder" ? "restoreNoteSharedFolder"
            : session.restoreNote === "plugin-unavailable" ? "restoreNotePlugin"
              : session.restoreNote === "environment-pending" ? "restoreNoteEnvironmentPending" : "restoreNoteEnvironment")}</span>
          <button type="button" onClick={() => setNoteDismissed(session.restoreNote ?? null)} aria-label={t(locale, "close")}>
            <UiIcon name="close" size="1em" />
          </button>
        </div>
      )}
      {searchOpen && !summaryMode && (
        <div className="terminal-card__search" role="search">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            placeholder={t(locale, "terminalSearchPlaceholder")}
            aria-label={t(locale, "terminalSearchPlaceholder")}
            onChange={(event) => runSearch(event.target.value, "next", true)}
            onKeyDown={(event) => {
              // Keystrokes typed into the search box must never reach the PTY.
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                runSearch(searchQuery, event.shiftKey ? "previous" : "next", false);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
          />
          <span className="terminal-card__search-count">{searchCount}</span>
          {/* The chevron asset points down; the square button flips it for "previous". */}
          <button
            type="button"
            title={t(locale, "terminalSearchPrevious")}
            aria-label={t(locale, "terminalSearchPrevious")}
            style={{ transform: "rotate(180deg)" }}
            onClick={() => runSearch(searchQuery, "previous", false)}
          >
            <UiIcon name="chevron" size="1em" />
          </button>
          <button
            type="button"
            title={t(locale, "terminalSearchNext")}
            aria-label={t(locale, "terminalSearchNext")}
            onClick={() => runSearch(searchQuery, "next", false)}
          >
            <UiIcon name="chevron" size="1em" />
          </button>
          <button
            type="button"
            title={t(locale, "terminalSearchClose")}
            aria-label={t(locale, "terminalSearchClose")}
            onClick={closeSearch}
          >
            <UiIcon name="close" size="1em" />
          </button>
        </div>
      )}
      {historicalOutput && !summaryMode && (
        <section className="terminal-card__historical-output" aria-label={backlogText(locale, "historicalOutput")}>
          <header><div><strong>{backlogText(locale, "historicalOutput")}</strong><span>{backlogText(locale, "historicalOutputContext")}</span></div>
            <button type="button" onClick={() => { setHistoricalOutput(null); closeSearch(); }} aria-label={t(locale, "close")}>
              <UiIcon name="close" size="1em" />
            </button>
          </header>
          {historicalOutput.loading && <p role="status">{backlogText(locale, "historicalOutputLoading")}</p>}
          {historicalOutput.error && <p role="alert">{historicalOutput.error}</p>}
          {!historicalOutput.loading && !historicalOutput.error && (
            <>
            {historicalOutput.historyTruncated && <p role="status">{backlogText(locale, "outputHistoryPruned")}</p>}
            <pre>{historicalOutput.text.split(/\r?\n/u).map((line, index) => {
              const lineNumber = historicalOutput.firstLine + index;
              return <span key={`${lineNumber}:${index}`} data-target={lineNumber === historicalOutput.targetLine ? "true" : undefined}>
                <small>{lineNumber}</small>{line || " "}{"\n"}
              </span>;
            })}</pre>
            </>
          )}
        </section>
      )}
      <button
        className="terminal-card__summary"
        type="button"
        onClick={activateSummary}
        onDoubleClick={activateSummaryDouble}
        title={visibleTitle}
        aria-label={visibleTitle}
        data-focus-activation={focusActivation}
      >
        <div className="terminal-card__summary-content">
          <ProviderIcon provider={session.provider} size="large" />
          <div className="terminal-card__summary-copy"><strong>{visibleTitle}</strong><span>{sessionStatusLabel(locale, session.status, session.provider)}</span></div>
        </div>
      </button>
      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`}
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, direction)}
          onPointerMove={resizeCard}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={cancelResize}
        />
      ))}
    </article>
  );
}

function terminalTheme(palette: PaletteId, pixelSkin: string | null = null): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const background = pixelSkin ? "#00000000" : palette === "night" ? "#171a24" : "#202430";
  return {
    background,
    foreground: "#f7f4ec",
    cursor: palette === "lilac" ? "#bfc9ee" : "#b8cf99",
    selectionBackground: "#7b789966"
  };
}

function compactUsage(summary: SessionSnapshot["usage"], locale: LocaleId): string {
  if (!summary?.source) return locale === "ru" ? "неизвестно" : "unknown";
  const tokens = summary.tokens.total === null
    ? (locale === "ru" ? "токены неизвестны" : "tokens unknown")
    : `${summary.tokens.total.toLocaleString(locale)} ${locale === "ru" ? "токенов" : "tokens"}`;
  const cost = summary.cost === null
    ? (locale === "ru" ? "стоимость неизвестна" : "cost unknown")
    : `${summary.currency === "USD" ? "$" : `${summary.currency} `}${summary.cost.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `${tokens} · ${cost}`;
}

function usageDetails(summary: SessionSnapshot["usage"], locale: LocaleId): string {
  if (!summary?.source) return locale === "ru" ? "Источник данных о расходе недоступен." : "Usage source is unavailable.";
  const unknown = locale === "ru" ? "неизвестно" : "unknown";
  const cost = summary.cost === null ? unknown : `${summary.currency} ${summary.cost.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  const value = (count: number | null): string => count === null ? unknown : count.toLocaleString(locale);
  return [
    `${locale === "ru" ? "Источник" : "Source"}: ${summary.source}`,
    `${locale === "ru" ? "Вход" : "Input"}: ${value(summary.tokens.input)}`,
    `${locale === "ru" ? "Выход" : "Output"}: ${value(summary.tokens.output)}`,
    `${locale === "ru" ? "Всего" : "Total"}: ${value(summary.tokens.total)}`,
    `${locale === "ru" ? "Стоимость" : "Cost"}: ${cost}`
  ].join("\n");
}

function isCardControl(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, .terminal-card__menu, .terminal-card__note, .terminal-card__resize-handle"));
}
