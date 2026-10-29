export interface TerminalBufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface TerminalBufferLike {
  readonly type: "normal" | "alternate";
  readonly baseY: number;
  readonly viewportY: number;
  readonly cursorY: number;
  readonly cursorX: number;
  getLine(index: number): TerminalBufferLineLike | undefined;
}

export interface PinnedTerminalInput {
  rows: string[];
  cursorRow: number;
  cursorColumn: number;
}

export function limitPinnedTerminalInput(input: PinnedTerminalInput, maxRows: number): PinnedTerminalInput {
  const capacity = Math.max(1, Math.floor(maxRows));
  if (input.rows.length <= capacity) return input;
  const firstRow = Math.max(
    0,
    Math.min(input.rows.length - capacity, input.cursorRow - Math.floor(capacity / 2))
  );
  return {
    rows: input.rows.slice(firstRow, firstRow + capacity),
    cursorRow: input.cursorRow - firstRow,
    cursorColumn: input.cursorColumn
  };
}

/** Pin the live logical cursor line only after it leaves the unreserved viewport. */
export function pinnedTerminalInput(buffer: TerminalBufferLike, viewportRows: number): PinnedTerminalInput | null {
  if (buffer.type !== "normal" || buffer.viewportY >= buffer.baseY || viewportRows < 1) return null;
  const cursorLine = buffer.baseY + buffer.cursorY;
  if (!buffer.getLine(cursorLine)) return null;

  let firstLine = cursorLine;
  while (firstLine > 0 && buffer.getLine(firstLine)?.isWrapped) firstLine -= 1;

  let lastLine = cursorLine;
  while (buffer.getLine(lastLine + 1)?.isWrapped) lastLine += 1;

  if (firstLine < buffer.viewportY + viewportRows && lastLine >= buffer.viewportY) return null;

  const rows: string[] = [];
  for (let line = firstLine; line <= lastLine; line += 1) {
    const bufferLine = buffer.getLine(line);
    if (!bufferLine) return null;
    rows.push(bufferLine.translateToString(true));
  }
  return {
    rows,
    cursorRow: cursorLine - firstLine,
    cursorColumn: buffer.cursorX
  };
}

/** Coalesce parser events into one visible DOM refresh; hidden output still advances xterm's buffer. */
export function createPinnedInputRefresh(options: {
  isLive(): boolean;
  refresh(): void;
  requestFrame(callback: () => void): number;
  cancelFrame(frame: number): void;
}): { schedule(): void; dispose(): void } {
  let frame: number | null = null;
  let disposed = false;
  return {
    schedule() {
      if (disposed || frame !== null || !options.isLive()) return;
      frame = options.requestFrame(() => {
        frame = null;
        if (!disposed && options.isLive()) options.refresh();
      });
    },
    dispose() {
      disposed = true;
      if (frame !== null) options.cancelFrame(frame);
      frame = null;
    }
  };
}
