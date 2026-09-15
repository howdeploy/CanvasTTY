import type { CameraState, SessionBounds } from "../../../../shared/contracts";

export function reconcileCanvasLayerOrder(
  current: readonly string[],
  active: readonly string[]
): string[] {
  const activeSet = new Set(active);
  const next = current.filter((id, index) => activeSet.has(id) && current.indexOf(id) === index);
  for (const id of active) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

export function bringCanvasLayerToFront(current: readonly string[], id: string): string[] {
  if (!current.includes(id) || current.at(-1) === id) return [...current];
  return [...current.filter((candidate) => candidate !== id), id];
}

export function canvasLayerZIndex(order: readonly string[], id: string): number {
  const index = order.indexOf(id);
  return index < 0 ? 1 : index + 1;
}

export function canvasLayerIsOccluded(
  id: string,
  order: readonly string[],
  boundsById: ReadonlyMap<string, SessionBounds>
): boolean {
  const index = order.indexOf(id);
  const bounds = boundsById.get(id);
  if (index < 0 || !bounds) return false;
  return order.slice(index + 1).some((candidate) => {
    const candidateBounds = boundsById.get(candidate);
    return candidateBounds ? boundsOverlap(bounds, candidateBounds) : false;
  });
}

export function boundsOverlap(left: SessionBounds, right: SessionBounds): boolean {
  return left.position.x < right.position.x + right.size.width
    && left.position.x + left.size.width > right.position.x
    && left.position.y < right.position.y + right.size.height
    && left.position.y + left.size.height > right.position.y;
}

/**
 * Screen rectangle a world rectangle covers: the exact inverse of `canvasWorldRect`
 * (screen = world * zoom + camera). Needed because cards are world-anchored while the
 * HUD lives in screen space, and the two must be compared in one space.
 */
export function canvasScreenRect(bounds: SessionBounds, camera: CameraState): SessionBounds {
  return {
    position: {
      x: bounds.position.x * camera.zoom + camera.x,
      y: bounds.position.y * camera.zoom + camera.y
    },
    size: {
      width: bounds.size.width * camera.zoom,
      height: bounds.size.height * camera.zoom
    }
  };
}

/** Value equality, so a re-measure that changed nothing can keep the previous state object as-is. */
export function boundsEqual(left: SessionBounds, right: SessionBounds): boolean {
  return left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.size.width === right.size.width
    && left.size.height === right.size.height;
}
