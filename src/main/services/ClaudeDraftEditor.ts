import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeDraftAction } from "../../shared/contracts.ts";

export const CLAUDE_DRAFT_ACTIONS: readonly ClaudeDraftAction[] = ["copy", "cut", "clear"];
export function isClaudeDraftAction(value: unknown): value is ClaudeDraftAction {
  return CLAUDE_DRAFT_ACTIONS.includes(value as ClaudeDraftAction);
}

const EXTERNAL_EDITOR_KEY = "\u0007";
const DONE_TIMEOUT_MS = 3000;
const POLL_MS = 15;

export interface ClaudeDraftEditorOptions {
  /** Private folder for the per-session request/done files; created on demand. */
  root: string;
  /** draft-editor.sh; its path becomes part of $VISUAL, so it must not contain whitespace. */
  helperPath: string;
  writeClipboard: (text: string) => void;
  timeoutMs?: number;
}

/**
 * Whole-draft copy/cut/clear for Claude Code on macOS. Claude has no select-all and
 * no draft API, but its Ctrl+G external-editor round trip hands the full draft (hidden
 * lines and pasted text included) to $VISUAL and reloads whatever $VISUAL leaves.
 * Claude drops keystrokes that arrive while the editor runs, so input for the session
 * is held until the helper reports done and then delivered in order. The request file
 * has one line per Ctrl+G sent; a Ctrl+G Claude has not picked up by the deadline stays
 * queued as "cancel", so arriving late it opens no editor and changes nothing.
 */
export class ClaudeDraftEditor {
  private readonly pending = new Map<string, string[]>();
  private readonly options: ClaudeDraftEditorOptions;
  private readonly timeoutMs: number;

  constructor(options: ClaudeDraftEditorOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DONE_TIMEOUT_MS;
  }

  /** Launch variables for one Claude session, or none when the helper cannot be named safely. */
  environment(sessionId: string, source: Readonly<Record<string, string | undefined>>): Record<string, string> {
    if (/\s/.test(this.options.helperPath) || !isSafeId(sessionId)) return {};
    // A new Claude process has no Ctrl+G outstanding from an earlier one.
    rmSync(this.directory(sessionId), { recursive: true, force: true });
    return {
      VISUAL: `/bin/sh ${this.options.helperPath}`,
      CANVASTTY_DRAFT_DIR: this.directory(sessionId),
      CANVASTTY_DRAFT_EDITOR: source.VISUAL || source.EDITOR || ""
    };
  }

  /** Queues input written while an action runs; true when the caller must not write it now. */
  hold(sessionId: string, data: string): boolean {
    const queue = this.pending.get(sessionId);
    if (!queue) return false;
    queue.push(data);
    return true;
  }

  /**
   * Runs one action and then writes followUp (the key or paste that replaces a selected
   * draft) and anything typed meanwhile. Resolves true when Claude's editor round trip ran.
   */
  async run(sessionId: string, action: ClaudeDraftAction, followUp: string, write: (data: string) => boolean): Promise<boolean> {
    if (!isSafeId(sessionId) || this.pending.has(sessionId)) return false;
    const directory = this.directory(sessionId);
    const request = join(directory, "request");
    this.pending.set(sessionId, []);
    let done = false;
    let sent = false;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      rmSync(join(directory, "done"), { force: true });
      rmSync(join(directory, "draft.txt"), { force: true });
      this.writeRequest(request, [...this.readRequest(request), action]);
      sent = write(EXTERNAL_EDITOR_KEY);
      if (!sent) return false;
      const deadline = Date.now() + this.timeoutMs;
      while (!(done = existsSync(join(directory, "done"))) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      if (done && action !== "clear") {
        const text = readFileSync(join(directory, "draft.txt"), "utf8");
        if (text) this.options.writeClipboard(text);
      }
      return done;
    } catch {
      return false;
    } finally {
      try {
        const queued = this.readRequest(request);
        if (!sent) queued.pop();
        // Every line still queued is a Ctrl+G on its way; none of them may act any more.
        this.writeRequest(request, done ? queued : queued.map(() => "cancel"));
        rmSync(join(directory, "done"), { force: true });
        rmSync(join(directory, "draft.txt"), { force: true });
      } catch {
        // The folder is private and rebuilt with the next action or launch.
      }
      const held = this.pending.get(sessionId) ?? [];
      this.pending.delete(sessionId);
      const rest = followUp + held.join("");
      if (rest) write(rest);
    }
  }

  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    if (isSafeId(sessionId)) rmSync(this.directory(sessionId), { recursive: true, force: true });
  }

  private readRequest(request: string): string[] {
    return existsSync(request) ? readFileSync(request, "utf8").split("\n").filter(Boolean) : [];
  }

  private writeRequest(request: string, lines: readonly string[]): void {
    if (lines.length === 0) {
      rmSync(request, { force: true });
      return;
    }
    // Renamed into place so the helper never reads a half-written queue.
    writeFileSync(`${request}.write`, `${lines.join("\n")}\n`, { mode: 0o600 });
    renameSync(`${request}.write`, request);
  }

  private directory(sessionId: string): string {
    return join(this.options.root, sessionId);
  }
}

function isSafeId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId);
}
