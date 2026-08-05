import { useEffect, useRef, useState } from "react";
import type {
  LocaleId,
  Point,
  SessionBounds,
  Size
} from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { normalizeUrl } from "../../lib/url";
import {
  constrainResize,
  snapMove,
  snapResize
} from "../workspace/snap";
import type { ResizeDirection } from "../workspace/snap";

export interface BrowserCardState {
  id: string;
  url: string;
  position: Point;
  size: Size;
}

interface BrowserCardProps {
  card: BrowserCardState;
  locale: LocaleId;
  zoom: number;
  snapEnabled: boolean;
  snapTargets: readonly SessionBounds[];
  onBoundsChange(id: string, bounds: SessionBounds): void;
  onUrlChange(id: string, url: string): void;
  onDispose(id: string): void;
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

export function BrowserCard({
  card,
  locale,
  zoom,
  snapEnabled,
  snapTargets,
  onBoundsChange,
  onUrlChange,
  onDispose
}: BrowserCardProps): React.JSX.Element {
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const [position, setPosition] = useState(card.position);
  const [size, setSize] = useState(card.size);
  const [draft, setDraft] = useState(card.url);
  const liveBounds = useRef<SessionBounds>({ position: card.position, size: card.size });

  useEffect(() => {
    const bounds = { position: card.position, size: card.size };
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  }, [card.position, card.size]);

  useEffect(() => {
    setDraft(card.url);
  }, [card.url]);

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current
    };
  };

  const drag = (event: React.PointerEvent<HTMLElement>): void => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const rawPosition = {
      x: state.startBounds.position.x + (event.clientX - state.startClient.x) / zoom,
      y: state.startBounds.position.y + (event.clientY - state.startClient.y) / zoom
    };
    const nextPosition = snapEnabled
      ? snapMove(rawPosition, state.startBounds.size, snapTargets)
      : rawPosition;
    applyLiveBounds({ position: nextPosition, size: state.startBounds.size });
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (!dragState.current || dragState.current.pointerId !== event.pointerId) return;
    dragState.current = null;
    onBoundsChange(card.id, liveBounds.current);
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
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

  const resizeCard = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - state.startClient.x) / zoom;
    const deltaY = (event.clientY - state.startClient.y) / zoom;
    const raw: SessionBounds = {
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
    };
    const constrained = constrainResize(raw, state.direction);
    applyLiveBounds(snapEnabled ? snapResize(constrained, state.direction, snapTargets) : constrained);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizeState.current || resizeState.current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    resizeState.current = null;
    onBoundsChange(card.id, liveBounds.current);
  };

  const applyLiveBounds = (bounds: SessionBounds): void => {
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  };

  const submitUrl = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const next = normalizeUrl(draft);
    if (next) onUrlChange(card.id, next);
    else setDraft(card.url);
  };

  return (
    <article
      className="terminal-card browser-card"
      data-interactive="true"
      data-wheel-owner="local"
      tabIndex={-1}
      style={{
        width: size.width,
        height: size.height,
        transform: `translate(${position.x}px, ${position.y}px)`
      }}
    >
      <header
        className="terminal-card__header"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="terminal-card__identity">
          <UiIcon name="globe" size={16} />
          <form className="browser-card__address" onSubmit={submitUrl}>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t(locale, "browserAddress")}
              aria-label={t(locale, "browserAddress")}
              spellCheck={false}
            />
          </form>
        </div>
        <div className="terminal-card__actions">
          <button className="terminal-card__action terminal-card__action--close" type="button" onClick={() => onDispose(card.id)} title={t(locale, "close")} aria-label={t(locale, "close")}><UiIcon name="close" size={16} /></button>
        </div>
      </header>
      {card.url ? (
        <webview className="browser-card__view" src={card.url} partition="persist:canvastty-browser" />
      ) : (
        <div className="browser-card__empty">{t(locale, "browserEmpty")}</div>
      )}
      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`}
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, direction)}
          onPointerMove={resizeCard}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      ))}
    </article>
  );
}
