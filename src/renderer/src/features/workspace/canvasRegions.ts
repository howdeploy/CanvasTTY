import type { CanvasRegion, Point, SessionBounds, Size } from "../../../../shared/contracts";
import { snapResize, type ResizeDirection } from "./snap.ts";

export const DEFAULT_CANVAS_REGION_SIZE = { width: 960, height: 600 } as const;
export const CANVAS_REGION_COLORS = [
  "#B8CF99",
  "#9CC7DC",
  "#D5A2C9",
  "#E2C58F",
  "#AEB5D8",
  "#D9A69A"
] as const;

export const MIN_REGION_SIZE: Size = { width: 360, height: 240 };
export const MAX_REGION_SIZE: Size = { width: 4_000, height: 3_000 };

export function canvasRegionAtPoint(
  title: string,
  color: string,
  point: Point,
  id: string
): CanvasRegion {
  return {
    id,
    title: title.trim().slice(0, 80),
    color,
    position: {
      x: point.x - DEFAULT_CANVAS_REGION_SIZE.width / 2,
      y: point.y - DEFAULT_CANVAS_REGION_SIZE.height / 2
    },
    size: { ...DEFAULT_CANVAS_REGION_SIZE }
  };
}

export function boundsInsideRegion(bounds: SessionBounds, region: CanvasRegion): boolean {
  return bounds.position.x >= region.position.x
    && bounds.position.y >= region.position.y
    && bounds.position.x + bounds.size.width <= region.position.x + region.size.width
    && bounds.position.y + bounds.size.height <= region.position.y + region.size.height;
}

export function translateBounds(bounds: SessionBounds, delta: Point): SessionBounds {
  return {
    position: { x: bounds.position.x + delta.x, y: bounds.position.y + delta.y },
    size: { ...bounds.size }
  };
}

export function constrainCanvasRegionBounds(
  bounds: SessionBounds,
  direction: ResizeDirection
): SessionBounds {
  const nextWidth = clamp(bounds.size.width, MIN_REGION_SIZE.width, MAX_REGION_SIZE.width);
  const nextHeight = clamp(bounds.size.height, MIN_REGION_SIZE.height, MAX_REGION_SIZE.height);
  return {
    position: {
      x: direction.includes("w") ? bounds.position.x + bounds.size.width - nextWidth : bounds.position.x,
      y: direction.includes("n") ? bounds.position.y + bounds.size.height - nextHeight : bounds.position.y
    },
    size: { width: nextWidth, height: nextHeight }
  };
}

export function snapCanvasRegionBounds(
  bounds: SessionBounds,
  direction: ResizeDirection,
  targets: readonly SessionBounds[]
): SessionBounds {
  return snapResize(bounds, direction, targets, {
    min: MIN_REGION_SIZE,
    max: MAX_REGION_SIZE
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
