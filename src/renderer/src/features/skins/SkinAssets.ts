import { useEffect, useState } from "react";
import { createReleasingCache } from "./releasingCache";
import type { PixelSkinPackSummary, PixelSkinSlot, PixelTerminalBorderSkinId } from "../../../../shared/contracts";

interface CachedImage { image: HTMLImageElement; references: number; promise: Promise<HTMLImageElement> }
const images = new Map<string, CachedImage>();

export type PixelSkinPackUrls = Readonly<Record<PixelSkinSlot, string>>;
const PACK_SLOTS: readonly PixelSkinSlot[] = [
  "minimal_idle", "minimal_working", "minimal_completed",
  "detailed_idle", "detailed_working", "detailed_completed",
  "master_idle", "master_working", "master_completed", "background"
];

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

const packs = createReleasingCache<PixelTerminalBorderSkinId, PixelSkinPackUrls>({
  load: async (id) => {
    const slots = await Promise.all(PACK_SLOTS.map(async (slot) => {
      const bytes = await window.canvasTTY.pixelSkins.readAsset(id, slot);
      if (!bytes) throw new Error(`Pixel skin asset ${slot} is unavailable.`);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return [slot, copy] as const;
    }));
    return Object.fromEntries(slots.map(([slot, bytes]) => [
      slot, URL.createObjectURL(new Blob([bytes], { type: "image/png" }))
    ])) as Record<PixelSkinSlot, string>;
  },
  dispose: (urls) => Object.values(urls).forEach((url) => URL.revokeObjectURL(url)),
  delayMs: 30_000,
  disposeLateLoads: window.canvasTTY.window.isMacOS
});

function acquirePixelSkinPack(id: PixelTerminalBorderSkinId): { urls: Promise<PixelSkinPackUrls>; release(): void } {
  const acquired = packs.acquire(id);
  return { urls: acquired.value, release: acquired.release };
}

export function usePixelSkinPackAssets(id: PixelTerminalBorderSkinId | null): PixelSkinPackUrls | null {
  const [urls, setUrls] = useState<PixelSkinPackUrls | null>(null);
  useEffect(() => {
    setUrls(null);
    if (!id) return;
    let active = true;
    const acquired = acquirePixelSkinPack(id);
    void acquired.urls.then((value) => {
      if (active) setUrls(value);
    }).catch(() => {
      if (active) setUrls(null);
    });
    return () => {
      active = false;
      acquired.release();
    };
  }, [id]);
  return urls;
}

export function usePixelSkinPackSummary(id: PixelTerminalBorderSkinId | null): PixelSkinPackSummary | null {
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
  }, [id]);
  return summary;
}
