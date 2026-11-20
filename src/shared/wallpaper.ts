import type { WallpaperId, WallpaperRecipe } from "./contracts";
export const MAX_WALLPAPER_BYTES = 80 * 1024 * 1024;
export const MAX_WALLPAPER_PACKAGE_BYTES = 113 * 1024 * 1024;
export const DEFAULT_WALLPAPER_RECIPE: WallpaperRecipe = {
  fit: "cover", x: 50, y: 50, width: 1920, height: 1080, pixelated: false, clockFont: "mono", dim: 0.35
};
export function isWallpaperId(value: unknown): value is WallpaperId {
  return typeof value === "string" && /^wallpaper:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
export function validateWallpaperDimensions(width: unknown, height: unknown): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1
    || (width as number) > 8192 || (height as number) > 8192 || (width as number) * (height as number) > 36_000_000) {
    throw new Error("Resolution must be within 8192 px per side and 36 megapixels.");
  }
}
export function validateWallpaperRecipe(value: unknown): WallpaperRecipe {
  if (!value || typeof value !== "object") throw new Error("Wallpaper settings are missing.");
  const r = value as WallpaperRecipe;
  validateWallpaperDimensions(r.width, r.height);
  if (!["contain", "cover"].includes(r.fit) || typeof r.pixelated !== "boolean"
    || !["mono", "sans", "serif", "pixel"].includes(r.clockFont)
    || !Number.isFinite(r.x) || !Number.isFinite(r.y) || r.x < 0 || r.x > 100 || r.y < 0 || r.y > 100
    || !Number.isFinite(r.dim) || r.dim < 0 || r.dim > 0.9) throw new Error("Wallpaper settings are invalid.");
  return { fit: r.fit, x: r.x, y: r.y, width: r.width, height: r.height, pixelated: r.pixelated, clockFont: r.clockFont, dim: r.dim };
}
