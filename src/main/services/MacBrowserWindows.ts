import { BrowserWindow, app, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { BrowserService } from "./BrowserService";

/** Independent macOS browser windows reuse the same browser policy and UI as the canvas browser. */
export class MacBrowserWindows {
  private readonly windows = new Map<BrowserWindow, BrowserService>();
  private readonly closing = new Set<Promise<unknown>>();
  private pauseHiddenTabs = true;

  setPauseHiddenTabs(enabled: boolean): void {
    this.pauseHiddenTabs = enabled;
    for (const browser of this.windows.values()) browser.setPauseHiddenTabs(enabled);
  }

  forRenderer(sender: WebContents): BrowserService | null {
    for (const [window, browser] of this.windows) if (window.webContents === sender) return browser;
    return null;
  }

  forPage(sender: WebContents): BrowserService | null {
    for (const browser of this.windows.values()) if (browser.ownsPage(sender)) return browser;
    return null;
  }

  async open(url?: string): Promise<void> {
    if (process.platform !== "darwin") throw new Error("Additional browser windows are available on macOS.");
    const id = randomUUID();
    const root = join(app.getPath("userData"), "browser", "windows", id);
    const window = new BrowserWindow({
      title: "CanvasTTY Browser", width: 1100, height: 800, minWidth: 640, minHeight: 420,
      show: false, backgroundColor: "#24252b",
      webPreferences: { preload: join(__dirname, "../preload/browserWindow.cjs"), sandbox: true,
        contextIsolation: true, nodeIntegration: false }
    });
    const browser = new BrowserService(() => window.isDestroyed() ? null : window, {
      userDataPath: root, restoreTabs: false, sessionPartition: `canvastty-window-${id}`,
      pauseHiddenTabs: this.pauseHiddenTabs
    });
    this.windows.set(window, browser);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, target) => {
      if (target !== window.webContents.getURL()) event.preventDefault();
    });
    window.on("closed", () => {
      this.windows.delete(window);
      const cleanup = browser.dispose().finally(() => rm(root, { recursive: true, force: true }));
      this.closing.add(cleanup);
      void cleanup.catch((error) => console.warn("Browser window cleanup failed.", error))
        .finally(() => this.closing.delete(cleanup));
    });
    try {
      if (process.env.ELECTRON_RENDERER_URL) {
        await window.loadURL(new URL("browser-window.html", process.env.ELECTRON_RENDERER_URL).href);
      } else await window.loadFile(join(__dirname, "../renderer/browser-window.html"));
      await browser.open(url);
      window.show();
    } catch (error) {
      window.destroy();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    for (const window of this.windows.keys()) if (!window.isDestroyed()) window.destroy();
    await Promise.allSettled([...this.closing]);
  }
}
