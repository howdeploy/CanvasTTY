import type { Size } from "../../../../shared/contracts";
import type { CanvasSubmenuSide } from "./canvasContextRouting";

// Placement of the canvas context menu and its submenus around the corner panels. Only the lazily loaded menu uses it,
// so it stays out of the startup bundle.

interface HorizontalBounds {
  left: number;
  right: number;
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

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The top for a context menu so it does not cover a corner panel (minimap, shortcut hints, Home/zoom controls): a menu
 * opened near a panel moves up until it clears it, by `gap`, while it stays at or below `minTop`. When that is not
 * possible the menu keeps its place (it is drawn above the panels anyway).
 */
export function canvasMenuTopClearOfPanels(menu: Box, panels: readonly Box[], minTop: number, gap: number): number {
  const height = menu.bottom - menu.top;
  const overlaps = (top: number, panel: Box): boolean => menu.left < panel.right && menu.right > panel.left
    && top < panel.bottom + gap && top + height > panel.top - gap;
  let top = menu.top;
  for (let step = 0; step < panels.length; step++) {
    const hit = panels.find((panel) => overlaps(top, panel));
    if (!hit) return top;
    top = hit.top - gap - height;
    if (top < minTop) return menu.top;
  }
  return panels.some((panel) => overlaps(top, panel)) ? menu.top : top;
}

/**
 * Where a context menu goes so it covers no corner panel, at any UI scale: first up (canvasMenuTopClearOfPanels);
 * when that cannot clear every panel, sideways at its own height, to the side of the panel it hits with room for it
 * within `minLeft`..`maxRight`. When neither works it keeps its place (drawn above the panels anyway).
 */
export function canvasMenuPlacementClearOfPanels(
  menu: Box, panels: readonly Box[], bounds: { minTop: number; minLeft: number; maxRight: number }, gap: number
): { left: number; top: number } {
  const width = menu.right - menu.left;
  const height = menu.bottom - menu.top;
  const hits = (left: number, top: number): Box | undefined => panels.find((panel) => left < panel.right
    && left + width > panel.left && top < panel.bottom + gap && top + height > panel.top - gap);
  const top = canvasMenuTopClearOfPanels(menu, panels, bounds.minTop, gap);
  if (!hits(menu.left, top)) return { left: menu.left, top };
  // Beside the panel it hits, nearest to where it was opened first, never back to a place already tried.
  const tried = new Set([menu.left]);
  let left = menu.left;
  for (let step = 0; step <= panels.length; step++) {
    const hit = hits(left, menu.top);
    if (!hit) return { left, top: menu.top };
    const next = [hit.left - gap - width, hit.right + gap]
      .filter((candidate) => !tried.has(candidate) && candidate >= bounds.minLeft && candidate + width <= bounds.maxRight)
      .sort((a, b) => Math.abs(a - menu.left) - Math.abs(b - menu.left))[0];
    if (next === undefined) break;
    tried.add(next);
    left = next;
  }
  return { left: menu.left, top: menu.top };
}

/**
 * Where a submenu opens beside its row (`anchor`): on the side with room (chooseCanvasSubmenuSide), downward unless it
 * runs past the canvas bottom (only when `allowUp`). When that place covers a corner panel (minimap, shortcut hints,
 * Home/zoom controls; their corners are set in Settings), the first of the other sides and directions that stays
 * inside the canvas and clear of every panel by `metrics.clearance`. When none is clear it keeps the preferred place
 * (drawn above the panels anyway). `metrics.gap` and `metrics.offset` are the submenu's CSS offsets from the row.
 */
export function chooseCanvasSubmenuPlacement(
  anchor: Box,
  size: Size,
  area: Box,
  panels: readonly Box[],
  metrics: { gap: number; offset: number; clearance: number },
  allowUp: boolean
): { side: CanvasSubmenuSide; up: boolean } {
  const { width, height } = size;
  const { gap, offset, clearance } = metrics;
  const box = (side: CanvasSubmenuSide, up: boolean): Box => {
    const left = side === "right" ? anchor.right + gap : anchor.left - gap - width;
    const top = up ? anchor.bottom + offset - height : anchor.top - offset;
    return { left, top, right: left + width, bottom: top + height };
  };
  const fits = (b: Box): boolean => b.left >= area.left && b.right <= area.right && b.top >= area.top
    && b.bottom <= area.bottom && !panels.some((panel) => b.left < panel.right + clearance
      && b.right > panel.left - clearance && b.top < panel.bottom + clearance && b.bottom > panel.top - clearance);
  const side = chooseCanvasSubmenuSide(anchor, area, width, gap);
  const up = allowUp && box(side, false).bottom > area.bottom;
  const other: CanvasSubmenuSide = side === "right" ? "left" : "right";
  const candidates = [{ side, up }, { side, up: !up }, { side: other, up }, { side: other, up: !up }]
    .filter((candidate) => allowUp || !candidate.up);
  return candidates.find((candidate) => fits(box(candidate.side, candidate.up))) ?? { side, up };
}
