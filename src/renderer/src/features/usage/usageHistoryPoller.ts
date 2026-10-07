export const USAGE_HISTORY_REFRESH_MS = 60_000;

export interface UsageHistoryPollerOptions<T> {
  load(): Promise<T>;
  onLoading(loading: boolean): void;
  onResult(value: T, at: number): void;
  onError(error: unknown, at: number): void;
  intervalMs?: number;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface UsageHistoryPoller {
  /** Loads now unless a request is already running, then restarts the interval. */
  refresh(): void;
  stop(): void;
}

/** One request at a time; a failure never stops the schedule; nothing is delivered after stop. */
export function startUsageHistoryPoller<T>(options: UsageHistoryPollerOptions<T>): UsageHistoryPoller {
  const intervalMs = options.intervalMs ?? USAGE_HISTORY_REFRESH_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let stopped = false;
  let running = false;
  let timer: unknown = null;

  const schedule = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = stopped ? null : setTimer(() => {
      timer = null;
      refresh();
    }, intervalMs);
  };

  const refresh = (): void => {
    if (stopped || running) return;
    running = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    options.onLoading(true);
    let request: Promise<T>;
    try {
      request = options.load();
    } catch (error) {
      request = Promise.reject(error);
    }
    void request.then(
      (value) => { if (!stopped) options.onResult(value, now()); },
      (error: unknown) => { if (!stopped) options.onError(error, now()); }
    ).finally(() => {
      running = false;
      if (stopped) return;
      options.onLoading(false);
      schedule();
    });
  };

  refresh();
  return {
    refresh,
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
  };
}
