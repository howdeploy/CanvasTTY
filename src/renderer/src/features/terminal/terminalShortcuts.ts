import { matchesPhysicalOrLayoutKey, matchesShortcut } from "../../lib/shortcuts.ts";
import type { ShortcutBindings } from "../../../../shared/contracts.ts";

interface TerminalKeyEvent {
  type: string;
  key: string;
  code: string;
  repeat?: boolean;
  isComposing?: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export const SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";
export const CODEX_SELECT_ALL_SEQUENCE = "\u001b[97;9u";

/** Preserve modifiers for native editor actions even when xterm lacks Super encoding. */
export function codexShortcutSequence(event: TerminalKeyEvent): string | null {
  if (event.type !== "keydown" || event.isComposing) return null;
  const modifiers = 1 + Number(event.shiftKey) + 2 * Number(event.altKey)
    + 4 * Number(event.ctrlKey) + 8 * Number(event.metaKey);
  const key = event.code || event.key;
  const letter = /^Key([A-Z])$/.exec(key);
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(key);
  const codepoint = letter ? letter[1]!.toLowerCase().charCodeAt(0) : digit ? digit[1]!.charCodeAt(0)
    : ({ Enter: 13, NumpadEnter: 13, Space: 32, Tab: 9, Escape: 27, Backspace: 127, Comma: 44 } as Record<string, number>)[key];
  if (codepoint !== undefined) return `\u001b[${codepoint};${modifiers}u`;
  const suffix = ({ ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F",
    F1: "P", F2: "Q", F3: "R", F4: "S" } as Record<string, string>)[key];
  if (suffix) return `\u001b[1;${modifiers}${suffix}`;
  const tilde = ({ Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19,
    F9: 20, F10: 21, F11: 23, F12: 24 } as Record<string, number>)[key];
  if (tilde !== undefined) return `\u001b[${tilde};${modifiers}~`;
  const functionKey = /^F(\d+)$/.exec(key);
  return functionKey ? `\u001b[${57363 + Number(functionKey[1])};${modifiers}u` : null;
}

export function codexEnterSequence(event: TerminalKeyEvent, provider: string): string | null {
  if (provider !== "codex" || event.type !== "keydown" || event.isComposing
    || !(event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter")) return null;
  const modifiers = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0)
    + (event.ctrlKey ? 4 : 0) + (event.metaKey ? 8 : 0);
  return modifiers === 1 ? "\r" : `\u001b[13;${modifiers}u`;
}

/** True for the Claude editor keys on a macOS Claude card ("Claude draft keys" on); other platforms keep theirs. */
function claudeEditorKey(event: TerminalKeyEvent, isMacOS: boolean, provider: string): boolean {
  return isMacOS && provider === "claude" && event.type === "keydown" && !event.isComposing;
}

/**
 * What the Claude editor's submit and newline keys send while Claude's prompt box is on screen: submit is
 * Claude's own Enter, newline is Shift+Enter. The caller checks the prompt box; elsewhere (dialogs, menus
 * without a prompt) Enter keeps its usual meaning. null: not one of these keys.
 */
export function claudeEnterSequence(
  event: TerminalKeyEvent,
  isMacOS: boolean,
  provider: string,
  bindings: Pick<ShortcutBindings, "claudeSubmit" | "claudeNewline" | "claudeNewlineAlternate">
): string | null {
  if (!claudeEditorKey(event, isMacOS, provider)) return null;
  if (bindings.claudeSubmit && matchesShortcut(event, bindings.claudeSubmit)) return "\r";
  if ([bindings.claudeNewline, bindings.claudeNewlineAlternate].some((binding) => binding && matchesShortcut(event, binding))) {
    return SHIFT_ENTER_SEQUENCE;
  }
  return null;
}

/**
 * What a key does to a macOS Claude card's whole-draft selection (Claude editor "select" key, Command+A by
 * default). Claude has no selection of its own, so CanvasTTY keeps it: the copy key copies the draft, the cut
 * key cuts it, typing, the terminal paste key or the delete key replace it, any other key drops the selection
 * and reaches Claude as usual. Without a selection the cut key does nothing. An empty binding is switched off.
 * null: not a draft key, handle the event normally.
 */
export type ClaudeDraftKeyIntent = "select" | "copy" | "cut" | "clear" | "replace" | "paste" | "swallow" | "deselect";

export type ClaudeDraftBindings = Pick<ShortcutBindings,
  "claudeSelectAll" | "claudeCopy" | "claudeCut" | "claudeClear" | "terminalPaste">;

const MODIFIER_KEYS = new Set(["Shift", "Meta", "Alt", "Control", "CapsLock", "Fn"]);

export function claudeDraftKeyIntent(
  event: TerminalKeyEvent,
  isMacOS: boolean,
  provider: string,
  selected: boolean,
  bindings: ClaudeDraftBindings
): ClaudeDraftKeyIntent | null {
  if (!claudeEditorKey(event, isMacOS, provider) || MODIFIER_KEYS.has(event.key)) return null;
  const pressed = (binding: string) => binding !== "" && matchesShortcut(event, binding);
  // A held shortcut repeats; only its first press acts, so holding the cut key cannot fire a burst of cuts.
  const once = (intent: ClaudeDraftKeyIntent): ClaudeDraftKeyIntent => event.repeat ? "swallow" : intent;
  if (pressed(bindings.claudeSelectAll)) return once("select");
  if (pressed(bindings.claudeCut)) return selected ? once("cut") : "swallow";
  if (!selected) return null;
  if (pressed(bindings.claudeCopy)) return once("copy");
  if (pressed(bindings.terminalPaste)) return once("paste");
  // The Mac delete key is Backspace; forward delete (fn+delete) clears the selection with it.
  if (pressed(bindings.claudeClear) || (bindings.claudeClear === "Backspace" && pressed("Delete"))) return "clear";
  if (event.metaKey || event.ctrlKey) return "deselect";
  return [...event.key].length === 1 ? "replace" : "deselect";
}

/** Rows of Claude's prompt box on screen: between the last two horizontal rules. */
export function claudePromptRows(lines: readonly string[]): { first: number; last: number } | null {
  const rules: number[] = [];
  for (let row = lines.length - 1; row >= 0 && rules.length < 2; row -= 1) {
    if (/^─{20,}/.test(lines[row]!.trimStart())) rules.push(row);
  }
  if (rules.length < 2 || rules[0]! - rules[1]! < 2) return null;
  return { first: rules[1]! + 1, last: rules[0]! - 1 };
}

export function shouldSelectCodexDraft(event: TerminalKeyEvent, isMacOS: boolean, provider: string): boolean {
  return isMacOS && provider === "codex"
    && event.type === "keydown"
    && event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    && matchesPhysicalOrLayoutKey(event, "KeyA", "a");
}

export function isMacTerminalClipboardShortcut(event: TerminalKeyEvent): boolean {
  return event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    && (matchesPhysicalOrLayoutKey(event, "KeyC", "c")
      || matchesPhysicalOrLayoutKey(event, "KeyV", "v"));
}

export function shouldTogglePixelSkinMasterView(
  event: TerminalKeyEvent,
  selectedTerminalExists: boolean,
  reservedShortcuts: readonly string[],
  binding = "F4"
): boolean {
  return selectedTerminalExists
    && event.type === "keydown"
    && !event.repeat
    && matchesShortcut(event, binding)
    && !reservedShortcuts.some((shortcut) => matchesShortcut(event, shortcut));
}

export function shouldSendTerminalLineBreak(event: TerminalKeyEvent): boolean {
  return event.type === "keydown"
    && (event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter")
    && event.shiftKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey;
}

export function shouldCopyTerminalSelection(event: TerminalKeyEvent, hasSelection: boolean, bindings?: ShortcutBindings): boolean {
  if (bindings) return event.type === "keydown" && hasSelection && matchesShortcut(event, bindings.terminalCopy);
  if (event.type !== "keydown" || !hasSelection || event.altKey) return false;

  if (!matchesPhysicalOrLayoutKey(event, "KeyC", "c")) return false;

  return (event.ctrlKey && !event.metaKey)
    || (event.metaKey && !event.ctrlKey && !event.shiftKey);
}

export function shouldPasteTerminalClipboard(event: TerminalKeyEvent, bindings?: ShortcutBindings): boolean {
  if (bindings) return event.type === "keydown" && matchesShortcut(event, bindings.terminalPaste);
  if (event.type !== "keydown" || event.altKey) return false;

  if (event.code === "Insert" || event.key === "Insert") {
    return event.shiftKey && !event.ctrlKey && !event.metaKey;
  }
  if (!matchesPhysicalOrLayoutKey(event, "KeyV", "v")) return false;

  return (event.ctrlKey && event.shiftKey && !event.metaKey)
    || (event.metaKey && !event.ctrlKey && !event.shiftKey);
}

export function shouldScrollTerminalPage(event: TerminalKeyEvent, bindings?: ShortcutBindings): -1 | 0 | 1 {
  if (event.type !== "keydown") return 0;
  if (bindings) return matchesShortcut(event, bindings.terminalPageUp) ? -1
    : matchesShortcut(event, bindings.terminalPageDown) ? 1 : 0;
  if (event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return 0;
  if (event.key === "PageUp" || event.code === "PageUp") return -1;
  if (event.key === "PageDown" || event.code === "PageDown") return 1;
  return 0;
}

export function shouldRestartExitedTerminal(event: TerminalKeyEvent, exited: boolean, bindings?: ShortcutBindings): boolean {
  if (bindings) return exited && event.type === "keydown" && matchesShortcut(event, bindings.terminalRestart);
  return exited
    && event.type === "keydown"
    && matchesPhysicalOrLayoutKey(event, "KeyD", "d")
    && event.ctrlKey
    && !event.shiftKey
    && !event.metaKey
    && !event.altKey;
}

export function shouldSearchTerminalOutput(event: TerminalKeyEvent, bindings?: ShortcutBindings): boolean {
  if (bindings) return event.type === "keydown" && matchesShortcut(event, bindings.terminalSearch);
  return event.type === "keydown"
    && matchesPhysicalOrLayoutKey(event, "KeyF", "f")
    && event.ctrlKey
    && event.shiftKey
    && !event.metaKey
    && !event.altKey;
}
