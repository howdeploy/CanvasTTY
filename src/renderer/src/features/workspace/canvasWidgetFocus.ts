import type { Point, SessionBounds } from "../../../../shared/contracts";

export const browserCanvasWidgetId = "browser";

export interface CanvasWidgetTarget {
  isWidget: boolean;
  focusableWidgetId: string | null;
}

export function terminalCanvasWidgetId(sessionId: string): string {
  return `terminal:${sessionId}`;
}

export function pluginCanvasWidgetId(instanceId: string): string {
  return `plugin-canvas:${instanceId}`;
}

export function homeCanvasWidgetId(widgetId: string): string {
  return `home:${widgetId}`;
}

export function canvasWidgetFocusAfterClick(
  current: string | null,
  target: CanvasWidgetTarget
): string | null {
  if (target.focusableWidgetId !== null) return target.focusableWidgetId;
  return target.isWidget ? current : null;
}

export function canvasWidgetTarget(target: EventTarget | null): CanvasWidgetTarget {
  if (!(target instanceof Element)) return { isWidget: false, focusableWidgetId: null };
  const widget = target.closest<HTMLElement>("[data-canvas-widget-id]");
  if (!widget) return { isWidget: false, focusableWidgetId: null };
  const widgetId = widget.dataset.canvasWidgetId;
  return {
    isWidget: true,
    focusableWidgetId: widget.dataset.canvasWidgetFocusable === "true" && widgetId
      ? widgetId
      : null
  };
}

export function isFocusedCanvasWidgetTarget(
  target: EventTarget | null,
  focusedWidgetId: string | null
): boolean {
  if (focusedWidgetId === null) return false;
  return canvasWidgetTarget(target).focusableWidgetId === focusedWidgetId;
}

export function isPriorityLocalCanvasWheelTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('[data-canvas-wheel-priority="local"]') !== null;
}

export type CanvasFocusDirection = "up" | "down" | "left" | "right";

export interface CanvasFocusCandidate {
  id: string;
  bounds: SessionBounds;
}

/**
 * Nearest widget strictly in the given direction from the current one: distance
 * along the axis first, perpendicular offset as a tie-breaker. With no current
 * widget the viewport centre acts as the origin, so the first chord always enters.
 */
export function canvasWidgetInDirection(
  candidates: readonly CanvasFocusCandidate[],
  currentId: string | null,
  direction: CanvasFocusDirection,
  origin: Point
): string | null {
  const current = candidates.find((candidate) => candidate.id === currentId) ?? null;
  const center = current
    ? {
      x: current.bounds.position.x + current.bounds.size.width / 2,
      y: current.bounds.position.y + current.bounds.size.height / 2
    }
    : origin;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate.id === (current?.id ?? null)) continue;
    const candidateCenter = {
      x: candidate.bounds.position.x + candidate.bounds.size.width / 2,
      y: candidate.bounds.position.y + candidate.bounds.size.height / 2
    };
    const deltaX = candidateCenter.x - center.x;
    const deltaY = candidateCenter.y - center.y;
    const along = direction === "left" ? -deltaX
      : direction === "right" ? deltaX
        : direction === "up" ? -deltaY
          : deltaY;
    if (along <= 0) continue;
    const perpendicular = direction === "left" || direction === "right"
      ? Math.abs(deltaY)
      : Math.abs(deltaX);
    const score = along + perpendicular * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = candidate.id;
    }
  }
  return best;
}
