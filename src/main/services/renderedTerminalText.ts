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
  const rowsText = (from = 0, to = terminal.buffer.active.length): string =>
    terminalRowsText(terminal, from, to, true).replace(/\n+$/u, "");
  const fullScreen = (params: (number | number[])[]): boolean => params.some((mode) => mode === 1049 || mode === 1047 || mode === 47);
  // Where the normal buffer's history ended as a full-screen TUI entered its alternate screen: what is above stays
  // above, what the CLI prints after leaving starts there (1049 restores the cursor to it).
  let entered: import("@xterm/headless").IMarker | undefined;
  const entering = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (terminal.buffer.active.type === "normal" && fullScreen(params)) {
      entered?.dispose();
      entered = terminal.registerMarker(0);
    }
    return false;
  });
  // A full-screen TUI leaves its alternate screen as it exits, which discards that screen: its last frame (often why it
  // stopped) is kept from the moment it leaves, and placed between the history before it and what it printed afterwards.
  let leftScreen = "";
  const leaving = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (terminal.buffer.active.type === "alternate" && fullScreen(params)) leftScreen = rowsText();
    return false;
  });
  try {
    await new Promise<void>((resolve) => terminal.write(data, resolve));
    // Every row, scrollback included (sessionScreen's terminalScreenText reads only the visible screen of a live one).
    if (terminal.buffer.active.type === "alternate" || !leftScreen) return rowsText();
    // A marker whose row was trimmed from the scrollback has line -1: then all that is left followed the frame.
    const split = entered && !entered.isDisposed && entered.line >= 0 ? entered.line : 0;
    return [rowsText(0, split), leftScreen, rowsText(split)].filter(Boolean).join("\n");
  } finally {
    leaving.dispose();
    entering.dispose();
    entered?.dispose();
    terminal.dispose();
  }
}
