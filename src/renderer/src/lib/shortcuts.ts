import {
  activeCanvasNavigationModifiers,
  canvasNavigationMouseButtonFromDomButton,
  canvasNavigationModifierFromKey,
  normalizeCanvasNavigationInputKey
} from "../../../shared/canvasNavigation.ts";

interface ShortcutEvent {
  key: string;
  /** Physical key, when the caller has it. `key` follows the layout, `code` does not. */
  code?: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Matches a physical key regardless of the active layout. On a Russian layout the K key
 * reports `key: "л"` while `code` stays `KeyK`, so a chord matched on `key` alone is dead
 * for anyone not typing Latin.
 */
export function matchesPhysicalOrLayoutKey(
  event: { key: string; code?: string },
  code: string,
  key: string
): boolean {
  return event.code === code || event.key.toLowerCase() === key;
}

export function shortcutFromKeyboardEvent(event: ShortcutEvent): string | null {
  if (canvasNavigationModifierFromKey(event.key) !== null) return null;
  const key = normalizeCanvasNavigationInputKey(event.key, event.code);
  if (!key) return null;

  return [...activeCanvasNavigationModifiers(event), key].join("+");
}

export function shortcutFromPointerEvent(event: Omit<ShortcutEvent, "key"> & { button: number }): string | null {
  const button = canvasNavigationMouseButtonFromDomButton(event.button);
  if (!button) return null;
  return [...activeCanvasNavigationModifiers(event), button].join("+");
}

export function matchesShortcut(event: ShortcutEvent, shortcut: string): boolean {
  return shortcutFromKeyboardEvent(event)?.toLowerCase() === shortcut.toLowerCase();
}

export function matchesPointerShortcut(
  event: Omit<ShortcutEvent, "key"> & { button: number },
  shortcut: string
): boolean {
  return shortcutFromPointerEvent(event)?.toLowerCase() === shortcut.toLowerCase();
}

export function isShortcutCaptureTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-shortcut-capture="true"], input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"]'));
}

export function isRenameInputTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-terminal-rename="true"]'));
}

export function displayCanvasNavigationBinding(binding: string, isMacOS: boolean): string {
  if (!isMacOS) return binding;
  return binding.split("+").map((part) => {
    if (part === "Alt") return "Option";
    if (part === "Meta") return "Command";
    return part;
  }).join("+");
}
