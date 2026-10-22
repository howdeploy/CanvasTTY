import type { SessionBounds } from "../../../../shared/contracts";
import type { CanvasAutoSortSession } from "./canvasAutoSort";

/**
 * What the empty-canvas Auto-sort may move and what its undo puts back. Kept apart from the
 * arrangement itself (canvasAutoSort.ts) so the menu can tell whether a sort is possible without
 * loading the layout code.
 */
export type CanvasAutoSortMode = "task" | "status" | "project" | "grid";

export const CANVAS_AUTO_SORT_MODES: readonly CanvasAutoSortMode[] = ["task", "status", "project", "grid"];

export type CanvasAutoSortKind = "terminal" | "plugin" | "browser" | "note" | "files" | "material";

export interface CanvasAutoSortCandidate {
  id: string;
  kind: CanvasAutoSortKind;
  bounds: SessionBounds;
  /** A companion-style plugin window (mascot): sorted only when explicitly selected. */
  decorative?: boolean;
}

export interface CanvasAutoSortUndo {
  mode: CanvasAutoSortMode;
  before: ReadonlyMap<string, SessionBounds>;
  after: ReadonlyMap<string, SessionBounds>;
}

/** The last criterion (checked row) and the single undo step; renderer memory only. */
export interface CanvasAutoSortState {
  mode: CanvasAutoSortMode | null;
  undo: CanvasAutoSortUndo | null;
}

/** What the workspace hands the Tools submenu: the layout of this moment and how to change it. */
export interface CanvasAutoSortHost {
  /** Bounds of every rendered layer, by layer id. */
  bounds: ReadonlyMap<string, SessionBounds>;
  selection: ReadonlySet<string>;
  home: SessionBounds;
  regions: readonly SessionBounds[];
  sessions: readonly CanvasAutoSortSession[];
  /** Plugin windows and installed plugins, to tell companion mascots apart. */
  pluginCanvas: readonly { id: string; pluginId: string }[];
  plugins: readonly { manifest: { id: string }; sourceUrl: string }[];
  snapToGrid: boolean;
  state: CanvasAutoSortState;
  setState(state: CanvasAutoSortState): void;
  /** Persist new bounds through the same per-kind callbacks a group drag uses. */
  commit(next: ReadonlyMap<string, SessionBounds>): void;
  /** Outline the windows that just moved (presentation only). */
  mark(ids: ReadonlySet<string>): void;
  onError(message: string): void;
}

/** Notes, materials and file cards are annotations whose place carries meaning: never moved. */
const MOVABLE_KINDS: ReadonlySet<CanvasAutoSortKind> = new Set(["terminal", "plugin", "browser"]);

/**
 * Which windows an auto-sort moves. A marquee selection holding two or more movable windows
 * limits the sort to them. Otherwise (no selection, or one holding only notes, materials, Files
 * cards or a single window) every terminal, plugin and Browser window that is not completely
 * inside a canvas region moves: regions hold the person's own grouping, and moving a window out
 * of one silently changes its membership. Mascots stay out of that default scope unless the
 * person selected them.
 */
export function canvasAutoSortScope(
  candidates: readonly CanvasAutoSortCandidate[],
  selection: ReadonlySet<string>,
  regions: readonly SessionBounds[]
): string[] {
  const movable = candidates.filter((candidate) => MOVABLE_KINDS.has(candidate.kind));
  const selected = movable.filter((candidate) => selection.has(candidate.id));
  if (selected.length >= 2) return selected.map((candidate) => candidate.id);
  return movable
    .filter((candidate) => !candidate.decorative || selection.has(candidate.id))
    .filter((candidate) => !regions.some((region) => contains(region, candidate.bounds)))
    .map((candidate) => candidate.id);
}

/**
 * What an undo puts back: only windows that still sit exactly where the sort placed them.
 * A window the person moved or resized afterwards keeps its new place; a closed one is skipped.
 */
export function canvasAutoSortUndoTargets(
  undo: CanvasAutoSortUndo,
  current: ReadonlyMap<string, SessionBounds>
): Map<string, SessionBounds> {
  const result = new Map<string, SessionBounds>();
  for (const [id, before] of undo.before) {
    const placed = undo.after.get(id);
    const now = current.get(id);
    if (placed && now && sameBounds(placed, now) && !sameBounds(before, now)) result.set(id, before);
  }
  return result;
}

/** Whether a sort step moves or resizes anything; sorting an already sorted layout does not. */
export function canvasAutoSortMoves(step: Pick<CanvasAutoSortUndo, "before" | "after">): boolean {
  for (const [id, placed] of step.after) {
    const before = step.before.get(id);
    if (!before || !sameBounds(before, placed)) return true;
  }
  return false;
}

function contains(outer: SessionBounds, inner: SessionBounds): boolean {
  return inner.position.x >= outer.position.x
    && inner.position.y >= outer.position.y
    && inner.position.x + inner.size.width <= outer.position.x + outer.size.width
    && inner.position.y + inner.size.height <= outer.position.y + outer.size.height;
}

function sameBounds(left: SessionBounds, right: SessionBounds): boolean {
  return left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.size.width === right.size.width
    && left.size.height === right.size.height;
}
