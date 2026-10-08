/** Physical-input smoke prerequisites; kept separate from product input routing. */
export interface BrowserSmokePageState {
  readyState: string;
  visibilityState: string;
  focused: boolean;
  width: number;
  height: number;
  scrollY: number;
  maxScrollY: number;
}

export interface BrowserSmokeWheelReadiness {
  ownerVisible: boolean;
  ownerFocused: boolean;
  page: BrowserSmokePageState;
}

export function isBrowserSmokeWheelReady(state: BrowserSmokeWheelReadiness): boolean {
  return state.ownerVisible && state.ownerFocused
    && state.page.readyState === "complete"
    && state.page.visibilityState === "visible"
    && state.page.focused;
}

/** A freeze release after the wheel idle deadline is expected, even if the renderer reports it late. */
export function freezeEndedBeforeIdle(
  events: readonly { active: boolean; observedAt: number }[],
  sequenceRefreshedAt: number,
  idleMs: number
): boolean {
  return events.some((event) => !event.active
    && event.observedAt >= sequenceRefreshedAt
    && event.observedAt < sequenceRefreshedAt + idleMs);
}

type BrowserSmokeSchedule = (callback: () => void, delayMs: number) => () => void;

const scheduleBrowserSmokeCheck: BrowserSmokeSchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function waitForBrowserSmokeWheelReady(
  readState: () => Promise<BrowserSmokeWheelReadiness>,
  timeoutMs: number,
  schedule: BrowserSmokeSchedule = scheduleBrowserSmokeCheck
): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let cancelCheck = () => {};
    let cancelTimeout = () => {};
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      cancelCheck();
      cancelTimeout();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const check = async () => {
      try {
        const state = await readState();
        if (finished) return;
        if (isBrowserSmokeWheelReady(state)) finish();
        else cancelCheck = schedule(() => { void check(); }, 50);
      } catch (error) {
        finish(error);
      }
    };
    cancelTimeout = schedule(() => finish(new Error(`Physical Browser wheel readiness timed out after ${timeoutMs} ms.`)), timeoutMs);
    void check();
  });
}

export function runBrowserSmokeCleanup(
  operation: () => Promise<unknown>,
  timeoutMs: number,
  schedule: BrowserSmokeSchedule = scheduleBrowserSmokeCheck
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    let cancelTimeout = () => {};
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelTimeout();
      resolve();
    };
    cancelTimeout = schedule(finish, timeoutMs);
    Promise.resolve().then(operation).then(finish, finish);
  });
}

export function requireBrowserSmokeScrollBaseline(
  page: BrowserSmokePageState,
  point: { x: number; y: number },
  expectedScrollY: number
): number {
  if (!Number.isFinite(page.width) || !Number.isFinite(page.height)
    || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.y < 0 || point.x >= page.width || point.y >= page.height) {
    throw new Error(`Physical Browser wheel smoke point is outside the page viewport: ${JSON.stringify({ point, page })}.`);
  }
  if (!Number.isFinite(page.maxScrollY) || !Number.isFinite(page.scrollY)
    || page.maxScrollY < expectedScrollY || page.scrollY !== expectedScrollY) {
    throw new Error(`Physical Browser wheel smoke could not establish scroll baseline ${expectedScrollY}: ${JSON.stringify(page)}.`);
  }
  return page.scrollY;
}
