import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitRiskReport,
  AgentProviderId,
  AgentChatHistoryItem,
  AgentCliAvailability,
  AppSettings,
  BrowserCanvasState,
  BrowserSnapshot,
  CameraState,
  CanvasRegion,
  FileCard,
  FileRootDescriptor,
  GithubPluginSearchResult,
  HomeAccentColors,
  HomeGridSize,
  HomeWidgetPlacement,
  InstalledPlugin,
  LaunchProfileId,
  LaunchRole,
  PluginLaunchValues,
  SessionEnvironmentChoice,
  LimitsSnapshot,
  Point,
  PluginContribution,
  PluginGridSize,
  PluginInstallPreview,
  PluginManifest,
  PluginUpdateStatus,
  ProviderId,
  SessionBounds,
  SessionSnapshot,
  StickyNote,
  UpdateStatus,
  WindowState
} from "../../shared/contracts";
import {
  DEFAULT_HOME_ACCENT_COLORS,
  DEFAULT_HOME_GRID_SIZE,
  DEFAULT_HOME_LAYOUT,
  DEFAULT_CANVAS_LAUNCHER_ITEMS,
  DEFAULT_RADIAL_LAUNCHER_ITEMS,
  DEFAULT_UI_SCALE,
  keyboardPresetShortcuts
} from "../../shared/contracts";
import { normalizeExternalUrl } from "../../shared/externalUrl";
import {
  createTerminalBorderSkinStyleController,
  type TerminalBorderSkinStyleController
} from "./lib/skinStyles";
import { TitleBar } from "./components/TitleBar";
import { Toast } from "./components/Toast";
import { environmentOptions } from "./features/launcher/LaunchOptionsSection";
import { UpdateNotice } from "./components/UpdateNotice";
import { resolveAppearanceSettings } from "./features/settings/appearanceSettings";
import { persistSettingsUpdate } from "./features/settings/persistSettings";
import { PluginBrowserOpenQueue } from "./features/plugins/PluginBrowserOpenQueue";
import {
  EMPTY_FILE_CARD_RUNTIME,
  type FileCardRuntimeState
} from "./features/files/fileCardRuntime";
import { fileCardToRootReference, isFileRootUsable } from "./features/files/fileCardRestore";
import { matchQuickOpen, toggleExpandedFolder } from "./features/files/fileTree";
import type { FileSessionOption } from "./features/files/FileBrowserCard";
import { GitRiskNotice } from "./features/terminal/GitRiskNotice";
import { WorkspaceCanvas } from "./features/workspace/WorkspaceCanvas";
import { createCameraStore } from "./features/workspace/cameraStore";
import { isPixelSkinThemeId } from "./features/skins/skinCatalog";
import { isPixelSkinPackId } from "./features/skins/SkinAssets";
import { expandedPixelSkinCardBounds, PIXEL_SKIN_CARD_SIZE } from "./features/skins/pixelSkinCardGeometry";
import type { LimitsLoadState } from "./features/home/homeModel";
import { markBootOnce } from "./lib/bootMarks";
import { afterNextPaint, loadCriticalSnapshot } from "./lib/bootSequence";
import { t } from "./lib/i18n";
import { AGENT_PROVIDERS, LIMIT_PROVIDERS } from "./lib/providers";
import { updateNoticeForStatus, updateNoticeKey, type UpdateNoticeAction } from "./lib/updateNotice";
import {
  mergeSessionSnapshots,
  upsertSession,
  upsertSnapshot
} from "./lib/sessionReconciliation";
import {
  handleMacNativeSelectAll,
  isRenameInputTarget,
  isShortcutCaptureTarget,
  matchesPointerShortcut,
  matchesShortcut,
  shouldKeepNativeKeyboardInput
} from "./lib/shortcuts";
import { homeGridPixelSize, homeLayoutFitsGrid, placeHomeWidget } from "./features/home/homeLayout";
import { boundsInsideRegion, translateBounds } from "./features/workspace/canvasRegions";
import { DEFAULT_SESSION_SIZE, findNearHomeSessionPosition } from "./features/workspace/sessionPlacement";

interface HomeEditDraft {
  homeGridSize: HomeGridSize;
  homeLayout: HomeWidgetPlacement[];
}

// Settings and the modal dialogs are not needed for the first paint of the canvas, so their code
// (and everything they alone pull in, like the plugin browser and shortcut editors) is split into
// separate chunks instead of shipping in the app's single startup bundle.
const AgentLaunchDialog = lazy(() =>
  import("./features/launcher/AgentLaunchDialog").then((module) => ({ default: module.AgentLaunchDialog })));
const TerminalLinkDialog = lazy(() =>
  import("./features/terminal/TerminalLinkDialog").then((module) => ({ default: module.TerminalLinkDialog })));
const SettingsPanel = lazy(() =>
  import("./features/settings/SettingsPanel").then((module) => ({ default: module.SettingsPanel })));
const ShortcutReference = lazy(() =>
  import("./components/ShortcutReference").then((module) => ({ default: module.ShortcutReference })));

const FALLBACK_SETTINGS: AppSettings = {
  locale: "ru",
  sessionRestoreMode: "off",
  persistCanvasRegions: true,
  persistStickyNotes: true,
  palette: "sage",
  homeAccentPreset: "classic",
  homeAccentColors: { ...DEFAULT_HOME_ACCENT_COLORS },
  sessionRowColorMode: "status",
  homeLauncherProviders: [...AGENT_PROVIDERS],
  apiProfiles: [],
  homeLimitProviders: [...LIMIT_PROVIDERS],
  canvasLauncherItems: [...DEFAULT_CANVAS_LAUNCHER_ITEMS],
  radialLauncherItems: [...DEFAULT_RADIAL_LAUNCHER_ITEMS],
  radialLauncherEnabled: false,
  agentLifecycleHooksEnabled: true,
  baseProtectionEnabled: true,
  uiScale: DEFAULT_UI_SCALE,
  canvasColor: "sage",
  canvasBackground: "none",
  pattern: "dots",
  terminalBorderSkin: "classic",
  terminalSkinDetail: "detailed",
  terminalSkinAnimationEnabled: true,
  appSkin: "classic",
  snapToGrid: true,
  copyOnSelect: false,
  terminalLinkOpenMode: "ask",
  invertTerminalWheel: true,
  invertCanvasWheel: false,
  edgePan: false,
  edgePanSpeed: "normal",
  zoomSensitivity: "normal",
  useScrollWheelToZoom: false,
  canvasWheelCaptureMode: "key",
  canvasWheelOverride: window.canvasTTY.window.isMacOS ? "Meta" : "Ctrl",
  canvasNavigationOverride: "Alt",
  focusActivation: "off",
  hoverFocus: false,
  hoverFocusSpeed: "normal",
  showShortcutHints: true,
  minimapPlacement: "top-right",
  minimapInteractionMode: "click",
  shortcutHintsPlacement: "bottom-right",
  canvasControlsPlacement: "bottom-left",
  keyboardPreset: window.canvasTTY.window.isMacOS ? "macos" : "linux",
  shortcuts: keyboardPresetShortcuts(window.canvasTTY.window.isMacOS ? "macos" : "linux"),
  mediaPath: null,
  mediaFit: "cover",
  lastDirectory: "/",
  acknowledgedDangerousProfiles: [],
  homeGridSize: { ...DEFAULT_HOME_GRID_SIZE },
  homeLayout: structuredClone(DEFAULT_HOME_LAYOUT),
  canvasRegions: [],
  stickyNotes: [],
  pluginCanvas: [],
  fileCards: [],
  browserCanvas: null,
  browserAgentAccess: true,
  browserShowAgentPresence: true,
  browserRestoreTabs: true,
  browserPauseHiddenTabs: true,
  attentionNotifications: true,
  attentionQueueVisible: true,
  attentionQueuePlacement: "bottom-right",
  agentChatHistoryVisible: false,
  agentChatHistoryPlacement: "top-left",
  agentChatHistoryExpandMode: "hover",
  agentChatHistorySearchAgents: "current",
  agentChatHistorySearchSessions: "filtered",
  agentControlEnabled: false,
  agentIsolation: "on",
  orchestrationMaxDepth: 2,
  orchestrationMaxSubagents: 8,
  defaultLaunchProfile: "auto"
};

const EMPTY_BROWSER_SNAPSHOT: BrowserSnapshot = {
  tabs: [],
  activeTabId: null,
  visible: false,
  agents: [],
  downloads: [],
  pendingDialog: null
};

const DEFAULT_FOCUS_ZOOM = 0.92;
const PLUGIN_CANVAS_FOCUS_ZOOM = 1;
const FILE_CARD_FOCUS_ZOOM = 1;

function startHomeMediaRead(
  path: string,
  read: (path: string) => Promise<string | null>,
  isCurrent: () => boolean,
  setMediaData: (data: string | null) => void
): () => void {
  let active = true;
  void read(path).then((data) => {
    if (active && isCurrent()) setMediaData(data);
  }).catch(() => undefined);
  return () => { active = false; };
}

function consumeProvidedHomeMediaPath(
  path: string,
  providedPathRef: { current: { path: string } | null }
): boolean {
  const provided = providedPathRef.current;
  if (!provided) return false;
  providedPathRef.current = null;
  return provided.path === path;
}

function TerminalBorderSkinStyleHost({ skinId }: { skinId: AppSettings["terminalBorderSkin"] }): null {
  const controllerRef = useRef<TerminalBorderSkinStyleController | null>(null);
  const activeSkinIdRef = useRef(skinId);
  activeSkinIdRef.current = skinId;

  useEffect(() => {
    const controller = createTerminalBorderSkinStyleController(window.canvasTTY.skins, document);
    controllerRef.current = controller;
    controller.setActive(activeSkinIdRef.current);
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setActive(skinId);
  }, [skinId]);

  return null;
}

function customHomeAccentStyle(colors: HomeAccentColors): React.CSSProperties {
  const launcherTile = mixHexWithWhite(colors.launcher, 0.62);
  return {
    "--home-clock": colors.clock,
    "--home-clock-text": readableTextColor(colors.clock),
    "--home-launcher-dock": colors.launcher,
    "--home-launcher-tile": launcherTile,
    "--home-launcher-text": readableTextColor(launcherTile),
    "--home-browser": colors.browser,
    "--home-browser-text": readableTextColor(colors.browser),
    "--home-settings": colors.settings,
    "--home-settings-text": readableTextColor(colors.settings),
    "--home-media": colors.media,
    "--home-media-text": readableTextColor(colors.media)
  } as React.CSSProperties;
}

function mixHexWithWhite(hex: string, sourceWeight: number): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `#${channels.map((channel) => (
    Math.round(channel * sourceWeight + 255 * (1 - sourceWeight)).toString(16).padStart(2, "0")
  )).join("")}`.toUpperCase();
}

function readableTextColor(hex: string): "#30313D" | "#FFFFFF" {
  const background = relativeLuminance(hex);
  const darkContrast = contrastRatio(background, relativeLuminance("#30313D"));
  const lightContrast = contrastRatio(background, 1);
  return darkContrast >= lightContrast ? "#30313D" : "#FFFFFF";
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(left: number, right: number): number {
  const brightest = Math.max(left, right);
  const darkest = Math.min(left, right);
  return (brightest + 0.05) / (darkest + 0.05);
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState(FALLBACK_SETTINGS);
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const pendingSessionPlacements = useRef<SessionBounds[]>([]);
  const [limits, setLimits] = useState<LimitsSnapshot | null>(null);
  const [limitsLoadState, setLimitsLoadState] = useState<LimitsLoadState>("loading");
  const [limitsRevision, setLimitsRevision] = useState(0);
  const [agentAvailability, setAgentAvailability] = useState<AgentCliAvailability | null>(null);
  const [mediaData, setMediaData] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [browser, setBrowser] = useState<BrowserSnapshot>(EMPTY_BROWSER_SNAPSHOT);
  // The camera lives in a store, not in state: a pan or zoom must not render the application tree.
  const [cameraStore] = useState(() => createCameraStore(homeCamera(DEFAULT_HOME_GRID_SIZE)));
  const setCamera = cameraStore.set;
  const isHomeCamera = useRef(true);
  const browserCanvasRef = useRef<BrowserCanvasState | null>(null);
  const mediaReadGenerationRef = useRef(0);
  const providedMediaRef = useRef<{ path: string } | null>(null);
  /**
   * Latest settings, kept in step synchronously by the mutators below. A canvas gesture
   * can commit several windows in one tick; deriving each write from the render-captured
   * `settings` would map the same base array every time and keep only the last one.
   */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pluginBrowserOpenQueueRef = useRef(new PluginBrowserOpenQueue());
  /** Non-persisted Files-card runtime (root handle + loaded listings), keyed by card id. */
  const [fileCardRuntime, setFileCardRuntime] = useState<Record<string, FileCardRuntimeState>>({});
  const fileCardRuntimeRef = useRef(fileCardRuntime);
  fileCardRuntimeRef.current = fileCardRuntime;
  /** Monotonic per-card quick-open sequence, so a stale search cannot overwrite a newer one. */
  const fileSearchSequence = useRef<Record<string, number>>({});
  /** Monotonic per-card read sequence, so a slow earlier read cannot overwrite a newer one. */
  const fileReadSequence = useRef<Record<string, number>>({});
  const [launchProvider, setLaunchProvider] = useState<ProviderId | null>(null);
  const [launchPosition, setLaunchPosition] = useState<Point | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openUpdatesRequest, setOpenUpdatesRequest] = useState(0);
  const [shortcutReferenceOpen, setShortcutReferenceOpen] = useState(false);
  const [homeEditDraft, setHomeEditDraft] = useState<HomeEditDraft | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [browserSelected, setBrowserSelected] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [fullscreenSessionId, setFullscreenSessionId] = useState<string | null>(null);
  const [pendingTerminalUrl, setPendingTerminalUrl] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ type: "idle" });
  const [dismissedUpdateNotice, setDismissedUpdateNotice] = useState<string | null>(null);
  const [updateNoticePending, setUpdateNoticePending] = useState(false);
  const updateNoticePendingRef = useRef(false);
  /** Git risk reports about cards that were closed (GitRiskNotice): shown until the person answers them. */
  const [closedGitRisks, setClosedGitRisks] = useState<GitRiskReport[]>([]);
  // Boot phases (bootSequence.ts): `ready` once the critical snapshot (settings, CLI availability, session
  // metadata, installed plugins) is in and the canvas may mount; `surfacesMounted` once that first stable frame
  // was painted, when restored terminals, plugin and browser cards mount and deferred work (browser runtime,
  // HOME media, limits) starts.
  const [ready, setReady] = useState(false);
  const [surfacesMounted, setSurfacesMounted] = useState(false);
  const [windowState, setWindowState] = useState<WindowState>({
    isMacOS: window.canvasTTY.window.isMacOS,
    maximized: false,
    fullscreen: false
  });

  const showToast = useCallback((message: string): void => setToast(message), []);
  const fileSessionOptions = useMemo<FileSessionOption[]>(
    () => sessions.map((session) => ({ sessionId: session.id, label: session.title })),
    [sessions]
  );

  const openUpdates = useCallback((): void => {
    setSettingsOpen(true);
    setOpenUpdatesRequest(request => request + 1);
  }, []);

  const runUpdateNoticeAction = useCallback((action: UpdateNoticeAction): void => {
    if (updateNoticePendingRef.current) return;
    let operation: Promise<void>;
    if (action === "manual") {
      if (updateStatus.type !== "available" || !updateStatus.manualUrl) return;
      operation = window.canvasTTY.external.openUrl(updateStatus.manualUrl);
    } else {
      operation = action === "download" ? window.canvasTTY.update.download() : window.canvasTTY.update.install();
    }
    updateNoticePendingRef.current = true;
    setUpdateNoticePending(true);
    void operation.catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : settings.locale === "ru" ? "Не удалось выполнить действие с обновлением" : "Update action failed");
      if (action !== "manual") openUpdates();
    }).finally(() => {
      updateNoticePendingRef.current = false;
      setUpdateNoticePending(false);
    });
  }, [openUpdates, settings.locale, showToast, updateStatus]);

  useEffect(() => window.canvasTTY.window.onOpenUpdates(openUpdates), [openUpdates]);

  useEffect(() => {
    let live = true;
    let eventSeen = false;
    const unsubscribe = window.canvasTTY.update.onStatus(status => {
      eventSeen = true;
      if (live) setUpdateStatus(status);
    });
    void window.canvasTTY.update.status().then(status => {
      if (live && !eventSeen) setUpdateStatus(status);
    }).catch(() => undefined);
    return () => { live = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    browserCanvasRef.current = settings.browserCanvas;
  }, [settings.browserCanvas]);

  useEffect(() => {
    // The first frame where the loading screen is gone and the workspace shows real data: the
    // point startup-latency measurements care about, not just "some DOM exists". Two frames: the
    // second callback runs after the first frame with this commit was produced. HOME is actionable in
    // that same frame when it is on screen: its data (settings, availability, sessions) is loaded and
    // the main process answered, so a launcher click reaches a live service.
    if (!ready) return;
    return afterNextPaint(() => {
      markBootOnce("firstStableFrame");
      if (document.querySelector(".home-zone") && !document.querySelector(".loading-screen")) markBootOnce("homeActionable");
      setSurfacesMounted(true);
    });
  }, [ready]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2_600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const unsubscribe = window.canvasTTY.window.onState(setWindowState);
    void window.canvasTTY.window.getState().then(setWindowState);
    return unsubscribe;
  }, []);

  useEffect(() => {
    let active = true;
    // Cards removed before the startup list arrives: that list is older and must not restore them.
    const removedBeforeList = new Set<string>();
    const unsubscribeSession = window.canvasTTY.terminal.onSession(({ session }) => {
      if (active) setSessions((current) => upsertSession(current, session));
    });
    const unsubscribeGitRisk = window.canvasTTY.terminal.onGitRisk((report) => {
      if (active) setClosedGitRisks((current) => [...current.filter((entry) => entry.id !== report.id), report].slice(-8));
    });
    const unsubscribeRemoved = window.canvasTTY.terminal.onRemoved(({ id }) => {
      if (!active) return;
      removedBeforeList.add(id);
      setSessions((current) => current.filter((session) => session.id !== id));
      setActiveSessionId((current) => current === id ? null : current);
      setRenamingSessionId((current) => current === id ? null : current);
    });

    const unsubscribeSettings = window.canvasTTY.settings.onChanged((next) => {
      if (active) setSettings(next);
    });
    void loadCriticalSnapshot(window.canvasTTY)
      .then((snapshot) => {
        if (!active) return;
        setSettings(snapshot.settings);
        setAgentAvailability(snapshot.availability);
        setSessions((current) => mergeSessionSnapshots(current, snapshot.sessions, removedBeforeList));
        setPlugins(snapshot.plugins);
        if (isHomeCamera.current) setCamera(homeCamera(snapshot.settings.homeGridSize));
      })
      .catch((error) => showToast(error instanceof Error ? error.message : "CanvasTTY initialization failed"))
      .finally(() => active && setReady(true));

    return () => {
      active = false;
      unsubscribeSession();
      unsubscribeRemoved();
      unsubscribeGitRisk();
      unsubscribeSettings();
    };
  }, [showToast]);

  useEffect(() => {
    // Deferred until the first stable frame is on screen: the browser card's runtime (its WebContents and page
    // load) and the HOME media file are not part of that frame, and both cost main-process and IPC time.
    if (!surfacesMounted) return;
    let active = true;
    const current = settingsRef.current;
    const browserApi = window.canvasTTY.browser;
    if (current.browserCanvas && browserApi) {
      void browserApi.open().then((state) => { if (active) setBrowser(state); })
        .catch((error: unknown) => showToast(error instanceof Error ? error.message : t(current.locale, "browserActionFailed")));
    }
    return () => { active = false; };
  }, [showToast, surfacesMounted]);

  useEffect(() => {
    // HOME media remains deferred until after the first stable frame, then follows settings changes.
    if (!surfacesMounted) return;
    const path = settings.mediaPath;
    if (!path) {
      setMediaData(null);
      return;
    }

    if (consumeProvidedHomeMediaPath(path, providedMediaRef)) return;

    const generation = ++mediaReadGenerationRef.current;
    return startHomeMediaRead(
      path,
      (mediaPath) => window.canvasTTY.media.read(mediaPath),
      () => mediaReadGenerationRef.current === generation && settingsRef.current.mediaPath === path,
      setMediaData
    );
  }, [settings.mediaPath, surfacesMounted]);

  useEffect(() => {
    const browserApi = window.canvasTTY.browser;
    if (!browserApi) return;
    const unsubscribe = browserApi.onState(({ snapshot }) => setBrowser(snapshot));
    void browserApi.getState().then(setBrowser).catch(() => undefined);
    return unsubscribe;
  }, []);

  useEffect(() => {
    // Limits are not part of the first frame (HOME shows them as loading) and a read can start provider CLIs in
    // the main process: they wait for the first stable frame.
    if (!surfacesMounted) return;
    let active = true;
    let requestRunning = false;
    let timer: number | null = null;

    const refreshLimits = async (): Promise<void> => {
      if (requestRunning) return;
      requestRunning = true;
      try {
        const snapshot = await window.canvasTTY.limits.get();
        if (!active) return;
        setLimits(snapshot);
        setLimitsLoadState("ready");
      } catch {
        if (active) setLimitsLoadState("error");
      } finally {
        requestRunning = false;
      }
    };

    const refreshAndSchedule = async (): Promise<void> => {
      // A hidden window reads no limits: nobody sees them, and each Codex read keeps a
      // `codex app-server` process (about 55-60 MB) alive in the main process. Reading
      // resumes the moment the window is visible again.
      if (document.visibilityState === "hidden") return;
      await refreshLimits();
      if (active && timer === null) {
        timer = window.setTimeout(() => {
          timer = null;
          void refreshAndSchedule();
        }, 60_000);
      }
    };
    const resumeWhenVisible = (): void => {
      if (active && timer === null && document.visibilityState === "visible") void refreshAndSchedule();
    };

    void refreshAndSchedule();
    document.addEventListener("visibilitychange", resumeWhenVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", resumeWhenVisible);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [limitsRevision, surfacesMounted]);

  useEffect(() => {
    const recenterHome = (): void => {
      if (isHomeCamera.current) setCamera(homeCamera(settings.homeGridSize));
    };
    window.addEventListener("resize", recenterHome);
    return () => window.removeEventListener("resize", recenterHome);
  }, [settings.homeGridSize]);

  const persistSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    await persistSettingsUpdate(
      (nextPatch) => window.canvasTTY.settings.update(nextPatch),
      (updated) => setSettings(updated),
      patch
    );
  }, []);

  const saveSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      await persistSettings(patch);
    } catch {
      showToast(t(settings.locale, "settingsFailed"));
    }
  }, [persistSettings, settings.locale, showToast]);

  const recheckAgentClis = useCallback(async (): Promise<void> => {
    const result = await window.canvasTTY.agents.recheck();
    setAgentAvailability(result.availability);
    setSettings(result.settings);
    setLimits(null);
    setLimitsLoadState("loading");
    setLimitsRevision((current) => current + 1);
  }, []);

  const createSession = useCallback(async (
    provider: ProviderId,
    profile: LaunchProfileId,
    cwd: string,
    requestedCenter?: Point,
    role: LaunchRole = "agent",
    launchOptions?: Record<string, PluginLaunchValues>,
    environment?: SessionEnvironmentChoice
  ): Promise<SessionSnapshot> => {
    const currentSettings = settingsRef.current;
    const pixelSkin = isPixelSkinThemeId(currentSettings.terminalBorderSkin)
      || isPixelSkinPackId(currentSettings.terminalBorderSkin);
    const cardSize = pixelSkin ? PIXEL_SKIN_CARD_SIZE : DEFAULT_SESSION_SIZE;
    const position = requestedCenter
      ? centeredWindowPosition(requestedCenter, cardSize)
      : findNearHomeSessionPosition(
          { position: { x: 0, y: 0 }, size: homeGridPixelSize(currentSettings.homeGridSize) },
          [
            ...sessionsRef.current,
            ...currentSettings.pluginCanvas,
            ...currentSettings.stickyNotes,
            ...(currentSettings.browserCanvas ? [currentSettings.browserCanvas] : []),
            ...pendingSessionPlacements.current
          ],
          cardSize
        );
    // Reserve the slot until the async create finishes, so fast parallel launches
    // cannot both choose the same free position before React renders either card.
    const reservation: SessionBounds | null = requestedCenter
      ? null
      : { position, size: cardSize };
    if (reservation) pendingSessionPlacements.current.push(reservation);
    try {
      const session = await window.canvasTTY.terminal.create({
        provider, profile, cwd, position, role, ...(launchOptions ? { launchOptions } : {}),
        ...(environment ? { environment } : {})
      });
      const sizedSession = pixelSkin ? { ...session, size: { ...cardSize } } : session;
      if (pixelSkin) window.canvasTTY.terminal.setBounds(session.id, { position, size: sizedSession.size });
      sessionsRef.current = upsertSnapshot(sessionsRef.current, sizedSession);
      setSessions((current) => upsertSnapshot(current, sizedSession));
      setActiveSessionId(session.id);
      await saveSettings({ lastDirectory: cwd });
      isHomeCamera.current = false;
      setCamera(focusCamera(position, sizedSession.size));
      return sizedSession;
    } finally {
      if (reservation) {
        pendingSessionPlacements.current = pendingSessionPlacements.current.filter((item) => item !== reservation);
      }
    }
  }, [saveSettings]);

  const openTerminal = useCallback(async (position?: Point): Promise<void> => {
    // With a trusted plugin environment for terminals, ask where it runs; otherwise open at once as always.
    const installed = await window.canvasTTY.plugins.list().catch(() => plugins);
    if (environmentOptions(installed, "terminal").length > 0) {
      setLaunchPosition(position ?? null);
      setLaunchProvider("terminal");
      return;
    }
    try {
      await createSession("terminal", "normal", settings.lastDirectory, position);
      showToast(t(settings.locale, "terminalStarted"));
    } catch (error) {
      showToast(error instanceof Error ? error.message : t(settings.locale, "launchFailed"));
    }
  }, [createSession, plugins, settings.lastDirectory, settings.locale, showToast]);

  const openAgent = useCallback((provider: AgentProviderId, position?: Point): void => {
    if (!agentAvailability?.[provider]) {
      showToast(t(settings.locale, "agentCliNotFound"));
      return;
    }
    setLaunchPosition(position ?? null);
    setLaunchProvider(provider);
  }, [agentAvailability, settings.locale, showToast]);

  useEffect(() => window.canvasTTY.plugins.onOpenLauncher(({ provider }) => {
    if (provider === "terminal") void openTerminal();
    else openAgent(provider);
  }), [openAgent, openTerminal]);


  const launchAgent = useCallback(async (
    provider: ProviderId,
    profile: LaunchProfileId,
    cwd: string,
    role: LaunchRole,
    launchOptions?: Record<string, PluginLaunchValues>,
    environment?: SessionEnvironmentChoice
  ): Promise<void> => {
    await createSession(provider, profile, cwd, launchPosition ?? undefined, role, launchOptions, environment);
    setLaunchPosition(null);
    showToast(provider === "terminal" ? t(settings.locale, "terminalStarted") : `${t(settings.locale, "sessionStarted")}: ${provider}`);
  }, [createSession, launchPosition, settings.locale, showToast]);

  const restartSession = useCallback(async (id: string, resume = false): Promise<void> => {
    try {
      await window.canvasTTY.terminal.restart(id, { resume });
      showToast(t(settings.locale, "sessionRestarted"));
    } catch (error) {
      showToast(error instanceof Error ? error.message : t(settings.locale, "restartFailed"));
    }
  }, [settings.locale, showToast]);

  const acknowledgeDanger = useCallback(async (provider: AgentProviderId): Promise<void> => {
    if (settings.acknowledgedDangerousProfiles.includes(provider)) return;
    await saveSettings({
      acknowledgedDangerousProfiles: [...settings.acknowledgedDangerousProfiles, provider]
    });
  }, [saveSettings, settings.acknowledgedDangerousProfiles]);

  const requestMedia = useCallback(async (): Promise<void> => {
    try {
      const selection = await window.canvasTTY.dialog.pickMedia();
      if (!selection) return;

      if (settingsRef.current.mediaPath === selection.path) {
        // A same-path deferred read may already be pending; its result must not replace this data URL.
        mediaReadGenerationRef.current += 1;
      } else {
        // Settings can notify before update() resolves, so suppress the path effect synchronously.
        providedMediaRef.current = { path: selection.path };
      }
      const updated = await window.canvasTTY.settings.update({ mediaPath: selection.path });
      setSettings(updated);
      setMediaData(selection.dataUrl);
    } catch {
      providedMediaRef.current = null;
      showToast(t(settings.locale, "mediaFailed"));
    }
  }, [settings.locale, showToast]);

  const removeMedia = useCallback(async (): Promise<void> => {
    try {
      const updated = await window.canvasTTY.settings.update({ mediaPath: null });
      mediaReadGenerationRef.current += 1;
      setSettings(updated);
      setMediaData(null);
    } catch {
      showToast(t(settings.locale, "mediaFailed"));
    }
  }, [settings.locale, showToast]);

  const changeSessionBounds = useCallback((id: string, bounds: SessionBounds): void => {
    setSessions((current) => current.map((session) => session.id === id
      ? { ...session, position: bounds.position, size: bounds.size }
      : session));
    window.canvasTTY.terminal.setBounds(id, bounds);
  }, []);

  const toggleSessionFullscreen = useCallback((id: string): void => {
    if (fullscreenSessionId === id) {
      // Exit fullscreen: only update state, no bounds persistence
      // Note: Camera position is preserved intentionally (BUG 3 mitigation).
      // If the user panned/zoomed during fullscreen, the camera stays where they left it.
      setFullscreenSessionId(null);
    } else {
      // Enter fullscreen: exit current fullscreen first if switching sessions (BUG 2)
      if (fullscreenSessionId !== null) {
        setFullscreenSessionId(null);
      }
      setFullscreenSessionId(id);
    }
  }, [fullscreenSessionId]);

  const previousBorderSkin = useRef<AppSettings["terminalBorderSkin"] | null>(null);
  useEffect(() => {
    if (!ready) return;
    const previous = previousBorderSkin.current;
    previousBorderSkin.current = settings.terminalBorderSkin;
    // Expand only when entering pixel styling; preserve restored and manually resized bounds.
    if (previous === null || previous === settings.terminalBorderSkin
      || isPixelSkinThemeId(previous) || isPixelSkinPackId(previous)
      || !(isPixelSkinThemeId(settings.terminalBorderSkin)
      || isPixelSkinPackId(settings.terminalBorderSkin))) return;
    const expanded = expandedPixelSkinCardBounds(sessions);
    for (const { id, bounds } of expanded) changeSessionBounds(id, bounds);
    const active = expanded.find(({ id }) => id === activeSessionId);
    if (active && !isHomeCamera.current) setCamera(focusCamera(active.bounds.position, active.bounds.size));
  }, [activeSessionId, changeSessionBounds, ready, sessions, settings.terminalBorderSkin]);

  const changePluginCanvasBounds = useCallback((id: string, bounds: SessionBounds): void => {
    const pluginCanvas = settingsRef.current.pluginCanvas.map((instance) => instance.id === id
      ? { ...instance, position: bounds.position, size: bounds.size }
      : instance);
    settingsRef.current = { ...settingsRef.current, pluginCanvas };
    setSettings((current) => ({ ...current, pluginCanvas }));
    void saveSettings({ pluginCanvas });
  }, [saveSettings]);

  const changeBrowserBounds = useCallback((browserCanvas: BrowserCanvasState): void => {
    browserCanvasRef.current = browserCanvas;
    setSettings((current) => ({ ...current, browserCanvas }));
    void saveSettings({ browserCanvas });
  }, [saveSettings]);

  const createCanvasRegion = useCallback((region: CanvasRegion): void => {
    const canvasRegions = [...settingsRef.current.canvasRegions, region];
    settingsRef.current = { ...settingsRef.current, canvasRegions };
    setSettings((current) => ({ ...current, canvasRegions }));
    void saveSettings({ canvasRegions });
  }, [saveSettings]);

  const changeCanvasRegion = useCallback((region: CanvasRegion): void => {
    const canvasRegions = settingsRef.current.canvasRegions.map((candidate) => candidate.id === region.id ? region : candidate);
    settingsRef.current = { ...settingsRef.current, canvasRegions };
    setSettings((current) => ({ ...current, canvasRegions }));
    void saveSettings({ canvasRegions });
  }, [saveSettings]);

  const createStickyNote = useCallback((note: StickyNote): void => {
    const stickyNotes = [...settingsRef.current.stickyNotes, note];
    settingsRef.current = { ...settingsRef.current, stickyNotes };
    setSettings((current) => ({ ...current, stickyNotes }));
    void saveSettings({ stickyNotes });
  }, [saveSettings]);

  const changeStickyNoteBounds = useCallback((id: string, bounds: SessionBounds): void => {
    const stickyNotes = settingsRef.current.stickyNotes.map((note) => note.id === id
      ? { ...note, position: bounds.position, size: bounds.size }
      : note);
    settingsRef.current = { ...settingsRef.current, stickyNotes };
    setSettings((current) => ({ ...current, stickyNotes }));
    void saveSettings({ stickyNotes });
  }, [saveSettings]);

  const changeStickyNoteText = useCallback((id: string, text: string): void => {
    const stickyNotes = settingsRef.current.stickyNotes.map((note) => note.id === id ? { ...note, text } : note);
    settingsRef.current = { ...settingsRef.current, stickyNotes };
    setSettings((current) => ({ ...current, stickyNotes }));
    void saveSettings({ stickyNotes });
  }, [saveSettings]);

  const deleteStickyNote = useCallback((id: string): void => {
    const stickyNotes = settingsRef.current.stickyNotes.filter((note) => note.id !== id);
    settingsRef.current = { ...settingsRef.current, stickyNotes };
    setSettings((current) => ({ ...current, stickyNotes }));
    void saveSettings({ stickyNotes });
  }, [saveSettings]);

  const changeCanvasRegionBounds = useCallback((
    id: string,
    bounds: SessionBounds,
    interaction: "move" | "resize"
  ): void => {
    const previous = settingsRef.current.canvasRegions.find((region) => region.id === id);
    if (!previous) return;
    const canvasRegions = settingsRef.current.canvasRegions.map((region) => region.id === id
      ? { ...region, position: bounds.position, size: bounds.size }
      : region);
    const patch: Partial<AppSettings> = { canvasRegions };

    if (interaction === "move") {
      const delta = {
        x: bounds.position.x - previous.position.x,
        y: bounds.position.y - previous.position.y
      };
      if (delta.x !== 0 || delta.y !== 0) {
        const movedSessions = sessions.map((session) => {
          if (!boundsInsideRegion(session, previous)) return session;
          const moved = translateBounds(session, delta);
          window.canvasTTY.terminal.setBounds(session.id, moved);
          return { ...session, ...moved };
        });
        const pluginCanvas = settingsRef.current.pluginCanvas.map((instance) => {
          if (!boundsInsideRegion(instance, previous)) return instance;
          const moved = translateBounds(instance, delta);
          return { ...instance, ...moved };
        });
        const currentBrowser = settingsRef.current.browserCanvas;
        const browserCanvas = currentBrowser && boundsInsideRegion(currentBrowser, previous)
          ? translateBounds(currentBrowser, delta)
          : currentBrowser;
        const stickyNotes = settingsRef.current.stickyNotes.map((note) => boundsInsideRegion(note, previous)
          ? { ...note, ...translateBounds(note, delta) }
          : note);
        const fileCards = settingsRef.current.fileCards.map((card) => boundsInsideRegion(card, previous)
          ? { ...card, ...translateBounds(card, delta) }
          : card);
        setSessions(movedSessions);
        patch.pluginCanvas = pluginCanvas;
        patch.browserCanvas = browserCanvas;
        patch.stickyNotes = stickyNotes;
        patch.fileCards = fileCards;
        browserCanvasRef.current = browserCanvas;
      }
    }

    settingsRef.current = { ...settingsRef.current, ...patch };
    setSettings((current) => ({ ...current, ...patch }));
    void saveSettings(patch);
  }, [saveSettings, sessions]);

  const deleteCanvasRegion = useCallback((id: string): void => {
    const canvasRegions = settingsRef.current.canvasRegions.filter((region) => region.id !== id);
    settingsRef.current = { ...settingsRef.current, canvasRegions };
    setSettings((current) => ({ ...current, canvasRegions }));
    void saveSettings({ canvasRegions });
  }, [saveSettings]);

  const updateFileCardRuntime = useCallback((
    id: string,
    update: (state: FileCardRuntimeState) => Partial<FileCardRuntimeState>
  ): void => {
    setFileCardRuntime((current) => {
      const base = current[id] ?? EMPTY_FILE_CARD_RUNTIME;
      return { ...current, [id]: { ...base, ...update(base) } };
    });
  }, []);

  const writeFileCards = useCallback((fileCards: FileCard[]): void => {
    settingsRef.current = { ...settingsRef.current, fileCards };
    setSettings((current) => ({ ...current, fileCards }));
    void saveSettings({ fileCards });
  }, [saveSettings]);

  const updateFileCard = useCallback((id: string, patch: Partial<FileCard>): void => {
    writeFileCards(settingsRef.current.fileCards.map((card) => (
      card.id === id ? { ...card, ...patch } : card
    )));
  }, [writeFileCards]);

  /** Releases a card's currently registered root, if any. Safe to call when none. */
  const releaseFileCardRoot = useCallback((id: string): void => {
    const rootId = fileCardRuntimeRef.current[id]?.root?.rootId ?? null;
    if (rootId) void window.canvasTTY.files.closeRoot(rootId).catch(() => undefined);
  }, []);

  const loadFileRoot = useCallback(async (id: string, descriptor: FileRootDescriptor): Promise<void> => {
    updateFileCardRuntime(id, () => ({
      root: descriptor,
      rootUnavailable: !descriptor.available,
      loading: descriptor.available,
      error: null,
      entries: [],
      childrenByDirectory: {},
      readResult: null,
      quickOpenQuery: "",
      quickOpenResults: []
    }));
    if (!descriptor.available) return;
    try {
      const entries = await window.canvasTTY.files.list(descriptor.rootId, "");
      updateFileCardRuntime(id, () => ({ entries, loading: false }));
    } catch (error) {
      updateFileCardRuntime(id, () => ({ loading: false, error: fileErrorMessage(error) }));
    }
  }, [updateFileCardRuntime]);

  const chooseFileFolder = useCallback((id: string): void => {
    void (async () => {
      try {
        const descriptor = await window.canvasTTY.files.openFolder();
        if (!descriptor) return;
        // The card may have closed while the native dialog was open; release the
        // freshly registered root instead of leaking it.
        if (!settingsRef.current.fileCards.some((card) => card.id === id)) {
          void window.canvasTTY.files.closeRoot(descriptor.rootId).catch(() => undefined);
          return;
        }
        releaseFileCardRoot(id);
        fileReadSequence.current[id] = (fileReadSequence.current[id] ?? 0) + 1;
        updateFileCard(id, {
          root: { rootType: "folder" },
          label: descriptor.label,
          folderPath: descriptor.folderPath ?? null,
          activeFile: null,
          expandedFolders: []
        });
        await loadFileRoot(id, descriptor);
      } catch (error) {
        updateFileCardRuntime(id, () => ({ loading: false, error: fileErrorMessage(error) }));
      }
    })();
  }, [loadFileRoot, releaseFileCardRoot, updateFileCard, updateFileCardRuntime]);

  const registerFileSession = useCallback((id: string, sessionId: string): void => {
    void (async () => {
      try {
        const descriptor = await window.canvasTTY.files.registerRoot({ rootType: "session", sessionId });
        if (!descriptor) {
          updateFileCardRuntime(id, () => ({ rootUnavailable: true, loading: false, error: null }));
          return;
        }
        if (!settingsRef.current.fileCards.some((card) => card.id === id)) {
          void window.canvasTTY.files.closeRoot(descriptor.rootId).catch(() => undefined);
          return;
        }
        releaseFileCardRoot(id);
        fileReadSequence.current[id] = (fileReadSequence.current[id] ?? 0) + 1;
        updateFileCard(id, {
          root: { rootType: "session", sessionId },
          label: descriptor.label,
          folderPath: null,
          activeFile: null,
          expandedFolders: []
        });
        await loadFileRoot(id, descriptor);
      } catch (error) {
        updateFileCardRuntime(id, () => ({ loading: false, error: fileErrorMessage(error) }));
      }
    })();
  }, [loadFileRoot, releaseFileCardRoot, updateFileCard, updateFileCardRuntime]);

  const openFileDirectory = useCallback((id: string, relativePath: string): void => {
    const card = settingsRef.current.fileCards.find((candidate) => candidate.id === id);
    const runtime = fileCardRuntimeRef.current[id];
    const root = runtime?.root ?? null;
    if (!card || !root || runtime?.rootUnavailable) return;
    const wasExpanded = card.expandedFolders.includes(relativePath);
    updateFileCard(id, { expandedFolders: toggleExpandedFolder(card.expandedFolders, relativePath) });
    if (wasExpanded || runtime.childrenByDirectory[relativePath] !== undefined) return;
    updateFileCardRuntime(id, () => ({ loading: true, error: null }));
    void window.canvasTTY.files.list(root.rootId, relativePath).then(
      (entries) => updateFileCardRuntime(id, (state) => ({
        loading: false,
        childrenByDirectory: { ...state.childrenByDirectory, [relativePath]: entries }
      })),
      (error: unknown) => updateFileCardRuntime(id, () => ({
        loading: false,
        error: fileErrorMessage(error)
      }))
    );
  }, [updateFileCard, updateFileCardRuntime]);

  const openFile = useCallback((id: string, relativePath: string): void => {
    const runtime = fileCardRuntimeRef.current[id];
    const root = runtime?.root ?? null;
    if (!root || runtime?.rootUnavailable) return;
    updateFileCard(id, { activeFile: relativePath });
    // Clear the binding so a still-in-flight read cannot render the previous file.
    updateFileCardRuntime(id, () => ({ readResult: null, loading: true, error: null }));
    const sequence = (fileReadSequence.current[id] ?? 0) + 1;
    fileReadSequence.current[id] = sequence;
    void window.canvasTTY.files.read(root.rootId, relativePath).then(
      (result) => {
        if (fileReadSequence.current[id] !== sequence) return;
        updateFileCardRuntime(id, () => ({
          loading: false,
          readResult: { relativePath, result }
        }));
      },
      (error: unknown) => {
        if (fileReadSequence.current[id] !== sequence) return;
        updateFileCardRuntime(id, () => ({
          loading: false,
          readResult: null,
          error: fileErrorMessage(error)
        }));
      }
    );
  }, [updateFileCard, updateFileCardRuntime]);

  const quickOpenFiles = useCallback((id: string, query: string): void => {
    updateFileCardRuntime(id, () => ({ quickOpenQuery: query }));
    const sequence = (fileSearchSequence.current[id] ?? 0) + 1;
    fileSearchSequence.current[id] = sequence;
    const runtime = fileCardRuntimeRef.current[id];
    const root = runtime?.root ?? null;
    if (query.trim() === "" || !root || runtime?.rootUnavailable) {
      updateFileCardRuntime(id, () => ({ quickOpenResults: [], loading: false }));
      return;
    }
    updateFileCardRuntime(id, () => ({ loading: true, quickOpenResults: [], error: null }));
    void window.canvasTTY.files.search(root.rootId, query).then(
      (result) => {
        if (fileSearchSequence.current[id] !== sequence) return;
        updateFileCardRuntime(id, () => ({
          loading: false,
          quickOpenResults: matchQuickOpen(result.relativePaths, query)
        }));
      },
      (error: unknown) => {
        if (fileSearchSequence.current[id] !== sequence) return;
        updateFileCardRuntime(id, () => ({ loading: false, error: fileErrorMessage(error) }));
      }
    );
  }, [updateFileCardRuntime]);

  /**
   * Re-registers one persisted Files card's root on launch. A session root is
   * resolved through its session id; a folder root is reopened by its persisted
   * canonical path. A null/unavailable registration shows the explicit
   * unavailable state and reads nothing; a card that never chose a root stays in
   * the root-selection state instead.
   */
  const restoreFileCard = useCallback(async (card: FileCard): Promise<void> => {
    const reference = fileCardToRootReference(card);
    if (!reference) {
      updateFileCardRuntime(card.id, () => ({ ...EMPTY_FILE_CARD_RUNTIME }));
      return;
    }
    const stillOpen = (): boolean => settingsRef.current.fileCards.some((candidate) => candidate.id === card.id);
    const releaseRoot = (rootId: string): void => {
      void window.canvasTTY.files.closeRoot(rootId).catch(() => undefined);
    };
    let descriptor: FileRootDescriptor | null = null;
    try {
      descriptor = await window.canvasTTY.files.registerRoot(reference);
    } catch (error) {
      if (!stillOpen()) return;
      updateFileCardRuntime(card.id, () => ({
        ...EMPTY_FILE_CARD_RUNTIME,
        rootUnavailable: true,
        error: fileErrorMessage(error)
      }));
      return;
    }
    if (descriptor !== null && !stillOpen()) {
      releaseRoot(descriptor.rootId);
      return;
    }
    if (!isFileRootUsable(descriptor)) {
      updateFileCardRuntime(card.id, () => ({ ...EMPTY_FILE_CARD_RUNTIME, rootUnavailable: true }));
      return;
    }
    const root = descriptor;
    updateFileCardRuntime(card.id, () => ({ ...EMPTY_FILE_CARD_RUNTIME, root, loading: true }));
    try {
      const entries = await window.canvasTTY.files.list(root.rootId, "");
      if (!stillOpen()) {
        releaseRoot(root.rootId);
        return;
      }
      updateFileCardRuntime(card.id, () => ({ entries, loading: false }));
    } catch (error) {
      if (!stillOpen()) return;
      updateFileCardRuntime(card.id, () => ({ loading: false, error: fileErrorMessage(error) }));
      return;
    }
    for (const folder of card.expandedFolders) {
      try {
        const children = await window.canvasTTY.files.list(root.rootId, folder);
        if (!stillOpen()) {
          releaseRoot(root.rootId);
          return;
        }
        updateFileCardRuntime(card.id, (state) => ({
          childrenByDirectory: { ...state.childrenByDirectory, [folder]: children }
        }));
      } catch {
        // A folder that disappeared stays unloaded; the rest of the tree restores.
      }
    }
    if (card.activeFile) {
      const relativePath = card.activeFile;
      updateFileCardRuntime(card.id, () => ({ loading: true }));
      try {
        const result = await window.canvasTTY.files.read(root.rootId, relativePath);
        if (!stillOpen()) {
          releaseRoot(root.rootId);
          return;
        }
        updateFileCardRuntime(card.id, () => ({
          loading: false,
          readResult: { relativePath, result }
        }));
      } catch (error) {
        if (!stillOpen()) return;
        updateFileCardRuntime(card.id, () => ({
          loading: false,
          readResult: null,
          error: fileErrorMessage(error)
        }));
      }
    }
  }, [updateFileCardRuntime]);

  const fileCardsRestored = useRef(false);
  useEffect(() => {
    if (!ready || fileCardsRestored.current) return;
    fileCardsRestored.current = true;
    for (const card of settingsRef.current.fileCards) void restoreFileCard(card);
  }, [ready, restoreFileCard]);

  const changeFileCardBounds = useCallback((id: string, bounds: SessionBounds): void => {
    updateFileCard(id, { position: bounds.position, size: bounds.size });
  }, [updateFileCard]);

  const closeFileCard = useCallback((id: string): void => {
    const rootId = fileCardRuntimeRef.current[id]?.root?.rootId ?? null;
    delete fileSearchSequence.current[id];
    delete fileReadSequence.current[id];
    setFileCardRuntime((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    writeFileCards(settingsRef.current.fileCards.filter((card) => card.id !== id));
    if (rootId) void window.canvasTTY.files.closeRoot(rootId).catch(() => undefined);
  }, [writeFileCards]);

  const focusFileCard = useCallback((id: string): void => {
    const card = settingsRef.current.fileCards.find((candidate) => candidate.id === id);
    if (!card) return;
    setActiveSessionId(null);
    setBrowserSelected(false);
    isHomeCamera.current = false;
    setCamera(focusCamera(card.position, card.size, FILE_CARD_FOCUS_ZOOM));
  }, []);

  const openFilesCard = useCallback((position?: Point): void => {
    const id = crypto.randomUUID();
    const size = { width: 780, height: 520 };
    const index = settingsRef.current.fileCards.length;
    const homeSize = homeGridPixelSize(settings.homeGridSize);
    const card: FileCard = {
      id,
      root: { rootType: "folder" },
      label: null,
      folderPath: null,
      activeFile: null,
      expandedFolders: [],
      position: position
        ? centeredWindowPosition(position, size)
        : { x: homeSize.width + 160 + (index % 2) * 820, y: Math.floor(index / 2) * 560 + 20 },
      size
    };
    writeFileCards([...settingsRef.current.fileCards, card]);
    setFileCardRuntime((current) => ({ ...current, [id]: EMPTY_FILE_CARD_RUNTIME }));
    setActiveSessionId(null);
    setBrowserSelected(false);
    isHomeCamera.current = false;
    setCamera(focusCamera(card.position, card.size, FILE_CARD_FOCUS_ZOOM));
  }, [settings.homeGridSize, writeFileCards]);

  const disposePluginCanvas = useCallback((id: string): void => {
    void saveSettings({ pluginCanvas: settingsRef.current.pluginCanvas.filter((instance) => instance.id !== id) });
  }, [saveSettings]);

  const focusPluginCanvas = useCallback((id: string): void => {
    const instance = settings.pluginCanvas.find((candidate) => candidate.id === id);
    if (!instance) return;
    setActiveSessionId(null);
    setBrowserSelected(false);
    isHomeCamera.current = false;
    setCamera(focusCamera(instance.position, instance.size, PLUGIN_CANVAS_FOCUS_ZOOM));
  }, [settings.pluginCanvas]);

  const openBrowser = useCallback(async (url?: string, requestedCenter?: Point): Promise<void> => {
    const browserApi = window.canvasTTY.browser;
    if (!browserApi) throw new Error(t(settings.locale, "browserRestartRequired"));
    const existingBrowserCanvas = browserCanvasRef.current;
    const homeSize = homeGridPixelSize(settings.homeGridSize);
    const browserCanvas = existingBrowserCanvas ?? {
      position: requestedCenter
        ? centeredWindowPosition(requestedCenter, { width: 920, height: 620 })
        : {
            x: homeSize.width + 160 + ((sessions.length + settings.pluginCanvas.length) % 2) * 760,
            y: Math.floor((sessions.length + settings.pluginCanvas.length) / 2) * 500 + 20
          },
      size: { width: 920, height: 620 }
    };
    const snapshot = await browserApi.open(url);
    setBrowser(snapshot);
    if (!existingBrowserCanvas) {
      browserCanvasRef.current = browserCanvas;
      try {
        await persistSettings({ browserCanvas });
      } catch (error) {
        browserCanvasRef.current = existingBrowserCanvas;
        throw error;
      }
    }
    setSettingsOpen(false);
    setActiveSessionId(null);
    setBrowserSelected(true);
    isHomeCamera.current = false;
    setCamera(focusCamera(browserCanvas.position, browserCanvas.size));
  }, [persistSettings, sessions.length, settings.homeGridSize, settings.locale, settings.pluginCanvas.length]);

  useEffect(() => {
    return window.canvasTTY.plugins.onBrowserOpenRequested((request) => {
      void pluginBrowserOpenQueueRef.current.enqueue(() => openBrowser(request.url)).then(
        () => window.canvasTTY.plugins.completeBrowserOpen({ requestId: request.requestId, ok: true }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : t(settings.locale, "browserActionFailed");
          showToast(message);
          return window.canvasTTY.plugins.completeBrowserOpen({ requestId: request.requestId, ok: false, error: message });
        }
      ).catch(() => undefined);
    });
  }, [openBrowser, settings.locale, showToast]);

  useEffect(() => window.canvasTTY.evenG2.onOpenBrowser(requestId => {
    void openBrowser().then(
      () => window.canvasTTY.evenG2.completeOpenBrowser(requestId, true),
      () => window.canvasTTY.evenG2.completeOpenBrowser(requestId, false)
    );
  }), [openBrowser]);

  const openBrowserFromUi = useCallback((position?: Point): void => {
    void openBrowser(undefined, position).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : t(settings.locale, "browserActionFailed"));
    });
  }, [openBrowser, settings.locale, showToast]);

  const openTerminalUrl = useCallback(async (url: string): Promise<void> => {
    try {
      const safeUrl = normalizeExternalUrl(url);
      if (settings.terminalLinkOpenMode === "canvas") {
        await openBrowser(safeUrl);
      } else if (settings.terminalLinkOpenMode === "external") {
        await window.canvasTTY.external.openUrl(safeUrl);
      } else {
        setPendingTerminalUrl(safeUrl);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : t(settings.locale, "browserActionFailed"));
    }
  }, [openBrowser, settings.locale, settings.terminalLinkOpenMode, showToast]);

  const closeBrowser = useCallback(async (): Promise<void> => {
    try {
      const browserApi = window.canvasTTY.browser;
      if (!browserApi) return;
      await browserApi.close();
      browserCanvasRef.current = null;
      await saveSettings({ browserCanvas: null });
      setBrowserSelected(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t(settings.locale, "browserActionFailed"));
    }
  }, [saveSettings, settings.locale, showToast]);

  const focusBrowser = useCallback((): void => {
    if (!settings.browserCanvas) return;
    setActiveSessionId(null);
    setBrowserSelected(true);
    isHomeCamera.current = false;
    setCamera(focusCamera(settings.browserCanvas.position, settings.browserCanvas.size));
  }, [settings.browserCanvas]);

  const disposeSession = useCallback((id: string, keepEnvironmentData?: boolean): void => {
    void window.canvasTTY.terminal.dispose(id, keepEnvironmentData === undefined ? undefined : { keepEnvironmentData });
    setSessions((current) => current.filter((session) => session.id !== id));
    setActiveSessionId((current) => current === id ? null : current);
    setRenamingSessionId((current) => current === id ? null : current);
  }, []);

  const focusSession = useCallback((session: SessionSnapshot): void => {
    setBrowserSelected(false);
    setActiveSessionId(session.id);
    isHomeCamera.current = false;
    setCamera(focusCamera(session.position, session.size));
  }, []);

  const resumeHistory = useCallback(async (item: AgentChatHistoryItem, center: Point): Promise<SessionSnapshot> => {
    const current = settingsRef.current;
    const pixelSkin = isPixelSkinThemeId(current.terminalBorderSkin) || isPixelSkinPackId(current.terminalBorderSkin);
    const size = pixelSkin ? PIXEL_SKIN_CARD_SIZE : DEFAULT_SESSION_SIZE;
    const position = centeredWindowPosition(center, size);
    const result = await window.canvasTTY.agentChatHistory.resume(item.provider, item.id, position);
    if ("error" in result) throw new Error(result.error.message);
    const { session, reused: alreadyOpen } = result;
    const sized = pixelSkin && !alreadyOpen ? { ...session, size: { ...size } } : session;
    if (pixelSkin && !alreadyOpen) window.canvasTTY.terminal.setBounds(session.id, { position: session.position, size });
    sessionsRef.current = upsertSnapshot(sessionsRef.current, sized);
    setSessions((sessions) => upsertSnapshot(sessions, sized));
    if (!alreadyOpen && session.status === "failed") throw new Error(session.failureDetails || "The conversation could not be resumed. Check the terminal card.");
    return sized;
  }, []);

  const renameSession = useCallback(async (id: string, title: string): Promise<void> => {
    try {
      const metadata = await window.canvasTTY.terminal.rename(id, title);
      setSessions((current) => upsertSession(current, metadata));
    } catch {
      showToast(t(settings.locale, "renameFailed"));
    }
  }, [settings.locale, showToast]);

  const changeCamera = useCallback((nextCamera: CameraState): void => {
    isHomeCamera.current = false;
    setCamera(nextCamera);
  }, []);

  const goHome = useCallback((): void => {
    isHomeCamera.current = true;
    setCamera(homeCamera(homeEditDraft?.homeGridSize ?? settings.homeGridSize));
  }, [homeEditDraft?.homeGridSize, settings.homeGridSize]);

  const changeHomeLayout = useCallback((homeLayout: HomeWidgetPlacement[]): void => {
    setHomeEditDraft((current) => current ? { ...current, homeLayout } : current);
  }, []);

  const changeHomeGridSize = useCallback((homeGridSize: HomeGridSize): void => {
    setHomeEditDraft((current) => current ? { ...current, homeGridSize } : current);
    isHomeCamera.current = true;
    setCamera(homeCamera(homeGridSize));
  }, []);

  const resetHomeLayout = useCallback((): void => {
    const homeGridSize = { ...DEFAULT_HOME_GRID_SIZE };
    setHomeEditDraft((current) => current ? {
      homeGridSize,
      homeLayout: structuredClone(DEFAULT_HOME_LAYOUT)
    } : current);
    isHomeCamera.current = true;
    setCamera(homeCamera(homeGridSize));
  }, []);

  const toggleHomeWidget = useCallback(async (
    widgetId: string,
    defaultSize: PluginGridSize
  ): Promise<void> => {
    const exists = settings.homeLayout.some((placement) => placement.widgetId === widgetId);
    if (exists) {
      if (widgetId === "core.settings") return;
      await saveSettings({
        homeLayout: settings.homeLayout.filter((placement) => placement.widgetId !== widgetId)
      });
      return;
    }

    const result = placeHomeWidget(
      settings.homeLayout,
      widgetId,
      defaultSize,
      settings.homeGridSize
    );
    if (!result) {
      showToast(t(settings.locale, "homeLayoutFull"));
      return;
    }
    await saveSettings({
      homeGridSize: result.gridSize,
      homeLayout: [...settings.homeLayout, result.placement]
    });
  }, [saveSettings, settings.homeGridSize, settings.homeLayout, settings.locale, showToast]);

  const previewPlugin = useCallback((sourceUrl: string): Promise<PluginInstallPreview> => (
    window.canvasTTY.plugins.previewInstall(sourceUrl)
  ), []);

  const installPlugin = useCallback(async (token: string, selectedModules: string[]): Promise<void> => {
    const installed = await window.canvasTTY.plugins.install(token, selectedModules);
    setPlugins((current) => [...current.filter((plugin) => plugin.manifest.id !== installed.manifest.id), installed]);

    let homeLayout = settings.homeLayout;
    let homeGridSize = settings.homeGridSize;
    for (const contribution of installed.manifest.contributions) {
      if (contribution.kind !== "home-widget") continue;
      const widgetId = `plugin:${installed.manifest.id}:${contribution.id}`;
      const result = placeHomeWidget(homeLayout, widgetId, contribution.defaultSize, homeGridSize);
      if (!result) continue;
      homeGridSize = result.gridSize;
      homeLayout = [...homeLayout, result.placement];
    }
    if (homeLayout !== settings.homeLayout) await saveSettings({ homeGridSize, homeLayout });
    showToast(`${t(settings.locale, "pluginInstalled")}: ${installed.manifest.name}`);
  }, [saveSettings, settings.homeGridSize, settings.homeLayout, settings.locale, showToast]);

  const refreshPlugins = useCallback(async (): Promise<void> => {
    setPlugins(await window.canvasTTY.plugins.list());
  }, []);

  const setPluginEnabled = useCallback(async (pluginId: string, enabled: boolean): Promise<void> => {
    try {
      const updated = await window.canvasTTY.plugins.setEnabled(pluginId, enabled);
      setPlugins((current) => current.map((plugin) => plugin.manifest.id === pluginId ? updated : plugin));
    } catch (error) {
      await refreshPlugins().catch(() => undefined);
      throw error;
    }
  }, [refreshPlugins]);

  const setPluginHookEnabled = useCallback(async (
    pluginId: string,
    hookId: string,
    enabled: boolean
  ): Promise<void> => {
    try {
      const updated = await window.canvasTTY.plugins.setHookEnabled(pluginId, hookId, enabled);
      setPlugins((current) => current.map((plugin) => plugin.manifest.id === pluginId ? updated : plugin));
    } catch (error) {
      await refreshPlugins().catch(() => undefined);
      throw error;
    }
  }, [refreshPlugins]);

  const setPluginNativeCodeTrusted = useCallback(async (pluginId: string, trusted: boolean): Promise<void> => {
    try {
      const updated = await window.canvasTTY.plugins.setNativeCodeTrusted(pluginId, trusted);
      setPlugins((current) => current.map((plugin) => plugin.manifest.id === pluginId ? updated : plugin));
    } catch (error) {
      await refreshPlugins().catch(() => undefined);
      throw error;
    }
  }, [refreshPlugins]);

  const setPluginDecisionsMayAllow = useCallback(async (pluginId: string, allowed: boolean): Promise<void> => {
    try {
      const updated = await window.canvasTTY.plugins.setDecisionsMayAllow(pluginId, allowed);
      setPlugins((current) => current.map((plugin) => plugin.manifest.id === pluginId ? updated : plugin));
    } catch (error) {
      await refreshPlugins().catch(() => undefined);
      throw error;
    }
  }, [refreshPlugins]);

  const setPluginModules = useCallback(async (pluginId: string, selectedModules: string[]): Promise<void> => {
    let updated: InstalledPlugin;
    try {
      updated = await window.canvasTTY.plugins.setModules(pluginId, selectedModules);
    } catch (error) {
      await refreshPlugins().catch(() => undefined);
      throw error;
    }
    setPlugins((current) => current.map((plugin) => plugin.manifest.id === pluginId ? updated : plugin));
    const contributions = new Set(updated.manifest.contributions.map((contribution) => contribution.id));
    await saveSettings({
      homeLayout: settings.homeLayout.filter((placement) => {
        const prefix = `plugin:${pluginId}:`;
        return !placement.widgetId.startsWith(prefix) || contributions.has(placement.widgetId.slice(prefix.length));
      }),
      pluginCanvas: settings.pluginCanvas.filter((instance) => (
        instance.pluginId !== pluginId || contributions.has(instance.contributionId)
      ))
    });
  }, [refreshPlugins, saveSettings, settings.homeLayout, settings.pluginCanvas]);

  const uninstallPlugin = useCallback(async (pluginId: string): Promise<void> => {
    try {
      await window.canvasTTY.plugins.uninstall(pluginId);
    } catch (error) {
      await refreshPlugins().catch(() => undefined);
      throw error;
    }
    setPlugins((current) => current.filter((plugin) => plugin.manifest.id !== pluginId));
    await saveSettings({
      homeLayout: settings.homeLayout.filter((placement) => !placement.widgetId.startsWith(`plugin:${pluginId}:`)),
      pluginCanvas: settings.pluginCanvas.filter((instance) => instance.pluginId !== pluginId)
    });
    showToast(t(settings.locale, "pluginRemoved"));
  }, [refreshPlugins, saveSettings, settings.homeLayout, settings.locale, settings.pluginCanvas, showToast]);

  const searchPlugins = useCallback((query: string): Promise<GithubPluginSearchResult[]> => (
    window.canvasTTY.plugins.search(query)
  ), []);

  const showcasePlugins = useCallback((): Promise<GithubPluginSearchResult[]> => (
    window.canvasTTY.plugins.showcase()
  ), []);

  const fetchPluginIcons = useCallback((sourceUrls: string[]): Promise<Record<string, string | null>> => (
    window.canvasTTY.plugins.icon(sourceUrls)
  ), []);

  const previewManifests = useCallback((sourceUrls: string[]): Promise<Record<string, PluginManifest>> => (
    window.canvasTTY.plugins.manifests(sourceUrls)
  ), []);

  const checkPluginUpdates = useCallback((): Promise<PluginUpdateStatus[]> => (
    window.canvasTTY.plugins.checkUpdates()
  ), []);

  const updatePlugin = useCallback(async (pluginId: string): Promise<void> => {
    let updated: InstalledPlugin;
    try {
      updated = await window.canvasTTY.plugins.update(pluginId);
    } catch (error) {
      await refreshPlugins().catch(() => undefined);
      throw error;
    }
    setPlugins((current) => current.map((plugin) => plugin.manifest.id === pluginId ? updated : plugin));
    showToast(`${t(settings.locale, "pluginUpdated")}: ${updated.manifest.name}`);
  }, [refreshPlugins, settings.locale, showToast]);

  const openPluginCanvasContribution = useCallback(async (
    plugin: InstalledPlugin,
    contribution: Extract<PluginContribution, { kind: "canvas-app" }>,
    sourceCanvasInstanceId?: string
  ): Promise<void> => {
    const existing = settings.pluginCanvas.find((instance) => (
      instance.pluginId === plugin.manifest.id && instance.contributionId === contribution.id
    ));
    if (existing) {
      setSettingsOpen(false);
      isHomeCamera.current = false;
      setCamera(focusCamera(existing.position, existing.size, PLUGIN_CANVAS_FOCUS_ZOOM));
      return;
    }
    const index = settings.pluginCanvas.length;
    const homeSize = homeGridPixelSize(settings.homeGridSize);
    const source = sourceCanvasInstanceId
      ? settings.pluginCanvas.find((instance) => instance.id === sourceCanvasInstanceId)
      : null;
    const instance = {
      id: crypto.randomUUID(),
      pluginId: plugin.manifest.id,
      contributionId: contribution.id,
      title: contribution.title,
      position: source ? {
        x: source.position.x + source.size.width + 40,
        y: source.position.y
      } : {
        x: homeSize.width + 160 + (index % 2) * 760,
        y: Math.floor(index / 2) * 500 + 20
      },
      size: contribution.defaultSize
    };
    await saveSettings({ pluginCanvas: [...settings.pluginCanvas, instance] });
    setSettingsOpen(false);
    isHomeCamera.current = false;
    setCamera(focusCamera(instance.position, instance.size, PLUGIN_CANVAS_FOCUS_ZOOM));
  }, [saveSettings, settings.homeGridSize, settings.pluginCanvas]);

  const openPluginContribution = useCallback(async (
    plugin: InstalledPlugin,
    contribution: PluginContribution
  ): Promise<void> => {
    if (contribution.kind === "window") {
      await window.canvasTTY.plugins.openWindow(plugin.manifest.id, contribution.id);
      return;
    }
    if (contribution.kind === "home-widget") {
      await toggleHomeWidget(`plugin:${plugin.manifest.id}:${contribution.id}`, contribution.defaultSize);
      return;
    }
    await openPluginCanvasContribution(plugin, contribution);
  }, [openPluginCanvasContribution, toggleHomeWidget]);

  useEffect(() => window.canvasTTY.plugins.onOpenCanvas((request) => {
    const plugin = plugins.find((candidate) => candidate.manifest.id === request.pluginId);
    const contribution = plugin?.manifest.contributions.find((candidate) => candidate.id === request.contributionId);
    if (!plugin || !contribution || contribution.kind !== "canvas-app" || !plugin.enabled) {
      showToast(t(settings.locale, "pluginActionFailed"));
      return;
    }
    void openPluginCanvasContribution(plugin, contribution, request.sourceCanvasInstanceId)
      .catch((error) => showToast(error instanceof Error ? error.message : t(settings.locale, "pluginActionFailed")));
  }), [openPluginCanvasContribution, plugins, settings.locale, showToast]);

  const startHomeEditor = useCallback((): void => {
    setSettingsOpen(false);
    setHomeEditDraft({
      homeGridSize: { ...settings.homeGridSize },
      homeLayout: structuredClone(settings.homeLayout)
    });
    isHomeCamera.current = true;
    setCamera(homeCamera(settings.homeGridSize));
  }, [settings.homeGridSize, settings.homeLayout]);

  const finishHomeEditor = useCallback(async (): Promise<void> => {
    if (!homeEditDraft || !homeLayoutFitsGrid(homeEditDraft.homeLayout, homeEditDraft.homeGridSize)) return;
    try {
      const updated = await window.canvasTTY.settings.update(homeEditDraft);
      setSettings(updated);
      setHomeEditDraft(null);
    } catch {
      showToast(t(settings.locale, "settingsFailed"));
    }
  }, [homeEditDraft, settings.locale, showToast]);

  useEffect(() => {
    const performShortcut = (shortcut: "home" | "renameWindow" | "toggleFullscreen"): void => {
      if (shortcut === "toggleFullscreen") {
        if (settingsOpen || launchProvider !== null || pendingTerminalUrl !== null || homeEditDraft) return;
        const id = fullscreenSessionId ?? activeSessionId;
        if (id) toggleSessionFullscreen(id);
        return;
      }
      if (shortcut === "home") {
        goHome();
        return;
      }
      if (!activeSessionId) {
        showToast(t(settings.locale, "selectWindowToRename"));
        return;
      }
      setRenamingSessionId(activeSessionId);
    };
    const handleShortcut = (event: KeyboardEvent): void => {
      if (shortcutReferenceOpen) return;
      if (handleMacNativeSelectAll(event, window.canvasTTY.window.isMacOS)) return;
      if (shouldKeepNativeKeyboardInput(event.target, window.canvasTTY.window.isMacOS, event)) return;
      if (event.repeat || isShortcutCaptureTarget(event.target) || isRenameInputTarget(event.target)) return;
      if (matchesShortcut(event, settings.shortcuts.toggleFullscreen)) {
        event.preventDefault();
        event.stopPropagation();
        performShortcut("toggleFullscreen");
        return;
      }
      if (matchesShortcut(event, settings.shortcuts.home)) {
        event.preventDefault();
        event.stopPropagation();
        performShortcut("home");
        return;
      }
      if (matchesShortcut(event, settings.shortcuts.renameWindow)) {
        event.preventDefault();
        event.stopPropagation();
        performShortcut("renameWindow");
      }
    };

    const handlePointerShortcut = (event: PointerEvent): void => {
      if (shortcutReferenceOpen) return;
      if (isShortcutCaptureTarget(event.target) || isRenameInputTarget(event.target)) return;
      const action = matchesPointerShortcut(event, settings.shortcuts.home)
        ? "home"
        : matchesPointerShortcut(event, settings.shortcuts.renameWindow)
          ? "renameWindow"
          : matchesPointerShortcut(event, settings.shortcuts.toggleFullscreen)
            ? "toggleFullscreen"
            : null;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      performShortcut(action);
    };

    window.addEventListener("keydown", handleShortcut, true);
    window.addEventListener("pointerdown", handlePointerShortcut, true);
    return () => {
      window.removeEventListener("keydown", handleShortcut, true);
      window.removeEventListener("pointerdown", handlePointerShortcut, true);
    };
  }, [activeSessionId, fullscreenSessionId, goHome, homeEditDraft, launchProvider, pendingTerminalUrl, settings.locale, settings.shortcuts, settingsOpen, shortcutReferenceOpen, showToast, toggleSessionFullscreen]);

  const appearance = resolveAppearanceSettings(settings);
  const rootClasses = useMemo(
    () => [
      "app",
      `app--${settings.palette}`,
      `app--home-${appearance.homeAccentPreset}`,
      `app--canvas-${appearance.canvasColor}`,
      windowState.isMacOS ? "app--macos" : "",
      windowState.isMacOS && windowState.fullscreen ? "app--macos-fullscreen" : ""
    ].filter(Boolean).join(" "),
    [appearance.canvasColor, appearance.homeAccentPreset, settings.palette, windowState.fullscreen, windowState.isMacOS]
  );
  const rootStyle = useMemo(
    () => ({
      ...(appearance.homeAccentPreset === "custom" ? customHomeAccentStyle(appearance.homeAccentColors) : {}),
      "--ui-scale": settings.uiScale
    }) as React.CSSProperties,
    [appearance.homeAccentColors, appearance.homeAccentPreset, settings.uiScale]
  );
  const workspaceSettings = useMemo(() => {
    const available = new Set(AGENT_PROVIDERS.filter((provider) => agentAvailability?.[provider]));
    return {
      ...settings,
      ...(homeEditDraft ? { homeGridSize: homeEditDraft.homeGridSize, homeLayout: homeEditDraft.homeLayout } : {}),
      homeLauncherProviders: settings.homeLauncherProviders.filter((provider) => available.has(provider)),
      homeLimitProviders: settings.homeLimitProviders.filter((provider) => available.has(provider)),
      canvasLauncherItems: settings.canvasLauncherItems.filter((provider) => provider === "terminal" || available.has(provider)),
      radialLauncherItems: settings.radialLauncherItems.filter((provider) => (
        provider === "terminal" || provider === "note" || provider === "browser" || provider === "settings" || available.has(provider)
      ))
    };
  }, [agentAvailability, homeEditDraft, settings]);

  return (
    <div className={rootClasses} style={rootStyle} data-app-skin={settings.appSkin}>
      <TerminalBorderSkinStyleHost skinId={settings.terminalBorderSkin} />
      <TitleBar locale={settings.locale} windowState={windowState} onWindowStateChange={setWindowState} />
      <main className="app__content">
        {!ready && <div className="loading-screen"><span>{t(settings.locale, "loading")}</span></div>}
        {ready && <WorkspaceCanvas
          surfacesMounted={surfacesMounted}
          settings={workspaceSettings}
          mediaData={mediaData}
          sessions={sessions}
          limits={limits}
          limitsLoadState={limitsLoadState}
          plugins={plugins}
          browser={browser}
          browserViewVisible={!settingsOpen && !shortcutReferenceOpen && launchProvider === null && pendingTerminalUrl === null}
          homeEditing={homeEditDraft !== null}
          camera={cameraStore}
          onCameraChange={changeCamera}
          onGoHome={goHome}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenShortcutReference={() => setShortcutReferenceOpen(true)}
          onOpenAgent={openAgent}
          onOpenTerminal={(position) => void openTerminal(position)}
          onOpenBrowser={openBrowserFromUi}
          onOpenTerminalUrl={(url) => void openTerminalUrl(url)}
          onRequestMedia={requestMedia}
          onRemoveMedia={removeMedia}
          onHomeLayoutChange={changeHomeLayout}
          onHomeGridSizeChange={changeHomeGridSize}
          onFinishHomeEdit={() => void finishHomeEditor()}
          onResetHomeLayout={resetHomeLayout}
          onPluginError={showToast}
          onPluginCanvasBoundsChange={changePluginCanvasBounds}
          onDisposePluginCanvas={disposePluginCanvas}
          onFocusPluginCanvas={focusPluginCanvas}
          onFocusSession={focusSession}
          onResumeHistory={resumeHistory}
          activeSessionId={activeSessionId}
          browserSelected={browserSelected}
          renamingSessionId={renamingSessionId}
          fullscreenSessionId={fullscreenSessionId}
          onToggleFullscreen={toggleSessionFullscreen}
          onSelectSession={(id) => {
            setBrowserSelected(false);
            setActiveSessionId(id);
          }}
          onSelectBrowser={() => {
            setActiveSessionId(null);
            setBrowserSelected(true);
          }}
          onClearCanvasSelection={() => {
            setActiveSessionId(null);
            setBrowserSelected(false);
          }}
          onRenameSession={renameSession}
          onRenameEnd={() => setRenamingSessionId(null)}
          onSessionBoundsChange={changeSessionBounds}
          onRestartSession={restartSession}
          onDisposeSession={disposeSession}
          onBrowserBoundsChange={changeBrowserBounds}
          onFocusBrowser={focusBrowser}
          onCloseBrowser={() => void closeBrowser()}
          onCreateCanvasRegion={createCanvasRegion}
          onChangeCanvasRegion={changeCanvasRegion}
          onCanvasRegionBoundsChange={changeCanvasRegionBounds}
          onDeleteCanvasRegion={deleteCanvasRegion}
          onCreateStickyNote={createStickyNote}
          onStickyNoteBoundsChange={changeStickyNoteBounds}
          onStickyNoteTextChange={changeStickyNoteText}
          onDeleteStickyNote={deleteStickyNote}
          fileCardState={fileCardRuntime}
          fileSessionOptions={fileSessionOptions}
          onOpenFiles={openFilesCard}
          onFocusFileCard={focusFileCard}
          onFileCardBoundsChange={changeFileCardBounds}
          onCloseFileCard={closeFileCard}
          onChooseFileFolder={chooseFileFolder}
          onRegisterFileSession={registerFileSession}
          onOpenFileDirectory={openFileDirectory}
          onOpenFile={openFile}
          onFileQuickOpen={quickOpenFiles}
          onOpenLink={(href) => {
            void openBrowser(href).catch((error: unknown) => {
              showToast(error instanceof Error ? error.message : t(settings.locale, "browserActionFailed"));
            });
          }}
        />}
      </main>

      <Suspense fallback={null}>
        {shortcutReferenceOpen && <ShortcutReference settings={settings}
          onClose={() => setShortcutReferenceOpen(false)} />}
        <AgentLaunchDialog
          provider={launchProvider}
          settings={settings}
          onClose={() => {
            setLaunchProvider(null);
            setLaunchPosition(null);
          }}
          onAcknowledge={acknowledgeDanger}
          onEnableAgentControl={() => persistSettings({ agentControlEnabled: true })}
          onLaunch={launchAgent}
        />
        <TerminalLinkDialog
          locale={settings.locale}
          url={pendingTerminalUrl}
          onClose={() => setPendingTerminalUrl(null)}
          onOpenCanvas={(url) => {
            setPendingTerminalUrl(null);
            void openBrowser(url).catch((error: unknown) => {
              showToast(error instanceof Error ? error.message : t(settings.locale, "browserActionFailed"));
            });
          }}
          onOpenExternal={(url) => {
            setPendingTerminalUrl(null);
            void window.canvasTTY.external.openUrl(url).catch((error: unknown) => {
              showToast(error instanceof Error ? error.message : t(settings.locale, "browserActionFailed"));
            });
          }}
        />
        <SettingsPanel
          open={settingsOpen}
          openUpdatesRequest={openUpdatesRequest}
          settings={settings}
          agentAvailability={agentAvailability}
          onRecheckAgentClis={recheckAgentClis}
          plugins={plugins}
          browser={browser}
          onClose={() => setSettingsOpen(false)}
          onChange={saveSettings}
          onPreviewPlugin={previewPlugin}
          onInstallPlugin={installPlugin}
          onSearchPlugins={searchPlugins}
          onShowcasePlugins={showcasePlugins}
          onFetchPluginIcons={fetchPluginIcons}
          onPreviewManifests={previewManifests}
          onCheckPluginUpdates={checkPluginUpdates}
          onUpdatePlugin={updatePlugin}
          onSetPluginModules={setPluginModules}
          onSetPluginEnabled={setPluginEnabled}
          onSetPluginHookEnabled={setPluginHookEnabled}
          onSetPluginNativeCodeTrusted={setPluginNativeCodeTrusted}
          onSetPluginDecisionsMayAllow={setPluginDecisionsMayAllow}
          onUninstallPlugin={uninstallPlugin}
          onOpenPluginContribution={openPluginContribution}
          onToggleHomeWidget={toggleHomeWidget}
          onEditHome={startHomeEditor}
          onOpenBrowser={openBrowser}
        />
      </Suspense>
      {closedGitRisks.length > 0 && (
        <div className="git-risk-panel">
          {closedGitRisks.map((report) => (
            <GitRiskNotice key={report.id} report={report} locale={settings.locale} closedTitle={report.title ?? report.cwd}
              onResolved={() => setClosedGitRisks((current) => current.filter((entry) => entry.id !== report.id))} />
          ))}
        </div>
      )}
      <UpdateNotice
        status={settingsOpen ? null : updateNoticeForStatus(updateStatus, dismissedUpdateNotice)}
        locale={settings.locale}
        pending={updateNoticePending}
        onOpen={() => {
          if (updateStatus.type === "available" || updateStatus.type === "ready") setDismissedUpdateNotice(updateNoticeKey(updateStatus));
          openUpdates();
        }}
        onAction={runUpdateNoticeAction}
        onDismiss={() => {
          if (updateStatus.type === "available" || updateStatus.type === "ready") setDismissedUpdateNotice(updateNoticeKey(updateStatus));
        }}
      />
      <Toast message={toast} />
    </div>
  );
}

function fileErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function centeredWindowPosition(point: Point, size: { width: number; height: number }): Point {
  return {
    x: point.x - size.width / 2,
    y: point.y - size.height / 2
  };
}

function homeCamera(homeGridSize: HomeGridSize): CameraState {
  const { width: viewportWidth, height: viewportHeight } = canvasViewportSize();
  const homeSize = homeGridPixelSize(homeGridSize);
  const availableZoom = Math.min(
    1,
    (viewportWidth - 80) / homeSize.width,
    (viewportHeight - 72) / homeSize.height
  );
  const zoom = [1, 0.9, 0.8, 0.75, 2 / 3, 0.5, 0.4, 1 / 3, 0.28, 0.25, 0.2]
    .find((step) => step <= availableZoom) ?? 0.2;
  return {
    zoom,
    x: Math.round((viewportWidth - homeSize.width * zoom) / 2),
    y: Math.round((viewportHeight - homeSize.height * zoom) / 2)
  };
}

function focusCamera(
  position: Point,
  size: { width: number; height: number },
  zoom = DEFAULT_FOCUS_ZOOM
): CameraState {
  const { width: viewportWidth, height: viewportHeight } = canvasViewportSize();
  return {
    zoom,
    x: viewportWidth / 2 - (position.x + size.width / 2) * zoom,
    y: viewportHeight / 2 - (position.y + size.height / 2) * zoom
  };
}

function canvasViewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1360, height: 820 };
  const content = document.querySelector<HTMLElement>(".app__content");
  return {
    width: content?.clientWidth || window.innerWidth,
    height: content?.clientHeight || window.innerHeight
  };
}
