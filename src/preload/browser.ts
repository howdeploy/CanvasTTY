import { ipcRenderer } from "electron";
import { BrowserHistorySwipe, type HistoryDirection } from "./BrowserHistorySwipe.ts";

const BROWSER_PAGE_WHEEL_CHANNEL = "browser:page-wheel";
const BROWSER_PAGE_WHEEL_DECISION_CHANNEL = "browser:page-wheel-decision";
type NativeHistoryGesture = { id: number; phase: "active" | "ended" | "cancelled"; claimed: boolean };
type BrowserWheelDecision = {
  generation: number;
  owner: "page" | "canvas";
  canGoBack?: boolean;
  canGoForward?: boolean;
  nativeGesture?: NativeHistoryGesture | null;
};

// Main owns the wheel idle boundary and reports it in the ownership reply, so this sandboxed
// entry mirrors the value instead of duplicating the constant. A reply without a usable window
// keeps asking main on every event: main latches the sequence itself, so that fallback costs
// round-trips but never wrong ownership.
let wheelIdleMs: number | null = null;
const historySwipe = new BrowserHistorySwipe();
let swipeTimer: ReturnType<typeof setTimeout> | null = null;
let navigationFrame: number | null = null;
let indicator: HTMLDivElement | null = null;
let indicatorArrow: HTMLDivElement | null = null;
let fadingIndicator: HTMLDivElement | null = null;
let fadeTimer: ReturnType<typeof setTimeout> | null = null;
let nativeGesture: NativeHistoryGesture | null = null;
let latestWheel: { input: Record<string, unknown>; generation: number } | null = null;
let wheelDecision: (BrowserWheelDecision & { lastEventAt: number }) | null = null;

window.addEventListener("wheel", (event) => {
  if (!event.isTrusted) return;
  const now = performance.now();
  const input = {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    topFrame: window === window.top,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
  };
  if (!wheelDecision || wheelIdleMs === null || now - wheelDecision.lastEventAt >= wheelIdleMs) {
    if (!nativeGesture || nativeGesture.phase !== "active") {
      cancelHistorySwipe();
      historySwipe.reset();
    }
    const value = ipcRenderer.sendSync(BROWSER_PAGE_WHEEL_DECISION_CHANNEL, input);
    wheelIdleMs = browserWheelIdleMs(value);
    wheelDecision = isBrowserWheelDecision(value)
      ? { ...value, lastEventAt: now }
      : { generation: 0, owner: "canvas", lastEventAt: now };
  } else {
    wheelDecision.lastEventAt = now;
  }
  const decision = wheelDecision;
  if (decision.nativeGesture && (!nativeGesture || nativeGesture.id !== decision.nativeGesture.id)) {
    acceptNativeGesture(decision.nativeGesture);
  }
  latestWheel = { input, generation: decision.generation };
  if (decision.owner === "canvas") {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  if (decision.owner === "page") {
    const preview = !nativeGesture || nativeGesture.phase === "active" ? historySwipe.update({
      ...input,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      canGoBack: decision.canGoBack === true,
      canGoForward: decision.canGoForward === true,
      scrollable: canScrollHorizontally(event)
    }) : null;
    if (preview || (nativeGesture && nativeGesture.phase !== "active"
      && (historySwipe.claimed || nativeGesture.claimed))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (preview) showHistoryIndicator(preview.direction, preview.progress);
    }
    if (swipeTimer) clearTimeout(swipeTimer);
    if (!nativeGesture) {
      swipeTimer = setTimeout(finishHistorySwipe, Math.min(120, (wheelIdleMs ?? 250) / 2));
    }
  } else {
    cancelHistorySwipe();
  }
  ipcRenderer.send(BROWSER_PAGE_WHEEL_CHANNEL, {
    ...input,
    generation: decision.generation,
    nativeGestureId: nativeGesture?.id,
    historySwipeClaimed: historySwipe.claimed
  });
}, { capture: true, passive: false });

ipcRenderer.on("browser:history-gesture", (_event, value: unknown) => {
  if (value === null) {
    cancelHistorySwipe();
    historySwipe.reset();
    nativeGesture = null;
    wheelDecision = null;
    latestWheel = null;
    return;
  }
  if (!value || typeof value !== "object") return;
  const gesture = value as NativeHistoryGesture;
  if (!Number.isSafeInteger(gesture.id) || gesture.id <= 0
    || !["active", "ended", "cancelled"].includes(gesture.phase)) return;
  acceptNativeGesture(gesture);
});

function acceptNativeGesture(gesture: NativeHistoryGesture): void {
  if (nativeGesture && gesture.id < nativeGesture.id) return;
  const changed = !nativeGesture || nativeGesture.id !== gesture.id;
  if (gesture.phase === "active" && changed) {
    cancelHistorySwipe();
    historySwipe.reset();
    wheelDecision = null;
    latestWheel = null;
  }
  const ended = !changed && nativeGesture?.phase !== "active";
  nativeGesture = gesture;
  if (gesture.phase === "cancelled") cancelHistorySwipe();
  else if (gesture.phase === "ended" && !ended) finishHistorySwipe();
}

function finishHistorySwipe(): void {
  if (swipeTimer) clearTimeout(swipeTimer);
  swipeTimer = null;
  const direction = historySwipe.finish();
  dismissHistoryIndicator(true);
  const wheel = latestWheel;
  const nativeGestureId = nativeGesture?.id;
  if (!direction || !wheel) return;
  // Start painting the dismissal before dispatch; navigation does not wait for the 150 ms fade.
  navigationFrame = requestAnimationFrame(() => {
    navigationFrame = requestAnimationFrame(() => {
      navigationFrame = null;
      if (!document.hasFocus() || document.visibilityState !== "visible") return;
      ipcRenderer.send(BROWSER_PAGE_WHEEL_CHANNEL, {
        ...wheel.input, generation: wheel.generation, historySwipe: direction, nativeGestureId
      });
    });
  });
}

function isBrowserWheelDecision(value: unknown): value is BrowserWheelDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const decision = value as Record<string, unknown>;
  return Number.isInteger(decision.generation)
    && (decision.generation as number) > 0
    && (decision.owner === "page" || decision.owner === "canvas");
}

function browserWheelIdleMs(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const idleMs = (value as Record<string, unknown>).idleMs;
  return typeof idleMs === "number" && Number.isFinite(idleMs) && idleMs > 0 ? idleMs : null;
}

function cancelHistorySwipe(): void {
  if (navigationFrame !== null) cancelAnimationFrame(navigationFrame);
  navigationFrame = null;
  if (swipeTimer) clearTimeout(swipeTimer);
  swipeTimer = null;
  historySwipe.finish();
  dismissHistoryIndicator(false);
}

function clearFadingIndicator(): void {
  if (fadeTimer) clearTimeout(fadeTimer);
  fadeTimer = null;
  fadingIndicator?.remove();
  fadingIndicator = null;
}

function dismissHistoryIndicator(animate: boolean): void {
  clearFadingIndicator();
  const current = indicator;
  indicator = null;
  indicatorArrow = null;
  if (!current) return;
  if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    current.remove();
    return;
  }
  fadingIndicator = current;
  current.style.setProperty("transition", "opacity 150ms ease-out", "important");
  current.style.setProperty("opacity", "0", "important");
  fadeTimer = setTimeout(clearFadingIndicator, 150);
}

window.addEventListener("blur", cancelHistorySwipe);
window.addEventListener("pagehide", cancelHistorySwipe);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") cancelHistorySwipe();
});

function canScrollHorizontally(event: WheelEvent): boolean {
  const elements = new Set<Element>();
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) continue;
    elements.add(target);
  }
  if (document.scrollingElement) elements.add(document.scrollingElement);
  for (const element of elements) {
    const style = getComputedStyle(element);
    if (style.overscrollBehaviorX === "contain" || style.overscrollBehaviorX === "none") return true;
    if (element.scrollWidth <= element.clientWidth + 1) continue;
    if (element !== document.scrollingElement && !/^(auto|scroll|overlay)$/.test(style.overflowX)) continue;
    const max = element.scrollWidth - element.clientWidth;
    const position = style.direction === "rtl" ? max + element.scrollLeft : element.scrollLeft;
    if (event.deltaX < 0 ? position > 1 : position < max - 1) return true;
  }
  return false;
}

function showHistoryIndicator(direction: HistoryDirection, progress: number): void {
  clearFadingIndicator();
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.setAttribute("aria-hidden", "true");
    indicator.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;";
    const shadow = indicator.attachShadow({ mode: "closed" });
    const arrow = document.createElement("div");
    arrow.style.cssText = "position:absolute;top:50%;display:grid;place-items:center;width:42px;height:104px;background:#2e68c7;color:white;font:700 38px/1 system-ui;box-shadow:0 2px 12px #0003;pointer-events:none;";
    shadow.append(arrow);
    document.documentElement.append(indicator);
    // Retain the closed-shadow child without exposing it to the remote page.
    indicatorArrow = arrow;
  }
  const arrow = indicatorArrow;
  if (!arrow) return;
  const back = direction === "back";
  arrow.textContent = back ? "←" : "→";
  arrow.style.left = back ? "0" : "auto";
  arrow.style.right = back ? "auto" : "0";
  arrow.style.borderRadius = back ? "0 12px 12px 0" : "12px 0 0 12px";
  arrow.style.opacity = String(0.45 + progress * 0.55);
  arrow.style.transform = `translate(${(back ? -1 : 1) * (1 - progress) * 32}px, -50%)`;
}
