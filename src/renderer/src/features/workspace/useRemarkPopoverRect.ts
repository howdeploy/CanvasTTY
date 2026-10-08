import type { RefObject } from "react";
import type { Point, SessionBounds } from "../../../../shared/contracts";
import { canvasScreenRect } from "./canvasStacking";
import { useCameraSelector, type CameraStore } from "./cameraStore";

export function useRemarkPopoverRect(
  camera: CameraStore,
  material: SessionBounds | null,
  viewport: RefObject<HTMLElement | null>,
  uiScale: number
): SessionBounds | null {
  const current = useCameraSelector(camera, (snapshot) => material ? snapshot : null);
  return material && current ? remarkPopoverRect(
    canvasScreenRect(material, current),
    viewport.current?.getBoundingClientRect() ?? null,
    uiScale
  ) : null;
}

function remarkPopoverRect(card: SessionBounds, viewportBounds: DOMRect | null, uiScale: number): SessionBounds {
  const width = 360 * uiScale;
  const height = 300 * uiScale;
  const viewportWidth = viewportBounds?.width ?? 1360;
  const viewportHeight = viewportBounds?.height ?? 820;
  const gap = 12;
  const inset = 12;
  const clampX = (x: number): number => Math.min(Math.max(inset, x), Math.max(inset, viewportWidth - width - inset));
  const clampY = (y: number): number => Math.min(Math.max(inset, y), Math.max(inset, viewportHeight - height - inset));
  const right = card.position.x + card.size.width;
  const bottom = card.position.y + card.size.height;
  const candidates: Point[] = [
    { x: card.position.x, y: bottom + gap },
    { x: right + gap, y: card.position.y },
    { x: card.position.x - gap - width, y: card.position.y },
    { x: card.position.x, y: card.position.y - gap - height }
  ];
  const fits = candidates.find((candidate) => candidate.x >= inset && candidate.y >= inset
    && candidate.x + width <= viewportWidth - inset && candidate.y + height <= viewportHeight - inset);
  const chosen = fits ?? candidates[0];
  return { position: { x: clampX(chosen.x), y: clampY(chosen.y) }, size: { width, height } };
}
