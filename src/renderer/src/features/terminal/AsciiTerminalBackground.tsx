import { useEffect, useRef, type MutableRefObject } from "react";
import { getBackgroundSyncClock, type BackgroundSyncClock } from "./backgroundSyncClock";
import { createBackgroundOutputPause } from "./backgroundOutputPause";
import type { TerminalBackgroundId } from "../../../../shared/terminalBackground";
import type { BackgroundWorkerMessage } from "./asciiBackground.worker";
import "./asciiTerminalBackground.css";

export function AsciiTerminalBackground({ scene, brightness, contrast, saturation, paused, speed, scale, offsetX, offsetY, live, pauseOnOutput, outputActivity, synchronized, viewport, focusDimming, focused, hidden = false }: {
  scene: Exclude<TerminalBackgroundId, "none">;
  brightness: number;
  contrast: number;
  saturation: number;
  paused: boolean;
  speed: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  live: boolean;
  pauseOnOutput: boolean;
  synchronized: boolean;
  viewport?: { width: number; height: number };
  outputActivity: MutableRefObject<(() => void) | null>;
  focusDimming?: boolean;
  focused?: boolean;
  hidden?: boolean;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const updateSize = useRef<(() => void) | null>(null);
  const pausedRef = useRef(paused);
  const pauseOnOutputRef = useRef(pauseOnOutput);
  pauseOnOutputRef.current = pauseOnOutput;
  const outputPause = useRef<ReturnType<typeof createBackgroundOutputPause> | null>(null);
  const brightnessRef = useRef(brightness);
  const speedRef = useRef(speed);
  const synchronizedRef = useRef(synchronized);
  synchronizedRef.current = synchronized;
  const syncClock = useRef<BackgroundSyncClock | null>(null);
  const syncScene = useRef(scene);
  const transformRef = useRef({ scale, offsetX, offsetY });
  const updatePlayback = useRef<(() => void) | null>(null);
  pausedRef.current = paused;
  brightnessRef.current = brightness;
  speedRef.current = speed;
  transformRef.current = { scale, offsetX, offsetY };
  useEffect(() => {
    const element = host.current;
    if (!element || !live) return;
    const canvas = document.createElement("canvas");
    element.append(canvas);
    const worker = new Worker(new URL("./asciiBackground.worker.ts", import.meta.url), { type: "module" });
    const send = (message: BackgroundWorkerMessage): void => worker.postMessage(message);
    const size = (): { width: number; height: number; pixelRatio: number } => {
      const width = Math.max(1, viewportRef.current?.width ?? element.clientWidth), height = Math.max(1, viewportRef.current?.height ?? element.clientHeight);
      const ratio = Math.min(devicePixelRatio || 1, 2, 2048 / width, 1200 / height);
      return {
        width: Math.max(1, Math.round(width * ratio)),
        height: Math.max(1, Math.round(height * ratio)),
        pixelRatio: ratio,
      };
    };
    const initialSize = size();
    canvas.width = initialSize.width;
    canvas.height = initialSize.height;
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "init", canvas: offscreen, scene, pixelRatio: initialSize.pixelRatio, recoverContext: window.canvasTTY.window.isMacOS } satisfies BackgroundWorkerMessage, [offscreen]);
    worker.onmessage = (event) => {
      if (event.data?.type === "error") {
        console.warn("ASCII background load failed:", scene, event.data.error);
        canvas.style.display = "none";
      }
    };
    worker.onerror = (event) => {
      console.warn("ASCII background worker failed", scene, event.message);
      canvas.style.display = "none";
    };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const run = (): void => {
      send({ type: "transform", value: transformRef.current });
      send({ type: "speed", value: speedRef.current });
      if (syncScene.current !== scene) { syncClock.current = null; syncScene.current = scene; }
      syncClock.current = synchronizedRef.current ? getBackgroundSyncClock(scene, speedRef.current, syncClock.current) : null;
      send({ type: "synchronize", clock: syncClock.current });
      send({ type: "playing", value: visible && !pausedRef.current && !outputPause.current?.isPaused() && brightnessRef.current > 0 && !reduced.matches && !document.hidden });
    };
    const pause = createBackgroundOutputPause(run);
    pause.setEnabled(pauseOnOutputRef.current);
    outputPause.current = pause;
    outputActivity.current = pause.activity;
    updatePlayback.current = run;
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; run(); });
    const resize = (): void => send({ type: "resize", ...size() });
    updateSize.current = resize;
    const resizer = new ResizeObserver(resize);
    observer.observe(canvas);
    resizer.observe(element);
    document.addEventListener("visibilitychange", run);
    reduced.addEventListener("change", run);
    return () => {
      pause.dispose();
      if (outputActivity.current === pause.activity) outputActivity.current = null;
      if (outputPause.current === pause) outputPause.current = null;
      observer.disconnect();
      resizer.disconnect();
      document.removeEventListener("visibilitychange", run);
      reduced.removeEventListener("change", run);
      worker.terminate();
      canvas.remove();
      updatePlayback.current = null;
      updateSize.current = null;
    };
  }, [scene, live]);
  useEffect(() => {
    outputPause.current?.setEnabled(pauseOnOutput);
    updatePlayback.current?.();
  }, [paused, brightness, speed, scale, offsetX, offsetY, pauseOnOutput, synchronized]);
  useEffect(() => { updateSize.current?.(); }, [viewport?.width, viewport?.height]);
  const dimFactor = (focusDimming && focused) ? 0.35 : 1.0;
  const effectiveBrightness = Math.max(5, Math.min(100, Math.round(brightness * dimFactor)));
  return <div ref={host} className="terminal-ascii-background" hidden={hidden} aria-hidden="true" style={{ opacity: effectiveBrightness / 100,
    filter: contrast === 100 && saturation === 100 ? undefined : `contrast(${contrast}%) saturate(${saturation}%)`,
    transition: focusDimming ? "opacity 0.25s ease" : undefined }} />;
}
