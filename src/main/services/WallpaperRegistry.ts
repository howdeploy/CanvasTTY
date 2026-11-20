import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, lstat, rename, rm, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { WallpaperId, WallpaperInstallRequest, WallpaperSummary } from "../../shared/contracts";
import { inspectSkinMedia, SKIN_MEDIA_MIME } from "../../shared/skinMedia.ts";
import { isWallpaperId, MAX_WALLPAPER_BYTES, MAX_WALLPAPER_PACKAGE_BYTES, validateWallpaperDimensions, validateWallpaperRecipe } from "../../shared/wallpaper.ts";

export class WallpaperRegistry {
  private root: string;
  private items = new Map<WallpaperId, WallpaperSummary>();
  private events = new EventEmitter();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(userData: string) { this.root = join(userData, "wallpapers"); }
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.items.clear();
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      const id = `wallpaper:${entry.name}`;
      if (!entry.isDirectory() || !isWallpaperId(id)) continue;
      try {
        const path = join(this.root, entry.name, "wallpaper.json");
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > 16384) continue;
        const item = JSON.parse(await readFile(path, "utf8")) as WallpaperSummary;
        if (item.id !== id || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100
          || !item.media || !Object.hasOwn(SKIN_MEDIA_MIME, item.media.format) || typeof item.media.animated !== "boolean") continue;
        validateWallpaperDimensions(item.media.width, item.media.height);
        item.recipe = validateWallpaperRecipe(item.recipe);
        this.items.set(id, item);
      } catch { /* A damaged item must not hide the remaining library. */ }
    }
  }
  list(): WallpaperSummary[] { return structuredClone([...this.items.values()]); }
  onChanged(listener: () => void): () => void { this.events.on("changed", listener); return () => this.events.off("changed", listener); }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action); this.queue = run.catch(() => undefined); return run;
  }
  install(request: WallpaperInstallRequest): Promise<WallpaperSummary> {
    return this.serial(async () => {
      if (!request || !(request.bytes instanceof Uint8Array) || !request.bytes.length || request.bytes.length > MAX_WALLPAPER_BYTES) throw new Error("Media must be at most 80 MB.");
      if (this.items.size >= 100) throw new Error("Wallpaper library is full (100 items).");
      if (typeof request.name !== "string" || !request.name.trim() || request.name.length > 100) throw new Error("Enter a name of 1–100 characters.");
      const media = inspectSkinMedia(request.bytes);
      if (media.format !== "mp4" && media.format !== "webm" && request.bytes.length > 20 * 1024 * 1024) throw new Error("Images must be at most 20 MB.");
      validateWallpaperDimensions(request.width, request.height);
      if (media.format !== "mp4" && media.format !== "webm") validateWallpaperDimensions(media.width, media.height);
      if (media.width && (media.width !== request.width || media.height !== request.height)) throw new Error("Image dimensions do not match.");
      media.width = request.width; media.height = request.height;
      const recipe = validateWallpaperRecipe(request.recipe);
      const uuid = randomUUID(), id: WallpaperId = `wallpaper:${uuid}`;
      const summary: WallpaperSummary = { id, name: request.name.trim(), media, recipe };
      const temporary = join(this.root, `.import-${uuid}`);
      await mkdir(temporary);
      try {
        await writeFile(join(temporary, `media.${media.format}`), request.bytes);
        await writeFile(join(temporary, "wallpaper.json"), JSON.stringify(summary));
        await rename(temporary, join(this.root, uuid));
      } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
      this.items.set(id, summary); this.events.emit("changed");
      return structuredClone(summary);
    });
  }
  async read(id: WallpaperId): Promise<{ summary: WallpaperSummary; bytes: Uint8Array } | null> {
    if (!isWallpaperId(id)) return null;
    const summary = this.items.get(id);
    if (!summary) return null;
    const folder = join(this.root, id.slice(10));
    if (!(await lstat(folder)).isDirectory()) throw new Error("Wallpaper folder is unavailable.");
    const path = join(folder, `media.${summary.media.format}`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_WALLPAPER_BYTES) throw new Error("Wallpaper media is unavailable.");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.size > MAX_WALLPAPER_BYTES) throw new Error("Wallpaper media is unavailable.");
      bytes = await handle.readFile();
      if (bytes.length > MAX_WALLPAPER_BYTES) throw new Error("Wallpaper grew beyond the limit.");
    } finally { await handle.close(); }
    if (inspectSkinMedia(bytes).format !== summary.media.format) throw new Error("Wallpaper format changed.");
    return { summary: structuredClone(summary), bytes };
  }
  remove(id: WallpaperId): Promise<void> {
    return this.serial(async () => {
      if (!isWallpaperId(id) || !this.items.has(id)) return;
      await rm(join(this.root, id.slice(10)), { recursive: true, force: true });
      this.items.delete(id); this.events.emit("changed");
    });
  }
  async export(id: WallpaperId): Promise<Uint8Array> {
    const asset = await this.read(id);
    if (!asset) throw new Error("Wallpaper not found.");
    const { summary, bytes } = asset;
    return Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "canvastty-wallpaper", name: summary.name, recipe: summary.recipe,
      source: { file: `media.${summary.media.format}`, width: summary.media.width, height: summary.media.height, base64: Buffer.from(bytes).toString("base64") } }));
  }
  async importPackage(bytes: Uint8Array): Promise<WallpaperSummary> {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_WALLPAPER_PACKAGE_BYTES) throw new Error("Wallpaper package is too large.");
    const data = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (data?.schemaVersion !== 1 || data?.kind !== "canvastty-wallpaper" || typeof data.source?.base64 !== "string"
      || data.source.base64.length > Math.ceil(MAX_WALLPAPER_BYTES / 3) * 4
      || data.source.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data.source.base64)) throw new Error("Invalid wallpaper package.");
    const mediaBytes = Buffer.from(data.source.base64, "base64");
    if (mediaBytes.toString("base64") !== data.source.base64) throw new Error("Invalid base64 media.");
    return this.install({ name: data.name, bytes: mediaBytes, recipe: data.recipe, width: data.source.width, height: data.source.height });
  }
}
