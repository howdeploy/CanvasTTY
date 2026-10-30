export interface NativeScrollPhase {
  phase: number;
  momentumPhase: number;
  x: number;
  y: number;
}
export interface BrowserHistoryGestureSnapshot {
  id: number;
  phase: "active" | "ended" | "cancelled";
  claimed: boolean;
}

// AppKit NSEventPhase values; momentum has an independent phase stream.
const BEGAN = 1;
const ENDED = 8;
const CANCELLED = 16;
const MAY_BEGIN = 32;

export class BrowserHistoryGesture {
  private nextId = 0;
  private session: (BrowserHistoryGestureSnapshot & { tabId: string; consumed: boolean }) | null = null;

  observe(input: NativeScrollPhase, tabId: string | null): { tabId: string; gesture: BrowserHistoryGestureSnapshot } | null {
    const previous = this.session?.phase;
    const previousId = this.session?.id;
    if (input.phase & MAY_BEGIN) return null;
    if (input.phase & BEGAN) {
      this.session = tabId ? { id: ++this.nextId, tabId, phase: "active", claimed: false, consumed: false } : null;
    } else if (this.session && (input.phase & CANCELLED)) {
      this.session.phase = "cancelled";
    } else if (this.session && ((input.phase & ENDED) || input.momentumPhase !== 0)) {
      this.session.phase = this.session.phase === "cancelled" ? "cancelled" : "ended";
    } else if (input.phase === 0 && input.momentumPhase === 0) {
      this.session = null;
    } else return null;
    if (!this.session || (previousId === this.session.id && previous === this.session.phase)) return null;
    return { tabId: this.session.tabId, gesture: this.snapshot(this.session.tabId)! };
  }

  snapshot(tabId: string): BrowserHistoryGestureSnapshot | null {
    const session = this.session;
    return session?.tabId === tabId ? { id: session.id, phase: session.phase, claimed: session.claimed } : null;
  }

  claim(tabId: string, input: unknown): void {
    if (!input || typeof input !== "object") return;
    const value = input as Record<string, unknown>;
    if (this.session?.tabId === tabId && value.nativeGestureId === this.session.id && value.historySwipeClaimed === true) {
      this.session.claimed = true;
    }
  }

  canNavigate(tabId: string, id: unknown): boolean {
    return this.session?.tabId === tabId && this.session.id === id
      && this.session.phase === "ended" && this.session.claimed && !this.session.consumed;
  }

  consume(): void { if (this.session) this.session.consumed = true; }
  clear(): void { this.session = null; }
}
