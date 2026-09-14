import type { CameraState, Point, SessionBounds } from "../../../../shared/contracts";

/** Client pixels a gesture must travel before it counts as a drag, not a click. */
export const CANVAS_DRAG_THRESHOLD = 3;

/**
 * Card surfaces that own their own press. A group drag must never preempt them,
 * so the press reaches the control, the search input, or the resize handle.
 */
export const TERMINAL_CARD_CONTROL_SELECTOR = "button, input, .terminal-card__resize-handle";

/** Viewport-local marquee rectangle, ready for absolute positioning. */
export interface CanvasMarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type CanvasPressIntent =
  /** Shift on empty canvas: select every window the rectangle covers. */
  | { kind: "marquee" }
  /** Plain press on empty canvas: drop the marquee group and fall through to the pan. */
  | { kind: "clear-selection" }
  /** Press on a terminal card that is one of several selected cards. */
  | { kind: "group-drag"; sessionId: string }
  | { kind: "none" };

export interface CanvasPress {
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** `data-session-id` of the closest terminal card; null when the press missed every card. */
  cardSessionId: string | null;
  /** The press started on a card control, the search input, or a resize handle. */
  onCardControl: boolean;
  /** The press started on a canvas widget surface (card, plugin canvas, browser, HOME). */
  onCanvasWidget: boolean;
  /** Session ids the marquee currently selects. */
  selection: ReadonlySet<string>;
}

/**
 * Resolves a primary press on the canvas. Navigation mouse bindings are resolved
 * before this: they own their presses no matter what sits underneath.
 */
export function canvasPressIntent(press: CanvasPress): CanvasPressIntent {
  if (press.button !== 0) return { kind: "none" };
  if (press.cardSessionId !== null) {
    // A group drag is a drag, not a press: until it travels it leaves the card's
    // own controls, focus, and click path untouched.
    const grouped = press.selection.size > 1
      && press.selection.has(press.cardSessionId)
      && !press.onCardControl
      && !press.altKey;
    return grouped ? { kind: "group-drag", sessionId: press.cardSessionId } : { kind: "none" };
  }
  if (press.onCanvasWidget) return { kind: "none" };
  if (press.shiftKey && !press.altKey && !press.ctrlKey && !press.metaKey) return { kind: "marquee" };
  return { kind: "clear-selection" };
}

/** Shared travel gate: below it a press stays a click for both the marquee and a group drag. */
export function pastCanvasDragThreshold(start: Point, current: Point): boolean {
  return Math.abs(current.x - start.x) > CANVAS_DRAG_THRESHOLD
    || Math.abs(current.y - start.y) > CANVAS_DRAG_THRESHOLD;
}

/** Viewport-local rectangle between two pointer positions. */
export function canvasMarqueeRect(start: Point, current: Point): CanvasMarqueeRect {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y)
  };
}

/** World-space rectangle a marquee covers, for intersection with rendered session bounds. */
export function canvasWorldRect(start: Point, current: Point, camera: CameraState): SessionBounds {
  const rect = canvasMarqueeRect(start, current);
  return {
    position: {
      x: (rect.left - camera.x) / camera.zoom,
      y: (rect.top - camera.y) / camera.zoom
    },
    size: {
      width: rect.width / camera.zoom,
      height: rect.height / camera.zoom
    }
  };
}

export interface CanvasGroupDragState {
  pointerId: number;
  sessionId: string;
  startClient: Point;
  /** True once the press travelled past the shared threshold and owns the gesture. */
  active: boolean;
}

export function beginCanvasGroupDrag(pointerId: number, sessionId: string, startClient: Point): CanvasGroupDragState {
  return { pointerId, sessionId, startClient, active: false };
}

/** Advances the press; the state only becomes active after real travel, never on jitter. */
export function advanceCanvasGroupDrag(
  drag: CanvasGroupDragState,
  pointer: { pointerId: number; clientX: number; clientY: number }
): CanvasGroupDragState {
  if (drag.pointerId !== pointer.pointerId || drag.active) return drag;
  if (!pastCanvasDragThreshold(drag.startClient, { x: pointer.clientX, y: pointer.clientY })) return drag;
  return { ...drag, active: true };
}

/** World-space delta the group commits on release, or null when the press never travelled. */
export function endCanvasGroupDrag(drag: CanvasGroupDragState, endClient: Point, zoom: number): Point | null {
  if (!drag.active) return null;
  return {
    x: (endClient.x - drag.startClient.x) / zoom,
    y: (endClient.y - drag.startClient.y) / zoom
  };
}
