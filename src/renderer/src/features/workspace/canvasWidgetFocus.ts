export const browserCanvasWidgetId = "browser";
export function browserWindowWidgetId(id: string): string { return id === "default" ? browserCanvasWidgetId : `browser:${id}`; }

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
