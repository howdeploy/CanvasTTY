import type { AppSettings } from "./contracts";
export type WorkspacePresetLayout = Pick<AppSettings, "stickyNotes" | "fileCards" | "pluginCanvas" | "canvasRegions" | "browserCanvas"> & { browserUrls: string[] };

export interface WorkspacePresetSummary {
  id: string;
  name: string;
  updatedAt: number;
  sessions: number;
  titles: string[];
  surfaces: number;
  browserTabs: number;
}

export interface WorkspacePresetRestoreResult {
  name: string;
  surfaces?: { added: number; browserTabsOpened: number; failures: string[] };
  cards: Array<{ id: string; title: string; state: "existing" | "opened" | "stopped"; detail?: string }>;
}
