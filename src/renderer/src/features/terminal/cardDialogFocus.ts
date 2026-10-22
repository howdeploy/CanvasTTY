/** Focus goes back to the card whose options menu opened a dialog (the menu itself is closed by then). */
export function focusCardOptions(sessionId: string): void {
  window.requestAnimationFrame(() => {
    const card = [...document.querySelectorAll<HTMLElement>("[data-session-id]")].find((element) => element.dataset.sessionId === sessionId);
    card?.querySelector<HTMLButtonElement>(".terminal-card__action--options")?.focus({ preventScroll: true });
  });
}

