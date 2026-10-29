import { terminalScreenText } from "./materials/sessionScreen.ts";

// Unstyled suggestions additionally require native lifecycle and input-ownership evidence.
const EMPTY_COMPOSER_PLACEHOLDERS = new Set([
  "", "Ask Codex to do anything", "Ask a follow-up question",
  "Find and fix a bug in @filename", "Implement {feature}", "Summarize recent commits",
  "Explain this codebase", "Write tests for @filename", "Improve documentation in @filename",
  "Use /skills to list available skills", "Run /review on my current changes",
  "Check recently modified functions for compatibility", "How many files have been modified?",
  "Will this algorithm scale well?",
]);

function composerIndex(lines: readonly string[]): number {
  let index = -1, indent = Infinity;
  for (let row = 0; row < lines.length; row++) {
    const match = lines[row].match(/^(\s*)›/);
    if (match && match[1].length <= indent) { index = row; indent = match[1].length; }
  }
  return index;
}

function composerRow(terminal: import("@xterm/headless").Terminal): number {
  const buffer = terminal.buffer.active;
  const index = composerIndex(Array.from({ length: terminal.rows }, (_, row) => {
    const line = buffer.getLine(buffer.baseY + row);
    return line && !line.isWrapped ? line.translateToString(true) : "";
  }));
  return index < 0 ? -1 : buffer.baseY + index;
}

/** The Codex task composer, shared by automated delivery and the native control API. */
export function codexComposerReady(screen: string, dimPlaceholder = false, emptyContinuation?: boolean): boolean {
  // Transcript prose can quote startup text. Standalone startup rows in the
  // current composer block, including the model banner above it, still gate input.
  const lines = screen.split("\n");
  const index = composerIndex(lines);
  if (index < 0) return false;
  const prompt = lines[index].match(/^\s*›\s*(.*?)\s*$/)!;
  const previous = composerIndex(lines.slice(0, index));
  const promptIndent = lines[index].match(/^\s*/u)![0].length;
  let answerIndent: number | null = null;
  for (const line of lines.slice(previous + 1, index)) {
    const bullet = line.match(/^(\s*)[•●◦*]\s+/);
    // Wrapped transcript may survive after its prompt and answer bullet scroll away.
    const indentedTranscript = !bullet && /^\s*\S/.test(line)
      && line.match(/^\s*/u)![0].length > (answerIndent ?? promptIndent) && !/^\s*[│|]/.test(line);
    const structuredProgress = /^\s*(?:Starting|Booting)\s+MCP(?:\s+servers?)?\s*\(\d+\/\d+\)(?::[^\n]*)?\s*$/i.test(line);
    if (indentedTranscript && (answerIndent !== null || !structuredProgress)) continue;
    // Live MCP progress has a structured counter, even after an earlier answer.
    if (/^\s*(?:[•●◦*]\s*)?(?:Starting|Booting)\s+MCP(?:\s+servers?)?\s*\(\d+\/\d+\)(?::[^\n]*)?\s*$/i.test(line)) return false;
    if (bullet) { answerIndent = bullet[1].length; continue; }
    if (line.trim()) answerIndent = null;
    if (/^\s*(?:[•●◦*│|]\s*)?(?:(?:Starting|Booting)\s+MCP\b|model:\s*loading\b|Do you trust the contents\b|Press enter to confirm\b|Update Model Permissions\b)/i.test(line)) return false;
  }
  if (/Do you trust the contents|Press enter to confirm|Update Model Permissions|model:\s+loading|(?:Starting|Booting)\s+MCP\b/i.test(lines.slice(index).join("\n"))) return false;
  // Only native dim placeholder cells may contain disposable animation. Never
  // erase Braille from a person's draft and turn it into a blank composer.
  const text = dimPlaceholder ? prompt[1].replace(/[\u2800-\u28ff]/g, " ").trim() : prompt[1];
  if (EMPTY_COMPOSER_PLACEHOLDERS.has(text)) return text.length === 0
    ? emptyContinuation ?? lines.slice(index + 1).every(line => !line.trim()) : dimPlaceholder;
  return dimPlaceholder && text.length > 0
    && [...EMPTY_COMPOSER_PLACEHOLDERS].some((placeholder) => placeholder.startsWith(text));
}

/** A blank first row may still own a multiline draft. Footer prose alone is
 * insufficient: native footer styling must distinguish it from typed input.
 */
export function codexContinuationIsEmpty(terminal: import("@xterm/headless").Terminal): boolean {
  const buffer = terminal.buffer.active;
  const prompt = composerRow(terminal);
  if (prompt < buffer.baseY) return false;
  for (let row = prompt + 1; row < buffer.baseY + terminal.rows; row++) {
    const line = buffer.getLine(row);
    let end = row, text = line?.translateToString(false) ?? "";
    while (end + 1 < buffer.baseY + terminal.rows && buffer.getLine(end + 1)?.isWrapped) {
      text += buffer.getLine(++end)?.translateToString(false) ?? "";
    }
    if (!text.trim()) continue;
    const footer = /^\s*(?:\? for shortcuts\b|.+\s+(?:low|medium|high|xhigh|max|ultra|default|none)\s*·\s+\S)/i.test(text);
    if (!footer || !line) return false;
    const styles = new Set<string>();
    let allDim = true;
    for (let part = row; part <= end; part++) {
      const cells = buffer.getLine(part)!;
      for (let col = 0; col < cells.length; col++) {
        const cell = cells.getCell(col);
        if (!cell?.getChars().trim()) continue;
        allDim &&= Boolean(cell.isDim());
        styles.add(`${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.isDim()}`);
      }
    }
    return allDim || styles.size > 1;
  }
  return true;
}

/** Explicit paste boundaries keep Codex's paste-burst detector from swallowing the submit key. */
export function codexPromptInput(text: string, submit = true): string {
  return `\x1b[200~${text}\x1b[201~${submit ? "\r" : ""}`;
}

/** These TUIs need explicit paste boundaries to keep task text separate from the submit key. */
export function agentPromptInput(provider: string, text: string, submit = true): string {
  return provider === "codex" || provider === "claude" || provider === "kimi"
    ? codexPromptInput(text, submit) : `${text}${submit ? "\r" : ""}`;
}

/** Codex draws placeholders dim; never accept a clipped human draft as a suggestion. */
export function codexPlaceholderIsDim(terminal: import("@xterm/headless").Terminal): boolean {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(composerRow(terminal));
  const match = line?.translateToString(true).match(/^\s*›\s*/);
  if (!line || !match) return false;
  let sawText = false;
  for (let col = match[0].length; col < line.length; col++) {
    const cell = line.getCell(col);
    if (!cell?.getChars().trim()) continue;
    if (!cell.isDim()) return false;
    sawText = true;
  }
  return sawText;
}

/** A known unstyled placeholder needs native idle, input ownership and a cursor at its start. */
export function codexTerminalComposerReady(terminal: import("@xterm/headless").Terminal, allowUnstyled = false): boolean {
  const screen = terminalScreenText(terminal, true);
  const continuation = codexContinuationIsEmpty(terminal);
  if (codexComposerReady(screen, codexPlaceholderIsDim(terminal), continuation)) return true;
  if (!allowUnstyled || !continuation) return false;
  const buffer = terminal.buffer.active;
  const row = composerRow(terminal);
  const line = buffer.getLine(row)?.translateToString(true) ?? "";
  const match = line.match(/^(\s*›\s?)(.*?)\s*$/u);
  return Boolean(match && EMPTY_COMPOSER_PLACEHOLDERS.has(match[2]!)
    && buffer.baseY + buffer.cursorY === row && buffer.cursorX === match[1]!.length
    && codexComposerReady(screen, true, continuation));
}
