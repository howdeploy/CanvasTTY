import type { Point, SessionBounds, SessionStatus } from "../../../../shared/contracts";
import type { CanvasAutoSortMode } from "./canvasAutoSortScope";

/**
 * Auto-sort for the empty-canvas Tools submenu. Pure geometry: the workspace collects the
 * windows in scope (canvasAutoSortScope.ts), this module decides where they go, and the
 * workspace commits the result through the same per-kind bounds callbacks a group drag uses.
 * The workspace loads it on demand, the first time a criterion is chosen.
 *
 * Every arrangement is deterministic. Ties are broken by the current reading order (top to
 * bottom, then left to right), then by start time, then by id, so sorting twice in a row is
 * a no-op and the result does not depend on the order the windows were listed in.
 */
export interface CanvasAutoSortItem {
  /** The canvas layer id (`data-canvas-layer-id`). */
  id: string;
  bounds: SessionBounds;
  /** Layer id of the session that spawned this one (orchestrator to subagent). */
  parentId?: string;
  status?: SessionStatus;
  /** Working folder; windows without one go to a trailing group. */
  project?: string;
  startedAt?: number;
}

/** The session fields auto-sort reads (a subset of SessionSnapshot). */
export interface CanvasAutoSortSession {
  id: string;
  parentSessionId?: string;
  status: SessionStatus;
  cwd: string;
  startedAt: number;
}

/** What the block must stay clear of, and whether window snapping is on. */
export interface CanvasAutoSortOptions {
  /** Fixed areas the block may not cover, e.g. HOME and canvas regions. */
  avoid?: readonly SessionBounds[];
  snapToGrid?: boolean;
  /** For a region plan: center the existing arrangement inside it, or refuse the whole step. */
  within?: SessionBounds;
}

/**
 * Build the items for the windows in scope from their current bounds and arrange them. Returns
 * null when fewer than two of them still exist, or a region cannot safely hold the arrangement.
 * `layerIdOf` maps a session id to its layer id.
 * Every layer in `bounds` that is not sorted (notes, materials, Files cards, windows left out of
 * the scope) is an obstacle the sorted block keeps clear of, like `options.avoid`.
 */
export function planCanvasAutoSort(
  ids: readonly string[],
  bounds: ReadonlyMap<string, SessionBounds>,
  sessions: readonly CanvasAutoSortSession[],
  layerIdOf: (sessionId: string) => string,
  mode: CanvasAutoSortMode,
  options: CanvasAutoSortOptions
): { before: Map<string, SessionBounds>; after: Map<string, SessionBounds> } | null {
  const sessionByLayer = new Map(sessions.map((session) => [layerIdOf(session.id), session]));
  const items: CanvasAutoSortItem[] = [];
  for (const id of new Set(ids)) {
    const current = bounds.get(id);
    if (!current) continue;
    const session = sessionByLayer.get(id);
    items.push({
      id,
      bounds: { position: { ...current.position }, size: { ...current.size } },
      ...(session ? {
        ...(session.parentSessionId ? { parentId: layerIdOf(session.parentSessionId) } : {}),
        status: session.status,
        project: session.cwd,
        startedAt: session.startedAt
      } : {})
    });
  }
  if (items.length < 2) return null;
  const sorted = new Set(items.map((item) => item.id));
  const obstacles = [...options.avoid ?? [], ...[...bounds].filter(([id]) => !sorted.has(id)).map(([, value]) => value)];
  const arranged = arrangeCanvasAutoSort(items, mode, { avoid: options.within ? [] : obstacles, snapToGrid: options.snapToGrid });
  const after = options.within ? centerInRegion(arranged, options.within, obstacles, options.snapToGrid === true) : arranged;
  if (!after) return null;
  return {
    before: new Map(items.map((item) => [item.id, item.bounds])),
    after
  };
}

/** The contract's snapping gap between neighbouring windows; criterion groups get twice that. */
const GAP = 20;
const GROUP_GAP = 2 * GAP;
const GRID = 10;

function centerInRegion(
  arranged: ReadonlyMap<string, SessionBounds>,
  region: SessionBounds,
  obstacles: readonly SessionBounds[],
  snap: boolean
): Map<string, SessionBounds> | null {
  // Keep 20px at the edges and 60px above the content for the existing region title.
  const content = {
    position: { x: region.position.x + GAP, y: region.position.y + 3 * GAP },
    size: { width: region.size.width - 2 * GAP, height: region.size.height - 4 * GAP }
  };
  const block = boundingBox([...arranged.values()]);
  const round = (value: number): number => snap ? Math.round(value / GRID) * GRID : Math.round(value);
  const x = round(content.position.x + (content.size.width - block.size.width) / 2);
  const y = round(content.position.y + (content.size.height - block.size.height) / 2);
  if (x < content.position.x || y < content.position.y
    || x + block.size.width > content.position.x + content.size.width
    || y + block.size.height > content.position.y + content.size.height) return null;
  const margin = { position: { x: x - GAP, y: y - GAP }, size: { width: block.size.width + 2 * GAP, height: block.size.height + 2 * GAP } };
  // shortcut: reject an obstructed centered block; add bounded placement search only if requested.
  if (obstacles.some((obstacle) => overlaps(margin, obstacle))) return null;
  return new Map([...arranged].map(([id, bounds]) => [id,
    at(x + bounds.position.x - block.position.x, y + bounds.position.y - block.position.y, bounds)
  ]));
}

/** The next start after an edge: the gap past it, rounded up onto the grid when snapping. */
type Step = (edge: number, gap?: number) => number;

/**
 * The new bounds of every item. The block starts at the top-left corner of the windows' current
 * bounding box (on the grid when snapping), so the windows stay where the person was looking. If
 * the block would cover anything in `options.avoid` it shifts right or down, whichever is the
 * shorter move, until it is clear by at least the gap. With snapping every window lands on the
 * grid. Sizes never change.
 */
export function arrangeCanvasAutoSort(
  items: readonly CanvasAutoSortItem[],
  mode: CanvasAutoSortMode,
  options: CanvasAutoSortOptions = {}
): Map<string, SessionBounds> {
  if (items.length === 0) return new Map();
  const snap = options.snapToGrid === true;
  const step: Step = (edge, gap = GAP) => (snap ? Math.ceil((edge + gap) / GRID) * GRID : edge + gap);
  const local = arrangeAt(items, mode, step);
  const extent = boundingBox([...local.values()]).size;
  const current = boundingBox(items.map((item) => item.bounds)).position;
  const start = snap
    ? { x: Math.round(current.x / GRID) * GRID, y: Math.round(current.y / GRID) * GRID }
    : { x: Math.round(current.x), y: Math.round(current.y) };
  const origin = clearSpot(start, extent, options.avoid ?? [], step);
  const result = new Map<string, SessionBounds>();
  for (const [id, bounds] of local) result.set(id, at(bounds.position.x + origin.x, bounds.position.y + origin.y, bounds));
  return result;
}

/**
 * The nearest place right of or below `start` where a block of `size`, grown by the gap, overlaps
 * none of `obstacles`. Each sweep only ever moves past an obstacle's far edge, so it ends after at
 * most one move per obstacle.
 */
function clearSpot(start: Point, size: SessionBounds["size"], obstacles: readonly SessionBounds[], step: Step): Point {
  const sweep = (axis: "x" | "y"): Point => {
    const spot = { ...start };
    for (let moves = 0; moves <= obstacles.length; moves += 1) {
      const margin = { position: { x: spot.x - GAP, y: spot.y - GAP }, size: { width: size.width + 2 * GAP, height: size.height + 2 * GAP } };
      const hit = obstacles.find((obstacle) => overlaps(margin, obstacle));
      if (!hit) break;
      spot[axis] = step(axis === "x" ? hit.position.x + hit.size.width : hit.position.y + hit.size.height);
    }
    return spot;
  };
  const right = sweep("x");
  const down = sweep("y");
  return down.y - start.y < right.x - start.x ? down : right;
}

function arrangeAt(items: readonly CanvasAutoSortItem[], mode: CanvasAutoSortMode, step: Step): Map<string, SessionBounds> {
  const ordered = [...items].sort(readingOrder);
  if (mode === "task") return arrangeTaskTree(ordered, step);
  if (mode === "grid") return arrangeGrid(ordered, 0, step);
  const groups = new Map<string, CanvasAutoSortItem[]>();
  for (const item of ordered) {
    const key = mode === "status" ? statusGroup(item.status) : projectGroup(item.project);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const result = new Map<string, SessionBounds>();
  let x = 0;
  for (const key of [...groups.keys()].sort(compareText)) {
    let right = x;
    for (const [id, bounds] of arrangeGrid(groups.get(key)!, x, step)) {
      result.set(id, bounds);
      right = Math.max(right, bounds.position.x + bounds.size.width);
    }
    x = step(right, GROUP_GAP);
  }
  return result;
}

/** Orchestrators in a column, each subagent to the right of the session that spawned it. */
function arrangeTaskTree(ordered: readonly CanvasAutoSortItem[], step: Step): Map<string, SessionBounds> {
  const byId = new Map(ordered.map((item) => [item.id, item]));
  const children = new Map<string, CanvasAutoSortItem[]>();
  const roots: CanvasAutoSortItem[] = [];
  for (const item of ordered) {
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    if (!parent || parent.id === item.id) {
      roots.push(item);
      continue;
    }
    const row = children.get(parent.id) ?? [];
    row.push(item);
    children.set(parent.id, row);
  }
  const depth = new Map<string, number>();
  const markDepth = (item: CanvasAutoSortItem, level: number): void => {
    if (depth.has(item.id)) return;
    depth.set(item.id, level);
    for (const child of children.get(item.id) ?? []) markDepth(child, level + 1);
  };
  for (const root of roots) markDepth(root, 0);
  // A malformed parent cycle has no natural root: break it at its first window in reading order.
  for (const item of ordered) {
    if (depth.has(item.id)) continue;
    roots.push(item);
    if (item.parentId) {
      children.set(item.parentId, (children.get(item.parentId) ?? []).filter((child) => child.id !== item.id));
    }
    markDepth(item, 0);
  }

  const levelWidths: number[] = [];
  for (const item of ordered) {
    const level = depth.get(item.id) ?? 0;
    levelWidths[level] = Math.max(levelWidths[level] ?? 0, item.bounds.size.width);
  }
  const levelX: number[] = [0];
  for (let level = 1; level < levelWidths.length; level += 1) {
    levelX[level] = step(levelX[level - 1]! + (levelWidths[level - 1] ?? 0));
  }

  // A subtree's height measured the way `place` stacks it, so grid rounding never makes rows overlap.
  const heights = new Map<string, number>();
  const subtreeHeight = (item: CanvasAutoSortItem): number => {
    const cached = heights.get(item.id);
    if (cached !== undefined) return cached;
    let top = 0;
    let bottom = 0;
    for (const child of children.get(item.id) ?? []) {
      bottom = top + subtreeHeight(child);
      top = step(bottom);
    }
    const height = Math.max(item.bounds.size.height, bottom);
    heights.set(item.id, height);
    return height;
  };
  const result = new Map<string, SessionBounds>();
  const place = (item: CanvasAutoSortItem, top: number): void => {
    result.set(item.id, at(levelX[depth.get(item.id) ?? 0] ?? 0, top, item.bounds));
    let childTop = top;
    for (const child of children.get(item.id) ?? []) {
      place(child, childTop);
      childTop = step(childTop + subtreeHeight(child));
    }
  };
  let top = 0;
  for (const root of roots) {
    place(root, top);
    top = step(top + subtreeHeight(root));
  }
  return result;
}

/** A near-square grid; each column is as wide as its widest window and each row as tall as its tallest. */
function arrangeGrid(ordered: readonly CanvasAutoSortItem[], left: number, step: Step): Map<string, SessionBounds> {
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const rows = Math.ceil(ordered.length / columns);
  const columnWidths = Array.from({ length: columns }, () => 0);
  const rowHeights = Array.from({ length: rows }, () => 0);
  ordered.forEach((item, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    columnWidths[column] = Math.max(columnWidths[column]!, item.bounds.size.width);
    rowHeights[row] = Math.max(rowHeights[row]!, item.bounds.size.height);
  });
  const columnX = [left];
  for (let index = 1; index < columns; index += 1) columnX[index] = step(columnX[index - 1]! + columnWidths[index - 1]!);
  const rowY = [0];
  for (let index = 1; index < rows; index += 1) rowY[index] = step(rowY[index - 1]! + rowHeights[index - 1]!);
  return new Map(ordered.map((item, index) => [
    item.id,
    at(columnX[index % columns]!, rowY[Math.floor(index / columns)]!, item.bounds)
  ]));
}

/** Columns left to right: what needs the person first, then what is idle, then what ended. */
function statusGroup(status: SessionStatus | undefined): string {
  switch (status) {
    case "needs_approval": return "0";
    case "working": return "1";
    case "idle": return "2";
    case "done": return "3";
    case "failed": return "4";
    case "unavailable": return "5";
    default: return "6";
  }
}

/** One column per working folder in path order; windows without a folder come last. */
function projectGroup(project: string | undefined): string {
  const normalized = project?.trim().replace(/(?<=.)[\\/]+$/u, "") ?? "";
  return normalized ? `0${normalized}` : "1";
}

function readingOrder(left: CanvasAutoSortItem, right: CanvasAutoSortItem): number {
  return left.bounds.position.y - right.bounds.position.y
    || left.bounds.position.x - right.bounds.position.x
    || (left.startedAt ?? 0) - (right.startedAt ?? 0)
    || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function at(x: number, y: number, bounds: SessionBounds): SessionBounds {
  return { position: { x, y }, size: { ...bounds.size } };
}

function boundingBox(bounds: readonly SessionBounds[]): SessionBounds {
  const left = Math.min(...bounds.map((item) => item.position.x));
  const top = Math.min(...bounds.map((item) => item.position.y));
  const right = Math.max(...bounds.map((item) => item.position.x + item.size.width));
  const bottom = Math.max(...bounds.map((item) => item.position.y + item.size.height));
  return { position: { x: left, y: top }, size: { width: right - left, height: bottom - top } };
}

function overlaps(left: SessionBounds, right: SessionBounds): boolean {
  return left.position.x < right.position.x + right.size.width
    && left.position.x + left.size.width > right.position.x
    && left.position.y < right.position.y + right.size.height
    && left.position.y + left.size.height > right.position.y;
}
