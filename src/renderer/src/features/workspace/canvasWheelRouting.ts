import type { CanvasWheelCaptureMode } from "../../../../shared/contracts.ts";
import {
  normalizeCanvasWheelDeltas,
  shouldCanvasOwnWheel
} from "../../../../shared/canvasNavigation.ts";
import {
  isFocusedCanvasWidgetTarget,
  isPriorityLocalCanvasWheelTarget
} from "./canvasWidgetFocus.ts";

export interface CanvasWheelRoutingInput {
  focusedWidgetId: string | null;
  captureMode: CanvasWheelCaptureMode;
  wheelOverrideActive: boolean;
  navigationOverrideActive: boolean;
  getBounds(): Pick<DOMRect, "width" | "height">;
  applyCanvasWheel(input: {
    clientX: number;
    clientY: number;
    deltaX: number;
    deltaY: number;
    ctrlKey: boolean;
    metaKey: boolean;
  }): void;
}

/** Route a native wheel event and report whether canvas navigation claimed it. */
export function routeCanvasWheelEvent(event: WheelEvent, input: CanvasWheelRoutingInput): boolean {
  const priorityLocalOwner = isPriorityLocalCanvasWheelTarget(event.target);
  const browserFreezeOwned = !priorityLocalOwner
    && event.target instanceof Element
    && event.target.closest('[data-browser-canvas-wheel-owner="canvas"]') !== null;
  const ownedByCanvas = browserFreezeOwned || shouldCanvasOwnWheel({
    overFocusedWidget: priorityLocalOwner
      || isFocusedCanvasWidgetTarget(event.target, input.focusedWidgetId),
    captureMode: input.captureMode,
    wheelOverrideActive: input.wheelOverrideActive,
    navigationOverrideActive: input.navigationOverrideActive
  });
  if (!ownedByCanvas) return false;

  event.preventDefault();
  event.stopPropagation();
  input.applyCanvasWheel({
    clientX: event.clientX,
    clientY: event.clientY,
    ...normalizeCanvasWheelDeltas(
      event.deltaX,
      event.deltaY,
      event.deltaMode,
      input.getBounds()
    ),
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey
  });
  return true;
}
