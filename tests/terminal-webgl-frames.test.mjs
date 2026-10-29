import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { clearPreservedWebglFrames } from "../src/renderer/src/features/terminal/terminalWebglFrames.ts";

test("transparent frames erase old glyphs, retain unchanged rows and remain available for snapshots", () => {
  const pixels = new Map([[0, "stale glyph"]]);
  const model = new Map([[0, "first row"], [1, "unchanged row"]]);
  const calls = [];
  const gl = {
    COLOR_BUFFER_BIT: 16384,
    clearColor: (...rgba) => {
      assert.deepEqual(rgba, [0, 0, 0, 0]);
      calls.push("clearColor");
    },
    clear: (mask) => {
      assert.equal(mask, gl.COLOR_BUFFER_BIT);
      pixels.clear();
      calls.push("clear");
    }
  };
  const renderer = {
    _gl: gl,
    renderRows(start, end) {
      assert.equal(this, renderer);
      calls.push([start, end]);
      // xterm updates only the dirty rows in its model, then draws the entire grid.
      for (const [row, text] of model) pixels.set(row, text);
    }
  };
  assert.equal(clearPreservedWebglFrames({ _renderer: renderer }), true);
  renderer.renderRows(0, 1);
  assert.deepEqual(pixels, model);
  model.delete(0);
  renderer.renderRows(0, 0);
  assert.deepEqual([...pixels], [[1, "unchanged row"]]);
  assert.deepEqual(calls, ["clearColor", "clear", [0, 1], "clearColor", "clear", [0, 0]]);
});

test("incompatible xterm internals are refused without replacing their renderer", () => {
  const renderRows = () => {};
  for (const addon of [null, {}, { _renderer: {} }, { _renderer: { renderRows } },
    { _renderer: { renderRows, _gl: {} } }]) {
    assert.equal(clearPreservedWebglFrames(addon), false);
    if (addon?._renderer?.renderRows) assert.equal(addon._renderer.renderRows, renderRows);
  }
});

test("every WebGL attachment installs the frame clear before becoming active and keeps snapshot readback", async () => {
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(card, /const webgl = new WebglAddon\(true\);/u);
  assert.match(card, /terminal\.loadAddon\(webgl\);\s+if \(!clearPreservedWebglFrames\(webgl\)\) throw new Error/u);
  assert.match(card, /catch \{\s+\/\/[^\n]+\n\s+webgl\.dispose\(\);\s+restoreRendererTransition\(\);\s+return false;/u);
  assert.ok(card.indexOf("clearPreservedWebglFrames(webgl)") < card.indexOf("webglAddonRef.current = webgl;"));
});
