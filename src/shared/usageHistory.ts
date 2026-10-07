export interface UsageEvent {
  id: string;
  provider: string;
  app: string;
  profile: string;
  session: string;
  from: number;
  to: number;
  input: number;
  output: number;
  cached: number;
  timing: 'event' | 'poll-delta';
}
export interface HistorySample {
  provider: string;
  scope: string | null;
  windowId: string;
  at: number;
  reset: number | null;
  percent: number;
}
/**
 * Optional per-run record of local log collection. `complete` means every discovered log
 * was read to its end and no source failed in that run. `lost` means the run consumed
 * accounting records it could not use (unparsable or oversized lines, counters baselined
 * without history), which no later run recovers.
 */
export interface UsageCollectionHealth {
  at: number;
  complete: boolean;
  lost?: true;
}
export interface UsageHistory {
  version: 1;
  startedAt: number;
  collectedAt: number;
  samples: HistorySample[];
  events: UsageEvent[];
  coverage: string[];
  providerStatus: string[];
  error: string | null;
  /** Per-run collection health; absent health never authorizes attribution. */
  health?: UsageCollectionHealth[];
}
