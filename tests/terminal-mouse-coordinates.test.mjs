import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { attachTerminalScrollbarCoordinateAdapter, remapTerminalMouseCoordinates } from "../src/renderer/src/features/terminal/terminalMouseCoordinates.ts";

test("installed xterm scrollbar drag follows layout distance at every canvas scale", async (t) => {
  const { outputFiles } = await build({
    stdin: {
      contents: 'export { VerticalScrollbar } from "vs/base/browser/ui/scrollbar/verticalScrollbar"; export { ScrollbarState } from "vs/base/browser/ui/scrollbar/scrollbarState";',
      resolveDir: fileURLToPath(new URL("..", import.meta.url))
    },
    nodePaths: [fileURLToPath(new URL("../node_modules/@xterm/xterm/src", import.meta.url))],
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    bundle: true, platform: "node", format: "esm", write: false
  });
  const { VerticalScrollbar, ScrollbarState } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
  const originalElement = globalThis.Element;
  globalThis.Element = class {};
  t.after(() => { globalThis.Element = originalElement; });

  for (const scale of [0.5, 0.7, 1, 1.5, 2]) {
    const scrollbar = Object.create(VerticalScrollbar.prototype);
    scrollbar._scrollbarState = new ScrollbarState(0, 14, 0, 400, 4000, 1000);
    scrollbar.slider = { toggleClassName() {} };
    scrollbar._host = { onDragStart() {}, onDragEnd() {} };
    let move;
    scrollbar._pointerMoveMonitor = { startMonitoring(_target, _id, _buttons, listener) { move = listener; } };
    let scrollTop;
    scrollbar._scrollable = { setScrollPositionNow(position) { scrollTop = position.scrollTop; } };
    const original = scrollbar._sliderPointerPosition;
    const detach = attachTerminalScrollbarCoordinateAdapter({
      element: { offsetHeight: 400, getBoundingClientRect: () => ({ height: 400 * scale }) },
      _core: { _viewport: { _scrollableElement: { _verticalScrollbar: scrollbar } } }
    });
    scrollbar._sliderPointerDown({ target: new Element(), pageX: 50, pageY: 100, pointerId: 1, buttons: 1 });
    move({ pageX: 50, pageY: 100 + 100 * scale });
    assert.equal(scrollTop, 2000, `scale ${scale}`);
    move({ pageX: 50, pageY: 100 - 50 * scale });
    assert.equal(scrollTop, 500, `upwards at scale ${scale}`);
    detach();
    assert.equal(scrollbar._sliderPointerPosition, original);
  }
});

test("keeps terminal coordinates unchanged at one-to-one scale", () => {
  assert.deepEqual(
    remapTerminalMouseCoordinates(
      { x: 190, y: 240 },
      { left: 100, top: 100, width: 700, height: 400 },
      { width: 700, height: 400 }
    ),
    { x: 190, y: 240 }
  );
});

test("maps visual coordinates back into xterm layout coordinates when zoomed out", () => {
  assert.deepEqual(
    remapTerminalMouseCoordinates(
      { x: 170, y: 170 },
      { left: 100, top: 100, width: 490, height: 280 },
      { width: 700, height: 400 }
    ),
    { x: 200, y: 200 }
  );
});

test("maps visual coordinates back into xterm layout coordinates when zoomed in", () => {
  assert.deepEqual(
    remapTerminalMouseCoordinates(
      { x: 240, y: 240 },
      { left: 100, top: 100, width: 840, height: 480 },
      { width: 700, height: 400 }
    ),
    { x: 216.66666666666669, y: 216.66666666666669 }
  );
});
