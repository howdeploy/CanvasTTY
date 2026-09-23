import electronUpdater, { type AppUpdater } from "electron-updater";
import type { AvailableUpdate, UpdateAdapter } from "./UpdateController.ts";

export class ElectronUpdaterAdapter implements UpdateAdapter {
  private readonly updater: AppUpdater;
  private checked: AvailableUpdate | null = null;
  private downloaded = false;

  constructor() {
    this.updater = electronUpdater.autoUpdater;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
  }

  async check(): Promise<AvailableUpdate | null> {
    const result = await this.updater.checkForUpdates();
    const info = result?.updateInfo;
    if (!info || info.version.includes("-")) return null;
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
    let failure: Error | null = null;
    const onError = (error: Error): void => { failure = error; };
    this.updater.on("error", onError);
    try {
      this.updater.quitAndInstall(false, true);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (failure) throw failure;
    } finally { this.updater.removeListener("error", onError); }
  }
}
