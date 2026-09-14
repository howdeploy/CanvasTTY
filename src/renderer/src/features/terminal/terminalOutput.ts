import type { CanvasTTYApi, TerminalDataEvent } from "../../../../shared/contracts.ts";

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
    if (outputOffset === undefined) queuedLiveOutput.push(event);
    else writeLive(event);
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    queuedLiveOutput.length = 0;
  };
  void api.readBuffer(id).then((snapshot) => {
    if (disposed) return;
    if (snapshot.buffer) write(snapshot.buffer);
    outputOffset = snapshot.outputOffset;
    for (const event of queuedLiveOutput) writeLive(event);
    queuedLiveOutput.length = 0;
  }).catch((error: unknown) => {
    if (disposed) return;
    dispose();
    onError(error);
  });
  return dispose;
}
