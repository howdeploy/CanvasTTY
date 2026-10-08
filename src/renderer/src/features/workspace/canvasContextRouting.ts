import type { Point, Size } from "../../../../shared/contracts";

export type CanvasContextHit = "empty" | "region" | "note" | "material" | "native" | "blocked";
export type CanvasContextMenuKind = "empty" | "region" | "note" | "material";
export type CanvasSubmenuSide = "left" | "right";

interface HorizontalBounds {
  left: number;
  right: number;
}

export function routeCanvasContextMenu(
  hit: CanvasContextHit,
  homeEditing: boolean
): CanvasContextMenuKind | null {
  if (homeEditing || hit === "native" || hit === "blocked") return null;
  return hit;
}

export function clampCanvasMenuPosition(
  pointer: Point,
  viewport: Size,
  menu: Size = { width: 300, height: 380 },
  inset = 12
): Point {
  return {
    x: Math.max(inset, Math.min(pointer.x, Math.max(inset, viewport.width - menu.width - inset))),
    y: Math.max(inset, Math.min(pointer.y, Math.max(inset, viewport.height - menu.height - inset)))
  };
}

export function chooseCanvasSubmenuSide(
  anchor: HorizontalBounds,
  viewport: HorizontalBounds,
  submenuWidth: number,
  gap: number
): CanvasSubmenuSide {
  const required = submenuWidth + gap;
  const rightSpace = viewport.right - anchor.right;
  const leftSpace = anchor.left - viewport.left;
  if (rightSpace >= required) return "right";
  if (leftSpace >= required) return "left";
  return rightSpace >= leftSpace ? "right" : "left";
}
