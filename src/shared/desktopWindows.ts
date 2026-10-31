export interface DesktopWindowCandidate {
  id: string;
  title: string;
  process: string;
}
export interface DesktopWindowViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/** Native coordinates come from trusted chrome, never from sandboxed plugin code. */
export function validateDesktopViewport(value: unknown): DesktopWindowViewport {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid desktop viewport.");
  const rect = value as Record<string, unknown>;
  for (const key of ["x", "y", "width", "height"] as const) {
    if (
      typeof rect[key] !== "number" ||
      !Number.isFinite(rect[key]) ||
      Math.abs(rect[key]) > 32_768
    )
      throw new Error("Invalid desktop viewport.");
  }
  if (
    (rect.width as number) < 0 ||
    (rect.height as number) < 0 ||
    typeof rect.visible !== "boolean"
  )
    throw new Error("Invalid desktop viewport.");
  return rect as unknown as DesktopWindowViewport;
}
