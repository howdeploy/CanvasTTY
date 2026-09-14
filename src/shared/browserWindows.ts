import type { AppSettings, BrowserCanvasEntry } from "./contracts.ts";

export function browserCanvasEntries(settings: Pick<AppSettings, "browserCanvas" | "browserCanvases">): BrowserCanvasEntry[] {
  return settings.browserCanvases ?? (settings.browserCanvas ? [{ id: "default", ...settings.browserCanvas }] : []);
}

export function browserCanvasPatch(entries: BrowserCanvasEntry[]): Pick<AppSettings, "browserCanvas" | "browserCanvases"> {
  const legacy = entries.find((entry) => entry.id === "default");
  return { browserCanvases: entries, browserCanvas: legacy ? { position: legacy.position, size: legacy.size } : null };
}
