import { useEffect, useRef, useState } from "react";
import type {
  AgentProviderId,
  AppSettings,
  CameraState,
  LimitsSnapshot,
  Point,
  SessionBounds,
  SessionSnapshot
} from "../../../../shared/contracts";
import { HomeZone } from "../home/HomeZone";
import { BrowserCard } from "../browser/BrowserCard";
import type { BrowserCardState } from "../browser/BrowserCard";
import { EDGE_PAN_SPEEDS, edgePanVelocity } from "./edgePan";
import { wheelZoomFactor } from "./zoom";
import { TerminalCard } from "../terminal/TerminalCard";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import type { LimitsLoadState } from "../home/homeModel";

interface WorkspaceCanvasProps {
  settings: AppSettings;
  mediaData: string | null;
  sessions: SessionSnapshot[];
  browserCards: BrowserCardState[];
  limits: LimitsSnapshot | null;
  limitsLoadState: LimitsLoadState;
  camera: CameraState;
  onCameraChange(camera: CameraState): void;
  onGoHome(): void;
  onOpenSettings(): void;
  onOpenAgent(provider: AgentProviderId): void;
  onOpenTerminal(): void;
  onOpenBrowser(): void;
  onFocusSession(session: SessionSnapshot): void;
  onRequestMedia(): Promise<void>;
  onRemoveMedia(): Promise<void>;
  onSessionBoundsChange(id: string, bounds: SessionBounds): void;
  onDisposeSession(id: string): void;
  onBrowserBoundsChange(id: string, bounds: SessionBounds): void;
  onBrowserUrlChange(id: string, url: string): void;
  onDisposeBrowser(id: string): void;
}

interface PanState {
  pointerId: number;
  startClient: Point;
  startCamera: CameraState;
}

export function WorkspaceCanvas({
  settings,
  mediaData,
  sessions,
  browserCards,
  limits,
  limitsLoadState,
  camera,
  onCameraChange,
  onGoHome,
  onOpenSettings,
  onOpenAgent,
  onOpenTerminal,
  onOpenBrowser,
  onFocusSession,
  onRequestMedia,
  onRemoveMedia,
  onSessionBoundsChange,
  onDisposeSession,
  onBrowserBoundsChange,
  onBrowserUrlChange,
  onDisposeBrowser
}: WorkspaceCanvasProps): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const panState = useRef<PanState | null>(null);
  const [panning, setPanning] = useState(false);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const edgePointer = useRef<Point | null>(null);
  const edgeFrame = useRef<number | null>(null);
  const edgeLastTime = useRef(0);

  useEffect(() => () => {
    if (edgeFrame.current !== null) cancelAnimationFrame(edgeFrame.current);
  }, []);

  const edgePanStep = (time: number): void => {
    edgeFrame.current = null;
    const pointer = edgePointer.current;
    if (!pointer || panState.current || !settingsRef.current.edgePan) return;
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return;
    const hovered = document.elementFromPoint(pointer.x, pointer.y);
    if (hovered?.closest('[data-interactive="true"]')) return;
    const velocity = edgePanVelocity(pointer, bounds, {
      maxSpeed: EDGE_PAN_SPEEDS[settingsRef.current.edgePanSpeed]
    });
    if (!velocity) return;
    const dt = edgeLastTime.current === 0 ? 0 : Math.min(0.05, (time - edgeLastTime.current) / 1000);
    edgeLastTime.current = time;
    onCameraChange({
      ...cameraRef.current,
      x: cameraRef.current.x + velocity.x * dt,
      y: cameraRef.current.y + velocity.y * dt
    });
    edgeFrame.current = requestAnimationFrame(edgePanStep);
  };

  const trackEdgePointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!settings.edgePan) {
      edgePointer.current = null;
      return;
    }
    edgePointer.current = { x: event.clientX, y: event.clientY };
    if (edgeFrame.current === null) {
      edgeLastTime.current = 0;
      edgeFrame.current = requestAnimationFrame(edgePanStep);
    }
  };

  const startPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-interactive="true"]')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startCamera: camera
    };
    setPanning(true);
  };

  const pan = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = panState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    onCameraChange({
      ...camera,
      x: state.startCamera.x + event.clientX - state.startClient.x,
      y: state.startCamera.y + event.clientY - state.startClient.y
    });
  };

  const endPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (panState.current?.pointerId !== event.pointerId) return;
    panState.current = null;
    setPanning(false);
  };

  const zoomAt = (clientX: number, clientY: number, nextZoom: number): void => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return;
    const localX = clientX - bounds.left;
    const localY = clientY - bounds.top;
    const worldX = (localX - camera.x) / camera.zoom;
    const worldY = (localY - camera.y) / camera.zoom;
    onCameraChange({
      zoom: nextZoom,
      x: localX - worldX * nextZoom,
      y: localY - worldY * nextZoom
    });
  };

  const zoomBy = (factor: number): void => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return;
    const nextZoom = clamp(camera.zoom * factor, 0.28, 1.35);
    zoomAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, nextZoom);
  };

  return (
    <div
      ref={viewport}
      className={`workspace pattern-${settings.pattern} ${panning ? "workspace--panning" : ""}`}
      onPointerDown={startPan}
      onPointerMove={(event) => {
        pan(event);
        trackEdgePointer(event);
      }}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onPointerLeave={() => {
        edgePointer.current = null;
      }}
      onWheel={(event) => {
        if ((event.target as HTMLElement).closest('[data-wheel-owner="local"]')) return;
        event.preventDefault();
        zoomAt(event.clientX, event.clientY, clamp(camera.zoom * wheelZoomFactor(event.deltaY, settings.zoomSensitivity), 0.28, 1.35));
      }}
    >
      <div className="workspace__scene" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        <HomeZone
          settings={settings}
          mediaData={mediaData}
          sessions={sessions}
          limits={limits}
          limitsLoadState={limitsLoadState}
          onOpenSettings={onOpenSettings}
          onOpenAgent={onOpenAgent}
          onOpenTerminal={onOpenTerminal}
          onOpenBrowser={onOpenBrowser}
          onFocusSession={onFocusSession}
          onRequestMedia={onRequestMedia}
          onRemoveMedia={onRemoveMedia}
        />
        {sessions.map((session) => (
          <TerminalCard
            key={session.id}
            session={session}
            locale={settings.locale}
            palette={settings.palette}
            zoom={camera.zoom}
            snapEnabled={settings.snapToGrid}
            snapTargets={[
              HOME_BOUNDS,
              ...sessions
                .filter((candidate) => candidate.id !== session.id)
                .map((candidate) => ({ position: candidate.position, size: candidate.size })),
              ...browserCards.map((candidate) => ({ position: candidate.position, size: candidate.size }))
            ]}
            onActivate={onFocusSession}
            onBoundsChange={onSessionBoundsChange}
            onDispose={onDisposeSession}
          />
        ))}
        {browserCards.map((card) => (
          <BrowserCard
            key={card.id}
            card={card}
            locale={settings.locale}
            zoom={camera.zoom}
            snapEnabled={settings.snapToGrid}
            snapTargets={[
              HOME_BOUNDS,
              ...sessions.map((candidate) => ({ position: candidate.position, size: candidate.size })),
              ...browserCards
                .filter((candidate) => candidate.id !== card.id)
                .map((candidate) => ({ position: candidate.position, size: candidate.size }))
            ]}
            onBoundsChange={onBrowserBoundsChange}
            onUrlChange={onBrowserUrlChange}
            onDispose={onDisposeBrowser}
          />
        ))}
      </div>

      <div className="canvas-controls" data-interactive="true">
        <button type="button" onClick={onGoHome} title={t(settings.locale, "home")}><UiIcon name="home" size={17} /></button>
        <button type="button" onClick={() => zoomBy(0.82)} title={t(settings.locale, "zoomOut")}><UiIcon name="zoom-out" size={17} /></button>
        <button type="button" onClick={() => zoomBy(1.22)} title={t(settings.locale, "zoomIn")}><UiIcon name="zoom-in" size={17} /></button>
      </div>
    </div>
  );
}

const HOME_BOUNDS: SessionBounds = {
  position: { x: 0, y: 0 },
  size: { width: 1180, height: 700 }
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
