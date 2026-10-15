// Unstyled text must match exactly; clipped prefixes also require native placeholder styling.
const EMPTY_COMPOSER_PLACEHOLDERS = new Set([
  "", "Ask Codex to do anything", "Ask a follow-up question",
  "Find and fix a bug in @filename", "Implement {feature}", "Summarize recent commits",
  "Explain this codebase", "Write tests for @filename", "Improve documentation in @filename",
  "Use /skills to list available skills", "Run /review on my current changes",
  "Check recently modified functions for compatibility", "How many files have been modified?",
  "Will this algorithm scale well?",
]);

/** The Codex task composer, shared by automated delivery and the native control API. */
export function codexComposerReady(screen: string, dimPlaceholder = false): boolean {
  if (/Do you trust the contents|Press enter to confirm|Update Model Permissions|model:\s+loading|(?:Starting|Booting)\s+MCP\b/i.test(screen)) return false;
  // Transcript prompts can equal built-in suggestions; only the bottom composer counts.
  const prompt = screen.split("\n").reverse().find((line) => /^\s*›/.test(line))?.match(/^\s*›\s*(.*?)\s*$/);
  if (!prompt) return false;
  if (EMPTY_COMPOSER_PLACEHOLDERS.has(prompt[1])) return true;
  return dimPlaceholder && prompt[1].length > 0
    && [...EMPTY_COMPOSER_PLACEHOLDERS].some((placeholder) => placeholder.startsWith(prompt[1]));
}

/** Explicit paste boundaries keep Codex's paste-burst detector from swallowing the submit key. */
export function codexPromptInput(text: string, submit = true): string {
  return `\x1b[200~${text}\x1b[201~${submit ? "\r" : ""}`;
}

/** Codex draws placeholders dim; never accept a clipped human draft as a suggestion. */
export function codexPlaceholderIsDim(terminal: import("@xterm/headless").Terminal): boolean {
  const buffer = terminal.buffer.active;
  for (let row = buffer.baseY + terminal.rows - 1; row >= buffer.baseY; row--) {
    const line = buffer.getLine(row);
    const match = line?.translateToString(true).match(/^\s*›\s*/);
    if (!line || !match) continue;
    let sawText = false;
    for (let col = match[0].length; col < line.length; col++) {
      const cell = line.getCell(col);
      if (!cell?.getChars().trim()) continue;
      if (!cell.isDim()) return false;
      sawText = true;
    }
    return sawText;
  }
  return false;
}
