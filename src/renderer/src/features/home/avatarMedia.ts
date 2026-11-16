import type { WallpaperSummary } from "../../../../shared/contracts";
import { DEFAULT_WALLPAPER_RECIPE } from "../../../../shared/wallpaper";
import { decodeSkinMedia } from "../skins/decodeSkinMedia";
/** Copy direct Home selections into the same persistent library as workshop assets. */
export async function installAvatarSelection(selection: { path: string; dataUrl: string }, target: "avatar" | "clock" = "avatar"): Promise<WallpaperSummary> {
  const match = selection.dataUrl.match(/^data:image\/(gif|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || match[2].length > Math.ceil(20 * 1024 * 1024 / 3) * 4) throw new Error("Avatar image: max 20 MiB.");
  const binary = atob(match[2]);
  const decoded = await decodeSkinMedia(Uint8Array.from(binary, value => value.charCodeAt(0)));
  if (!["gif", "png", "webp"].includes(decoded.media.format)) throw new Error("Choose GIF, PNG or WebP.");
  const name = selection.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "").slice(0, 90) || "Avatar";
  return window.canvasTTY.wallpapers.install({ name, bytes: decoded.bytes, width: decoded.width, height: decoded.height,
    recipe: { ...DEFAULT_WALLPAPER_RECIPE, width: target === "clock" ? 1440 : 512, height: target === "clock" ? 810 : 512, fit: "cover" } });
}
