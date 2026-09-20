import { createHash, randomBytes } from "node:crypto";
import xterm from "@xterm/headless";
import {
  IPC,
  type SessionMetadata,
  type TerminalDataEvent,
} from "../../../shared/contracts.ts";
import {
  cleanTerminalText,
  cleanCodexChrome,
  codexMenu,
  presentTerminal,
} from "./presentation.ts";

type Port = {
  listMetadata(): SessionMetadata[];
  geometry(id: string): { cols: number; rows: number };
  readBuffer(id: string): { buffer: string; outputOffset: number };
};
interface Screen {
  terminal: InstanceType<typeof xterm.Terminal>;
  ready: Promise<void>;
  offset: number;
  lastAnswer: string;
  answerTurn: string | null;
  authoritative: boolean;
  sequence: number;
  turnPending: boolean;
  busySeen: boolean;
  menuFingerprint: string | null;
  menuId: string | null;
  consumed: string | null;
}
export class TerminalPresentation {
  private screens = new Map<string, Screen>();
  private port: Port;
  constructor(port: Port) {
    this.port = port;
  }
  private screen(id: string): Screen {
    const prior = this.screens.get(id);
    if (prior) return prior;
    const terminal = new xterm.Terminal({
      ...this.port.geometry(id),
      allowProposedApi: true,
      scrollback: 300,
    });
    const buffer = this.port.readBuffer(id);
    const screen: Screen = {
      terminal,
      ready: new Promise((resolve) => terminal.write(buffer.buffer, resolve)),
      offset: buffer.outputOffset,
      lastAnswer: "",
      answerTurn: null,
      authoritative: false,
      sequence: 0,
      turnPending: false,
      busySeen: false,
      menuFingerprint: null,
      menuId: null,
      consumed: null,
    };
    this.screens.set(id, screen);
    return screen;
  }
  observe(channel: string, payload: unknown): void {
    if (channel === IPC.terminalRemoved) {
      const id = (payload as { id: string }).id;
      this.screens.get(id)?.terminal.dispose();
      this.screens.delete(id);
      return;
    }
    if (channel === IPC.terminalSession) {
      const session = (payload as { session: SessionMetadata }).session;
      const screen = this.screen(session.id);
      if (session.status === "working") {
        screen.turnPending = true;
        screen.busySeen = true;
      }
      return;
    }
    if (channel !== IPC.terminalData) return;
    const event = payload as TerminalDataEvent,
      screen = this.screen(event.id);
    const overlap = Math.max(
      0,
      screen.offset - (event.outputOffset - event.data.length),
    );
    const data = event.data.slice(overlap);
    screen.offset = Math.max(screen.offset, event.outputOffset);
    const geometry = this.port.geometry(event.id);
    if (
      geometry.cols !== screen.terminal.cols ||
      geometry.rows !== screen.terminal.rows
    )
      screen.terminal.resize(geometry.cols, geometry.rows);
    if (data)
      screen.ready = screen.ready.then(
        () =>
          new Promise<void>((resolve) => screen.terminal.write(data, resolve)),
      );
  }
  answer(id: string, text: string, turnId: string | null): void {
    if (!this.port.listMetadata().some((s) => s.id === id) || !text.trim())
      return;
    const screen = this.screen(id);
    if (turnId && screen.answerTurn === turnId) return;
    screen.answerTurn = turnId;
    screen.lastAnswer = text.trim();
    screen.authoritative = true;
    screen.sequence++;
    screen.turnPending = false;
  }
  pending(id: string): void {
    const screen = this.screen(id);
    screen.turnPending = true;
    screen.busySeen = false;
  }
  private async text(id: string, history = false): Promise<string> {
    const screen = this.screen(id);
    await screen.ready;
    const buffer = screen.terminal.buffer.active,
      lines: string[] = [];
    for (
      let i = history ? 0 : buffer.baseY;
      i < buffer.baseY + screen.terminal.rows;
      i++
    ) {
      const line = buffer.getLine(i),
        content = line?.translateToString(!history) || "";
      if (history && line?.isWrapped && lines.length)
        lines[lines.length - 1] += content;
      else lines.push(content);
    }
    return lines
      .map((line) => line.trimEnd())
      .join("\n")
      .trim()
      .slice(history ? -32000 : -10000);
  }
  async read(id: string) {
    const session = this.port.listMetadata().find((s) => s.id === id);
    if (!session) throw new Error("Session unavailable");
    const screen = this.screen(id),
      viewport = await this.text(id),
      menu = session.provider === "codex" ? codexMenu(viewport) : null;
    if (menu) {
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([menu.title, menu.options]))
        .digest("hex");
      if (screen.consumed === fingerprint)
        return {
          body: "Selection sent. Waiting for the terminal.",
          revision: "selected-" + fingerprint,
          interaction: null,
        };
      if (screen.menuFingerprint !== fingerprint || !screen.menuId) {
        screen.menuFingerprint = fingerprint;
        screen.menuId = randomBytes(16).toString("hex");
      }
      return {
        body: menu.title,
        revision: "menu-" + screen.menuId + "-" + menu.selected,
        interaction: { ...menu, id: screen.menuId },
      };
    }
    screen.menuId = null;
    screen.menuFingerprint = null;
    screen.consumed = null;
    if (
      !screen.authoritative &&
      session.status !== "working" &&
      session.status !== "needs_approval"
    ) {
      const reply = presentTerminal(
        session.provider,
        await this.text(id, true),
      );
      if (
        reply &&
        (session.provider !== "codex" ||
          !screen.lastAnswer ||
          (screen.turnPending && screen.busySeen))
      )
        screen.lastAnswer = reply;
    }
    const body =
      session.status === "needs_approval"
        ? cleanTerminalText(viewport)
        : screen.lastAnswer ||
          (session.provider === "codex"
            ? cleanCodexChrome(viewport)
            : cleanTerminalText(viewport));
    return {
      body: body || "Ready for a task.",
      revision:
        screen.sequence +
        "-" +
        createHash("sha256").update(body).digest("hex").slice(0, 16),
      interaction: null,
    };
  }
  async choice(id: string, menuId: string, index: number, custom: boolean) {
    const view = await this.read(id),
      menu = view.interaction;
    if (!menu || menu.id !== menuId) throw new Error("Menu changed");
    const target = custom ? menu.customIndex : index;
    if (
      target === null ||
      !Number.isInteger(target) ||
      target < 0 ||
      target >= menu.options.length
    )
      throw new Error("No matching option");
    const delta = target - menu.selected;
    return {
      data: (delta < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(delta)) + "\r",
      commit: () => {
        const screen = this.screen(id);
        screen.consumed = screen.menuFingerprint;
        screen.menuId = null;
      },
    };
  }
  close(): void {
    for (const screen of this.screens.values()) screen.terminal.dispose();
    this.screens.clear();
  }
}
