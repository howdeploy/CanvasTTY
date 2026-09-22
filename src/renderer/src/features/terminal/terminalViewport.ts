import type { Terminal } from "@xterm/xterm";

interface TerminalViewportLine {
  readonly isWrapped: boolean;
}

interface TerminalViewportBuffer {
  readonly type: "normal" | "alternate";
  readonly cursorY: number;
  readonly viewportY: number;
  readonly baseY: number;
  getLine(line: number): TerminalViewportLine | undefined;
}

interface TerminalViewportMarker {
  readonly line: number;
  dispose(): void;
}

interface TerminalViewport {
  readonly cols: number;
  readonly buffer: { readonly active: TerminalViewportBuffer };
  registerMarker(cursorYOffset?: number): TerminalViewportMarker;
  scrollToBottom(): void;
  scrollToLine(line: number): void;
}

interface XtermViewportCore {
  _bufferService: { scrollLines(amount: number): void };
  _viewport?: {
    _renderService: { _pausedResizeTask: { flush(): void } };
    _sync(): void;
    scrollToLine(line: number, disableSmoothScroll: boolean): void;
  };
}

/** Keep the viewport across a TUI's clear-and-replay of normal history. */
export function attachTerminalRedrawViewport(terminal: Terminal): () => void {
  let pending: number | undefined;
  const erase = terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
    const buffer = terminal.buffer.active;
    if (params[0] === 3 && buffer.type === "normal") {
      // ponytail: replay has no stable line IDs; keep relative position through TUI rewrapping.
      pending ??= buffer.baseY === 0 ? 1 : buffer.viewportY / buffer.baseY;
    }
    // Let xterm execute the erase; retaining old rows would duplicate TUI history.
    return false;
  });
  // Codex clears just before starting its synchronized replay. Keep the anchor
  // across that boundary, but discard it for ordinary output or new input.
  const lineFeed = terminal.onLineFeed(() => {
    if (!terminal.modes.synchronizedOutputMode) pending = undefined;
  });
  const input = terminal.onData(() => { pending = undefined; });
  const endFrame = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (!params.includes(2026) || pending === undefined) return false;
    const position = pending;
    pending = undefined;
    const buffer = terminal.buffer.active;
    if (buffer.type === "normal") {
      scrollTerminalToLine(terminal, Math.round(position * buffer.baseY), position === 1);
    }
    return false;
  });
  return () => { erase.dispose(); lineFeed.dispose(); input.dispose(); endFrame.dispose(); };
}

function scrollTerminalToLine(terminal: TerminalViewport, line: number, pinned: boolean): void {
  const core = (terminal as TerminalViewport & { _core?: XtermViewportCore })._core;
  if (core?._viewport) {
    // xterm 6 applies public scroll deltas to potentially stale scrollbar coordinates.
    // Flush offscreen dimensions, then synchronize the buffer and absolute position.
    core._viewport._renderService._pausedResizeTask.flush();
    core._bufferService.scrollLines(line - terminal.buffer.active.viewportY);
    core._viewport._sync();
    core._viewport.scrollToLine(line, true);
  } else if (pinned) {
    terminal.scrollToBottom();
  } else {
    terminal.scrollToLine(line);
  }
}

/**
 * Fits xterm without losing the reader's place in normal-buffer scrollback.
 * A marker follows the logical line through xterm's width reflow while the
 * wrapped-row offset keeps the same visible fragment as close to the top as
 * the new column count allows.
 */
export function fitTerminalPreservingViewport(terminal: TerminalViewport, fit: () => void): void {
  const before = terminal.buffer.active;
  const core = (terminal as TerminalViewport & { _core?: XtermViewportCore })._core;
  if (before.type !== "normal") {
    fit();
    // Returning from an offscreen TUI must not clamp normal history against the
    // old renderer height and turn off follow-output mode.
    core?._viewport?._renderService._pausedResizeTask.flush();
    return;
  }

  const pinnedToBottom = before.viewportY >= before.baseY;
  const fallbackLine = before.viewportY;
  let marker: TerminalViewportMarker | undefined;
  let wrappedCellOffset = 0;

  if (!pinnedToBottom) {
    let logicalLineStart = before.viewportY;
    while (logicalLineStart > 0 && before.getLine(logicalLineStart)?.isWrapped) {
      logicalLineStart -= 1;
    }
    wrappedCellOffset = (before.viewportY - logicalLineStart) * terminal.cols;
    const cursorLine = before.baseY + before.cursorY;
    marker = terminal.registerMarker(logicalLineStart - cursorLine);
  }

  try {
    fit();
    const after = terminal.buffer.active;
    if (after.type !== "normal") return;

    const anchoredLine = marker && marker.line >= 0
      ? marker.line + Math.floor(wrappedCellOffset / Math.max(terminal.cols, 1))
      : fallbackLine;
    const line = pinnedToBottom ? after.baseY : Math.max(0, Math.min(anchoredLine, after.baseY));
    scrollTerminalToLine(terminal, line, pinnedToBottom);
  } finally {
    marker?.dispose();
  }
}
