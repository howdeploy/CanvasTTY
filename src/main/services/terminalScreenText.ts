import { lazyRequire } from "../lazyRequire.ts";

const xterm = lazyRequire<typeof import("@xterm/headless")>("@xterm/headless");

/** Rows of scrollback the rendering keeps above the screen: the tail an orchestrator reads is far shorter. */
const SCROLLBACK_ROWS = 500;
const DEFAULT_GEOMETRY = { cols: 120, rows: 40 };

/**
 * What a terminal shows for `data` as plain text: the scrollback rows and the screen (the alternate screen of a
 * full-screen TUI such as OpenCode, which keeps no scrollback), as a headless xterm renders them, so cursor moves,
 * redraws, erases and colors leave only the text a person sees. A row the terminal wrapped continues its line;
 * trailing blanks and empty rows at the end are dropped.
 */
export async function terminalScreenText(data: string, geometry: { cols: number; rows: number } | null): Promise<string> {
  const { cols, rows } = geometry && geometry.cols > 0 && geometry.rows > 0 ? geometry : DEFAULT_GEOMETRY;
  const terminal = new (xterm().Terminal)({ cols, rows, scrollback: SCROLLBACK_ROWS, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => terminal.write(data, resolve));
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      // Untrimmed, so a space the wrap fell on stays between the words; each line is trimmed once it is whole.
      const text = line.translateToString(false);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return lines.map((line) => line.trimEnd()).join("\n");
  } finally {
    terminal.dispose();
  }
}
