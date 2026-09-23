import { useLayoutEffect, useRef, type RefObject } from 'react';

const dialogs: HTMLElement[] = [];
const focusable = 'button, input, textarea, select, a[href], summary, [tabindex], [contenteditable="true"]';
const visible = (element: HTMLElement): boolean => element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';

/** Modal ownership is stacked so opening settings over a retained launch draft is safe. */
export function useDialogFocus<T extends HTMLElement>(
  ref: RefObject<T | null>, active: boolean,
  options: { onEscape?(): void; initialFocus?: RefObject<HTMLElement | null>; restoreFocus?: RefObject<HTMLElement | null> } = {}
): void {
  const current = useRef(options);
  current.current = options;
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!active || !dialog) return;
    const opener = options.restoreFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const previousTabIndex = dialog.getAttribute('tabindex');
    if (previousTabIndex === null) dialog.tabIndex = -1;
    dialogs.push(dialog);
    const isTop = (): boolean => dialogs.filter(visible).at(-1) === dialog;
    const controls = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>(focusable)]
      .filter(element => visible(element) && element.tabIndex >= 0 && !element.matches(':disabled'));
    const focus = (): void => {
      const preferred = current.current.initialFocus?.current;
      (preferred && visible(preferred) ? preferred : controls()[0] ?? dialog).focus({ preventScroll: true });
    };
    const keydown = (event: KeyboardEvent): void => {
      if (!isTop()) return;
      if (event.key === 'Escape' && current.current.onEscape) {
        // Shortcut recording owns Escape while it is listening.
        if (event.target instanceof Element && event.target.closest('[data-shortcut-capture="true"]')) return;
        event.preventDefault(); event.stopImmediatePropagation(); current.current.onEscape();
      } else if (event.key === 'Tab') {
        const items = controls(), index = items.indexOf(document.activeElement as HTMLElement);
        if (items.length === 0 || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
          event.preventDefault();
          (event.shiftKey ? items.at(-1) ?? dialog : items[0] ?? dialog).focus({ preventScroll: true });
        }
      }
    };
    const focusin = (event: FocusEvent): void => {
      if (isTop() && event.target instanceof Node && !dialog.contains(event.target)) focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin, true);
    // Settings starts with a visibility transition; focusing in the commit can be ignored.
    let frame = 0;
    const deadline = performance.now() + 500;
    const initialFocus = (): void => {
      if (isTop()) focus();
      else if (performance.now() < deadline) frame = requestAnimationFrame(initialFocus);
    };
    initialFocus();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin, true);
      const index = dialogs.lastIndexOf(dialog);
      if (index >= 0) dialogs.splice(index, 1);
      if (previousTabIndex === null) dialog.removeAttribute('tabindex');
      queueMicrotask(() => {
        const top = dialogs.filter(visible).at(-1);
        if (opener && visible(opener) && (!top || top.contains(opener))) opener.focus({ preventScroll: true });
      });
    };
  }, [active, ref]);
}
