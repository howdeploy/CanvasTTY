import type { CanvasTTYApi, TerminalDataEvent } from "../../../../shared/contracts.ts";

/** Subscribe before reading history, then discard the overlap with batched live output. */
export function attachTerminalOutput(
  api: Pick<CanvasTTYApi["terminal"], "onData" | "readBuffer">,
  id: string,
  write: (data: string) => void,
  onError: (error: unknown) => void
): () => void {
  let disposed = false;
  let outputOffset: number | undefined;
  const queuedLiveOutput: TerminalDataEvent[] = [];
  const writeLive = (event: TerminalDataEvent): void => {
    const start = event.outputOffset - event.data.length;
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
