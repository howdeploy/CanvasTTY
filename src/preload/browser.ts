import { ipcRenderer } from "electron";

const BROWSER_PAGE_WHEEL_CHANNEL = "browser:page-wheel";
const BROWSER_PAGE_WHEEL_DECISION_CHANNEL = "browser:page-wheel-decision";
type BrowserWheelDecision = {
  generation: number;
  owner: "page" | "canvas";
};

// Main owns the wheel idle boundary and reports it in the ownership reply, so this sandboxed
// entry mirrors the value instead of duplicating the constant. A reply without a usable window
// keeps asking main on every event: main latches the sequence itself, so that fallback costs
// round-trips but never wrong ownership.
let wheelIdleMs: number | null = null;
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
    const value = ipcRenderer.sendSync(BROWSER_PAGE_WHEEL_DECISION_CHANNEL, input);
    wheelIdleMs = browserWheelIdleMs(value);
    wheelDecision = isBrowserWheelDecision(value)
      ? { generation: value.generation, owner: value.owner, lastEventAt: now }
      : { generation: 0, owner: "canvas", lastEventAt: now };
  } else {
    wheelDecision.lastEventAt = now;
  }
  const decision = wheelDecision;
  if (decision.owner === "canvas") {
    event.preventDefault();
    event.stopImmediatePropagation();
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
