import { useEffect, useRef, useState } from "react";
import type { LocaleId, Point, SessionBounds, StickyNote } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { snapMove, snapResize, type ResizeDirection } from "../workspace/snap";
import {
  constrainStickyNoteResize,
  MAX_STICKY_NOTE_SIZE,
  MIN_STICKY_NOTE_SIZE
} from "./stickyNoteBounds";

interface StickyNoteCardProps {
  note: StickyNote;
  locale: LocaleId;
  zoom: number;
  stackIndex: number;
  editRequest: number;
  snapEnabled: boolean;
  snapTargets: readonly SessionBounds[];
  onBoundsChange(id: string, bounds: SessionBounds): void;
  onTextChange(id: string, text: string): void;
  onClose(id: string): void;
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

// Interaction behavior is adapted from @TroopJostle's StickyNoteCard in PR #23.
export function StickyNoteCard({
  note,
  locale,
  zoom,
  stackIndex,
  editRequest,
  snapEnabled,
  snapTargets,
  onBoundsChange,
  onTextChange,
  onClose
}: StickyNoteCardProps): React.JSX.Element {
  const editor = useRef<HTMLTextAreaElement>(null);
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const textSaveTimer = useRef<number | null>(null);
  const persistedText = useRef(note.text);
  const pendingText = useRef(note.text);
  const onTextChangeRef = useRef(onTextChange);
  const initialBounds = { position: note.position, size: note.size };
  const liveBounds = useRef<SessionBounds>(initialBounds);
  const [position, setPosition] = useState(note.position);
  const [size, setSize] = useState(note.size);
  const [text, setText] = useState(note.text);
  onTextChangeRef.current = onTextChange;

  useEffect(() => {
    const bounds = { position: note.position, size: note.size };
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  }, [note.position, note.size]);

  useEffect(() => {
    persistedText.current = note.text;
    pendingText.current = note.text;
    setText(note.text);
  }, [note.text]);

  useEffect(() => {
    if (editRequest <= 0) return;
    const frame = window.requestAnimationFrame(() => {
      const element = editor.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(element.value.length, element.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editRequest]);

  useEffect(() => () => {
    if (textSaveTimer.current !== null) window.clearTimeout(textSaveTimer.current);
    if (pendingText.current !== persistedText.current) {
      onTextChangeRef.current(note.id, pendingText.current);
    }
  }, [note.id]);

  const saveText = (nextText: string): void => {
    if (textSaveTimer.current !== null) window.clearTimeout(textSaveTimer.current);
    textSaveTimer.current = null;
    if (nextText === persistedText.current) return;
    persistedText.current = nextText;
    onTextChangeRef.current(note.id, nextText);
  };

  const changeText = (nextText: string): void => {
    pendingText.current = nextText;
    setText(nextText);
    if (textSaveTimer.current !== null) window.clearTimeout(textSaveTimer.current);
    textSaveTimer.current = window.setTimeout(() => saveText(nextText), 400);
  };

  const applyBounds = (bounds: SessionBounds): void => {
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  };

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea")) return;
    event.preventDefault();
    event.stopPropagation();
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
    applyBounds({
      position: snapEnabled ? snapMove(rawPosition, state.startBounds.size, snapTargets) : rawPosition,
      size: state.startBounds.size
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragState.current = null;
    onBoundsChange(note.id, liveBounds.current);
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
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - state.startClient.x) / zoom;
    const deltaY = (event.clientY - state.startClient.y) / zoom;
    const constrained = constrainStickyNoteResize({
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
    applyBounds(snapEnabled
      ? snapResize(constrained, state.direction, snapTargets, {
          min: MIN_STICKY_NOTE_SIZE,
          max: MAX_STICKY_NOTE_SIZE
        })
      : constrained);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = null;
    onBoundsChange(note.id, liveBounds.current);
  };

  return (
    <article
      className="sticky-note-card"
      data-interactive="true"
      data-sticky-note-id={note.id}
      data-canvas-layer-id={`note:${note.id}`}
      data-wheel-owner="local"
      style={{
        zIndex: stackIndex,
        width: size.width,
        height: size.height,
        transform: `translate(${position.x}px, ${position.y}px)`
      }}
    >
      <header
        className="sticky-note-card__header"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span><UiIcon name="sticky-note" size="1.15em" />{t(locale, "stickyNote")}</span>
        <button
          className="sticky-note-card__close"
          type="button"
          onClick={() => {
            saveText(text);
            onClose(note.id);
          }}
          title={t(locale, "close")}
          aria-label={t(locale, "close")}
        >
          <UiIcon name="close" size="1.23em" />
        </button>
      </header>
      <textarea
        ref={editor}
        className="sticky-note-card__editor"
        value={text}
        maxLength={20_000}
        placeholder={t(locale, "stickyNotePlaceholder")}
        aria-label={t(locale, "stickyNote")}
        onChange={(event) => changeText(event.target.value)}
        onBlur={() => saveText(text)}
      />
      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`}
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, direction)}
          onPointerMove={resize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      ))}
    </article>
  );
}
