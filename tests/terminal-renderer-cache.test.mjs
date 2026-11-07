import assert from "node:assert/strict";
import test from "node:test";
import { cacheTerminalRenderers } from "../src/renderer/src/features/terminal/terminalRendererCache.ts";

function harness() {
  const calls = [];
  const element = () => ({ style: { visibility: "" }, setAttribute() {}, removeAttribute() {} });
  const renderer = (name, dom = false) => ({
    ...(dom ? { _rowContainer: element(), _selectionContainer: element() } : { _canvas: element() }),
    dispose() { calls.push(`dispose:${name}`); },
    handleResize() { calls.push(`resize:${name}`); },
    handleDevicePixelRatioChange() { calls.push(`dpr:${name}`); },
    handleFocus() {}, handleBlur() {},
    renderRows() { calls.push(`rows:${name}`); },
    _handleOptionsChanged() { calls.push(`options:${name}`); }
  });
  const dom = renderer("dom", true), webgl = renderer("webgl");
  let current = dom;
  const service = {
    _renderer: {
      get value() { return current; },
      set value(next) { if (current !== next) { current.dispose(); current = next; } }
    },
    setRenderer(next) { this._renderer.value = next; calls.push("subscribe"); },
    refreshRows() {}
  };
  const originalFactory = () => { throw new Error("a zoom must reuse the DOM renderer"); };
  const core = { _renderService: service, _createRenderer: originalFactory };
  const doc = { defaultView: { devicePixelRatio: 1 }, activeElement: null };
  const terminal = { _core: core, cols: 80, rows: 24, element: { ownerDocument: doc } };
  return { calls, dom, webgl, service, core, doc, terminal, originalFactory };
}

test("renderer switches preserve live layers, suppress parked work and keep one redraw subscription", () => {
  const h = harness(), originalSetter = h.service.setRenderer;
  const cache = cacheTerminalRenderers(h.terminal);
  assert.ok(cache);
  h.service.setRenderer(h.webgl);
  assert.equal(h.dom._rowContainer.style.visibility, "hidden");
  h.calls.length = 0;
  h.dom._handleOptionsChanged();
  h.dom.renderRows(0, 23);
  assert.deepEqual(h.calls, [], "a parked renderer cannot change the active grid");
  for (let i = 0; i < 5; i++) {
    cache.dom();
    assert.equal(h.service._renderer.value, h.dom);
    assert.equal(h.dom._rowContainer.style.visibility, "");
    assert.equal(h.webgl._canvas.style.visibility, "hidden");
    cache.webgl({ _renderer: h.webgl });
  }
  assert.ok(!h.calls.includes("dispose:dom") && !h.calls.includes("dispose:webgl"));
  assert.ok(!h.calls.includes("subscribe"), "cached swaps never accumulate event subscriptions");
  h.doc.defaultView.devicePixelRatio = 2;
  cache.dom();
  assert.equal(h.calls.filter((call) => call === "dpr:dom").length, 1);
  cache.release({ _renderer: h.webgl });
  h.webgl.dispose();
  assert.equal(h.calls.filter((call) => call === "dispose:webgl").length, 1);
  cache.dispose();
  assert.equal(h.core._createRenderer, h.originalFactory);
  assert.equal(h.service.setRenderer, originalSetter);
  h.dom.dispose();
  assert.equal(h.calls.filter((call) => call === "dispose:dom").length, 1);
});

test("unknown xterm internals keep the original renderer path", () => {
  assert.equal(cacheTerminalRenderers({}), null);
  assert.equal(cacheTerminalRenderers({ _core: { _renderService: {} } }), null);
});

test("a resumed DOM renderer measures missing glyphs together with the exact xterm spans", () => {
  const h = harness(), steps = [];
  const cells = [
    { text: "a", bold: false, italic: false },
    { text: "a", bold: false, italic: false },
    { text: "a", bold: true, italic: false },
    { text: "界", bold: false, italic: true }
  ];
  h.terminal.buffer = { active: { viewportY: 0, getLine: (y) => y === 0 ? {
    length: cells.length,
    getCell: (x) => ({ getChars: () => cells[x].text, isBold: () => cells[x].bold, isItalic: () => cells[x].italic })
  } : undefined } };
  const flat = new Float32Array(256).fill(-9999), holey = new Map();
  h.dom._widthCache = {
    _flat: flat, _holey: holey,
    _container: {
      ownerDocument: { createDocumentFragment: () => ({ children: [], append(element) { this.children.push(element); } }) },
      append(fragment) { steps.push(["append", fragment.children.map((element) => element.textContent)]); }
    },
    _measureElements: [0, 1, 2, 3].map((variant) => ({ cloneNode: () => ({
      textContent: "",
      get offsetWidth() { steps.push(["read", variant]); return 32 * (10 + variant); },
      remove() { steps.push(["remove", variant]); }
    }) }))
  };
  const cache = cacheTerminalRenderers(h.terminal);
  h.service.setRenderer(h.webgl);
  cache.dom();
  assert.deepEqual(steps[0], ["append", ["a".repeat(32), "a".repeat(32), "界".repeat(32)]]);
  assert.deepEqual(steps.slice(1, 4), [["read", 0], ["read", 1], ["read", 2]]);
  assert.ok(steps.slice(4).every(([step]) => step === "remove"));
  assert.equal(flat[97], 10);
  assert.equal(holey.get("aB"), 11);
  assert.equal(holey.get("界I"), 12);
  steps.length = 0;
  cache.webgl({ _renderer: h.webgl });
  cache.dom();
  assert.ok(!steps.some(([step]) => step === "read"), "unchanged widths survive another zoom cycle");
  cache.dispose();
});
