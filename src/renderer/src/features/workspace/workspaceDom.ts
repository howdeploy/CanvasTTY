export function downloadText(text: string, filename: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function findSessionCard(sessionId: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-session-id]"))
    .find((candidate) => candidate.dataset.sessionId === sessionId) ?? null;
}
