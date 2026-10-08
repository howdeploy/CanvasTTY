/** Tracks only the terminal output protocol needed for clipboard paste, before scrollback is truncated.
 * CSI parameters have the same 32-entry/int32 bounds as xterm; strings retain no payload.
 */
export class TerminalPasteMode {
  private state: "ground" | "escape" | "escapeIntermediate" | "csiEntry" | "csiParam" | "csiIntermediate" | "csiIgnore" | "osc" | "string" | "dcsHeader" | "dcs" = "ground";
  private enabled = false;
  private collect = 0;
  private params: number[] = [0];
  private subparam = false;
  private overflow = false;

  accept(data: string): void {
    for (const char of data) {
      const code = char.codePointAt(0)!;
      if (code === 0x1b) { this.state = "escape"; this.collect = 0; continue; }
      if (code === 0x9b) { this.beginCsi(); continue; }
      if (code === 0x9d) { this.state = "osc"; continue; }
      if (code === 0x90) { this.state = "dcsHeader"; continue; }
      if (code === 0x98 || code === 0x9e || code === 0x9f) { this.state = "string"; continue; }
      if (code === 0x18 || code === 0x1a || code === 0x9c || (code >= 0x80 && code <= 0x9a)) {
        this.state = "ground"; continue;
      }
      if (this.state === "osc") { if (code === 7) this.state = "ground"; continue; }
      if (this.state === "string" || this.state === "dcs") continue;
      if (code < 0x20 || code === 0x7f) continue;
      if (this.state === "dcsHeader") { if (code >= 0x40 && code <= 0x7e) this.state = "dcs"; continue; }
      if (this.state === "ground") continue;
      if (this.state === "escape" || this.state === "escapeIntermediate") {
        if (this.state === "escape") {
          if (char === "[") { this.beginCsi(); continue; }
          if (char === "]") { this.state = "osc"; continue; }
          if (char === "P") { this.state = "dcsHeader"; continue; }
          if (char === "X" || char === "^" || char === "_") { this.state = "string"; continue; }
          if (char === "c") this.enabled = false; // RIS
        }
        if (code >= 0x20 && code <= 0x2f) this.state = "escapeIntermediate";
        else this.state = "ground";
        continue;
      }
      if (code >= 0x40 && code <= 0x7e) {
        if (this.state !== "csiIgnore") {
          if (this.collect === 0x3f && (char === "h" || char === "l") && this.params.includes(2004)) this.enabled = char === "h";
          if (this.collect === 0x21 && char === "p") this.enabled = false; // DECSTR also resets xterm's private modes.
        }
        this.state = "ground";
      } else if (this.state !== "csiIgnore") {
        if (code >= 0x20 && code <= 0x2f) {
          this.collect = (this.collect << 8) | code;
          this.state = "csiIntermediate";
        } else if (this.state === "csiIntermediate") this.state = "csiIgnore";
        else if (code >= 0x3c && code <= 0x3f && this.state === "csiEntry") {
          this.collect = code; this.state = "csiParam";
        } else if (code >= 0x30 && code <= 0x39) {
          if (!this.subparam && !this.overflow) {
            const i = this.params.length - 1;
            this.params[i] = Math.min(0x7fffffff, this.params[i] * 10 + code - 0x30);
          }
          this.state = "csiParam";
        } else if (char === ";" || char === ":") {
          this.subparam = char === ":";
          if (!this.subparam) {
            if (this.params.length < 32) this.params.push(0); else this.overflow = true;
          }
          this.state = "csiParam";
        } else this.state = "csiIgnore";
      }
    }
  }

  paste(text: string): string {
    const normalized = text.replace(/\r?\n/g, "\r");
    return this.enabled ? `\x1b[200~${normalized}\x1b[201~` : normalized;
  }

  private beginCsi(): void {
    this.state = "csiEntry"; this.collect = 0; this.params = [0]; this.subparam = false; this.overflow = false;
  }
}
