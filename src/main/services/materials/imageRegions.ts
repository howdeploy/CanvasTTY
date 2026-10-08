import type { RemarkAnchor, Size } from "../../../shared/contracts";
import { isAreaAnchor } from "../../../shared/materials.ts";

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const POINT_SHARE = 0.18;
const CROP_PADDING_SHARE = 0.15;
const CROP_PADDING_MIN = 16;

export function anchorRect(anchor: RemarkAnchor, natural: Size): PixelRect {
  if (!isAreaAnchor(anchor)) return { x: 0, y: 0, width: natural.width, height: natural.height };
  if (anchor.kind === "point") {
    const side = Math.max(8, Math.round(Math.min(natural.width, natural.height) * POINT_SHARE));
    return clampRect({
      x: Math.round(anchor.x * natural.width - side / 2),
      y: Math.round(anchor.y * natural.height - side / 2),
      width: side,
      height: side
    }, natural);
  }
  return clampRect({
    x: Math.round(anchor.x * natural.width),
    y: Math.round(anchor.y * natural.height),
    width: Math.max(1, Math.round(anchor.width * natural.width)),
    height: Math.max(1, Math.round(anchor.height * natural.height))
  }, natural);
}

export function cropRect(anchor: RemarkAnchor, natural: Size): PixelRect {
  const rect = anchorRect(anchor, natural);
  if (!isAreaAnchor(anchor)) return rect;
  const padX = Math.max(CROP_PADDING_MIN, Math.round(rect.width * CROP_PADDING_SHARE));
  const padY = Math.max(CROP_PADDING_MIN, Math.round(rect.height * CROP_PADDING_SHARE));
  return clampRect({ x: rect.x - padX, y: rect.y - padY, width: rect.width + padX * 2, height: rect.height + padY * 2 }, natural);
}

export function clampRect(rect: PixelRect, natural: Size): PixelRect {
  const x = Math.min(Math.max(0, rect.x), Math.max(0, natural.width - 1));
  const y = Math.min(Math.max(0, rect.y), Math.max(0, natural.height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.width + Math.min(0, rect.x), natural.width - x)),
    height: Math.max(1, Math.min(rect.height + Math.min(0, rect.y), natural.height - y))
  };
}

export function outlineThickness(natural: Size): number {
  return Math.max(2, Math.round(Math.min(natural.width, natural.height) / 180));
}

export function drawOutline(
  bitmap: Uint8Array,
  size: Size,
  rect: PixelRect,
  thickness: number,
  bgra: readonly [number, number, number, number]
): void {
  const right = Math.min(size.width, rect.x + rect.width);
  const bottom = Math.min(size.height, rect.y + rect.height);
  for (let y = Math.max(0, rect.y - thickness); y < Math.min(size.height, bottom + thickness); y += 1) {
    for (let x = Math.max(0, rect.x - thickness); x < Math.min(size.width, right + thickness); x += 1) {
      const inside = x >= rect.x && x < right && y >= rect.y && y < bottom;
      if (inside) continue;
      const offset = (y * size.width + x) * 4;
      bitmap[offset] = bgra[0];
      bitmap[offset + 1] = bgra[1];
      bitmap[offset + 2] = bgra[2];
      bitmap[offset + 3] = bgra[3];
    }
  }
}
