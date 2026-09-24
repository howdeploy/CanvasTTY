import { useEffect, useId, useRef, useState } from "react";
import type { LocaleId, SessionSnapshot } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { failureClipboardText, failureSummary, type FailureSummary } from "./failureSummary";

const FAILURE_TOOLTIP_GAP = 6;
const FAILURE_TOOLTIP_MARGIN = 16;
const FAILURE_TOOLTIP_MAX_WIDTH = 520;
const FAILURE_TOOLTIP_MAX_DETAILS_HEIGHT = 260;
const FAILURE_TOOLTIP_MIN_DETAILS_HEIGHT = 80;
/** Header, summary lines, the diagnostics toggle and paddings above the scrollable raw output. */
const FAILURE_TOOLTIP_CHROME_HEIGHT = 132;
const FAILURE_TOOLTIP_CLOSE_DELAY_MS = 160;
const FAILURE_COPIED_FEEDBACK_MS = 1_500;

/** What a failed session shows: the derived summary plus the raw diagnostics to keep secondary. */
export type SessionFailure = FailureSummary;

interface SessionFailureDetailsProps {
  details: SessionFailure;
  locale: LocaleId;
}

/**
 * Failure summary a failed session can show; null for every other status. The raw
 * diagnostics fall back to an explicit "no output" note so the collapsed section
 * never pretends the terminal said something it did not.
 */
export function sessionFailureDetails(session: SessionSnapshot, locale: LocaleId): SessionFailure | null {
  const summary = failureSummary(session, locale);
  if (!summary) return null;
  return {
    ...summary,
    diagnostics: summary.diagnostics ?? session.failureDetails ?? `${t(locale, "failureOutputUnavailable")}${session.exitCode ?? "unknown"}`
  };
}

export function SessionFailureDetails({ details: failure, locale }: SessionFailureDetailsProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Several surfaces can show the same session, so the popover id is per mount.
  const tooltipId = useId();
  const details = failureClipboardText(failure);

  const cancelClose = (): void => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const closeTooltip = (): void => {
    cancelClose();
    const tooltip = tooltipRef.current;
    if (tooltip?.matches(":popover-open")) tooltip.hidePopover();
    setOpen(false);
  };

  const scheduleClose = (): void => {
    cancelClose();
    closeTimer.current = setTimeout(closeTooltip, FAILURE_TOOLTIP_CLOSE_DELAY_MS);
  };

  const positionTooltip = (): void => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(FAILURE_TOOLTIP_MAX_WIDTH, window.innerWidth - FAILURE_TOOLTIP_MARGIN * 2);
    // Right-aligned with the trigger, then clamped so the box always stays inside the viewport.
    const left = Math.max(
      FAILURE_TOOLTIP_MARGIN,
      Math.min(bounds.right - width, window.innerWidth - width - FAILURE_TOOLTIP_MARGIN)
    );
    const availableBelow = window.innerHeight - bounds.bottom - FAILURE_TOOLTIP_GAP - FAILURE_TOOLTIP_MARGIN;
    const availableAbove = bounds.top - FAILURE_TOOLTIP_GAP - FAILURE_TOOLTIP_MARGIN;
    const placeBelow = availableBelow >= availableAbove;
    const availableHeight = Math.max(placeBelow ? availableBelow : availableAbove, FAILURE_TOOLTIP_MIN_DETAILS_HEIGHT);
    const detailsHeight = Math.max(
      FAILURE_TOOLTIP_MIN_DETAILS_HEIGHT,
      Math.min(FAILURE_TOOLTIP_MAX_DETAILS_HEIGHT, availableHeight - FAILURE_TOOLTIP_CHROME_HEIGHT)
    );

    tooltip.style.left = `${left}px`;
    tooltip.style.setProperty("--failure-tooltip-details-max-height", `${detailsHeight}px`);
    tooltip.style.setProperty("--failure-tooltip-max-height", `${Math.max(availableHeight, FAILURE_TOOLTIP_MIN_DETAILS_HEIGHT)}px`);
    if (placeBelow) {
      tooltip.style.top = `${Math.max(FAILURE_TOOLTIP_MARGIN, bounds.bottom + FAILURE_TOOLTIP_GAP)}px`;
      tooltip.style.bottom = "auto";
    } else {
      tooltip.style.top = "auto";
      tooltip.style.bottom = `${Math.max(FAILURE_TOOLTIP_MARGIN, window.innerHeight - bounds.top + FAILURE_TOOLTIP_GAP)}px`;
    }
  };

  const openTooltip = (): void => {
    cancelClose();
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    positionTooltip();
    if (!tooltip.matches(":popover-open")) tooltip.showPopover();
    setOpen(true);
  };

  const closeAndRefocus = (): void => {
    closeTooltip();
    triggerRef.current?.focus();
  };

  const handleEscape = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeAndRefocus();
  };

  const copyDetails = (): void => {
    window.canvasTTY.clipboard.writeText(details);
    setCopied(true);
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), FAILURE_COPIED_FEEDBACK_MS);
  };

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", positionTooltip);
    window.addEventListener("scroll", positionTooltip, true);
    return () => {
      window.removeEventListener("resize", positionTooltip);
      window.removeEventListener("scroll", positionTooltip, true);
    };
  }, [open]);

  useEffect(() => () => {
    cancelClose();
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        className="usage-row__failure-trigger"
        type="button"
        aria-controls={tooltipId}
        aria-describedby={tooltipId}
        aria-expanded={open}
        title={t(locale, "showErrorDetails")}
        aria-label={t(locale, "showErrorDetails")}
        onClick={openTooltip}
        onMouseEnter={openTooltip}
        onMouseLeave={scheduleClose}
        onFocus={openTooltip}
        onBlur={scheduleClose}
        onKeyDown={handleEscape}
      >
        <UiIcon name="error" size={24} />
      </button>
      <div
        ref={tooltipRef}
        className="usage-row__failure-tooltip"
        id={tooltipId}
        role="group"
        aria-label={t(locale, "statusFailed")}
        popover="manual"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onFocus={cancelClose}
        onBlur={scheduleClose}
        onKeyDown={handleEscape}
        onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))}
      >
        <header className="usage-row__failure-header">
          <strong className="usage-row__failure-headline">{failure.headline}</strong>
          <div className="usage-row__failure-actions">
            <button
              className="usage-row__failure-copy"
              type="button"
              onClick={copyDetails}
              title={copied ? t(locale, "copiedErrorDetails") : t(locale, "copyErrorDetails")}
              aria-label={copied ? t(locale, "copiedErrorDetails") : t(locale, "copyErrorDetails")}
            >
              {copied ? <UiIcon name="done" size={16} /> : <UiIcon name="copy" size={16} />}
            </button>
            <button
              className="usage-row__failure-close"
              type="button"
              onClick={closeAndRefocus}
              title={t(locale, "closeErrorDetails")}
              aria-label={t(locale, "closeErrorDetails")}
            >
              <UiIcon name="close" size={16} />
            </button>
          </div>
        </header>
        <p className="usage-row__failure-summary">
          <span className="usage-row__failure-detail">{failure.detail}</span>
          {failure.possibleCause && <code className="usage-row__failure-cause">{failure.possibleCause}</code>}
        </p>
        {failure.diagnostics && (
          <details className="usage-row__failure-diagnostics">
            <summary>
              <span>{t(locale, "failureDiagnostics")}</span>
              <small>{t(locale, "failureDiagnosticsHint")}</small>
            </summary>
            <pre className="usage-row__failure-details" tabIndex={0}>{failure.diagnostics}</pre>
          </details>
        )}
      </div>
    </>
  );
}
