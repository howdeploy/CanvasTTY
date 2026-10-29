import assert from "node:assert/strict";
import test from "node:test";
import { importWithFakeReact } from "./helpers/fake-react.mjs";

test("fullscreen repeatedly moves one portal host without disposing it, keeping focus, then removes it on unmount", async (t) => {
  let created = 0;
  let removed = 0;
  let moves = 0;
  const document = { activeElement: null, createElement() { created++; return new Element(); } };
  class Element {
    style = {};
    parentElement = null;
    ownerDocument = document;
    get isConnected() { return this.parentElement !== null; }
    contains(element) { return element === document.activeElement; }
    focus() { document.activeElement = this; }
    remove() { removed++; this.parentElement = null; }
    appendChild(node) { node.parentElement = this; document.activeElement = null; }
    moveBefore(node) { moves++; node.parentElement = this; }
  }
  const previousDocument = globalThis.document;
  const previousElement = globalThis.HTMLElement;
  globalThis.document = document;
  globalThis.HTMLElement = Element;
  t.after(() => { globalThis.document = previousDocument; globalThis.HTMLElement = previousElement; });
  const react = await importWithFakeReact("src/renderer/src/features/terminal/PersistentTerminalCardHost.tsx", "PersistentTerminalCardHost", {
    plugins: [{ name: "portal", setup(build) {
      build.onResolve({ filter: /^react-dom$/ }, () => ({ path: "portal", namespace: "test-portal" }));
      build.onLoad({ filter: /.*/, namespace: "test-portal" }, () => ({ contents: 'export const createPortal = (children, container) => ({ type: "portal", props: { children, container } });' }));
    } }]
  });
  const normal = new Element(), fullscreenLayer = new Element(), focused = new Element();
  const render = fullscreen => react.__render(react.PersistentTerminalCardHost, { children: { type: "xterm-card" }, fullscreen, fullscreenLayer });
  const first = render(true);
  const [anchor, portal] = first.props.children;
  anchor.props.ref.current = { parentElement: normal };
  const host = portal.props.container;
  assert.equal(host.parentElement, fullscreenLayer, "also supports mounting directly in fullscreen");
  document.activeElement = focused;
  for (const fullscreen of [false, true, false, true, false]) {
    const next = render(fullscreen);
    assert.equal(next.props.children[1].props.container, host, "React's portal target stays identical");
    assert.equal(host.parentElement, fullscreen ? fullscreenLayer : normal);
    assert.equal(document.activeElement, focused, "state-preserving DOM moves retain terminal focus");
  }
  assert.equal(created, 1);
  assert.equal(removed, 0);
  assert.equal(moves, 5);
  react.__unmount();
  assert.equal(removed, 1);
  assert.equal(host.isConnected, false);
});
