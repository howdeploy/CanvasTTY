import {
  app,
  screen,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "node:path";
import { IPC } from "../../shared/contracts.ts";
import { validateDesktopViewport } from "../../shared/desktopWindows.ts";
import { DesktopWindowService } from "../services/DesktopWindowService.ts";
import type { PluginManager } from "../services/PluginManager.ts";
import type { SettingsStore } from "../services/SettingsStore.ts";
import type { IpcRegistrar } from "./IpcReadinessGate.ts";

export function registerDesktopWindowIpc(
  ipc: IpcRegistrar,
  plugins: PluginManager,
  settings: SettingsStore,
  getWindow: () => BrowserWindow | null,
  assertSender: (event: IpcMainInvokeEvent) => void,
  helperPath?: string,
): void {
  let service: DesktopWindowService | null = null;
  let ownerWindow: BrowserWindow | null = null;
  let closing = false;
  const getService = (): DesktopWindowService => {
    if (service) return service;
    const window = getWindow();
    if (!window) throw new Error("Canvas window is unavailable.");
    ownerWindow = window;
    service = new DesktopWindowService(
      helperPath ??
        (app.isPackaged
          ? join(process.resourcesPath, "desktop-apps", "window-host.ps1")
          : join(
              app.getAppPath(),
              "native",
              "desktop-apps",
              "window-host.ps1",
            )),
      () => window.getNativeWindowHandle().readBigUInt64LE().toString(),
    );
    const stop = async (): Promise<void> => {
      const current = service;
      service = null;
      await current?.dispose();
    };
    window.webContents.on("render-process-gone", () => {
      void stop();
    });
    window.webContents.on(
      "did-start-navigation",
      (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) void stop();
      },
    );
    window.on("close", (event) => {
      if (!service || closing) return;
      event.preventDefault();
      closing = true;
      void stop().finally(() => {
        if (!window.isDestroyed()) window.close();
      });
    });
    return service;
  };
  ipc.handle(
    IPC.pluginsDesktopWindows,
    async (
      event,
      pluginId: string,
      instanceId: string,
      action: string,
      value: unknown,
    ) => {
      assertSender(event);
      if (process.platform !== "win32")
        throw new Error(
          "Native desktop embedding is available on Windows only.",
        );
      if (
        typeof pluginId !== "string" ||
        typeof instanceId !== "string" ||
        instanceId.length > 200
      )
        throw new Error("Invalid desktop card identity.");
      const owner = `${pluginId}/${instanceId}`;
      // Detach remains available during disable/removal so cleanup cannot be blocked by revoked permission.
      if (action === "detach") {
        await service?.detach(owner);
        return null;
      }
      plugins.assertPermission(pluginId, "desktop:embed");
      const card = settings
        .get()
        .pluginCanvas.find(
          (entry) => entry.id === instanceId && entry.pluginId === pluginId,
        );
      if (
        !card ||
        plugins.contribution(pluginId, card.contributionId).kind !==
          "canvas-app"
      )
        throw new Error(
          "Desktop embedding requires an active canvas app card.",
        );
      const native = getService();
      if (action === "list") return native.list(owner);
      if (action === "attach") {
        if (typeof value !== "string" || value.length > 80)
          throw new Error("Invalid window selection.");
        await native.attach(owner, value);
        try {
          plugins.assertPermission(pluginId, "desktop:embed");
          if (!settings.get().pluginCanvas.some((entry) => entry.id === instanceId && entry.pluginId === pluginId)) throw new Error("Desktop card was closed during attachment.");
        } catch (error) {
          await native.detach(owner);
          throw error;
        }
        return null;
      }
      if (action === "update") {
        const viewport = validateDesktopViewport(value);
        const window = ownerWindow;
        if (!window || window.isDestroyed())
          throw new Error("Canvas window is unavailable.");
        const scale =
          screen.getDisplayMatching(window.getBounds()).scaleFactor *
          window.webContents.getZoomFactor();
        const bounds = window.getContentBounds();
        const visible =
          viewport.visible &&
          window.isVisible() &&
          !window.isMinimized() &&
          viewport.x >= 0 &&
          viewport.y >= 0 &&
          viewport.x + viewport.width <= bounds.width &&
          viewport.y + viewport.height <= bounds.height;
        await native.update(owner, {
          x: Math.round(viewport.x * scale),
          y: Math.round(viewport.y * scale),
          width: Math.round(viewport.width * scale),
          height: Math.round(viewport.height * scale),
          visible,
        });
        return null;
      }
      throw new Error("Unknown desktop window action.");
    },
  );
}
