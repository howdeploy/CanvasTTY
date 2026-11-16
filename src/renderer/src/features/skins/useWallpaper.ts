import { useMemo, useSyncExternalStore } from "react";
import type { WallpaperId, WallpaperSummary } from "../../../../shared/contracts";
import { SKIN_MEDIA_MIME } from "../../../../shared/skinMedia";

export interface WallpaperAsset { summary: WallpaperSummary; src: string }
interface Entry { asset: WallpaperAsset | null; listeners: Set<() => void>; stop?: () => void; revision: number }
const cache = new Map<WallpaperId, Entry>();

/** One IPC read and object URL shared by all consumers of the selected asset.
 * The last subscriber releases the URL; late async reads cannot leak new URLs. */
export function useWallpaper(id: WallpaperId | null | undefined): WallpaperAsset | null {
  const store = useMemo(() => ({
    subscribe(listener: () => void): () => void {
      if (!id || !window.canvasTTY.wallpapers) return () => {};
      let entry = cache.get(id);
      if (!entry) {
        entry = { asset: null, listeners: new Set(), revision: 0 };
        cache.set(id, entry);
      }
      const current = entry;
      current.listeners.add(listener);
      if (!current.stop) {
        const refresh = async (): Promise<void> => {
          const revision = ++current.revision;
          try {
            const result = await window.canvasTTY.wallpapers.read(id);
            if (cache.get(id) !== current || revision !== current.revision) return;
            const previous = current.asset;
            current.asset = result ? { summary: result.summary, src: URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: SKIN_MEDIA_MIME[result.summary.media.format] })) } : null;
            for (const notify of current.listeners) notify();
            if (previous) URL.revokeObjectURL(previous.src);
          } catch { /* Preserve a loaded asset during a transient read failure. */ }
        };
        current.stop = window.canvasTTY.wallpapers.onChanged(() => void refresh());
        void refresh();
      }
      return () => {
        current.listeners.delete(listener);
        if (current.listeners.size === 0) {
          current.stop?.();
          if (current.asset) URL.revokeObjectURL(current.asset.src);
          cache.delete(id);
        }
      };
    },
    snapshot: (): WallpaperAsset | null => id ? cache.get(id)?.asset ?? null : null
  }), [id]);
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
