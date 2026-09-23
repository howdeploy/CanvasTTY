import { useEffect, useState, type ReactNode } from "react";

export function CanvasOverlayPanel({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(() => !window.matchMedia("(max-width: 900px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const resize = (): void => setOpen(!query.matches);
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);
  return (
    <details className="canvas-overlay-panel" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-interactive="true">
      <summary>{label}</summary>
      <div className="canvas-overlay-panel__body">{children}</div>
    </details>
  );
}
