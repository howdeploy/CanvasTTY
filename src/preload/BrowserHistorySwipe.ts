export type HistoryDirection = "back" | "forward";
export interface HistorySwipeInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  scrollable: boolean;
}
const SWIPE_THRESHOLD = 160;

export class BrowserHistorySwipe {
  private direction: HistoryDirection | null = null;
  private distance = 0;
  private blocked = false;
  private finished = false;

  update(input: HistorySwipeInput): { direction: HistoryDirection; progress: number } | null {
    if (this.blocked || this.finished) return null;
    if (input.deltaX === 0 && input.deltaY === 0) return null;
    if (input.deltaMode !== 0 || input.ctrlKey || input.metaKey || input.altKey || input.shiftKey
      || !Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY)) {
      this.blocked = true;
      return null;
    }
    if (!this.direction) {
      const direction = input.deltaX < 0 ? "back" : "forward";
      if (Math.abs(input.deltaX) < Math.abs(input.deltaY) * 1.5 || input.deltaX === 0
        || input.scrollable || !(direction === "back" ? input.canGoBack : input.canGoForward)) {
        this.blocked = true;
        return null;
      }
      this.direction = direction;
    }
    this.distance = Math.max(0, this.distance + input.deltaX * (this.direction === "back" ? -1 : 1));
    return { direction: this.direction, progress: Math.min(1, this.distance / SWIPE_THRESHOLD) };
  }

  get claimed(): boolean { return this.direction !== null && !this.blocked; }

  finish(): HistoryDirection | null {
    if (this.finished) return null;
    this.finished = true;
    return !this.blocked && this.distance >= SWIPE_THRESHOLD ? this.direction : null;
  }

  reset(): void {
    this.direction = null;
    this.distance = 0;
    this.blocked = false;
    this.finished = false;
  }
}
