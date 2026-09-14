import type { SessionSnapshot } from "../../../../shared/contracts";

/**
 * The ATTENTION QUEUE — sessions whose own snapshot status asks the user for a
 * decision or reports a failure, in snapshot order. Terminal payloads never
 * promote a session: the status field is the only source of truth.
 */
export function attentionSessions(sessions: readonly SessionSnapshot[]): SessionSnapshot[] {
  return sessions.filter((session) => session.status === "needs_approval" || session.status === "failed");
}
