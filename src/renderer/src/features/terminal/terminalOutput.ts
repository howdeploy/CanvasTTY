import type { CanvasTTYApi, TerminalDataEvent } from "../../../../shared/contracts.ts";
import { createSurfaceGate, type SurfaceGate } from "../workspace/surfaceLifecycle.ts";

/**
 * Bounded one-line marker for output the card never received. The producer's
 * scrollback ring is what makes a replay start after the last offset written
 * here, and that hole must be visible: a trimmed replay stitched straight onto
 * older output reads as gapless and silently lies about what the session said.
 * The message is supplied by the caller so it follows the app locale, like the
 * other in-terminal notices.
 */
function replayGapNotice(missing: number, message: (missing: number) => string): string {
  return `\r\n\x1b[33m${message(missing)}\x1b[0m\r\n`;
}

/** Subscribe before reading history, then discard the overlap with batched live output. */
export function attachTerminalOutput(
  api: Pick<CanvasTTYApi["terminal"], "onData" | "readBuffer">,
  id: string,
  write: (data: string) => void,
  onError: (error: unknown) => void,
  gapNotice: (missing: number) => string
): () => void {
  let disposed = false;
  let outputOffset: number | undefined;
  let liveOnly = false;
  const queuedLiveOutput: TerminalDataEvent[] = [];
  const writeLive = (event: TerminalDataEvent): void => {
    const start = event.outputOffset - event.data.length;
    // A replay longer than the ring starts after the last offset written here.
    // Mark the hole, then write the surviving tail; offsets are absolute, so
    // the tail still lands exactly where the session produced it.
    if (start > outputOffset!) write(replayGapNotice(start - outputOffset!, gapNotice));
    const data = event.data.slice(Math.max(0, outputOffset! - start));
    if (data) write(data);
    outputOffset = Math.max(outputOffset!, event.outputOffset);
  };
  const unsubscribe = api.onData((event) => {
    if (disposed || event.id !== id) return;
    // Without history there is nothing to join against, so the first live
    // event defines where this card's output begins.
    if (outputOffset === undefined && liveOnly) outputOffset = event.outputOffset - event.data.length;
    if (outputOffset === undefined) queuedLiveOutput.push(event);
    else writeLive(event);
  }, id);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    queuedLiveOutput.length = 0;
  };
  void api.readBuffer(id).then((snapshot) => {
    if (disposed) return;
    // Parser state is synthetic metadata; it must never count towards the producer's byte offsets.
    if (snapshot.restorePrefix) write(snapshot.restorePrefix);
    if (snapshot.buffer) write(snapshot.buffer);
    outputOffset = snapshot.outputOffset;
    for (const event of queuedLiveOutput) writeLive(event);
    queuedLiveOutput.length = 0;
  }).catch((error: unknown) => {
    if (disposed) return;
    // Missing history must not also cost the live stream: report the failure,
    // keep the subscription and continue from the oldest output still queued.
    onError(error);
    if (disposed) return;
    liveOnly = true;
    const first = queuedLiveOutput[0];
    if (first) outputOffset = first.outputOffset - first.data.length;
    for (const event of queuedLiveOutput) writeLive(event);
    queuedLiveOutput.length = 0;
  });
  return dispose;
}

/**
 * The terminal card's side of the surface lifecycle: a live card receives terminalData, a suspended one
 * does not. The main process keeps appending to scrollback while a card is suspended and replays the
 * missed suffix, once, when it turns live again (TerminalManager.setVisible); attachTerminalOutput drops
 * anything the card already wrote by absolute offset, so nothing is lost or written twice.
 */
export function createTerminalDeliveryGate(
  api: Pick<CanvasTTYApi["terminal"], "setVisible">,
  id: string
): SurfaceGate {
  return createSurfaceGate((live) => api.setVisible(id, live));
}
