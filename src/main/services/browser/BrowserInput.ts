import { BrowserKernelError } from "./BrowserErrors.ts";

const KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft",
  "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"
]);
const MODIFIERS: Record<string, number> = { Ctrl: 2, Control: 2, Shift: 8, Alt: 1, Meta: 4 };

/** A bounded key chord, never arbitrary CDP input or a held modifier across tool calls. */
export function browserKeyChord(value: unknown): { key: string; code: string; modifiers: number; windowsVirtualKeyCode?: number } {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) throw invalidKey();
  const parts = value.split("+");
  const base = parts.pop()!;
  let modifiers = 0;
  for (const modifier of parts) {
    if (!Object.hasOwn(MODIFIERS, modifier)) throw invalidKey();
    const bit = MODIFIERS[modifier];
    if (!bit || (modifiers & bit)) throw invalidKey();
    modifiers |= bit;
  }
  if (!(KEYS.has(base) || /^[a-zA-Z0-9]$/.test(base))) throw invalidKey();
  const letter = /^[a-zA-Z]$/.test(base);
  const key = base === "Space" ? " " : letter && parts.length ? ((modifiers & 8) ? base.toUpperCase() : base.toLowerCase()) : base;
  const virtual: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
  return { key, code: letter ? 'Key' + base.toUpperCase() : /^[0-9]$/.test(base) ? 'Digit' + base : base,
    modifiers, windowsVirtualKeyCode: letter || /^[0-9]$/.test(base) ? base.toUpperCase().charCodeAt(0) : virtual[base] };
}
function invalidKey(): BrowserKernelError {
  return new BrowserKernelError("INVALID_INPUT", "Unsupported browser key. Use a named key or letter/digit, optionally prefixed by Ctrl/Control, Shift, Alt or Meta separated by +.");
}

export function browserTextMode(value: unknown): "legacy" | "insert" | "replace" {
  if (value === undefined) return "legacy";
  if (value === "insert" || value === "replace") return value;
  throw new BrowserKernelError("INVALID_INPUT", "Browser text mode must be insert or replace.");
}
