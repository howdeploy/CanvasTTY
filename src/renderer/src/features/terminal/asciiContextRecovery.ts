/** A canvas cannot switch from WebGL to 2D after context loss; rebuild its GPU resources on restoration. */
export function attachAsciiContextRecovery(
  canvas: Pick<OffscreenCanvas, "addEventListener" | "removeEventListener">,
  suspend: () => void,
  restore: () => void
): () => void {
  let lost = false;
  const onLost = (event: Event): void => {
    event.preventDefault();
    if (lost) return;
    lost = true;
    suspend();
  };
  const onRestored = (): void => {
    if (!lost) return;
    lost = false;
    restore();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return () => {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
  };
}
