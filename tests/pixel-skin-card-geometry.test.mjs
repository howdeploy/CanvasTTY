import assert from "node:assert/strict";
import test from "node:test";
import { expandedPixelSkinCardBounds, PIXEL_SKIN_CARD_SIZE } from "../src/renderer/src/features/skins/pixelSkinCardGeometry.ts";

test("pixel frames normalize both smaller and larger cards to one 3:2 size", () => {
  const cards = [
    { id: "fixed", position: { x: 100, y: 100 }, size: { ...PIXEL_SKIN_CARD_SIZE } },
    { id: "small", position: { x: 110, y: 110 }, size: { width: 700, height: 430 } },
    { id: "large", position: { x: 150, y: 150 }, size: { width: 1440, height: 900 } }
  ];
  const changed = expandedPixelSkinCardBounds(cards);
  assert.deepEqual(changed.map(({ id }) => id), ["small", "large"]);
  assert.ok(changed.every(({ bounds }) => bounds.size.width === 960 && bounds.size.height === 640));
  assert.ok(changed[0].bounds.position.x >= 100 + 960 + 40);
  assert.ok(changed[1].bounds.position.x >= changed[0].bounds.position.x + 960 + 40);
  assert.deepEqual(expandedPixelSkinCardBounds([
    cards[0],
    ...changed.map(({ id, bounds }) => ({ id, ...bounds }))
  ]), []);
});
