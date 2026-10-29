import { matchesPhysicalOrLayoutKey, matchesShortcut } from "../../lib/shortcuts.ts";
import type { ShortcutBindings } from "../../../../shared/contracts.ts";
export { codexShortcutSequence } from "../../../../shared/codexKeyboard.ts";

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

export function codexEnterSequence(event: TerminalKeyEvent, provider: string): string | null {
  if (provider !== "codex" || event.type !== "keydown" || event.isComposing
    || !(event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter")) return null;
  const modifiers = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0)
    + (event.ctrlKey ? 4 : 0) + (event.metaKey ? 8 : 0);
  return modifiers === 1 ? "\r" : `\u001b[13;${modifiers}u`;
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
