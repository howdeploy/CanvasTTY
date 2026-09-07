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
  shouldRouteWheelToCanvas: () => boolean = () => false
): () => void {
  const ownerDocument = screen.ownerDocument;
  const syntheticEvents = new WeakSet<Event>();
  let dragging = false;

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
    if (!needsRemap) {
      if (event.type === "mouseup") dragging = false;
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    const remapped = cloneMouseEvent(event, adjusted);
    syntheticEvents.add(remapped);
    target.dispatchEvent(remapped);
    if (event.type === "mouseup") dragging = false;
  };

  const handleWheelEvent = (event: WheelEvent): void => {
    if (syntheticEvents.has(event)) return;
    const target = event.target;
    if (!(target instanceof Node) || !screen.contains(target)) return;
    if (shouldRouteWheelToCanvas()) return;
    const rect = screen.getBoundingClientRect();
    const adjusted = remapTerminalMouseCoordinates(
      { x: event.clientX, y: event.clientY },
      rect,
      { width: screen.offsetWidth, height: screen.offsetHeight }
    );
    const needsRemap = Math.abs(adjusted.x - event.clientX) > 0.01
      || Math.abs(adjusted.y - event.clientY) > 0.01;
    const wheelMultiplier = getWheelMultiplier();
    if (!needsRemap && wheelMultiplier === 1) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const remapped = cloneWheelEvent(event, adjusted, wheelMultiplier);
    syntheticEvents.add(remapped);
    target.dispatchEvent(remapped);
  };

  for (const type of MOUSE_EVENT_TYPES) ownerDocument.addEventListener(type, handleMouseEvent, true);
  screen.addEventListener("wheel", handleWheelEvent, { capture: true, passive: false });

  return () => {
    for (const type of MOUSE_EVENT_TYPES) ownerDocument.removeEventListener(type, handleMouseEvent, true);
    screen.removeEventListener("wheel", handleWheelEvent, true);
  };
}

function cloneMouseEvent(event: MouseEvent, point: ClientPoint): MouseEvent {
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
    altKey: event.altKey,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget
  });
}

function cloneWheelEvent(event: WheelEvent, point: ClientPoint, multiplier: 1 | -1): WheelEvent {
  return new WheelEvent(event.type, {
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
}
