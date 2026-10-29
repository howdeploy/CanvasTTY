/**
 * When a hidden browser tab is paused (frozen) or put to sleep (discarded), and when it is woken again.
 *
 * Hidden tabs already run with Chromium background throttling, but throttling leaves requestAnimationFrame loops and
 * a timer wake-up every second running. A tab that stays hidden and undriven for `freezeAfterMs` is frozen (Chromium
 * stops its timers, rAF and tasks); one that stays so for `discardAfterMs`, or the least recently used ones when more
 * than `maxLiveHiddenTabs` hidden tabs are alive, is discarded (its WebContents is closed; the host keeps what it needs
 * to bring it back). Showing a tab, or any command for it, wakes it first: `ensureLive` resolves only once the tab
 * runs again, so no automation reaches a frozen page.
 *
 * Every transition of one tab runs on that tab's own queue, so a wake that arrives while a freeze or discard is in
 * flight waits for it and then undoes it. The host decides what blocks a transition (playing media, a download, an
 * open dialog, a beforeunload handler, an agent on the tab); a blocked tab is retried later, never forced.
 * This class holds no Electron objects: BrowserService is the host, and tests drive it with fake timers.
 */

export type TabLifecycleState = "active" | "frozen" | "discarded";

export interface TabLifecycleHost {
  /** Why the tab must not be frozen now, or null. */
  freezeBlocker(tabId: string): string | null;
  /** Why the tab must not be discarded now, or null. May consult the page (a beforeunload handler). */
  discardBlocker(tabId: string): Promise<string | null>;
  freeze(tabId: string): Promise<void>;
  resume(tabId: string): Promise<void>;
  /** False when the tab could not be discarded after all (it was shown or driven meanwhile); it then stays as it was. */
  discard(tabId: string): Promise<boolean>;
  restore(tabId: string): Promise<void>;
  stateChanged(tabId: string, state: TabLifecycleState): void;
}

export interface TabLifecycleOptions {
  enabled?: boolean;
  freezeAfterMs?: number;
  discardAfterMs?: number;
  maxLiveHiddenTabs?: number;
  /** How long a blocked or failed freeze or discard waits before it is tried again. */
  retryAfterMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

export const TAB_FREEZE_AFTER_MS = 30_000;
export const TAB_DISCARD_AFTER_MS = 10 * 60_000;
export const MAX_LIVE_HIDDEN_TABS = 6;

interface Entry {
  id: string;
  state: TabLifecycleState;
  visible: boolean;
  busy: boolean;
  /** When the tab was last shown, driven or woken; idle time counts from the later of this and hiding. */
  lastUsedAt: number;
  hiddenSince: number | null;
  freezeNotBefore: number;
  discardNotBefore: number;
  /** A discard for the hidden-tab limit is queued; the tab no longer counts as live. */
  discardQueued: boolean;
  timer: unknown;
  queue: Promise<unknown>;
}

export class BrowserTabLifecycle {
  private readonly host: TabLifecycleHost;
  private readonly entries = new Map<string, Entry>();
  private readonly freezeAfterMs: number;
  private readonly discardAfterMs: number;
  private readonly maxLiveHiddenTabs: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private enabled: boolean;
  private disposed = false;

  constructor(host: TabLifecycleHost, options: TabLifecycleOptions = {}) {
    this.host = host;
    this.enabled = options.enabled ?? true;
    this.freezeAfterMs = options.freezeAfterMs ?? TAB_FREEZE_AFTER_MS;
    this.discardAfterMs = options.discardAfterMs ?? TAB_DISCARD_AFTER_MS;
    this.maxLiveHiddenTabs = options.maxLiveHiddenTabs ?? MAX_LIVE_HIDDEN_TABS;
    this.retryAfterMs = options.retryAfterMs ?? this.freezeAfterMs;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.onError = options.onError ?? ((error) => console.warn("CanvasTTY browser tab lifecycle step failed.", error));
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  state(tabId: string): TabLifecycleState {
    return this.entries.get(tabId)?.state ?? "active";
  }

  /** Starts tracking a tab (a no-op for one already tracked, such as a tab being restored). */
  track(tabId: string, visible: boolean): void {
    if (this.disposed || this.entries.has(tabId)) return;
    const now = this.now();
    const entry: Entry = {
      id: tabId,
      state: "active",
      visible,
      busy: false,
      lastUsedAt: now,
      hiddenSince: visible ? null : now,
      freezeNotBefore: 0,
      discardNotBefore: 0,
      discardQueued: false,
      timer: null,
      queue: Promise.resolve()
    };
    this.entries.set(tabId, entry);
    this.schedule(entry);
  }

  untrack(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    this.cancelTimer(entry);
    this.entries.delete(tabId);
  }

  setVisible(tabId: string, visible: boolean): void {
    const entry = this.entries.get(tabId);
    if (!entry || entry.visible === visible) return;
    entry.visible = visible;
    if (visible) {
      entry.hiddenSince = null;
      this.touch(entry);
      if (entry.state !== "active") void this.ensureLive(tabId).catch(this.onError);
      return;
    }
    entry.hiddenSince = this.now();
    this.resetRetries(entry);
    this.schedule(entry);
  }

  /** Automation started or stopped driving the tab (BrowserAutomationService's busy window). */
  setBusy(tabId: string, busy: boolean): void {
    const entry = this.entries.get(tabId);
    if (!entry || entry.busy === busy) return;
    entry.busy = busy;
    this.touch(entry);
    if (!busy) this.schedule(entry);
  }

  /**
   * Resolves once the tab runs: a frozen tab is resumed, a discarded one restored (`reloaded`). Waits for any
   * transition of the tab already in flight, so a wake never overtakes the freeze or discard it has to undo.
   */
  ensureLive(tabId: string): Promise<{ reloaded: boolean }> {
    const entry = this.entries.get(tabId);
    if (!entry) return Promise.resolve({ reloaded: false });
    this.touch(entry);
    const result = this.enqueue(entry, async () => {
      if (this.entries.get(tabId) !== entry) return { reloaded: false };
      if (entry.state === "frozen") {
        try {
          await this.host.resume(tabId);
        } finally {
          // A resume that failed (the automation channel went away) must not leave the tab marked paused forever.
          this.setState(entry, "active");
        }
        return { reloaded: false };
      }
      if (entry.state === "discarded") {
        await this.host.restore(tabId);
        this.setState(entry, "active");
        return { reloaded: true };
      }
      return { reloaded: false };
    });
    return result.finally(() => this.schedule(entry));
  }

  /** Off: nothing new is paused and paused tabs resume; sleeping tabs wake when they are next shown or used. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const entry of this.entries.values()) {
      this.resetRetries(entry);
      if (!enabled) {
        this.cancelTimer(entry);
        // The queued wake must also follow a freeze that has not finished yet.
        if (entry.state === "frozen" || entry.state === "active") void this.ensureLive(entry.id).catch(this.onError);
      } else {
        // Idle time counts from now: turning the setting on must not put long-hidden tabs to sleep at once.
        entry.lastUsedAt = this.now();
        this.schedule(entry);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) this.cancelTimer(entry);
    this.entries.clear();
  }

  private touch(entry: Entry): void {
    entry.lastUsedAt = this.now();
    this.resetRetries(entry);
    this.cancelTimer(entry);
  }

  private resetRetries(entry: Entry): void {
    entry.freezeNotBefore = 0;
    entry.discardNotBefore = 0;
  }

  private deferRetries(entry: Entry): void {
    const retryAt = this.now() + this.retryAfterMs;
    // Either deadline can already be due, including one that expired while the failed transition was in flight.
    entry.freezeNotBefore = Math.max(entry.freezeNotBefore, retryAt);
    entry.discardNotBefore = Math.max(entry.discardNotBefore, retryAt);
  }

  private idle(entry: Entry): boolean {
    return this.enabled && !this.disposed && !entry.visible && !entry.busy && this.entries.get(entry.id) === entry;
  }

  private idleSince(entry: Entry): number {
    return Math.max(entry.hiddenSince ?? entry.lastUsedAt, entry.lastUsedAt);
  }

  private freezeAt(entry: Entry): number {
    return Math.max(this.idleSince(entry) + this.freezeAfterMs, entry.freezeNotBefore);
  }

  private discardAt(entry: Entry): number {
    return Math.max(this.idleSince(entry) + this.discardAfterMs, entry.discardNotBefore);
  }

  private schedule(entry: Entry): void {
    this.cancelTimer(entry);
    if (!this.idle(entry) || entry.state === "discarded") return;
    const due = entry.state === "active"
      ? Math.min(this.freezeAt(entry), this.discardAt(entry))
      : this.discardAt(entry);
    entry.timer = this.setTimer(() => {
      entry.timer = null;
      void this.enqueue(entry, () => this.step(entry)).catch(this.onError);
    }, Math.max(0, due - this.now()));
  }

  private cancelTimer(entry: Entry): void {
    if (entry.timer === null) return;
    this.clearTimer(entry.timer);
    entry.timer = null;
  }

  private async step(entry: Entry): Promise<void> {
    try {
      if (!this.idle(entry)) return;
      const now = this.now();
      if (entry.state === "active" && now >= this.freezeAt(entry)) {
        const blocker = this.host.freezeBlocker(entry.id);
        if (blocker) entry.freezeNotBefore = now + this.retryAfterMs;
        else {
          await this.host.freeze(entry.id);
          if (this.entries.get(entry.id) === entry) this.setState(entry, "frozen");
        }
      }
      if (entry.state !== "discarded" && this.idle(entry) && this.now() >= this.discardAt(entry)) {
        await this.tryDiscard(entry);
      }
      this.enforceHiddenLimit();
    } catch (error) {
      this.deferRetries(entry);
      throw error;
    } finally {
      this.schedule(entry);
    }
  }

  private async tryDiscard(entry: Entry): Promise<void> {
    if (!this.idle(entry) || entry.state === "discarded") return;
    const blocker = await this.host.discardBlocker(entry.id);
    // Shown, driven or untracked while the page was asked: leave it.
    if (!this.idle(entry) || this.state(entry.id) === "discarded") return;
    if (blocker) {
      entry.discardNotBefore = this.now() + this.retryAfterMs;
      return;
    }
    const discarded = await this.host.discard(entry.id);
    if (discarded && this.entries.get(entry.id) === entry) this.setState(entry, "discarded");
  }

  /** More than maxLiveHiddenTabs hidden tabs alive: discard the least recently used that have been idle a while. */
  private enforceHiddenLimit(): void {
    const live = [...this.entries.values()].filter((entry) => (
      !entry.visible && entry.state !== "discarded" && !entry.discardQueued
    ));
    let excess = live.length - this.maxLiveHiddenTabs;
    if (excess <= 0) return;
    const now = this.now();
    const candidates = live
      .filter((entry) => this.idle(entry) && now - this.idleSince(entry) >= this.freezeAfterMs && now >= entry.discardNotBefore)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const entry of candidates) {
      if (excess <= 0) break;
      excess -= 1;
      entry.discardQueued = true;
      void this.enqueue(entry, async () => {
        try {
          await this.tryDiscard(entry);
        } catch (error) {
          this.deferRetries(entry);
          throw error;
        } finally {
          entry.discardQueued = false;
          this.schedule(entry);
        }
      }).catch(this.onError);
    }
  }

  private setState(entry: Entry, state: TabLifecycleState): void {
    if (entry.state === state) return;
    entry.state = state;
    this.host.stateChanged(entry.id, state);
  }

  private enqueue<T>(entry: Entry, task: () => Promise<T>): Promise<T> {
    const run = entry.queue.then(task, task);
    entry.queue = run.catch(() => undefined);
    return run;
  }
}
