/** Provider ids, labels and launcher order. Kept free of imports and other data so small
 * bundles, such as the Even G2 companion, can use it without the rest of the contracts. */
export type ProviderId = "terminal" | "codex" | "claude" | "qwen" | "kimi" | "opencode" | "hermes" | "grok" | "omp" | "pi" | "cursor" | "minimax" | "devin" | "antigravity";
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  terminal: "Terminal", codex: "Codex", claude: "Claude", qwen: "Qwen Code",
  kimi: "Kimi", opencode: "OpenCode", hermes: "Hermes", grok: "Grok Build",
  omp: "OMP", pi: "Pi", cursor: "Cursor", minimax: "MiniMax Code",
  devin: "Devin", antigravity: "Antigravity",
};
export type CanvasLauncherItemId = ProviderId;

export const CANVAS_LAUNCHER_ITEMS: readonly CanvasLauncherItemId[] = [
  "codex",
  "claude",
  "qwen",
  "kimi",
  "opencode",
  "hermes",
  "grok",
  "omp",
  "pi",
  "cursor",
  "minimax",
  "devin",
  "antigravity",
  "terminal"
];
