export function findSessionCard(sessionId: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-session-id]"))
    .find((candidate) => candidate.dataset.sessionId === sessionId) ?? null;
}
