import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PixelTerminalBorderSkinId, SessionStatus } from "../../../../shared/contracts";
import { acquireSkinImage, isPixelSkinPackId, PILOT_SKIN_ASSETS, usePixelSkinPackAssets } from "./SkinAssets";
import { pixelSkinArtworkBounds, pixelSkinSurfaceBounds } from "./SkinLayout";
import type { PixelSkinSurfaceBounds, SkinDetailLevel } from "./SkinLayout";
import { needsGoldMinimalWorkingMarker, resolvePixelSkinViewAsset } from "./skinViewAssets";
import { isPixelSkinThemeId, pixelSkinStateForSession } from "./skinCatalog";
import type { PixelSkinArtState, PixelSkinThemeId } from "./skinCatalog";

const MAX_CANVAS_PIXELS = 2_000_000;
type ArtworkDetail = SkinDetailLevel;
const THEME_COLORS: Record<PixelSkinThemeId, string> = {
  sakura: "#ef5a9e",
  matrix: "#24ee76",
  "forest-cabin": "#ef9d50",
  "gold-black": "#f2bc37",
  cat: "#f5a742",
  "gothic-eclipse": "#db7955"
};

interface SkinArtwork {
  theme: PixelSkinThemeId | PixelTerminalBorderSkinId;
  artState: PixelSkinArtState;
  detail: ArtworkDetail;
  image: HTMLImageElement;
  transparentCenter: boolean;
}

interface ViewState {
  theme: PixelSkinThemeId | PixelTerminalBorderSkinId;
  status: SessionStatus;
  artState: PixelSkinArtState;
  width: number;
  height: number;
  detail: ArtworkDetail;
  image: HTMLImageElement | null;
  transparentCenter: boolean;
  surfaceBounds: PixelSkinSurfaceBounds;
}

function fadePreviousCanvas(canvas: HTMLCanvasElement, transitions: Set<() => void>): void {
  const snapshot = canvas.cloneNode(false) as HTMLCanvasElement;
  const context = snapshot.getContext("2d");
  if (!context) return;
  context.drawImage(canvas, 0, 0);
  // Insert under older fading snapshots so a rapid status change keeps the current composite visible.
  canvas.after(snapshot);
  const animation = snapshot.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 180, easing: "ease-in-out", fill: "forwards"
  });
  const cleanup = (): void => {
    animation.onfinish = animation.oncancel = null;
    animation.cancel();
    snapshot.remove();
    transitions.delete(cleanup);
  };
  transitions.add(cleanup);
  animation.onfinish = animation.oncancel = cleanup;
}

function paintFallback(context: CanvasRenderingContext2D, state: ViewState, width: number, height: number): void {
  const themeColor = isPixelSkinThemeId(state.theme) ? THEME_COLORS[state.theme] : "#9fbacb";
  const statusColor = state.status === "failed" ? "#ed7f84"
    : state.status === "needs_approval" ? "#f2be65" : themeColor;
  context.strokeStyle = statusColor;
  context.lineWidth = 3;
  context.strokeRect(2, 2, Math.max(0, width - 4), Math.max(0, height - 4));
  context.fillStyle = statusColor;
  for (const x of [4, Math.max(4, width - 12)]) {
    for (const y of [4, Math.max(4, height - 12)]) context.fillRect(x, y, 8, 8);
  }
  if (state.status === "working" && width > 72) {
    for (let index = 0; index < 3; index += 1) context.fillRect(width / 2 - 13 + index * 10, 3, 4, 4);
  }
}

function imageHasTransparentCenter(image: HTMLImageElement): boolean {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  context.imageSmoothingEnabled = false;
  context.drawImage(image, Math.floor(image.naturalWidth / 2), Math.floor(image.naturalHeight / 2), 1, 1, 0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3] <= 8;
}

function paint(canvas: HTMLCanvasElement, state: ViewState, frameOnly = false): void {
  const { width, height, detail, status } = state;
  if (width <= 0 || height <= 0) return;

  const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  const pixelWidth = Math.max(1, Math.ceil(width * ratio));
  const pixelHeight = Math.max(1, Math.ceil(height * ratio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, width, height);

  const image = state.image;
  if (!frameOnly && state.transparentCenter) return;
  if (frameOnly) {
    if (!image) return;
  }
  if (frameOnly && !state.transparentCenter) {
    const { left, right, top, bottom } = state.surfaceBounds;
    if (![left, right, top, bottom].every(Number.isFinite) || left >= right || top >= bottom) return;
    context.save();
    // Expand the opening outward so fractional CSS bounds cannot cover terminal glyphs.
    context.beginPath();
    context.rect(0, 0, width, height);
    context.rect(Math.floor(left), Math.floor(top), Math.ceil(right) - Math.floor(left), Math.ceil(bottom) - Math.floor(top));
    context.clip("evenodd");
  }
  if (!image) {
    paintFallback(context, state, width, height);
  } else {
    try {
      const art = pixelSkinArtworkBounds(state.theme, detail);
      context.drawImage(image,
        art.x * image.naturalWidth, art.y * image.naturalHeight,
        art.width * image.naturalWidth, art.height * image.naturalHeight,
        0, 0, width, height);
    } catch {
      context.clearRect(0, 0, width, height);
      paintFallback(context, state, width, height);
    }
  }

  if (isPixelSkinThemeId(state.theme)
    && needsGoldMinimalWorkingMarker(state.theme, detail, state.artState, PILOT_SKIN_ASSETS) && width >= 64) {
    context.fillStyle = "#6b4a0b";
    context.fillRect(width / 2 - 8, 4, 16, 8);
    context.fillStyle = "#f2bc37";
    context.fillRect(width / 2 - 5, 6, 3, 4);
    context.fillRect(width / 2 - 1, 6, 3, 4);
    context.fillRect(width / 2 + 3, 6, 3, 4);
  }
  if (frameOnly && !state.transparentCenter) context.restore();
}

export function Canvas2DSkinView({ theme, status, artState, width, height, detail, surfaceBounds }: {
  theme: PixelSkinThemeId | PixelTerminalBorderSkinId;
  status: SessionStatus;
  artState?: PixelSkinArtState;
  width: number;
  height: number;
  detail: ArtworkDetail;
  surfaceBounds?: PixelSkinSurfaceBounds;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLCanvasElement>(null);
  const [artwork, setArtwork] = useState<SkinArtwork | null>(null);
  const previousArtwork = useRef<SkinArtwork | null>(null);
  const transitions = useRef(new Set<() => void>());
  const packUrls = usePixelSkinPackAssets(isPixelSkinPackId(theme) ? theme : null);
  const stateName = artState ?? pixelSkinStateForSession(status);
  const resolution = isPixelSkinThemeId(theme)
    ? resolvePixelSkinViewAsset(theme, detail, stateName, PILOT_SKIN_ASSETS)
    : null;
  const assetUrl = resolution?.kind === "asset" ? resolution.url
    : packUrls ? packUrls[`${detail}_${stateName}`] : null;
  const transparentCenter = artwork?.transparentCenter ?? false;
  const bounds = surfaceBounds ?? pixelSkinSurfaceBounds(theme, detail, width, height);

  useEffect(() => {
    if (!assetUrl) return;
    const acquired = acquireSkinImage(assetUrl);
    let mounted = true;
    void acquired.image.then((image) => {
      if (!mounted) return;
      setArtwork({ theme, detail, artState: stateName, image, transparentCenter: imageHasTransparentCenter(image) });
    }).catch(() => {
      // Keep the last decoded artwork; an initial failure already has the fallback frame.
    });
    return () => {
      mounted = false;
      acquired.release();
    };
  }, [assetUrl, theme, detail, stateName]);

  useLayoutEffect(() => {
    const current: ViewState = {
      theme, status, artState: stateName, detail, image: null, transparentCenter: false,
      ...artwork, width, height, surfaceBounds: bounds
    };
    if (previousArtwork.current && previousArtwork.current !== artwork && !document.hidden
      && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (canvasRef.current) fadePreviousCanvas(canvasRef.current, transitions.current);
      if (frameRef.current) fadePreviousCanvas(frameRef.current, transitions.current);
    }
    if (canvasRef.current) paint(canvasRef.current, current);
    if (frameRef.current) paint(frameRef.current, current, true);
    previousArtwork.current = artwork;
  }, [artwork, theme, status, stateName, width, height, detail,
    bounds.left, bounds.right, bounds.top, bounds.bottom]);

  useLayoutEffect(() => () => {
    for (const cleanup of transitions.current) cleanup();
  }, []);

  return <>
    <canvas ref={canvasRef} className="terminal-skin-canvas" data-detail={artwork?.detail ?? detail} aria-hidden="true" />
    <canvas ref={frameRef} className="terminal-skin-canvas terminal-skin-canvas--frame" data-overlay={transparentCenter} aria-hidden="true" />
  </>;
}
