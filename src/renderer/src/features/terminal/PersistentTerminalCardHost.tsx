import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * macOS fullscreen moves the DOM host, while React keeps the same portal and
 * TerminalCard owner. Recreating xterm from the main process's short raw ring
 * would lose the card's longer parsed scrollback, viewport, selection and modes.
 */
export function PersistentTerminalCardHost({ children, fullscreen, fullscreenLayer }: {
  children: ReactNode;
  fullscreen: boolean;
  fullscreenLayer: HTMLElement | null;
}): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  useLayoutEffect(() => {
    const target = fullscreen ? fullscreenLayer : anchor.current?.parentElement;
    if (!target || host.parentElement === target) return;
    // Chromium's state-preserving move also retains textarea focus. Initial
    // placement needs appendChild because the portal host is not connected yet.
    const movable = target as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
    if (host.isConnected && typeof movable.moveBefore === "function") movable.moveBefore(host, null);
    else {
      const focused = host.ownerDocument.activeElement;
      target.appendChild(host);
      if (focused instanceof HTMLElement && host.contains(focused)) focused.focus({ preventScroll: true });
    }
  }, [host, fullscreen, fullscreenLayer]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return <><span ref={anchor} style={{ display: "none" }} aria-hidden="true" />{createPortal(children, host)}</>;
}
