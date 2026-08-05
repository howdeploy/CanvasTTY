import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProviderId,
  AppSettings,
  CameraState,
  LaunchProfileId,
  LimitsSnapshot,
  Point,
  ProviderId,
  SessionBounds,
  SessionMetadata,
  SessionSnapshot
} from "../../shared/contracts";
import { TitleBar } from "./components/TitleBar";
import { Toast } from "./components/Toast";
import { AgentLaunchDialog } from "./features/launcher/AgentLaunchDialog";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { WorkspaceCanvas } from "./features/workspace/WorkspaceCanvas";
import type { BrowserCardState } from "./features/browser/BrowserCard";
import type { LimitsLoadState } from "./features/home/homeModel";
import { t } from "./lib/i18n";

const FALLBACK_SETTINGS: AppSettings = {
  locale: "ru",
  palette: "sage",
  pattern: "dots",
  snapToGrid: true,
  edgePan: false,
  edgePanSpeed: "normal",
  zoomSensitivity: "normal",
  mediaPath: null,
  mediaFit: "cover",
  lastDirectory: "/",
  acknowledgedDangerousProfiles: []
};

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState(FALLBACK_SETTINGS);
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const [browserCards, setBrowserCards] = useState<BrowserCardState[]>([]);
  const [limits, setLimits] = useState<LimitsSnapshot | null>(null);
  const [limitsLoadState, setLimitsLoadState] = useState<LimitsLoadState>("loading");
  const [mediaData, setMediaData] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraState>(() => homeCamera());
  const isHomeCamera = useRef(true);
  const [launchProvider, setLaunchProvider] = useState<ProviderId | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const showToast = useCallback((message: string): void => setToast(message), []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2_600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true;
    const unsubscribeSession = window.canvasTTY.terminal.onSession(({ session }) => {
      if (active) setSessions((current) => upsertSession(current, session));
    });
    const unsubscribeRemoved = window.canvasTTY.terminal.onRemoved(({ id }) => {
      if (active) setSessions((current) => current.filter((session) => session.id !== id));
    });

    void Promise.all([window.canvasTTY.settings.get(), window.canvasTTY.terminal.list()])
      .then(async ([loadedSettings, loadedSessions]) => {
        if (!active) return;
        setSettings(loadedSettings);
        setSessions(loadedSessions);
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
      if (isHomeCamera.current) setCamera(homeCamera());
    };
    window.addEventListener("resize", recenterHome);
    return () => window.removeEventListener("resize", recenterHome);
  }, []);

  const saveSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      const updated = await window.canvasTTY.settings.update(patch);
      setSettings(updated);
    } catch {
      showToast(t(settings.locale, "settingsFailed"));
    }
  }, [settings.locale, showToast]);

  const createSession = useCallback(async (
    provider: ProviderId,
    profile: LaunchProfileId,
    cwd: string,
    title: string
  ): Promise<SessionSnapshot> => {
    const position = nextSessionPosition(sessions.length);
    const session = await window.canvasTTY.terminal.create({ provider, profile, cwd, position, title });
    setSessions((current) => upsertSnapshot(current, session));
    await saveSettings({ lastDirectory: cwd });
    isHomeCamera.current = false;
    setCamera(focusCamera(position, session.size));
    return session;
  }, [sessions.length, saveSettings]);

  const launchSession = useCallback(async (
    provider: ProviderId,
    profile: LaunchProfileId,
    cwd: string,
    title: string
  ): Promise<void> => {
    await createSession(provider, profile, cwd, title);
    showToast(provider === "terminal"
      ? t(settings.locale, "terminalStarted")
      : `${t(settings.locale, "sessionStarted")}: ${provider}`);
  }, [createSession, settings.locale, showToast]);

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

  const disposeSession = useCallback((id: string): void => {
    void window.canvasTTY.terminal.dispose(id);
    setSessions((current) => current.filter((session) => session.id !== id));
  }, []);

  const openBrowser = useCallback((): void => {
    const position = nextSessionPosition(sessions.length + browserCards.length);
    const size = { width: 940, height: 620 };
    setBrowserCards((current) => [
      ...current,
      { id: `browser-${Date.now()}-${current.length}`, url: "", position, size }
    ]);
    isHomeCamera.current = false;
    setCamera(focusCamera(position, size));
  }, [sessions.length, browserCards.length]);

  const changeBrowserBounds = useCallback((id: string, bounds: SessionBounds): void => {
    setBrowserCards((current) => current.map((card) => (card.id === id
      ? { ...card, position: bounds.position, size: bounds.size }
      : card)));
  }, []);

  const changeBrowserUrl = useCallback((id: string, url: string): void => {
    setBrowserCards((current) => current.map((card) => (card.id === id ? { ...card, url } : card)));
  }, []);

  const disposeBrowser = useCallback((id: string): void => {
    setBrowserCards((current) => current.filter((card) => card.id !== id));
  }, []);

  const focusSession = useCallback((session: SessionSnapshot): void => {
    isHomeCamera.current = false;
    setCamera(focusCamera(session.position, session.size));
  }, []);

  const changeCamera = useCallback((nextCamera: CameraState): void => {
    isHomeCamera.current = false;
    setCamera(nextCamera);
  }, []);

  const goHome = useCallback((): void => {
    isHomeCamera.current = true;
    setCamera(homeCamera());
  }, []);

  const rootClasses = useMemo(
    () => `app app--${settings.palette}`,
    [settings.palette]
  );

  return (
    <div className={rootClasses}>
      <TitleBar locale={settings.locale} />
      <main className="app__content">
        {!ready && <div className="loading-screen">{t(settings.locale, "loading")}</div>}
        <WorkspaceCanvas
          settings={settings}
          mediaData={mediaData}
          sessions={sessions}
          browserCards={browserCards}
          limits={limits}
          limitsLoadState={limitsLoadState}
          camera={camera}
          onCameraChange={changeCamera}
          onGoHome={goHome}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAgent={setLaunchProvider}
          onOpenTerminal={() => setLaunchProvider("terminal")}
          onOpenBrowser={openBrowser}
          onRequestMedia={requestMedia}
          onRemoveMedia={removeMedia}
          onFocusSession={focusSession}
          onSessionBoundsChange={changeSessionBounds}
          onDisposeSession={disposeSession}
          onBrowserBoundsChange={changeBrowserBounds}
          onBrowserUrlChange={changeBrowserUrl}
          onDisposeBrowser={disposeBrowser}
        />
      </main>

      <AgentLaunchDialog
        provider={launchProvider}
        settings={settings}
        onClose={() => setLaunchProvider(null)}
        onAcknowledge={acknowledgeDanger}
        onLaunch={launchSession}
      />
      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onChange={saveSettings}
      />
      <Toast message={toast} />
    </div>
  );
}

function upsertSession(sessions: SessionSnapshot[], metadata: SessionMetadata): SessionSnapshot[] {
  const existing = sessions.find((session) => session.id === metadata.id);
  const next: SessionSnapshot = { ...metadata, buffer: existing?.buffer ?? "" };
  return upsertSnapshot(sessions, next);
}

function upsertSnapshot(sessions: SessionSnapshot[], next: SessionSnapshot): SessionSnapshot[] {
  const index = sessions.findIndex((session) => session.id === next.id);
  if (index < 0) return [...sessions, next];
  return sessions.map((session) => session.id === next.id ? next : session);
}

function nextSessionPosition(index: number): Point {
  return {
    x: 1340 + (index % 2) * 760,
    y: Math.floor(index / 2) * 500 + 20
  };
}

function homeCamera(): CameraState {
  const viewportWidth = typeof window === "undefined" ? 1360 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 820 : window.innerHeight - 44;
  const availableZoom = Math.min(
    1,
    (viewportWidth - 64) / 1180,
    (viewportHeight - 48) / 700
  );
  const zoom = [1, 0.9, 0.8, 0.75, 2 / 3, 0.5, 0.4, 1 / 3, 0.28]
    .find((step) => step <= availableZoom) ?? 0.28;
  return {
    zoom,
    x: Math.round((viewportWidth - 1180 * zoom) / 2),
    y: Math.round((viewportHeight - 700 * zoom) / 2)
  };
}

function focusCamera(position: Point, size: { width: number; height: number }): CameraState {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight - 44;
  const zoom = 0.92;
  return {
    zoom,
    x: viewportWidth / 2 - (position.x + size.width / 2) * zoom,
    y: viewportHeight / 2 - (position.y + size.height / 2) * zoom
  };
}
