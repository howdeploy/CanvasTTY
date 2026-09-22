import type { BrowserWindow, WebContents, WebContentsView } from "electron";
import type {
  BrowserCanvasFreezeFrameEvent,
  BrowserCanvasWheelEvent,
  BrowserViewportBounds,
  CanvasWheelCaptureMode,
  Point,
  Size
} from "../../../shared/contracts.ts";
import {
  BROWSER_CANVAS_WHEEL_IDLE_MS,
  BrowserCanvasFreezeFrameStore,
  BrowserCanvasWheelSequence,
  browserCanvasNativeWheelSinkLayout,
  createBrowserCanvasNativeWheelSink,
  encodeBrowserCanvasFreezeFrame,
  type BrowserCanvasNativeWheelSink,
  type BrowserCanvasNativeWheelSinkLayout,
  type BrowserCanvasRectangle
} from "./BrowserCanvasFreeze.ts";
import type { BrowserCanvasSinkViewportController } from "./BrowserCanvasSinkViewport.ts";
import {
  BrowserPageWheelSequence,
  browserPageWheelClientPoint,
  browserWheelOwner,
  toCanvasPageWheelInput,
  type BrowserWheelDecision
} from "./BrowserCanvasWheel.ts";

export interface BrowserCanvasGestureTab {
  id: string;
  view: WebContentsView;
  canvasSinkViewport: BrowserCanvasSinkViewportController;
}

export interface BrowserCanvasGestureHost {
  getOwner(): BrowserWindow | null;
  getViewport(): BrowserViewportBounds;
  getActiveTab(): BrowserCanvasGestureTab | null;
  getTab(tabId: string): BrowserCanvasGestureTab | undefined;
  isVisible(): boolean;
  isDisposed(): boolean;
  getOverrideState(): { wheelActive: boolean; navigationActive: boolean };
  getCursorScreenPoint(): Point;
  requestSurfaceSync(): void;
  beforeSequenceEnd(): void;
  shouldDeferIdleEnd(): boolean;
  sendWheel(payload: BrowserCanvasWheelEvent): void;
  sendFreezeFrame(payload: BrowserCanvasFreezeFrameEvent): void;
}

export type BrowserCanvasSurfaceDecision =
  | { kind: "normal" }
  | { kind: "frozen" }
  | { kind: "sink"; layout: BrowserCanvasNativeWheelSinkLayout };

export class BrowserCanvasGestureController {
  private readonly host: BrowserCanvasGestureHost;
  private readonly now: () => number;
  private readonly pageSequence = new BrowserPageWheelSequence();
  private readonly ownerSequence = new BrowserCanvasWheelSequence();
  private readonly frameStore = new BrowserCanvasFreezeFrameStore();
  private captureMode: CanvasWheelCaptureMode;
  private inputFocused = false;
  private browserWheelPoint: { tabId: string; point: Point; observedAt: number } | null = null;
  private sequenceTimer: NodeJS.Timeout | null = null;
  private capturePromise: Promise<void> | null = null;
  private captureQueued = false;
  private captureAfterSequence = false;
  private freezeActive = false;
  private freezeTabId: string | null = null;
  private freezeEventGeneration = 0;
  private nativeSink: BrowserCanvasNativeWheelSink | null = null;

  constructor(
    host: BrowserCanvasGestureHost,
    options: { captureMode: CanvasWheelCaptureMode; now?: () => number }
  ) {
    this.host = host;
    this.captureMode = options.captureMode;
    this.now = options.now ?? Date.now;
  }

  get activeNativeSink(): BrowserCanvasNativeWheelSink | null {
    return this.nativeSink;
  }

  get frozenTabId(): string | null {
    return this.freezeTabId;
  }

  get isFreezeActive(): boolean {
    return this.freezeActive;
  }

  setInputFocused(focused: boolean): void {
    this.inputFocused = focused;
  }

  setCaptureMode(mode: CanvasWheelCaptureMode): void {
    this.captureMode = mode;
  }

  decidePageWheel(sender: WebContents, input: unknown): BrowserWheelDecision {
    const failClosed = { generation: 0, owner: "canvas" } satisfies BrowserWheelDecision;
    const wheel = toCanvasPageWheelInput(input);
    const viewport = this.host.getViewport();
    const tab = this.host.getActiveTab();
    if (!wheel || !this.host.isVisible() || viewport.surface !== "native" || !tab) return failClosed;
    if (tab.view.webContents !== sender || sender.isDestroyed()) return failClosed;
    const owner = this.host.getOwner();
    if (!owner || owner.isDestroyed()) return failClosed;
    const overrides = this.host.getOverrideState();
    const decision = this.pageSequence.decide(browserWheelOwner({
      surface: viewport.surface,
      focused: this.inputFocused,
      captureMode: this.captureMode,
      wheelOverrideActive: overrides.wheelActive,
      canvasOverrideActive: overrides.navigationActive,
      ctrlKey: wheel.ctrlKey,
      metaKey: wheel.metaKey
    }), this.now());
    if (decision.owner === "canvas") {
      this.beginOwnerSequence(this.wheelClientPoint(tab.id, owner, input), true);
    }
    return decision;
  }

  handlePageWheel(sender: WebContents, input: unknown): void {
    const viewport = this.host.getViewport();
    const tab = this.host.getActiveTab();
    if (!this.host.isVisible() || viewport.surface === "hidden" || !tab) return;
    if (tab.view.webContents !== sender || sender.isDestroyed()) return;
    const wheel = toCanvasPageWheelInput(input);
    if (!wheel) return;
    const generation = pageWheelGeneration(input);
    const owner = generation === null ? null : this.pageSequence.touch(generation, this.now());
    if (owner === null || owner === "page") return;
    const ownerWindow = this.host.getOwner();
    if (!ownerWindow || ownerWindow.isDestroyed()) return;
    const clientPoint = this.wheelClientPoint(tab.id, ownerWindow, input);
    this.beginOwnerSequence(clientPoint);
    this.host.sendWheel({
      tabId: tab.id,
      clientX: clientPoint.x,
      clientY: clientPoint.y,
      ...wheel
    });
  }

  beginRendererSequence(input: unknown): void {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const values = input as Record<string, unknown>;
    if (!Number.isFinite(values.clientX) || !Number.isFinite(values.clientY)) return;
    const owner = this.host.getOwner();
    if (!owner || owner.isDestroyed()) return;
    const content = owner.getContentBounds();
    const clientX = values.clientX as number;
    const clientY = values.clientY as number;
    if (clientX < 0 || clientY < 0 || clientX >= content.width || clientY >= content.height) return;
    this.beginOwnerSequence({ x: clientX, y: clientY });
  }

  observeBrowserWheel(tabId: string, mouse: Electron.MouseInputEvent): void {
    if (mouse.type !== "mouseWheel") return;
    const viewport = this.host.getViewport();
    const sink = this.nativeSink?.tabId === tabId ? this.nativeSink : null;
    this.browserWheelPoint = {
      tabId,
      point: sink ? { ...sink.pointer } : { x: viewport.x + mouse.x, y: viewport.y + mouse.y },
      observedAt: this.now()
    };
  }

  beginOwnerSequence(point: Point, preserveNativeTarget = false): void {
    const viewport = this.host.getViewport();
    const tab = this.host.getActiveTab();
    if (!this.host.isVisible() || viewport.surface === "hidden" || !tab) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const transition = this.ownerSequence.begin(point, this.now());
    this.scheduleEnd();
    if (transition.started) {
      const proposedSink = preserveNativeTarget
        ? createBrowserCanvasNativeWheelSink(tab.id, viewport, point)
        : null;
      const sinkTab = proposedSink ? this.host.getTab(proposedSink.tabId) : undefined;
      this.nativeSink = proposedSink && sinkTab?.canvasSinkViewport.preserve(proposedSink.viewport)
        ? proposedSink
        : null;
      this.refreshFrame();
    }
    this.host.requestSurfaceSync();
  }

  endSequence(sync = true): void {
    if (this.sequenceTimer) {
      clearTimeout(this.sequenceTimer);
      this.sequenceTimer = null;
    }
    this.host.beforeSequenceEnd();
    const frozenTabId = this.freezeTabId;
    const wasFrozen = this.freezeActive;
    const nativeSinkTabId = this.nativeSink?.tabId ?? null;
    this.ownerSequence.end();
    this.pageSequence.reset();
    this.nativeSink = null;
    if (sync && !this.host.isDisposed()) this.host.requestSurfaceSync();
    if (nativeSinkTabId) this.host.getTab(nativeSinkTabId)?.canvasSinkViewport.restore();
    if (wasFrozen && frozenTabId && this.freezeTabId === frozenTabId) {
      this.freezeActive = false;
      this.freezeTabId = null;
      this.sendFreezeFrame(frozenTabId, false, this.frameStore.frameFor(frozenTabId));
    }
    if (this.captureAfterSequence) {
      this.captureAfterSequence = false;
      if (sync && !this.host.isDisposed() && this.host.getViewport().surface === "native") this.refreshFrame();
    }
  }

  invalidateCapture(): void {
    this.frameStore.invalidateCapture();
  }

  clear(): void {
    this.frameStore.clear();
  }

  viewportChanged(previous: BrowserViewportBounds, next: BrowserViewportBounds): void {
    if (next.surface === "hidden") {
      this.inputFocused = false;
      this.endSequence(false);
      this.invalidateCapture();
      return;
    }
    if (next.surface === "native" && (
      previous.width !== next.width
      || previous.height !== next.height
      || previous.canvasScale !== next.canvasScale
    )) {
      if (this.freezeActive) this.captureAfterSequence = true;
      else this.refreshFrame();
    }
  }

  surfaceDecision(
    tabId: string,
    visibleRectangle: BrowserCanvasRectangle | null,
    ownerSize: Size
  ): BrowserCanvasSurfaceDecision {
    if (!this.ownerSequence.shouldFreeze(visibleRectangle)) return { kind: "normal" };
    this.activateFreezeFrame(tabId);
    const layout = this.nativeSink?.tabId === tabId
      ? browserCanvasNativeWheelSinkLayout(this.nativeSink, ownerSize)
      : null;
    return layout ? { kind: "sink", layout } : { kind: "frozen" };
  }

  refreshFrame(): void {
    const viewport = this.host.getViewport();
    const tab = this.host.getActiveTab();
    if (this.host.isDisposed() || !this.host.isVisible() || viewport.surface !== "native" || !tab) return;
    if (tab.view.webContents.isDestroyed()) return;
    if (this.capturePromise) {
      this.captureQueued = true;
      return;
    }
    const token = this.frameStore.beginCapture(tab.id);
    const capture = (async (): Promise<void> => {
      try {
        const image = await tab.view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        const dataUrl = encodeBrowserCanvasFreezeFrame(image);
        if (!dataUrl) {
          this.frameStore.failCapture(token);
          return;
        }
        const frame = this.frameStore.commitCapture(token, dataUrl);
        if (!frame) return;
        this.sendFreezeFrame(frame.tabId, this.freezeActive && this.freezeTabId === frame.tabId, frame.dataUrl);
      } catch {
        this.frameStore.failCapture(token);
      }
    })();
    this.capturePromise = capture;
    void capture.finally(() => {
      if (this.capturePromise === capture) this.capturePromise = null;
      if (!this.captureQueued) return;
      this.captureQueued = false;
      this.refreshFrame();
    });
  }

  private scheduleEnd(): void {
    if (this.sequenceTimer) clearTimeout(this.sequenceTimer);
    this.sequenceTimer = setTimeout(() => {
      this.sequenceTimer = null;
      if (!this.ownerSequence.expired(this.now())) {
        this.scheduleEnd();
        return;
      }
      this.endIdleSequence();
    }, BROWSER_CANVAS_WHEEL_IDLE_MS);
  }

  private endIdleSequence(): void {
    if (this.host.shouldDeferIdleEnd()) {
      this.scheduleEnd();
      return;
    }
    this.endSequence();
  }

  private activateFreezeFrame(tabId: string): void {
    if (this.freezeActive && this.freezeTabId === tabId) return;
    this.freezeActive = true;
    this.freezeTabId = tabId;
    this.sendFreezeFrame(tabId, true, this.frameStore.frameFor(tabId));
  }

  private sendFreezeFrame(tabId: string, active: boolean, dataUrl: string | null): void {
    this.host.sendFreezeFrame({
      tabId,
      generation: ++this.freezeEventGeneration,
      active,
      dataUrl
    });
  }

  private wheelClientPoint(tabId: string, owner: BrowserWindow, input: unknown): Point {
    const contentBounds = owner.getContentBounds();
    const eventPoint = browserPageWheelClientPoint(input, {
      ownerScreenBounds: contentBounds,
      viewport: this.host.getViewport()
    });
    if (eventPoint) return eventPoint;
    const nativePoint = this.browserWheelPoint;
    if (nativePoint?.tabId === tabId && this.now() - nativePoint.observedAt < BROWSER_CANVAS_WHEEL_IDLE_MS) {
      return { ...nativePoint.point };
    }
    const pointer = this.host.getCursorScreenPoint();
    return { x: pointer.x - contentBounds.x, y: pointer.y - contentBounds.y };
  }
}

function pageWheelGeneration(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const generation = (value as Record<string, unknown>).generation;
  return Number.isInteger(generation) && (generation as number) > 0 ? generation as number : null;
}
