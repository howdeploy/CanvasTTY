import type { UsageHistory } from "../../../../shared/usageHistory.ts";

export interface UsageHistoryApi {
  get(): Promise<UsageHistory>;
}

/** The preload bridge is missing (for example, an older main process). */
export class UsageHistoryUnavailableError extends Error {
  constructor() {
    super("window.canvasTTY.usageHistory.get is not available");
    this.name = "UsageHistoryUnavailableError";
  }
}

/** Looks the bridge up structurally so the renderer works before and after the contract lands. */
export function resolveUsageHistoryApi(bridge: unknown): UsageHistoryApi | null {
  if (typeof bridge !== "object" || bridge === null) return null;
  const api = (bridge as { usageHistory?: unknown }).usageHistory;
  if (typeof api !== "object" || api === null) return null;
  const get = (api as { get?: unknown }).get;
  return typeof get === "function" ? { get: () => Promise.resolve(get.call(api)) as Promise<UsageHistory> } : null;
}

export async function loadUsageHistory(api: UsageHistoryApi | null): Promise<UsageHistory> {
  if (!api) throw new UsageHistoryUnavailableError();
  const { parseUsageHistory } = await import("../../../../shared/usageReport.ts");
  const parsed = parseUsageHistory(await api.get());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.history;
}
