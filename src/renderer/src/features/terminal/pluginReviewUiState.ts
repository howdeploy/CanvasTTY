import type { SessionMetadata } from "../../../../shared/contracts";

export interface VirtualFileWindow {
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
}

export function virtualFileWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 4
): VirtualFileWindow {
  const count = Math.max(0, Math.floor(itemCount));
  const height = Math.max(1, rowHeight);
  const firstVisible = Math.min(count, Math.floor(Math.max(0, scrollTop) / height));
  const visibleEnd = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / height));
  const startIndex = Math.max(0, firstVisible - Math.max(0, Math.floor(overscan)));
  const endIndex = Math.min(count, Math.max(visibleEnd, firstVisible + 1) + Math.max(0, Math.floor(overscan)));
  return {
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * height,
    bottomSpacerHeight: (count - endIndex) * height
  };
}

type SessionReviewState = Pick<SessionMetadata, "status" | "turnCompleted">;

/** Tracks only known descendants (and their newly announced children), ignoring PTY/data traffic. */
export class TaskReviewSessionTracker {
  private readonly sessions = new Set<string>();
  private readonly states = new Map<string, SessionReviewState>();
  private readonly rootSessionId: string;

  constructor(rootSessionId: string) {
    this.rootSessionId = rootSessionId;
    this.sessions.add(rootSessionId);
  }

  include(sessionId: string): void {
    this.sessions.add(sessionId);
  }

  seedSubtree(sessions: ReadonlyArray<Pick<SessionMetadata, "id" | "parentSessionId">>): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of sessions) {
        if (session.parentSessionId && this.sessions.has(session.parentSessionId) && !this.sessions.has(session.id)) {
          this.sessions.add(session.id);
          changed = true;
        }
      }
    }
    this.sessions.add(this.rootSessionId);
  }

  observe(session: SessionMetadata): boolean {
    const wasKnown = this.sessions.has(session.id);
    const parentIsKnown = Boolean(session.parentSessionId && this.sessions.has(session.parentSessionId));
    if (!wasKnown && !parentIsKnown) return false;
    this.sessions.add(session.id);

    const previous = this.states.get(session.id);
    const next: SessionReviewState = { status: session.status, turnCompleted: session.turnCompleted };
    if (previous?.status === next.status && previous.turnCompleted === next.turnCompleted) return false;
    this.states.set(session.id, next);

    const isTerminal = next.status === "done" || next.status === "failed";
    const wasTerminal = previous?.status === "done" || previous?.status === "failed";
    return (isTerminal && (previous === undefined || !wasTerminal))
      || (!isTerminal && next.turnCompleted === true && previous?.turnCompleted !== true)
      || (previous !== undefined && next.status === "working"
        && (previous.status !== "working" || previous.turnCompleted === true));
  }
}
