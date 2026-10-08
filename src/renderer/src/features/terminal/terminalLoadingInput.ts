import type { ShortcutBindings } from "../../../../shared/contracts.ts";
import { matchesShortcut } from "../../lib/shortcuts.ts";
import {
  CODEX_SELECT_ALL_SEQUENCE,
  SHIFT_ENTER_SEQUENCE,
  codexEnterSequence,
  codexShortcutSequence,
  shouldSelectCodexDraft,
  shouldSendTerminalLineBreak
} from "./terminalShortcuts.ts";

interface TerminalLoadingKeyEvent {
  type: string;
  key: string;
  code: string;
  isComposing?: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

interface NativeEditorBindings {
  submit: string;
  submitAlternate: string;
  submitSuper: string;
  newline: string;
  selectAll: string;
}

/**
 * Translate the small set of key events a loading terminal cannot leave to xterm.
 * Printable text, clipboard paste and IME commits arrive through its textarea's
 * input events and should be forwarded verbatim instead of replayed later.
 */
export function terminalLoadingKeySequence(
  event: TerminalLoadingKeyEvent,
  provider: string,
  isMacOS: boolean,
  shortcuts: ShortcutBindings,
  nativeEditor?: NativeEditorBindings
): string | null {
  if (event.type !== "keydown" || event.isComposing) return null;

  if (nativeEditor && Object.values(nativeEditor).some((binding) => matchesShortcut(event, binding))) {
    return codexShortcutSequence(event);
  }

  const codexEnter = codexEnterSequence(event, provider);
  if (codexEnter !== null) return codexEnter;
  if (!nativeEditor && shouldSelectCodexDraft(event, isMacOS, provider)) return CODEX_SELECT_ALL_SEQUENCE;
  if (!nativeEditor && shouldSendTerminalLineBreak(event)) return SHIFT_ENTER_SEQUENCE;

  const key = event.code || event.key;
  if (event.metaKey) return null;

  // Don't turn configured clipboard shortcuts into control characters. The
  // loading shell handles the terminal's paste binding separately; copy remains
  // native unless the terminal has an actual selection to copy.
  if (matchesShortcut(event, shortcuts.terminalPaste)) return null;

  // On non-macOS systems Alt+letter is the conventional ESC-prefixed shell key.
  // On macOS Option may compose printable characters, which the textarea handles.
  if (event.altKey && !event.ctrlKey && !isMacOS && event.key.length === 1) return `\u001b${event.key}`;

  if (event.ctrlKey && !event.altKey && !event.shiftKey) {
    const letter = /^Key([A-Z])$/.exec(key);
    if (letter) return String.fromCharCode(letter[1]!.charCodeAt(0) - 64);
    const controlKeys: Readonly<Record<string, string>> = {
      Space: "\u0000", Digit2: "\u0000", BracketLeft: "\u001b", Backslash: "\u001c",
      BracketRight: "\u001d", Digit6: "\u001e", Minus: "\u001f", Backspace: "\u0008"
    };
    const control = controlKeys[key];
    if (control !== undefined) return control;
  }

  if (event.ctrlKey || event.altKey || event.shiftKey) {
    // The app and OS own modified letter chords. xterm's configured terminal
    // actions above and the existing Codex bindings are the only chords consumed
    // by this proxy.
    const modifier = 1 + Number(event.shiftKey) + 2 * Number(event.altKey)
      + 4 * Number(event.ctrlKey) + 8 * Number(event.metaKey);
    const suffix = ({ ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" } as Record<string, string>)[key];
    if (suffix) return `\u001b[1;${modifier}${suffix}`;
    if (key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey) return "\u001b[Z";
    const tilde = ({ Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 } as Record<string, number>)[key];
    if (tilde !== undefined) return `\u001b[${tilde};${modifier}~`;
    return null;
  }

  const plain: Readonly<Record<string, string>> = {
    Enter: "\r", NumpadEnter: "\r", Tab: "\t", Escape: "\u001b", Backspace: "\u007f",
    ArrowUp: "\u001b[A", ArrowDown: "\u001b[B", ArrowRight: "\u001b[C", ArrowLeft: "\u001b[D",
    Home: "\u001b[H", End: "\u001b[F", Insert: "\u001b[2~", Delete: "\u001b[3~",
    PageUp: "\u001b[5~", PageDown: "\u001b[6~",
    F1: "\u001bOP", F2: "\u001bOQ", F3: "\u001bOR", F4: "\u001bOS",
    F5: "\u001b[15~", F6: "\u001b[17~", F7: "\u001b[18~", F8: "\u001b[19~",
    F9: "\u001b[20~", F10: "\u001b[21~", F11: "\u001b[23~", F12: "\u001b[24~"
  };
  const sequence = plain[key];
  if (sequence !== undefined) return sequence;

  return null;
}
