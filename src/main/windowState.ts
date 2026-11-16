import type { WindowState } from "../shared/contracts";

export interface WindowStateSource {
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isVisible?(): boolean;
  isMinimized?(): boolean;
}

export type WindowStateEvent = "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen" | "show" | "hide" | "minimize" | "restore";

export interface WindowStateObservable extends WindowStateSource {
  on(event: WindowStateEvent, listener: () => void): void;
  off(event: WindowStateEvent, listener: () => void): void;
}

export function readWindowState(
  window: WindowStateSource | null,
  platform: NodeJS.Platform = process.platform
): WindowState {
  return {
    isMacOS: platform === "darwin",
    maximized: window?.isMaximized() ?? false,
    fullscreen: window?.isFullScreen() ?? false,
    ...(window?.isVisible ? { visible: window.isVisible() && !window.isMinimized?.() } : {})
  };
}

export function observeWindowState(
  window: WindowStateObservable,
  publish: (state: WindowState) => void,
  platform: NodeJS.Platform = process.platform
): () => void {
  const notify = (): void => publish(readWindowState(window, platform));
  const events: WindowStateEvent[] = ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "show", "hide", "minimize", "restore"];
  for (const event of events) window.on(event, notify);
  return () => {
    for (const event of events) window.off(event, notify);
  };
}

export function createWindowStateObserver<TWindow extends WindowStateObservable>(
  publish: (window: TWindow, state: WindowState) => void,
  platform: NodeJS.Platform = process.platform
): (window: TWindow | null) => void {
  let observedWindow: TWindow | null = null;
  let stopObserving: (() => void) | null = null;

  return (window) => {
    if (observedWindow === window) return;
    stopObserving?.();
    stopObserving = null;
    observedWindow = window;
    if (window) stopObserving = observeWindowState(window, (state) => publish(window, state), platform);
  };
}
