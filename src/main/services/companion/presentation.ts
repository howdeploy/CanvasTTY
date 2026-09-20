/** Presentation only: lifecycle status comes from CanvasTTY, never from text. */
export function cleanTerminalText(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^\s*[─━═\-]{6,}\s*$/.test(line))
    .filter((line) => !/^\s*[◦•●]?\s*Working\s*\(/i.test(line))
    .filter(
      (line) =>
        !/^\s*gpt-[\w.-]+\s+(?:low|medium|high|xhigh|max|ultra|default|none)\s*·/.test(
          line,
        ),
    )
    .filter(
      (line) =>
        !/^\s*[›>]\s*(?:Ask Codex|Find and fix|Implement|Summarize|Explain this|Write tests|Use \/skills)/i.test(
          line,
        ),
    )
    .join("\n")
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
    .trim();
}

export function latestCodexReply(value: string): string {
  const lines = value.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    if (
      /^[•●]\s+/.test(lines[index]) &&
      !/^[•●]\s+(?:Working\s*\(|Starting MCP servers|You have \d+ usage limit resets|Tip:)/i.test(
        lines[index],
      )
    )
      start = index;
  }
  if (start < 0) return "";
  const selected = [];
  for (let index = start; index < lines.length; index++) {
    if (
      index > start &&
      (/^\s*›\s/.test(lines[index]) ||
        /^[•●◦]\s+(?:Starting MCP servers|You have \d+ usage limit resets|Tip:)/i.test(
          lines[index],
        ) ||
        /^\s*⚠\s*Heads up/i.test(lines[index]))
    )
      break;
    selected.push(
      index === start ? lines[index].replace(/^[•●]\s+/, "") : lines[index],
    );
  }
  return cleanTerminalText(selected.join("\n")).slice(-16000);
}

export interface ChoiceMenu {
  kind: "choices";
  title: string;
  options: Array<{ number: number; label: string }>;
  selected: number;
  customIndex: number | null;
}

export function codexMenu(value: string): ChoiceMenu | null {
  const lines = value.split(/\r?\n/),
    options: ChoiceMenu["options"] = [];
  let first = -1,
    last = -1,
    selected = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*([›❯>])?\s*(\d{1,2})[.)]\s+(.+?)\s*$/u);
    if (!match) {
      if (
        options.length &&
        /^\s{4,}\S/u.test(lines[i]) &&
        !/press.*(?:enter|esc)|(?:enter|esc).*to\b/iu.test(lines[i])
      )
        options.at(-1)!.label += " " + lines[i].trim();
      continue;
    }
    const number = Number(match[2]);
    if (number !== options.length + 1) {
      if (options.length) break;
      else continue;
    }
    if (first < 0) first = i;
    last = i;
    if (match[1]) {
      if (selected >= 0) return null;
      selected = options.length;
    }
    options.push({ number, label: match[3].trim() });
    if (options.length > 20) return null;
  }
  // Numbered prose is not a menu: a live selection cursor is required.
  if (options.length < 2 || selected < 0) return null;
  if (
    !lines
      .slice(last + 1)
      .some((line) =>
        /(?:press\s+)?enter\s+to\s+(?:confirm|select|submit)|esc\s+to\s+(?:go back|cancel)|enter.*(?:submit|выбр|подтверд)/iu.test(
          line,
        ),
      )
  )
    return null;
  if (
    lines
      .slice(last + 1)
      .some((line) => /^\s*›(?:\s*$|\s+(?!\d+[.)]\s)\S)/u.test(line))
  )
    return null;
  const prefix = cleanCodexChrome(lines.slice(0, first).join("\n"));
  const contextLines = prefix.split("\n");
  let heading = -1;
  for (let i = 0; i < contextLines.length; i++)
    if (
      /^\s*(?:Select\b|Choose\b|Would you like\b|Allow\b|Approve\b|Which\b|What\b|Question\s+\d|Выберите\b|Разрешить\b)/iu.test(
        contextLines[i],
      )
    )
      heading = i;
  const context =
    heading >= 0
      ? contextLines.slice(heading).join("\n").trim()
      : prefix
          .split(/\n\s*\n/u)
          .filter(Boolean)
          .at(-1) || "";
  const lastOption = options.length - 1;
  const custom =
    /^type (?:something|your|an? )|^other(?:\s*\(|\s*$)|^something else|tell codex.*differently|^сво[йею].*(?:ответ|вариант)|^другое|^ввести.*(?:текст|ответ)/iu.test(
      options[lastOption].label,
    )
      ? lastOption
      : -1;
  return {
    kind: "choices",
    title: context || "Выберите вариант",
    options,
    selected,
    customIndex: custom < 0 ? null : custom,
  };
}

/** Strip only known Codex UI chrome; never run this on authoritative answers. */
export function cleanCodexChrome(value: string): string {
  const lines = value.split(/\r?\n/),
    result: string[] = [];
  let banner = false,
    tip = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      /^\s*╭[─━]/u.test(line) &&
      lines
        .slice(i, i + 8)
        .some((x) => /OpenAI Codex|\bmodel:|\bdirectory:/.test(x))
    ) {
      banner = true;
      continue;
    }
    if (banner) {
      if (/^\s*╰[─━]/u.test(line)) banner = false;
      continue;
    }
    if (
      /^\s*(?:│\s*(?:>_\s*OpenAI Codex|model:|directory:|permissions:)|[\u2500-\u257f]+\s*$)/u.test(
        line,
      )
    )
      continue;
    if (/^\s*(?:[•●]\s*)?Tip:/iu.test(line)) {
      tip = true;
      continue;
    }
    if (tip) {
      if (!line.trim()) tip = false;
      else if (/^\s{2,}\S/.test(line)) continue;
      else tip = false;
    }
    if (
      /^\s*[•●◦]?\s*(?:You have \d+ usage limit resets|Starting MCP servers)/iu.test(
        line,
      )
    )
      continue;
    if (/^\s*\? for shortcuts|^\s*Press (?:enter|esc).*|^\s*›\s*$/iu.test(line))
      continue;
    result.push(line);
  }
  return cleanTerminalText(result.join("\n"));
}

export function presentTerminal(provider: string, value: string): string {
  if (provider === "codex") return latestCodexReply(value);
  return cleanTerminalText(value)
    .split("\n")
    .slice(-40)
    .join("\n")
    .slice(-16000);
}
