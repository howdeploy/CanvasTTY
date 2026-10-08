export interface TerminalFileLocation {
  path: string;
  line: number;
  column: number;
}

export function parseTerminalFileLink(value: unknown): TerminalFileLocation | null {
  if (typeof value !== "string" || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let path = value.trim();
  let fragment = "";
  if (/^(?:file|vscode):/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.username || url.password || url.search || url.port) return null;
      if (url.protocol === "file:" && url.hostname !== "" && url.hostname !== "localhost") return null;
      if (url.protocol === "vscode:" && url.hostname !== "file") return null;
      path = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      fragment = url.hash;
    } catch {
      return null;
    }
  }
  const position = /:(\d+)(?::(\d+))?$/.exec(path);
  if (position) path = path.slice(0, position.index);
  const hashPosition = /^#L?(\d+)(?:C(\d+))?$/.exec(fragment);
  if (fragment && !hashPosition) return null;
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return null;
  const drive = /^[a-z]:[\\/]/i.test(path);
  if ((drive ? path.slice(2) : path).includes(":")) return null;
  if (!/[\\/]/.test(path) && !position && !hashPosition) return null;
  if (/^[\\/]{2}/.test(path) || /^\\/.test(path)) return null;
  const line = Number(hashPosition?.[1] ?? position?.[1] ?? 1);
  const column = Number(hashPosition?.[2] ?? position?.[2] ?? 1);
  if (![line, column].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647)) return null;
  return { path, line, column };
}

export function findTerminalFileLinks(text: string): { start: number; end: number; text: string }[] {
  const links: { start: number; end: number; text: string }[] = [];
  const tokens = /"([^"\n]+)"(:\d+(?::\d+)?)?|'([^'\n]+)'(:\d+(?::\d+)?)?|`([^`\n]+)`(:\d+(?::\d+)?)?|([^\s<>"'`()[\]{}]+)/gu;
  for (const match of text.matchAll(tokens)) {
    const quoted = match[7] === undefined;
    const raw = match[1] ?? match[3] ?? match[5] ?? match[7];
    const suffix = match[2] ?? match[4] ?? match[6] ?? "";
    const value = quoted ? raw + suffix : raw.replace(/[.,;!?]+$/, "");
    if (!parseTerminalFileLink(value)) continue;
    links.push({ start: match.index, end: match.index + match[0].length - (raw.length + suffix.length - value.length), text: value });
  }
  return links;
}
