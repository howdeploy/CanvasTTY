import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findAll, importWithFakeReact } from "./helpers/fake-react.mjs";

async function fixture(t) {
  const component = await importWithFakeReact("src/renderer/src/features/browser/BrowserCard.tsx", "BrowserCard");
  component.__reset();
  const previous = { window: globalThis.window };
  globalThis.window = { canvasTTY: { window: { isMacOS: true }, browser: {
    setViewport() {}, setInputFocused() {}, onCanvasPointer: () => () => {},
    onCanvasFreezeFrame: () => () => {}
  } } };
  t.after(() => { component.__unmount(); Object.assign(globalThis, previous); });
  const camera = { x: 0, y: 0, zoom: 1 };
  const noop = () => {};
  return (downloads) => {
    const tree = component.__render(component.BrowserCard, {
      browser: { tabs: [], activeTabId: null, agents: [], downloads, pendingDialog: null },
      bounds: { position: { x: 0, y: 0 }, size: { width: 800, height: 600 } },
      camera: { get: () => camera, subscribe: () => noop }, locale: "en", visible: true,
      stackIndex: 1, uiScale: 1, snapEnabled: false, focusActivation: "single", focused: false,
      selected: false, showAgentPresence: true, getSnapTargets: () => [],
      onBoundsChange: noop, onActivate: noop, onSelect: noop, onWidgetFocus: noop,
      onWidgetHoverChange: noop, onClose: noop, onError: noop
    });
    return findAll(tree, (node) => node.type === "button"
      && node.props.className?.split(" ").includes("browser-card__downloads"))[0];
  };
}

const badgeClass = "browser-card__download-count";

test("empty downloads button keeps its icon out of the absolute count badge rule", async (t) => {
  const render = await fixture(t);
  const button = render([]);
  const iconElement = findAll(button, (node) => node.props.name === "download")[0];
  const icon = iconElement.type(iconElement.props);
  assert.equal(icon.type, "span", "exercise the UiIcon span that used to match :last-child");
  assert.ok(!icon.props.className.split(" ").includes(badgeClass));
  assert.equal(findAll(button, (node) => node.props.className === badgeClass).length, 0);
  const css = await readFile(new URL("../src/renderer/src/styles/app.css", import.meta.url), "utf8");
  // The badge must have an explicit target: the last child is the icon when the count is absent.
  assert.doesNotMatch(css, /\.browser-card__downloads\s*>\s*span:last-child/);
  assert.match(css, /\.browser-card__download-count\s*\{[^}]*position:\s*absolute;[^}]*right:\s*-2px;[^}]*top:\s*-3px;/);
});

test("completed downloads retain a separate total count badge", async (t) => {
  const render = await fixture(t);
  const button = render([{ id: "a", status: "completed", startedAt: 1 }, { id: "b", status: "completed", startedAt: 2 }]);
  const badges = findAll(button, (node) => node.props.className === badgeClass);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].props.children, 2);
  assert.ok(!button.props.className.includes("browser-card__downloads--active"));
});

test("active downloads keep the active count and icon animation class separate from the badge", async (t) => {
  const render = await fixture(t);
  const button = render([{ id: "a", status: "completed", startedAt: 1 },
    { id: "b", status: "pending", startedAt: 2 }, { id: "c", status: "progressing", startedAt: 3 }]);
  const badges = findAll(button, (node) => node.props.className === badgeClass);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].props.children, 2, "active count takes precedence over the total");
  assert.ok(button.props.className.includes("browser-card__downloads--active"));
});
