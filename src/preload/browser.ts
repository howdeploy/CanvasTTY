import { ipcRenderer } from "electron";
import { BrowserHistorySwipe, type HistoryDirection } from "./BrowserHistorySwipe.ts";

const BROWSER_PAGE_WHEEL_CHANNEL = "browser:page-wheel";
const BROWSER_PAGE_WHEEL_DECISION_CHANNEL = "browser:page-wheel-decision";
type BrowserWheelDecision = {
  generation: number;
  owner: "page" | "canvas";
  canGoBack?: boolean;
  canGoForward?: boolean;
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
    cancelHistorySwipe();
    historySwipe.reset();
    const value = ipcRenderer.sendSync(BROWSER_PAGE_WHEEL_DECISION_CHANNEL, input);
    wheelIdleMs = browserWheelIdleMs(value);
    wheelDecision = isBrowserWheelDecision(value)
      ? { ...value, lastEventAt: now }
      : { generation: 0, owner: "canvas", lastEventAt: now };
  } else {
    wheelDecision.lastEventAt = now;
  }
  const decision = wheelDecision;
  if (decision.owner === "canvas") {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  if (decision.owner === "page") {
    const preview = historySwipe.update({
      ...input,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      canGoBack: decision.canGoBack === true,
      canGoForward: decision.canGoForward === true,
      scrollable: canScrollHorizontally(event)
    });
    if (preview) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showHistoryIndicator(preview.direction, preview.progress);
    }
    if (swipeTimer) clearTimeout(swipeTimer);
    // Leave time to paint the dismissed HUD before main expires the ownership generation.
    swipeTimer = setTimeout(() => {
      swipeTimer = null;
      const direction = historySwipe.finish();
      indicator?.remove();
      indicator = null;
      indicatorArrow = null;
      if (direction) {
        // The first frame paints the removal; dispatch on the next frame so navigation cannot
        // retain a compositor frame that still contains the indicator while the next page loads.
        navigationFrame = requestAnimationFrame(() => {
          navigationFrame = requestAnimationFrame(() => {
            navigationFrame = null;
            if (!document.hasFocus() || document.visibilityState !== "visible") return;
            ipcRenderer.send(BROWSER_PAGE_WHEEL_CHANNEL, {
              ...input, generation: decision.generation, historySwipe: direction
            });
          });
        });
      }
    }, Math.min(120, (wheelIdleMs ?? 250) / 2));
  } else {
    cancelHistorySwipe();
  }
  ipcRenderer.send(BROWSER_PAGE_WHEEL_CHANNEL, {
    ...input,
    generation: decision.generation
  });
}, { capture: true, passive: false });

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
  indicator?.remove();
  indicator = null;
  indicatorArrow = null;
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
