import type { SessionSnapshot } from "../../../../shared/contracts";
import type { WorkspaceLayoutItem } from "./workspaceLayout";

export type TaskCardState = "waiting" | "working" | "waiting-response" | "done" | "failed";

export interface TaskAggregate {
  total: number;
  working: number;
  waiting: number;
  done: number;
  failed: number;
}

export function taskCardState(session: Pick<SessionSnapshot, "status" | "turnCompleted">): TaskCardState {
  if (session.status === "working") return "working";
  if (session.status === "needs_approval") return "waiting";
  if (session.status === "failed" || session.status === "unavailable") return "failed";
  if (session.status === "done" || session.turnCompleted === true) return "done";
  return "waiting-response";
}

export function aggregateTaskChildren(children: readonly SessionSnapshot[]): TaskAggregate {
  const aggregate: TaskAggregate = { total: children.length, working: 0, waiting: 0, done: 0, failed: 0 };
  for (const child of children) {
    const state = taskCardState(child);
    if (state === "working") aggregate.working += 1;
    else if (state === "waiting" || state === "waiting-response") aggregate.waiting += 1;
    else if (state === "done") aggregate.done += 1;
    else aggregate.failed += 1;
  }
  return aggregate;
}

export function directTaskEdges(sessions: readonly SessionSnapshot[]): Array<{ parentId: string; childId: string; state: TaskCardState }> {
  const live = new Set(sessions.map((session) => session.id));
  return sessions
    .filter((session) => session.parentSessionId && live.has(session.parentSessionId))
    .map((session) => ({
      parentId: session.parentSessionId!,
      childId: session.id,
      state: taskCardState(session)
    }));
}

export function sessionLayoutItems(sessions: readonly SessionSnapshot[]): WorkspaceLayoutItem[] {
  return sessions.map((session) => ({
    id: session.id,
    bounds: { position: session.position, size: session.size },
    ...(session.parentSessionId ? { parentId: session.parentSessionId } : {}),
    status: session.status,
    project: session.cwd
  }));
}

/**
 * The card's budget status. When the platform cannot suspend running processes (Windows), a pause only blocks input
 * and new launches, and the card says so instead of claiming the task is paused.
 */
export function taskBudgetLabel(budget: NonNullable<SessionSnapshot["taskBudget"]>, locale: string): { text: string; title: string } {
  const ru = locale === "ru";
  if (budget.paused && budget.processesKeepRunning) return ru
    ? { text: "Бюджет: ввод заблокирован", title: "Windows не умеет приостанавливать запущенные процессы: ввод и новые запуски заблокированы, но уже запущенные процессы продолжают работать." }
    : { text: "Budget: input blocked", title: "Windows cannot suspend running processes: input and new launches are blocked, but processes already running keep running." };
  if (budget.paused) return ru
    ? { text: "Бюджет: пауза", title: "Задача и её процессы приостановлены" }
    : { text: "Budget: paused", title: "The task and its processes are suspended" };
  const cost = budget.costUsd === null ? "—" : `$${budget.costUsd.toFixed(2)}`;
  const time = budget.durationMs === null ? "—" : elapsedLabel(budget.durationMs);
  return { text: `${budget.tokens ?? "—"} tokens · ${cost} · ${time}`, title: ru ? "Остаток бюджета задачи" : "Remaining task budget" };
}

export function elapsedLabel(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
