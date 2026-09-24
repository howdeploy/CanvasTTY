import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { AppSettings, CameraState, Point, SessionBounds } from "../../../../shared/contracts";
import {
  canvasNavigationMouseButtonFromDomButton,
  isCanvasNavigationBindingActive
} from "../../../../shared/canvasNavigation";
import {
  CANVAS_CARD_CONTROL_SELECTOR,
  advanceCanvasGroupDrag,
  beginCanvasGroupDrag,
  canvasGroupDragDelta,
  canvasMarqueeRect,
  canvasPressIntent,
  canvasWorldRect,
  pastCanvasDragThreshold,
  type CanvasMarqueeMode,
  type CanvasGroupDragState,
  type CanvasMarqueeRect
} from "./canvasSelectionGesture";
import { EDGE_PAN_SPEEDS, edgePanVelocity } from "./edgePan";

interface PanState {
  pointerId: number;
  startClient: Point;
  startCamera: CameraState;
  moved: boolean;
  suppressClick: boolean;
}

interface NativePanState {
  tabId: string;
  startClient: Point;
  startCamera: CameraState;
}

interface MarqueeState {
  pointerId: number;
  mode: CanvasMarqueeMode;
  start: Point;
  current: Point;
  moved: boolean;
}

interface UseCanvasPointerNavigationOptions {
  viewport: RefObject<HTMLDivElement | null>;
  settings: AppSettings;
  cameraRef: MutableRefObject<CameraState>;
  canvasOverrideActiveRef: RefObject<boolean>;
  commitCamera(camera: CameraState): void;
  /** Canvas layer ids currently marquee-selected; a drag on one of them moves the group. */
  selectedLayerIds: ReadonlySet<string>;
  /** Replaces the marquee group with the layers intersecting the world rectangle; null clears it. */
  onMarqueeSelection(bounds: SessionBounds | null, mode?: CanvasMarqueeMode): void;
  /** Freezes the commit basis of a travelled group move; called once, when the press activates. */
  onGroupDragStart(layerId: string): void;
  /** Commits a group move: the pointer offset in world units, applied from the pressed layer. */
  onGroupDrag(layerId: string, delta: Point): void;
}

export interface CanvasPointerNavigationController {
  panning: boolean;
  marquee: CanvasMarqueeRect | null;
  groupNudge: Point | null;
  handlePointerDownCapture(event: React.PointerEvent<HTMLDivElement>): boolean;
  handleClickCapture(event: React.MouseEvent<HTMLDivElement>): boolean;
  handleAuxClickCapture(event: React.MouseEvent<HTMLDivElement>): boolean;
  handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void;
  handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void;
  handlePointerMoveCapture(event: React.PointerEvent<HTMLDivElement>): void;
  handlePointerEnd(event: React.PointerEvent<HTMLDivElement>): void;
  handlePointerEndCapture(event: React.PointerEvent<HTMLDivElement>): void;
  /** Aborts the in-flight pan, marquee, or group move without committing anything. */
  handlePointerCancel(): void;
  handlePointerLeave(): void;
}

export function useCanvasPointerNavigation({
  viewport,
  settings,
  cameraRef,
  canvasOverrideActiveRef,
  commitCamera,
  selectedLayerIds,
  onMarqueeSelection,
  onGroupDragStart,
  onGroupDrag
}: UseCanvasPointerNavigationOptions): CanvasPointerNavigationController {
  const panState = useRef<PanState | null>(null);
  const nativePanState = useRef<NativePanState | null>(null);
  const suppressClick = useRef(false);
  const [panning, setPanning] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selectedLayerIdsRef = useRef(selectedLayerIds);
  selectedLayerIdsRef.current = selectedLayerIds;
  const onMarqueeSelectionRef = useRef(onMarqueeSelection);
  onMarqueeSelectionRef.current = onMarqueeSelection;
  const onGroupDragStartRef = useRef(onGroupDragStart);
  onGroupDragStartRef.current = onGroupDragStart;
  const onGroupDragRef = useRef(onGroupDrag);
  onGroupDragRef.current = onGroupDrag;
  const marqueeState = useRef<MarqueeState | null>(null);
  const [marquee, setMarquee] = useState<CanvasMarqueeRect | null>(null);
  const groupDrag = useRef<CanvasGroupDragState | null>(null);
  const [groupNudge, setGroupNudge] = useState<Point | null>(null);
  const edgePointer = useRef<Point | null>(null);
  const edgeFrame = useRef<number | null>(null);
  const edgeLastTime = useRef(0);

  const panTo = useCallback((clientX: number, clientY: number): void => {
    const state = panState.current;
    if (!state) return;
    if (Math.abs(clientX - state.startClient.x) > 3 || Math.abs(clientY - state.startClient.y) > 3) {
      state.moved = true;
    }
    commitCamera({
      ...state.startCamera,
      x: state.startCamera.x + clientX - state.startClient.x,
      y: state.startCamera.y + clientY - state.startClient.y
    });
  }, [commitCamera]);

  const finishPan = useCallback((): void => {
    const state = panState.current;
    if (!state) return;
    if (state.moved || state.suppressClick) {
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    }
    const element = viewport.current;
    if (element?.hasPointerCapture(state.pointerId)) element.releasePointerCapture(state.pointerId);
    panState.current = null;
    window.canvasTTY.canvasNavigation.setPointerGestureActive(false);
    setPanning(false);
  }, [viewport]);

  /**
   * Aborts every in-flight gesture without committing: nothing is written back, so a
   * cancelled pan, marquee, or group move leaves the camera, the selection, and the
   * committed bounds untouched. Shared by cancel events and window blur.
   */
  const cancelPointerGesture = useCallback((): void => {
    const pointerId = panState.current?.pointerId
      ?? marqueeState.current?.pointerId
      ?? groupDrag.current?.pointerId;
    const element = viewport.current;
    if (pointerId !== undefined && element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    if (panState.current) window.canvasTTY.canvasNavigation.setPointerGestureActive(false);
    panState.current = null;
    nativePanState.current = null;
    marqueeState.current = null;
    setMarquee(null);
    groupDrag.current = null;
    setGroupNudge(null);
    setPanning(false);
  }, [viewport]);

  const localPoint = useCallback((clientX: number, clientY: number): Point | null => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return null;
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  }, [viewport]);

  const startMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>, mode: CanvasMarqueeMode): boolean => {
    const local = localPoint(event.clientX, event.clientY);
    if (!local) return false;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    marqueeState.current = { pointerId: event.pointerId, mode, start: local, current: local, moved: false };
    setMarquee(canvasMarqueeRect(local, local));
    return true;
  }, [localPoint]);

  const updateMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const state = marqueeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const local = localPoint(event.clientX, event.clientY);
    if (!local) return;
    const moved = state.moved || pastCanvasDragThreshold(state.start, local);
    marqueeState.current = { ...state, current: local, moved };
    setMarquee(canvasMarqueeRect(state.start, local));
  }, [localPoint]);

  const finishMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const state = marqueeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    marqueeState.current = null;
    const element = viewport.current;
    if (element?.hasPointerCapture(state.pointerId)) element.releasePointerCapture(state.pointerId);
    setMarquee(null);
    // A click on empty canvas outside the group clears it even if the modifier
    // was held without enough travel to draw a marquee.
    if (!state.moved) {
      onMarqueeSelectionRef.current(null);
      return;
    }
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    onMarqueeSelectionRef.current(canvasWorldRect(state.start, state.current, cameraRef.current), state.mode);
  }, [cameraRef, viewport]);

  const updateGroupDrag = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const state = groupDrag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const advanced = advanceCanvasGroupDrag(state, event);
    // Under the threshold the press is still a click: the card keeps its own drag.
    if (!advanced.active) return;
    // The transition is the only one-time work: the group takes pointer capture and
    // freezes the basis it will commit from, so the preview cannot feed back into it.
    if (advanced !== state) {
      groupDrag.current = advanced;
      const element = viewport.current;
      if (element && !element.hasPointerCapture(event.pointerId)) element.setPointerCapture(event.pointerId);
      onGroupDragStartRef.current(advanced.layerId);
    }
    // Every owned move, not just the transition: the pressed card's handlers must never
    // see the gesture, and stopPropagation is event-local — it cannot undo a handler
    // that already ran on an earlier move.
    event.stopPropagation();
    const delta = canvasGroupDragDelta(advanced, { x: event.clientX, y: event.clientY }, cameraRef.current.zoom);
    if (!delta) return;
    setGroupNudge(delta);
  }, [cameraRef, viewport]);

  const finishGroupDrag = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const state = groupDrag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    groupDrag.current = null;
    // A press that never travelled is a plain click: the card keeps its own
    // pointer-up path, and nothing is suppressed.
    if (!state.active) return;
    event.stopPropagation();
    const element = viewport.current;
    if (element?.hasPointerCapture(state.pointerId)) element.releasePointerCapture(state.pointerId);
    setGroupNudge(null);
    const delta = canvasGroupDragDelta(state, { x: event.clientX, y: event.clientY }, cameraRef.current.zoom);
    if (delta === null) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    onGroupDragRef.current(state.layerId, delta);
  }, [cameraRef, viewport]);

  useEffect(() => {
    window.addEventListener("blur", cancelPointerGesture);
    return () => window.removeEventListener("blur", cancelPointerGesture);
  }, [cancelPointerGesture]);

  useEffect(() => () => {
    if (edgeFrame.current !== null) cancelAnimationFrame(edgeFrame.current);
    if (panState.current) window.canvasTTY.canvasNavigation.setPointerGestureActive(false);
  }, []);

  useEffect(() => window.canvasTTY.browser.onCanvasNavigationPointer((event) => {
    if (panState.current && event.type !== "down") {
      if (event.type === "move") panTo(event.clientX, event.clientY);
      else finishPan();
      return;
    }
    if (event.type === "down") {
      nativePanState.current = {
        tabId: event.tabId,
        startClient: { x: event.clientX, y: event.clientY },
        startCamera: cameraRef.current
      };
      setPanning(true);
      return;
    }
    const state = nativePanState.current;
    if (!state || state.tabId !== event.tabId) return;
    if (event.type === "move") {
      commitCamera({
        ...state.startCamera,
        x: state.startCamera.x + event.clientX - state.startClient.x,
        y: state.startCamera.y + event.clientY - state.startClient.y
      });
      return;
    }
    nativePanState.current = null;
    setPanning(false);
  }), [cameraRef, commitCamera, finishPan, panTo]);

  const isMousePanBinding = useCallback((event: {
    button: number;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }): boolean => {
    const button = canvasNavigationMouseButtonFromDomButton(event.button);
    if (button === null) return false;
    return isCanvasNavigationBindingActive({
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      pressedMouseButtons: new Set([button])
    }, settingsRef.current.canvasNavigationOverride);
  }, []);

  const isMouseReservedBinding = useCallback((event: {
    button: number;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }): boolean => {
    const button = canvasNavigationMouseButtonFromDomButton(event.button);
    if (button === null) return false;
    const state = {
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      pressedMouseButtons: new Set([button])
    };
    return isCanvasNavigationBindingActive(state, settingsRef.current.canvasNavigationOverride)
      || (
        settingsRef.current.canvasWheelCaptureMode === "key"
        && isCanvasNavigationBindingActive(state, settingsRef.current.canvasWheelOverride)
      );
  }, []);

  const startPan = useCallback((event: React.PointerEvent<HTMLDivElement>, override = false): boolean => {
    const middleButton = event.button === 1;
    const mouseBinding = isMousePanBinding(event);
    const forced = override || middleButton || mouseBinding;
    const supportedButton = event.button === 0 || middleButton || mouseBinding;
    const blocked = !supportedButton
      || (!forced && (event.target as HTMLElement).closest('[data-interactive="true"]') !== null);
    if (blocked) return false;
    if (forced) {
      event.preventDefault();
      event.stopPropagation();
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    panState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startCamera: cameraRef.current,
      moved: false,
      suppressClick: forced
    };
    window.canvasTTY.canvasNavigation.setPointerGestureActive(true);
    setPanning(true);
    return true;
  }, [cameraRef, isMousePanBinding]);

  const edgePanStep = useCallback((time: number): void => {
    edgeFrame.current = null;
    const pointer = edgePointer.current;
    if (!pointer || panState.current || nativePanState.current || marqueeState.current || groupDrag.current
      || !settingsRef.current.edgePan) return;
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return;
    const hovered = document.elementFromPoint(pointer.x, pointer.y);
    if (hovered?.closest('[data-interactive="true"]')) return;
    const velocity = edgePanVelocity(pointer, bounds, {
      maxSpeed: EDGE_PAN_SPEEDS[settingsRef.current.edgePanSpeed]
    });
    if (!velocity) return;
    const dt = edgeLastTime.current === 0 ? 0 : Math.min(0.05, (time - edgeLastTime.current) / 1000);
    edgeLastTime.current = time;
    commitCamera({
      ...cameraRef.current,
      x: cameraRef.current.x + velocity.x * dt,
      y: cameraRef.current.y + velocity.y * dt
    });
    edgeFrame.current = requestAnimationFrame(edgePanStep);
  }, [cameraRef, commitCamera, viewport]);

  const startGroupDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, layerId: string): boolean => {
    // Deliberately non-preempting: the press still reaches the card, so focus, the
    // click path, and the card's own controls behave normally until it travels.
    groupDrag.current = beginCanvasGroupDrag(
      event.pointerId,
      layerId,
      { x: event.clientX, y: event.clientY }
    );
    return true;
  }, []);

  const handlePointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>): boolean => {
    if (event.button === 1 || isMousePanBinding(event)) return startPan(event, true);
    const target = event.target as HTMLElement;
    // One selector for every card kind: each of the four card roots publishes `data-canvas-layer-id`.
    const card = target.closest<HTMLElement>("[data-canvas-layer-id]");
    const widgetTarget = isCanvasWidgetTarget(event.target);
    const intent = canvasPressIntent({
      button: event.button,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      cardLayerId: card?.dataset.canvasLayerId ?? null,
      onCardControl: target.closest(CANVAS_CARD_CONTROL_SELECTOR) !== null,
      onCanvasWidget: widgetTarget,
      selection: selectedLayerIdsRef.current
    });
    if (intent.kind === "group-drag") return startGroupDrag(event, intent.layerId);
    if (intent.kind === "marquee") return startMarquee(event, intent.mode);
    if (intent.kind === "clear-selection") onMarqueeSelectionRef.current(null);
    if (!canvasOverrideActiveRef.current || !widgetTarget) return false;
    return startPan(event, true);
  }, [canvasOverrideActiveRef, isMousePanBinding, startGroupDrag, startMarquee, startPan]);

  const handlePointerMoveCapture = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (marqueeState.current?.pointerId === event.pointerId) {
      updateMarquee(event);
      return;
    }
    if (groupDrag.current?.pointerId === event.pointerId) updateGroupDrag(event);
  }, [updateGroupDrag, updateMarquee]);

  const handlePointerEndCapture = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    finishGroupDrag(event);
    finishMarquee(event);
  }, [finishGroupDrag, finishMarquee]);

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>): boolean => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, []);

  const handleAuxClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>): boolean => {
    if (event.button !== 1 && !isMouseReservedBinding(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, [isMouseReservedBinding]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const state = panState.current;
    if (state?.pointerId === event.pointerId) panTo(event.clientX, event.clientY);
    if (!settingsRef.current.edgePan) {
      edgePointer.current = null;
      return;
    }
    edgePointer.current = { x: event.clientX, y: event.clientY };
    if (edgeFrame.current === null) {
      edgeLastTime.current = 0;
      edgeFrame.current = requestAnimationFrame(edgePanStep);
    }
  }, [edgePanStep, panTo]);

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (panState.current?.pointerId === event.pointerId) finishPan();
  }, [finishPan]);

  const handlePointerLeave = useCallback((): void => {
    edgePointer.current = null;
  }, []);

  return {
    panning,
    marquee,
    groupNudge,
    handlePointerDownCapture,
    handleClickCapture,
    handleAuxClickCapture,
    handlePointerDown: startPan,
    handlePointerMove,
    handlePointerMoveCapture,
    handlePointerEnd,
    handlePointerEndCapture,
    handlePointerCancel: cancelPointerGesture,
    handlePointerLeave
  };
}

function isCanvasWidgetTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    '[data-wheel-owner="local"], [data-interactive="true"], [data-canvas-zoom-surface="application"]'
  ));
}
