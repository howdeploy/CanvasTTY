import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { AppSettings } from "../../../../shared/contracts";
import { HOVER_FOCUS_DELAYS } from "./focus";
import {
  browserCanvasWidgetId,
  canvasWidgetFocusAfterClick,
  canvasWidgetTarget,
  terminalCanvasWidgetId
} from "./canvasWidgetFocus";

export interface CanvasWidgetFocusState {
  id: string | null;
  source: "explicit" | "hover";
}

interface UseCanvasWidgetFocusOptions {
  viewport: RefObject<HTMLDivElement | null>;
  settings: AppSettings;
  activeSessionId: string | null;
  browserSelected: boolean;
  widgetTreeVersion: string;
}

export interface CanvasWidgetFocusController {
  state: CanvasWidgetFocusState;
  stateRef: RefObject<CanvasWidgetFocusState>;
  focus(id: string | null, source: CanvasWidgetFocusState["source"]): void;
  cancelHover(id?: string): void;
  scheduleHover(id: string): void;
  focusBrowser(): void;
  hoverBrowser(active: boolean): void;
  handleClick(event: React.MouseEvent<HTMLDivElement>): void;
  handlePointerOver(event: React.PointerEvent<HTMLDivElement>): void;
  handlePointerOut(event: React.PointerEvent<HTMLDivElement>): void;
}

export function useCanvasWidgetFocus({
  viewport,
  settings,
  activeSessionId,
  browserSelected,
  widgetTreeVersion
}: UseCanvasWidgetFocusOptions): CanvasWidgetFocusController {
  const [state, setState] = useState<CanvasWidgetFocusState>({ id: null, source: "explicit" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const hoverTimer = useRef<{ id: string; timer: number } | null>(null);

  const focus = useCallback((id: string | null, source: CanvasWidgetFocusState["source"]): void => {
    setState((current) => current.id === id && current.source === source ? current : { id, source });
  }, []);

  const cancelHover = useCallback((id?: string): void => {
    const pending = hoverTimer.current;
    if (!pending || (id !== undefined && pending.id !== id)) return;
    window.clearTimeout(pending.timer);
    hoverTimer.current = null;
  }, []);

  const scheduleHover = useCallback((id: string): void => {
    cancelHover();
    if (!settingsRef.current.hoverFocus || stateRef.current.id === id) return;
    hoverTimer.current = {
      id,
      timer: window.setTimeout(() => {
        hoverTimer.current = null;
        focus(id, "hover");
      }, HOVER_FOCUS_DELAYS[settingsRef.current.hoverFocusSpeed])
    };
  }, [cancelHover, focus]);

  const focusBrowser = useCallback((): void => {
    cancelHover();
    focus(browserCanvasWidgetId, "explicit");
  }, [cancelHover, focus]);

  const hoverBrowser = useCallback((active: boolean): void => {
    if (active) scheduleHover(browserCanvasWidgetId);
    else cancelHover(browserCanvasWidgetId);
  }, [cancelHover, scheduleHover]);

  useEffect(() => () => cancelHover(), [cancelHover]);

  useEffect(() => {
    if (!settings.hoverFocus) cancelHover();
  }, [cancelHover, settings.hoverFocus]);

  useEffect(() => {
    if (activeSessionId !== null) focus(terminalCanvasWidgetId(activeSessionId), "explicit");
  }, [activeSessionId, focus]);

  useEffect(() => {
    if (browserSelected) focus(browserCanvasWidgetId, "explicit");
  }, [browserSelected, focus]);

  useEffect(() => {
    if (state.id === null) return;
    const widgets = viewport.current?.querySelectorAll<HTMLElement>("[data-canvas-widget-id]");
    const exists = widgets && Array.from(widgets).some((widget) => widget.dataset.canvasWidgetId === state.id);
    if (!exists) focus(null, "explicit");
  }, [focus, state.id, viewport, widgetTreeVersion]);

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const target = canvasWidgetTarget(event.target);
    setState((current) => {
      const nextId = canvasWidgetFocusAfterClick(current.id, target);
      return nextId === current.id ? current : { id: nextId, source: "explicit" };
    });
  }, []);

  const handlePointerOver = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const target = canvasWidgetTarget(event.target).focusableWidgetId;
    const previous = canvasWidgetTarget(event.relatedTarget).focusableWidgetId;
    if (target !== null && target !== previous) scheduleHover(target);
  }, [scheduleHover]);

  const handlePointerOut = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const target = canvasWidgetTarget(event.target).focusableWidgetId;
    const next = canvasWidgetTarget(event.relatedTarget).focusableWidgetId;
    if (target !== null && target !== next) cancelHover(target);
  }, [cancelHover]);

  return {
    state,
    stateRef,
    focus,
    cancelHover,
    scheduleHover,
    focusBrowser,
    hoverBrowser,
    handleClick,
    handlePointerOver,
    handlePointerOut
  };
}
