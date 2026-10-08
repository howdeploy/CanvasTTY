import { useEffect, useRef, type RefObject } from "react";

interface DialogFocusOptions {
  onEscape(): void;
  initialFocus?: () => HTMLElement | null;
  fallbackFocus?: () => HTMLElement | null;
  trapFocus?: boolean;
  restoreFocus?: () => boolean;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  options: DialogFocusOptions
): void {
  const latestOptions = useRef(options);
  latestOptions.current = options;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableElements = (): HTMLElement[] => {
      const nestedDialog = dialog.querySelector<HTMLElement>("[role='alertdialog']:not([hidden])");
      const scope = nestedDialog ?? dialog;
      return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true"
        && element.getClientRects().length > 0);
    };
    const initialFocus = latestOptions.current.initialFocus?.() ?? focusableElements()[0] ?? dialog;
    initialFocus.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        latestOptions.current.onEscape();
        return;
      }
      if (event.key !== "Tab" || latestOptions.current.trapFocus === false) return;

      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);

    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      if (latestOptions.current.restoreFocus?.() === false) return;
      const canRestorePrevious = previousFocus !== null && previousFocus.isConnected && previousFocus !== document.body
        && previousFocus !== document.documentElement && !dialog.contains(previousFocus);
      const fallback = latestOptions.current.fallbackFocus?.();
      if (canRestorePrevious) {
        previousFocus.focus({ preventScroll: true });
      } else if (fallback?.isConnected) {
        fallback.focus({ preventScroll: true });
      } else if (previousFocus?.isConnected && !dialog.contains(previousFocus)) {
        previousFocus.focus({ preventScroll: true });
      } else {
        fallback?.focus({ preventScroll: true });
      }
    };
  }, [dialogRef]);
}
