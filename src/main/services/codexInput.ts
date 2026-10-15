// Exact built-in placeholders; matching prefixes would also accept human drafts.
const EMPTY_COMPOSER_PLACEHOLDERS = new Set([
  "", "Ask Codex to do anything", "Ask a follow-up question",
  "Find and fix a bug in @filename", "Implement {feature}", "Summarize recent commits",
  "Explain this codebase", "Write tests for @filename", "Improve documentation in @filename",
  "Use /skills to list available skills", "Run /review on my current changes",
]);

/** The Codex task composer, shared by automated delivery and the native control API. */
export function codexComposerReady(screen: string): boolean {
  if (/Do you trust the contents|Press enter to confirm|Update Model Permissions|model:\s+loading|MCP startup/i.test(screen)) return false;
  return screen.split("\n").some((line) => {
    const prompt = line.match(/^\s*›\s*(.*?)\s*$/);
    return prompt !== null && EMPTY_COMPOSER_PLACEHOLDERS.has(prompt[1]);
  });
}

/** Explicit paste boundaries keep Codex's paste-burst detector from swallowing the submit key. */
export function codexPromptInput(text: string, submit = true): string {
  return `\x1b[200~${text}\x1b[201~${submit ? "\r" : ""}`;
}
