import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  LocaleId,
  Point,
  ProviderId,
  RadialLauncherItemId
} from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { PROVIDERS } from "../../lib/providers";
import { radialItemAtPointer, radialItemOffset, radialLauncherLayout, RADIAL_LAUNCHER_DEAD_ZONE } from "./radialLauncher";

interface RadialLauncherProps {
  anchor: Point;
  pointerAnchor: Point;
  items: RadialLauncherItemId[];
  locale: LocaleId;
  pointerId: number;
  uiScale: number;
  onActivate(item: RadialLauncherItemId, fromPointerRelease?: boolean): void;
  onClose(reason?: "release" | "cancel"): void;
}

const PROVIDER_IDS = new Set<ProviderId>([
  "terminal", "codex", "claude", "qwen", "kimi", "opencode", "hermes", "grok", "omp", "pi", "cursor", "minimax", "devin", "antigravity"
]);

export function RadialLauncher({
  anchor,
  pointerAnchor,
  items,
  locale,
  pointerId,
  uiScale,
  onActivate,
  onClose
}: RadialLauncherProps): React.JSX.Element {
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const highlightedRef = useRef(highlighted);
  highlightedRef.current = highlighted;
  const menuRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const layout = radialLauncherLayout(anchor, viewport, uiScale);

  useLayoutEffect(() => {
    const parent = menuRef.current?.parentElement;
    if (!parent) return;
    const measure = (): void => setViewport({ width: parent.clientWidth, height: parent.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handleMove = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      const origin = menuRef.current?.getBoundingClientRect();
      if (!origin) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-radial-index]') : null;
      // A click without movement still opens the context menu, even after edge clamping.
      const next = Math.hypot(event.clientX - pointerAnchor.x, event.clientY - pointerAnchor.y) < RADIAL_LAUNCHER_DEAD_ZONE
        ? null
        : target && menuRef.current?.contains(target) ? Number(target.dataset.radialIndex)
          : radialItemAtPointer({ x: origin.x, y: origin.y }, { x: event.clientX, y: event.clientY }, items.length, RADIAL_LAUNCHER_DEAD_ZONE * layout.scale);
      highlightedRef.current = next;
      setHighlighted(next);
    };
    const handleUp = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId || event.button !== 2) return;
      const item = highlightedRef.current === null ? null : items[highlightedRef.current];
      if (item) onActivate(item, true);
      else onClose("release");
    };
    const handleDown = (event: PointerEvent): void => {
      if (event.button === 0 && !(event.target instanceof Element && event.target.closest(".radial-launcher"))) {
        onClose("cancel");
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose("cancel");
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((current) => current === null ? 0 : (current + 1) % items.length);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((current) => current === null ? items.length - 1 : (current - 1 + items.length) % items.length);
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && highlightedRef.current !== null) {
        event.preventDefault();
        onActivate(items[highlightedRef.current]);
      }
    };
    window.addEventListener("pointermove", handleMove, true);
    window.addEventListener("pointerup", handleUp, true);
    window.addEventListener("pointerdown", handleDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointermove", handleMove, true);
      window.removeEventListener("pointerup", handleUp, true);
      window.removeEventListener("pointerdown", handleDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [items, onActivate, onClose, pointerAnchor, pointerId, layout.scale]);

  return (
    <div
      ref={menuRef}
      className="radial-launcher"
      style={{ left: layout.anchor.x, top: layout.anchor.y, fontSize: 13 * layout.scale }}
      role="menu"
      aria-label={t(locale, "quickLauncher")}
      tabIndex={-1}
      data-interactive="true"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="radial-launcher__center" aria-hidden="true">
        <span>{t(locale, "releaseToLaunch")}</span>
      </div>
      {items.map((item, index) => {
        const offset = radialItemOffset(index, items.length, layout.radius);
        const active = highlighted === index;
        return (
          <button
            key={item}
            className={`radial-launcher__item ${active ? "radial-launcher__item--active" : ""}`}
            style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))` }}
            type="button"
            role="menuitem"
            data-radial-index={index}
            aria-current={active ? "true" : undefined}
            onPointerEnter={() => { highlightedRef.current = index; setHighlighted(index); }}
            onFocus={() => { highlightedRef.current = index; setHighlighted(index); }}
            onClick={() => onActivate(item)}
          >
            <span className="radial-launcher__icon">{renderIcon(item)}</span>
            <span>{itemLabel(locale, item)}</span>
          </button>
        );
      })}
    </div>
  );
}

function renderIcon(item: RadialLauncherItemId): React.JSX.Element {
  if (PROVIDER_IDS.has(item as ProviderId)) return <ProviderIcon provider={item as ProviderId} size="small" />;
  if (item === "browser") return <UiIcon name="browser" size={20} />;
  if (item === "settings") return <UiIcon name="settings" size={20} />;
  return <UiIcon name="sticky-note" size={20} />;
}

export function itemLabel(locale: LocaleId, item: RadialLauncherItemId): string {
  if (item === "note") return t(locale, "stickyNote");
  if (item === "browser") return t(locale, "browser");
  if (item === "settings") return t(locale, "settings");
  return PROVIDERS[item].label;
}
