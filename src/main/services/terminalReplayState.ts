const ESC = "\x1b";
const MAX_PENDING_SEQUENCE = 4_096;
const PRIVATE_MODES = new Set([1, 6, 7, 12, 25, 45, 66, 1004, 2004, 2026]);
const MOUSE_MODES = new Set([9, 1000, 1002, 1003]);
const MOUSE_ENCODINGS = new Set([1006, 1016]);
const SGR_FLAGS: Record<number, [string, boolean]> = {
  1: ["bold", true], 2: ["dim", true], 3: ["italic", true], 23: ["italic", false],
  4: ["underline", true], 21: ["underline", true], 24: ["underline", false],
  5: ["blink", true], 25: ["blink", false], 7: ["inverse", true], 27: ["inverse", false],
  8: ["invisible", true], 28: ["invisible", false], 9: ["strike", true], 29: ["strike", false],
  53: ["overline", true], 55: ["overline", false]
};

/**
 * State immediately before the raw scrollback ring. Completed OSC/DCS payloads are never replayed.
 * Fixed mode/style groups and a capped incomplete sequence keep this bounded independently of PTY output.
 * shortcut: evicted cells, cursor positions and wrap history need a screen checkpoint for full reconstruction.
 */
export class TerminalReplayState {
  private sgr = new Map<string, string>();
  private normalSavedSgr = new Map<string, string>();
  private alternateSavedSgr = new Map<string, string>();
  private modes = new Map<number, boolean>();
  private alternate = 0;
  private insert = false;
  private mouse = 0;
  private mouseEncoding = 0;
  private margins = "";
  private charsets = new Map<string, string>();
  private shift = "";
  private pending = "";
  private state: "ground" | "escape" | "csi" | "osc" | "string" = "ground";
  private clipped = false;
  private highSurrogate = "";

  feed(data: string): void {
    for (let index = 0; index < data.length; index++) {
      const char = data[index]!;
      const code = data.charCodeAt(index);
      if (this.state === "ground" && code >= 0x20 && !(code >= 0x80 && code <= 0x9f)) continue;
      if (code === 0x18 || code === 0x1a || code === 0x9c || (code >= 0x80 && code <= 0x9a && ![0x90, 0x98].includes(code))) {
        this.finish();
        continue;
      }
      if (code === 0x1b) {
        this.pending = ESC;
        this.state = "escape";
        this.clipped = false;
        continue;
      }
      if ((code === 0x0e || code === 0x0f) && this.state !== "osc" && this.state !== "string") {
        this.shift = char;
        continue;
      }
      if ([0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f].includes(code)) {
        if (code === 0x9b) this.start("csi", `${ESC}[`);
        else if (code === 0x9d) this.start("osc", `${ESC}]`);
        else this.start("string", `${ESC}${code === 0x90 ? "P" : "X"}`);
        continue;
      }
      if (this.state === "ground") continue;
      if (this.state === "osc" && code === 7) {
        this.finish();
        continue;
      }
      // Executed C0 controls do not belong to a CSI/ESC parameter string.
      if (code < 0x20) continue;
      if (code === 0x7f && this.state !== "osc" && this.state !== "string") continue;
      if (!this.clipped) {
        this.pending += char;
        if (this.pending.length > MAX_PENDING_SEQUENCE) {
          this.clipped = true;
          // Consume the rest without turning an oversized string into visible text or replaying side effects.
          this.pending = this.state === "osc" ? `${ESC}]999999;` : this.state === "string" ? `${ESC}X` : `${ESC}[0?`;
        }
      }
      if (this.state === "escape") {
        if (this.pending === `${ESC}[`) this.state = "csi";
        else if (this.pending === `${ESC}]`) this.state = "osc";
        else if ([`${ESC}P`, `${ESC}X`, `${ESC}^`, `${ESC}_`].includes(this.pending)) this.state = "string";
        else if (code >= 0x30 && code <= 0x7e) {
          if (!this.clipped) this.escape(this.pending);
          this.finish();
        }
      } else if (this.state === "csi" && code >= 0x40 && code <= 0x7e) {
        if (!this.clipped) this.csi(this.pending);
        this.finish();
      }
    }
    const last = data.charCodeAt(data.length - 1);
    this.highSurrogate = last >= 0xd800 && last <= 0xdbff && this.state === "ground" ? data.slice(-1) : "";
  }

  prefix(): string {
    const style = (values: Map<string, string>): string => `${ESC}[0${values.size ? `;${[...values.values()].join(";")}` : ""}m`;
    let prefix = "";
    if (this.alternate) {
      prefix += style(this.normalSavedSgr) + `${ESC}[?${this.alternate}h`;
      prefix += style(this.alternateSavedSgr) + `${ESC}7`;
    } else if (this.normalSavedSgr.size) prefix += style(this.normalSavedSgr) + `${ESC}7`;
    if (this.margins) prefix += this.margins;
    for (const [mode, enabled] of this.modes) prefix += `${ESC}[?${mode}${enabled ? "h" : "l"}`;
    if (this.insert) prefix += `${ESC}[4h`;
    if (this.mouse) prefix += `${ESC}[?${this.mouse}h`;
    if (this.mouseEncoding) prefix += `${ESC}[?${this.mouseEncoding}h`;
    prefix += [...this.charsets.values()].join("") + this.shift;
    if (prefix || this.sgr.size) prefix += style(this.sgr);
    return prefix + this.pending + this.highSurrogate;
  }

  private start(state: typeof this.state, prefix: string): void {
    this.state = state;
    this.pending = prefix;
    this.clipped = false;
  }

  private finish(): void {
    this.state = "ground";
    this.pending = "";
    this.clipped = false;
  }

  private escape(sequence: string): void {
    if (sequence === `${ESC}c`) {
      this.sgr.clear();
      this.normalSavedSgr.clear();
      this.alternateSavedSgr.clear();
      this.modes.clear();
      this.alternate = this.mouse = this.mouseEncoding = 0;
      this.insert = false;
      this.margins = this.shift = "";
      this.charsets.clear();
    } else if (sequence === `${ESC}7`) this.saveSgr();
    else if (sequence === `${ESC}8`) this.restoreSgr();
    else if (/^\x1b[()*+\-./][0-~]$/u.test(sequence)) this.charsets.set(sequence[1]!, sequence);
    else if (sequence === `${ESC}=`) this.modes.set(66, true);
    else if (sequence === `${ESC}>`) this.modes.set(66, false);
    else if (/^\x1b[no|}~]$/u.test(sequence)) this.shift = sequence;
  }

  private csi(sequence: string): void {
    const sgr = /^\x1b\[([\d;:]*)m$/u.exec(sequence);
    if (sgr) {
      this.rendition(sgr[1]!);
      return;
    }
    const modes = /^\x1b\[(\??)([\d;]*)([hl])$/u.exec(sequence);
    if (modes) {
      const enabled = modes[3] === "h";
      for (const value of modes[2]!.split(";").map(Number)) {
        if (!modes[1]) {
          if (value === 4) this.insert = enabled;
        } else if ([47, 1047, 1049].includes(value)) {
          if (enabled && value === 1049) this.saveSgr();
          this.alternate = enabled ? value : 0;
          if (!enabled && value === 1049) this.restoreSgr();
        } else if (value === 1048) enabled ? this.saveSgr() : this.restoreSgr();
        else if (PRIVATE_MODES.has(value)) this.modes.set(value, enabled);
        else if (MOUSE_MODES.has(value)) this.mouse = enabled ? value : 0;
        else if (MOUSE_ENCODINGS.has(value)) this.mouseEncoding = enabled ? value : 0;
      }
    } else if (/^\x1b\[\d*(;\d*)?r$/u.test(sequence)) this.margins = sequence;
    else if (sequence === `${ESC}[s`) this.saveSgr();
    else if (sequence === `${ESC}[u`) this.restoreSgr();
    else if (sequence === `${ESC}[!p`) {
      this.sgr.clear();
      this.insert = false;
      this.margins = this.shift = "";
      this.modes.clear();
      this.charsets.clear();
      (this.alternate ? this.alternateSavedSgr : this.normalSavedSgr).clear();
    }
  }

  private saveSgr(): void {
    if (this.alternate) this.alternateSavedSgr = new Map(this.sgr);
    else this.normalSavedSgr = new Map(this.sgr);
  }

  private restoreSgr(): void {
    this.sgr = new Map(this.alternate ? this.alternateSavedSgr : this.normalSavedSgr);
  }

  private rendition(parameters: string): void {
    const parts = parameters.split(";");
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const code = Number(part.split(":")[0]);
      if (code === 0) this.sgr.clear();
      else if (code === 22) { this.sgr.delete("bold"); this.sgr.delete("dim"); }
      else if ([38, 48, 58].includes(code)) {
        const group = code === 38 ? "foreground" : code === 48 ? "background" : "underlineColor";
        if (part.includes(":")) this.sgr.set(group, part);
        else {
          const count = parts[index + 1] === "5" ? 3 : parts[index + 1] === "2" ? 5 : 0;
          if (count && index + count <= parts.length) this.sgr.set(group, parts.slice(index, index + count).join(";"));
          if (count) index += count - 1;
        }
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.sgr.set("foreground", part);
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.sgr.set("background", part);
      else if (code === 39) this.sgr.delete("foreground");
      else if (code === 49) this.sgr.delete("background");
      else if (code === 59) this.sgr.delete("underlineColor");
      else {
        const group = SGR_FLAGS[code];
        if (group) group[1] && part !== "4:0" ? this.sgr.set(group[0], part) : this.sgr.delete(group[0]);
      }
    }
  }
}
