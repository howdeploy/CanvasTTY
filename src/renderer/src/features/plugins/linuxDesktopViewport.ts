import type { LinuxDesktopWindowViewport } from "../../../../shared/linuxDesktopWindows";
import type { SessionBounds } from "../../../../shared/contracts";

export interface LinuxDesktopCanvasPolicy {
  visible: boolean;
  overlays: readonly SessionBounds[];
  higherLayers: readonly string[];
}

/** The X11 overlay must leave the card's rounded corners and resize handles exposed. */
export function linuxDesktopViewportForFrame(
  frame: HTMLIFrameElement,
  inset: number,
  suspended: boolean,
  policy?: LinuxDesktopCanvasPolicy,
): LinuxDesktopWindowViewport {
  const rect = frame.getBoundingClientRect();
  const scale = rect.width / Math.max(1, frame.clientWidth);
  const card = frame.closest<HTMLElement>(".plugin-canvas-card");
  const style = card ? getComputedStyle(card) : null;
  const gutter = (Math.max(12, parseFloat(style?.borderBottomLeftRadius ?? "0") || 0,
    parseFloat(style?.borderBottomRightRadius ?? "0") || 0) + 2) * scale;
  const top = inset * (rect.height / Math.max(1, frame.clientHeight));
  const workspaceElement = frame.closest<HTMLElement>(".workspace");
  const workspace = workspaceElement?.getBoundingClientRect();
  const area = {
    x: rect.left + gutter,
    y: rect.top + top,
    width: Math.max(0, rect.width - 2 * gutter),
    height: Math.max(0, rect.height - top - gutter),
    visible: !suspended && policy?.visible !== false,
    referenceWidth: window.innerWidth,
    referenceHeight: window.innerHeight,
    clipBounds: workspace
      ? { x: workspace.left, y: workspace.top, width: workspace.width, height: workspace.height }
      : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    occlusions: [] as LinuxDesktopWindowViewport["occlusions"],
  };
  area.visible &&= area.width > 1 && area.height > 1
    && document.visibilityState !== "hidden";
  if (area.visible) {
    const rectangles = (policy?.overlays ?? []).map(bounds => ({
      x: (workspace?.left ?? 0) + bounds.position.x,
      y: (workspace?.top ?? 0) + bounds.position.y,
      width: bounds.size.width, height: bounds.size.height,
    }));
    const higher = new Set(policy?.higherLayers ?? []);
    // Read live DOM bounds: a dragged card has not committed its world bounds yet.
    for (const other of workspaceElement?.querySelectorAll<HTMLElement>("[data-canvas-layer-id]") ?? []) {
      if (!higher.has(other.dataset.canvasLayerId ?? "") || getComputedStyle(other).visibility === "hidden") continue;
      const bounds = other.getBoundingClientRect();
      rectangles.push({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height });
    }
    area.occlusions = rectangles.filter(bounds => bounds.width > 0 && bounds.height > 0
      && bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
      && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y);
  }
  return area;
}

/** The isolated Linux toolbar follows the host skin and remains readable when zoomed out. */
export function linuxDesktopAppearanceForFrame(frame: HTMLIFrameElement): object {
  const style = getComputedStyle(frame);
  const color = (skin: string, fallback: string): string =>
    style.getPropertyValue(skin).trim() || style.getPropertyValue(fallback).trim();
  return {
    scale: frame.getBoundingClientRect().width / Math.max(1, frame.clientWidth),
    font: style.fontFamily,
    colors: {
      "--surface": color("--skin-bg-surface", "--surface"),
      "--surface-soft": color("--skin-bg-surface-soft", "--surface-soft"),
      "--ink": color("--skin-text-primary", "--text"),
      "--muted": color("--skin-text-secondary", "--text-muted-on-dark"),
      "--border": color("--skin-border-base", "--border"),
      "--accent": color("--skin-accent", "--primary"),
      "--on-accent": color("--skin-accent-contrast", "--text-dark"),
      "--danger": color("--skin-status-err", "--danger"),
    },
  };
}
