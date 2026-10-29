import type { IBufferLine, Terminal } from "@xterm/xterm";

export function terminalTextRuns(line: IBufferLine | undefined, columns: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1, end = 0;
  for (let column = 0; line && column < columns; column++) {
    const cell = line.getCell(column);
    // ANSI highlights already provide their own background and contrast.
    if (cell?.getChars().trim() && cell.isBgDefault() && !cell.isInverse()) {
      if (start < 0) start = column;
      end = Math.min(columns, column + Math.max(1, cell.getWidth()));
    } else if (start >= 0 && column >= end) {
      runs.push([start, end]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, end]);
  return runs;
}

export function attachTerminalTextBackdrop(terminal: Terminal, host: HTMLElement): () => void {
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return () => {};
  let canvas: HTMLCanvasElement | undefined;
  let frame: number | undefined;
  const draw = (): void => {
    frame = undefined;
    if (!host.classList.contains("terminal-card__surface--ascii-readable")) return;
    const width = screen.clientWidth, height = screen.clientHeight;
    if (!width || !height || !screen.checkVisibility({ visibilityProperty: true })) return;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "terminal-ascii-text-backdrop";
      canvas.setAttribute("aria-hidden", "true");
      screen.append(canvas);
    }
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const configured = Number.parseFloat(getComputedStyle(host).getPropertyValue("--terminal-text-backdrop-strength"));
    const strength = Number.isFinite(configured) ? Math.min(1, Math.max(0, configured)) : 0.86;
    context.fillStyle = `rgba(2, 4, 10, ${strength})`;
    context.shadowColor = `rgba(2, 4, 10, ${Math.min(1, strength * 90 / 86)})`;
    context.shadowBlur = 3 * ratio;
    const cellWidth = width / terminal.cols, cellHeight = height / terminal.rows;
    const buffer = terminal.buffer.active;
    for (let row = 0; row < terminal.rows; row++) {
      for (const [start, end] of terminalTextRuns(buffer.getLine(buffer.viewportY + row), terminal.cols)) {
        context.beginPath();
        context.roundRect(start * cellWidth - 1, row * cellHeight + 1,
          (end - start) * cellWidth + 2, Math.max(1, cellHeight - 2), 3);
        context.fill();
      }
    }
  };
  // Terminal events update the mask; background animation never triggers this work.
  const schedule = (): void => {
    if (frame === undefined && host.classList.contains("terminal-card__surface--ascii-readable")) {
      frame = requestAnimationFrame(draw);
    }
  };
  const subscriptions = [terminal.onRender(schedule), terminal.onScroll(schedule), terminal.onResize(schedule)];
  const observer = new ResizeObserver(schedule);
  observer.observe(screen);
  schedule();
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    subscriptions.forEach(subscription => subscription.dispose());
    observer.disconnect();
    canvas?.remove();
  };
}
