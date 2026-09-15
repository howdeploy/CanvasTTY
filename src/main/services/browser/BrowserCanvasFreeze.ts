import type { Point, Size } from "../../../shared/contracts.ts";

export const BROWSER_CANVAS_FREEZE_GUARD_DIP = 4;
export const BROWSER_CANVAS_NATIVE_WHEEL_SINK_SIZE_DIP = 4;
// Sole owner of the wheel idle boundary: BrowserCanvasWheel hands this value to the page
// preload in its ownership reply, and the preload keeps no copy of its own.
export const BROWSER_CANVAS_WHEEL_IDLE_MS = 250;
export const BROWSER_CANVAS_FREEZE_MAX_BYTES = Math.floor(1.5 * 1024 * 1024);

export interface BrowserCanvasRectangle extends Point, Size {}

interface BrowserCanvasWheelSequenceState {
  active: boolean;
  collisionLatched: boolean;
  lastWheelAt: number;
  pointer: Point | null;
}

export interface BrowserCanvasFreezeCaptureToken {
  tabId: string;
  generation: number;
}

export interface BrowserCanvasNativeWheelSink {
  tabId: string;
  pointer: Point;
  viewport: BrowserCanvasRectangle;
}

export interface BrowserCanvasNativeWheelSinkLayout {
  clip: BrowserCanvasRectangle;
  view: BrowserCanvasRectangle;
}

export interface BrowserCanvasFreezeImage {
  getSize(): Size;
  resize(options: { width: number; height: number; quality?: "good" }): BrowserCanvasFreezeImage;
  toJPEG(quality: number): Buffer;
}

export class BrowserCanvasWheelSequence {
  private state: BrowserCanvasWheelSequenceState = {
    active: false,
    collisionLatched: false,
    lastWheelAt: 0,
    pointer: null
  };

  begin(pointer: Point, now: number): { started: boolean } {
    const started = !this.state.active;
    this.state = {
      active: true,
      collisionLatched: started ? false : this.state.collisionLatched,
      lastWheelAt: now,
      pointer: { ...pointer }
    };
    return { started };
  }

  shouldFreeze(rectangle: BrowserCanvasRectangle | null): boolean {
    if (!this.state.active) return false;
    if (this.state.collisionLatched) return true;
    if (!rectangle || !this.state.pointer) return false;
    if (!pointInsideExpandedRectangle(this.state.pointer, rectangle, BROWSER_CANVAS_FREEZE_GUARD_DIP)) {
      return false;
    }
    this.state = { ...this.state, collisionLatched: true };
    return true;
  }

  expired(now: number): boolean {
    return this.state.active && now - this.state.lastWheelAt >= BROWSER_CANVAS_WHEEL_IDLE_MS;
  }

  end(): boolean {
    if (!this.state.active && !this.state.collisionLatched && this.state.pointer === null) return false;
    this.state = {
      ...this.state,
      active: false,
      collisionLatched: false,
      lastWheelAt: 0,
      pointer: null
    };
    return true;
  }
}

export class BrowserCanvasFreezeFrameStore {
  private captureGeneration = 0;
  private latestRequest: BrowserCanvasFreezeCaptureToken | null = null;
  private frame: { tabId: string; dataUrl: string } | null = null;

  beginCapture(tabId: string): BrowserCanvasFreezeCaptureToken {
    const token = { tabId, generation: ++this.captureGeneration };
    this.latestRequest = token;
    return token;
  }

  commitCapture(token: BrowserCanvasFreezeCaptureToken, dataUrl: string): { tabId: string; dataUrl: string } | null {
    if (!this.isCurrent(token)) return null;
    this.latestRequest = null;
    this.frame = { tabId: token.tabId, dataUrl };
    return { ...this.frame };
  }

  failCapture(token: BrowserCanvasFreezeCaptureToken): void {
    if (this.isCurrent(token)) this.latestRequest = null;
  }

  invalidateCapture(): void {
    this.latestRequest = null;
    this.captureGeneration += 1;
  }

  frameFor(tabId: string): string | null {
    return this.frame?.tabId === tabId ? this.frame.dataUrl : null;
  }

  clear(): void {
    this.latestRequest = null;
    this.frame = null;
    this.captureGeneration += 1;
  }

  private isCurrent(token: BrowserCanvasFreezeCaptureToken): boolean {
    return this.latestRequest?.tabId === token.tabId
      && this.latestRequest.generation === token.generation;
  }
}

export function browserVisibleRectangle(
  viewport: BrowserCanvasRectangle,
  content: Size
): BrowserCanvasRectangle | null {
  const left = Math.max(0, viewport.x);
  const top = Math.max(0, viewport.y);
  const right = Math.min(content.width, viewport.x + viewport.width);
  const bottom = Math.min(content.height, viewport.y + viewport.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function createBrowserCanvasNativeWheelSink(
  tabId: string,
  viewport: BrowserCanvasRectangle,
  pointer: Point
): BrowserCanvasNativeWheelSink | null {
  if (
    !tabId
    || !rectangleIsFinite(viewport)
    || viewport.width <= 0
    || viewport.height <= 0
    || !pointIsFinite(pointer)
    || !pointInsideRectangle(pointer, viewport)
  ) return null;
  return {
    tabId,
    pointer: { ...pointer },
    viewport: { ...viewport }
  };
}

export function browserCanvasNativeWheelSinkLayout(
  sink: BrowserCanvasNativeWheelSink,
  content: Size
): BrowserCanvasNativeWheelSinkLayout | null {
  if (!sizeIsFinite(content) || content.width <= 0 || content.height <= 0) return null;
  const contentWidth = Math.floor(content.width);
  const contentHeight = Math.floor(content.height);
  if (
    contentWidth <= 0
    || contentHeight <= 0
    || !pointInsideRectangle(sink.pointer, { x: 0, y: 0, width: contentWidth, height: contentHeight })
  ) return null;

  const width = Math.min(BROWSER_CANVAS_NATIVE_WHEEL_SINK_SIZE_DIP, contentWidth);
  const height = Math.min(BROWSER_CANVAS_NATIVE_WHEEL_SINK_SIZE_DIP, contentHeight);
  const x = Math.min(
    contentWidth - width,
    Math.max(0, Math.floor(sink.pointer.x) - Math.floor(width / 2))
  );
  const y = Math.min(
    contentHeight - height,
    Math.max(0, Math.floor(sink.pointer.y) - Math.floor(height / 2))
  );
  return {
    clip: { x, y, width, height },
    view: { x: 0, y: 0, width, height }
  };
}

export function encodeBrowserCanvasFreezeFrame(image: BrowserCanvasFreezeImage): string | null {
  let current = image;
  let bytes = current.toJPEG(70);
  for (let attempt = 0; bytes.byteLength > BROWSER_CANVAS_FREEZE_MAX_BYTES && attempt < 4; attempt += 1) {
    const size = current.getSize();
    const scale = Math.min(0.85, Math.sqrt(BROWSER_CANVAS_FREEZE_MAX_BYTES / bytes.byteLength) * 0.9);
    current = current.resize({
      width: Math.max(160, Math.floor(size.width * scale)),
      height: Math.max(100, Math.floor(size.height * scale)),
      quality: "good"
    });
    bytes = current.toJPEG([65, 50, 35, 25][attempt] ?? 25);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > BROWSER_CANVAS_FREEZE_MAX_BYTES) return null;
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function pointInsideExpandedRectangle(point: Point, rectangle: BrowserCanvasRectangle, guard: number): boolean {
  return point.x >= rectangle.x - guard
    && point.y >= rectangle.y - guard
    && point.x < rectangle.x + rectangle.width + guard
    && point.y < rectangle.y + rectangle.height + guard;
}

function pointInsideRectangle(point: Point, rectangle: BrowserCanvasRectangle): boolean {
  return point.x >= rectangle.x
    && point.y >= rectangle.y
    && point.x < rectangle.x + rectangle.width
    && point.y < rectangle.y + rectangle.height;
}

function pointIsFinite(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function sizeIsFinite(size: Size): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height);
}

function rectangleIsFinite(rectangle: BrowserCanvasRectangle): boolean {
  return pointIsFinite(rectangle) && sizeIsFinite(rectangle);
}
