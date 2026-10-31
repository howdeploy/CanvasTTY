import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/renderer/src/features/workspace/WorkspaceCanvas.tsx", import.meta.url), "utf8");
const cardStart = source.indexOf("<BrowserCard");
assert.ok(cardStart >= 0);
const visible = source.slice(cardStart, source.indexOf("/>", cardStart)).match(/\bvisible=\{([^}]+)\}/)?.[1];
assert.ok(visible, "test executes the production BrowserCard visibility decision");
const nativeContentVisible = source.match(/const nativeContentVisible = ([\s\S]*?);/)?.[1];
assert.ok(nativeContentVisible, "test executes the shared native content visibility decision");
const evaluateVisibility = new Function("state", `with (state) { const nativeContentVisible = (${nativeContentVisible}); return (${visible}); }`);

const unobstructed = {
  browserViewVisible: true,
  fullscreenSessionId: null,
  homeEditing: false,
  contextMenu: null,
  regionEditor: null,
  commandPaletteOpen: false,
  radialLauncher: null,
  browserOccluded: false,
  browserUnderOverlay: false
};

test("native Browser visibility follows terminal fullscreen enter, switch and exit", () => {
  const state = { ...unobstructed };
  assert.equal(evaluateVisibility(state), true);
  for (const fullscreenSessionId of ["shell", "agent", null, "shell", null]) {
    state.fullscreenSessionId = fullscreenSessionId;
    assert.equal(evaluateVisibility(state), fullscreenSessionId === null,
      fullscreenSessionId === null ? "exiting restores Browser visibility" : "any fullscreen terminal hides Browser");
  }
});

test("exiting fullscreen still respects every existing Browser visibility blocker", () => {
  for (const patch of [
    { browserViewVisible: false }, { homeEditing: true }, { contextMenu: {} },
    { regionEditor: {} }, { commandPaletteOpen: true }, { radialLauncher: {} },
    { browserOccluded: true }, { browserUnderOverlay: true }
  ]) {
    const state = { ...unobstructed, ...patch, fullscreenSessionId: "shell" };
    assert.equal(evaluateVisibility(state), false);
    state.fullscreenSessionId = null;
    assert.equal(evaluateVisibility(state), false, JSON.stringify(patch));
  }
});
