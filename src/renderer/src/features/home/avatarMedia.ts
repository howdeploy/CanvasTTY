import type { WallpaperSummary } from "../../../../shared/contracts";
import { DEFAULT_WALLPAPER_RECIPE } from "../../../../shared/wallpaper";
import { decodeSkinMedia } from "../skins/decodeSkinMedia";

const MAX_HOME_IMAGE_BYTES = 20 * 1024 * 1024;
const HOME_IMAGE_SIZES = {
  avatar: { width: 512, height: 512 },
  clock: { width: 1440, height: 810 }
};

/** Copy direct Home selections into the same persistent library as workshop assets. */
export async function installAvatarSelection(selection: { path: string; dataUrl: string }): Promise<WallpaperSummary> {
  const match = selection.dataUrl.match(/^data:image\/(gif|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || match[2].length > Math.ceil(MAX_HOME_IMAGE_BYTES / 3) * 4) throw new Error("Choose GIF, PNG or WebP up to 20 MiB.");
  const binary = atob(match[2]);
  return installHomeImage(selection.path, Uint8Array.from(binary, value => value.charCodeAt(0)), "avatar");
}

export async function installClockBackground(file: File): Promise<WallpaperSummary> {
  if (file.size > MAX_HOME_IMAGE_BYTES) throw new Error("Image is over 20 MiB.");
  return installHomeImage(file.name, new Uint8Array(await file.arrayBuffer()), "clock");
}

async function installHomeImage(path: string, bytes: Uint8Array, target: keyof typeof HOME_IMAGE_SIZES): Promise<WallpaperSummary> {
  if (bytes.byteLength > MAX_HOME_IMAGE_BYTES) throw new Error("Image is over 20 MiB.");
  const decoded = await decodeSkinMedia(bytes);
  if (!["gif", "png", "webp"].includes(decoded.media.format)) throw new Error("Choose GIF, PNG or WebP.");
  const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "").slice(0, 90) || (target === "avatar" ? "Avatar" : "Clock");
  return window.canvasTTY.wallpapers.install({ name, bytes: decoded.bytes, width: decoded.width, height: decoded.height,
    recipe: { ...DEFAULT_WALLPAPER_RECIPE, ...HOME_IMAGE_SIZES[target], fit: "cover" } });
}
