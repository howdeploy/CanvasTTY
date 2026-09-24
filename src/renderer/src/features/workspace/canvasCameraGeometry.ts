import type { CameraState, SessionBounds, Size } from "../../../../shared/contracts";

/** Same clamp as the canvas wheel/zoom controls in useCanvasWheelNavigation. */
export const CANVAS_MIN_ZOOM = 0.2;
export const CANVAS_MAX_ZOOM = 1.35;
/** Screen-space margin kept around fitted content, per side. */
export const CANVAS_FIT_MARGIN = 72;

export function boundsUnion(bounds: readonly SessionBounds[]): SessionBounds | null {
  if (bounds.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of bounds) {
    minX = Math.min(minX, box.position.x);
    minY = Math.min(minY, box.position.y);
    maxX = Math.max(maxX, box.position.x + box.size.width);
    maxY = Math.max(maxY, box.position.y + box.size.height);
  }
  return {
    position: { x: minX, y: minY },
    size: { width: maxX - minX, height: maxY - minY }
  };
}

/** Centres the given world rectangle in the viewport, as large as the margin allows. */
export function cameraFittingBounds(bounds: SessionBounds, viewport: Size): CameraState {
  const availableWidth = Math.max(1, viewport.width - CANVAS_FIT_MARGIN * 2);
  const availableHeight = Math.max(1, viewport.height - CANVAS_FIT_MARGIN * 2);
  const zoom = Math.max(CANVAS_MIN_ZOOM, Math.min(CANVAS_MAX_ZOOM, Math.min(
    availableWidth / Math.max(1, bounds.size.width),
    availableHeight / Math.max(1, bounds.size.height)
  )));
  return {
    zoom,
    x: viewport.width / 2 - (bounds.position.x + bounds.size.width / 2) * zoom,
    y: viewport.height / 2 - (bounds.position.y + bounds.size.height / 2) * zoom
  };
}

/** Camera that fits every rectangle; null when there is nothing to fit. */
export function cameraFittingContent(
  content: readonly SessionBounds[],
  viewport: Size
): CameraState | null {
  const union = boundsUnion(content);
  return union === null ? null : cameraFittingBounds(union, viewport);
}
