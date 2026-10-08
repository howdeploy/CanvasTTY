import type { FileEntry } from "../../../../shared/contracts";

/**
 * Pure, renderer-side tree helpers for the Files card. These functions never
 * touch the filesystem or IPC; the main process returns ordered `FileEntry`
 * lists and the card composes them into a display tree.
 */

export interface FileTreeNode {
  entry: FileEntry;
  /**
   * Ordered child nodes, or null when this directory's contents have not been
   * loaded yet. A loaded but empty directory is an empty array.
   */
  children: FileTreeNode[] | null;
}

export interface FileTreeRow {
  entry: FileEntry;
  /** Zero-based nesting depth; root entries are depth 0. */
  depth: number;
  isDirectory: boolean;
  isExpanded: boolean;
  /** True once a directory's children have been loaded into the tree. */
  hasLoadedChildren: boolean;
}

/** Case-insensitive name compare with a stable case-sensitive tiebreak. */
function compareNames(left: string, right: string): number {
  const leftLower = left.toLowerCase();
  const rightLower = right.toLowerCase();
  if (leftLower < rightLower) return -1;
  if (leftLower > rightLower) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Directories first, then files, each group sorted by name (case-insensitive). */
export function orderFileEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return compareNames(left.name, right.name);
  });
}

/**
 * Builds the visible tree from the root listing plus a map of already-loaded
 * directory listings keyed by directory relative path. Directories without a
 * loaded listing keep `children: null` so the UI can request expansion.
 */
export function buildFileTree(
  rootEntries: readonly FileEntry[],
  childrenByDirectory: Readonly<Record<string, readonly FileEntry[]>> = {}
): FileTreeNode[] {
  const build = (entries: readonly FileEntry[]): FileTreeNode[] =>
    orderFileEntries(entries).map((entry) => {
      if (entry.kind !== "directory") {
        return { entry, children: null } satisfies FileTreeNode;
      }
      const loaded = childrenByDirectory[entry.relativePath];
      return {
        entry,
        children: loaded === undefined ? null : build(loaded)
      } satisfies FileTreeNode;
    });
  return build(rootEntries);
}

/** Adds a folder path to the expanded set, or removes it when present. */
export function toggleExpandedFolder(
  expandedFolders: readonly string[],
  relativePath: string
): string[] {
  if (expandedFolders.includes(relativePath)) {
    return expandedFolders.filter((path) => path !== relativePath);
  }
  return [...expandedFolders, relativePath];
}

/**
 * Depth-first flattening of the tree into the rows a flat list can render.
 * Children are only walked for directories present in `expandedFolders` whose
 * listing has actually been loaded.
 */
export function flattenFileTree(
  tree: readonly FileTreeNode[],
  expandedFolders: readonly string[]
): FileTreeRow[] {
  const expanded = new Set(expandedFolders);
  const rows: FileTreeRow[] = [];
  const walk = (nodes: readonly FileTreeNode[], depth: number): void => {
    for (const node of nodes) {
      const isDirectory = node.entry.kind === "directory";
      const isExpanded = isDirectory && expanded.has(node.entry.relativePath);
      rows.push({
        entry: node.entry,
        depth,
        isDirectory,
        isExpanded,
        hasLoadedChildren: node.children !== null
      });
      if (isDirectory && isExpanded && node.children !== null) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(tree, 0);
  return rows;
}

function basename(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}

/**
 * Ranks file paths for quick open by case-insensitive substring match:
 * 4 = filename equals the query, 3 = filename starts with it, 2 = filename
 * contains it, 1 = only the directory path contains it. Ties shorten first,
 * then sort case-insensitively by full path.
 */
export function matchQuickOpen(
  relativePaths: readonly string[],
  query: string
): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const matches: Array<{ relativePath: string; score: number }> = [];
  for (const relativePath of relativePaths) {
    if (!relativePath.toLowerCase().includes(needle)) continue;
    const name = basename(relativePath).toLowerCase();
    let score = 1;
    if (name === needle) score = 4;
    else if (name.startsWith(needle)) score = 3;
    else if (name.includes(needle)) score = 2;
    matches.push({ relativePath, score });
  }
  return matches
    .sort((left, right) =>
      right.score - left.score
      || left.relativePath.length - right.relativePath.length
      || compareNames(left.relativePath, right.relativePath)
    )
    .map((match) => match.relativePath);
}
