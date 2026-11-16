import { useState } from "react";
import type { HomeGridSize, HomeWidgetPlacement, LocaleId } from "../../../../shared/contracts";
import { DEFAULT_HOME_LAYOUT, HOME_GRID_MAX_COLUMNS, HOME_GRID_MAX_ROWS, HOME_GRID_MIN_COLUMNS, HOME_GRID_MIN_ROWS } from "../../../../shared/contracts";
import { placeHomeWidget, updateHomePlacement } from "./homeLayout";

/** Edits only the draft. Done persists the whole layout; Cancel discards it. */
export function HomeLayoutPanel({ layout, grid, locale, onLayout, onGrid }: {
  layout: HomeWidgetPlacement[]; grid: HomeGridSize; locale: LocaleId;
  onLayout(layout: HomeWidgetPlacement[]): void; onGrid(grid: HomeGridSize): void;
}): React.JSX.Element {
  const ru = locale === "ru";
  const [selected, setSelected] = useState("core.media"), [error, setError] = useState("");
  const names: Record<string, string> = {
    "core.limits": ru ? "Лимиты" : "Limits", "core.sessions": ru ? "Сессии" : "Sessions",
    "core.clock": ru ? "Часы и таймеры" : "Clocks & timers", "core.media": ru ? "Аватар" : "Avatar",
    "core.launcher": ru ? "Инструменты" : "Tools", "core.settings": ru ? "Настройки" : "Settings"
  };
  const ids = [...new Set([...DEFAULT_HOME_LAYOUT.map(item => item.widgetId), ...layout.map(item => item.widgetId)])];
  const current = layout.find(item => item.widgetId === selected);
  const toggle = (): void => {
    setError("");
    if (current) { if (selected !== "core.settings") onLayout(layout.filter(item => item.widgetId !== selected)); return; }
    const defaults = DEFAULT_HOME_LAYOUT.find(item => item.widgetId === selected);
    if (!defaults) return;
    const result = placeHomeWidget(layout, selected, { columns: defaults.columnSpan, rows: defaults.rowSpan }, grid);
    if (result) { onLayout([...layout, result.placement]); onGrid(result.gridSize); }
    else setError(ru ? "Нет свободного места." : "No free space.");
  };
  const change = (field: "column" | "row" | "columnSpan" | "rowSpan", value: number): void => {
    if (!current) return;
    const next = updateHomePlacement(layout, { ...current, [field]: value }, grid);
    if (next) { setError(""); onLayout(next); }
    else setError(ru ? "Плитки не должны пересекаться или выходить за границу." : "Tiles must fit without overlapping.");
  };
  return <aside className="home-layout-panel" data-interactive="true" aria-label={ru ? "Параметры плиток" : "Tile properties"}>
    <label>{ru ? "Плитка" : "Tile"}<select value={selected} onChange={event => { setSelected(event.target.value); setError(""); }}>
      {ids.map(id => <option key={id} value={id}>{names[id] ?? id}{layout.some(item => item.widgetId === id) ? "" : ru ? " · скрыта" : " · hidden"}</option>)}
    </select></label>
    <button type="button" disabled={selected === "core.settings"} onClick={toggle}>{current ? (ru ? "Скрыть плитку" : "Hide tile") : (ru ? "Показать плитку" : "Show tile")}</button>
    {current && <div className="home-layout-panel__geometry">{(["column", "row", "columnSpan", "rowSpan"] as const).map((field, index) => <label key={field}>
      {(ru ? ["Колонка", "Ряд", "Ширина", "Высота"] : ["Column", "Row", "Width", "Height"])[index]}
      <input type="number" min={index < 2 ? 0 : 1} max={index % 2 === 0 ? grid.columns : grid.rows} value={current[field]} onChange={event => change(field, Number(event.target.value))} />
    </label>)}</div>}
    <div className="home-layout-panel__geometry"><label>{ru ? "Колонок Home" : "Home columns"}<input type="number" min={HOME_GRID_MIN_COLUMNS} max={HOME_GRID_MAX_COLUMNS} value={grid.columns} onChange={event => { const columns = Number(event.target.value); if (Number.isInteger(columns) && columns >= HOME_GRID_MIN_COLUMNS && columns <= HOME_GRID_MAX_COLUMNS) onGrid({ ...grid, columns }); }} /></label>
      <label>{ru ? "Рядов Home" : "Home rows"}<input type="number" min={HOME_GRID_MIN_ROWS} max={HOME_GRID_MAX_ROWS} value={grid.rows} onChange={event => { const rows = Number(event.target.value); if (Number.isInteger(rows) && rows >= HOME_GRID_MIN_ROWS && rows <= HOME_GRID_MAX_ROWS) onGrid({ ...grid, rows }); }} /></label></div>
    {error && <small role="status">{error}</small>}
  </aside>;
}
