import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** draft-editor.sh; its path becomes part of $VISUAL, so it must be a plain path. */
  helperPath: string;
  writeClipboard: (text: string) => void;
  timeoutMs?: number;
}

type Step =
  | { data: string }
  | { action: ClaudeDraftAction; followUp: string; resolve: (done: boolean) => void };

interface SessionQueue {
  steps: Step[];
  write: (data: string) => boolean;
}

/**
 * Whole-draft copy/cut/clear for Claude Code on macOS. Claude has no select-all and
 * no draft API, but its Ctrl+G external-editor round trip hands the full draft (hidden
 * lines and pasted text included) to $VISUAL and reloads whatever $VISUAL leaves.
 * Claude drops keystrokes that arrive while the editor runs, so a session's actions run
 * one at a time and its input is held until they finish, then delivered in order.
 *
 * Each action is a file req.<n>. The helper claims the oldest one by renaming it, so a
 * request is either claimed or cancelled, never both. A Ctrl+G Claude has not picked up
 * by the deadline turns its request into cancel.<n>: a Ctrl+G that finds no request uses
 * up one cancel and changes nothing, so a late one opens no editor.
 */
export class ClaudeDraftEditor {
  private readonly queues = new Map<string, SessionQueue>();
  private readonly granted = new Set<string>();
  private readonly options: ClaudeDraftEditorOptions;
  private readonly timeoutMs: number;
  private sequence = 0;

  constructor(options: ClaudeDraftEditorOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DONE_TIMEOUT_MS;
  }

  /** Launch variables for one Claude session, or none when the helper cannot be used safely. */
  environment(sessionId: string, source: Readonly<Record<string, string | undefined>>): Record<string, string> {
    this.forget(sessionId);
    // $VISUAL may go through a shell: no whitespace, quoting or shell syntax in the helper's path.
    if (/[\s'"\\$`;&|<>(){}[\]*?!#~]/.test(this.options.helperPath) || !isSafeId(sessionId)) return {};
    // A new Claude process has no Ctrl+G outstanding from an earlier one.
    try {
      rmSync(this.directory(sessionId), { recursive: true, force: true });
    } catch {
      return {};
    }
    this.granted.add(sessionId);
    return {
      VISUAL: `/bin/sh ${this.options.helperPath}`,
      CANVASTTY_DRAFT_DIR: this.directory(sessionId),
      CANVASTTY_DRAFT_EDITOR: source.VISUAL || source.EDITOR || ""
    };
  }

  /** Whether this session's Claude was launched with the helper as its editor. */
  isGranted(sessionId: string): boolean {
    return this.granted.has(sessionId);
  }

  /** Queues input written while actions run; true when the caller must not write it now. */
  hold(sessionId: string, data: string): boolean {
    const queue = this.queues.get(sessionId);
    if (!queue) return false;
    queue.steps.push({ data });
    return true;
  }

  /**
   * Queues one action; once earlier ones finish it runs, then writes followUp (the key or
   * paste that replaces a selected draft). Resolves true when Claude's editor round trip ran.
   */
  run(sessionId: string, action: ClaudeDraftAction, followUp: string, write: (data: string) => boolean): Promise<boolean> {
    if (!isSafeId(sessionId) || !this.granted.has(sessionId)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const step: Step = { action, followUp, resolve };
      const queue = this.queues.get(sessionId);
      if (queue) {
        queue.steps.push(step);
        return;
      }
      const started: SessionQueue = { steps: [step], write };
      this.queues.set(sessionId, started);
      void this.drain(sessionId, started);
    });
  }

  /** Drops the session's queue and files; queued actions resolve false and held input is discarded. */
  forget(sessionId: string): void {
    this.granted.delete(sessionId);
    const queue = this.queues.get(sessionId);
    this.queues.delete(sessionId);
    for (const step of queue?.steps.splice(0) ?? []) if ("action" in step) step.resolve(false);
    if (!isSafeId(sessionId)) return;
    try {
      rmSync(this.directory(sessionId), { recursive: true, force: true });
    } catch {
      // Rebuilt with the next launch.
    }
  }

  private async drain(sessionId: string, queue: SessionQueue): Promise<void> {
    const live = () => this.queues.get(sessionId) === queue;
    while (live() && queue.steps.length > 0) {
      const step = queue.steps.shift()!;
      if ("data" in step) {
        queue.write(step.data);
        continue;
      }
      const done = await this.roundTrip(sessionId, step.action, queue.write, live).catch(() => false);
      if (live() && step.followUp) queue.write(step.followUp);
      step.resolve(done);
    }
    if (live()) this.queues.delete(sessionId);
  }

  private async roundTrip(
    sessionId: string,
    action: ClaudeDraftAction,
    write: (data: string) => boolean,
    live: () => boolean
  ): Promise<boolean> {
    const directory = this.directory(sessionId);
    const id = String(++this.sequence);
    const request = join(directory, `req.${id}`);
    const done = join(directory, `done.${id}`);
    const draft = join(directory, `draft.${id}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Written aside and renamed in, so the helper never sees a half-written request.
    const staged = join(directory, `staged.${id}`);
    rmSync(staged, { force: true });
    writeFileSync(staged, `${action}\n`, { mode: 0o600, flag: "wx" });
    renameSync(staged, request);
    try {
      if (!write(EXTERNAL_EDITOR_KEY)) {
        rmSync(request, { force: true });
        return false;
      }
      if (!(await this.waitFor(done, live))) {
        try {
          // Not claimed yet: the Ctrl+G still on its way must change nothing.
          renameSync(request, join(directory, `cancel.${id}`));
          return false;
        } catch {
          // Claimed just now; the helper is finishing this very request.
          if (!(await this.waitFor(done, live))) return false;
        }
      }
      if (action !== "clear") {
        const stat = lstatSync(draft, { throwIfNoEntry: false });
        const text = stat?.isFile() ? readFileSync(draft, "utf8") : "";
        if (text) this.options.writeClipboard(text);
      }
      return true;
    } finally {
      rmSync(done, { force: true });
      rmSync(draft, { force: true });
    }
  }

  private async waitFor(path: string, live: () => boolean): Promise<boolean> {
    const deadline = Date.now() + this.timeoutMs;
    while (live() && !existsSync(path)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return live();
  }

  private directory(sessionId: string): string {
    return join(this.options.root, sessionId);
  }
}

function isSafeId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId);
}
