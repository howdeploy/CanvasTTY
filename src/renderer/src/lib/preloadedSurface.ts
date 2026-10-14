import { useEffect, useState } from "react";

/**
 * A surface (a menu, a palette) whose code is kept out of the startup bundle but still opens at once. Its chunk is
 * loaded once, either ahead of time (`preloadWhenIdle`) or by the first open, and the loaded component is then
 * rendered directly. It is not a `React.lazy` behind `Suspense`: React holds a suspended boundary's reveal for up to
 * 300 ms, which delayed the first right-click and the first Cmd/Ctrl+K by that much.
 */
export interface PreloadedSurface<T> {
  /** Starts loading (once; a failed load is tried again next time) and settles with the loaded value. */
  load(): Promise<T>;
  /** The loaded value, or null while it has not loaded. */
  loaded(): T | null;
}

export function preloadedSurface<T>(load: () => Promise<T>): PreloadedSurface<T> {
  let value: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    load() {
      pending ??= load().then((loaded) => {
        value = loaded;
        return loaded;
      }, (error: unknown) => {
        pending = null;
        throw error;
      });
      return pending;
    },
    loaded: () => value
  };
}

/**
 * The surface's value for a render that shows it (`wanted`): the loaded one at once, or null while a load this open
 * started is still running (the caller renders nothing until it arrives, then re-renders).
 */
export function usePreloadedSurface<T>(surface: PreloadedSurface<T>, wanted: boolean): T | null {
  const [, setLoaded] = useState(0);
  const value = surface.loaded();
  useEffect(() => {
    if (!wanted || surface.loaded() !== null) return;
    let live = true;
    surface.load().then(() => {
      if (live) setLoaded((count) => count + 1);
    }, (error: unknown) => console.error("CanvasTTY could not load a menu", error));
    return () => { live = false; };
  }, [surface, wanted]);
  return wanted ? value : null;
}

/** Loads the surfaces once the app is idle after its first paint; returns a cancel for the pending start. */
export function preloadWhenIdle(surfaces: readonly PreloadedSurface<unknown>[]): () => void {
  const start = (): void => {
    for (const surface of surfaces) void surface.load().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(start, { timeout: 2_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(start, 200);
  return () => window.clearTimeout(timer);
}
