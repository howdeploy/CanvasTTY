import type { LocaleId } from "../../../../shared/contracts";
import { CanvasMenuDivider, CanvasMenuLabel, CanvasMenuRow } from "../../components/CanvasMenuPrimitives";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { planCanvasAutoSort } from "./canvasAutoSort";
import {
  CANVAS_AUTO_SORT_MODES,
  canvasAutoSortMoves,
  canvasAutoSortScope,
  canvasAutoSortUndoTargets,
  type CanvasAutoSortCandidate,
  type CanvasAutoSortHost,
  type CanvasAutoSortMode
} from "./canvasAutoSortScope";
import { parseCanvasLayerId, pluginLayerId, terminalLayerId } from "./canvasSelectionGesture";

/**
 * The body of the empty-canvas Tools submenu. The context menu loads it, with the layout code,
 * the first time Tools opens, so none of it is in the startup bundle.
 */
const LABELS = {
  task: "canvasAutoSortTask",
  status: "canvasAutoSortStatus",
  project: "canvasAutoSortProject",
  grid: "canvasAutoSortGrid"
} as const satisfies Record<CanvasAutoSortMode, Parameters<typeof t>[1]>;

/** The windows an auto-sort would move right now (see canvasAutoSortScope). */
export function canvasAutoSortIds(host: CanvasAutoSortHost): string[] {
  const mascots = new Set(host.pluginCanvas
    .filter((instance) => host.plugins.find((plugin) => plugin.manifest.id === instance.pluginId)?.sourceUrl.startsWith("mascot:"))
    .map((instance) => pluginLayerId(instance.id)));
  const candidates: CanvasAutoSortCandidate[] = [];
  for (const [id, bounds] of host.bounds) {
    const kind = parseCanvasLayerId(id)?.kind;
    if (kind) candidates.push({ id, kind, bounds, decorative: mascots.has(id) });
  }
  return canvasAutoSortScope(candidates, host.selection, host.regions);
}

/**
 * Sort by `mode` and remember the step for undo; the criterion is kept only once a sort happened.
 * A sort that moves nothing (the layout already follows the criterion) keeps the earlier undo step.
 */
export function runCanvasAutoSort(host: CanvasAutoSortHost, mode: CanvasAutoSortMode): void {
  const plan = planCanvasAutoSort(canvasAutoSortIds(host), host.bounds, host.sessions, terminalLayerId, mode, {
    avoid: [host.home, ...host.regions],
    snapToGrid: host.snapToGrid
  });
  if (!plan) return;
  if (!canvasAutoSortMoves(plan)) {
    if (mode !== host.state.mode) host.setState({ mode, undo: host.state.undo });
    return;
  }
  host.commit(plan.after);
  host.setState({ mode, undo: { mode, ...plan } });
  host.mark(new Set(plan.after.keys()));
}

/** Put back the windows that are still where the last sort placed them. */
export function undoCanvasAutoSort(host: CanvasAutoSortHost): void {
  if (!host.state.undo) return;
  const restore = canvasAutoSortUndoTargets(host.state.undo, host.bounds);
  host.setState({ mode: host.state.mode, undo: null });
  if (restore.size === 0) return;
  host.commit(restore);
  host.mark(new Set(restore.keys()));
}

export function CanvasAutoSortMenu({ host, locale, className, onDone }: {
  host: CanvasAutoSortHost;
  locale: LocaleId;
  className: string;
  onDone(): void;
}): React.JSX.Element {
  const available = canvasAutoSortIds(host).length >= 2;
  const undoAvailable = host.state.undo !== null && canvasAutoSortUndoTargets(host.state.undo, host.bounds).size > 0;
  const run = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      console.error("Auto-sort failed", error);
      host.onError(t(locale, "canvasAutoSortFailed"));
    }
    onDone();
  };
  return (
    <div className={className} role="menu" aria-label={t(locale, "canvasMenuTools")}>
      <div role="group" aria-label={t(locale, "canvasAutoSort")}>
        <CanvasMenuLabel>{t(locale, "canvasAutoSort")}</CanvasMenuLabel>
        {CANVAS_AUTO_SORT_MODES.map((mode) => (
          <CanvasMenuRow
            indent
            role="menuitemradio"
            aria-checked={mode === host.state.mode}
            disabled={!available}
            right={mode === host.state.mode ? (
              <span className="canvas-menu__check" aria-hidden="true"><UiIcon name="done" size="1em" /></span>
            ) : undefined}
            key={mode}
            onClick={() => run(() => runCanvasAutoSort(host, mode))}
          >{t(locale, LABELS[mode])}</CanvasMenuRow>
        ))}
        {!available && <p className="canvas-menu__hint">{t(locale, "canvasAutoSortUnavailable")}</p>}
      </div>
      {undoAvailable && (
        <>
          <CanvasMenuDivider />
          <CanvasMenuRow icon="undo" role="menuitem" onClick={() => run(() => undoCanvasAutoSort(host))}>
            {t(locale, "canvasAutoSortUndo")}
          </CanvasMenuRow>
        </>
      )}
    </div>
  );
}
