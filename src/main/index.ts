import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { IPC } from "../shared/contracts";
import { registerIpc } from "./ipc/registerIpc";
import { SettingsStore } from "./services/SettingsStore";
import { TerminalManager } from "./services/TerminalManager";
import { LimitsService } from "./services/LimitsService";

let mainWindow: BrowserWindow | null = null;
let terminalManager: TerminalManager | null = null;
let limitsService: LimitsService | null = null;

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 920,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: "#aaa7a2",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl && url !== currentUrl) event.preventDefault();
  });

  window.once("ready-to-show", () => window.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

app.whenReady().then(async () => {
  const settings = new SettingsStore(app.getPath("userData"), app.getLocale());
  await settings.load();

  terminalManager = new TerminalManager((channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  });
  limitsService = new LimitsService();
  registerIpc({ settings, terminals: terminalManager, limits: limitsService });

  mainWindow = await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createWindow();
  });
});

app.on("before-quit", () => {
  limitsService?.dispose();
  terminalManager?.disposeAll();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Keep shared event names in the main bundle so accidental channel drift fails at build time.
void IPC.terminalData;
