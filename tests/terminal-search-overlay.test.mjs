import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { shouldSearchTerminalOutput } from "../src/renderer/src/features/terminal/terminalShortcuts.ts";

const terminalCardPath = new URL(
  "../src/renderer/src/features/terminal/TerminalCard.tsx",
  import.meta.url
);

const keydown = {
  type: "keydown",
  key: "f",
  code: "KeyF",
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  altKey: false
};

test("ctrl+shift+f opens the terminal scrollback search instead of reaching the PTY", () => {
  assert.equal(shouldSearchTerminalOutput({ ...keydown, ctrlKey: true, shiftKey: true }), true);
  assert.equal(shouldSearchTerminalOutput({ ...keydown, key: "F", ctrlKey: true, shiftKey: true }), true);
  assert.equal(shouldSearchTerminalOutput({ ...keydown, key: "А", code: "KeyF", ctrlKey: true, shiftKey: true }), true);
});

test("plain ctrl+f and unrelated chords stay with the terminal application", () => {
  assert.equal(shouldSearchTerminalOutput({ ...keydown, ctrlKey: true }), false);
  assert.equal(shouldSearchTerminalOutput({ ...keydown, shiftKey: true }), false);
  assert.equal(shouldSearchTerminalOutput({ ...keydown, metaKey: true, shiftKey: true }), false);
  assert.equal(shouldSearchTerminalOutput({ ...keydown, ctrlKey: true, shiftKey: true, altKey: true }), false);
  assert.equal(shouldSearchTerminalOutput({ ...keydown, ctrlKey: true, shiftKey: true, type: "keyup" }), false);
});

test("the search overlay keeps the keyboard and hands it back to the terminal on close", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /new SearchAddon\(\)/);
  assert.match(source, /terminal\.loadAddon\(searchAddon\)/);
  assert.match(source, /className="terminal-card__search"/);
  assert.match(source, /className="terminal-card__search-count"/);
  assert.match(source, /searchInputRef\.current\?\.focus\(\)/);
  assert.match(source, /addon\.clearDecorations\(\)/);
  assert.match(source, /if \(!renaming && !summaryMode\) terminalRef\.current\?\.focus\(\)/);
  // The canvas keydown handler owns window-level shortcuts; the card must not
  // race it with a second global listener.
  assert.doesNotMatch(source, /window\.addEventListener\("keydown"/);
});

test("provider titles from OSC 0/2 fill the header only until the user renames the session", async () => {
  const source = await readFile(terminalCardPath, "utf8");

  assert.match(source, /terminal\.onTitleChange\(/);
  assert.match(source, /visibleTerminalTitle\(\{ \.\.\.titleSource, cwdLabel: compactPath\(session\.cwd\) \}\)/);
  assert.doesNotMatch(source, /canvasTTY\.terminal\.rename\(session\.id, oscTitle/);
});
