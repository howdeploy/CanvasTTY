import assert from "node:assert/strict";
import test from "node:test";
import {
  boundsOverlapOrTouch,
  DEFAULT_SESSION_GAP,
  DEFAULT_SESSION_MARGIN,
  DEFAULT_SESSION_SIZE,
  findNearHomeSessionPosition,
  generateCandidatePositions
} from "../src/renderer/src/features/workspace/sessionPlacement.ts";

const HOME_BOUNDS = {
  position: { x: 0, y: 0 },
  size: { width: 1000, height: 700 }
};

const CARD_SIZE = { width: 700, height: 430 };

test("finds initial position to the right of Home with margin", () => {
  const pos = findNearHomeSessionPosition(HOME_BOUNDS, [], CARD_SIZE);
  assert.equal(pos.x, HOME_BOUNDS.position.x + HOME_BOUNDS.size.width + DEFAULT_SESSION_MARGIN);
  assert.equal(pos.y, HOME_BOUNDS.position.y);
});

test("is deterministic: same inputs always yield identical position", () => {
  const occupied = [
    { position: { x: 1040, y: 0 }, size: CARD_SIZE }
  ];
  const pos1 = findNearHomeSessionPosition(HOME_BOUNDS, occupied, CARD_SIZE);
  const pos2 = findNearHomeSessionPosition(HOME_BOUNDS, occupied, CARD_SIZE);
  assert.deepEqual(pos1, pos2);
});

test("does not intersect Home or occupied bounds", () => {
  const occupied = [];
  for (let i = 0; i < 10; i++) {
    const nextPos = findNearHomeSessionPosition(HOME_BOUNDS, occupied, CARD_SIZE);
    const candidateBounds = { position: nextPos, size: CARD_SIZE };

    // Check no overlap with Home
    assert.equal(
      boundsOverlapOrTouch(candidateBounds, HOME_BOUNDS, 0),
      false,
      `Card ${i} overlaps with Home`
    );

    // Check no overlap with existing occupied cards
    for (let j = 0; j < occupied.length; j++) {
      assert.equal(
        boundsOverlapOrTouch(candidateBounds, occupied[j], DEFAULT_SESSION_GAP),
        false,
        `Card ${i} overlaps with card ${j}`
      );
    }

    occupied.push(candidateBounds);
  }
});

test("reuses freed positions when cards are closed or moved", () => {
  const cards = [];
  for (let i = 0; i < 5; i++) {
    const pos = findNearHomeSessionPosition(HOME_BOUNDS, cards, CARD_SIZE);
    cards.push({ position: pos, size: CARD_SIZE });
  }

  // Remove the second card (index 1), leaving a hole
  const freedCard = cards[1];
  const occupiedWithHole = [cards[0], cards[2], cards[3], cards[4]];

  // The next placement should fill the freed hole
  const reusedPos = findNearHomeSessionPosition(HOME_BOUNDS, occupiedWithHole, CARD_SIZE);
  assert.deepEqual(reusedPos, freedCard.position);
});

test("allocates 40+ cards in compact 2D growth rather than a strip endlessly downward", () => {
  const occupied = [];
  const cardCount = 45;

  for (let i = 0; i < cardCount; i++) {
    const pos = findNearHomeSessionPosition(HOME_BOUNDS, occupied, CARD_SIZE);
    occupied.push({ position: pos, size: CARD_SIZE });
  }

  assert.equal(occupied.length, cardCount);

  // Compute bounding box of all placed cards
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const uniqueX = new Set();
  const uniqueY = new Set();

  for (const card of occupied) {
    minX = Math.min(minX, card.position.x);
    maxX = Math.max(maxX, card.position.x + card.size.width);
    minY = Math.min(minY, card.position.y);
    maxY = Math.max(maxY, card.position.y + card.size.height);
    uniqueX.add(card.position.x);
    uniqueY.add(card.position.y);
  }

  const clusterWidth = maxX - minX;
  const clusterHeight = maxY - minY;
  const aspectRatio = clusterWidth / clusterHeight;

  // With a 1D downward strip (e.g. 2 columns), 45 cards would be ~23 rows tall:
  // clusterWidth ~ 1400, clusterHeight ~ 10,000, aspectRatio ~ 0.14!
  // For compact 2D growth:
  // There should be multiple columns (at least 4) and multiple rows (at least 4).
  assert.ok(
    uniqueX.size >= 4,
    `Expected at least 4 columns for compact 2D growth, got ${uniqueX.size}`
  );
  assert.ok(
    uniqueY.size >= 4,
    `Expected at least 4 rows for compact 2D growth, got ${uniqueY.size}`
  );

  // Aspect ratio should be well-proportioned (e.g. between 0.6 and 2.5), not an endless strip (<0.2)
  assert.ok(
    aspectRatio >= 0.5 && aspectRatio <= 3.0,
    `Expected 2D aspect ratio between 0.5 and 3.0, got ${aspectRatio.toFixed(2)}`
  );
  assert.ok(maxY < 3000 && minY > -3000, `45 cards drifted too far vertically: ${minY}..${maxY}`);
});

test("respects different Home sizes without pushing the first card far away", () => {
  for (const size of [{ width: 650, height: 520 }, { width: 1400, height: 900 }]) {
    const home = { position: { x: -200, y: 100 }, size };
    const position = findNearHomeSessionPosition(home, []);
    assert.deepEqual(position, { x: home.position.x + size.width + DEFAULT_SESSION_MARGIN, y: home.position.y });
    assert.equal(boundsOverlapOrTouch({ position, size: DEFAULT_SESSION_SIZE }, home), false);
  }
});

test("handles custom size, gap, and margin options", () => {
  const customSize = { width: 500, height: 300 };
  const customGap = 15;
  const customMargin = 50;

  const pos = findNearHomeSessionPosition(HOME_BOUNDS, [], customSize, {
    gap: customGap,
    margin: customMargin
  });

  assert.equal(pos.x, HOME_BOUNDS.position.x + HOME_BOUNDS.size.width + customMargin);
  assert.equal(pos.y, HOME_BOUNDS.position.y);
});

test("is bounded and robust with arbitrary occupied cards", () => {
  // Random or arbitrary scattered existing cards
  const existingCards = [
    { position: { x: 1040, y: 0 }, size: { width: 800, height: 500 } },
    { position: { x: 1900, y: 100 }, size: { width: 700, height: 400 } },
    { position: { x: 1100, y: 600 }, size: { width: 600, height: 300 } }
  ];

  const pos = findNearHomeSessionPosition(HOME_BOUNDS, existingCards, CARD_SIZE);
  const bounds = { position: pos, size: CARD_SIZE };

  assert.equal(boundsOverlapOrTouch(bounds, HOME_BOUNDS, 0), false);
  for (const card of existingCards) {
    assert.equal(boundsOverlapOrTouch(bounds, card, DEFAULT_SESSION_GAP), false);
  }
});
