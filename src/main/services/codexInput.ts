// Every nonempty suggestion needs native placeholder styling, including exact matches.
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
  // Transcript prose can quote startup text. Standalone startup rows in the
  // current composer block, including the model banner above it, still gate input.
  const lines = screen.split("\n");
  let index = lines.length - 1;
  while (index >= 0 && !/^\s*›/.test(lines[index])) index--;
  if (index < 0) return false;
  const prompt = lines[index].match(/^\s*›\s*(.*?)\s*$/)!;
  let previous = index - 1;
  while (previous >= 0 && !/^\s*›/.test(lines[previous])) previous--;
  let answerIndent: number | null = null;
  for (const line of lines.slice(previous + 1, index)) {
    // Live MCP progress has a structured counter, even after an earlier answer.
    if (/^\s*(?:[•◦*]\s*)?(?:Starting|Booting)\s+MCP\s+servers?\s*\(\d+\/\d+\)/i.test(line)) return false;
    const bullet = line.match(/^(\s*)[•◦*]\s+/);
    if (previous >= 0 && bullet) { answerIndent = bullet[1].length; continue; }
    // Codex indents wrapped lines and paragraphs under the answer's bullet.
    if (answerIndent !== null && /^\s*\S/.test(line)
      && line.match(/^\s*/u)![0].length > answerIndent && !/^\s*[│|]/.test(line)) continue;
    if (line.trim()) answerIndent = null;
    if (/^\s*(?:[•◦*│|]\s*)?(?:(?:Starting|Booting)\s+MCP\b|model:\s*loading\b|Do you trust the contents\b|Press enter to confirm\b|Update Model Permissions\b)/i.test(line)) return false;
  }
  if (/Do you trust the contents|Press enter to confirm|Update Model Permissions|model:\s+loading|(?:Starting|Booting)\s+MCP\b/i.test(lines.slice(index).join("\n"))) return false;
  // Only native dim placeholder cells may contain disposable animation. Never
  // erase Braille from a person's draft and turn it into a blank composer.
  const text = dimPlaceholder ? prompt[1].replace(/[\u2800-\u28ff]/g, " ").trim() : prompt[1];
  if (EMPTY_COMPOSER_PLACEHOLDERS.has(text)) return text.length === 0 || dimPlaceholder;
  return dimPlaceholder && text.length > 0
    && [...EMPTY_COMPOSER_PLACEHOLDERS].some((placeholder) => placeholder.startsWith(text));
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
