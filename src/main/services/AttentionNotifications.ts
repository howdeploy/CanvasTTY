import type { SessionStatus } from "../../shared/contracts.ts";

type AttentionStatus = Extract<SessionStatus, "needs_approval" | "failed">;

export class AttentionNotifications {
  private readonly statuses = new Map<string, SessionStatus>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly notify: (id: string, status: AttentionStatus) => void;
  private readonly enabled: () => boolean;

  constructor(notify: (id: string, status: AttentionStatus) => void, enabled: () => boolean) {
    this.notify = notify;
    this.enabled = enabled;
  }

  status(id: string): SessionStatus | undefined {
    return this.statuses.get(id);
  }

  observe(id: string, status: SessionStatus, failureOrigin: "restore" | "user" | null = null): void {
    const previous = this.statuses.get(id);
    if (previous === status && !(status === "failed" && failureOrigin === "user")) return;
    this.cancel(id);
    this.statuses.set(id, status);
    if (status !== "needs_approval" && status !== "failed") return;
    if (status === "failed" && failureOrigin === "restore") return;
    if (!this.enabled()) return;
    if (status === "failed") {
      this.notify(id, status);
    } else if (status === "needs_approval") {
      // Brief approval states can be resolved by the agent before a person has anything to answer.
      const timer = setTimeout(() => {
        if (this.pending.get(id) !== timer) return;
        this.pending.delete(id);
        if (this.statuses.get(id) === "needs_approval" && this.enabled()) this.notify(id, "needs_approval");
      }, 1_000);
      timer.unref?.();
      this.pending.set(id, timer);
    }
  }

  forget(id: string): void {
    this.cancel(id);
    this.statuses.delete(id);
  }

  dispose(): void {
    for (const id of this.pending.keys()) this.cancel(id);
    this.statuses.clear();
  }

  private cancel(id: string): void {
    const timer = this.pending.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.pending.delete(id);
  }
}
