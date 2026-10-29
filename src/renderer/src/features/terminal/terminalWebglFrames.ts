/** xterm 0.19 blends transparent backgrounds; preserved frames need a clear before each full-grid draw. */
export function clearPreservedWebglFrames(addon: unknown): boolean {
  const renderer = (addon as { _renderer?: {
    _gl?: Pick<WebGL2RenderingContext, "clearColor" | "clear" | "COLOR_BUFFER_BIT">;
    renderRows(start: number, end: number): void;
  } } | null)?._renderer;
  const gl = renderer?._gl;
  if (!renderer || typeof renderer.renderRows !== "function"
    || !gl || typeof gl.clearColor !== "function" || typeof gl.clear !== "function"
    || typeof gl.COLOR_BUFFER_BIT !== "number") return false;
  const render = renderer.renderRows;
  renderer.renderRows = function (start, end): void {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    render.call(this, start, end);
  };
  return true;
}
