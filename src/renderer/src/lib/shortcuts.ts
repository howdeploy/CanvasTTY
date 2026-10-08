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
  const key = event.code === "Comma" || event.key === ","
    ? "Comma" : normalizeCanvasNavigationInputKey(event.key, event.code);
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
  return target instanceof Element && Boolean(target.closest('[data-shortcut-capture="true"]'));
}

export function isRenameInputTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-terminal-rename="true"]'));
}

/**
 * Renderer-owned editing includes terminal surfaces and shortcut recorders: both need Command+C/V/A delivered
 * as keyboard events. The terminal-named focus API also covers these recorder controls. Ordinary fields and plugin
 * pages (an iframe is the active element) use the menu's native editing.
 */
export function isTerminalEditTarget(target: EventTarget | null): boolean {
  return isShortcutCaptureTarget(target)
    || (target instanceof Element && Boolean(target.closest(".terminal-card__surface, .xterm")));
}

/** Reports changes in renderer-owned edit focus, including shortcut recorders (macOS edit-shortcut routing). */
export function trackTerminalEditFocus(doc: Document, report: (focused: boolean) => void): () => void {
  let last: boolean | null = null;
  const update = (): void => {
    const focused = isTerminalEditTarget(doc.activeElement);
    if (focused === last) return;
    last = focused;
    report(focused);
  };
  // focusout runs before the next element is active: read it once the move has settled.
  const settle = (): void => { queueMicrotask(update); };
  doc.addEventListener("focusin", update, true);
  doc.addEventListener("focusout", settle, true);
  doc.defaultView?.addEventListener("blur", settle);
  update();
  return () => {
    doc.removeEventListener("focusin", update, true);
    doc.removeEventListener("focusout", settle, true);
    doc.defaultView?.removeEventListener("blur", settle);
  };
}

export function shouldKeepNativeKeyboardInput(
  target: EventTarget | null,
  _isMacOS: boolean,
  _event?: ShortcutEvent
): boolean {
  return target instanceof Element
    && Boolean(target.closest('.terminal-card__surface, input, textarea, select, [contenteditable="true"]'));
}

// Terminal Command+A bypasses the Electron menu, so ordinary fields need their DOM selection here.
export function handleMacNativeSelectAll(event: KeyboardEvent, isMacOS: boolean): boolean {
  if (!isMacOS || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    || !matchesPhysicalOrLayoutKey(event, "KeyA", "a") || !(event.target instanceof Element)) return false;
  if (isShortcutCaptureTarget(event.target) || event.target.closest(".xterm")) return false;
  const field = event.target.closest("input, textarea");
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.select();
  else {
    let editable = event.target.closest<HTMLElement>("[contenteditable]");
    if (!editable?.isContentEditable) return false;
    while (editable.parentElement?.isContentEditable) editable = editable.parentElement;
    const selection = editable.ownerDocument.getSelection();
    if (!selection) return false;
    selection.selectAllChildren(editable);
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function displayCanvasNavigationBinding(binding: string, isMacOS: boolean): string {
  if (!isMacOS) return binding;
  return binding.split("+").map((part) => {
    if (part === "Alt") return "Option";
    if (part === "Meta") return "Command";
    return part;
  }).join("+");
}
