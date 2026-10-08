import { useEffect, useRef } from "react";

/** Runs a single timeout loop while this view is active and the app is visible. */
export function useVisibleRefresh(refresh: () => void, intervalMs: number, active = true): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!active) return;
    let timer: number | null = null;
    const stop = (): void => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const tick = (): void => {
      if (!document.hidden) refreshRef.current();
    };
    const start = (): void => {
      if (timer !== null || document.hidden) return;
      timer = window.setInterval(tick, intervalMs);
    };
    const onVisibilityChange = (): void => {
      if (document.hidden) stop();
      else { tick(); start(); }
    };
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, intervalMs]);
}

let clockNow = Date.now();
let clockTimer: number | null = null;
const clockListeners = new Set<() => void>();

function publishClock(): void {
  clockNow = Date.now();
  for (const listener of clockListeners) listener();
}

function startClock(): void {
  if (clockTimer === null && !document.hidden && clockListeners.size > 0) {
    clockTimer = window.setInterval(publishClock, 1_000);
  }
}

function stopClock(): void {
  if (clockTimer === null) return;
  window.clearInterval(clockTimer);
  clockTimer = null;
}

function clockVisibilityChanged(): void {
  if (document.hidden) stopClock();
  else {
    publishClock();
    startClock();
  }
}

/** One visible, shared clock for every task summary instead of one interval per card. */
export function subscribeToWorkspaceClock(listener: () => void): () => void {
  const firstSubscriber=clockListeners.size===0;
  clockListeners.add(listener);
  if (firstSubscriber) {
    document.addEventListener("visibilitychange", clockVisibilityChanged);
    if(!document.hidden)publishClock();
  }
  startClock();
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      stopClock();
      document.removeEventListener("visibilitychange", clockVisibilityChanged);
    }
  };
}

export function workspaceClockNow(): number { return clockNow; }
