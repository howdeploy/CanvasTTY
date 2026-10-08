import { useSyncExternalStore } from "react";
import type { Point, SessionBounds, SessionSnapshot } from "../../../../shared/contracts";
import { boundsEqual } from "./canvasStacking";
import { translateBounds } from "./canvasRegions";
import { terminalLayerId } from "./canvasSelectionGesture";
import type { TaskCardState } from "./workspaceTaskGraph";

type TaskBoundsPreviewStore = {
  getSnapshot(): ReadonlyMap<string, SessionBounds>;
  subscribe(listener: () => void): () => void;
  set(sessionId: string, bounds: SessionBounds | null): void;
};

export function createTaskBoundsPreviewStore(): TaskBoundsPreviewStore {
  let snapshot: ReadonlyMap<string, SessionBounds> = new Map();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(sessionId, bounds) {
      const previous = snapshot.get(sessionId);
      if (bounds === null ? previous === undefined : previous !== undefined && boundsEqual(previous, bounds)) return;
      const next = new Map(snapshot);
      if (bounds === null) next.delete(sessionId);
      else next.set(sessionId, { position: { ...bounds.position }, size: { ...bounds.size } });
      snapshot = next;
      for (const listener of listeners) listener();
    }
  };
}

/** Bounds previews only affect task arrows; keep their pointer-move updates out of the canvas tree. */
export function TaskEdgeLayer({
  edges,
  sessions,
  previews,
  selected,
  groupNudge
}: {
  edges: readonly { parentId: string; childId: string; state: TaskCardState }[];
  sessions: ReadonlyMap<string, SessionSnapshot>;
  previews: TaskBoundsPreviewStore;
  selected: ReadonlySet<string>;
  groupNudge: Point | null | undefined;
}): React.JSX.Element {
  const live = useSyncExternalStore(previews.subscribe, previews.getSnapshot, previews.getSnapshot);
  const boundsFor = (session: SessionSnapshot): SessionBounds => {
    const bounds = live.get(session.id) ?? { position: session.position, size: session.size };
    return selected.has(terminalLayerId(session.id)) && groupNudge ? translateBounds(bounds, groupNudge) : bounds;
  };
  return <div className="workspace__task-edges" aria-hidden="true">
    {edges.map((edge) => {
      const parent = sessions.get(edge.parentId);
      const child = sessions.get(edge.childId);
      if (!parent || !child) return null;
      const parentBounds = boundsFor(parent);
      const childBounds = boundsFor(child);
      const parentCenter = parentBounds.position.x + parentBounds.size.width / 2;
      const childCenter = childBounds.position.x + childBounds.size.width / 2;
      const forward = childCenter >= parentCenter;
      const x1 = forward ? parentBounds.position.x + parentBounds.size.width : parentBounds.position.x;
      const x2 = forward ? childBounds.position.x : childBounds.position.x + childBounds.size.width;
      const y1 = parentBounds.position.y + parentBounds.size.height / 2;
      const y2 = childBounds.position.y + childBounds.size.height / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      return <div key={`${edge.parentId}:${edge.childId}`} className="workspace__task-edge"
        data-state={edge.state} style={{ left: x1, top: y1, width: Math.hypot(dx, dy), transform: `rotate(${Math.atan2(dy, dx)}rad)` }} />;
    })}
  </div>;
}

