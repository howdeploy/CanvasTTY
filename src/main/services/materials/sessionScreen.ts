import type { TerminalDataEvent } from "../../../shared/contracts";
import { lazyRequire } from "../../lazyRequire.ts";

const xterm = lazyRequire<typeof import("@xterm/headless")>("@xterm/headless");

export interface ScreenPort {
  geometry(id: string): { cols: number; rows: number };
  readBuffer(id: string): { buffer: string; outputOffset: number };
}

export class SessionScreen {
  readonly id: string;
  private readonly port: ScreenPort;
  private readonly terminal: import("@xterm/headless").Terminal;
  private ready: Promise<void>;
  private offset: number;
  private disposed = false;

  constructor(port: ScreenPort, id: string) {
    this.id = id;
    this.port = port;
    const geometry = port.geometry(id);
    this.terminal = new (xterm().Terminal)({ cols: geometry.cols, rows: geometry.rows, allowProposedApi: true, scrollback: 200 });
    const snapshot = port.readBuffer(id);
    this.offset = snapshot.outputOffset;
    this.ready = new Promise((resolve) => this.terminal.write(snapshot.buffer, resolve));
  }

  feed(event: TerminalDataEvent): void {
    if (event.id !== this.id) return;
    const overlap = Math.max(0, this.offset - (event.outputOffset - event.data.length));
    const data = event.data.slice(overlap);
    this.offset = Math.max(this.offset, event.outputOffset);
    if (!data || this.disposed) return;
    let geometry: { cols: number; rows: number } | null = null;
    try {
      geometry = this.port.geometry(this.id);
    } catch {
      geometry = null;
    }
    this.ready = this.ready.then(() => new Promise((resolve) => {
      if (this.disposed) return resolve();
      if (geometry && (geometry.cols !== this.terminal.cols || geometry.rows !== this.terminal.rows)) this.terminal.resize(geometry.cols, geometry.rows);
      this.terminal.write(data, resolve);
    }));
  }

  async text(): Promise<string> {
    await this.ready;
    if (this.disposed) return "";
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = buffer.baseY; row < buffer.baseY + this.terminal.rows; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  async typedAfter(marker: string): Promise<string | null> {
    await this.ready;
    if (this.disposed) return null;
    const buffer = this.terminal.buffer.active;
    let boundary = buffer.baseY + this.terminal.rows;
    for (let row = boundary - 1; row >= buffer.baseY; row -= 1) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) ?? "";
      if (/[─│╭╰═┃]{3,}/u.test(text)) {
        boundary = row;
        break;
      }
    }
    const collect = (line: { length: number; getCell(column: number): { getChars(): string; isDim(): number } | undefined } | undefined, from: number): string => {
      if (!line) return "";
      let typed = "";
      for (let column = from; column < line.length; column += 1) {
        const cell = line.getCell(column);
        const chars = cell?.getChars() ?? "";
        if (cell && chars.trim() && !cell.isDim()) typed += chars;
      }
      return typed;
    };
    let sawMarker = false;
    for (let row = boundary - 1; row >= buffer.baseY; row -= 1) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) ?? "";
      if (/[─│╭╰═┃]{3,}/u.test(text)) break;
      const at = text.indexOf(marker);
      if (!line || at === -1 || text.slice(0, at).trim() !== "") continue;
      sawMarker = true;
      let typed = collect(line, at + marker.length);
      for (let below = row + 1; below < boundary; below += 1) typed += collect(buffer.getLine(below), 0);
      if (typed !== "") return typed;
    }
    return sawMarker ? "" : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
}

export function withoutBraille(screen: string): string {
  return screen.replace(/[\u2800-\u28ff]/g, " ");
}

export function imageMarkers(screen: string): number {
  return new Set(screen.match(/\[Image #\d+\]/g) ?? []).size;
}

export function pasteMarkers(screen: string): number {
  return (screen.match(/\[Pasted (?:text #\d+[^\]]*|Content[^\]]*)\]/g) ?? []).length;
}
