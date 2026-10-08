import type { Point, SessionBounds } from "../../../../shared/contracts";


export interface WorkspaceLayoutItem {
  id: string;
  bounds: SessionBounds;
  parentId?: string;
  status?: string;
  project?: string;
}

const GAP_X = 56;
const GAP_Y = 44;

/** Place cards in a collision-free parent/child tree while keeping each root anchored at origin. */
export function arrangeTaskTree(
  items: readonly WorkspaceLayoutItem[],
  origin: Point,
  gapX = GAP_X,
  gapY = GAP_Y
): Map<string, SessionBounds> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string, WorkspaceLayoutItem[]>();
  const roots: WorkspaceLayoutItem[] = [];
  for (const item of items) {
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    if (!parent || parent.id === item.id) {
      roots.push(item);
      continue;
    }
    const row = children.get(parent.id) ?? [];
    row.push(item);
    children.set(parent.id, row);
  }
  for (const row of children.values()) row.sort((a, b) => a.id.localeCompare(b.id));
  const depth = new Map<string, number>();
  const markDepth = (item: WorkspaceLayoutItem, level: number): void => {
    if (depth.has(item.id)) return;
    depth.set(item.id, level);
    for (const child of children.get(item.id) ?? []) markDepth(child, level + 1);
  };
  for (const root of roots) markDepth(root, 0);
  // A malformed cyclic component has no natural root. Break one edge and arrange it as a tree.
  for (const item of items) {
    if (depth.has(item.id)) continue;
    roots.push(item);
    const parentId = item.parentId;
    if (parentId) children.set(parentId, (children.get(parentId) ?? []).filter((child) => child.id !== item.id));
    markDepth(item, 0);
  }
  roots.sort((a, b) => a.id.localeCompare(b.id));

  const levelWidths: number[] = [];
  for (const item of items) {
    const level = depth.get(item.id) ?? 0;
    levelWidths[level] = Math.max(levelWidths[level] ?? 0, item.bounds.size.width);
  }

  const levelX: number[] = [];
  for (let index = 1; index < levelWidths.length; index += 1) {
    levelX[index] = (levelX[index - 1] ?? 0) + (levelWidths[index - 1] ?? 0) + gapX;
  }

  const result = new Map<string, SessionBounds>();
  const subtreeHeightCache = new Map<string, number>();
  const subtreeHeight = (item: WorkspaceLayoutItem): number => {
    const cached = subtreeHeightCache.get(item.id);
    if (cached !== undefined) return cached;
    const row = children.get(item.id) ?? [];
    const childHeight = row.length === 0 ? 0
      : row.reduce((sum, child) => sum + subtreeHeight(child), 0) + gapY * (row.length - 1);
    const height = Math.max(item.bounds.size.height, childHeight);
    subtreeHeightCache.set(item.id, height);
    return height;
  };
  const place = (item: WorkspaceLayoutItem, blockTop: number): void => {
    const level = depth.get(item.id) ?? 0;
    result.set(item.id, at(origin.x + (levelX[level] ?? 0), blockTop, item.bounds));
    const row = children.get(item.id) ?? [];
    if (row.length === 0) return;
    const totalChildHeight = row.reduce((sum, child) => sum + subtreeHeight(child), 0) + gapY * (row.length - 1);
    let childTop = blockTop + Math.max(0, (item.bounds.size.height - totalChildHeight) / 2);
    for (const child of row) {
      place(child, childTop);
      childTop += subtreeHeight(child) + gapY;
    }
  };
  let cursorY = origin.y;
  for (const root of roots) {
    place(root, cursorY);
    cursorY += subtreeHeight(root) + gapY;
  }
  return result;
}

export function taskTreeBounds(
  parent: WorkspaceLayoutItem,
  descendants: readonly WorkspaceLayoutItem[],
  gapX = GAP_X,
  gapY = GAP_Y
): Map<string, SessionBounds> {
  const subtreeIds = new Set([parent.id]);
  const queue = [parent.id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of descendants) {
      if (child.parentId === current && !subtreeIds.has(child.id)) {
        subtreeIds.add(child.id);
        queue.push(child.id);
      }
    }
  }
  const subtree = descendants.filter((item) => item.id !== parent.id && subtreeIds.has(item.id));
  return arrangeTaskTree([parent, ...subtree], parent.bounds.position, gapX, gapY);
}

function at(x: number, y: number, bounds: SessionBounds): SessionBounds {
  return { position: { x, y }, size: { ...bounds.size } };
}

