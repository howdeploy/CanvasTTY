import { useLayoutEffect, type RefObject } from "react";

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex], [contenteditable='true']";

function controls(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
    element.tabIndex >= 0 && !element.matches(":disabled")
    && !element.closest("[hidden], [inert]") && element.getClientRects().length > 0);
}

function focusInside(dialog: HTMLElement): void {
  if (!dialog.contains(dialog.ownerDocument.activeElement)) {
    (controls(dialog)[0] ?? dialog).focus({ preventScroll: true });
  }
}

export function useModalFocus(dialogRef: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const document = dialog.ownerDocument;
    const previous = document.activeElement;
    const containFocus = (): void => focusInside(dialog);
    const trapTab = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const targets = controls(dialog);
      const current = targets.indexOf(document.activeElement as HTMLElement);
      if (current !== -1 && (event.shiftKey ? current > 0 : current < targets.length - 1)) return;
      event.preventDefault();
      (event.shiftKey ? targets.at(-1) ?? dialog : targets[0] ?? dialog).focus({ preventScroll: true });
    };
    document.addEventListener("keydown", trapTab, true);
    document.addEventListener("focusin", containFocus, true);
    focusInside(dialog);
    return () => {
      document.removeEventListener("keydown", trapTab, true);
      document.removeEventListener("focusin", containFocus, true);
      if (previous instanceof HTMLElement && previous.isConnected
        && (dialog.contains(document.activeElement) || document.activeElement === document.body)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [dialogRef, open]);

  useLayoutEffect(() => {
    if (open && dialogRef.current) focusInside(dialogRef.current);
  });
}
