import { app, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { IPC } from "../../shared/contracts.ts";
import { validateDesktopViewport } from "../../shared/desktopWindows.ts";
import { LinuxDesktopWindowService } from "../services/LinuxDesktopWindowService.ts";
import { clipBrowserViewportBounds, normalizeBrowserViewportBounds } from "../services/browser/BrowserViewport.ts";
import type { PluginManager } from "../services/PluginManager.ts";
import type { SettingsStore } from "../services/SettingsStore.ts";
import type { IpcRegistrar } from "./IpcReadinessGate.ts";

export function registerLinuxDesktopWindowIpc(
  ipc: IpcRegistrar,
  plugins: PluginManager,
  settings: SettingsStore,
  getWindow: () => BrowserWindow | null,
  assertSender: (event: IpcMainInvokeEvent) => void,
): void {
  let service: LinuxDesktopWindowService | null = null;
  let ownerWindow: BrowserWindow | null = null;
  let stopping: Promise<void> | null = null;
  let closing = false;
  let closeRequested = false;
  const stop = async (): Promise<void> => {
    if (stopping) return stopping;
    const current = service;
    service = null;
    stopping = current?.dispose() ?? Promise.resolve();
    try { await stopping; } finally { stopping = null; }
  };
  const quit = (): void => { void stop().finally(() => app.quit()); };
  process.once("SIGTERM", quit);
  process.once("SIGINT", quit);
  const getService = (): LinuxDesktopWindowService => {
    if (stopping) throw new Error("Desktop windows are being restored. Try again when restoration finishes.");
    if (service) return service;
    const window = getWindow();
    if (!window || window.isDestroyed()) throw new Error("Canvas window is unavailable.");
    const newOwner = ownerWindow !== window;
    ownerWindow = window;
    service = new LinuxDesktopWindowService(
      app.isPackaged ? join(process.resourcesPath, "desktop-apps-linux", "window-host.py")
        : join(app.getAppPath(), "native", "desktop-apps-linux", "window-host.py"),
      () => {
        const handle = window.getNativeWindowHandle();
        return handle.length >= 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
      },
      (owner) => {
        const card = settings.get().pluginCanvas.find(entry => `${entry.pluginId}/${entry.id}` === owner);
        if (!card || window.isDestroyed() || window.webContents.isDestroyed()) return;
        try { plugins.assertPermission(card.pluginId, "desktop:embed"); } catch { return; }
        window.webContents.send(IPC.pluginsDesktopWindowFocus, { pluginId: card.pluginId, instanceId: card.id });
      },
    );
    if (newOwner) {
      closing = false;
      closeRequested = false;
      window.webContents.on("render-process-gone", () => { void stop(); });
      window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) void stop();
      });
      window.on("close", (event) => {
        if (closing || (!service && !stopping)) return;
        event.preventDefault();
        if (closeRequested) return;
        closeRequested = true;
        void stop().finally(() => {
          closing = true;
          if (!window.isDestroyed()) window.close();
        });
      });
    }
    return service;
  };
  ipc.handle(IPC.pluginsDesktopWindows, async (event, pluginId: string, instanceId: string, action: string, value: unknown) => {
    assertSender(event);
    if (typeof pluginId !== "string" || typeof instanceId !== "string" || instanceId.length > 200) throw new Error("Invalid desktop card identity.");
    const owner = `${pluginId}/${instanceId}`;
    if (action === "detach") { await service?.detach(owner); return null; }
    plugins.assertPermission(pluginId, "desktop:embed");
    const card = settings.get().pluginCanvas.find(entry => entry.id === instanceId && entry.pluginId === pluginId);
    if (!card || plugins.contribution(pluginId, card.contributionId).kind !== "canvas-app") {
      throw new Error("Desktop embedding requires an active canvas app card.");
    }
    const native = getService();
    if (action === "list") return native.list(owner);
    if (action === "attach") {
      if (typeof value !== "string" || value.length > 80) throw new Error("Invalid window selection.");
      await native.attach(owner, value);
      try {
        plugins.assertPermission(pluginId, "desktop:embed");
        if (!settings.get().pluginCanvas.some(entry => entry.id === instanceId && entry.pluginId === pluginId)) throw new Error("Desktop card was closed during attachment.");
      } catch (error) {
        await native.detach(owner);
        throw error;
      }
      return null;
    }
    if (action === "update") {
      const viewport = validateDesktopViewport(value);
      const window = ownerWindow;
      if (!window || window.isDestroyed()) throw new Error("Canvas window is unavailable.");
      const { referenceWidth, referenceHeight, clipBounds, occlusions } = viewport as typeof viewport & {
        referenceWidth?: unknown; referenceHeight?: unknown; clipBounds?: unknown; occlusions?: unknown;
      };
      if (typeof referenceWidth !== "number" || !Number.isFinite(referenceWidth) || referenceWidth < 1 || referenceWidth > 32768
        || typeof referenceHeight !== "number" || !Number.isFinite(referenceHeight) || referenceHeight < 1 || referenceHeight > 32768) {
        throw new Error("Invalid Linux viewport reference size.");
      }
      const bounds = normalizeBrowserViewportBounds({ x: viewport.x, y: viewport.y,
        width: viewport.width, height: viewport.height, surface: "native", clipBounds });
      if (!bounds) throw new Error("Invalid Linux viewport clipping bounds.");
      const clip = clipBrowserViewportBounds(bounds, { width: referenceWidth, height: referenceHeight });
      if (!Array.isArray(occlusions) || occlusions.length > 256) throw new Error("Invalid Linux desktop occlusions.");
      const nativeOcclusions = occlusions.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Linux desktop occlusion.");
        const rectangle = normalizeBrowserViewportBounds({ ...entry, surface: "native" });
        if (!rectangle) throw new Error("Invalid Linux desktop occlusion.");
        const clipped = clipBrowserViewportBounds(rectangle, { width: referenceWidth, height: referenceHeight });
        return clipped ? [clipped] : [];
      });
      const visible = viewport.visible && window.isVisible() && !window.isMinimized() && clip !== null;
      await native.update(owner, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        referenceWidth, referenceHeight, clipBounds: clip ?? { x: 0, y: 0, width: 0, height: 0 }, occlusions: nativeOcclusions, visible });
      return null;
    }
    throw new Error("Unknown desktop window action.");
  });
}
