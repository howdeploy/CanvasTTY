interface CodexKeyEvent {
  type: string;
  key: string;
  code: string;
  isComposing?: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

// CanvasTTY maps physical shortcuts onto these stable actions, including Meta keys unsupported by Codex's keymap.
export const CODEX_KEYMAP_SUBMIT_SEQUENCE = "\r";
export const CODEX_KEYMAP_NEWLINE_SEQUENCE = "\u001b[13;2u";

/** Preserve modifiers for Codex editor actions even when xterm lacks Super encoding. */
export function codexShortcutSequence(event: CodexKeyEvent): string | null {
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

/** Submit programmatic prompts using the keymap of this launch, never the latest settings. */
export function codexPromptSubmit(data: string, binding?: string, submitSequence?: string): string | null {
  if (!data.endsWith("\r")) return data;
  if (submitSequence) return submitSequence === "\r" ? data : data.slice(0, -1) + submitSequence;
  if (!binding || binding === "Enter") return data;
  const parts = binding.split("+");
  const key = parts.pop()!;
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
  const sequence = codexShortcutSequence({
    type: "keydown", key, code,
    ctrlKey: parts.includes("Ctrl"), shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"), metaKey: parts.includes("Meta")
  });
  return sequence === null ? null : data.slice(0, -1) + sequence;
}
