import type { Point, RadialLauncherItemId } from "../../../../shared/contracts";

export const RADIAL_LAUNCHER_RADIUS = 126;
export const RADIAL_LAUNCHER_DEAD_ZONE = 28;

export function radialLauncherLayout(anchor: Point, viewport: { width: number; height: number }, uiScale: number): { anchor: Point; radius: number; scale: number } {
  // Include the expanded action, its focus ring and wrapped label, not just the radius.
  const scale = Math.max(.1, Math.min(uiScale, (viewport.width - 16) / 360, (viewport.height - 16) / 360));
  const margin = 180 * scale + 8;
  return {
    anchor: { x: Math.max(margin, Math.min(viewport.width - margin, anchor.x)), y: Math.max(margin, Math.min(viewport.height - margin, anchor.y)) },
    radius: RADIAL_LAUNCHER_RADIUS * scale,
    scale
  };
}

export function radialItemOffset(index: number, count: number, radius = RADIAL_LAUNCHER_RADIUS): Point {
  if (count <= 0) return { x: 0, y: 0 };
  const angle = -Math.PI / 2 + index * (Math.PI * 2 / count);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function radialItemAtPointer(
  anchor: Point,
  pointer: Point,
  count: number,
  deadZone = RADIAL_LAUNCHER_DEAD_ZONE
): number | null {
  if (count <= 0) return null;
  const dx = pointer.x - anchor.x;
  const dy = pointer.y - anchor.y;
  if (Math.hypot(dx, dy) < deadZone) return null;
  const pointerAngle = normalizeAngle(Math.atan2(dy, dx) + Math.PI / 2);
  return Math.round(pointerAngle / (Math.PI * 2 / count)) % count;
}

export function setRadialLauncherItemEnabled(
  current: readonly RadialLauncherItemId[],
  item: RadialLauncherItemId,
  enabled: boolean
): RadialLauncherItemId[] {
  if (!enabled) {
    const next = current.filter((candidate) => candidate !== item);
    return next.length > 0 ? next : [...current];
  }
  if (current.includes(item) || current.length >= 8) return [...current];
  return [...current, item];
}

function normalizeAngle(value: number): number {
  const fullCircle = Math.PI * 2;
  return ((value % fullCircle) + fullCircle) % fullCircle;
}
