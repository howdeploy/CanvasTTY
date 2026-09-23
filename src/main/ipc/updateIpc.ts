import { BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from "electron";
import { IPC } from "../../shared/contracts";
import type { SettingsStore } from "../services/SettingsStore";
import type { TerminalManager } from "../services/TerminalManager";
import type { UpdateController } from "../services/updates/UpdateController";
import { terminalShutdownMessage } from "../services/updates/updateMessages";

export function registerUpdateIpc(update: UpdateController, settings: SettingsStore,
  terminals: TerminalManager, getMainWindow: () => BrowserWindow | null): void {
  let installRequested = false;
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    const window = getMainWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error("Update IPC is available only to the CanvasTTY window");
    }
  };
  update.onStatus(status => {
    const window = getMainWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(IPC.updateChanged, status);
    }
  });
  ipcMain.handle(IPC.updateStatus, event => { trusted(event); return update.status(); });
  ipcMain.handle(IPC.updateCheck, event => { trusted(event); return update.check(); });
  ipcMain.handle(IPC.updateDownload, event => { trusted(event); return update.download(); });
  ipcMain.handle(IPC.updateInstall, async event => {
    trusted(event);
    if (installRequested) throw new Error("Update installation is already in progress");
    if (update.status().type !== "ready") throw new Error("No downloaded update");
    installRequested = true;
    try {
      const live = terminals.list().filter(session => session.exitCode === null).length;
      if (live > 0) {
        const locale = settings.get().locale;
        const ru = locale === "ru";
        const window = getMainWindow();
        const options: MessageBoxOptions = {
          type: "warning",
          title: ru ? "Установить обновление?" : "Install update?",
          message: terminalShutdownMessage(live, locale),
          buttons: ru ? ["Отмена", "Установить и перезапустить"] : ["Cancel", "Install and restart"],
          cancelId: 0,
          defaultId: 0
        };
        const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
        if (result.response !== 1) return;
      }
      // Preserve restorable session descriptors and stop PTYs before an installer
      // can replace files or relaunch the application.
      const restore = await terminals.shutdownForUpdate();
      try {
        await update.install();
      } catch (error) {
        await restore().catch(restoreError => {
          console.error("Terminal sessions could not be restored after a failed update.", restoreError);
        });
        throw error;
      }
    } finally {
      installRequested = false;
    }
  });
}
