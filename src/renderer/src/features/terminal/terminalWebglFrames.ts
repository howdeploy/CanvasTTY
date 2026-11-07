/** Draw immediately before a transition snapshot; ordinary frames need no preserved drawing buffer. */
export function drawTerminalWebglSnapshot(addon: unknown, rows: number): boolean {
  const renderer = (addon as { _renderer?: {
    _gl?: Pick<WebGL2RenderingContext, "clearColor" | "clear" | "COLOR_BUFFER_BIT">;
    renderRows(start: number, end: number): void;
  } } | null)?._renderer;
  const gl = renderer?._gl;
  if (!renderer || typeof renderer.renderRows !== "function"
    || !gl || typeof gl.clearColor !== "function" || typeof gl.clear !== "function"
    || typeof gl.COLOR_BUFFER_BIT !== "number") return false;
  // The previous frame may still be in this buffer: transparent glyphs must not blend with it twice.
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  renderer.renderRows(0, rows - 1);
  return true;
}
