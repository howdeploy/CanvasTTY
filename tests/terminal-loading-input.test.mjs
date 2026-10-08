import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SHORTCUTS } from "../src/shared/contracts.ts";
import { terminalLoadingKeySequence } from "../src/renderer/src/features/terminal/terminalLoadingInput.ts";
import { SHIFT_ENTER_SEQUENCE } from "../src/renderer/src/features/terminal/terminalShortcuts.ts";

const key = (code, options = {}) => ({
  type: "keydown", key: options.key ?? code, code, isComposing: false,
  ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...options
});

test("the loading terminal forwards control keys and preserves the existing Codex submit bindings", () => {
  assert.equal(terminalLoadingKeySequence(key("KeyC", { key: "c", ctrlKey: true }), "terminal", false, DEFAULT_SHORTCUTS), "\u0003");
  assert.equal(terminalLoadingKeySequence(key("KeyD", { key: "d", ctrlKey: true }), "terminal", false, DEFAULT_SHORTCUTS), "\u0004");
  assert.equal(terminalLoadingKeySequence(key("ArrowLeft"), "terminal", false, DEFAULT_SHORTCUTS), "\u001b[D");
  assert.equal(terminalLoadingKeySequence(key("Backspace"), "terminal", false, DEFAULT_SHORTCUTS), "\u007f");
  assert.equal(terminalLoadingKeySequence(key("Enter", { key: "Enter" }), "codex", false, DEFAULT_SHORTCUTS), "\r");
  assert.equal(terminalLoadingKeySequence(key("Enter", { key: "Enter", shiftKey: true }), "terminal", false, DEFAULT_SHORTCUTS), SHIFT_ENTER_SEQUENCE);
  assert.equal(terminalLoadingKeySequence(key("Enter", { key: "Enter", shiftKey: true }), "codex", false, DEFAULT_SHORTCUTS), "\u001b[13;2u");
  assert.equal(terminalLoadingKeySequence(key("KeyA", { key: "a", metaKey: true }), "codex", true, DEFAULT_SHORTCUTS), "\u001b[97;9u");
});

test("IME, app chords and native clipboard chords are left to the focused textarea or existing app handling", () => {
  assert.equal(terminalLoadingKeySequence(key("KeyA", { key: "a", isComposing: true }), "terminal", false, DEFAULT_SHORTCUTS), null);
  assert.equal(terminalLoadingKeySequence(key("KeyC", { key: "c", metaKey: true }), "terminal", true, DEFAULT_SHORTCUTS), null);
  assert.equal(terminalLoadingKeySequence(key("KeyV", { key: "v", metaKey: true }), "terminal", true, DEFAULT_SHORTCUTS), null);
  assert.equal(terminalLoadingKeySequence(key("KeyP", { key: "p", ctrlKey: true, shiftKey: true }), "terminal", false, DEFAULT_SHORTCUTS), null);
  assert.equal(terminalLoadingKeySequence(key("KeyV", { key: "v", ctrlKey: true, shiftKey: true }), "terminal", false, DEFAULT_SHORTCUTS), null);
  assert.equal(terminalLoadingKeySequence(key("KeyA", { key: "a", ctrlKey: true }), "terminal", false, DEFAULT_SHORTCUTS,
    { submit: "Ctrl+Enter", submitAlternate: "Ctrl+Shift+Enter", submitSuper: "Meta+Enter", newline: "Shift+Enter", selectAll: "Ctrl+A" }), "\u001b[97;5u");
});
