import { app, type BrowserWindow } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { NativeScrollPhase } from "./BrowserHistoryGesture.ts";

interface GestureMonitor {
  start(handle: Buffer, callback: (phase: NativeScrollPhase) => void): () => void;
}

export function observeBrowserHistoryGestures(owner: BrowserWindow, listener: (phase: NativeScrollPhase) => void): (() => void) | null {
  if (process.platform !== "darwin" || typeof owner.getNativeWindowHandle !== "function") return null;
  const require = createRequire(join(app.getAppPath(), "package.json"));
  const path = app.isPackaged
    ? join(process.resourcesPath, "browser-gestures/browser-gestures.node")
    : join(app.getAppPath(), "build/browser-gestures", `darwin-${process.arch}`, "browser-gestures.node");
  const monitor: GestureMonitor = require(path);
  return monitor.start(owner.getNativeWindowHandle(), listener);
}
