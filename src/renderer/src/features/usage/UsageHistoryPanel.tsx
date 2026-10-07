import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LocaleId } from "../../../../shared/contracts.ts";
import type { UsageHistory } from "../../../../shared/usageHistory.ts";
import type { UsagePeriod, WeightBasis } from "../../../../shared/usageReport.ts";
import { UiIcon } from "../../components/UiIcon";
import { loadUsageHistory, resolveUsageHistoryApi, UsageHistoryUnavailableError } from "./usageHistoryApi.ts";
import { startUsageHistoryPoller, type UsageHistoryPoller } from "./usageHistoryPoller.ts";
import { usageText } from "./usageText.ts";
import type { UsageHistoryLoadError } from "./UsageHistoryView";
import "./usageHistory.css";

interface UsageHistoryPanelProps {
  locale: LocaleId;
  open: boolean;
  /** Portal host outside the transformed canvas; it must carry the app's theme tokens. */
  container: Element | null;
  onOpenChange(open: boolean): void;
}

const TABBABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex='-1'])";

/** Toolbar trigger plus the modal overlay. All hooks run unconditionally on every render. */
export function UsageHistoryPanel({ locale, open, container, onOpenChange }: UsageHistoryPanelProps): React.JSX.Element {
  const [Report, setReport] = useState<typeof import("./UsageHistoryReport").UsageHistoryReport | null>(null);
  const [reportLoadError, setReportLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<UsageHistoryLoadError | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [period, setPeriod] = useState<UsagePeriod>("24h");
  const [weightBasis, setWeightBasis] = useState<WeightBasis>("uncached");
  const pollerRef = useRef<UsageHistoryPoller | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const dialogId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const text = usageText(locale);

  useEffect(() => {
    if (!open || Report) return;
    let live = true;
    setReportLoadError(null);
    void import("./UsageHistoryReport").then((module) => {
      if (live) setReport(() => module.UsageHistoryReport);
    }, (error: unknown) => {
      if (live) setReportLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => { live = false; };
  }, [open, Report]);

  useEffect(() => {
    if (!open) return;
    const poller = startUsageHistoryPoller({
      load: () => loadUsageHistory(resolveUsageHistoryApi(window.canvasTTY)),
      onLoading: setLoading,
      onResult: (value, at) => {
        setHistory(value);
        setLoadedAt(at);
        setLoadError(null);
        setClock(at);
      },
      onError: (error, at) => {
        setLoadError({
          kind: error instanceof UsageHistoryUnavailableError ? "unavailable" : "failed",
          message: error instanceof Error ? error.message : String(error),
          at
        });
        setClock(at);
      }
    });
    pollerRef.current = poller;
    return () => {
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
      setLoading(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onOpenChangeRef.current(false);
      } else if (event.key === "Tab") {
        wrapFocus(event, dialogRef.current);
      }
    };
    const keepFocusInside = (event: FocusEvent): void => {
      const dialog = dialogRef.current;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) closeButtonRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", keepFocusInside);
      const target = previous?.isConnected ? previous : triggerRef.current;
      target?.focus({ preventScroll: true });
    };
  }, [open, Report]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`usage-history-trigger${open ? " usage-history-trigger--open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        title={text.trigger}
        onClick={() => onOpenChange(!open)}
      >
        <UiIcon name="sliders-horizontal" size={15} />
        <span>{text.trigger}</span>
      </button>
      {open && container && createPortal(
        <div className="usage-history-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onOpenChange(false);
        }}>
          <section
            ref={dialogRef}
            id={dialogId}
            className="usage-history"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
          >
            {Report ? <Report
              locale={locale}
              timeZone={timeZone}
              now={clock}
              history={history}
              loading={loading}
              loadError={loadError}
              loadedAt={loadedAt}
              period={period}
              weightBasis={weightBasis}
              titleId={titleId}
              descriptionId={descriptionId}
              closeButtonRef={closeButtonRef}
              onPeriodChange={(next) => {
                setPeriod(next);
                setClock(Date.now());
              }}
              onWeightBasisChange={setWeightBasis}
              onRefresh={() => pollerRef.current?.refresh()}
              onClose={() => onOpenChange(false)}
            /> : <header className="usage-history__header">
              <div className="usage-history__heading">
                <h2 id={titleId}>{text.title}</h2>
                <p id={descriptionId} role={reportLoadError ? "alert" : "status"}>
                  {reportLoadError ? text.reportFailed.replace("{message}", reportLoadError) : text.loading}
                </p>
              </div>
              <button ref={closeButtonRef} type="button" onClick={() => onOpenChange(false)}>{text.close}</button>
            </header>}
          </section>
        </div>,
        container
      )}
    </>
  );
}

/** Wraps Tab at the dialog edges; radio groups contribute only their tab stop. */
function wrapFocus(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const stops = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => {
    if (element.getClientRects().length === 0) return false;
    if (!(element instanceof HTMLInputElement) || element.type !== "radio" || element.checked) return true;
    return !dialog.querySelector(`input[type="radio"][name="${CSS.escape(element.name)}"]:checked`);
  });
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  } else if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}
