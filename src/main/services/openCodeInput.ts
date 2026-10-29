/** ConPTY may consume these modes; retain the existing Windows delivery behavior. */
export function waitsForOpenCodeStartup(provider: string, platform = process.platform): boolean {
  return provider === "opencode" && (platform === "linux" || platform === "darwin");
}

/** The verified OpenCode startup sequence, not an empty-composer or acceptance check. */
export class OpenCodeStartupReadiness {
  ready = false;
  private alternateScreen = false;
  private carry = "";

  push(data: string): boolean {
    if (this.ready) return true;
    const text = this.carry + data;
    let consumed = 0;
    for (const match of text.matchAll(/\x1b\[\?([\d;]+)([hl])/gu)) {
      consumed = match.index + match[0].length;
      const set = match[2] === "h";
      for (const mode of match[1]!.split(";")) {
        if (mode === "1049" || mode === "1047" || mode === "47") this.alternateScreen = set;
        else if (mode === "25" && set && this.alternateScreen) this.ready = true;
      }
      if (this.ready) { this.carry = ""; return true; }
    }
    const escape = text.lastIndexOf("\x1b");
    this.carry = escape >= consumed && text.length - escape < 32 ? text.slice(escape) : "";
    return false;
  }
}
