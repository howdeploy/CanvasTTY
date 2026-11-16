import type { AppSettings } from "../../shared/contracts.ts";
import type { WorkspacePresetLayout } from "../../shared/workspacePresets.ts";
import { SettingsStore, normalizeSettings } from "./SettingsStore.ts";
const empty = (): WorkspacePresetLayout => ({ stickyNotes: [], fileCards: [], pluginCanvas: [], canvasRegions: [], browserCanvas: null, browserUrls: [] });
/** Reuse the same bounds, root-reference and card validators as ordinary settings. */
export function normalizePresetLayout(value: unknown): WorkspacePresetLayout {
  if (value === undefined) return empty();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace layout.");
  const source = value as WorkspacePresetLayout;
  for (const name of ["stickyNotes", "fileCards", "pluginCanvas", "canvasRegions", "browserUrls"] as const) {
    if (!Array.isArray(source[name]) || source[name].length > 200) throw new Error("Invalid workspace layout.");
  }
  const defaults = new SettingsStore(".", "en").get();
  const settings = normalizeSettings(source, defaults);
  for (const name of ["stickyNotes", "fileCards", "pluginCanvas", "canvasRegions"] as const) {
    if (settings[name].length !== source[name].length) throw new Error("Invalid saved workspace card.");
  }
  const browserUrls = source.browserUrls.map(value => {
    if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid saved browser URL.");
    const url = new URL(value);
    if (!["http:", "https:", "about:"].includes(url.protocol) || (url.protocol === "about:" && url.href !== "about:blank") || url.username || url.password) throw new Error("Unsupported saved browser URL.");
    return url.href;
  });
  return { stickyNotes: settings.stickyNotes, fileCards: settings.fileCards, pluginCanvas: settings.pluginCanvas,
    canvasRegions: settings.canvasRegions, browserCanvas: settings.browserCanvas, browserUrls: [...new Set(browserUrls)] };
}
export function capturePresetLayout(settings: AppSettings, browserUrls: string[]): WorkspacePresetLayout {
  // Non-web tabs and URL-embedded credentials are deliberately excluded from automatic reopening.
  const urls = browserUrls.filter(value => { try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; } });
  return normalizePresetLayout({ stickyNotes: settings.stickyNotes, fileCards: settings.fileCards, pluginCanvas: settings.pluginCanvas,
    canvasRegions: settings.canvasRegions, browserCanvas: settings.browserCanvas, browserUrls: urls });
}
export function mergePresetLayout(current: AppSettings, saved: WorkspacePresetLayout): { patch: Partial<AppSettings>; added: number } {
  let added = 0;
  const merge = <T extends { id: string }>(current: T[], saved: T[]): T[] => {
    const ids = new Set(current.map(c => c.id)); const missing = saved.filter(c => !ids.has(c.id)); added += missing.length;
    return [...current, ...missing];
  };
  const patch: Partial<AppSettings> = {
      stickyNotes: merge(current.stickyNotes, saved.stickyNotes), fileCards: merge(current.fileCards, saved.fileCards),
      pluginCanvas: merge(current.pluginCanvas, saved.pluginCanvas), canvasRegions: merge(current.canvasRegions, saved.canvasRegions),
      browserCanvas: current.browserCanvas ?? saved.browserCanvas
  };
  const normalized = normalizeSettings({ ...current, ...patch }, current);
  for (const name of ["stickyNotes", "fileCards", "pluginCanvas", "canvasRegions"] as const) {
    if (normalized[name].length !== patch[name]!.length) throw new Error(`Workspace would exceed the ${name} card limit. Remove cards before restoring this preset.`);
  }
  return { patch, added };
}
