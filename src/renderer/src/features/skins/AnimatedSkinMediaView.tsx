import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { SkinMediaInfo } from "../../../../shared/skinMedia";

// One native subscription/poll per renderer, shared by all visible skin instances.
// On macOS a programmatic hide can change isVisible() before the hide event arrives.
// The fallback also covers Electron windows whose Page Visibility API stays visible.
const nativeVisibilityListeners = new Set<() => void>();
let nativeVisibility = true;
let stopNativeVisibility: (() => void) | null = null;
function subscribeNativeVisibility(listener: () => void): () => void {
  nativeVisibilityListeners.add(listener);
  if (nativeVisibilityListeners.size === 1) {
    const api = window.canvasTTY?.window;
    if (api) {
      let active = true, revision = 0;
      const update = (visible: boolean): void => {
        if (!active || nativeVisibility === visible) return;
        nativeVisibility = visible;
        for (const subscriber of nativeVisibilityListeners) subscriber();
      };
      const unsubscribe = api.onState((state) => { revision += 1; update(state.visible !== false); });
      const poll = (): void => {
        const version = ++revision;
        void api.getState().then((state) => { if (version === revision) update(state.visible !== false); }).catch(() => undefined);
      };
      poll();
      const timer = setInterval(poll, 500);
      stopNativeVisibility = () => { active = false; clearInterval(timer); unsubscribe(); };
    }
  }
  return () => {
    nativeVisibilityListeners.delete(listener);
    if (nativeVisibilityListeners.size === 0) { stopNativeVisibility?.(); stopNativeVisibility = null; }
  };
}

/** Native media retains APNG/WebP animation, unlike a one-time drawImage call. */
export default function AnimatedSkinMediaView({ src, media, className, style, paused = false, onError, errorLabel }: {
  src: string;
  media: SkinMediaInfo;
  className?: string;
  style?: CSSProperties;
  paused?: boolean;
  onError?(): void;
  errorLabel?: string;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const fail = (): void => { setFailed(true); onError?.(); };
  const host = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const still = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(!document.hidden);
  const nativeVisible = useSyncExternalStore(subscribeNativeVisibility, () => nativeVisibility);
  const [intersecting, setIntersecting] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const videoMedia = media.format === "mp4" || media.format === "webm";
  const playing = !failed && !paused && visible && nativeVisible && intersecting && !reduced;

  useEffect(() => setFailed(false), [src]);

  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const visibility = (): void => setVisible(!document.hidden);
    const motion = (): void => setReduced(query.matches);
    document.addEventListener("visibilitychange", visibility);
    query.addEventListener("change", motion);
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting));
    if (host.current) observer.observe(host.current);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      query.removeEventListener("change", motion);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.muted = true;
    if (playing) void element.play().catch(() => { /* Decode errors surface via onError. */ });
    else element.pause();
    return () => element.pause();
  }, [src, playing, videoMedia]);

  useEffect(() => {
    if (videoMedia || !media.animated || playing) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      const canvas = still.current;
      if (!active || !canvas) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d")?.drawImage(image, 0, 0);
      image.src = "";
    };
    image.src = src;
    return () => { active = false; image.src = ""; };
  }, [src, videoMedia, media.animated, playing]);

  return <span ref={host} className={className} style={style} aria-hidden={failed && errorLabel ? undefined : true} data-skin-media={media.format}>
    {failed && errorLabel && <span className="skin-media-error" role="status">{errorLabel}</span>}
    {videoMedia
      ? <video ref={video} src={src} muted loop playsInline preload="metadata" onError={fail} />
      : media.animated && !playing
        ? <canvas ref={still} />
        : <img src={src} alt="" onError={fail} />}
  </span>;
}
