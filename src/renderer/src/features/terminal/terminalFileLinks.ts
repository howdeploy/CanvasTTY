import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { findTerminalFileLinks } from "../../../../shared/terminalFileLink.ts";

export function terminalFileLinkProvider(
  terminal: Pick<Terminal, "buffer" | "cols">,
  activate: (event: MouseEvent, reference: string) => void
): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const buffer = terminal.buffer.active;
      let first = lineNumber - 1;
      while (first > 0 && buffer.getLine(first)?.isWrapped && lineNumber - first < 100) first -= 1;
      if (buffer.getLine(first)?.isWrapped) {
        callback(undefined);
        return;
      }
      let text = "";
      const cells: { x: number; y: number; width: number }[] = [];
      let row = first;
      for (; row < first + 100; row += 1) {
        const line = buffer.getLine(row);
        if (!line || (row > first && !line.isWrapped)) break;
        const next = buffer.getLine(row + 1);
        for (let column = 0; column < terminal.cols; column += 1) {
          const cell = line.getCell(column);
          if (!cell || cell.getWidth() === 0) continue;
          if (column === terminal.cols - 1 && cell.getChars() === ""
            && next?.isWrapped && next.getCell(0)?.getWidth() === 2) continue;
          const chars = cell.getChars() || " ";
          for (let i = 0; i < chars.length; i += 1) {
            cells.push({ x: column + 1, y: row + 1, width: cell.getWidth() });
          }
          text += chars;
        }
      }
      if (row === first + 100 && buffer.getLine(row)?.isWrapped) {
        callback(undefined);
        return;
      }
      callback(findTerminalFileLinks(text).flatMap((link) => {
        const start = cells[link.start];
        const end = cells[link.end - 1];
        if (!start || !end || lineNumber < start.y || lineNumber > end.y) return [];
        return [{
          text: link.text,
          range: { start: { x: start.x, y: start.y }, end: { x: end.x + end.width - 1, y: end.y } },
          activate: (event: MouseEvent) => activate(event, link.text)
        }];
      }));
    }
  };
}
