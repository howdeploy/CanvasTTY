import { lazyRequire } from "../lazyRequire.ts";
import { terminalRowsText } from "./materials/sessionScreen.ts";

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
export async function renderedTerminalText(data: string, geometry: { cols: number; rows: number } | null): Promise<string> {
  const { cols, rows } = geometry && geometry.cols > 0 && geometry.rows > 0 ? geometry : DEFAULT_GEOMETRY;
  const terminal = new (xterm().Terminal)({ cols, rows, scrollback: SCROLLBACK_ROWS, allowProposedApi: true });
  const rowsText = (): string => terminalRowsText(terminal, 0, terminal.buffer.active.length, true).replace(/\n+$/u, "");
  // A full-screen TUI leaves its alternate screen as it exits, which discards that screen: its last frame (often why it
  // stopped) is kept from the moment it leaves, before what it printed afterwards.
  let leftScreen = "";
  const leaving = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (terminal.buffer.active.type === "alternate" && params.some((mode) => mode === 1049 || mode === 1047 || mode === 47)) {
      leftScreen = rowsText();
    }
    return false;
  });
  try {
    await new Promise<void>((resolve) => terminal.write(data, resolve));
    // Every row, scrollback included (sessionScreen's terminalScreenText reads only the visible screen of a live one).
    const shown = rowsText();
    if (terminal.buffer.active.type === "alternate" || !leftScreen) return shown;
    return shown ? `${leftScreen}\n${shown}` : leftScreen;
  } finally {
    leaving.dispose();
    terminal.dispose();
  }
}
