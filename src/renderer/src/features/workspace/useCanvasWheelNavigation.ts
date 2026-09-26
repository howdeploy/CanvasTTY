import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type {
  AppSettings,
  CameraState,
  CanvasNavigationMouseButton,
  Point
} from "../../../../shared/contracts";
import {
  canvasNavigationMouseButtonFromDomButton,
  canvasWheelIntent,
  isCanvasNavigationBindingActive,
  shouldCanvasOwnWheel,
  type CanvasWheelDeltas
} from "../../../../shared/canvasNavigation";
import { routeCanvasWheelEvent } from "./canvasWheelRouting";
import type { CanvasWidgetFocusState } from "./useCanvasWidgetFocus";

export interface CanvasWheelInput extends CanvasWheelDeltas {
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

interface UseCanvasWheelNavigationOptions {
  viewport: RefObject<HTMLDivElement | null>;
  settings: AppSettings;
  cameraRef: MutableRefObject<CameraState>;
  widgetFocusRef: RefObject<CanvasWidgetFocusState>;
  commitCamera(camera: CameraState): void;
}

export interface CanvasWheelNavigationController {
  canvasOverrideActive: boolean;
  canvasOverrideActiveRef: RefObject<boolean>;
  routeWidgetWheelToCanvas: boolean;
  /** True from the first zooming step until 160 ms of silence. */
  zooming: boolean;
  applyCanvasWheel(event: CanvasWheelInput): void;
  zoomBy(factor: number): void;
}

/** Trail after the last zoom step before the gesture is considered over. */
const MARK_GESTURE_SETTLE_MS = 160;

export function useCanvasWheelNavigation({
  viewport,
  settings,
  cameraRef,
  widgetFocusRef,
  commitCamera
}: UseCanvasWheelNavigationOptions): CanvasWheelNavigationController {
  const [wheelOverrideActive, setWheelOverrideActive] = useState(false);
  const wheelOverrideActiveRef = useRef(false);
  const [canvasOverrideActive, setCanvasOverrideActive] = useState(false);
  const canvasOverrideActiveRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const panFrame = useRef<number | null>(null);
  const pendingPan = useRef<Point>({ x: 0, y: 0 });
  const [zooming, setZooming] = useState(false);
  const zoomSettleTimer = useRef<number | null>(null);

  // Trailing edge only: every zoom step restarts the timer, so a continuous
  // wheel or pinch keeps the gesture open and only silence closes it.
  const markZoomGesture = useCallback((): void => {
    setZooming(true);
    if (zoomSettleTimer.current !== null) window.clearTimeout(zoomSettleTimer.current);
    zoomSettleTimer.current = window.setTimeout(() => {
      zoomSettleTimer.current = null;
      setZooming(false);
    }, MARK_GESTURE_SETTLE_MS);
  }, []);

  const zoomAt = useCallback((clientX: number, clientY: number, nextZoom: number): void => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return;
    const camera = cameraRef.current;
    const localX = clientX - bounds.left;
    const localY = clientY - bounds.top;
    const worldX = (localX - camera.x) / camera.zoom;
    const worldY = (localY - camera.y) / camera.zoom;
    markZoomGesture();
    commitCamera({
      zoom: nextZoom,
      x: localX - worldX * nextZoom,
      y: localY - worldY * nextZoom
    });
  }, [cameraRef, commitCamera, markZoomGesture, viewport]);

  const flushPan = useCallback((): void => {
    if (panFrame.current !== null) {
      cancelAnimationFrame(panFrame.current);
      panFrame.current = null;
    }
    const delta = pendingPan.current;
    if (delta.x === 0 && delta.y === 0) return;
    pendingPan.current = { x: 0, y: 0 };
    commitCamera({
      ...cameraRef.current,
      x: cameraRef.current.x - delta.x,
      y: cameraRef.current.y - delta.y
    });
  }, [cameraRef, commitCamera]);

  const applyCanvasWheel = useCallback((event: CanvasWheelInput): void => {
    window.canvasTTY.canvasNavigation.armOwnerWheelSequence(event.clientX, event.clientY);
    const intent = canvasWheelIntent(event, event, settingsRef.current);
    if (intent.kind === "pan") {
      pendingPan.current.x += intent.deltaX;
      pendingPan.current.y += intent.deltaY;
      if (panFrame.current === null) panFrame.current = requestAnimationFrame(flushPan);
      return;
    }
    flushPan();
    zoomAt(event.clientX, event.clientY, clamp(cameraRef.current.zoom * intent.factor, 0.2, 1.35));
  }, [cameraRef, flushPan, zoomAt]);

  useEffect(() => () => {
    if (panFrame.current !== null) cancelAnimationFrame(panFrame.current);
    if (zoomSettleTimer.current !== null) window.clearTimeout(zoomSettleTimer.current);
  }, []);

  useEffect(() => window.canvasTTY.canvasNavigation.onOverrideState(({ wheelActive, navigationActive }) => {
    wheelOverrideActiveRef.current = wheelActive;
    canvasOverrideActiveRef.current = navigationActive;
    viewport.current?.classList.toggle("workspace--canvas-override", navigationActive);
    setWheelOverrideActive(wheelActive);
    setCanvasOverrideActive(navigationActive);
  }), [viewport]);

  useEffect(() => {
    const pressedButtons = new Set<CanvasNavigationMouseButton>();
    const reservedButtons = new Set<CanvasNavigationMouseButton>();
    const releaseButtons = (): void => {
      for (const button of pressedButtons) {
        window.canvasTTY.canvasNavigation.setPointerBindingState({
          button,
          pressed: false,
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false
        });
      }
      pressedButtons.clear();
      reservedButtons.clear();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      const button = canvasNavigationMouseButtonFromDomButton(event.button);
      if (button === null) return;
      const pointerState = {
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        pressedMouseButtons: new Set([button])
      };
      const reserved = (
        settingsRef.current.canvasWheelCaptureMode === "key"
        && isCanvasNavigationBindingActive(pointerState, settingsRef.current.canvasWheelOverride)
      ) || isCanvasNavigationBindingActive(pointerState, settingsRef.current.canvasNavigationOverride);
      if (reserved) {
        reservedButtons.add(button);
        event.preventDefault();
      }
      pressedButtons.add(button);
      window.canvasTTY.canvasNavigation.setPointerBindingState({
        button,
        pressed: true,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey
      });
    };
    const handlePointerUp = (event: PointerEvent): void => {
      const button = canvasNavigationMouseButtonFromDomButton(event.button);
      if (button === null) return;
      if (reservedButtons.delete(button)) event.preventDefault();
      if (!pressedButtons.delete(button)) return;
      window.canvasTTY.canvasNavigation.setPointerBindingState({
        button,
        pressed: false,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey
      });
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", releaseButtons, true);
    window.addEventListener("blur", releaseButtons);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", releaseButtons, true);
      window.removeEventListener("blur", releaseButtons);
      releaseButtons();
    };
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent): void => {
      routeCanvasWheelEvent(event, {
        focusedWidgetId: widgetFocusRef.current.id,
        captureMode: settingsRef.current.canvasWheelCaptureMode,
        wheelOverrideActive: wheelOverrideActiveRef.current,
        navigationOverrideActive: canvasOverrideActiveRef.current,
        getBounds: () => element.getBoundingClientRect(),
        applyCanvasWheel
      });
    };
    element.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => element.removeEventListener("wheel", handleWheel, true);
  }, [applyCanvasWheel, viewport, widgetFocusRef]);

  useEffect(() => window.canvasTTY.browser.onCanvasWheel(applyCanvasWheel), [applyCanvasWheel]);

  const zoomBy = useCallback((factor: number): void => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return;
    zoomAt(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
      clamp(cameraRef.current.zoom * factor, 0.2, 1.35)
    );
  }, [cameraRef, viewport, zoomAt]);

  return {
    canvasOverrideActive,
    canvasOverrideActiveRef,
    routeWidgetWheelToCanvas: shouldCanvasOwnWheel({
      overFocusedWidget: true,
      captureMode: settings.canvasWheelCaptureMode,
      wheelOverrideActive,
      navigationOverrideActive: canvasOverrideActive
    }),
    zooming,
    applyCanvasWheel,
    zoomBy
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
