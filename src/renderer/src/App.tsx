import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProviderId,
  AppSettings,
  BrowserCanvasState,
  BrowserSnapshot,
  CameraState,
  CanvasRegion,
  GithubPluginSearchResult,
  HomeAccentColors,
  HomeGridSize,
  HomeWidgetPlacement,
  InstalledPlugin,
  LaunchProfileId,
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
  WindowState
} from "../../shared/contracts";
import {
  DEFAULT_HOME_ACCENT_COLORS,
  DEFAULT_HOME_GRID_SIZE,
  DEFAULT_HOME_LAYOUT,
  DEFAULT_CANVAS_LAUNCHER_ITEMS,
  DEFAULT_RADIAL_LAUNCHER_ITEMS,
  DEFAULT_UI_SCALE,
  DEFAULT_SHORTCUTS
} from "../../shared/contracts";
import { normalizeExternalUrl } from "../../shared/externalUrl";
import { TitleBar } from "./components/TitleBar";
import { Toast } from "./components/Toast";
import { AgentLaunchDialog } from "./features/launcher/AgentLaunchDialog";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { resolveAppearanceSettings } from "./features/settings/appearanceSettings";
import { persistSettingsUpdate } from "./features/settings/persistSettings";
import { PluginBrowserOpenQueue } from "./features/plugins/PluginBrowserOpenQueue";
import { TerminalLinkDialog } from "./features/terminal/TerminalLinkDialog";
import { WorkspaceCanvas } from "./features/workspace/WorkspaceCanvas";
import type { LimitsLoadState } from "./features/home/homeModel";
import { t } from "./lib/i18n";
import {
  mergeSessionSnapshots,
  upsertSession,
  upsertSnapshot
} from "./lib/sessionReconciliation";
import {
  isRenameInputTarget,
  isShortcutCaptureTarget,
  matchesPointerShortcut,
  matchesShortcut
} from "./lib/shortcuts";
import { homeGridPixelSize, homeLayoutFitsGrid, placeHomeWidget } from "./features/home/homeLayout";
import { boundsInsideRegion, translateBounds } from "./features/workspace/canvasRegions";

interface HomeEditDraft {
  homeGridSize: HomeGridSize;
  homeLayout: HomeWidgetPlacement[];
}

const FALLBACK_SETTINGS: AppSettings = {
  locale: "ru",
  restoreTerminalSessions: false,
  persistCanvasRegions: true,
  persistStickyNotes: true,
  palette: "sage",
  homeAccentPreset: "classic",
  homeAccentColors: { ...DEFAULT_HOME_ACCENT_COLORS },
  sessionRowColorMode: "status",
  homeLauncherProviders: ["codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok"],
  homeLimitProviders: ["codex", "claude", "qwen", "kimi", "opencode", "grok"],
  canvasLauncherItems: [...DEFAULT_CANVAS_LAUNCHER_ITEMS],
  radialLauncherItems: [...DEFAULT_RADIAL_LAUNCHER_ITEMS],
  agentLifecycleHooksEnabled: true,
  uiScale: DEFAULT_UI_SCALE,
  canvasColor: "sage",
  pattern: "dots",
  snapToGrid: true,
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
  shortcuts: { ...DEFAULT_SHORTCUTS },
  mediaPath: null,
  mediaFit: "cover",
  lastDirectory: "/",
  acknowledgedDangerousProfiles: [],
  homeGridSize: { ...DEFAULT_HOME_GRID_SIZE },
  homeLayout: structuredClone(DEFAULT_HOME_LAYOUT),
  canvasRegions: [],
  stickyNotes: [],
  pluginCanvas: [],
  browserCanvas: null,
  browserAgentAccess: true,
  browserShowAgentPresence: true,
  browserRestoreTabs: true
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
  const [limits, setLimits] = useState<LimitsSnapshot | null>(null);
  const [limitsLoadState, setLimitsLoadState] = useState<LimitsLoadState>("loading");
  const [mediaData, setMediaData] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [browser, setBrowser] = useState<BrowserSnapshot>(EMPTY_BROWSER_SNAPSHOT);
  const [camera, setCamera] = useState<CameraState>(() => homeCamera(DEFAULT_HOME_GRID_SIZE));
  const isHomeCamera = useRef(true);
  const browserCanvasRef = useRef<BrowserCanvasState | null>(null);
  const pluginBrowserOpenQueueRef = useRef(new PluginBrowserOpenQueue());
  const [launchProvider, setLaunchProvider] = useState<AgentProviderId | null>(null);
  const [launchPosition, setLaunchPosition] = useState<Point | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [homeEditDraft, setHomeEditDraft] = useState<HomeEditDraft | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [browserSelected, setBrowserSelected] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [pendingTerminalUrl, setPendingTerminalUrl] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [windowState, setWindowState] = useState<WindowState>({
    isMacOS: window.canvasTTY.window.isMacOS,
    maximized: false,
    fullscreen: false
  });

  const showToast = useCallback((message: string): void => setToast(message), []);

  useEffect(() => {
    browserCanvasRef.current = settings.browserCanvas;
  }, [settings.browserCanvas]);

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
    const browserApi = window.canvasTTY.browser;
    const unsubscribeSession = window.canvasTTY.terminal.onSession(({ session }) => {
      if (active) setSessions((current) => upsertSession(current, session));
    });
    const unsubscribeRemoved = window.canvasTTY.terminal.onRemoved(({ id }) => {
      if (!active) return;
      setSessions((current) => current.filter((session) => session.id !== id));
      setActiveSessionId((current) => current === id ? null : current);
      setRenamingSessionId((current) => current === id ? null : current);
    });

    const settingsRequest = window.canvasTTY.settings.get();
    const sessionsRequest = window.canvasTTY.terminal.list().then((loadedSessions) => {
      if (active) setSessions((current) => mergeSessionSnapshots(current, loadedSessions));
      return loadedSessions;
    });
    const pluginsRequest = window.canvasTTY.plugins.list();

    void Promise.all([settingsRequest, sessionsRequest, pluginsRequest])
      .then(async ([loadedSettings, _loadedSessions, loadedPlugins]) => {
        if (!active) return;
        setSettings(loadedSettings);
        setPlugins(loadedPlugins);
        if (loadedSettings.browserCanvas && browserApi) {
          const browserState = await browserApi.open();
          if (active) setBrowser(browserState);
        }
        if (isHomeCamera.current) setCamera(homeCamera(loadedSettings.homeGridSize));
        if (loadedSettings.mediaPath) {
          const data = await window.canvasTTY.media.read(loadedSettings.mediaPath);
          if (active) setMediaData(data);
        }
      })
      .catch((error) => showToast(error instanceof Error ? error.message : "CanvasTTY initialization failed"))
      .finally(() => active && setReady(true));

    return () => {
      active = false;
      unsubscribeSession();
      unsubscribeRemoved();
    };
  }, [showToast]);

  useEffect(() => {
    const browserApi = window.canvasTTY.browser;
    if (!browserApi) return;
    const unsubscribe = browserApi.onState(({ snapshot }) => setBrowser(snapshot));
    void browserApi.getState().then(setBrowser).catch(() => undefined);
    return unsubscribe;
  }, []);

  useEffect(() => {
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
      await refreshLimits();
      if (active) timer = window.setTimeout(() => void refreshAndSchedule(), 60_000);
    };

    void refreshAndSchedule();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

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

  const createSession = useCallback(async (
    provider: ProviderId,
    profile: LaunchProfileId,
    cwd: string,
    requestedCenter?: Point
  ): Promise<SessionSnapshot> => {
    const position = requestedCenter
      ? centeredWindowPosition(requestedCenter, { width: 700, height: 430 })
      : nextSessionPosition(sessions.length, settings.homeGridSize);
    const session = await window.canvasTTY.terminal.create({ provider, profile, cwd, position });
    setSessions((current) => upsertSnapshot(current, session));
    setActiveSessionId(session.id);
    await saveSettings({ lastDirectory: cwd });
    isHomeCamera.current = false;
    setCamera(focusCamera(position, session.size));
    return session;
  }, [sessions.length, saveSettings, settings.homeGridSize]);

  const openTerminal = useCallback(async (position?: Point): Promise<void> => {
    try {
      await createSession("terminal", "normal", settings.lastDirectory, position);
      showToast(t(settings.locale, "terminalStarted"));
    } catch (error) {
      showToast(error instanceof Error ? error.message : t(settings.locale, "launchFailed"));
    }
  }, [createSession, settings.lastDirectory, settings.locale, showToast]);

  const openAgent = useCallback((provider: AgentProviderId, position?: Point): void => {
    setLaunchPosition(position ?? null);
    setLaunchProvider(provider);
  }, []);

  useEffect(() => window.canvasTTY.plugins.onOpenLauncher(({ provider }) => {
    if (provider === "terminal") void openTerminal();
    else openAgent(provider);
  }), [openAgent, openTerminal]);


  const launchAgent = useCallback(async (
    provider: AgentProviderId,
    profile: LaunchProfileId,
    cwd: string
  ): Promise<void> => {
    await createSession(provider, profile, cwd, launchPosition ?? undefined);
    setLaunchPosition(null);
    showToast(`${t(settings.locale, "sessionStarted")}: ${provider}`);
  }, [createSession, launchPosition, settings.locale, showToast]);

  const restartSession = useCallback(async (id: string): Promise<void> => {
    try {
      await window.canvasTTY.terminal.restart(id);
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

      const updated = await window.canvasTTY.settings.update({ mediaPath: selection.path });
      setSettings(updated);
      setMediaData(selection.dataUrl);
    } catch {
      showToast(t(settings.locale, "mediaFailed"));
    }
  }, [settings.locale, showToast]);

  const removeMedia = useCallback(async (): Promise<void> => {
    try {
      const updated = await window.canvasTTY.settings.update({ mediaPath: null });
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

  const changePluginCanvasBounds = useCallback((id: string, bounds: SessionBounds): void => {
    const pluginCanvas = settings.pluginCanvas.map((instance) => instance.id === id
      ? { ...instance, position: bounds.position, size: bounds.size }
      : instance);
    setSettings((current) => ({ ...current, pluginCanvas }));
    void saveSettings({ pluginCanvas });
  }, [saveSettings, settings.pluginCanvas]);

  const changeBrowserBounds = useCallback((browserCanvas: BrowserCanvasState): void => {
    browserCanvasRef.current = browserCanvas;
    setSettings((current) => ({ ...current, browserCanvas }));
    void saveSettings({ browserCanvas });
  }, [saveSettings]);

  const createCanvasRegion = useCallback((region: CanvasRegion): void => {
    const canvasRegions = [...settings.canvasRegions, region];
    setSettings((current) => ({ ...current, canvasRegions }));
    void saveSettings({ canvasRegions });
  }, [saveSettings, settings.canvasRegions]);

  const changeCanvasRegion = useCallback((region: CanvasRegion): void => {
    const canvasRegions = settings.canvasRegions.map((candidate) => candidate.id === region.id ? region : candidate);
    setSettings((current) => ({ ...current, canvasRegions }));
    void saveSettings({ canvasRegions });
  }, [saveSettings, settings.canvasRegions]);

  const createStickyNote = useCallback((note: StickyNote): void => {
    const stickyNotes = [...settings.stickyNotes, note];
    setSettings((current) => ({ ...current, stickyNotes }));
    void saveSettings({ stickyNotes });
  }, [saveSettings, settings.stickyNotes]);

  const changeStickyNoteBounds = useCallback((id: string, bounds: SessionBounds): void => {
    const stickyNotes = settings.stickyNotes.map((note) => note.id === id
      ? { ...note, position: bounds.position, size: bounds.size }
      : note);
    setSettings((current) => ({ ...current, stickyNotes }));
    void saveSettings({ stickyNotes });
  }, [saveSettings, settings.stickyNotes]);

  const changeStickyNoteText = useCallback((id: string, text: string): void => {
    const stickyNotes = settings.stickyNotes.map((note) => note.id === id ? { ...note, text } : note);
    setSettings((current) => ({ ...current, stickyNotes }));
    void saveSettings({ stickyNotes });
  }, [saveSettings, settings.stickyNotes]);

  const deleteStickyNote = useCallback((id: string): void => {
    const stickyNotes = settings.stickyNotes.filter((note) => note.id !== id);
    setSettings((current) => ({ ...current, stickyNotes }));
    void saveSettings({ stickyNotes });
  }, [saveSettings, settings.stickyNotes]);

  const changeCanvasRegionBounds = useCallback((
    id: string,
    bounds: SessionBounds,
    interaction: "move" | "resize"
  ): void => {
    const previous = settings.canvasRegions.find((region) => region.id === id);
    if (!previous) return;
    const canvasRegions = settings.canvasRegions.map((region) => region.id === id
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
        const pluginCanvas = settings.pluginCanvas.map((instance) => {
          if (!boundsInsideRegion(instance, previous)) return instance;
          const moved = translateBounds(instance, delta);
          return { ...instance, ...moved };
        });
        const browserCanvas = settings.browserCanvas && boundsInsideRegion(settings.browserCanvas, previous)
          ? translateBounds(settings.browserCanvas, delta)
          : settings.browserCanvas;
        const stickyNotes = settings.stickyNotes.map((note) => boundsInsideRegion(note, previous)
          ? { ...note, ...translateBounds(note, delta) }
          : note);
        setSessions(movedSessions);
        patch.pluginCanvas = pluginCanvas;
        patch.browserCanvas = browserCanvas;
        patch.stickyNotes = stickyNotes;
        browserCanvasRef.current = browserCanvas;
      }
    }

    setSettings((current) => ({ ...current, ...patch }));
    void saveSettings(patch);
  }, [saveSettings, sessions, settings.browserCanvas, settings.canvasRegions, settings.pluginCanvas, settings.stickyNotes]);

  const deleteCanvasRegion = useCallback((id: string): void => {
    const canvasRegions = settings.canvasRegions.filter((region) => region.id !== id);
    setSettings((current) => ({ ...current, canvasRegions }));
    void saveSettings({ canvasRegions });
  }, [saveSettings, settings.canvasRegions]);

  const disposePluginCanvas = useCallback((id: string): void => {
    void saveSettings({ pluginCanvas: settings.pluginCanvas.filter((instance) => instance.id !== id) });
  }, [saveSettings, settings.pluginCanvas]);

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

  const openBrowserFromUi = useCallback((position?: Point): void => {
    void openBrowser(undefined, position).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : t(settings.locale, "browserActionFailed"));
    });
  }, [openBrowser, settings.locale, showToast]);

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

  const disposeSession = useCallback((id: string): void => {
    void window.canvasTTY.terminal.dispose(id);
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
    const performShortcut = (shortcut: "home" | "renameWindow"): void => {
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
      if (event.repeat || isShortcutCaptureTarget(event.target) || isRenameInputTarget(event.target)) return;
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
      if (isShortcutCaptureTarget(event.target) || isRenameInputTarget(event.target)) return;
      const action = matchesPointerShortcut(event, settings.shortcuts.home)
        ? "home"
        : matchesPointerShortcut(event, settings.shortcuts.renameWindow)
          ? "renameWindow"
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
  }, [activeSessionId, goHome, settings.locale, settings.shortcuts, showToast]);

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
  const workspaceSettings = useMemo(() => homeEditDraft ? {
    ...settings,
    homeGridSize: homeEditDraft.homeGridSize,
    homeLayout: homeEditDraft.homeLayout
  } : settings, [homeEditDraft, settings]);

  return (
    <div className={rootClasses} style={rootStyle}>
      <TitleBar locale={settings.locale} windowState={windowState} onWindowStateChange={setWindowState} />
      <main className="app__content">
        {!ready && <div className="loading-screen">{t(settings.locale, "loading")}</div>}
        <WorkspaceCanvas
          settings={workspaceSettings}
          mediaData={mediaData}
          sessions={sessions}
          limits={limits}
          limitsLoadState={limitsLoadState}
          plugins={plugins}
          browser={browser}
          browserViewVisible={!settingsOpen && launchProvider === null && pendingTerminalUrl === null}
          homeEditing={homeEditDraft !== null}
          camera={camera}
          onCameraChange={changeCamera}
          onGoHome={goHome}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAgent={openAgent}
          onOpenTerminal={(position) => void openTerminal(position)}
          onOpenBrowser={openBrowserFromUi}
          onOpenTerminalUrl={(url) => {
            try {
              setPendingTerminalUrl(normalizeExternalUrl(url));
            } catch (error) {
              showToast(error instanceof Error ? error.message : t(settings.locale, "browserActionFailed"));
            }
          }}
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
          activeSessionId={activeSessionId}
          browserSelected={browserSelected}
          renamingSessionId={renamingSessionId}
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
        />
      </main>

      <AgentLaunchDialog
        provider={launchProvider}
        settings={settings}
        onClose={() => {
          setLaunchProvider(null);
          setLaunchPosition(null);
        }}
        onAcknowledge={acknowledgeDanger}
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
        settings={settings}
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
        onUninstallPlugin={uninstallPlugin}
        onOpenPluginContribution={openPluginContribution}
        onToggleHomeWidget={toggleHomeWidget}
        onEditHome={startHomeEditor}
        onOpenBrowser={openBrowser}
      />
      <Toast message={toast} />
    </div>
  );
}

function nextSessionPosition(index: number, homeGridSize: HomeGridSize): Point {
  const homeSize = homeGridPixelSize(homeGridSize);
  return {
    x: homeSize.width + 160 + (index % 2) * 760,
    y: Math.floor(index / 2) * 500 + 20
  };
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
