import { useSyncExternalStore } from "react";
import type { LocaleId, SessionSnapshot } from "../../../../shared/contracts";
import { aggregateTaskChildren, elapsedLabel, taskBudgetLabel } from "./workspaceTaskGraph";
import { backlogText } from "./workspaceBacklogText";
import { subscribeToWorkspaceClock, workspaceClockNow } from "./visibleRefresh";

interface TaskSummaryBarProps {
  parent: SessionSnapshot;
  children: readonly SessionSnapshot[];
  locale: LocaleId;
  onGather(): void;
}

export function TaskSummaryBar({ parent, children, locale, onGather }: TaskSummaryBarProps): React.JSX.Element | null {
  const visible = parent.role === "orchestrator" && (children.length > 0 || Boolean(parent.taskBudget));
  if (!visible) return null;
  return <VisibleTaskSummaryBar parent={parent} children={children} locale={locale} onGather={onGather} />;
}

function VisibleTaskSummaryBar({ parent, children, locale, onGather }: TaskSummaryBarProps): React.JSX.Element {
  const now = useSyncExternalStore(subscribeToWorkspaceClock, workspaceClockNow, workspaceClockNow);
  const summary = aggregateTaskChildren(children);
  const elapsed = elapsedLabel(now - (parent.taskScope?.startedAt ?? parent.startedAt));
  const budgetLabel = parent.taskBudget ? taskBudgetLabel(parent.taskBudget, locale) : null;
  return (
    <div className="terminal-task-summary" data-interactive="true" aria-label={backlogText(locale, "taskSummary")}>
      <span className="terminal-task-summary__counts">
        <span data-state="working">{summary.working} {backlogText(locale, "working")}</span>
        <span data-state="waiting">{summary.waiting} {backlogText(locale, "waiting")}</span>
        <span data-state="done">{summary.done} {backlogText(locale, "done")}</span>
        <span data-state="failed">{summary.failed} {backlogText(locale, "failed")}</span>
      </span>
      <span className="terminal-task-summary__elapsed" title={backlogText(locale, "elapsed")}>{elapsed}</span>
      {budgetLabel && <span role="status" title={budgetLabel.title}>{budgetLabel.text}</span>}
      <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onGather}>{backlogText(locale, "gatherTask")}</button>
    </div>
  );
}
