import type { AppSettings, CanvasOverlayPlacement, SessionSnapshot } from "../../../../shared/contracts";

/**
 * The ATTENTION QUEUE — sessions whose own snapshot status asks the user for a
 * decision or reports a failure, in snapshot order. Terminal payloads never
 * promote a session: the status field is the only source of truth. The order is
 * the order the sessions were created in and is never re-sorted, so a row keeps
 * its place while the user reads the list.
 */
export function attentionSessions(sessions: readonly SessionSnapshot[]): SessionSnapshot[] {
  return sessions.filter((session) => session.status === "needs_approval" || session.status === "failed");
}

/**
 * Whether the attention panel is rendered in the given overlay corner. Only the
 * panel's own visibility setting and placement matter: OS notifications
 * (`attentionNotifications`) are a separate channel and never hide the HUD.
 */
export function attentionQueueRenderedAt(
  settings: Pick<AppSettings, "attentionQueueVisible" | "attentionQueuePlacement">,
  placement: CanvasOverlayPlacement
): boolean {
  return settings.attentionQueueVisible && settings.attentionQueuePlacement === placement;
}
