import type {
  BrowserViewportSurface,
  CanvasWheelCaptureMode,
  Point,
  Size
} from "../../../shared/contracts.ts";
import { shouldCanvasOwnWheel } from "../../../shared/canvasNavigation.ts";
import { BROWSER_CANVAS_WHEEL_IDLE_MS } from "./BrowserCanvasFreeze.ts";

const MAX_WHEEL_DELTA = 1_200;
const LINE_DELTA_CSS_PIXELS = 16;
export type BrowserWheelOwner = "page" | "canvas";

export interface BrowserWheelDecision {
  generation: number;
  owner: BrowserWheelOwner;
}

// Wire shape of the synchronous ownership reply. The page preload mirrors `idleMs` from this
// envelope because its sandboxed entry stays self-contained and cannot share the main-process
// constant; the decision itself keeps its own form.
export interface BrowserPageWheelReply extends BrowserWheelDecision {
  idleMs: number;
}

export interface BrowserWheelOwnershipInput {
  surface: BrowserViewportSurface;
  focused: boolean;
  captureMode: CanvasWheelCaptureMode;
  wheelOverrideActive: boolean;
  canvasOverrideActive: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface CanvasPageWheelInput {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface BrowserPageWheelPointContext {
  ownerScreenBounds: Point & Size;
  viewport: Point & Size;
}

export type BrowserCanvasNavigationPointerType = "down" | "move" | "up" | "cancel";

export function browserWheelOwner(input: BrowserWheelOwnershipInput): BrowserWheelOwner {
  return shouldCanvasOwnWheel({
    overFocusedWidget: input.focused,
    captureMode: input.captureMode,
    wheelOverrideActive: input.wheelOverrideActive,
    navigationOverrideActive: input.canvasOverrideActive,
    forceCanvas: input.surface !== "native" || input.ctrlKey || input.metaKey
  }) ? "canvas" : "page";
}

export function browserPageWheelReply(decision: BrowserWheelDecision): BrowserPageWheelReply {
  return {
    generation: decision.generation,
    owner: decision.owner,
    idleMs: BROWSER_CANVAS_WHEEL_IDLE_MS
  };
}

export class BrowserPageWheelSequence {
  private generation = 0;
  private owner: BrowserWheelOwner | null = null;
  private lastWheelAt = 0;

  decide(requestedOwner: BrowserWheelOwner, now: number): BrowserWheelDecision {
    if (this.owner !== null && now - this.lastWheelAt < BROWSER_CANVAS_WHEEL_IDLE_MS) {
      this.lastWheelAt = now;
      return { generation: this.generation, owner: this.owner };
    }
    this.generation += 1;
    this.owner = requestedOwner;
    this.lastWheelAt = now;
    return { generation: this.generation, owner: requestedOwner };
  }

  touch(generation: number, now: number): BrowserWheelOwner | null {
    if (
      this.owner === null
      || generation !== this.generation
      || now - this.lastWheelAt >= BROWSER_CANVAS_WHEEL_IDLE_MS
    ) return null;
    this.lastWheelAt = now;
    return this.owner;
  }

  reset(): void {
    this.owner = null;
    this.lastWheelAt = 0;
  }
}

export function browserCanvasNavigationPointerType(
  input: { type: string; button?: string },
  canvasOverrideActive: boolean,
  gestureOwnedByCanvas: boolean,
  options: {
    mouseBindingActive?: boolean;
    activeButton?: string | null;
  } = {}
): BrowserCanvasNavigationPointerType | null {
  if (!gestureOwnedByCanvas) {
    const startsCanvasGesture = input.type === "mouseDown" && (
      input.button === "middle"
      || (input.button === "left" && canvasOverrideActive)
      || options.mouseBindingActive === true
    );
    return startsCanvasGesture ? "down" : null;
  }
  if (input.type === "mouseEnter" || input.type === "mouseMove") return "move";
  const activeButton = options.activeButton === undefined ? "left" : options.activeButton;
  if (input.type === "mouseUp" && (activeButton === null || input.button === activeButton)) return "up";
  return null;
}

export function toCanvasPageWheelInput(value: unknown): CanvasPageWheelInput | null {
  if (!isRecord(value)) return null;
  const deltaX = finiteNumber(value.deltaX);
  const deltaY = finiteNumber(value.deltaY);
  const deltaMode = finiteNumber(value.deltaMode);
  const viewportWidth = finiteNumber(value.viewportWidth);
  const viewportHeight = finiteNumber(value.viewportHeight);
  const ctrlKey = booleanValue(value.ctrlKey);
  const metaKey = booleanValue(value.metaKey);
  if (
    deltaX === null || deltaY === null || deltaMode === null
    || viewportWidth === null || viewportHeight === null
    || ctrlKey === null || metaKey === null
    || !Number.isInteger(deltaMode) || deltaMode < 0 || deltaMode > 2
    || viewportWidth <= 0 || viewportHeight <= 0
  ) return null;

  const scaleX = deltaMode === 1 ? LINE_DELTA_CSS_PIXELS : deltaMode === 2 ? viewportWidth : 1;
  const scaleY = deltaMode === 1 ? LINE_DELTA_CSS_PIXELS : deltaMode === 2 ? viewportHeight : 1;
  const normalizedX = clampDelta(deltaX * scaleX);
  const normalizedY = clampDelta(deltaY * scaleY);
  if (normalizedX === 0 && normalizedY === 0) return null;
  return { deltaX: normalizedX, deltaY: normalizedY, ctrlKey, metaKey };
}

export function browserPageWheelClientPoint(
  value: unknown,
  context: BrowserPageWheelPointContext
): Point | null {
  if (!isRecord(value) || !rectangleIsFinite(context.ownerScreenBounds) || !rectangleIsFinite(context.viewport)) {
    return null;
  }

  const screenX = finiteNumber(value.screenX);
  const screenY = finiteNumber(value.screenY);
  if (screenX !== null && screenY !== null) {
    const point = {
      x: screenX - context.ownerScreenBounds.x,
      y: screenY - context.ownerScreenBounds.y
    };
    if (pointInsideSize(point, context.ownerScreenBounds)) return point;
  }

  if (value.topFrame !== true) return null;
  const clientX = finiteNumber(value.clientX);
  const clientY = finiteNumber(value.clientY);
  const viewportWidth = finiteNumber(value.viewportWidth);
  const viewportHeight = finiteNumber(value.viewportHeight);
  if (
    clientX === null || clientY === null
    || viewportWidth === null || viewportHeight === null
    || clientX < 0 || clientY < 0
    || viewportWidth <= 0 || viewportHeight <= 0
    || clientX >= viewportWidth || clientY >= viewportHeight
    || context.viewport.width <= 0 || context.viewport.height <= 0
  ) return null;
  return {
    x: context.viewport.x + clientX * context.viewport.width / viewportWidth,
    y: context.viewport.y + clientY * context.viewport.height / viewportHeight
  };
}

function clampDelta(delta: number): number {
  return Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, delta));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rectangleIsFinite(value: Point & Size): boolean {
  return Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.width)
    && Number.isFinite(value.height);
}

function pointInsideSize(point: Point, size: Size): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < size.width && point.y < size.height;
}
