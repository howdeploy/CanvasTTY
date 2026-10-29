import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canvasCardPropsEqual } from "../src/renderer/src/features/terminal/terminalCardProps.ts";

// A pan or zoom gesture renders the workspace on every pointer move. TerminalCard is memoized so those
// renders do not reach the cards: equal props skip the card, any real change does not. Snap targets reach the
// card as a getter that stays the same function, so a neighbour's move does not render it either.

const bounds = (x, y, width = 700, height = 430) => ({ position: { x, y }, size: { width, height } });
const session = { id: "s1", position: { x: 0, y: 0 }, size: { width: 700, height: 430 } };
const callbacks = { onActivate() {}, onSelect() {}, onBoundsChange() {}, getSnapTargets() { return []; } };
const props = (overrides = {}) => ({
  session, zoom: 1, focused: false, selected: false, stackIndex: 3,
  ...callbacks, ...overrides
});

test("a card's props compare equal across a pan: same data, same callbacks and snap-target getter", () => {
  assert.equal(canvasCardPropsEqual(props(), props()), true);
});

test("any real change renders the card", () => {
  for (const change of [
    { zoom: 0.49 }, { focused: true }, { selected: true }, { stackIndex: 4 },
    { session: { ...session, title: "renamed" } },
    { onSelect() {} }, { restoreEnabled: true }
  ]) {
    assert.equal(canvasCardPropsEqual(props(), props(change)), false, JSON.stringify(Object.keys(change)));
  }
});

test("TerminalCard is memoized and the workspace hands it callbacks that stay the same functions", async () => {
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(card, /export const TerminalCard = memo\(TerminalCardView, canvasCardPropsEqual\)/u);
  const workspace = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
  const cards = [...workspace.matchAll(/<TerminalCard\b([\s\S]*?)\/>/gu)].map((match) => match[1]);
  assert.equal(cards.length, 1, "canvas and fullscreen share the same card factory");
  for (const body of cards) {
    // A new arrow function per render would defeat the memo: every callback comes from the stable set.
    assert.doesNotMatch(body, /\bon[A-Z]\w*=\{[^}]*=>/u);
    assert.match(body, /\{\.\.\.\(fullscreen \? terminalCardCallbacks\.fullscreen : terminalCardCallbacks\.canvas\)\}/u);
    assert.match(body, /onToggleFullscreen=\{toggleFullscreenFor\(session\.id\)\}/u);
  }
  assert.match(workspace, /renderTerminalCard\(session, fullscreenSessionId === session\.id\)/u, "the persistent Mac host uses the shared factory");
  assert.match(workspace, /renderTerminalCard\(session, false\)/u, "the legacy canvas uses the shared factory");
  assert.match(workspace, /renderTerminalCard\(session, true\)/u, "the legacy fullscreen layer uses the shared factory");
  assert.match(workspace, /const terminalCardCallbacks = useMemo\(\(\) => \{[\s\S]*?\}, \[\]\);/u);
});
