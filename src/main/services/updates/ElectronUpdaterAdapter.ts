import electronUpdater, { type AppUpdater } from "electron-updater";
import { app } from "electron";
import { AwaitedNsisUpdater } from "./AwaitedNsisUpdater";
import { isNewStableVersion, type AvailableUpdate, type UpdateAdapter } from "./UpdateController.ts";

export class ElectronUpdaterAdapter implements UpdateAdapter {
  private readonly updater: AppUpdater;
  private checked: AvailableUpdate | null = null;
  private downloaded = false;
  private installFailure: ((error: Error) => void) | null = null;

  constructor() {
    this.updater = process.platform === "win32" ? new AwaitedNsisUpdater() : electronUpdater.autoUpdater;
    this.updater.on("error", (error: Error) => {
      console.error("CanvasTTY updater error.", error);
      this.installFailure?.(error);
    });
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowPrerelease = false;
    // SemVer ranks hotfixes below their base; our release-order gate below prevents actual downgrades.
    this.updater.allowDowngrade = true;
  }

  async check(): Promise<AvailableUpdate | null> {
    this.checked = null;
    this.downloaded = false;
    const result = await this.updater.checkForUpdates();
    const info = result?.updateInfo;
    if (!result?.isUpdateAvailable || !info || !isNewStableVersion(info.version, app.getVersion())) return null;
    let notes = typeof info.releaseNotes === "string" ? info.releaseNotes.slice(0, 10000)
      : Array.isArray(info.releaseNotes) ? info.releaseNotes.map(entry => entry.note).filter(Boolean).join("\n\n").slice(0, 10000)
        : undefined;
    if (!notes) {
      try {
        const response = await fetch("https://api.github.com/repos/howdeploy/CanvasTTY/releases/latest", {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "CanvasTTY-updater" },
          signal: AbortSignal.timeout(15_000)
        });
        if (response.ok) {
          const release: unknown = await response.json();
          if (release && typeof release === "object") {
            const value = release as { tag_name?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown };
            if (!value.draft && !value.prerelease && value.tag_name === `v${info.version}` && typeof value.body === "string") {
              notes = value.body.slice(0, 10_000);
            }
          }
        }
      } catch { /* Release notes are optional; update availability remains usable. */ }
    }
    this.checked = { version: info.version, ...(notes ? { notes } : {}) };
    this.downloaded = false;
    return this.checked;
  }

  async download(progress: (percent?: number) => void): Promise<void> {
    if (!this.checked) throw new Error("No selected release");
    const listener = (value: { percent: number }): void => progress(value.percent);
    this.updater.on("download-progress", listener);
    try {
      await this.updater.downloadUpdate();
      this.downloaded = true;
    } finally {
      this.updater.removeListener("download-progress", listener);
    }
  }

  async install(): Promise<void> {
    if (!this.downloaded) throw new Error("Update has not been downloaded");
    if (this.updater instanceof AwaitedNsisUpdater) {
      await this.updater.installAndRestart();
      return;
    }
    // Keep observing errors until the updater actually begins quitting, not for one event-loop tick.
    let onQuit: () => void = () => undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        onQuit = resolve;
        this.installFailure = reject;
        app.once("before-quit", onQuit);
        this.updater.quitAndInstall(false, true);
      });
    } finally {
      app.removeListener("before-quit", onQuit);
      this.installFailure = null;
    }
  }
}
