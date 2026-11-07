/**
 * WebGL renderer slots for terminal cards.
 *
 * A card drawn by xterm's DOM renderer costs the renderer process style, layout and paint for every row
 * it changes; the WebGL renderer draws the same grid from a glyph atlas on the GPU. Every WebGL card
 * holds its own WebGL2 context, and Chromium keeps at most 16 of them alive per renderer process: past
 * that it silently loses the oldest one. So contexts are a bounded pool. Cards on screen ask for one; the
 * pool hands them out by priority (the focused card, then by on-screen area, then by most recent use) and
 * every card without one keeps the DOM renderer, exactly as before.
 *
 * Changes that come from moving the camera settle before the pool acts, and so does every other re-plan
 * (output on a waiting card, a pin running out, a backoff ending): none moves a context until the settle
 * time has passed since the last camera or layout change. A card that holds a context keeps it unless
 * another card is clearly larger on screen, so a pan or a wheel zoom does not create and drop contexts on
 * every frame. A holder that has been idle for a while loses that edge: a card of the same size that is
 * printing output takes its place. Clients that can park a renderer switch to DOM immediately when
 * ineligible; their warm contexts occupy spare slots only and yield to any eligible on-screen card.
 *
 * The pool knows nothing about xterm or the DOM: a card registers a client that measures its on-screen
 * rectangle and attaches or detaches the renderer. That keeps the policy testable in node.
 */

/**
 * Contexts the pool hands out. Chromium's limit is 16 active WebGL contexts per renderer process
 * (WebGLRenderingContextBase's active-context cap; the next one evicts the oldest with a console warning).
 * Ten leaves six for everything else in this renderer: plugin canvas apps drawing with WebGL, and released
 * card contexts that are lost but not yet collected. At device pixel ratio 2 a context with its glyph atlas
 * costs roughly 20 MB of GPU memory, so ten cards stay near 200 MB.
 */
export const WEBGL_CONTEXT_BUDGET = 10;
/** Quiet time after the last camera, layout or focus change before contexts move between cards. */
export const WEBGL_SETTLE_MS = 200;
/** A card holding a context keeps it against a card less than this much larger on screen. */
export const WEBGL_AREA_HYSTERESIS = 1.25;
/** A holder with no output, input or focus for this long no longer wins ties against a busier card. */
export const WEBGL_IDLE_MS = 10_000;
/** Output reaching a card without a context re-plans at most this often, and only if a slot could move. */
export const WEBGL_ACTIVITY_REPLAN_MS = 1_000;
/** A card that just got a context keeps it this long against a better-ranked card (not against leaving). */
export const WEBGL_MIN_HOLD_MS = 1_000;
/** After a context loss (or a failed attach) the card stays on the DOM renderer this long; repeats double it. */
export const WEBGL_LOSS_BACKOFF_MS = 30_000;
const WEBGL_LOSS_BACKOFF_MAX_MS = 10 * 60_000;

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WebglPoolClient {
  /** The card's rectangle in viewport pixels, or null when it is not rendered (display or visibility off). */
  measure(): ScreenRect | null;
  /** Load the WebGL renderer. False when WebGL2 is unavailable; the card stays on the DOM renderer. */
  attach(): boolean;
  /** Drop the WebGL renderer; xterm draws with the DOM renderer again. Terminal state is untouched. */
  detach(visible: boolean): void;
  /** Switch drawing without destroying a leased context; parked contexts still count against the budget. */
  setActive?(active: boolean): void;
}

export interface WebglPoolOptions {
  budget?: number;
  settleMs?: number;
  minHoldMs?: number;
  lossBackoffMs?: number;
  now(): number;
  viewport(): { width: number; height: number };
  schedule(callback: () => void, ms: number): () => void;
}

interface Entry {
  client: WebglPoolClient;
  eligible: boolean;
  focused: boolean;
  lastUsed: number;
  holding: boolean;
  active: boolean;
  grantedAt: number;
  blockedUntil: number;
  losses: number;
  /** On-screen area at the last plan; 0 = off screen, ineligible or backing off. */
  area: number;
}

export interface WebglCandidate {
  id: string;
  area: number;
  focused: boolean;
  holding: boolean;
  /** No output, input or focus for WEBGL_IDLE_MS: a holder in this state gets no tie advantage. */
  idle: boolean;
  /** Holding, and granted within the minimum hold time: kept against better-ranked cards. */
  pinned: boolean;
  lastUsed: number;
}

/** Visible area of a rectangle inside the viewport, in square pixels. */
export function visibleArea(rect: ScreenRect | null, viewport: { width: number; height: number }): number {
  if (!rect) return 0;
  const width = Math.min(rect.right, viewport.width) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The cards that should hold a context, best first. Only cards with on-screen area compete. Order: the
 * focused card; then pinned holders; then on-screen area, where a busy holder's area counts
 * WEBGL_AREA_HYSTERESIS times (so equal busy cards never trade places); then the most recently used.
 */
export function rankWebglCandidates(candidates: readonly WebglCandidate[], budget: number): string[] {
  const score = (candidate: WebglCandidate): number =>
    candidate.area * (candidate.holding && !candidate.idle ? WEBGL_AREA_HYSTERESIS : 1);
  return candidates
    .filter((candidate) => candidate.area > 0)
    .sort((a, b) =>
      Number(b.focused) - Number(a.focused)
      || Number(b.pinned) - Number(a.pinned)
      || score(b) - score(a)
      || b.lastUsed - a.lastUsed
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, budget))
    .map((candidate) => candidate.id);
}

export class WebglContextPool {
  private readonly entries = new Map<string, Entry>();
  private readonly options: WebglPoolOptions;
  private readonly budget: number;
  private cancelSettle: (() => void) | null = null;
  private activityPlanPending = false;
  /** When viewportChanged() last ran; no context moves until the settle time has passed since then. */
  private lastViewportChange = Number.NEGATIVE_INFINITY;

  constructor(options: WebglPoolOptions) {
    this.options = options;
    this.budget = options.budget ?? WEBGL_CONTEXT_BUDGET;
  }

  /** Register a card; it starts on the DOM renderer. Returns the unregister function. */
  register(id: string, client: WebglPoolClient): () => void {
    this.remove(id);
    this.entries.set(id, {
      client, eligible: false, focused: false, lastUsed: this.options.now(), holding: false, active: false,
      grantedAt: 0, blockedUntil: 0, losses: 0, area: 0
    });
    this.settle();
    return () => {
      if (this.entries.get(id)?.client === client) this.remove(id);
    };
  }

  /**
   * Losing eligibility switches to DOM now, so a zoomed-in WebGL raster is never upscaled.
   * A warm context can stay leased while there is room; activation waits for the camera to settle.
   */
  update(id: string, state: { eligible: boolean; focused: boolean }): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const changed = entry.eligible !== state.eligible || entry.focused !== state.focused;
    entry.eligible = state.eligible;
    entry.focused = state.focused;
    if (state.focused) entry.lastUsed = this.options.now();
    if (!state.eligible && entry.holding) {
      if (entry.client.setActive) {
        this.setActive(entry, false);
        entry.area = 0;
      } else {
        entry.area = visibleArea(entry.client.measure(), this.options.viewport());
        this.release(entry);
      }
    }
    if (changed) this.settle();
  }

  /**
   * Output reached the card: it counts as recently used. Called for every write, so it is O(1) and only
   * schedules a plan when an on-screen card without a context could get one (a free slot, or an idle holder).
   */
  touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const now = this.options.now();
    entry.lastUsed = now;
    if (entry.holding || entry.area === 0 || this.activityPlanPending || !this.slotCouldMove(now)) return;
    this.activityPlanPending = true;
    this.options.schedule(() => {
      this.activityPlanPending = false;
      this.planWhenSettled();
    }, WEBGL_ACTIVITY_REPLAN_MS);
  }

  /** The camera, the window or a card's bounds changed. Acts once things are still. */
  viewportChanged(): void {
    this.lastViewportChange = this.options.now();
    this.settle();
  }

  /**
   * The card's context was lost and the card already dropped the renderer. It stays on the DOM renderer
   * for a backoff that doubles with every further loss, and its slot goes to the next card.
   */
  contextLost(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.holding = false;
    entry.active = false;
    this.backOff(entry);
    this.settle();
  }

  /** Ids holding a context, for diagnostics and tests. */
  holders(): string[] {
    return [...this.entries].filter(([, entry]) => entry.holding).map(([id]) => id);
  }

  /**
   * Recompute now. Normally reached through the settle timer. While the camera is still settling the
   * pending settle timer is kept, so the plan for where the camera comes to rest still runs.
   */
  plan(): void {
    const now = this.options.now();
    if (this.settleRemaining(now) <= 0) {
      this.cancelSettle?.();
      this.cancelSettle = null;
    }
    const viewport = this.options.viewport();
    const candidates: WebglCandidate[] = [];
    for (const [id, entry] of this.entries) {
      const allowed = entry.eligible && entry.blockedUntil <= now;
      const area = allowed ? visibleArea(entry.client.measure(), viewport) : 0;
      entry.area = area;
      const pinned = entry.holding && now - entry.grantedAt < (this.options.minHoldMs ?? WEBGL_MIN_HOLD_MS);
      const idle = !entry.focused && now - entry.lastUsed >= WEBGL_IDLE_MS;
      candidates.push({ id, area, focused: entry.focused, holding: entry.holding, idle, pinned, lastUsed: entry.lastUsed });
    }
    const wanted = new Set(rankWebglCandidates(candidates, this.budget));
    // Spare slots keep parked contexts warm. They never displace an on-screen candidate.
    const retained = new Set([...this.entries]
      .filter(([id, entry]) => !wanted.has(id) && entry.holding && entry.client.setActive)
      .sort(([, a], [, b]) => b.lastUsed - a.lastUsed)
      .slice(0, Math.max(0, this.budget - wanted.size))
      .map(([id]) => id));
    // Measure every card before detach/attach changes DOM and fits terminal grids.
    // Release before attaching, so the live context count never goes over the budget.
    for (const [id, entry] of this.entries) {
      if (retained.has(id)) this.setActive(entry, false);
      else if (!wanted.has(id)) this.release(entry);
    }
    for (const id of wanted) {
      const entry = this.entries.get(id)!;
      if (entry.holding) {
        if (!entry.active) {
          this.setActive(entry, true);
          entry.grantedAt = now;
        }
        continue;
      }
      if (!entry.client.attach()) {
        // No WebGL2 context for this card (blocklisted GPU, acceleration off, GPU process in trouble):
        // it stays on the DOM renderer and backs off like a lost context.
        this.backOff(entry);
        continue;
      }
      entry.holding = true;
      entry.active = true;
      entry.grantedAt = now;
    }
    // A pinned holder kept a better-ranked card waiting: look again when the pin runs out.
    const waiting = candidates.some((candidate) => candidate.area > 0 && !wanted.has(candidate.id));
    const pinnedUntil = Math.max(...[...this.entries.values()]
      .filter((entry) => entry.holding && now - entry.grantedAt < (this.options.minHoldMs ?? WEBGL_MIN_HOLD_MS))
      .map((entry) => entry.grantedAt + (this.options.minHoldMs ?? WEBGL_MIN_HOLD_MS)), 0);
    if (waiting && pinnedUntil > now) this.settle(pinnedUntil - now);
  }

  private slotCouldMove(now: number): boolean {
    let holders = 0;
    for (const entry of this.entries.values()) {
      if (!entry.holding) continue;
      holders += 1;
      if (!entry.active) return true;
      if (!entry.focused && now - entry.lastUsed >= WEBGL_IDLE_MS) return true;
    }
    return holders < this.budget;
  }

  private backOff(entry: Entry): void {
    entry.losses += 1;
    const backoff = Math.min(WEBGL_LOSS_BACKOFF_MAX_MS, (this.options.lossBackoffMs ?? WEBGL_LOSS_BACKOFF_MS) * 2 ** (entry.losses - 1));
    entry.blockedUntil = this.options.now() + backoff;
    // Look again once the backoff is over; the card competes like any other then.
    this.options.schedule(() => this.settle(), backoff);
  }

  private settle(ms = this.options.settleMs ?? WEBGL_SETTLE_MS): void {
    this.cancelSettle?.();
    this.cancelSettle = this.options.schedule(() => {
      this.cancelSettle = null;
      this.planWhenSettled();
    }, ms);
  }

  /** Time left until the settle time has passed since the last camera or layout change. */
  private settleRemaining(now: number): number {
    return this.lastViewportChange + (this.options.settleMs ?? WEBGL_SETTLE_MS) - now;
  }

  /** Every timer re-plans through here: while the camera is still moving it waits for the quiet interval. */
  private planWhenSettled(): void {
    const remaining = this.settleRemaining(this.options.now());
    if (remaining > 0) this.settle(remaining);
    else this.plan();
  }

  private release(entry: Entry): void {
    if (!entry.holding) return;
    entry.holding = false;
    entry.active = false;
    entry.client.detach(entry.area > 0);
  }

  private setActive(entry: Entry, active: boolean): void {
    if (entry.active === active) return;
    entry.client.setActive?.(active);
    entry.active = active;
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.release(entry);
    this.entries.delete(id);
    // Its slot may go to a waiting card.
    this.settle();
  }
}

let shared: WebglContextPool | null = null;

/** The renderer's one pool, bound to the window. */
export function webglContextPool(): WebglContextPool {
  if (shared) return shared;
  const pool = new WebglContextPool({
    now: () => performance.now(),
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    schedule: (callback, ms) => {
      const timer = window.setTimeout(callback, ms);
      return () => window.clearTimeout(timer);
    }
  });
  window.addEventListener("resize", () => pool.viewportChanged());
  shared = pool;
  return pool;
}
