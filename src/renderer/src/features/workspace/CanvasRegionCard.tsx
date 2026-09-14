import { useEffect, useRef, useState } from "react";
import type { CanvasRegion, Point, SessionBounds } from "../../../../shared/contracts";
import { constrainCanvasRegionBounds } from "./canvasRegions";
import { snapMove, snapResize, type ResizeDirection } from "./snap";

interface CanvasRegionCardProps {
  region: CanvasRegion;
  zoom: number;
  snapEnabled: boolean;
  snapTargets: readonly SessionBounds[];
  onBoundsChange(id: string, bounds: SessionBounds, interaction: "move" | "resize"): void;
  onMovePreview(id: string, bounds: SessionBounds | null): void;
}

interface DragState {
  pointerId: number;
  startClient: Point;
  startBounds: SessionBounds;
}

interface ResizeState extends DragState {
  direction: ResizeDirection;
}

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

export function CanvasRegionCard({
  region,
  zoom,
  snapEnabled,
  snapTargets,
  onBoundsChange,
  onMovePreview
}: CanvasRegionCardProps): React.JSX.Element {
  const initialBounds = { position: region.position, size: region.size };
  const [bounds, setBounds] = useState<SessionBounds>(initialBounds);
  const liveBounds = useRef(initialBounds);
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);

  useEffect(() => {
    const next = { position: region.position, size: region.size };
    liveBounds.current = next;
    setBounds(next);
  }, [region.position, region.size]);

  const applyBounds = (next: SessionBounds): void => {
    liveBounds.current = next;
    setBounds(next);
  };

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current
    };
    onMovePreview(region.id, liveBounds.current);
  };

  const drag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // A buttonless move is a hover, not a drag.
    if (event.buttons === 0) return;
    const rawPosition = {
      x: state.startBounds.position.x + (event.clientX - state.startClient.x) / zoom,
      y: state.startBounds.position.y + (event.clientY - state.startClient.y) / zoom
    };
    const next = {
      position: snapEnabled ? snapMove(rawPosition, state.startBounds.size, snapTargets) : rawPosition,
      size: state.startBounds.size
    };
    applyBounds(next);
    onMovePreview(region.id, next);
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragState.current = null;
    onBoundsChange(region.id, liveBounds.current, "move");
    onMovePreview(region.id, null);
  };

  // Cancelling drops the local bounds and the shared preview; the committed region props
  // then re-seed `liveBounds`, so the next gesture starts from the persisted position.
  const cancelDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    onMovePreview(region.id, null);
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeState.current = {
      pointerId: event.pointerId,
      direction,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current
    };
  };

  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // A buttonless move is a hover, not a resize.
    if (event.buttons === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - state.startClient.x) / zoom;
    const deltaY = (event.clientY - state.startClient.y) / zoom;
    const raw = constrainCanvasRegionBounds({
      position: {
        x: state.startBounds.position.x + (state.direction.includes("w") ? deltaX : 0),
        y: state.startBounds.position.y + (state.direction.includes("n") ? deltaY : 0)
      },
      size: {
        width: state.startBounds.size.width
          + (state.direction.includes("e") ? deltaX : 0)
          - (state.direction.includes("w") ? deltaX : 0),
        height: state.startBounds.size.height
          + (state.direction.includes("s") ? deltaY : 0)
          - (state.direction.includes("n") ? deltaY : 0)
      }
    }, state.direction);
    applyBounds(snapEnabled ? snapResize(raw, state.direction, snapTargets) : raw);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = null;
    onBoundsChange(region.id, liveBounds.current, "resize");
  };

  // Resize previews nothing outside the card, so the region props alone cannot pull the
  // local bounds back: restore them from the last persisted bounds explicitly.
  const cancelResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    resizeState.current = null;
    applyBounds({ position: region.position, size: region.size });
  };

  return (
    <article
      className="canvas-region"
      data-canvas-region-id={region.id}
      style={{
        width: bounds.size.width,
        height: bounds.size.height,
        transform: `translate(${bounds.position.x}px, ${bounds.position.y}px)`,
        "--canvas-region-color": region.color
      } as React.CSSProperties}
    >
      <button
        className="canvas-region__title"
        type="button"
        data-interactive="true"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
      >{region.title}</button>
      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`canvas-region__resize-handle canvas-region__resize-handle--${direction}`}
          data-interactive="true"
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, direction)}
          onPointerMove={resize}
          onPointerUp={endResize}
          onPointerCancel={cancelResize}
          onLostPointerCapture={cancelResize}
        />
      ))}
    </article>
  );
}
