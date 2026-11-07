import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { skipEmptySelectionRedraws } from "../src/renderer/src/features/terminal/terminalSelectionRedraw.ts";

// xterm refreshes the selection on every scroll; its DOM renderer rebuilds every row for each refresh,
// even off-screen. With no selection before and after, the refresh is dropped; real changes pass.

function fakeTerminal() {
  const calls = [];
  const service = {
    _selectionState: { start: undefined, end: undefined, columnSelectMode: false },
    handleSelectionChanged(start, end, columnSelectMode) {
      this._selectionState.start = start;
      this._selectionState.end = end;
      this._selectionState.columnSelectMode = columnSelectMode;
      calls.push([start, end, columnSelectMode]);
    }
  };
  return { terminal: { _core: { _renderService: service } }, service, calls };
}

test("an empty-to-empty selection refresh (every scroll) reaches no renderer", () => {
  const { terminal, service, calls } = fakeTerminal();
  skipEmptySelectionRedraws(terminal);
  for (let i = 0; i < 50; i++) service.handleSelectionChanged(undefined, undefined, false);
  assert.equal(calls.length, 0);
});

test("making, moving and clearing a selection all reach the renderer, in order", () => {
  const { terminal, service, calls } = fakeTerminal();
  skipEmptySelectionRedraws(terminal);
  service.handleSelectionChanged([0, 1], [5, 1], false); // made
  service.handleSelectionChanged([0, 1], [5, 1], false); // refreshed while it exists (it scrolls with output)
  service.handleSelectionChanged([0, 0], [5, 0], true);
  service.handleSelectionChanged(undefined, undefined, false); // cleared: the highlight must go
  service.handleSelectionChanged(undefined, undefined, false); // nothing left to clear
  assert.deepEqual(calls, [[[0, 1], [5, 1], false], [[0, 1], [5, 1], false], [[0, 0], [5, 0], true], [undefined, undefined, false]]);
  assert.equal(service._selectionState.start, undefined);
});

test("the guard is removable and leaves terminals without the internals alone", () => {
  const { terminal, service, calls } = fakeTerminal();
  const restore = skipEmptySelectionRedraws(terminal);
  restore();
  service.handleSelectionChanged(undefined, undefined, false);
  assert.equal(calls.length, 1);
  assert.doesNotThrow(() => skipEmptySelectionRedraws({})());
  assert.doesNotThrow(() => skipEmptySelectionRedraws({ _core: { _renderService: {} } })());
});

test("the guard matches the xterm build the app bundles and every card installs it", async () => {
  // The internals it relies on: the render service keeps the selection state and forwards the change.
  const xterm = await readFile(new URL("../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url), "utf8");
  assert.match(xterm, /handleSelectionChanged\(\w,\w,\w\)\{this\._selectionState\.start=\w,this\._selectionState\.end=\w/u);
  const card = await readFile(new URL("../src/renderer/src/features/terminal/TerminalCard.tsx", import.meta.url), "utf8");
  assert.match(card, /const restoreSelectionRedraws = skipEmptySelectionRedraws\(terminal\);/u);
  const restore = card.indexOf("restoreSelectionRedraws();");
  const dispose = card.indexOf("terminal.dispose();", restore);
  const cacheDispose = card.indexOf("rendererCache?.dispose();", restore);
  assert.ok(restore >= 0 && dispose > restore, "restore the selection guard before disposing the terminal");
  assert.ok(cacheDispose > restore && cacheDispose < dispose, "dispose cached renderers before disposing the terminal");
});


test("paused selections track their latest state and repaint once on resume, even without output", () => {
  const { terminal, service, calls } = fakeTerminal();
  Object.assign(service, { _isPaused: true, _needsSelectionRefresh: false, _needsFullRefresh: false });
  skipEmptySelectionRedraws(terminal);
  service.handleSelectionChanged([0, 1], [5, 1], false);
  service.handleSelectionChanged([0, 0], [5, 0], true);
  assert.equal(calls.length, 0, "hidden scrolling never reaches the DOM renderer");
  assert.deepEqual(service._selectionState, { start: [0, 0], end: [5, 0], columnSelectMode: true });
  service._needsFullRefresh = false;
  service.handleSelectionChanged(undefined, undefined, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(service._selectionState, { start: undefined, end: undefined, columnSelectMode: false });
  assert.equal(service._needsFullRefresh, true, "clearing without output requests a resume frame");
  assert.equal(service._needsSelectionRefresh, true, "the resume frame applies the final selection");
  service._isPaused = false;
  service.handleSelectionChanged([1, 2], [4, 2], false);
  assert.deepEqual(calls, [[[1, 2], [4, 2], false]], "visible selection changes still reach the renderer");
});

test("a paused service without the resume flags retains its original selection behavior", () => {
  const { terminal, service, calls } = fakeTerminal();
  service._isPaused = true;
  const restore = skipEmptySelectionRedraws(terminal);
  service.handleSelectionChanged([0, 1], [5, 1], false);
  assert.equal(calls.length, 1);
  restore();
  service.handleSelectionChanged(undefined, undefined, false);
  assert.equal(calls.length, 2);
});
