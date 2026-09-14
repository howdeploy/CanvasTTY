import assert from "node:assert/strict";
import test from "node:test";
import {
  displayCanvasNavigationBinding,
  matchesPhysicalOrLayoutKey,
  matchesPointerShortcut,
  matchesShortcut,
  shortcutFromKeyboardEvent,
  shortcutFromPointerEvent
} from "../src/renderer/src/lib/shortcuts.ts";

const keyEvent = (key, modifiers = {}) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...modifiers
});

test("captures and matches middle, back, and forward mouse buttons", () => {
  const pointerEvent = (button, modifiers = {}) => ({
    button,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers
  });
  assert.equal(shortcutFromPointerEvent(pointerEvent(1)), "Mouse3");
  assert.equal(shortcutFromPointerEvent(pointerEvent(3)), "Mouse4");
  assert.equal(shortcutFromPointerEvent(pointerEvent(4, { ctrlKey: true })), "Ctrl+Mouse5");
  assert.equal(shortcutFromPointerEvent(pointerEvent(0)), null);
  assert.equal(matchesPointerShortcut(pointerEvent(3), "Mouse4"), true);
});

test("captures plain defaults and canonical modifier order", () => {
  assert.equal(shortcutFromKeyboardEvent(keyEvent("Home")), "Home");
  assert.equal(shortcutFromKeyboardEvent(keyEvent("F2")), "F2");
  assert.equal(
    shortcutFromKeyboardEvent(keyEvent("r", { altKey: true, ctrlKey: true, shiftKey: true })),
    "Ctrl+Alt+Shift+R"
  );
});

test("ignores modifier-only and unsupported keys", () => {
  assert.equal(shortcutFromKeyboardEvent(keyEvent("Control", { ctrlKey: true })), null);
  assert.equal(shortcutFromKeyboardEvent(keyEvent("Unidentified")), null);
});

test("matches shortcuts without casing drift", () => {
  assert.equal(matchesShortcut(keyEvent("h", { ctrlKey: true }), "Ctrl+H"), true);
  assert.equal(matchesShortcut(keyEvent("h", { ctrlKey: true }), "Alt+H"), false);
});

test("a shortcut survives a non-Latin layout by preferring the physical key", () => {
  // Russian layout: the physical K key reports `key: "л"`. Recording and matching must
  // still agree on the same chord, otherwise no letter shortcut can be bound at all.
  const cyrillic = keyEvent("л", { code: "KeyK", ctrlKey: true });
  assert.equal(shortcutFromKeyboardEvent(cyrillic), "Ctrl+K");
  assert.equal(matchesShortcut(cyrillic, "Ctrl+K"), true);
  assert.equal(matchesPhysicalOrLayoutKey({ key: "л", code: "KeyK" }, "KeyK", "k"), true);
  assert.equal(matchesPhysicalOrLayoutKey({ key: "б", code: "Comma" }, "Comma", ","), true);
  // The `key` fallback still covers events that carry no usable code, so a mismatch in
  // both the code and the reported key is the only real negative.
  assert.equal(matchesPhysicalOrLayoutKey({ key: "л", code: "KeyX" }, "KeyK", "k"), false);
});

test("displays platform-neutral canvas navigation bindings with macOS key names", () => {
  assert.equal(displayCanvasNavigationBinding("Ctrl+Alt+Meta+Space", true), "Ctrl+Option+Command+Space");
  assert.equal(displayCanvasNavigationBinding("Ctrl+Alt", false), "Ctrl+Alt");
});
