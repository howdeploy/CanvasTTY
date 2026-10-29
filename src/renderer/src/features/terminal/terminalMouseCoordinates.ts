interface ClientPoint {
  x: number;
  y: number;
}

interface VisualRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface LayoutSize {
  width: number;
  height: number;
}

const MOUSE_EVENT_TYPES = [
  "mousedown",
  "mousemove",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu"
] as const;

export function attachTerminalScrollbarCoordinateAdapter(terminal: { element?: HTMLElement }): () => void {
  const element = terminal.element;
  const scrollbar = (terminal as typeof terminal & {
    _core?: { _viewport?: { _scrollableElement: { _verticalScrollbar: {
      _sliderPointerPosition(event: { pageY: number }): number;
    } } } };
  })._core?._viewport?._scrollableElement._verticalScrollbar;
  if (!element || !scrollbar) return () => undefined;

  // xterm 6's scrollbar is outside .xterm-screen and uses native PointerEvents.
  // Normalize only its drag distance, preserving pointer capture and canvas input.
  const original = scrollbar._sliderPointerPosition;
  scrollbar._sliderPointerPosition = (event) => {
    const height = element.getBoundingClientRect().height;
    const scale = height / element.offsetHeight;
    return original.call(scrollbar, event) / (Number.isFinite(scale) && scale > 0 ? scale : 1);
  };
  return () => { scrollbar._sliderPointerPosition = original; };
}

export function remapTerminalMouseCoordinates(
  point: ClientPoint,
  rect: VisualRect,
  layout: LayoutSize
): ClientPoint {
  if (layout.width <= 0 || layout.height <= 0 || rect.width <= 0 || rect.height <= 0) return point;
  const scaleX = rect.width / layout.width;
  const scaleY = rect.height / layout.height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return point;

  return {
    x: rect.left + (point.x - rect.left) / scaleX,
    y: rect.top + (point.y - rect.top) / scaleY
  };
}

export function attachTerminalMouseCoordinateAdapter(
  screen: HTMLElement,
  getWheelMultiplier: () => 1 | -1 = () => 1,
  shouldRouteWheelToCanvas: () => boolean = () => false,
  shouldForceSelectionWithShift: () => boolean = () => false
): () => void {
  const ownerDocument = screen.ownerDocument;
  const viewport = screen.parentElement ?? screen;
  const wheelTarget = screen.closest?.<HTMLElement>(".terminal-card") ?? viewport;
  const syntheticEvents = new WeakSet<Event>();
  let dragging = false;
  // Mounted under the pointer: no mouseenter comes until it leaves.
  let hovered = screen.matches(":hover");

  const handleMouseEvent = (event: MouseEvent): void => {
    if (syntheticEvents.has(event)) return;
    const target = event.target;
    if (!target) return;
    const targetInScreen = target instanceof Node && screen.contains(target);
    if (event.type === "mousedown" && event.button === 0 && targetInScreen) dragging = true;
    if (!targetInScreen && !dragging) return;

    const rect = screen.getBoundingClientRect();
    const adjusted = remapTerminalMouseCoordinates(
      { x: event.clientX, y: event.clientY },
      rect,
      { width: screen.offsetWidth, height: screen.offsetHeight }
    );
    const needsRemap = Math.abs(adjusted.x - event.clientX) > 0.01
      || Math.abs(adjusted.y - event.clientY) > 0.01;
    // On macOS xterm forces selection with Option, which is the canvas pan key.
    // Translate Shift only for xterm mouse events; pointer navigation stays intact.
    const forceSelection = shouldForceSelectionWithShift() && event.shiftKey && event.button === 0;
    if (!needsRemap && !forceSelection) {
      if (event.type === "mouseup") endDrag();
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    const remapped = cloneMouseEvent(event, adjusted, forceSelection);
    syntheticEvents.add(remapped);
    target.dispatchEvent(remapped);
    if (event.type === "mouseup") endDrag();
  };
  const endDrag = (): void => {
    dragging = false;
    updateListening();
  };

  const handleWheelEvent = (event: WheelEvent): void => {
    if (syntheticEvents.has(event)) return;
    const target = event.target;
    if (!(target instanceof Node) || !wheelTarget.contains(target)) return;
    if (shouldRouteWheelToCanvas()) return;
    const targetInViewport = viewport.contains(target);
    const resizeHandle = !targetInViewport && (target as Element).closest?.(".terminal-card__resize-handle");
    const viewportRect = resizeHandle ? viewport.getBoundingClientRect() : null;
    // Resize handles overlap the scrollbar; only wheel input should pass through to xterm.
    const forwardFromResize = viewportRect !== null
      && event.clientX >= viewportRect.left && event.clientX < viewportRect.left + viewportRect.width
      && event.clientY >= viewportRect.top && event.clientY < viewportRect.top + viewportRect.height;
    if (!targetInViewport && !forwardFromResize) return;
    const rect = screen.getBoundingClientRect();
    const adjusted = remapTerminalMouseCoordinates(
      { x: event.clientX, y: event.clientY },
      rect,
      { width: screen.offsetWidth, height: screen.offsetHeight }
    );
    const needsRemap = Math.abs(adjusted.x - event.clientX) > 0.01
      || Math.abs(adjusted.y - event.clientY) > 0.01;
    const wheelMultiplier = getWheelMultiplier();
    if (!needsRemap && wheelMultiplier === 1 && !forwardFromResize) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const remapped = cloneWheelEvent(event, adjusted, wheelMultiplier);
    syntheticEvents.add(remapped);
    (forwardFromResize ? viewport : target).dispatchEvent(remapped);
  };

  // The document-level capture listeners run before xterm's own, but only while the pointer is over this card or
  // drags from it: with many cards open, a mouse move elsewhere costs nothing here.
  let listening = false;
  const updateListening = (): void => {
    const wanted = hovered || dragging;
    if (wanted === listening) return;
    listening = wanted;
    for (const type of MOUSE_EVENT_TYPES) {
      if (wanted) ownerDocument.addEventListener(type, handleMouseEvent, true);
      else ownerDocument.removeEventListener(type, handleMouseEvent, true);
    }
  };
  const handleEnter = (): void => {
    hovered = true;
    updateListening();
  };
  const handleLeave = (): void => {
    hovered = false;
    updateListening();
  };

  screen.addEventListener("mouseenter", handleEnter);
  screen.addEventListener("mouseleave", handleLeave);
  // Capture at the card so overlapping resize handles cannot swallow the scrollbar's wheel input.
  wheelTarget.addEventListener("wheel", handleWheelEvent, { capture: true, passive: false });
  updateListening();

  return () => {
    hovered = false;
    dragging = false;
    updateListening();
    screen.removeEventListener("mouseenter", handleEnter);
    screen.removeEventListener("mouseleave", handleLeave);
    wheelTarget.removeEventListener("wheel", handleWheelEvent, true);
  };
}

function cloneMouseEvent(event: MouseEvent, point: ClientPoint, forceSelection = false): MouseEvent {
  return new MouseEvent(event.type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: event.view,
    detail: event.detail,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: point.x,
    clientY: point.y,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey || forceSelection,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget
  });
}

function cloneWheelEvent(event: WheelEvent, point: ClientPoint, multiplier: 1 | -1): WheelEvent {
  const remapped = new WheelEvent(event.type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: event.view,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: point.x,
    clientY: point.y,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget,
    deltaX: event.deltaX * multiplier,
    deltaY: event.deltaY * multiplier,
    deltaZ: event.deltaZ * multiplier,
    deltaMode: event.deltaMode
  });
  // xterm's scrollback reads legacy deltas; mouse-reporting TUIs read deltaY.
  const legacy = event as WheelEvent & { wheelDelta?: number; wheelDeltaX?: number; wheelDeltaY?: number };
  for (const property of ["wheelDelta", "wheelDeltaX", "wheelDeltaY"] as const) {
    if (typeof legacy[property] === "number") {
      Object.defineProperty(remapped, property, { value: legacy[property] * multiplier });
    }
  }
  return remapped;
}
