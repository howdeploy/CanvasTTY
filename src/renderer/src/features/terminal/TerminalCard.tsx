import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import {
  INITIAL_TERMINAL_COLS,
  INITIAL_TERMINAL_ROWS
} from "../../../../shared/contracts";
import type {
  LocaleId,
  PaletteId,
  Point,
  FocusActivation,
  SessionBounds,
  SessionSnapshot
} from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { sessionStatusLabel } from "../../lib/sessionStatus";
import { attachTerminalMouseCoordinateAdapter, attachTerminalScrollbarCoordinateAdapter } from "./terminalMouseCoordinates";
import {
  SHIFT_ENTER_SEQUENCE,
  shouldCopyTerminalSelection,
  shouldPasteTerminalClipboard,
  shouldRestartExitedTerminal,
  shouldScrollTerminalPage,
  shouldSendTerminalLineBreak
} from "./terminalShortcuts";
import { fitTerminalPreservingViewport } from "./terminalViewport";
import { attachTerminalOutput } from "./terminalOutput";
import {
  constrainResize,
  snapMove,
  snapResize
} from "../workspace/snap";
import { shouldActivateCanvasFromClick } from "../workspace/focus";
import type { ResizeDirection } from "../workspace/snap";
import { terminalCanvasWidgetId } from "../workspace/canvasWidgetFocus";

interface TerminalCardProps {
  session: SessionSnapshot;
  locale: LocaleId;
  palette: PaletteId;
  zoom: number;
  stackIndex: number;
  snapEnabled: boolean;
  focusActivation: FocusActivation;
  invertTerminalWheel: boolean;
  captureCanvasWheelOverWidgets: boolean;
  focused: boolean;
  focusChangeSource: "explicit" | "hover";
  selected: boolean;
  renaming: boolean;
  snapTargets: readonly SessionBounds[];
  onActivate(session: SessionSnapshot): void;
  onSelect(id: string): void;
  onRename(id: string, title: string): Promise<void>;
  onRenameEnd(): void;
  onBoundsChange(id: string, bounds: SessionBounds): void;
  onRestart(id: string): Promise<void>;
  onDispose(id: string): void;
  onOpenUrl(url: string): void;
}

interface DragState {
  pointerId: number;
  startClient: Point;
  startBounds: SessionBounds;
}

interface ResizeState extends DragState {
  direction: ResizeDirection;
}

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const TERMINAL_FOCUS_IN = "\u001b[I";
const TERMINAL_FOCUS_OUT = "\u001b[O";

export function TerminalCard({
  session,
  locale,
  palette,
  zoom,
  stackIndex,
  snapEnabled,
  focusActivation,
  invertTerminalWheel,
  captureCanvasWheelOverWidgets,
  focused,
  focusChangeSource,
  selected,
  renaming,
  snapTargets,
  onActivate,
  onSelect,
  onRename,
  onRenameEnd,
  onBoundsChange,
  onRestart,
  onDispose,
  onOpenUrl
}: TerminalCardProps): React.JSX.Element {
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onOpenUrlRef = useRef(onOpenUrl);
  onOpenUrlRef.current = onOpenUrl;
  const renameInput = useRef<HTMLInputElement>(null);
  const renameInFlight = useRef(false);
  const suppressFocusReport = useRef(false);
  const sessionExited = useRef(session.exitCode !== null);
  sessionExited.current = session.exitCode !== null;
  const restartAction = useRef<() => Promise<void>>(async () => undefined);
  const invertTerminalWheelRef = useRef(invertTerminalWheel);
  invertTerminalWheelRef.current = invertTerminalWheel;
  const captureCanvasWheelRef = useRef(captureCanvasWheelOverWidgets);
  captureCanvasWheelRef.current = captureCanvasWheelOverWidgets;
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const [position, setPosition] = useState(session.position);
  const [size, setSize] = useState(session.size);
  const [restarting, setRestarting] = useState(false);
  const liveBounds = useRef<SessionBounds>({ position: session.position, size: session.size });
  const summaryMode = zoom < 0.5;
  const summaryScale = summaryMode ? Math.min(2.5, Math.max(1, 0.5 / zoom)) : 1;
  const terminalBackground = terminalTheme(palette).background;

  restartAction.current = async () => {
    if (restarting || !sessionExited.current) return;
    setRestarting(true);
    try {
      await onRestart(session.id);
      const terminal = terminalRef.current;
      if (terminal) window.canvasTTY.terminal.resize(session.id, terminal.cols, terminal.rows);
    } finally {
      setRestarting(false);
    }
  };

  useEffect(() => {
    const bounds = { position: session.position, size: session.size };
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  }, [session.position, session.size]);

  useEffect(() => {
    const host = terminalHost.current;
    if (!host) return;

    const terminal = new Terminal({
      cols: INITIAL_TERMINAL_COLS,
      rows: INITIAL_TERMINAL_ROWS,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 5_000,
      allowTransparency: true,
      theme: terminalTheme(palette),
      // OSC 8 hyperlinks are handled by xterm itself rather than WebLinksAddon.
      // Without an explicit handler, xterm shows its own confirm() prompt and
      // attempts window.open(), bypassing CanvasTTY's link destination chooser.
      linkHandler: {
        activate: (event, uri) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenUrlRef.current(uri);
        }
      }
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      event.stopPropagation();
      onOpenUrlRef.current(uri);
    });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);
    let lastReportedGrid = "";
    const reportGrid = (cols: number, rows: number): void => {
      const grid = `${cols}x${rows}`;
      if (grid === lastReportedGrid) return;
      lastReportedGrid = grid;
      window.canvasTTY.terminal.resize(session.id, cols, rows);
    };
    const resize = terminal.onResize(({ cols, rows }) => reportGrid(cols, rows));
    const unsubscribe = attachTerminalOutput(
      window.canvasTTY.terminal,
      session.id,
      (data) => terminal.write(data),
      (error) => {
        console.error("CanvasTTY could not load terminal history.", error);
        terminal.write(`\r\n[CanvasTTY] ${t(locale, "terminalHistoryFailed")}\r\n`);
      }
    );
    const fit = (): void => {
      try {
        fitTerminalPreservingViewport(terminal, () => fitAddon.fit());
        reportGrid(terminal.cols, terminal.rows);
      } catch {
        // A hidden semantic-zoom surface has no measurable rows yet.
      }
    };
    terminal.attachCustomKeyEventHandler((event) => {
      if (shouldRestartExitedTerminal(event, sessionExited.current)) {
        event.preventDefault();
        event.stopPropagation();
        void restartAction.current();
        return false;
      }
      if (shouldSendTerminalLineBreak(event)) {
        event.preventDefault();
        event.stopPropagation();
        window.canvasTTY.terminal.input(session.id, SHIFT_ENTER_SEQUENCE);
        return false;
      }
      const pageDirection = shouldScrollTerminalPage(event);
      if (pageDirection !== 0 && terminal.buffer.active.type === "normal") {
        // In the normal buffer PgUp/PgDn page the scrollback; in the alternate
        // buffer they fall through to the application (vim, less, agent TUI).
        event.preventDefault();
        event.stopPropagation();
        terminal.scrollPages(pageDirection);
        return false;
      }
      if (shouldCopyTerminalSelection(event, terminal.hasSelection())) {
        event.preventDefault();
        event.stopPropagation();
        window.canvasTTY.clipboard.writeText(terminal.getSelection());
        return false;
      }
      if (!shouldPasteTerminalClipboard(event)) return true;

      event.preventDefault();
      event.stopPropagation();
      void window.canvasTTY.clipboard.readText()
        .then((text) => {
          if (text && terminalRef.current === terminal) terminal.paste(text);
        })
        .catch(() => undefined);
      return false;
    });
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    const detachMouseCoordinateAdapter = screen
      ? attachTerminalMouseCoordinateAdapter(
        screen,
        () => invertTerminalWheelRef.current ? -1 : 1,
        () => captureCanvasWheelRef.current
      )
      : () => undefined;
    terminalRef.current = terminal;
    const detachScrollbarCoordinateAdapter = attachTerminalScrollbarCoordinateAdapter(terminal);
    fit();

    const frame = requestAnimationFrame(fit);
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);

    const input = terminal.onData((data) => {
      // Hover focus routes keyboard input locally without reporting a synthetic focus transition to the TUI.
      if (suppressFocusReport.current && (data === TERMINAL_FOCUS_IN || data === TERMINAL_FOCUS_OUT)) return;
      window.canvasTTY.terminal.input(session.id, data);
    });
    return () => {
      cancelAnimationFrame(frame);
      detachMouseCoordinateAdapter();
      detachScrollbarCoordinateAdapter();
      unsubscribe();
      resizeObserver.disconnect();
      input.dispose();
      resize.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      terminal.dispose();
    };
  }, [session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalTheme(palette);
  }, [palette]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    suppressFocusReport.current = focusChangeSource === "hover";
    if (focused && !renaming && !summaryMode) terminal.focus();
    else if (!focused) {
      terminal.blur();
      renameInput.current?.blur();
    }
    suppressFocusReport.current = false;
  }, [focusChangeSource, focused, renaming, summaryMode]);

  const bindRenameInput = useCallback((input: HTMLInputElement | null): void => {
    renameInput.current = input;
    if (!input) return;
    terminalRef.current?.blur();
    input.focus({ preventScroll: true });
    input.select();
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current
    };
  };

  const drag = (event: React.PointerEvent<HTMLElement>): void => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const rawPosition = {
      x: state.startBounds.position.x + (event.clientX - state.startClient.x) / zoom,
      y: state.startBounds.position.y + (event.clientY - state.startClient.y) / zoom
    };
    const nextPosition = snapEnabled
      ? snapMove(rawPosition, state.startBounds.size, snapTargets)
      : rawPosition;
    applyLiveBounds({ position: nextPosition, size: state.startBounds.size });
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (!dragState.current || dragState.current.pointerId !== event.pointerId) return;
    dragState.current = null;
    onBoundsChange(session.id, liveBounds.current);
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeState.current = {
      pointerId: event.pointerId,
      direction,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current
    };
  };

  const resizeCard = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - state.startClient.x) / zoom;
    const deltaY = (event.clientY - state.startClient.y) / zoom;
    const raw: SessionBounds = {
      position: {
        x: state.startBounds.position.x + (state.direction.includes("w") ? deltaX : 0),
        y: state.startBounds.position.y + (state.direction.includes("n") ? deltaY : 0)
      },
      size: {
        width: state.startBounds.size.width
          + (state.direction.includes("e") ? deltaX : 0)
          - (state.direction.includes("w") ? deltaX : 0),
        height: state.startBounds.size.height
          + (state.direction.includes("s") ? deltaY : 0)
          - (state.direction.includes("n") ? deltaY : 0)
      }
    };
    const constrained = constrainResize(raw, state.direction);
    applyLiveBounds(snapEnabled ? snapResize(constrained, state.direction, snapTargets) : constrained);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizeState.current || resizeState.current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    resizeState.current = null;
    onBoundsChange(session.id, liveBounds.current);
  };

  const applyLiveBounds = (bounds: SessionBounds): void => {
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  };

  const activateSummary = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.currentTarget.closest<HTMLElement>(".terminal-card")?.focus({ preventScroll: true });
    onSelect(session.id);
    if (shouldActivateCanvasFromClick(focusActivation, 1)) onActivate(session);
  };

  const activateSummaryDouble = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (shouldActivateCanvasFromClick(focusActivation, 2)) onActivate(session);
  };

  const activateCard = (event: React.MouseEvent<HTMLElement>): void => {
    if (!shouldActivateCanvasFromClick(focusActivation, 1) || isCardControl(event.target)) return;
    onActivate(session);
  };

  const activateCardDouble = (event: React.MouseEvent<HTMLElement>): void => {
    if (!shouldActivateCanvasFromClick(focusActivation, 2) || isCardControl(event.target)) return;
    onActivate(session);
  };

  const commitRename = async (): Promise<void> => {
    if (renameInFlight.current) return;
    const title = renameInput.current?.value.trim() ?? "";
    if (!title) {
      onRenameEnd();
      return;
    }
    renameInFlight.current = true;
    try {
      await onRename(session.id, title);
      onRenameEnd();
    } finally {
      renameInFlight.current = false;
    }
  };

  return (
    <article
      className={`terminal-card terminal-card--${session.provider} ${summaryMode ? "terminal-card--summary" : ""} ${selected ? "terminal-card--selected" : ""}`}
      data-interactive="true"
      data-canvas-layer-id={`terminal:${session.id}`}
      data-canvas-widget-id={terminalCanvasWidgetId(session.id)}
      data-canvas-widget-focusable="true"
      data-canvas-zoom-surface="application"
      data-wheel-owner={summaryMode ? undefined : "local"}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        onSelect(session.id);
        if (!renaming && !summaryMode && !(event.target as HTMLElement).closest("button, input")) {
          terminalRef.current?.focus();
        }
      }}
      onClick={activateCard}
      onDoubleClick={activateCardDouble}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = sessionExited.current || renaming ? "none" : "copy";
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        const terminal = terminalRef.current;
        if (!terminal || sessionExited.current || renaming) return;
        try {
          const text = window.canvasTTY.terminal.fileDropText(Array.from(event.dataTransfer.files));
          onSelect(session.id);
          terminal.focus();
          terminal.paste(text);
        } catch {
          terminal.write(`\r\n[CanvasTTY] ${t(locale, "terminalFileDropFailed")}\r\n`);
        }
      }}
      style={{
        width: size.width,
        height: size.height,
        zIndex: stackIndex,
        transform: `translate(${position.x}px, ${position.y}px)`,
        "--summary-scale": summaryScale,
        "--summary-content-width": `${Math.max(0, (size.width - 72) / summaryScale)}px`,
        "--terminal-background": terminalBackground
      } as React.CSSProperties}
    >
      <header
        className="terminal-card__header"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="terminal-card__identity">
          <ProviderIcon provider={session.provider} size="small" />
          {renaming ? (
            <input
              ref={bindRenameInput}
              className="terminal-card__rename"
              data-terminal-rename="true"
              defaultValue={session.title}
              autoFocus
              maxLength={80}
              aria-label={t(locale, "renameWindow")}
              onPointerDown={(event) => event.stopPropagation()}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onRenameEnd();
                }
              }}
            />
          ) : (
            <strong title={session.titleCustomized ? session.title : session.cwd}>
              {session.titleCustomized ? session.title : compactPath(session.cwd)}
            </strong>
          )}
        </div>
        <div className="terminal-card__actions">
          {session.exitCode !== null && (
            <button
              className="terminal-card__action terminal-card__action--restart"
              type="button"
              disabled={restarting}
              onClick={() => void restartAction.current()}
              title={`${t(locale, "restartSession")} · Ctrl+D`}
              aria-label={t(locale, "restartSession")}
            >
              <UiIcon name={restarting ? "working" : "reload"} size="1.23em" />
            </button>
          )}
          <button className="terminal-card__action terminal-card__action--close" type="button" onClick={() => onDispose(session.id)} title={t(locale, "close")} aria-label={t(locale, "close")}><UiIcon name="close" size="1.23em" /></button>
        </div>
      </header>
      <div className="terminal-card__surface" ref={terminalHost} />
      <button
        className="terminal-card__summary"
        type="button"
        onClick={activateSummary}
        onDoubleClick={activateSummaryDouble}
        title={session.title}
        aria-label={session.title}
        data-focus-activation={focusActivation}
      >
        <div className="terminal-card__summary-content">
          <ProviderIcon provider={session.provider} size="large" />
          <div className="terminal-card__summary-copy"><strong>{session.title}</strong><span>{sessionStatusLabel(locale, session.status, session.provider)}</span></div>
        </div>
      </button>
      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`}
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, direction)}
          onPointerMove={resizeCard}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      ))}
    </article>
  );
}

function terminalTheme(palette: PaletteId): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const background = palette === "night" ? "#171a24" : "#202430";
  return {
    background,
    foreground: "#f7f4ec",
    cursor: palette === "lilac" ? "#bfc9ee" : "#b8cf99",
    selectionBackground: "#7b789966"
  };
}

function compactPath(path: string): string {
  const home = "/home/";
  if (!path.startsWith(home)) return path;
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `~/${parts.slice(2).join("/")}` : path;
}

function isCardControl(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, .terminal-card__resize-handle"));
}
