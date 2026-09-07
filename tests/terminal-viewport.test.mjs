import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/xterm";
import { fitTerminalPreservingViewport } from "../src/renderer/src/features/terminal/terminalViewport.ts";

// Exercise the installed xterm buffer and scrollbar in Node, without opening a DOM terminal.
const { outputFiles } = await build({
  stdin: {
    contents: 'export { Viewport } from "browser/Viewport"; export { Scrollable } from "vs/base/common/scrollable";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url))
  },
  nodePaths: [fileURLToPath(new URL("../node_modules/@xterm/xterm/src", import.meta.url))],
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false
});
const { Viewport, Scrollable } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);

async function xtermFixture(t, { cols = 80, rows = 40, viewportY = 12, paused = false } = {}) {
  const terminal = new xterm.Terminal({ cols, rows, scrollback: 5_000 });
  const scrollable = new Scrollable({
    forceIntegerValues: false,
    smoothScrollDuration: 0,
    scheduleAtNextAnimationFrame() { throw new Error("Unexpected smooth scrolling"); }
  });
  t.after(() => { terminal.dispose(); scrollable.dispose(); });
  await new Promise((resolve) => terminal.write(
    Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")} ${"x".repeat(120)}`).join("\r\n"),
    resolve
  ));

  const bufferService = terminal._core._bufferService;
  let pendingResize;
  const refreshes = [];
  const viewport = Object.create(Viewport.prototype);
  viewport._bufferService = bufferService;
  viewport._renderService = {
    dimensions: { css: { cell: { height: 18 }, canvas: { height: rows * 18 } } },
    addRefreshCallback(callback) { refreshes.push(callback); return refreshes.length; },
    _pausedResizeTask: { flush() { pendingResize?.(); pendingResize = undefined; } }
  };
  viewport._scrollableElement = {
    setScrollDimensions: (dimensions) => scrollable.setScrollDimensions(dimensions, false),
    setScrollPosition: (position) => position.reuseAnimation
      ? scrollable.setScrollPositionSmooth(position, true)
      : scrollable.setScrollPositionNow(position),
    getScrollPosition: () => scrollable.getCurrentScrollPosition()
  };
  viewport._onRequestScrollLines = { fire: (amount) => bufferService.scrollLines(amount) };
  scrollable.onScroll((event) => viewport._handleScroll(event));
  bufferService.onResize(() => {
    const resize = () => { viewport._renderService.dimensions.css.canvas.height = terminal.rows * 18; };
    if (paused) pendingResize = resize;
    else resize();
    viewport.queueSync();
  });
  bufferService.onScroll(() => viewport._sync());
  terminal._core._viewport = viewport;
  viewport._sync();
  terminal.scrollToLine(viewportY === "bottom" ? terminal.buffer.active.baseY : viewportY);

  return {
    terminal,
    flushRender() { for (const callback of refreshes.splice(0)) callback(); },
    visibleLine: () => scrollable.getCurrentScrollPosition().scrollTop / 18
  };
}

test("resize while rendering is paused preserves both history and follow-output mode", async (t) => {
  for (const viewportY of [350, "bottom"]) {
    const { terminal, flushRender, visibleLine } = await xtermFixture(t, { viewportY, paused: true });
    for (const rows of [12, 24, 10]) {
      fitTerminalPreservingViewport(terminal, () => terminal.resize(80, rows));
      flushRender();
      await new Promise((resolve) => terminal.write("\r\nnew output", resolve));
      flushRender();
      const expected = viewportY === "bottom" ? terminal.buffer.active.baseY : viewportY;
      assert.equal(terminal.buffer.active.viewportY, expected);
      assert.equal(visibleLine(), expected);
    }
  }
});

test("shrinking the terminal height does not jump a scrolled reader to the beginning", async (t) => {
  const { terminal, flushRender, visibleLine } = await xtermFixture(t);
  const originalText = terminal.buffer.active.getLine(12).translateToString(true);

  fitTerminalPreservingViewport(terminal, () => terminal.resize(80, 12));
  flushRender();
  await new Promise((resolve) => terminal.write("\r\nnew output", resolve));
  flushRender();

  assert.equal(terminal.buffer.active.viewportY, 12);
  assert.equal(visibleLine(), 12);
  assert.equal(terminal.buffer.active.getLine(12).translateToString(true), originalText);
});

test("repeated width and height changes retain the same history through deferred xterm sync", async (t) => {
  const { terminal, flushRender, visibleLine } = await xtermFixture(t, { viewportY: 100 });
  const originalText = terminal.buffer.active.getLine(100).translateToString(true);

  for (const [cols, rows] of [[40, 12], [300, 40], [80, 24], [20, 40], [120, 12], [80, 40]]) {
    fitTerminalPreservingViewport(terminal, () => terminal.resize(cols, rows));
    fitTerminalPreservingViewport(terminal, () => terminal.resize(cols, rows + 1));
    flushRender();
    const line = terminal.buffer.active.viewportY;
    assert.equal(visibleLine(), line);
    assert.equal(terminal.buffer.active.getLine(line).translateToString(true).slice(0, 4), originalText.slice(0, 4));
  }
});

test("a terminal following output stays pinned across resize and later writes", async (t) => {
  const { terminal, flushRender, visibleLine } = await xtermFixture(t, { viewportY: "bottom" });
  for (const [cols, rows] of [[40, 12], [120, 40], [80, 24]]) {
    fitTerminalPreservingViewport(terminal, () => terminal.resize(cols, rows));
    flushRender();
    await new Promise((resolve) => terminal.write("\r\nnew output", resolve));
    flushRender();
    assert.equal(terminal.buffer.active.viewportY, terminal.buffer.active.baseY);
    assert.equal(visibleLine(), terminal.buffer.active.baseY);
  }
});

function terminalFixture({
  type = "normal",
  cols = 80,
  cursorY = 3,
  viewportY = 12,
  baseY = 20,
  wrappedLines = new Set()
} = {}) {
  const calls = [];
  const marker = {
    line: viewportY,
    dispose() {
      calls.push(["dispose"]);
    }
  };
  const active = {
    type,
    cursorY,
    viewportY,
    baseY,
    getLine(line) {
      return { isWrapped: wrappedLines.has(line) };
    }
  };
  const terminal = {
    cols,
    buffer: { active },
    registerMarker(offset) {
      calls.push(["marker", offset]);
      return marker;
    },
    scrollToBottom() {
      calls.push(["bottom"]);
    },
    scrollToLine(line) {
      calls.push(["line", line]);
    }
  };
  return { active, calls, marker, terminal };
}

test("fit keeps a bottom-pinned terminal at the bottom", () => {
  const fixture = terminalFixture({ viewportY: 20, baseY: 20 });

  fitTerminalPreservingViewport(fixture.terminal, () => {
    fixture.calls.push(["fit"]);
    fixture.active.viewportY = 0;
    fixture.active.baseY = 26;
  });

  assert.deepEqual(fixture.calls, [["fit"], ["bottom"]]);
});

test("fit anchors a scrolled viewport to the same logical wrapped content", () => {
  const fixture = terminalFixture({ wrappedLines: new Set([12]) });

  fitTerminalPreservingViewport(fixture.terminal, () => {
    fixture.calls.push(["fit"]);
    fixture.terminal.cols = 40;
    fixture.active.viewportY = 0;
    fixture.active.baseY = 30;
    fixture.marker.line = 13;
  });

  assert.deepEqual(fixture.calls, [
    ["marker", -12],
    ["fit"],
    ["line", 15],
    ["dispose"]
  ]);
});

test("fit falls back to the bounded numeric viewport if its marker is trimmed", () => {
  const fixture = terminalFixture();

  fitTerminalPreservingViewport(fixture.terminal, () => {
    fixture.calls.push(["fit"]);
    fixture.active.viewportY = 0;
    fixture.active.baseY = 8;
    fixture.marker.line = -1;
  });

  assert.deepEqual(fixture.calls, [
    ["marker", -11],
    ["fit"],
    ["line", 8],
    ["dispose"]
  ]);
});

test("fit leaves alternate-buffer scrolling to the terminal application", () => {
  const fixture = terminalFixture({ type: "alternate" });

  fitTerminalPreservingViewport(fixture.terminal, () => fixture.calls.push(["fit"]));

  assert.deepEqual(fixture.calls, [["fit"]]);
});
