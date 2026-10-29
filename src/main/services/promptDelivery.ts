import type { Terminal } from "@xterm/headless";

export interface PromptDeliveryReceipt {
  stage: "not-written" | "pasted" | "submitted";
  acceptance: "unconfirmed" | "confirmed";
  evidence?: "hook" | "program-status" | "title";
  reason?: string;
}

/** Read the active input region, never a copy of the task in the transcript. */
export function promptComposer(terminal: Terminal, provider: string, throughCursor = false): { text: string; typed: string } | null {
  const buffer = terminal.buffer.active;
  const pattern = provider === "claude" ? /^(\s*)❯\s?/u
    : provider === "kimi" ? /^(\s*)│\s*>\s?/u : /^(\s*)›\s?/u;
  let row = -1, column = 0, indent = Infinity;
  for (let at = 0; at < terminal.rows; at++) {
    const line = buffer.getLine(buffer.baseY + at);
    const match = !line?.isWrapped && line?.translateToString(true).match(pattern);
    if (match && match[1]!.length <= indent) {
      row = at; column = match[0].length; indent = match[1]!.length;
    }
  }
  if (row < 0) return null;
  let text = "", typed = "", end = row;
  for (let at = row; at < terminal.rows && (!throughCursor || at <= buffer.cursorY); at++) {
    const line = buffer.getLine(buffer.baseY + at);
    const value = line?.translateToString(true) ?? "";
    if (at > row && /^\s*[─━═╰╯└┘]{3,}/u.test(value)) break;
    end = at;
    const from = at === row ? column : provider === "kimi" ? value.indexOf("│") + 1 : 0;
    const to = provider === "kimi" ? value.lastIndexOf("│") : line?.length ?? 0;
    for (let col = from; col < to; col++) {
      const cell = line?.getCell(col);
      const chars = cell?.getChars() ?? "";
      text += chars;
      if (!cell?.isDim()) typed += chars;
    }
    text += "\n"; typed += "\n";
  }
  return buffer.cursorY >= row && buffer.cursorY <= end ? { text: text.trim(), typed: typed.trim() } : null;
}

export function claudeTerminalComposerReady(terminal: Terminal): boolean {
  const composer = promptComposer(terminal, "claude");
  return composer?.typed === "" && !/\[(?:Pasted text #\d+|Pasted Content|Image #\d+)/u.test(composer.text);
}

/** Repeated text needs a new occurrence; an old collapsed paste is not an acknowledgement. */
export function promptPasteObserved(before: string, after: string, text: string): boolean {
  const compact = (value: string): string => value.replace(/\s/gu, "");
  const tail = compact(text).slice(-64);
  const occurrences = (value: string): number => tail ? compact(value).split(tail).length - 1 : 0;
  if (tail && occurrences(after) > occurrences(before)) return true;
  const markers = (value: string): string[] => value.match(/\[Pasted (?:text #\d+[^\]]*|Content[^\]]*)\]/gu) ?? [];
  const previous = markers(before);
  return markers(after).some((marker, index, all) =>
    all.filter((value) => value === marker).length > previous.filter((value) => value === marker).length && all.indexOf(marker) === index);
}
