import type {
  BrowserCanvasState,
  CanvasMaterial,
  CanvasRegion,
  PluginCanvasInstance,
  SessionBounds,
  SessionSnapshot,
  StickyNote
} from "../../../../shared/contracts";
import { boundsEqual } from "./canvasStacking.ts";

export interface MinimapContent {
  homeBounds: SessionBounds;
  canvasRegions: readonly CanvasRegion[];
  sessions: readonly SessionSnapshot[];
  stickyNotes: readonly StickyNote[];
  materials: readonly CanvasMaterial[];
  pluginCanvas: readonly PluginCanvasInstance[];
  browserCanvas: BrowserCanvasState | null;
  layerOrder: readonly string[];
}

/** Session output, titles and activity do not change the workspace projection. */
export function minimapContentEqual(previous: MinimapContent, next: MinimapContent): boolean {
  return boundsEqual(previous.homeBounds, next.homeBounds)
    && sameItems(previous.layerOrder, next.layerOrder, (left, right) => left === right)
    && sameItems(previous.canvasRegions, next.canvasRegions, (left, right) => (
      left.id === right.id && left.color === right.color && boundsEqual(left, right)
    ))
    && sameItems(previous.sessions, next.sessions, (left, right) => (
      left.id === right.id && left.provider === right.provider && boundsEqual(left, right)
    ))
    && sameItems(previous.stickyNotes, next.stickyNotes, sameWindow)
    && sameItems(previous.materials, next.materials, sameWindow)
    && sameItems(previous.pluginCanvas, next.pluginCanvas, sameWindow)
    && (previous.browserCanvas === next.browserCanvas || (
      previous.browserCanvas !== null && next.browserCanvas !== null
      && boundsEqual(previous.browserCanvas, next.browserCanvas)
    ));
}

function sameWindow(left: SessionBounds & { id: string }, right: SessionBounds & { id: string }): boolean {
  return left.id === right.id && boundsEqual(left, right);
}

function sameItems<T>(previous: readonly T[], next: readonly T[], equal: (left: T, right: T) => boolean): boolean {
  return previous === next || (
    previous.length === next.length && previous.every((item, index) => equal(item, next[index]))
  );
}
