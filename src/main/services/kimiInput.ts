/** shortcut: Only the verified Kimi 2.x box is supported; add a versioned parser before supporting legacy prompts. */
export function kimiComposerReady(terminal: import("@xterm/headless").Terminal): boolean {
  const buffer = terminal.buffer.active;
  const lines = Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
  let prompt = -1;
  for (let row = 0; row < lines.length; row++) {
    if (/^\s*│\s*>/u.test(lines[row]!)) prompt = row;
  }
  if (prompt < 1 || !/^\s*[╭┌├]─{2,}[╮┐┤]\s*$/u.test(lines[prompt - 1]!)
    || !/^\s*│\s*>\s*│\s*$/u.test(lines[prompt]!)) return false;
  let bottom = prompt + 1;
  while (bottom < lines.length && /^\s*│\s*│\s*$/u.test(lines[bottom]!)) bottom++;
  if (!/^\s*[╰└]─{2,}[╯┘]\s*$/u.test(lines[bottom] ?? "")) return false;
  if (buffer.cursorY < prompt || buffer.cursorY >= bottom) return false;
  const cursorLine = lines[buffer.cursorY]!;
  const left = cursorLine.indexOf("│"), right = cursorLine.lastIndexOf("│");
  return buffer.cursorX > left && buffer.cursorX < right;
}
