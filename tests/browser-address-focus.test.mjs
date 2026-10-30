import assert from "node:assert/strict";
import test from "node:test";
import { findAll, importWithFakeReact } from "./helpers/fake-react.mjs";

async function fixture(t) {
  const component = await importWithFakeReact("src/renderer/src/features/browser/BrowserCard.tsx", "BrowserCard");
  component.__reset();
  const previous = { window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map();
  let nextFrame = 0;
  let pageFocus = 0;
  globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.window = { canvasTTY: { window: { isMacOS: true }, browser: {
    setViewport() {}, setInputFocused() {}, onCanvasPointer: () => () => {},
    onCanvasFreezeFrame: () => () => {}, focus() { pageFocus++; }
  } } };
  t.after(() => { component.__unmount(); Object.assign(globalThis, previous); });
  const camera = { x: 0, y: 0, zoom: 1 };
  const noop = () => {};
  const props = {
    browser: { tabs: [{ id: "page", url: "https://fixture.test/", agents: [], status: "ready" }],
      activeTabId: "page", agents: [], downloads: [], pendingDialog: null },
    bounds: { position: { x: 0, y: 0 }, size: { width: 800, height: 600 } },
    locale: "en", camera: { get: () => camera, subscribe: () => noop }, visible: true,
    stackIndex: 1, uiScale: 1, snapEnabled: false, focusActivation: "single", focused: false,
    selected: false, showAgentPresence: false, getSnapTargets: () => [],
    onBoundsChange: noop, onActivate: noop, onSelect: noop, onWidgetFocus: noop,
    onWidgetHoverChange: noop, onClose: noop, onError: noop
  };
  const render = (patch = {}) => component.__render(component.BrowserCard, Object.assign(props, patch));
  const address = (tree) => findAll(tree, (node) => node.type === "input" && node.props.name === "address")[0];
  const frame = () => {
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback();
  };
  return { render, address, frame, pageFocus: () => pageFocus };
}

test("the first address click after canvas focus does not hand focus to the native page", async (t) => {
  const h = await fixture(t);
  const tree = h.render();
  tree.props.onPointerDownCapture();
  h.address(tree).props.onFocus();
  h.render({ focused: true });
  h.frame();
  assert.equal(h.pageFocus(), 0, "the address owns input after its first click");
});

test("address focus arriving before the pending animation frame cancels native focus", async (t) => {
  const h = await fixture(t);
  h.render();
  const tree = h.render({ focused: true });
  h.address(tree).props.onFocus();
  h.frame();
  assert.equal(h.pageFocus(), 0, "the callback checks the current address focus");
});

test("activating Browser outside the address still focuses its page, while hiding cancels it", async (t) => {
  const h = await fixture(t);
  h.render();
  h.render({ focused: true });
  h.frame();
  assert.equal(h.pageFocus(), 1);
  h.render({ focused: false });
  h.render({ focused: true });
  h.render({ visible: false });
  h.frame();
  assert.equal(h.pageFocus(), 1, "a hidden surface cannot steal focus from fullscreen or an overlay");
});
