import type { Point, SessionBounds, Size } from "../../../../shared/contracts";

export interface SessionPlacementOptions {
  /** Gap between placed cards. Defaults to 24px. */
  gap?: number;
  /** Margin separating placed cards from Home bounds. Defaults to 40px. */
  margin?: number;
  /** Maximum number of candidate positions to test before fallback. Defaults to 2000. */
  maxCandidates?: number;
}

export const DEFAULT_SESSION_SIZE: Size = { width: 700, height: 430 };
export const DEFAULT_SESSION_GAP = 24;
export const DEFAULT_SESSION_MARGIN = 40;

/**
 * Checks whether two bounds intersect, treating touch/overlap within gap as intersection.
 */
export function boundsOverlapOrTouch(
  a: SessionBounds,
  b: SessionBounds,
  minGap = 0
): boolean {
  return (
    a.position.x < b.position.x + b.size.width + minGap &&
    a.position.x + a.size.width + minGap > b.position.x &&
    a.position.y < b.position.y + b.size.height + minGap &&
    a.position.y + a.size.height + minGap > b.position.y
  );
}

/**
 * Calculates Euclidean distance between the center of candidate bounds and the center of Home.
 */
function distanceToHomeCenter(
  bounds: SessionBounds,
  homeCenter: Point
): number {
  const cx = bounds.position.x + bounds.size.width / 2;
  const cy = bounds.position.y + bounds.size.height / 2;
  return Math.hypot(cx - homeCenter.x, cy - homeCenter.y);
}

/**
 * Generates an ordered sequence of discrete grid candidate positions near Home.
 *
 * Design:
 * - Starts at the primary anchor to the right (East) of Home, aligned with Home's top.
 *   X_base = home.x + home.width + margin
 *   Y_base = home.y
 * - Grid steps are (cardWidth + gap, cardHeight + gap).
 * - Searches in every direction around Home after the preferred first position.
 *   This keeps a large collection compact instead of growing endlessly down or right.
 * - Candidates are sorted deterministically by distance from Home's visual center,
 *   with row-major / col-major tie-breaking.
 * - Any freed positions (gaps created by closing/moving a card) are visited early in the sequence and reused.
 * - No candidate intersects Home or any occupied bounds.
 */
export function generateCandidatePositions(
  homeBounds: SessionBounds,
  size: Size,
  options: SessionPlacementOptions = {}
): Point[] {
  const gap = options.gap ?? DEFAULT_SESSION_GAP;
  const margin = options.margin ?? DEFAULT_SESSION_MARGIN;
  const maxCandidates = options.maxCandidates ?? 2000;

  const stepX = size.width + gap;
  const stepY = size.height + gap;

  // Primary anchor: East of Home
  const baseX = homeBounds.position.x + homeBounds.size.width + margin;
  const baseY = homeBounds.position.y;

  const homeCenter: Point = {
    x: homeBounds.position.x + homeBounds.size.width / 2,
    y: homeBounds.position.y + homeBounds.size.height / 2
  };

  interface CandidateEntry {
    point: Point;
    dist: number;
    col: number;
    row: number;
  }

  const entries: CandidateEntry[] = [];

  // The first slot stays immediately east of Home. After that, search the
  // surrounding lattice; filtering below excludes cells overlapping Home.
  const maxExtent = Math.max(6, Math.ceil(Math.sqrt(maxCandidates) / 2) + 4);
  for (let col = -maxExtent; col <= maxExtent; col += 1) {
    for (let row = -maxExtent; row <= maxExtent; row += 1) {
      if (col === 0 && row === 0) continue;
      const point: Point = {
        x: baseX + col * stepX,
        y: baseY + row * stepY
      };
      const bounds: SessionBounds = { position: point, size };
      const dist = distanceToHomeCenter(bounds, homeCenter);
      entries.push({ point, dist, col, row });
    }
  }

  entries.sort((a, b) => {
    if (Math.abs(a.dist - b.dist) > 0.001) {
      return a.dist - b.dist;
    }
    if (a.row !== b.row) {
      return a.row - b.row;
    }
    return a.col - b.col;
  });

  return [{ x: baseX, y: baseY }, ...entries.slice(0, maxCandidates - 1).map((e) => e.point)];
}

/**
 * Finds a deterministic, non-overlapping free position for a new terminal session near Home.
 *
 * @param homeBounds Bounding box of Home.
 * @param occupied Array of occupied card/session bounds currently on canvas.
 * @param size Size of the card to place (defaults to 700x430).
 * @param options Placement configuration (gap, margin).
 * @returns The chosen Point (x, y) for the new session.
 */
export function findNearHomeSessionPosition(
  homeBounds: SessionBounds,
  occupied: readonly SessionBounds[],
  size: Size = DEFAULT_SESSION_SIZE,
  options: SessionPlacementOptions = {}
): Point {
  const gap = options.gap ?? DEFAULT_SESSION_GAP;
  const candidates = generateCandidatePositions(homeBounds, size, options);

  for (const candidate of candidates) {
    const candidateBounds: SessionBounds = { position: candidate, size };

    // Must not overlap Home
    if (boundsOverlapOrTouch(candidateBounds, homeBounds, 0)) {
      continue;
    }

    // Must not overlap any occupied bounds
    let collision = false;
    for (const card of occupied) {
      if (boundsOverlapOrTouch(candidateBounds, card, gap)) {
        collision = true;
        break;
      }
    }

    if (!collision) {
      return candidate;
    }
  }

  // Fallback if all discrete candidates collided (extremely dense/large canvas):
  // Place safely to the right of all known occupied bounds and Home.
  let maxRight = homeBounds.position.x + homeBounds.size.width;
  for (const card of occupied) {
    maxRight = Math.max(maxRight, card.position.x + card.size.width);
  }

  return {
    x: maxRight + (options.margin ?? DEFAULT_SESSION_MARGIN),
    y: homeBounds.position.y
  };
}
