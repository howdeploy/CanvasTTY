import type { CameraState, Point, SessionBounds } from "../../../../shared/contracts";

/** Client pixels a gesture must travel before it counts as a drag, not a click. */
export const CANVAS_DRAG_THRESHOLD = 3;

/** The four kinds of window the canvas renders, side by side, in one scene. */
export type CanvasLayerKind = "terminal" | "plugin" | "browser" | "note";

/** A canvas layer id decoded into what it names. The browser has no target of its own. */
export interface CanvasLayerRef {
  kind: CanvasLayerKind;
  targetId: string | null;
}

/** Layer ids are the one identity a card publishes and every gesture stage speaks. */
export const browserLayerId = "browser";

export function terminalLayerId(id: string): string {
  return `terminal:${id}`;
}

export function pluginLayerId(id: string): string {
  return `plugin:${id}`;
}

export function noteLayerId(id: string): string {
  return `note:${id}`;
}

/**
 * The inverse of the layer-id helpers, and the single place that decodes the scheme.
 * Anything that is not one of the four layer prefixes — including an id with nothing
 * after the colon — is not a layer id.
 */
export function parseCanvasLayerId(layerId: string): CanvasLayerRef | null {
  if (layerId === browserLayerId) return { kind: "browser", targetId: null };
  const separator = layerId.indexOf(":");
  if (separator === -1 || separator === layerId.length - 1) return null;
  const kind = layerId.slice(0, separator);
  const targetId = layerId.slice(separator + 1);
  if (kind !== "terminal" && kind !== "plugin" && kind !== "note") return null;
  return { kind, targetId };
}

/**
 * Card surfaces that own their own press. A group drag must never preempt them,
 * so the press reaches the control, the search input, the editor, or the resize handle.
 * The resize handle class is shared by all four cards. `textarea` is required: the
 * sticky-note editor is one, and a drag anchor there would break text selection.
 */
export const CANVAS_CARD_CONTROL_SELECTOR = "button, input, textarea, .terminal-card__resize-handle";

/** Viewport-local marquee rectangle, ready for absolute positioning. */
export interface CanvasMarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type CanvasMarqueeMode = "all" | "terminal-only";

export type CanvasPressIntent =
  /** Shift (all windows) or Ctrl (terminal-only) on empty canvas: marquee select. */
  | { kind: "marquee"; mode: CanvasMarqueeMode }
  /** Plain press or click outside selection: drop the marquee group. */
  | { kind: "clear-selection" }
  /** Press on a card that is one of several selected cards. */
  | { kind: "group-drag"; layerId: string }
  | { kind: "none" };

export interface CanvasPress {
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** `data-canvas-layer-id` of the closest canvas card; null when the press missed every card. */
  cardLayerId: string | null;
  /** The press started on a card control, the search input, the note editor, or a resize handle. */
  onCardControl: boolean;
  /** The press started on a canvas widget surface (card, plugin canvas, browser, HOME). */
  onCanvasWidget: boolean;
  /** Layer ids the marquee currently selects. */
  selection: ReadonlySet<string>;
}

/**
 * Resolves a primary press on the canvas. Navigation mouse bindings are resolved
 * before this: they own their presses no matter what sits underneath.
 */
export function canvasPressIntent(press: CanvasPress): CanvasPressIntent {
  if (press.button !== 0) return { kind: "none" };

  if (press.cardLayerId !== null) {
    // A group drag is a drag, not a press: until it travels it leaves the card's
    // own controls, focus, and click path untouched.
    const isSelected = press.selection.has(press.cardLayerId);
    if (isSelected) {
      const grouped = press.selection.size > 1
        && !press.onCardControl
        && !press.altKey;
      return grouped ? { kind: "group-drag", layerId: press.cardLayerId } : { kind: "none" };
    }
    // Clearing the visual group does not consume the press: card controls still
    // receive their own click, even when the card is outside the selected group.
    if (press.selection.size > 0) {
      return { kind: "clear-selection" };
    }
    return { kind: "none" };
  }

  // A press on any other widget also clears the group without consuming its click.
  if (press.onCanvasWidget) {
    if (press.selection.size > 0) {
      return { kind: "clear-selection" };
    }
    return { kind: "none" };
  }

  // Empty canvas marquee:
  // Shift+left drag -> marquee all
  // Ctrl+left drag -> terminal-only marquee
  if (press.shiftKey && !press.altKey && !press.ctrlKey && !press.metaKey) {
    return { kind: "marquee", mode: "all" };
  }
  if (press.ctrlKey && !press.altKey && !press.shiftKey && !press.metaKey) {
    return { kind: "marquee", mode: "terminal-only" };
  }

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

/** World-space rectangle a marquee covers, for intersection with rendered layer bounds. */
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

/** Filters layer ids according to marquee mode (e.g. terminal-only vs all). */
export function filterMarqueeSelectionByMode(layerIds: Iterable<string>, mode: CanvasMarqueeMode): Set<string> {
  if (mode === "all") return new Set(layerIds);
  const result = new Set<string>();
  for (const id of layerIds) {
    const ref = parseCanvasLayerId(id);
    if (ref?.kind === "terminal") {
      result.add(id);
    }
  }
  return result;
}

export interface CanvasGroupDragState {
  pointerId: number;
  layerId: string;
  startClient: Point;
  /** True once the press travelled past the shared threshold and owns the gesture. */
  active: boolean;
}

export function beginCanvasGroupDrag(pointerId: number, layerId: string, startClient: Point): CanvasGroupDragState {
  return { pointerId, layerId, startClient, active: false };
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

/**
 * World-space delta between the press and a pointer position, or null while the press has
 * not travelled. The live preview and the commit both read it, so the two cannot drift.
 */
export function canvasGroupDragDelta(drag: CanvasGroupDragState, client: Point, zoom: number): Point | null {
  if (!drag.active) return null;
  return {
    x: (client.x - drag.startClient.x) / zoom,
    y: (client.y - drag.startClient.y) / zoom
  };
}
