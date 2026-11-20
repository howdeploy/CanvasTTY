import type { Point, SessionBounds, Size } from "../../../../shared/contracts";

export const PIXEL_SKIN_CARD_SIZE: Size = { width: 960, height: 640 };
// Keep the old export for consumers that used it as the initial sizing target.
export const PIXEL_SKIN_MIN_CARD_SIZE = PIXEL_SKIN_CARD_SIZE;
const CARD_GAP = 40;

interface PositionedCard {
  id: string;
  position: Point;
  size: Size;
}

function overlaps(a: SessionBounds, b: SessionBounds): boolean {
  return a.position.x < b.position.x + b.size.width + CARD_GAP
    && a.position.x + a.size.width + CARD_GAP > b.position.x
    && a.position.y < b.position.y + b.size.height + CARD_GAP
    && a.position.y + a.size.height + CARD_GAP > b.position.y;
}

/** Normalize themed terminals to one frame size without stacking changed cards. */
export function expandedPixelSkinCardBounds(cards: readonly PositionedCard[]): Array<{ id: string; bounds: SessionBounds }> {
  const occupied: SessionBounds[] = cards
    .filter((card) => card.size.width === PIXEL_SKIN_CARD_SIZE.width
      && card.size.height === PIXEL_SKIN_CARD_SIZE.height)
    .map(({ position, size }) => ({ position, size }));
  const changed: Array<{ id: string; bounds: SessionBounds }> = [];
  const ordered = cards
    .filter((card) => card.size.width !== PIXEL_SKIN_CARD_SIZE.width
      || card.size.height !== PIXEL_SKIN_CARD_SIZE.height)
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  for (const card of ordered) {
    const size = { ...PIXEL_SKIN_CARD_SIZE };
    const bounds = { position: { ...card.position }, size };
    let collision = occupied.find((other) => overlaps(bounds, other));
    while (collision) {
      bounds.position.x = collision.position.x + collision.size.width + CARD_GAP;
      collision = occupied.find((other) => overlaps(bounds, other));
    }
    changed.push({ id: card.id, bounds });
    occupied.push(bounds);
  }
  return changed;
}
