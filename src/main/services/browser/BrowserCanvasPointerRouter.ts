import type { BrowserWindow, WebContentsView } from "electron";
import type {
  BrowserCanvasNavigationPointerEvent,
  BrowserViewportBounds,
  Point
} from "../../../shared/contracts.ts";
import type { BrowserCanvasNativeWheelSink } from "./BrowserCanvasFreeze.ts";
import {
  BrowserCanvasCursorController,
  browserCanvasNavigationCursor
} from "./BrowserCanvasCursor.ts";
import { browserCanvasNavigationPointerType } from "./BrowserCanvasWheel.ts";

export interface BrowserCanvasPointerTab {
  id: string;
  view: WebContentsView;
  canvasCursor: BrowserCanvasCursorController;
}

export interface BrowserCanvasPointerRouterHost {
  getOwner(): BrowserWindow | null;
  getViewport(): BrowserViewportBounds;
  getTab(tabId: string): BrowserCanvasPointerTab | undefined;
  getTabs(): Iterable<BrowserCanvasPointerTab>;
  getNativeWheelSink(): BrowserCanvasNativeWheelSink | null;
  getFrozenTabId(): string | null;
  isFreezeActive(): boolean;
  isNavigationOverrideActive(): boolean;
  ownsNavigationMouseButton?(button: string | undefined): boolean;
  getCursorScreenPoint(): Point;
  endWheelSequence(): void;
  sendNavigationPointer(payload: BrowserCanvasNavigationPointerEvent): void;
}

interface PointerRelay {
  tabId: string;
  button: NonNullable<Electron.MouseInputEvent["button"]>;
  clickCount: number;
  lastClient: Point;
}

interface NativeSinkPointerRelay extends PointerRelay {
  target: "browser" | "owner";
}

export class BrowserCanvasPointerRouter {
  private readonly host: BrowserCanvasPointerRouterHost;
  private canvasDragTabId: string | null = null;
  private canvasDragButton: string | null = null;
  private rendererGestureActive = false;
  private navigationActive = false;
  private freezePointerRelay: PointerRelay | null = null;
  private nativeSinkPointerRelay: NativeSinkPointerRelay | null = null;

  constructor(host: BrowserCanvasPointerRouterHost) {
    this.host = host;
  }

  get hasFreezePointerRelay(): boolean {
    return this.freezePointerRelay !== null;
  }

  setNavigationActive(active: boolean): void {
    if (this.navigationActive === active) return;
    this.navigationActive = active;
    this.syncCursors();
  }

  setRendererGestureActive(active: boolean): void {
    if (this.rendererGestureActive === active) return;
    this.rendererGestureActive = active;
    this.syncCursors();
  }

  cancelNavigationGesture(): void {
    const hadRendererGesture = this.rendererGestureActive;
    this.rendererGestureActive = false;
    if (this.canvasDragTabId !== null) this.cancelCanvasDrag(this.canvasDragTabId);
    else if (hadRendererGesture) this.syncCursors();
  }

  cancelTab(tabId: string): void {
    this.cancelCanvasDrag(tabId);
    if (this.freezePointerRelay?.tabId === tabId) this.cancelFreezePointerRelay();
    if (this.nativeSinkPointerRelay?.tabId === tabId) this.cancelNativeSinkPointerRelay();
  }

  cancelSequenceRelays(): void {
    this.cancelFreezePointerRelay();
    this.cancelNativeSinkPointerRelay();
  }

  handleBrowserMouse(
    tab: BrowserCanvasPointerTab,
    owner: BrowserWindow,
    event: Electron.Event,
    mouse: Electron.MouseInputEvent
  ): boolean {
    const sink = this.host.getNativeWheelSink();
    const activeSink = sink?.tabId === tab.id ? sink : null;
    const mouseClientPoint = activeSink
      ? this.ownerPointerClientPoint(owner, activeSink.pointer, mouse)
      : { x: this.host.getViewport().x + mouse.x, y: this.host.getViewport().y + mouse.y };
    const pointerType = browserCanvasNavigationPointerType(
      mouse,
      this.host.isNavigationOverrideActive(),
      this.canvasDragTabId === tab.id || this.rendererGestureActive,
      {
        mouseBindingActive: this.host.ownsNavigationMouseButton?.(mouse.button as string | undefined) ?? false,
        activeButton: this.canvasDragTabId === tab.id ? this.canvasDragButton : null
      }
    );
    if (pointerType) {
      if (pointerType === "down") {
        this.canvasDragTabId = tab.id;
        this.canvasDragButton = mouse.button ?? "left";
        this.syncCursors();
      }
      if (pointerType === "up" || pointerType === "cancel") {
        this.canvasDragTabId = null;
        this.canvasDragButton = null;
        this.rendererGestureActive = false;
        this.syncCursors();
      }
      event.preventDefault();
      this.host.sendNavigationPointer({
        tabId: tab.id,
        type: pointerType,
        clientX: mouseClientPoint.x,
        clientY: mouseClientPoint.y
      });
      return true;
    }
    if ((this.canvasDragTabId === tab.id || this.rendererGestureActive) && mouse.type === "mouseLeave") {
      event.preventDefault();
      return true;
    }
    return this.relayNativeSinkFromBrowser(event, mouse, owner, tab);
  }

  handleOwnerMouse(
    event: Electron.Event,
    mouse: Electron.MouseInputEvent,
    owner: BrowserWindow
  ): boolean {
    if (this.relayNativeSinkFromOwner(event, mouse, owner)) return true;
    if (this.relayFreezeFromOwner(event, mouse)) return true;
    return this.relayCanvasDragFromOwner(event, mouse);
  }

  private cancelCanvasDrag(tabId: string): void {
    if (this.canvasDragTabId !== tabId) return;
    this.canvasDragTabId = null;
    this.canvasDragButton = null;
    this.syncCursors();
    this.host.sendNavigationPointer({
      tabId,
      type: "cancel",
      clientX: 0,
      clientY: 0
    });
  }

  private syncCursors(): void {
    for (const tab of this.host.getTabs()) {
      tab.canvasCursor.set(browserCanvasNavigationCursor(
        this.navigationActive,
        this.canvasDragTabId === tab.id || this.rendererGestureActive
      ));
    }
  }

  private relayFreezeFromOwner(event: Electron.Event, mouse: Electron.MouseInputEvent): boolean {
    const relay = this.freezePointerRelay;
    if (relay) {
      if (!freezePointerEvent(mouse)) return false;
      event.preventDefault();
      relay.lastClient = { x: mouse.x, y: mouse.y };
      if (mouse.type === "mouseLeave") {
        this.cancelFreezePointerRelay();
        this.host.endWheelSequence();
        return true;
      }
      this.sendFreezePointerInput(relay.tabId, mouse, relay.button, relay.clickCount);
      if (mouse.type === "mouseUp" && mouse.button === relay.button) {
        this.freezePointerRelay = null;
        this.host.endWheelSequence();
      }
      return true;
    }
    if (
      this.navigationActive
      || this.host.isNavigationOverrideActive()
      || this.rendererGestureActive
      || this.canvasDragTabId !== null
    ) return false;
    const frozenTabId = this.host.getFrozenTabId();
    if (!this.host.isFreezeActive() || frozenTabId === null || !this.pointInsideViewport(mouse)) return false;
    if (mouse.type === "contextMenu") {
      event.preventDefault();
      this.sendFreezePointerInput(frozenTabId, mouse, mouse.button ?? "right", mouse.clickCount ?? 1);
      return true;
    }
    if (mouse.type !== "mouseDown" || mouse.button === undefined) return false;
    const tab = this.host.getTab(frozenTabId);
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    event.preventDefault();
    const clickCount = Math.max(1, mouse.clickCount ?? 1);
    tab.view.webContents.focus();
    this.freezePointerRelay = {
      tabId: tab.id,
      button: mouse.button,
      clickCount,
      lastClient: { x: mouse.x, y: mouse.y }
    };
    this.sendFreezePointerInput(tab.id, mouse, mouse.button, clickCount);
    return true;
  }

  private sendFreezePointerInput(
    tabId: string,
    mouse: Electron.MouseInputEvent,
    button: PointerRelay["button"],
    clickCount: number
  ): void {
    const tab = this.host.getTab(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const viewport = this.host.getViewport();
    sendPointerInput(
      tab.view.webContents,
      mouse,
      { button, clickCount },
      { x: mouse.x - viewport.x, y: mouse.y - viewport.y }
    );
  }

  private cancelFreezePointerRelay(): void {
    const relay = this.freezePointerRelay;
    if (!relay) return;
    this.freezePointerRelay = null;
    const tab = this.host.getTab(relay.tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const viewport = this.host.getViewport();
    sendPointerInput(
      tab.view.webContents,
      { type: "mouseUp", modifiers: [] },
      relay,
      { x: relay.lastClient.x - viewport.x, y: relay.lastClient.y - viewport.y }
    );
  }

  private relayNativeSinkFromBrowser(
    event: Electron.Event,
    mouse: Electron.MouseInputEvent,
    owner: BrowserWindow,
    tab: BrowserCanvasPointerTab
  ): boolean {
    const relay = this.nativeSinkPointerRelay;
    if (relay?.tabId === tab.id) {
      if (relay.target === "browser") {
        if (mouse.type === "mouseUp" && mouse.button === relay.button) this.nativeSinkPointerRelay = null;
        return false;
      }
      if (!nativeWheelSinkPointerEvent(mouse)) return false;
      event.preventDefault();
      const point = this.ownerPointerClientPoint(owner, relay.lastClient, mouse);
      relay.lastClient = point;
      this.sendPointerToOwner(owner, mouse, relay, point);
      if (mouse.type === "mouseUp" && mouse.button === relay.button) this.nativeSinkPointerRelay = null;
      return true;
    }

    const sink = this.host.getNativeWheelSink();
    if (
      !sink
      || sink.tabId !== tab.id
      || (mouse.type !== "mouseDown" && mouse.type !== "contextMenu")
      || mouse.button === undefined
    ) return false;

    event.preventDefault();
    const point = this.ownerPointerClientPoint(owner, sink.pointer, mouse);
    this.host.endWheelSequence();
    const target = this.host.getViewport().surface === "native" && this.pointInsideViewport(point)
      ? "browser"
      : "owner";
    const nextRelay: NativeSinkPointerRelay = {
      tabId: tab.id,
      target,
      button: mouse.button,
      clickCount: Math.max(1, mouse.clickCount ?? 1),
      lastClient: point
    };
    if (mouse.type === "mouseDown") this.nativeSinkPointerRelay = nextRelay;
    if (target === "browser") this.sendPointerToBrowser(tab, mouse, nextRelay, point);
    else this.sendPointerToOwner(owner, mouse, nextRelay, point);
    return true;
  }

  private relayNativeSinkFromOwner(
    event: Electron.Event,
    mouse: Electron.MouseInputEvent,
    owner: BrowserWindow
  ): boolean {
    const relay = this.nativeSinkPointerRelay;
    if (!relay || !nativeWheelSinkPointerEvent(mouse)) return false;
    const point = this.ownerPointerClientPoint(owner, relay.lastClient, mouse);
    relay.lastClient = point;
    if (relay.target === "owner") {
      if (mouse.type === "mouseUp" && mouse.button === relay.button) this.nativeSinkPointerRelay = null;
      return false;
    }
    event.preventDefault();
    const tab = this.host.getTab(relay.tabId);
    if (tab && !tab.view.webContents.isDestroyed()) this.sendPointerToBrowser(tab, mouse, relay, point);
    if (mouse.type === "mouseUp" && mouse.button === relay.button) this.nativeSinkPointerRelay = null;
    return true;
  }

  private sendPointerToBrowser(
    tab: BrowserCanvasPointerTab,
    mouse: Electron.MouseInputEvent,
    relay: NativeSinkPointerRelay,
    point: Point
  ): void {
    const viewport = this.host.getViewport();
    sendPointerInput(
      tab.view.webContents,
      mouse,
      relay,
      { x: point.x - viewport.x, y: point.y - viewport.y }
    );
  }

  private sendPointerToOwner(
    owner: BrowserWindow,
    mouse: Electron.MouseInputEvent,
    relay: NativeSinkPointerRelay,
    point: Point
  ): void {
    sendPointerInput(owner.webContents, mouse, relay, point);
  }

  private cancelNativeSinkPointerRelay(): void {
    const relay = this.nativeSinkPointerRelay;
    if (!relay) return;
    this.nativeSinkPointerRelay = null;
    const owner = this.host.getOwner();
    if (!owner || owner.isDestroyed()) return;
    const mouseUp: Electron.MouseInputEvent = {
      type: "mouseUp",
      x: relay.lastClient.x,
      y: relay.lastClient.y,
      button: relay.button,
      clickCount: relay.clickCount,
      modifiers: []
    };
    if (relay.target === "browser") {
      const tab = this.host.getTab(relay.tabId);
      if (tab && !tab.view.webContents.isDestroyed()) this.sendPointerToBrowser(tab, mouseUp, relay, relay.lastClient);
    } else {
      this.sendPointerToOwner(owner, mouseUp, relay, relay.lastClient);
    }
  }

  private ownerPointerClientPoint(
    owner: BrowserWindow,
    fallback: Point,
    mouse?: Electron.MouseInputEvent
  ): Point {
    const globalX = mouse?.globalX;
    const globalY = mouse?.globalY;
    const pointer = typeof globalX === "number" && Number.isFinite(globalX)
      && typeof globalY === "number" && Number.isFinite(globalY)
      ? { x: globalX, y: globalY }
      : this.host.getCursorScreenPoint();
    const content = owner.getContentBounds();
    const point = { x: pointer.x - content.x, y: pointer.y - content.y };
    return point.x >= 0 && point.y >= 0 && point.x < content.width && point.y < content.height
      ? point
      : { ...fallback };
  }

  private pointInsideViewport(point: Point): boolean {
    const viewport = this.host.getViewport();
    return point.x >= viewport.x
      && point.y >= viewport.y
      && point.x < viewport.x + viewport.width
      && point.y < viewport.y + viewport.height;
  }

  private relayCanvasDragFromOwner(
    event: Electron.Event,
    mouse: Electron.MouseInputEvent
  ): boolean {
    const tabId = this.canvasDragTabId;
    if (tabId === null) return false;
    const type = mouse.type === "mouseMove"
      ? "move"
      : mouse.type === "mouseUp" && (
        this.canvasDragButton === null || mouse.button === this.canvasDragButton
      )
        ? "up"
        : mouse.type === "mouseLeave"
          ? "cancel"
          : null;
    if (type === null) return false;
    if (type === "up" || type === "cancel") {
      this.canvasDragTabId = null;
      this.canvasDragButton = null;
      this.syncCursors();
    }
    event.preventDefault();
    this.host.sendNavigationPointer({
      tabId,
      type,
      clientX: mouse.x,
      clientY: mouse.y
    });
    return true;
  }
}

function freezePointerEvent(mouse: Electron.MouseInputEvent): boolean {
  return mouse.type === "mouseMove"
    || mouse.type === "mouseUp"
    || mouse.type === "mouseLeave"
    || mouse.type === "contextMenu";
}

function nativeWheelSinkPointerEvent(mouse: Electron.MouseInputEvent): boolean {
  return mouse.type === "mouseDown"
    || mouse.type === "mouseUp"
    || mouse.type === "mouseMove"
    || mouse.type === "mouseEnter"
    || mouse.type === "mouseLeave"
    || mouse.type === "contextMenu";
}

function sendPointerInput(
  contents: { sendInputEvent(event: Electron.MouseInputEvent): void },
  mouse: Pick<Electron.MouseInputEvent, "type" | "modifiers">,
  relay: Pick<PointerRelay, "button" | "clickCount">,
  point: Point
): void {
  contents.sendInputEvent({
    type: mouse.type,
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: relay.button,
    clickCount: relay.clickCount,
    modifiers: mouse.modifiers
  });
}
