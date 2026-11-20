import type { HomeGridSize, HomeWidgetPlacement, LocaleId } from "../../../../shared/contracts";
import { resizeHomePlacement, updateHomePlacement, type HomeResizeDirection } from "./homeLayout";
const directions: HomeResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
export default function HomeWidgetControls({ placement, layout, grid, locale, onLayout, onStart, onMove, onEnd }: {
  placement: HomeWidgetPlacement; layout: HomeWidgetPlacement[]; grid: HomeGridSize; locale: LocaleId;
  onLayout(layout: HomeWidgetPlacement[]): void;
  onStart(event: React.PointerEvent<HTMLButtonElement>, placement: HomeWidgetPlacement, mode: "move" | "resize", direction?: HomeResizeDirection): void;
  onMove(event: React.PointerEvent<HTMLButtonElement>): void; onEnd(event: React.PointerEvent<HTMLButtonElement>): void;
}): React.JSX.Element {
  const ru = locale === "ru";
  const label = ({ "core.limits": ru ? "Лимиты" : "Limits", "core.sessions": ru ? "Сессии" : "Sessions",
    "core.clock": ru ? "Часы и таймеры" : "Clocks & timers", "core.media": ru ? "Аватар" : "Avatar",
    "core.launcher": ru ? "Инструменты" : "Tools", "core.settings": ru ? "Настройки" : "Settings" }[placement.widgetId] ?? placement.widgetId);
  const keyboard = (event: React.KeyboardEvent): void => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.shiftKey ? resizeHomePlacement(placement, "se", delta[0], delta[1])
      : { ...placement, column: placement.column + delta[0], row: placement.row + delta[1] };
    const updated = updateHomePlacement(layout, next, grid);
    if (updated) onLayout(updated);
  };
  return <>
    <button className="home-widget-slot__move" type="button" onPointerDown={event => onStart(event, placement, "move")}
      onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd} onKeyDown={keyboard}
      aria-label={`${label}: ${ru ? "стрелки — перемещение, Shift + стрелки — размер" : "arrows to move, Shift + arrows to resize"}`}>
      <span>{label}</span>
    </button>
    {directions.map(direction => <button className={`home-widget-slot__resize home-widget-slot__resize--${direction}`} type="button" key={direction}
      aria-label={`${ru ? "Размер" : "Resize"}: ${label} (${direction})`} onPointerDown={event => onStart(event, placement, "resize", direction)}
      onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd} />)}
  </>;
}
