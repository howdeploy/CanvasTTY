import { useEffect, useId, useRef, useState } from "react";
import type { LocaleId, SessionSnapshot } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";

const FAILURE_TOOLTIP_GAP = 6;
const FAILURE_TOOLTIP_MARGIN = 16;
const FAILURE_TOOLTIP_MAX_WIDTH = 520;
const FAILURE_TOOLTIP_MAX_DETAILS_HEIGHT = 260;
const FAILURE_TOOLTIP_MIN_DETAILS_HEIGHT = 80;
const FAILURE_TOOLTIP_CHROME_HEIGHT = 22;

interface SessionFailureDetailsProps {
  details: string;
  locale: LocaleId;
}

/** Failure text a failed session can show; null for every other status. */
export function sessionFailureDetails(session: SessionSnapshot, locale: LocaleId): string | null {
  if (session.status !== "failed") return null;
  return session.failureDetails ?? `${t(locale, "failureOutputUnavailable")}${session.exitCode ?? "unknown"}`;
}

export function SessionFailureDetails({ details, locale }: SessionFailureDetailsProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  // Several surfaces can show the same session, so the popover id is per mount.
  const tooltipId = useId();

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
    closeTimer.current = setTimeout(closeTooltip, 160);
  };

  const positionTooltip = (): void => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(FAILURE_TOOLTIP_MAX_WIDTH, window.innerWidth - FAILURE_TOOLTIP_MARGIN * 2);
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
    if (placeBelow) {
      tooltip.style.top = `${bounds.bottom + FAILURE_TOOLTIP_GAP}px`;
      tooltip.style.bottom = "auto";
    } else {
      tooltip.style.top = "auto";
      tooltip.style.bottom = `${window.innerHeight - bounds.top + FAILURE_TOOLTIP_GAP}px`;
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

  const handleEscape = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeTooltip();
    triggerRef.current?.focus();
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

  useEffect(() => () => cancelClose(), []);

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
        <span className="usage-row__failure-details">{details}</span>
        <button
          className="usage-row__failure-copy"
          type="button"
          onClick={() => window.canvasTTY.clipboard.writeText(details)}
          title={t(locale, "copyErrorDetails")}
          aria-label={t(locale, "copyErrorDetails")}
        >
          <UiIcon name="copy" size={16} />
        </button>
      </div>
    </>
  );
}
