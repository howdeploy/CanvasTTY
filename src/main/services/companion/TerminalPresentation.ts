import { createHash, randomBytes } from "node:crypto";
import { lazyRequire } from "../../lazyRequire.ts";
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

// Headless terminals are created on demand; the module loads with the first one.
const xterm = lazyRequire<typeof import("@xterm/headless")>("@xterm/headless");

/**
 * How long a session's headless screen may sit unread before its xterm parser is disposed. Presentation is
 * request-driven (the device polls `/g2/api/terminal` while a session is actually on screen), so a screen that
 * has gone quiet for this long is no longer being presented; its parser is torn down and, if the device comes
 * back to it, rebuilt from the main terminal's own retained buffer (see `parsed()`).
 */
const IDLE_SCREEN_MS = 20_000;

type Port = {
  listMetadata(): SessionMetadata[];
  geometry(id: string): { cols: number; rows: number };
  readBuffer(id: string): { buffer: string; outputOffset: number };
  /** The secret redaction registry's masking (the manager's `redactSecrets`). */
  redactSecrets?(text: string): string;
};
interface Screen {
  /**
   * The session's headless screen, made the first time the glasses read it (from the scrollback, which is
   * the same text the live stream carries) and fed from then on. Sessions nobody reads cost nothing to parse.
   */
  terminal: import("@xterm/headless").Terminal | null;
  ready: Promise<void>;
  offset: number;
  lastAnswer: string;
  answerTurn: string | null;
  answerExpiresAt: number | null;
  authoritative: boolean;
  sequence: number;
  turnPending: boolean;
  inputPending: boolean;
  observedStatus: SessionMetadata["status"] | null;
  responseAvailable: boolean;
  busySeen: boolean;
  menuFingerprint: string | null;
  menuId: string | null;
  consumed: string | null;
  /** Set each time this session is actually read (presented); drives idle disposal of `terminal`. */
  lastRead: number;
}
export class TerminalPresentation {
  private screens = new Map<string, Screen>();
  private port: Port;
  constructor(port: Port) {
    this.port = port;
  }
  /** The session's answer state; cheap, made for every session the companion hears about. */
  private screen(id: string): Screen {
    const prior = this.screens.get(id);
    if (prior) return prior;
    const screen: Screen = {
      terminal: null,
      ready: Promise.resolve(),
      offset: 0,
      lastAnswer: "",
      answerTurn: null,
      answerExpiresAt: null,
      authoritative: false,
      sequence: 0,
      turnPending: false,
      inputPending: false,
      observedStatus: null,
      responseAvailable: false,
      busySeen: false,
      menuFingerprint: null,
      menuId: null,
      consumed: null,
      lastRead: 0,
    };
    this.screens.set(id, screen);
    return screen;
  }
  /**
   * The session's state with its headless screen, rebuilt from the main terminal's retained buffer whenever it
   * was disposed (never yet made, or reaped by `sweepIdle` after this session stopped being presented).
   */
  private parsed(id: string): Screen & { terminal: import("@xterm/headless").Terminal } {
    const screen = this.screen(id);
    screen.lastRead = Date.now();
    this.sweepIdle(screen.lastRead);
    if (!screen.terminal) {
      const terminal = new (xterm().Terminal)({
        ...this.port.geometry(id),
        allowProposedApi: true,
        scrollback: 300,
      });
      const buffer = this.port.readBuffer(id);
      screen.terminal = terminal;
      screen.offset = buffer.outputOffset;
      screen.ready = new Promise((resolve) => terminal.write(buffer.buffer, resolve));
    }
    return screen as Screen & { terminal: import("@xterm/headless").Terminal };
  }
  /**
   * Disposes the headless xterm parser of every screen that has not been read for `IDLE_SCREEN_MS`. Piggybacks
   * on existing traffic (a read, or live output for some session) rather than a new timer; the rest of the
   * screen's state (answer cache, menu, etc.) is untouched, and `parsed()` rebuilds the parser from the main
   * terminal's retained buffer the next time this session is actually presented again. A screen just read at
   * `now` is never disposed by its own call, since its `lastRead` is `now` too.
   */
  private sweepIdle(now: number): void {
    for (const screen of this.screens.values()) {
      if (!screen.terminal || now - screen.lastRead < IDLE_SCREEN_MS) continue;
      screen.terminal.dispose();
      screen.terminal = null;
      screen.ready = Promise.resolve();
    }
  }
  observe(channel: string, payload: unknown): void {
    if (channel === IPC.terminalRemoved) {
      const id = (payload as { id: string }).id;
      this.screens.get(id)?.terminal?.dispose();
      this.screens.delete(id);
      return;
    }
    if (channel === IPC.terminalSession) {
      const session = (payload as { session: SessionMetadata }).session;
      this.observeStatus(this.screen(session.id),session);
      return;
    }
    if (channel !== IPC.terminalData) return;
    const event = payload as TerminalDataEvent;
    // Piggyback idle disposal on live output traffic too, so a session nobody reads any more stops being
    // parsed even while it keeps emitting output (no new timer is introduced): if this very session's screen
    // is the one that goes idle, the sweep below disposes it and the write beneath is skipped.
    this.sweepIdle(Date.now());
    const screen = this.screens.get(event.id);
    // Not read yet: the scrollback will hold this output when the glasses first ask.
    const terminal = screen?.terminal;
    if (!screen || !terminal) return;
    const overlap = Math.max(
      0,
      screen.offset - (event.outputOffset - event.data.length),
    );
    const data = event.data.slice(overlap);
    screen.offset = Math.max(screen.offset, event.outputOffset);
    const geometry = this.port.geometry(event.id);
    if (
      geometry.cols !== terminal.cols ||
      geometry.rows !== terminal.rows
    )
      terminal.resize(geometry.cols, geometry.rows);
    if (data)
      screen.ready = screen.ready.then(
        () =>
          new Promise<void>((resolve) => terminal.write(data, resolve)),
      );
  }
  private observeStatus(screen:Screen,session:SessionMetadata):void {
    const previous=screen.observedStatus;
    screen.observedStatus=session.status;
    if(session.status==="working") {
      screen.turnPending=true;screen.busySeen=true;screen.responseAvailable=false;
    } else if(session.status==="idle" && !session.turnCompleted) {
      if(previous===null || previous==="working")screen.responseAvailable=true;
      if(previous==="working")screen.inputPending=false;
    } else screen.responseAvailable=false;
  }
  /** An old response is eligible again only after fresh progress/answer, not a failed-to-idle transition. */
  canShowResponseAttention(id:string):boolean {
    const screen=this.screens.get(id);
    return screen?.responseAvailable===true && !screen.inputPending;
  }
  answer(id: string, text: string, turnId: string | null, expiresAt: number): void {
    if (!this.port.listMetadata().some((s) => s.id === id) || !text.trim())
      return;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    const screen = this.screen(id);
    if (turnId && screen.answerTurn === turnId) return;
    screen.answerTurn = turnId;
    screen.answerExpiresAt = expiresAt;
    screen.lastAnswer = this.redact(text.trim());
    screen.authoritative = true;
    screen.sequence++;
    screen.turnPending = false;
    screen.inputPending = false;
    screen.responseAvailable = true;
  }
  clearAnswer(id: string): void {
    const screen = this.screens.get(id);
    if (!screen) return;
    screen.lastAnswer = "";
    screen.answerTurn = null;
    screen.answerExpiresAt = null;
    screen.authoritative = true;
    screen.sequence++;
  }
  pending(id: string): void {
    const screen = this.screen(id);
    screen.turnPending = true;
    screen.busySeen = false;
  }
  /** A confirmed text/voice submission acknowledges a response; raw terminal keys do not. */
  submitted(id:string):void {
    this.pending(id);
    this.screen(id).inputPending = true;
  }
  /** Successful device input resolves the prior response notice until fresh progress or an answer. */
  hasPendingInput(id:string):boolean { return this.screens.get(id)?.inputPending ?? false; }
  /**
   * What leaves for the companion device is masked like any text handed out: the whole screen at once, so a key
   * the terminal wrapped over two lines is still found (the registry tolerates the line break), before it is cut.
   */
  private redact(text: string): string {
    return this.port.redactSecrets ? this.port.redactSecrets(text) : text;
  }
  private async text(id: string, history = false): Promise<string> {
    const screen = this.parsed(id);
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
    return this.redact(
      lines
        .map((line) => line.trimEnd())
        .join("\n")
        .trim(),
    ).slice(history ? -32000 : -10000);
  }
  async read(id: string) {
    const session = this.port.listMetadata().find((s) => s.id === id);
    if (!session) throw new Error("Session unavailable");
    const screen = this.screen(id);
    this.observeStatus(screen,session);
    const viewport = await this.text(id),
      menu = session.provider === "codex" ? codexMenu(viewport) : null;
    if (screen.answerExpiresAt !== null && screen.answerExpiresAt <= Date.now()) {
      screen.lastAnswer = "";
      screen.answerTurn = null;
      screen.answerExpiresAt = null;
      screen.authoritative = true;
      screen.sequence++;
    }
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
      ) {
        if (reply !== screen.lastAnswer) {
          screen.inputPending = false;
          if(session.status==="idle" && !session.turnCompleted)screen.responseAvailable=true;
        }
        screen.lastAnswer = reply;
      }
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
    for (const screen of this.screens.values()) screen.terminal?.dispose();
    this.screens.clear();
  }
}
