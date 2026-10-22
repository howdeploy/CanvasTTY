import type { GitCheckpoints } from "./GitCheckpoints.ts";
import type { TerminalManager } from "./TerminalManager.ts";
import { isTurnStart } from "./agent-runtime/RuntimeGateway.ts";

type BarrierTerminals = Pick<TerminalManager, "getMetadata" | "canCaptureCheckpoint" | "providerSignalGuard" | "isCheckpointRestoreActive" | "submittedInputs">;

/** The longest a turn start or a permission decision waits for its rollback point (below the hooks' 1 s deadline). */
export const CHECKPOINT_BARRIER_MS = 750;

export interface CheckpointTurnBarrierDependencies {
  /** The terminal manager, once it exists (the runtime gateway is created first). */
  terminals(): BarrierTerminals | null;
  checkpoints: Pick<GitCheckpoints, "capture">;
  redact(text: string): string;
  warn?(message: string, detail: string): void;
  /** Tests may shorten the bound (a permission decision's wait, and a capture's longest run). */
  barrierMs?: number;
}

type Turn = {
  pending: Promise<void>; turnId: string | null; current: () => boolean; submitted: number;
  /** Cancels the capture; `waiting` counts the barriers (lifecycle or permission) still waiting for it. */
  capture: AbortController; waiting: number;
};

/**
 * When rollback points are taken: once per agent turn of a live auto or yolo card, before its turn starts (the
 * runtime gateway holds the authenticated `working` hook's acknowledgement, bounded and fail-open). A turn is the
 * hook's own turn id when it reports one; otherwise it lasts until an accepted non-working signal, or until the person
 * submits input while the card is not working (TerminalManager's input generation). A permission decision takes a
 * point only when no current turn is known for the card (a CLI without a turn-start hook, or a turn the person moved
 * past), bounded the same way; inside the current turn it waits (bounded) for that turn's point and never takes a
 * second one. A failed or cancelled attempt is not retried within the same turn (a later
 * retry would snapshot the turn's own edits as if they came before it). A CLI without a turn-end hook keeps its card
 * "working": a turn-start event without a turn id is a new turn when input was submitted since the current turn's point.
 * The capture belongs to its turn, not to the barrier that started it: a newer signal of the same turn ends the first
 * barrier's wait (RuntimeGateway supersedes it) and waits for the same capture. The capture is cancelled once no
 * barrier waits for it any more, one barrier after it started, or when its turn ends or is replaced.
 */
export function createCheckpointTurnBarrier(dependencies: CheckpointTurnBarrierDependencies) {
  const turns = new Map<string, Turn>();
  const warn = dependencies.warn ?? ((message: string, detail: string) => console.warn(message, detail));
  const barrierMs = dependencies.barrierMs ?? CHECKPOINT_BARRIER_MS;

  const startTurn = (id: string, turnId: string | null, signal?: AbortSignal, turnStart = false): Promise<void> => {
    const terminals = dependencies.terminals();
    const row = terminals?.getMetadata(id);
    if (!terminals || !row || row.exitCode !== null || (row.profile !== "auto" && row.profile !== "yolo")) return Promise.resolve();
    if (!terminals.canCaptureCheckpoint(id)) return Promise.resolve();
    const known = turns.get(id);
    const submitted = terminals.submittedInputs(id);
    // The host's freshness check decides first: a reported turn id never revives a turn the person moved past.
    const newPrompt = turnStart && !turnId && known !== undefined && submitted > known.submitted;
    if (known && known.current() && !newPrompt && (!turnId || !known.turnId || known.turnId === turnId)) return waitFor(known, signal);
    if (known) cancel(known);
    const turn: Turn = { pending: Promise.resolve(), turnId, current: terminals.providerSignalGuard(id), submitted, capture: new AbortController(), waiting: 0 };
    // Never longer than one barrier from its start, however many signals of the turn wait for it.
    const deadline = setTimeout(() => turn.capture.abort(new Error("Rollback point timed out.")), barrierMs);
    deadline.unref?.();
    turn.pending = dependencies.checkpoints.capture(id, row.cwd, turn.capture.signal).catch((error: unknown) => {
      warn("Rollback point unavailable", dependencies.redact(String(error)));
    }).finally(() => clearTimeout(deadline));
    turns.set(id, turn);
    return waitFor(turn, signal);
  };
  const cancel = (turn: Turn): void => turn.capture.abort(new Error("The agent turn ended before its rollback point was taken."));
  /**
   * One barrier's wait for its turn's point, until the point settles or `signal` aborts. A capture no barrier waits for
   * any more is cancelled, after the current I/O callback: a newer signal of the same turn, which superseded this
   * barrier, takes over the wait first.
   */
  const waitFor = (turn: Turn, signal?: AbortSignal): Promise<void> => {
    if (!signal) return turn.pending;
    turn.waiting++;
    return new Promise<void>((resolve) => {
      let open = true;
      const done = (): void => {
        if (!open) return;
        open = false;
        signal.removeEventListener("abort", done);
        turn.waiting--;
        if (signal.aborted) setImmediate(() => { if (turn.waiting === 0) turn.capture.abort(new Error("Rollback point timed out.")); });
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
      void turn.pending.then(done);
    });
  };

  return {
    /** RuntimeGateway.lifecycleGuard: the host's freshness check for a held turn start. */
    lifecycleGuard(id: string): () => boolean {
      return dependencies.terminals()?.providerSignalGuard(id) ?? (() => false);
    },
    /** RuntimeGateway.beforeLifecycle: false when the turn went stale while its rollback point was taken. */
    async beforeLifecycle(id: string, signal: { turnId?: string | null; event?: string }, cancellation: AbortSignal): Promise<boolean> {
      const terminals = dependencies.terminals();
      if (!terminals) return false;
      const current = terminals.providerSignalGuard(id);
      if (!current()) return false;
      await startTurn(id, signal.turnId ?? null, cancellation, isTurnStart(signal.event ?? ""));
      return current();
    },
    /** An accepted lifecycle signal: anything but working or a pending approval ends the turn. */
    onSignal(id: string, state: string): void {
      if (state === "working" || state === "needs_approval") return;
      const known = turns.get(id);
      if (known) cancel(known);
      turns.delete(id);
    },
    /**
     * Before a permission decision: a reason (to deny with) when a restore holds the card or its turn changed while a
     * rollback point was taken; null to go on to the decision.
     */
    async beforePermission(id: string, signal?: AbortSignal): Promise<string | null> {
      const terminals = dependencies.terminals();
      if (terminals?.isCheckpointRestoreActive(id)) return "Workspace rollback point restoration is in progress.";
      const current = terminals?.providerSignalGuard(id);
      const known = turns.get(id);
      const bound = new AbortController();
      const stop = (): void => bound.abort(signal?.reason ?? new Error("Rollback point timed out."));
      const timer = setTimeout(stop, barrierMs);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        // Inside the current turn: wait (bounded) for its point if it is still being taken; a settled one, even a
        // failed one, is not taken again. A stale or missing turn takes its point now.
        if (known && known.current()) {
          await Promise.race([known.pending, new Promise<void>((resolve) => bound.signal.addEventListener("abort", () => resolve(), { once: true }))]);
        } else await startTurn(id, null, bound.signal);
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
      if (!current?.() || terminals?.isCheckpointRestoreActive(id)) return "The agent turn changed while preparing its rollback point.";
      return null;
    },
    forget(id: string): void {
      const known = turns.get(id);
      if (known) cancel(known);
      turns.delete(id);
    }
  };
}
