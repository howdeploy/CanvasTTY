import { useMemo } from "react";
import type { UsageHistory } from "../../../../shared/usageHistory.ts";
import { buildUsageReport } from "../../../../shared/usageReport.ts";
import { UsageHistoryView, type UsageHistoryViewProps } from "./UsageHistoryView";

type Props = Omit<UsageHistoryViewProps, "report" | "reportError"> & { history: UsageHistory | null };

/** Report calculation and its view are loaded only when the usage dialog opens. */
export function UsageHistoryReport({ history, ...props }: Props): React.JSX.Element {
  const { now, period, weightBasis } = props;
  const computed = useMemo(() => {
    if (!history) return { report: null, error: null };
    try {
      return { report: buildUsageReport(history, { now, period, weightBasis }), error: null };
    } catch (error) {
      return { report: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [history, now, period, weightBasis]);
  return <UsageHistoryView {...props} report={computed.report} reportError={computed.error} />;
}
