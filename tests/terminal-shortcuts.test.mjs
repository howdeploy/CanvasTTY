import assert from "node:assert/strict";
import test from "node:test";
import { keyboardPresetShortcuts } from "../src/shared/contracts.ts";
import {
  CODEX_SELECT_ALL_SEQUENCE,
  SHIFT_ENTER_SEQUENCE,
  isMacTerminalClipboardShortcut,
  shouldCopyTerminalSelection,
  shouldPasteTerminalClipboard,
  shouldRestartExitedTerminal,
  shouldScrollTerminalPage,
  shouldSendTerminalLineBreak,
  shouldSelectCodexDraft,
  shouldTogglePixelSkinMasterView
} from "../src/renderer/src/features/terminal/terminalShortcuts.ts";

const keydown = {
  type: "keydown",
  key: "c",
  code: "KeyC",
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  altKey: false
};

test("Command+A selects only a macOS Codex draft with the unmodified physical or layout chord", () => {
  const select = { ...keydown, key: "a", code: "KeyA", metaKey: true };
  assert.equal(shouldSelectCodexDraft(select, true, "codex"), true);
  assert.equal(shouldSelectCodexDraft({ ...select, key: "ф" }, true, "codex"), true);
  assert.equal(shouldSelectCodexDraft({ ...select, code: "", repeat: true }, true, "codex"), true);
  assert.equal(CODEX_SELECT_ALL_SEQUENCE, "\u001b[97;9u");
  assert.equal(shouldSelectCodexDraft(select, false, "codex"), false);
  for (const provider of ["terminal", "claude", "gemini", "grok"]) {
    assert.equal(shouldSelectCodexDraft(select, true, provider), false);
  }
  for (const event of [
    { ...select, metaKey: false, ctrlKey: true },
    { ...select, ctrlKey: true },
    { ...select, shiftKey: true },
    { ...select, altKey: true },
    { ...select, type: "keyup" },
    { ...select, key: "c", code: "KeyC" },
    { ...select, key: "ф", code: "KeyF" }
  ]) assert.equal(shouldSelectCodexDraft(event, true, "codex"), false);
});

test("macOS terminal adaptation handles only Command copy and paste", () => {
  assert.equal(isMacTerminalClipboardShortcut({ ...keydown, metaKey: true }), true);
  assert.equal(isMacTerminalClipboardShortcut({ ...keydown, key: "м", code: "KeyV", metaKey: true }), true);
  for (const event of [
    { ...keydown, ctrlKey: true },
    { ...keydown, key: "F2", code: "F2" },
    { ...keydown, key: "F4", code: "F4" },
    { ...keydown, key: "Home", code: "Home" },
    { ...keydown, key: "f", code: "KeyF", ctrlKey: true, shiftKey: true },
    { ...keydown, key: "Enter", code: "Enter", shiftKey: true },
    { ...keydown, key: "k", code: "KeyK", metaKey: true }
  ]) assert.equal(isMacTerminalClipboardShortcut(event), false);
});

test("copies a terminal selection with platform copy shortcuts", () => {
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true }, true), true);
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true, shiftKey: true }, true), true);
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true, shiftKey: true, key: "C" }, true), true);
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true, shiftKey: true, key: "С" }, true), true);
  assert.equal(shouldCopyTerminalSelection({ ...keydown, metaKey: true }, true), true);
});

test("configured platform copy bindings work with selection in English and Russian layouts", () => {
  for (const [preset, binding, modifiers] of [
    ["windows", "Ctrl+C", { ctrlKey: true }],
    ["linux", "Ctrl+Shift+C", { ctrlKey: true, shiftKey: true }],
    ["macos", "Meta+C", { metaKey: true }]
  ]) {
    const bindings = keyboardPresetShortcuts(preset);
    assert.equal(bindings.terminalCopy, binding);
    for (const key of ["c", "с"]) {
      const event = { ...keydown, ...modifiers, key };
      assert.equal(shouldCopyTerminalSelection(event, true, bindings), true, preset);
      assert.equal(shouldCopyTerminalSelection(event, false, bindings), false, preset);
      assert.equal(shouldCopyTerminalSelection({ ...event, type: "keyup" }, true, bindings), false, preset);
      assert.equal(shouldCopyTerminalSelection({ ...event, altKey: true }, true, bindings), false, preset);
    }
  }
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true }, true, keyboardPresetShortcuts("linux")), false);
});

test("leaves control-c without a selection and unrelated chords to the PTY", () => {
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true }, false), false);
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true, key: "Insert", code: "Insert" }, true), false);
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true, altKey: true }, true), false);
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true, key: "v", code: "KeyV" }, true), false);
  assert.equal(shouldCopyTerminalSelection({ ...keydown, ctrlKey: true, type: "keyup" }, true), false);
});

test("pastes with terminal shortcuts independently of the active layout", () => {
  const paste = { ...keydown, key: "v", code: "KeyV" };

  assert.equal(shouldPasteTerminalClipboard({ ...paste, ctrlKey: true, shiftKey: true }), true);
  assert.equal(shouldPasteTerminalClipboard({ ...paste, key: "М", ctrlKey: true, shiftKey: true }), true);
  assert.equal(shouldPasteTerminalClipboard({ ...paste, metaKey: true }), true);
  assert.equal(shouldPasteTerminalClipboard({ ...paste, key: "Insert", code: "Insert", shiftKey: true }), true);
});

test("leaves literal control-v and unrelated paste chords to the PTY", () => {
  const paste = { ...keydown, key: "v", code: "KeyV" };

  assert.equal(shouldPasteTerminalClipboard({ ...paste, ctrlKey: true }), false);
  assert.equal(shouldPasteTerminalClipboard({ ...paste, ctrlKey: true, shiftKey: true, altKey: true }), false);
  assert.equal(shouldPasteTerminalClipboard({ ...paste, ctrlKey: true, shiftKey: true, type: "keyup" }), false);
});

test("encodes shift-enter as a modified terminal enter key", () => {
  const enter = { ...keydown, key: "Enter", code: "Enter" };

  assert.equal(shouldSendTerminalLineBreak({ ...enter, shiftKey: true }), true);
  assert.equal(shouldSendTerminalLineBreak(enter), false);
  assert.equal(shouldSendTerminalLineBreak({ ...enter, shiftKey: true, ctrlKey: true }), false);
  assert.equal(shouldSendTerminalLineBreak({ ...enter, shiftKey: true, type: "keyup" }), false);
  assert.equal(SHIFT_ENTER_SEQUENCE, "\u001b[13;2u");
});

test("ctrl-d restarts only an exited terminal session", () => {
  const restart = { ...keydown, key: "d", code: "KeyD", ctrlKey: true };
  assert.equal(shouldRestartExitedTerminal(restart, true), true);
  assert.equal(shouldRestartExitedTerminal(restart, false), false);
  assert.equal(shouldRestartExitedTerminal({ ...restart, shiftKey: true }, true), false);
});

test("plain F4 toggles master detail and modified or repeated F4 stays with the app", () => {
  const f4 = { ...keydown, key: "F4", code: "F4" };

  assert.equal(shouldTogglePixelSkinMasterView(f4, true, []), true);
  assert.equal(shouldTogglePixelSkinMasterView({ ...f4, key: "Unidentified", code: "F4" }, true, []), true);
  assert.equal(shouldTogglePixelSkinMasterView(f4, false, []), false);
  assert.equal(shouldTogglePixelSkinMasterView(f4, true, ["F4"]), false);
  assert.equal(shouldTogglePixelSkinMasterView({ ...f4, type: "keyup" }, true, []), false);
  assert.equal(shouldTogglePixelSkinMasterView({ ...f4, repeat: true }, true, []), false);
  assert.equal(shouldTogglePixelSkinMasterView({ ...f4, ctrlKey: true }, true, []), false);
  assert.equal(shouldTogglePixelSkinMasterView({ ...f4, shiftKey: true }, true, []), false);
  assert.equal(shouldTogglePixelSkinMasterView({ ...f4, metaKey: true }, true, []), false);
  assert.equal(shouldTogglePixelSkinMasterView({ ...f4, altKey: true }, true, []), false);
});

test("configured Home or rename bindings take precedence over F4", () => {
  const f4 = { ...keydown, key: "F4", code: "F4" };

  assert.equal(shouldTogglePixelSkinMasterView(f4, true, ["F4"]), false);
  assert.equal(shouldTogglePixelSkinMasterView(f4, true, ["F2", "F4"]), false);
});

test("plain page-up and page-down page the scrollback viewport", () => {
  assert.equal(shouldScrollTerminalPage({ ...keydown, key: "PageUp", code: "PageUp" }), -1);
  assert.equal(shouldScrollTerminalPage({ ...keydown, key: "PageDown", code: "PageDown" }), 1);
  assert.equal(shouldScrollTerminalPage({ ...keydown, key: "PageUp", code: "" }), -1);
  assert.equal(shouldScrollTerminalPage({ ...keydown, key: "", code: "PageDown" }), 1);
});

test("modified page keys stay with the terminal application", () => {
  const pageUp = { ...keydown, key: "PageUp", code: "PageUp" };

  assert.equal(shouldScrollTerminalPage({ ...pageUp, shiftKey: true }), 0);
  assert.equal(shouldScrollTerminalPage({ ...pageUp, ctrlKey: true }), 0);
  assert.equal(shouldScrollTerminalPage({ ...pageUp, metaKey: true }), 0);
  assert.equal(shouldScrollTerminalPage({ ...pageUp, altKey: true }), 0);
  assert.equal(shouldScrollTerminalPage({ ...pageUp, type: "keyup" }), 0);
  assert.equal(shouldScrollTerminalPage(keydown), 0);
});
