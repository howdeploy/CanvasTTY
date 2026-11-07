import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { drawTerminalWebglSnapshot } from "../src/renderer/src/features/terminal/terminalWebglFrames.ts";

test("a snapshot redraws the complete grid synchronously without patching ordinary rendering", () => {
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
  const original = renderer.renderRows;
  assert.equal(drawTerminalWebglSnapshot({ _renderer: renderer }, 2), true);
  assert.deepEqual(pixels, model);
  model.delete(0);
  assert.equal(drawTerminalWebglSnapshot({ _renderer: renderer }, 2), true);
  assert.deepEqual([...pixels], [[1, "unchanged row"]]);
  assert.deepEqual(calls, ["clearColor", "clear", [0, 1], "clearColor", "clear", [0, 1]]);
  assert.equal(renderer.renderRows, original);
  renderer.renderRows(0, 0);
  assert.deepEqual(calls.at(-1), [0, 0], "ordinary frames do not incur our snapshot clear");
});

test("incompatible xterm internals are refused without replacing their renderer", () => {
  const renderRows = () => {};
  for (const addon of [null, {}, { _renderer: {} }, { _renderer: { renderRows } },
    { _renderer: { renderRows, _gl: {} } }]) {
    assert.equal(drawTerminalWebglSnapshot(addon, 24), false);
    if (addon?._renderer?.renderRows) assert.equal(addon._renderer.renderRows, renderRows);
  }
});

test("WebGL buffers are redrawn only for transition readback instead of preserved for every card", async () => {
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(card, /const webgl = new WebglAddon\(\);/u);
  assert.match(card, /drawTerminalWebglSnapshot\(webglAddonRef\.current, terminal\.rows\)/u);
  assert.match(card, /catch \{\s+\/\/[^\n]+\n\s+rendererCacheRef\.current\?\.release\(webgl\);\s+webgl\.dispose\(\);\s+restoreRendererTransition\(\);\s+return false;/u);
  assert.ok(card.indexOf("drawTerminalWebglSnapshot(webglAddonRef.current") < card.indexOf("context.drawImage(canvas"));
});

test("off-screen release skips snapshot work but still frees WebGL and refits the DOM grid", async () => {
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  const start = card.indexOf("  const disableWebgl =");
  const source = card.slice(start, card.indexOf("\n  useEffect(", start));
  let snapshots = 0, disposals = 0, fits = 0, reveals = 0;
  const addon = { dispose: () => { disposals++; } };
  const webglAddonRef = { current: addon };
  const release = runInNewContext(stripTypeScriptTypes(source + "\ndisableWebgl;"), {
    webglAddonRef, rendererCacheRef: { current: null }, fitRef: { current: () => { fits++; } }, asciiBackgroundRef: { current: false },
    beginRendererTransition: () => { snapshots++; return {}; },
    revealRendererTransition: () => { reveals++; }
  });
  const terminal = { element: { dataset: { renderer: "webgl" }, querySelector: () => null, setAttribute() {} } };
  release(terminal, false);
  assert.deepEqual([snapshots, disposals, fits, reveals], [0, 1, 1, 0]);
  webglAddonRef.current = addon;
  release(terminal, true);
  assert.deepEqual([snapshots, disposals, fits, reveals], [1, 2, 2, 1]);
});
