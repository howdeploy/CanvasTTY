import { watch } from "node:fs";
import { dirname } from "node:path";

export interface WatchHandle {
  close(): void;
}

export type WatchFactory = (directory: string, listener: () => void, failed: () => void) => WatchHandle;

export const MAX_WATCHED_DIRECTORIES = 64;

export const nodeWatchFactory: WatchFactory = (directory, listener, failed) => {
  const watcher = watch(directory, { persistent: false }, () => listener());
  watcher.on("error", () => {
    watcher.close();
    failed();
  });
  return watcher;
};

interface DirectoryEntry {
  handle: WatchHandle | null;
  ids: Set<string>;
}

export class DirectoryWatchSet {
  private readonly factory: WatchFactory;
  private readonly changed: (ids: string[]) => void;
  private readonly directories = new Map<string, DirectoryEntry>();
  private readonly directoryOf = new Map<string, string>();

  constructor(factory: WatchFactory, changed: (ids: string[]) => void) {
    this.factory = factory;
    this.changed = changed;
  }

  track(id: string, path: string | null): void {
    const next = path === null ? null : dirname(path);
    const previous = this.directoryOf.get(id) ?? null;
    if (previous === next) return;
    if (previous !== null) this.release(id, previous);
    if (next === null) return;
    this.directoryOf.set(id, next);
    const entry = this.directories.get(next);
    if (entry) {
      entry.ids.add(id);
      return;
    }
    const created: DirectoryEntry = { handle: null, ids: new Set([id]) };
    this.directories.set(next, created);
    this.open(next, created);
  }

  retry(): void {
    for (const [directory, entry] of this.directories) {
      if (entry.handle === null) this.open(directory, entry);
    }
  }

  untrack(id: string): void {
    const directory = this.directoryOf.get(id);
    if (directory !== undefined) this.release(id, directory);
  }

  watched(id: string): boolean {
    const directory = this.directoryOf.get(id);
    return directory !== undefined && this.directories.get(directory)?.handle !== null;
  }

  close(): void {
    for (const entry of this.directories.values()) entry.handle?.close();
    this.directories.clear();
    this.directoryOf.clear();
  }

  private release(id: string, directory: string): void {
    this.directoryOf.delete(id);
    const entry = this.directories.get(directory);
    if (!entry) return;
    entry.ids.delete(id);
    if (entry.ids.size > 0) return;
    entry.handle?.close();
    this.directories.delete(directory);
  }

  private open(directory: string, entry: DirectoryEntry): void {
    if (this.watchedCount() >= MAX_WATCHED_DIRECTORIES) return;
    try {
      const handle = this.factory(directory, () => this.changed([...entry.ids]), () => {
        if (entry.handle === handle) entry.handle = null;
      });
      entry.handle = handle;
    } catch {
      entry.handle = null;
    }
  }

  private watchedCount(): number {
    let count = 0;
    for (const entry of this.directories.values()) if (entry.handle !== null) count += 1;
    return count;
  }
}
