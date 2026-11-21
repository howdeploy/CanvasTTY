import type { SkinMediaInfo } from "../../../../shared/skinMedia";
import { useEffect, useState, useSyncExternalStore } from "react";
import { duoWorkspace } from "../duo/duoWorkspaceRuntime";
import { createReleasingCache } from "./releasingCache";
import type { PixelSkinPackSummary, PixelSkinSlot, PixelTerminalBorderSkinId } from "../../../../shared/contracts";

interface CachedImage { image: HTMLImageElement; references: number; promise: Promise<HTMLImageElement> }
const images = new Map<string, CachedImage>();

const pilotModules = import.meta.glob<string>("./assets/pilots/*.avif", {
  eager: true,
  query: "?url",
  import: "default"
});

export const PILOT_SKIN_ASSETS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(pilotModules).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url])
);

export function acquireSkinImage(url: string): { image: Promise<HTMLImageElement>; release(): void } {
  let entry = images.get(url);
  if (!entry) {
    const image = new Image();
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Skin image could not be decoded."));
      image.src = url;
    });
    entry = { image, references: 0, promise };
    images.set(url, entry);
  }
  entry.references += 1;
  let released = false;
  return {
    image: entry.promise,
    release() {
      if (released) return;
      released = true;
      if (--entry.references === 0) images.delete(url);
    }
  };
}

export function cachedSkinImageCount(): number { return images.size; }

export function isPixelSkinPackId(value: unknown): value is PixelTerminalBorderSkinId {
  return typeof value === "string" && /^pixel:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

interface PackAsset { url: string; media: SkinMediaInfo }

function skinSource(): string {
  const state = duoWorkspace.get().reply?.state;
  return state?.role === "guest" && state.documentSync ? state.workspaceId ?? "guest" : "local";
}

// A terminal frame and the workspace background have independent lifetimes and transfers.
const assets = createReleasingCache<string, PackAsset>({
  load: async key => {
    const [id, slot] = key.split("/") as [PixelTerminalBorderSkinId, PixelSkinSlot];
    const bytes = await window.canvasTTY.pixelSkins.readAsset(id, slot);
    if (!bytes) throw new Error(`Pixel skin asset ${slot} is unavailable.`);
    const { inspectSkinMedia, SKIN_MEDIA_MIME } = await import("../../../../shared/skinMedia");
    const copy = new Uint8Array(bytes);
    const media = inspectSkinMedia(copy);
    return { url: URL.createObjectURL(new Blob([copy], { type: SKIN_MEDIA_MIME[media.format] })), media };
  },
  dispose: asset => URL.revokeObjectURL(asset.url),
  delayMs: 30_000
});

export function usePixelSkinPackAsset(id: PixelTerminalBorderSkinId | null, slot: PixelSkinSlot): PackAsset | null {
  const source = useSyncExternalStore(duoWorkspace.subscribe, skinSource);
  const key = id && `${id}/${slot}/${source}`;
  const [loaded, setLoaded] = useState<{ key: string; asset: PackAsset } | null>(null);
  useEffect(() => {
    if (!key) return;
    let active = true;
    const acquired = assets.acquire(key);
    void acquired.value.then(asset => {
      if (active) setLoaded({ key, asset });
    }).catch(() => { if (active) setLoaded(null); });
    return () => { active = false; acquired.release(); };
  }, [key]);
  return loaded && loaded.key === key ? loaded.asset : null;
}

export function usePixelSkinPackSummary(id: PixelTerminalBorderSkinId | null): PixelSkinPackSummary | null {
  const source = useSyncExternalStore(duoWorkspace.subscribe, skinSource);
  const [summary, setSummary] = useState<PixelSkinPackSummary | null>(null);
  useEffect(() => {
    setSummary(null);
    if (!id) return;
    let active = true;
    void window.canvasTTY.pixelSkins.list().then((items) => {
      if (active) setSummary(items.find((item) => item.id === id) ?? null);
    }).catch(() => {
      if (active) setSummary(null);
    });
    return () => { active = false; };
  }, [id, source]);
  return summary;
}
