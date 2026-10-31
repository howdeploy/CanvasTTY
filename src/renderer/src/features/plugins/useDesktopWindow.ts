import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { InstalledPlugin } from "../../../../shared/contracts";
import type { DesktopWindowViewport } from "../../../../shared/desktopWindows";
import { linuxDesktopAppearanceForFrame, linuxDesktopViewportForFrame } from "./linuxDesktopViewport";
import type { LinuxDesktopCanvasPolicy } from "./linuxDesktopViewport";

/** Only trusted chrome measures the iframe; sandbox messages cannot supply a screen rectangle. */
export function desktopViewportForFrame(
  frame: HTMLIFrameElement,
  inset: number,
  suspended: boolean,
): DesktopWindowViewport {
  const rect = frame.getBoundingClientRect();
  const top = inset * (rect.height / Math.max(1, frame.clientHeight));
  const area = {
    x: rect.left,
    y: rect.top + top,
    width: rect.width,
    height: Math.max(0, rect.height - top),
    visible: !suspended,
  };
  area.visible &&=
    rect.width > 1 &&
    area.height > 1 &&
    area.x >= 0 &&
    area.y >= 0 &&
    area.x + area.width <= window.innerWidth &&
    area.y + area.height <= window.innerHeight &&
    document.visibilityState !== "hidden";
  const belongs = (x: number, y: number): boolean =>
    document.elementFromPoint(x, y) === frame;
  if (area.visible) {
    const points = [
      [area.x + 1, area.y + 1],
      [area.x + area.width - 1, area.y + 1],
      [area.x + 1, area.y + area.height - 1],
      [area.x + area.width - 1, area.y + area.height - 1],
      [area.x + area.width / 2, area.y + area.height / 2],
    ];
    area.visible = points.every(([x, y]) => belongs(x!, y!));
  }
  if (area.visible) {
    // Even a small overlapping card/menu must occlude the native child. Hide it
    // as a whole, since Chromium cannot composite HTML above a foreign HWND.
    for (const other of document.querySelectorAll<HTMLElement>(
      "[data-canvas-widget-id], [role=dialog], [role=menu]",
    )) {
      if (other.contains(frame)) continue;
      const r = other.getBoundingClientRect();
      const left = Math.max(area.x, r.left),
        right = Math.min(area.x + area.width, r.right);
      const top = Math.max(area.y, r.top),
        bottom = Math.min(area.y + area.height, r.bottom);
      if (
        right > left &&
        bottom > top &&
        !belongs((left + right) / 2, (top + bottom) / 2)
      ) {
        area.visible = false;
        break;
      }
    }
  }
  return area;
}

export function useDesktopWindow(
  frame: RefObject<HTMLIFrameElement | null>,
  plugin: InstalledPlugin,
  instanceId: string | undefined,
  suspended: boolean,
  onError: (message: string) => void,
  nativeSurface?: LinuxDesktopCanvasPolicy,
  onFocus?: () => void,
): (method: string, params: Record<string, unknown>) => Promise<unknown> {
  const attached = useRef(false);
  const inset = useRef(64);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const generation = useRef(0);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const pluginId = plugin.manifest.id;
  const permitted =
    plugin.enabled && plugin.manifest.permissions.includes("desktop:embed");
  const linuxViewport = window.canvasTTY.window.platform === "linux" ? linuxDesktopViewportForFrame : null;
  const reportViewport = useRef(() => {});
  const nativeSurfaceRef = useRef(nativeSurface);
  nativeSurfaceRef.current = nativeSurface;
  const focusRef = useRef(onFocus);
  focusRef.current = onFocus;

  useEffect(() => {
    if (!linuxViewport || !instanceId || !permitted) return;
    return window.canvasTTY.plugins.onDesktopWindowFocus?.(event => {
      if (event.pluginId === pluginId && event.instanceId === instanceId) focusRef.current?.();
    });
  }, [instanceId, permitted, pluginId, linuxViewport]);

  useLayoutEffect(() => {
    if (linuxViewport) reportViewport.current();
  });

  useEffect(() => {
    if (!instanceId || !permitted) return;
    let active = true,
      busy = false,
      pending = false;
    let lastViewport = "", lastSent = 0, lastAppearance = "", appearanceAt = 0;
    const mine = ++generation.current;
    const tick = async (): Promise<void> => {
      if (linuxViewport && frame.current && Date.now() - appearanceAt >= 100) {
        appearanceAt = Date.now();
        const appearance = linuxDesktopAppearanceForFrame(frame.current);
        const serialized = JSON.stringify(appearance);
        if (serialized !== lastAppearance) {
          lastAppearance = serialized;
          frame.current.contentWindow?.postMessage({ source: "canvastty-host", type: "desktop-appearance", value: appearance }, "*");
        }
      }
      if (!active || !attached.current || (busy && !linuxViewport) || !frame.current) return;
      const viewport = linuxViewport
        ? linuxViewport(frame.current, inset.current, suspendedRef.current, nativeSurfaceRef.current)
        : desktopViewportForFrame(frame.current, inset.current, suspendedRef.current);
      const serialized = JSON.stringify(viewport);
      if (serialized === lastViewport && Date.now() - lastSent < 500) return;
      if (busy) { pending = true; return; }
      lastViewport = serialized;
      lastSent = Date.now();
      busy = true;
      try {
        await window.canvasTTY.plugins.desktopWindows(
          pluginId,
          instanceId,
          "update",
          viewport,
        );
      } catch (error) {
        if (!active || mine !== generation.current) return;
        attached.current = false;
        void window.canvasTTY.plugins
          .desktopWindows(pluginId, instanceId, "detach")
          .catch(() => undefined);
        errorRef.current(
          error instanceof Error
            ? error.message
            : "Desktop window is unavailable.",
        );
      } finally {
        busy = false;
        if (linuxViewport && pending && active) {
          pending = false;
          void tick();
        }
      }
    };
    reportViewport.current = () => { void tick(); };
    const observer = linuxViewport ? new ResizeObserver(reportViewport.current) : null;
    if (frame.current) observer?.observe(frame.current);
    if (linuxViewport) window.addEventListener("resize", reportViewport.current);
    // A heartbeat also runs while hidden: native content must hide for modals,
    // camera movement, semantic summaries and minimization, then reappear.
    const timer = window.setInterval(() => void tick(), 500);
    let animation = 0;
    const animate = (): void => {
      void tick();
      animation = window.requestAnimationFrame(animate);
    };
    animation = window.requestAnimationFrame(animate);
    const detach = (): void => {
      attached.current = false;
      void window.canvasTTY.plugins
        .desktopWindows(pluginId, instanceId, "detach")
        .catch(() => undefined);
    };
    const element = frame.current;
    const loaded = (): void => { lastAppearance = ""; detach(); };
    element?.addEventListener("load", loaded);
    return () => {
      active = false;
      generation.current++;
      window.clearInterval(timer);
      window.cancelAnimationFrame(animation);
      observer?.disconnect();
      if (linuxViewport) window.removeEventListener("resize", reportViewport.current);
      reportViewport.current = () => {};
      element?.removeEventListener("load", loaded);
      detach();
    };
  }, [frame, instanceId, permitted, pluginId, linuxViewport, plugin.installedAt]);

  return async (method, params) => {
    if (!permitted)
      throw new Error("Plugin permission is required: desktop:embed.");
    if (!instanceId)
      throw new Error(
        "Desktop embedding is available only inside a canvas app card.",
      );
    if (method === "desktopWindows.list")
      return window.canvasTTY.plugins.desktopWindows(
        pluginId,
        instanceId,
        "list",
      );
    if (method === "desktopWindows.status")
      return { attached: attached.current };
    if (linuxViewport && method === "desktopWindows.layout") {
      if (typeof params.insetTop !== "number" || !Number.isFinite(params.insetTop)
        || params.insetTop < 40 || params.insetTop > 4096) throw new Error("Invalid native viewport inset.");
      inset.current = params.insetTop;
      reportViewport.current();
      return null;
    }
    if (method === "desktopWindows.detach") {
      attached.current = false;
      return window.canvasTTY.plugins.desktopWindows(
        pluginId,
        instanceId,
        "detach",
      );
    }
    if (method === "desktopWindows.attach") {
      if (typeof params.windowId !== "string")
        throw new Error("A window selection is required.");
      if (
        typeof params.insetTop !== "number" ||
        !Number.isFinite(params.insetTop) ||
        params.insetTop < 40 ||
        params.insetTop > 300
      )
        throw new Error("Invalid native viewport inset.");
      inset.current = params.insetTop;
      const mine = generation.current;
      await window.canvasTTY.plugins.desktopWindows(
        pluginId,
        instanceId,
        "attach",
        params.windowId,
      );
      if (mine !== generation.current) {
        await window.canvasTTY.plugins.desktopWindows(
          pluginId,
          instanceId,
          "detach",
        );
        return null;
      }
      attached.current = true;
      if (linuxViewport) reportViewport.current();
      return null;
    }
    throw new Error("Unknown desktop window method.");
  };
}
