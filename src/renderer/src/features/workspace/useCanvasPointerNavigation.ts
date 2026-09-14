import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { AppSettings, CameraState, Point, SessionBounds } from "../../../../shared/contracts";
import {
  canvasNavigationMouseButtonFromDomButton,
  isCanvasNavigationBindingActive
} from "../../../../shared/canvasNavigation";
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

/** Viewport-local marquee rectangle, ready for absolute positioning. */
export interface CanvasMarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MarqueeState {
  pointerId: number;
  start: Point;
  current: Point;
  moved: boolean;
}

interface GroupDragState {
  pointerId: number;
  draggedId: string;
  startClient: Point;
}

/** Client pixels a gesture must travel before it counts as a drag, not a click. */
const CANVAS_DRAG_THRESHOLD = 3;

interface UseCanvasPointerNavigationOptions {
  viewport: RefObject<HTMLDivElement | null>;
  settings: AppSettings;
  cameraRef: MutableRefObject<CameraState>;
  canvasOverrideActiveRef: RefObject<boolean>;
  commitCamera(camera: CameraState): void;
  /** Session ids currently marquee-selected; a drag on one of them moves the group. */
  selectedSessionIds: ReadonlySet<string>;
  /** Replaces the marquee group with the sessions intersecting the world rectangle; null clears it. */
  onMarqueeSelection(bounds: SessionBounds | null): void;
  /** Commits a group move: the pointer offset in world units. */
  onGroupDrag(draggedId: string, delta: Point): void;
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
  handlePointerLeave(): void;
}

export function useCanvasPointerNavigation({
  viewport,
  settings,
  cameraRef,
  canvasOverrideActiveRef,
  commitCamera,
  selectedSessionIds,
  onMarqueeSelection,
  onGroupDrag
}: UseCanvasPointerNavigationOptions): CanvasPointerNavigationController {
  const panState = useRef<PanState | null>(null);
  const nativePanState = useRef<NativePanState | null>(null);
  const suppressClick = useRef(false);
  const [panning, setPanning] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selectedSessionIdsRef = useRef(selectedSessionIds);
  selectedSessionIdsRef.current = selectedSessionIds;
  const onMarqueeSelectionRef = useRef(onMarqueeSelection);
  onMarqueeSelectionRef.current = onMarqueeSelection;
  const onGroupDragRef = useRef(onGroupDrag);
  onGroupDragRef.current = onGroupDrag;
  const marqueeState = useRef<MarqueeState | null>(null);
  const [marquee, setMarquee] = useState<CanvasMarqueeRect | null>(null);
  const groupDrag = useRef<GroupDragState | null>(null);
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

  const resetPan = useCallback((): void => {
    const pointerId = panState.current?.pointerId;
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

  const worldRectFromLocal = useCallback((start: Point, end: Point): SessionBounds => {
    const camera = cameraRef.current;
    const left = (Math.min(start.x, end.x) - camera.x) / camera.zoom;
    const top = (Math.min(start.y, end.y) - camera.y) / camera.zoom;
    return {
      position: { x: left, y: top },
      size: {
        width: Math.abs(end.x - start.x) / camera.zoom,
        height: Math.abs(end.y - start.y) / camera.zoom
      }
    };
  }, [cameraRef]);

  const startMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>): boolean => {
    const local = localPoint(event.clientX, event.clientY);
    if (!local) return false;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    marqueeState.current = { pointerId: event.pointerId, start: local, current: local, moved: false };
    setMarquee({ left: local.x, top: local.y, width: 0, height: 0 });
    return true;
  }, [localPoint]);

  const updateMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const state = marqueeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const local = localPoint(event.clientX, event.clientY);
    if (!local) return;
    const moved = state.moved
      || Math.abs(local.x - state.start.x) > CANVAS_DRAG_THRESHOLD
      || Math.abs(local.y - state.start.y) > CANVAS_DRAG_THRESHOLD;
    marqueeState.current = { ...state, current: local, moved };
    setMarquee({
      left: Math.min(state.start.x, local.x),
      top: Math.min(state.start.y, local.y),
      width: Math.abs(local.x - state.start.x),
      height: Math.abs(local.y - state.start.y)
    });
  }, [localPoint]);

  const finishMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const state = marqueeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    marqueeState.current = null;
    const element = viewport.current;
    if (element?.hasPointerCapture(state.pointerId)) element.releasePointerCapture(state.pointerId);
    setMarquee(null);
    // A press without travel stays a plain click, so focus handling is untouched.
    if (!state.moved) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    onMarqueeSelectionRef.current(worldRectFromLocal(state.start, state.current));
  }, [viewport, worldRectFromLocal]);

  const updateGroupDrag = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const state = groupDrag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const camera = cameraRef.current;
    setGroupNudge({
      x: (event.clientX - state.startClient.x) / camera.zoom,
      y: (event.clientY - state.startClient.y) / camera.zoom
    });
  }, [cameraRef]);

  const finishGroupDrag = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const state = groupDrag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    groupDrag.current = null;
    const element = viewport.current;
    if (element?.hasPointerCapture(state.pointerId)) element.releasePointerCapture(state.pointerId);
    setGroupNudge(null);
    const camera = cameraRef.current;
    const delta = {
      x: (event.clientX - state.startClient.x) / camera.zoom,
      y: (event.clientY - state.startClient.y) / camera.zoom
    };
    if (delta.x === 0 && delta.y === 0) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    onGroupDragRef.current(state.draggedId, delta);
  }, [cameraRef, viewport]);

  useEffect(() => {
    window.addEventListener("blur", resetPan);
    return () => window.removeEventListener("blur", resetPan);
  }, [resetPan]);

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

  const startGroupDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, sessionId: string): boolean => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    groupDrag.current = {
      pointerId: event.pointerId,
      draggedId: sessionId,
      startClient: { x: event.clientX, y: event.clientY }
    };
    setGroupNudge({ x: 0, y: 0 });
    return true;
  }, []);

  const handlePointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>): boolean => {
    if (event.button === 1 || isMousePanBinding(event)) return startPan(event, true);
    const card = (event.target as HTMLElement).closest<HTMLElement>(".terminal-card");
    const sessionId = card?.dataset.sessionId ?? null;
    if (card && sessionId !== null && event.button === 0 && !event.altKey
      && selectedSessionIdsRef.current.size > 1 && selectedSessionIdsRef.current.has(sessionId)) {
      // The whole group moves together, so the card's own drag must not also run.
      return startGroupDrag(event, sessionId);
    }
    if (event.button === 0 && card === null && !isCanvasWidgetTarget(event.target)) {
      if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) return startMarquee(event);
      onMarqueeSelectionRef.current(null);
    }
    if (!canvasOverrideActiveRef.current || !isCanvasWidgetTarget(event.target)) return false;
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
    handlePointerLeave
  };
}

function isCanvasWidgetTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    '[data-wheel-owner="local"], [data-interactive="true"], [data-canvas-zoom-surface="application"]'
  ));
}
