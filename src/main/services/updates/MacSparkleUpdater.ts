import { chmod, mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { isNewStableVersion, type AvailableUpdate, type UpdateAdapter } from "./UpdateController.ts";

interface ReleaseAsset { name: string; browser_download_url: string; size: number }
interface Release { tag_name: string; body: string | null; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

const RELEASE_API = "https://api.github.com/repos/howdeploy/CanvasTTY/releases/latest";
const MAX_ARCHIVE_SIZE = 2 * 1024 * 1024 * 1024;
const INSTALL_CACHE_GRACE_MS = 20 * 60_000;

function validAsset(asset: ReleaseAsset | undefined): asset is ReleaseAsset {
  if (!asset || typeof asset.browser_download_url !== "string" || !Number.isSafeInteger(asset.size) || asset.size <= 0) return false;
  try {
    const url = new URL(asset.browser_download_url);
    return url.protocol === "https:" && url.hostname === "github.com" &&
      url.pathname.startsWith("/howdeploy/CanvasTTY/releases/download/");
  } catch { return false; }
}

async function getRelease(): Promise<Release> {
  const response = await fetch(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "CanvasTTY-updater" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Release check failed (${response.status})`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("Invalid release response");
  const release = value as Partial<Release>;
  if (typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
      typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean" ||
      !Array.isArray(release.assets)) throw new Error("Invalid release response");
  return release as Release;
}

export class MacSparkleUpdater implements UpdateAdapter {
  private readonly userDataPath: string;
  private readonly appPath: string;
  private readonly helperPath: string;
  private readonly serverPath: string;
  private readonly currentVersion: string;
  private selected: { version: string; archive: ReleaseAsset; appcast: Buffer } | null = null;
  private cached: { archivePath: string; appcastPath: string } | null = null;

  constructor(userDataPath: string, appPath: string, helperPath: string, serverPath: string, currentVersion: string) {
    this.userDataPath = userDataPath;
    this.appPath = appPath;
    this.helperPath = helperPath;
    this.serverPath = serverPath;
    this.currentVersion = currentVersion;
  }

  async check(): Promise<AvailableUpdate | null> {
    await this.cleanupCache();
    const release = await getRelease();
    if (release.draft || release.prerelease) return null;
    const version = release.tag_name.slice(1);
    if (!isNewStableVersion(version, this.currentVersion)) return null;
    const archive = release.assets.find(asset => asset.name === `CanvasTTY-${version}-mac-arm64.zip`);
    const appcast = release.assets.find(asset => asset.name === "appcast.xml");
    if (!validAsset(archive) || !validAsset(appcast) || archive.size > MAX_ARCHIVE_SIZE || appcast.size > 2_000_000) {
      throw new Error("Mac update files are missing or invalid");
    }
    const feedResponse = await fetch(appcast.browser_download_url, { signal: AbortSignal.timeout(30_000) });
    if (!feedResponse.ok) throw new Error(`Appcast download failed (${feedResponse.status})`);
    const pinnedFeed = Buffer.from(await feedResponse.arrayBuffer());
    if (pinnedFeed.length !== appcast.size) throw new Error("Appcast size mismatch");
    const root = join(this.userDataPath, "updates");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const probeDirectory = await mkdtemp(join(root, "mac-probe-"));
    try {
      const probePath = join(probeDirectory, "appcast.xml");
      await writeFile(probePath, pinnedFeed, { mode: 0o600, flag: "wx" });
      if (!await this.probeSignedFeed(probePath, version)) return null;
    } finally { await rm(probeDirectory, { recursive: true, force: true }); }
    this.selected = { version, archive, appcast: pinnedFeed };
    this.cached = null;
    return { version, ...(typeof release.body === "string" ? { notes: release.body.slice(0, 10_000) } : {}) };
  }

  async download(progress: (percent?: number) => void): Promise<void> {
    if (!this.selected) throw new Error("No selected Mac release");
    const selected = this.selected;
    const root = join(this.userDataPath, "updates");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, "mac-"));
    await chmod(directory, 0o700);
    const archivePath = join(directory, "update.zip");
    const appcastPath = join(directory, "appcast.xml");
    const partPath = archivePath + ".part";
    try {
      await writeFile(appcastPath, selected.appcast, { mode: 0o600, flag: "wx" });
      const response = await fetch(selected.archive.browser_download_url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Update download failed (${response.status})`);
      const file = await open(partPath, "wx", 0o600);
      let received = 0;
      try {
        for await (const chunk of response.body) {
          const data = Buffer.from(chunk);
          received += data.length;
          if (received > MAX_ARCHIVE_SIZE) throw new Error("Update archive is too large");
          let offset = 0;
          while (offset < data.length) {
            const result = await file.write(data, offset, data.length - offset);
            if (result.bytesWritten <= 0) throw new Error("Update cache write failed");
            offset += result.bytesWritten;
          }
          progress(Math.min(100, (received / selected.archive.size) * 100));
        }
        await file.sync();
      } finally { await file.close(); }
      if (received !== selected.archive.size) throw new Error("Update archive size mismatch");
      await rename(partPath, archivePath);
      this.cached = { archivePath, appcastPath };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async install(): Promise<void> {
    if (!this.selected || !this.cached) throw new Error("No cached Mac update");
    const selected = this.selected;
    const cached = this.cached;
    const archiveSize = (await stat(cached.archivePath)).size;
    if (archiveSize !== selected.archive.size) throw new Error("Cached archive is incomplete");
    const marker = join(dirname(cached.archivePath), "installing");
    await writeFile(marker, "", { mode: 0o600, flag: "wx" });
    try {
      await this.runSparkle(cached.appcastPath, cached.archivePath, selected.version, false);
    } catch (error) {
      await rm(marker, { force: true });
      throw error;
    }
  }

  private async cleanupCache(): Promise<void> {
    const root = join(this.userDataPath, "updates");
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("mac-") || entry.name.startsWith("mac-probe-")) continue;
      const directory = join(root, entry.name);
      let protectedUntil = 0;
      try { protectedUntil = (await stat(join(directory, "installing"))).mtimeMs + INSTALL_CACHE_GRACE_MS; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (Date.now() >= protectedUntil) await rm(directory, { recursive: true, force: true });
    }
  }

  async probeSignedFeed(appcastPath: string, version: string): Promise<boolean> {
    const output = await this.runSparkle(appcastPath, "-", version, true);
    if (output.includes(`SPARKLE_AVAILABLE:${version}`)) return true;
    if (output.includes("SPARKLE_NO_UPDATE")) return false;
    throw new Error("Sparkle probe returned no result");
  }

  private async runSparkle(appcastPath: string, archivePath: string, version: string, probe: boolean): Promise<string> {
    const child = spawn(process.execPath, [this.serverPath, this.helperPath, this.appPath,
      appcastPath, archivePath, version, ...(probe ? ["probe"] : [])], {
      stdio: ["ignore", "pipe", "pipe"], detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    return new Promise<string>((resolve, reject) => {
      let output = "";
      let errorOutput = "";
      let started = false;
      const timer = setTimeout(() => {
        if (!started) { child.kill(); reject(new Error("Sparkle helper did not start")); }
      }, 15_000);
      timer.unref();
      child.stdout?.on("data", chunk => {
        output += String(chunk);
        if (!started && output.includes("SPARKLE_STARTED")) {
          started = true;
          clearTimeout(timer);
          if (!probe) {
            // Sparkle must survive Electron's quit and release the old app.
            child.unref();
            for (const pipe of [child.stdout, child.stderr]) {
              if (pipe && "unref" in pipe && typeof pipe.unref === "function") pipe.unref();
            }
          }
        }
      });
      child.stderr?.on("data", chunk => { errorOutput = (errorOutput + String(chunk)).slice(-2000); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error(errorOutput.trim() || `Sparkle install failed (${code})`));
      });
    });
  }
}
