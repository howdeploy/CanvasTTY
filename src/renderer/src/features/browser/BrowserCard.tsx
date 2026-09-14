import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AgentPresenceSnapshot,
  BrowserCanvasFreezeFrameEvent,
  BrowserCanvasState,
  BrowserDownloadSnapshot,
  BrowserObservation,
  BrowserObservedElement,
  BrowserResult,
  BrowserSnapshot,
  BrowserTabSnapshot,
  BrowserViewportSurface,
  CameraState,
  FocusActivation,
  LocaleId,
  Point,
  SessionBounds,
  SessionSnapshot
} from "../../../../shared/contracts";
import { BROWSER_PROVIDER_COLORS } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { shouldActivateCanvasFromClick } from "../workspace/focus";
import { snapMove, snapResize, type ResizeDirection } from "../workspace/snap";
import { browserCanvasWidgetId } from "../workspace/canvasWidgetFocus";
import {
  INSPECT_ELEMENT_LIMIT,
  inspectAgentLine,
  inspectAgentAwaitsApproval,
  inspectAgentSessionId,
  inspectPayloadFor,
  inspectRefIsStale
} from "./inspectToAgent";

interface BrowserCardProps {
  browser: BrowserSnapshot;
  bounds: BrowserCanvasState;
  locale: LocaleId;
  /** Agent sessions that can receive an inspected element. */
  sessions: readonly SessionSnapshot[];
  zoom: number;
  camera: CameraState;
  visible: boolean;
  stackIndex: number;
  uiScale: number;
  snapEnabled: boolean;
  focusActivation: FocusActivation;
  focused: boolean;
  selected: boolean;
  showAgentPresence: boolean;
  snapTargets: readonly SessionBounds[];
  onBoundsChange(bounds: BrowserCanvasState): void;
  onActivate(): void;
  onSelect(): void;
  onWidgetFocus(): void;
  onWidgetHoverChange(active: boolean): void;
  onClose(): void;
  onError(message: string): void;
}

interface DragState {
  pointerId: number;
  startClient: Point;
  startBounds: SessionBounds;
}

interface ResizeState extends DragState {
  direction: ResizeDirection;
}

type BrowserPanel = "downloads" | "close-all" | "inspect" | null;

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

export function BrowserCard({
  browser,
  bounds,
  locale,
  sessions,
  zoom,
  camera,
  visible,
  stackIndex,
  uiScale,
  snapEnabled,
  focusActivation,
  focused,
  selected,
  showAgentPresence,
  snapTargets,
  onBoundsChange,
  onActivate,
  onSelect,
  onWidgetFocus,
  onWidgetHoverChange,
  onClose,
  onError
}: BrowserCardProps): React.JSX.Element {
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const addressFocused = useRef(false);
  const [position, setPosition] = useState(bounds.position);
  const [size, setSize] = useState(bounds.size);
  const liveBounds = useRef<SessionBounds>(bounds);
  const activeTab = browser.tabs.find((tab) => tab.id === browser.activeTabId) ?? null;
  const [address, setAddress] = useState(activeTab?.url ?? "");
  const [panel, setPanel] = useState<BrowserPanel>(null);
  const [observed, setObserved] = useState<BrowserObservation | null>(null);
  const [observedElement, setObservedElement] = useState<BrowserObservedElement | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [dialogPrompt, setDialogPrompt] = useState("");
  const [freezeFrame, setFreezeFrame] = useState<BrowserCanvasFreezeFrameEvent | null>(null);
  const summaryMode = zoom < 0.5;
  const summaryScale = summaryMode ? Math.min(2.5, Math.max(1, 0.5 / zoom)) : 1;
  const activeAgents = useMemo(
    () => mergeAgents(activeTab?.agents ?? [], browser.agents.filter((agent) => agent.currentTabId === activeTab?.id)),
    [activeTab?.agents, activeTab?.id, browser.agents]
  );
  const recentDownloads = useMemo(
    () => [...browser.downloads].sort((left, right) => right.startedAt - left.startedAt),
    [browser.downloads]
  );
  const activeDownloadCount = recentDownloads.filter((download) => (
    download.status === "pending" || download.status === "progressing"
  )).length;
  const pageUnavailable = activeTab?.status === "crashed";
  const nativeViewVisible = visible
    && !summaryMode
    && panel === null
    && browser.pendingDialog === null
    && !pageUnavailable
    && activeTab !== null;
  const surface: BrowserViewportSurface = !visible ? "hidden" : nativeViewVisible ? "native" : "placeholder";
  const freezeFrameVisible = freezeFrame?.active === true
    && freezeFrame.tabId === activeTab?.id;
  const freezeFrameDataUrl = freezeFrame && freezeFrame.tabId === activeTab?.id
    ? freezeFrame.dataUrl
    : null;
  /** The exact line, CR included, that Send to agent will type into the PTY. */
  const inspectPreview = useMemo(() => (
    observed === null || observedElement === null
      ? null
      : inspectAgentLine(inspectPayloadFor(observedElement, observed.url))
  ), [observed, observedElement]);

  useEffect(() => {
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  }, [bounds]);

  useEffect(() => {
    if (!addressFocused.current) setAddress(activeTab?.url ?? "");
  }, [activeTab?.id, activeTab?.url]);

  useEffect(() => {
    setDialogPrompt(browser.pendingDialog?.defaultPrompt ?? "");
  }, [browser.pendingDialog?.defaultPrompt, browser.pendingDialog?.openedAt]);

  const viewportState = useRef({ surface, zoom, showAgentPresence });
  viewportState.current = { surface, zoom, showAgentPresence };

  const reportViewport = useCallback((): void => {
    const element = viewport.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const clipRect = element.closest<HTMLElement>(".workspace")?.getBoundingClientRect();
    const state = viewportState.current;
    window.canvasTTY.browser.setViewport({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      surface: state.surface,
      ...(clipRect ? {
        clipBounds: {
          x: clipRect.left,
          y: clipRect.top,
          width: clipRect.width,
          height: clipRect.height
        }
      } : {}),
      canvasScale: state.zoom,
      showAgentPresence: state.showAgentPresence
    });
  }, []);

  useLayoutEffect(() => {
    reportViewport();
  }, [camera.x, camera.y, position, reportViewport, showAgentPresence, size, surface, zoom]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(reportViewport);
    observer.observe(element);
    window.addEventListener("resize", reportViewport);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportViewport);
    };
  }, [reportViewport]);

  useEffect(() => () => {
    window.canvasTTY.browser.setViewport({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      surface: "hidden",
      canvasScale: 1,
      showAgentPresence: false
    });
  }, []);

  useLayoutEffect(() => {
    window.canvasTTY.browser.setInputFocused(focused);
  }, [focused]);

  useEffect(() => () => window.canvasTTY.browser.setInputFocused(false), []);

  useEffect(() => window.canvasTTY.browser.onCanvasPointer((event) => {
    if (event.tabId !== browser.activeTabId) return;
    if (event.type === "enter") {
      onWidgetHoverChange(true);
      return;
    }
    if (event.type === "leave") {
      onWidgetHoverChange(false);
      return;
    }
    if (event.type === "down") {
      onWidgetFocus();
      onSelect();
      window.canvasTTY.browser.focus();
      return;
    }
    if (shouldActivateCanvasFromClick(focusActivation, event.clickCount)) onActivate();
  }), [browser.activeTabId, focusActivation, onActivate, onSelect, onWidgetFocus, onWidgetHoverChange]);

  useEffect(() => window.canvasTTY.browser.onCanvasFreezeFrame((event) => {
    setFreezeFrame((current) => {
      if (current && event.generation <= current.generation) return current;
      const cachedDataUrl = current?.tabId === event.tabId ? current.dataUrl : null;
      return { ...event, dataUrl: event.dataUrl ?? cachedDataUrl };
    });
  }), []);

  useEffect(() => {
    if (!focused || !nativeViewVisible) return;
    const frame = requestAnimationFrame(() => window.canvasTTY.browser.focus());
    return () => cancelAnimationFrame(frame);
  }, [focused, nativeViewVisible]);

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest("button, input, [data-browser-action]")) return;
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
    dragState.current = null;
    onBoundsChange(liveBounds.current);
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

  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
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
    const constrained = constrainBrowserResize(raw, state.direction);
    applyBounds(snapEnabled ? snapResize(constrained, state.direction, snapTargets) : constrained);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = null;
    onBoundsChange(liveBounds.current);
  };

  const applyBounds = (next: SessionBounds): void => {
    liveBounds.current = next;
    setPosition(next.position);
    setSize(next.size);
  };

  const run = (action: () => Promise<unknown>): void => {
    void action().catch((error: unknown) => {
      onError(error instanceof Error ? error.message : t(locale, "browserActionFailed"));
    });
  };

  const submitAddress = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!activeTab) return;
    run(() => window.canvasTTY.browser.navigate(activeTab.id, address));
    addressFocused.current = false;
    (event.currentTarget.elements.namedItem("address") as HTMLInputElement | null)?.blur();
  };

  const closeAllTabs = (): void => {
    run(async () => {
      await window.canvasTTY.browser.closeAllTabs();
      setPanel(null);
    });
  };

  /** Observes the page once and lets the user hand a single element to an agent session. */
  const toggleInspect = (): void => {
    if (panel === "inspect") {
      setPanel(null);
      setObserved(null);
      setObservedElement(null);
      setInspectError(null);
      return;
    }
    setPanel("inspect");
    setObserved(null);
    setObservedElement(null);
    setInspectError(null);
    if (!activeTab) {
      setInspectError(t(locale, "browserInspectEmpty"));
      return;
    }
    run(async () => {
      try {
        const result: BrowserResult = await window.canvasTTY.browser.execute({
          type: "browser_observe",
          requestId: crypto.randomUUID(),
          tabId: activeTab.id,
          limit: INSPECT_ELEMENT_LIMIT
        });
        if (!result.ok) throw new Error(result.error?.message ?? t(locale, "browserActionFailed"));
        const observation = result.data as BrowserObservation;
        setObserved(observation);
        setObservedElement(observation.elements[0] ?? null);
      } catch (error: unknown) {
        setInspectError(error instanceof Error ? error.message : t(locale, "browserActionFailed"));
      }
    });
  };

  const sendInspectedElement = (): void => {
    if (!observedElement || !observed) return;
    const sessionId = inspectAgentSessionId(sessions);
    if (sessionId === null) {
      setInspectError(t(locale, inspectAgentAwaitsApproval(sessions)
        ? "browserInspectAwaitingApproval"
        : "browserInspectNoAgent"));
      return;
    }
    const payload = inspectPayloadFor(observedElement, observed.url);
    const live = activeTab === null
      ? null
      : { tabId: activeTab.id, documentRevision: activeTab.documentRevision };
    if (inspectRefIsStale(payload, live)) {
      // The page moved on; sending the old node would target the wrong element.
      setInspectError(t(locale, "browserActionFailed"));
      return;
    }
    window.canvasTTY.terminal.input(sessionId, inspectAgentLine(payload));
    setPanel(null);
    setObserved(null);
    setObservedElement(null);
    setInspectError(null);
  };

  const answerDialog = (accept: boolean): void => {
    const dialog = browser.pendingDialog;
    if (!dialog) return;
    run(async () => {
      const result = await window.canvasTTY.browser.execute({
        type: "browser_handle_dialog",
        requestId: crypto.randomUUID(),
        tabId: dialog.tabId,
        accept,
        promptText: dialog.type === "prompt" ? dialogPrompt : undefined
      });
      if (!result.ok) throw new Error(result.error?.message ?? t(locale, "browserActionFailed"));
    });
  };

  const activateSummary = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onSelect();
    if (shouldActivateCanvasFromClick(focusActivation, 1)) onActivate();
  };

  const activateSummaryDouble = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (shouldActivateCanvasFromClick(focusActivation, 2)) onActivate();
  };

  const activateCard = (event: React.MouseEvent<HTMLElement>): void => {
    if (isBrowserCardControl(event.target)) return;
    if (shouldActivateCanvasFromClick(focusActivation, 1)) onActivate();
  };

  const activateCardDouble = (event: React.MouseEvent<HTMLElement>): void => {
    if (isBrowserCardControl(event.target)) return;
    if (shouldActivateCanvasFromClick(focusActivation, 2)) onActivate();
  };

  return (
    <article
      className={`browser-card ${summaryMode ? "browser-card--summary" : ""} ${selected ? "browser-card--selected" : ""}`}
      data-interactive="true"
      data-canvas-layer-id="browser"
      data-canvas-widget-id={browserCanvasWidgetId}
      data-canvas-widget-focusable="true"
      data-canvas-zoom-surface="application"
      data-wheel-owner={summaryMode ? undefined : "local"}
      data-browser-canvas-wheel-owner={surface !== "native" || freezeFrameVisible ? "canvas" : undefined}
      tabIndex={-1}
      onPointerDownCapture={() => {
        onWidgetFocus();
        onSelect();
      }}
      onPointerEnter={() => onWidgetHoverChange(true)}
      onPointerLeave={() => onWidgetHoverChange(false)}
      onClick={activateCard}
      onDoubleClick={activateCardDouble}
      style={{
        width: size.width,
        height: size.height,
        zIndex: stackIndex,
        transform: `translate(${position.x}px, ${position.y}px)`,
        "--summary-scale": summaryScale,
        "--summary-content-width": `${Math.max(0, (size.width - 48) / summaryScale)}px`
      } as React.CSSProperties}
    >
      <header
        className="browser-card__header"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="browser-card__title">
          <UiIcon name="browser" size="1.69em" />
          <span>
            <strong>{t(locale, "browser")}</strong>
            <small title={activeTab?.title}>{activeTab?.title || t(locale, "newTab")}</small>
          </span>
        </span>
        <button className="browser-card__hide" type="button" onClick={onClose} title={t(locale, "hideBrowser")} aria-label={t(locale, "hideBrowser")}>
          <UiIcon name="close" size="1.23em" />
        </button>
      </header>

      <div className="browser-card__tabs">
        <div className="browser-card__tab-list" role="tablist" aria-label={t(locale, "browserTabs")}>
          {browser.tabs.map((tab) => (
            <div
              className={`browser-card__tab ${tab.id === browser.activeTabId ? "browser-card__tab--active" : ""}`}
              key={tab.id}
              role="presentation"
            >
              <button
                className="browser-card__tab-select"
                type="button"
                role="tab"
                aria-selected={tab.id === browser.activeTabId}
                onClick={() => run(() => window.canvasTTY.browser.selectTab(tab.id))}
                title={tab.title}
              >
                <TabFavicon tab={tab} />
                <span className="browser-card__tab-title">{tab.title || t(locale, "newTab")}</span>
                {showAgentPresence && <AgentBadges agents={tab.agents} locale={locale} compact />}
              </button>
              <button
                className="browser-card__tab-close"
                type="button"
                onClick={() => run(() => window.canvasTTY.browser.closeTab(tab.id))}
                title={t(locale, "closeTab")}
                aria-label={t(locale, "closeTab")}
              >
                <UiIcon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="browser-card__new-tab"
          type="button"
          onClick={() => run(() => window.canvasTTY.browser.newTab())}
          title={t(locale, "newTab")}
          aria-label={t(locale, "newTab")}
        >
          <UiIcon name="plus" size={16} />
        </button>
        <button
          className="browser-card__close-all"
          type="button"
          disabled={browser.tabs.length === 0}
          onClick={() => setPanel((current) => current === "close-all" ? null : "close-all")}
        >
          {t(locale, "closeAllTabsShort")}
        </button>
      </div>

      <nav className="browser-card__navigation" aria-label={t(locale, "browserNavigation")}>
        <button className="browser-card__back" type="button" disabled={!activeTab?.canGoBack} onClick={() => activeTab && run(() => window.canvasTTY.browser.back(activeTab.id))} title={t(locale, "back")}>
          <UiIcon name="arrow" size={16} />
        </button>
        <button type="button" disabled={!activeTab?.canGoForward} onClick={() => activeTab && run(() => window.canvasTTY.browser.forward(activeTab.id))} title={t(locale, "forward")}>
          <UiIcon name="arrow" size={16} />
        </button>
        <button type="button" disabled={!activeTab} onClick={() => activeTab && run(() => window.canvasTTY.browser.reload(activeTab.id))} title={t(locale, "reload")}>
          <UiIcon name={activeTab?.loading ? "working" : "reload"} size={16} />
        </button>
        <form onSubmit={submitAddress}>
          <input
            name="address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => { addressFocused.current = true; }}
            onBlur={() => { addressFocused.current = false; }}
            placeholder={t(locale, "browserAddress")}
            aria-label={t(locale, "browserAddress")}
          />
        </form>
        {showAgentPresence && <AgentBadges agents={browser.agents} locale={locale} />}
        <button
          className="browser-card__inspect-toggle"
          type="button"
          disabled={!activeTab}
          onClick={toggleInspect}
          title={t(locale, "browserInspect")}
          aria-label={t(locale, "browserInspect")}
        >
          <UiIcon name="search" size={16} />
        </button>
        <button
          className={`browser-card__downloads ${activeDownloadCount > 0 ? "browser-card__downloads--active" : ""}`}
          type="button"
          onClick={() => setPanel((current) => current === "downloads" ? null : "downloads")}
          title={t(locale, "browserDownloads")}
          aria-label={`${t(locale, "browserDownloads")}: ${recentDownloads.length}`}
        >
          <UiIcon name="download" size={16} />
          {recentDownloads.length > 0 && <span>{activeDownloadCount || recentDownloads.length}</span>}
        </button>
      </nav>

      <div
        ref={viewport}
        className="browser-card__viewport"
        data-browser-canvas-wheel-owner={freezeFrameVisible ? "canvas" : undefined}
      >
        {freezeFrameDataUrl && (
          <img
            className="browser-card__freeze-frame"
            src={freezeFrameDataUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        )}
      </div>

      {!activeTab && (
        <div className="browser-card__page-state">
          <UiIcon name="browser" size={36} />
          <strong>{t(locale, "browserNoTabs")}</strong>
          <button type="button" onClick={() => run(() => window.canvasTTY.browser.newTab())}>{t(locale, "newTab")}</button>
        </div>
      )}

      {pageUnavailable && activeTab && (
        <div className="browser-card__page-state browser-card__page-state--error">
          <UiIcon name="error" size={34} />
          <strong>{t(locale, "browserTabCrashed")}</strong>
          <small>{activeTab.crashState ?? t(locale, "browserActionFailed")}</small>
          <button type="button" onClick={() => run(() => window.canvasTTY.browser.reload(activeTab.id))}>{t(locale, "reload")}</button>
        </div>
      )}

      <button
        className="browser-card__summary"
        type="button"
        onClick={activateSummary}
        onDoubleClick={activateSummaryDouble}
        data-focus-activation={focusActivation}
        data-browser-canvas-wheel-owner="canvas"
        aria-label={t(locale, "browser")}
      >
        <span className="browser-card__summary-content">
          <TabFavicon tab={activeTab} large />
          <strong>{activeTab?.title || t(locale, "browser")}</strong>
          <small>{activeTab?.url || t(locale, "newTab")}</small>
          {showAgentPresence && <AgentBadges agents={activeAgents} locale={locale} />}
        </span>
      </button>

      {summaryMode && showAgentPresence && (
        <AgentCursorLayer agents={activeAgents} width={size.width} height={size.height - 54 * uiScale} />
      )}

      {panel === "downloads" && (
        <section className="browser-card__popover browser-card__download-panel" data-browser-action="true" data-wheel-owner="local">
          <header>
            <strong>{t(locale, "browserDownloads")}</strong>
            <button type="button" onClick={() => setPanel(null)} aria-label={t(locale, "close")}><UiIcon name="close" size={14} /></button>
          </header>
          {recentDownloads.length === 0 ? (
            <p>{t(locale, "browserNoDownloads")}</p>
          ) : recentDownloads.slice(0, 6).map((download) => (
            <DownloadRow download={download} locale={locale} key={download.id} />
          ))}
        </section>
      )}

      {panel === "inspect" && (
        <section className="browser-inspect" data-browser-action="true" data-wheel-owner="local" aria-label={t(locale, "browserInspectTitle")}>
          <strong className="browser-inspect__title">{t(locale, "browserInspectTitle")}</strong>
          {inspectError && <p className="browser-inspect__empty">{inspectError}</p>}
          {!inspectError && (observed === null || observed.elements.length === 0) && (
            <p className="browser-inspect__empty">{observed === null ? t(locale, "browserInspect") : t(locale, "browserInspectEmpty")}</p>
          )}
          {observed !== null && observed.elements.length > 0 && (
            <ul className="browser-inspect__list">
              {observed.elements.map((element) => (
                <li key={element.ref.ref}>
                  <button
                    className="browser-inspect__item"
                    type="button"
                    aria-selected={observedElement?.ref.ref === element.ref.ref}
                    onClick={() => {
                      setObservedElement(element);
                      setInspectError(null);
                    }}
                  >
                    <strong>{element.name || element.role || element.ref.ref}</strong>
                    <span>{element.role} · {element.ref.ref}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {inspectPreview !== null && (
            // The page-authored label is part of what the user approves: show the whole line, untruncated.
            <p className="browser-inspect__preview" title={inspectPreview}>{inspectPreview}</p>
          )}
          <button
            className="browser-inspect__send"
            type="button"
            disabled={observedElement === null}
            onClick={sendInspectedElement}
          >{t(locale, "browserInspectSend")}</button>
        </section>
      )}

      {panel === "close-all" && (
        <section className="browser-card__popover browser-card__confirm" data-browser-action="true" role="alertdialog" aria-label={t(locale, "closeAllTabs")}>
          <strong>{t(locale, "closeAllTabsQuestion")}</strong>
          <p>{t(locale, "closeAllTabsDescription")}</p>
          <div>
            <button type="button" onClick={() => setPanel(null)}>{t(locale, "cancel")}</button>
            <button className="browser-card__danger-action" type="button" onClick={closeAllTabs}>{t(locale, "closeAllTabs")}</button>
          </div>
        </section>
      )}

      {browser.pendingDialog && (
        <section className="browser-card__dialog" data-browser-action="true" role="dialog" aria-modal="true" aria-label={t(locale, "browserSiteDialog")}>
          <span>{t(locale, "browserSiteDialog")}</span>
          <strong>{browser.pendingDialog.message}</strong>
          {browser.pendingDialog.type === "prompt" && (
            <input value={dialogPrompt} onChange={(event) => setDialogPrompt(event.target.value)} aria-label={t(locale, "browserSiteReply")} />
          )}
          <div>
            {browser.pendingDialog.type !== "alert" && <button type="button" onClick={() => answerDialog(false)}>{t(locale, "cancel")}</button>}
            <button className="browser-card__dialog-primary" type="button" onClick={() => answerDialog(true)}>{t(locale, "browserContinue")}</button>
          </div>
        </section>
      )}

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

function TabFavicon({ tab, large = false }: { tab: BrowserTabSnapshot | null; large?: boolean }): React.JSX.Element {
  const source = safeFavicon(tab?.favicon ?? null);
  const failedTab = tab?.status === "error" || tab?.status === "crashed";
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);

  return (
    <span className={`browser-card__favicon ${large ? "browser-card__favicon--large" : ""} ${tab?.loading ? "browser-card__favicon--loading" : ""} ${failedTab ? "browser-card__favicon--error" : ""}`}>
      {source && !failed
        ? <img src={source} alt="" onError={() => setFailed(true)} />
        : <UiIcon name={failedTab ? "error" : "browser"} size={large ? 30 : 14} />}
    </span>
  );
}

function AgentBadges({
  agents,
  locale,
  compact = false
}: {
  agents: AgentPresenceSnapshot[];
  locale: LocaleId;
  compact?: boolean;
}): React.JSX.Element | null {
  if (agents.length === 0) return null;
  const visibleAgents = agents.slice(0, compact ? 3 : 4);
  return (
    <span className={`browser-card__agents ${compact ? "browser-card__agents--compact" : ""}`} aria-label={`${t(locale, "browserAgents")}: ${agents.length}`}>
      {visibleAgents.map((agent) => (
        <span
          className={`browser-card__agent ${agent.connectionState === "stale" ? "browser-card__agent--stale" : ""}`}
          style={{ "--agent-color": agentColor(agent) } as React.CSSProperties}
          title={`${agent.label || agent.provider}: ${t(locale, agent.connectionState === "stale" ? "browserAgentStale" : "browserAgentConnected")}`}
          key={agent.connectionId}
        >
          <span className="browser-card__cursor-glyph" aria-hidden="true" />
          {!compact && <strong>{agent.label || agent.provider}</strong>}
        </span>
      ))}
      {agents.length > visibleAgents.length && <span className="browser-card__agent-more">+{agents.length - visibleAgents.length}</span>}
    </span>
  );
}

function AgentCursorLayer({
  agents,
  width,
  height
}: {
  agents: AgentPresenceSnapshot[];
  width: number;
  height: number;
}): React.JSX.Element | null {
  const visibleAgents = agents.filter((agent) => agent.cursor.updatedAt > 0);
  if (visibleAgents.length === 0) return null;
  return (
    <div className="browser-card__cursor-layer" aria-hidden="true">
      {visibleAgents.map((agent) => (
        <span
          className={`browser-card__live-cursor ${agent.connectionState === "stale" ? "browser-card__live-cursor--stale" : ""}`}
          style={{
            left: clamp(agent.cursor.x, 8, Math.max(8, width - 18)),
            top: clamp(agent.cursor.y, 8, Math.max(8, height - 18)),
            "--agent-color": agentColor(agent)
          } as React.CSSProperties}
          key={agent.connectionId}
        >
          <span />
        </span>
      ))}
    </div>
  );
}

function DownloadRow({ download, locale }: { download: BrowserDownloadSnapshot; locale: LocaleId }): React.JSX.Element {
  const percent = download.totalBytes > 0
    ? Math.min(100, Math.round(download.receivedBytes / download.totalBytes * 100))
    : null;
  return (
    <div className="browser-card__download-row">
      <span><UiIcon name="download" size={14} /></span>
      <span>
        <strong title={download.fileName}>{download.fileName}</strong>
        <small>{downloadStatusLabel(locale, download.status)}{percent === null ? "" : `, ${percent}%`}</small>
      </span>
      {download.status === "progressing" && percent !== null && <i style={{ "--download-progress": `${percent}%` } as React.CSSProperties} />}
    </div>
  );
}

function downloadStatusLabel(locale: LocaleId, status: BrowserDownloadSnapshot["status"]): string {
  const keys = {
    pending: "browserDownloadPending",
    progressing: "browserDownloadProgressing",
    completed: "browserDownloadCompleted",
    canceled: "browserDownloadCanceled",
    interrupted: "browserDownloadInterrupted"
  } as const;
  return t(locale, keys[status]);
}

function safeFavicon(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith("data:image/") || value.startsWith("blob:") ? value : null;
}

function mergeAgents(...groups: AgentPresenceSnapshot[][]): AgentPresenceSnapshot[] {
  const agents = new Map<string, AgentPresenceSnapshot>();
  for (const group of groups) {
    for (const agent of group) agents.set(agent.connectionId, agent);
  }
  return [...agents.values()].sort((left, right) => left.connectedAt - right.connectedAt);
}

function agentColor(agent: AgentPresenceSnapshot): string {
  return BROWSER_PROVIDER_COLORS[agent.provider];
}

function isBrowserCardControl(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest("button, input, form, [data-browser-action]") !== null;
}

function constrainBrowserResize(bounds: SessionBounds, direction: ResizeDirection): SessionBounds {
  const right = bounds.position.x + bounds.size.width;
  const bottom = bounds.position.y + bounds.size.height;
  const width = clamp(bounds.size.width, 620, 1_600);
  const height = clamp(bounds.size.height, 420, 1_100);
  return {
    position: {
      x: direction.includes("w") ? right - width : bounds.position.x,
      y: direction.includes("n") ? bottom - height : bounds.position.y
    },
    size: { width, height }
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
