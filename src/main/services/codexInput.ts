/** The Codex task composer, shared by automated delivery and the native control API. */
export function codexComposerReady(screen: string): boolean {
  if (/Do you trust the contents|Press enter to confirm|Update Model Permissions|model:\s+loading|MCP startup/i.test(screen)) return false;
  return screen.split("\n").some((line) => /^\s*›\s*(?:Ask Codex to do anything)?\s*$/.test(line));
}

/** Explicit paste boundaries keep Codex's paste-burst detector from swallowing the submit key. */
export function codexPromptInput(text: string, submit = true): string {
  return `\x1b[200~${text}\x1b[201~${submit ? "\r" : ""}`;
}
