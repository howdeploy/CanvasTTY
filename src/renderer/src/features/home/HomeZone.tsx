import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProviderId,
  AppSettings,
  HomeGridSize,
  HomeWidgetPlacement,
  InstalledPlugin,
  LimitsSnapshot,
  LocaleId,
  ProviderId,
  SessionSnapshot
} from "../../../../shared/contracts";
import {
  HOME_GRID_CELL_HEIGHT,
  HOME_GRID_CELL_WIDTH,
  HOME_GRID_GAP,
  HOME_GRID_MAX_COLUMNS,
  HOME_GRID_MAX_ROWS
} from "../../../../shared/contracts.ts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import {
  homeLauncherColumnCount,
  PROVIDERS,
  resolveHomeLimitProviders,
  resolveHomeLauncherProviders
} from "../../lib/providers";
import { sessionStatusIcon, sessionStatusLabel } from "../../lib/sessionStatus";
import { sessionStatusTone } from "../../lib/sessionStatusTone";
import { HomeMediaWidget } from "./HomeMediaWidget";
import { PluginFrame } from "../plugins/PluginFrame";
import type { PluginCanvasWheelInput } from "../plugins/pluginInputBridge";
import {
  HOME_GRID_COLUMN_STEP,
  HOME_GRID_ROW_STEP,
  homeGridPixelSize,
  isInsideHome,
  minimumHomeGridSize,
  resizeHomePlacement,
  type HomeResizeDirection,
  updateHomePlacement
} from "./homeLayout";
import {
  formatLimitDuration,
  formatResetCountdown,
  selectHomeModel,
  type HomeLimitReason,
  type HomeLimitRow,
  type LimitsLoadState
} from "./homeModel";
import { homeCanvasWidgetId } from "../workspace/canvasWidgetFocus";

interface HomeZoneProps {
  settings: AppSettings;
  mediaData: string | null;
  sessions: SessionSnapshot[];
  limits: LimitsSnapshot | null;
  limitsLoadState: LimitsLoadState;
  plugins: InstalledPlugin[];
  editing: boolean;
  onOpenSettings(): void;
  onOpenAgent(provider: AgentProviderId): void;
  onOpenTerminal(): void;
  onOpenBrowser(): void;
  onFocusSession(session: SessionSnapshot): void;
  onRequestMedia(): Promise<void>;
  onRemoveMedia(): Promise<void>;
  onLayoutChange(layout: HomeWidgetPlacement[]): void;
  onGridSizeChange(gridSize: HomeGridSize): void;
  onPluginError(message: string): void;
  captureCanvasWheelOverWidgets: boolean;
  focusedWidgetId: string | null;
  onWidgetFocus(id: string): void;
  onWidgetHoverChange(id: string, active: boolean): void;
  onPluginCanvasWheel(event: PluginCanvasWheelInput): void;
}

interface LayoutPointerState {
  pointerId: number;
  mode: "move" | "resize";
  direction: HomeResizeDirection | null;
  startClient: { x: number; y: number };
  startPlacement: HomeWidgetPlacement;
  scale: { x: number; y: number };
}

interface GridPointerState {
  pointerId: number;
  startClient: { x: number; y: number };
  startGridSize: HomeGridSize;
  scale: { x: number; y: number };
}

const HOME_RESIZE_DIRECTIONS: HomeResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const FAILURE_TOOLTIP_GAP = 6;
const FAILURE_TOOLTIP_MARGIN = 16;
const FAILURE_TOOLTIP_MAX_WIDTH = 520;
const FAILURE_TOOLTIP_MAX_DETAILS_HEIGHT = 260;
const FAILURE_TOOLTIP_MIN_DETAILS_HEIGHT = 80;
const FAILURE_TOOLTIP_CHROME_HEIGHT = 22;

interface SessionFailureDetailsProps {
  sessionId: string;
  details: string;
  locale: LocaleId;
}

function SessionFailureDetails({ sessionId, details, locale }: SessionFailureDetailsProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const tooltipId = `session-failure-${sessionId}`;

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

export function HomeZone({
  settings,
  mediaData,
  sessions,
  limits,
  limitsLoadState,
  plugins,
  editing,
  onOpenSettings,
  onOpenAgent,
  onOpenTerminal,
  onOpenBrowser,
  onFocusSession,
  onRequestMedia,
  onRemoveMedia,
  onLayoutChange,
  onGridSizeChange,
  onPluginError,
  captureCanvasWheelOverWidgets,
  focusedWidgetId,
  onWidgetFocus,
  onWidgetHoverChange,
  onPluginCanvasWheel
}: HomeZoneProps): React.JSX.Element {
  const locale = settings.locale;
  const launcherProviders = resolveHomeLauncherProviders(settings);
  const limitProviders = resolveHomeLimitProviders(settings);
  const [now, setNow] = useState(() => new Date());
  const home = useMemo(
    () => selectHomeModel(sessions, limits, limitsLoadState, now.getTime(), limitProviders),
    [sessions, limits, limitsLoadState, now, settings.homeLimitProviders]
  );
  const homeElement = useRef<HTMLElement>(null);
  const layoutPointer = useRef<LayoutPointerState | null>(null);
  const gridPointer = useRef<GridPointerState | null>(null);
  const layoutRef = useRef(settings.homeLayout);
  const gridRef = useRef(settings.homeGridSize);
  const [draftLayout, setDraftLayout] = useState(settings.homeLayout);
  const [draftGridSize, setDraftGridSize] = useState(settings.homeGridSize);
  layoutRef.current = draftLayout;
  gridRef.current = draftGridSize;

  useEffect(() => {
    if (!layoutPointer.current) setDraftLayout(settings.homeLayout);
  }, [settings.homeLayout]);

  useEffect(() => {
    if (!gridPointer.current) setDraftGridSize(settings.homeGridSize);
  }, [settings.homeGridSize]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const startLayoutPointer = (
    event: React.PointerEvent<HTMLButtonElement>,
    placement: HomeWidgetPlacement,
    mode: LayoutPointerState["mode"],
    direction: HomeResizeDirection | null = null
  ): void => {
    const bounds = homeElement.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    layoutPointer.current = {
      pointerId: event.pointerId,
      mode,
      direction,
      startClient: { x: event.clientX, y: event.clientY },
      startPlacement: placement,
      scale: {
        x: bounds.width / homeGridPixelSize(gridRef.current).width,
        y: bounds.height / homeGridPixelSize(gridRef.current).height
      }
    };
  };

  const moveLayoutPointer = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const state = layoutPointer.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const columnDelta = Math.round(
      (event.clientX - state.startClient.x) / (HOME_GRID_COLUMN_STEP * state.scale.x)
    );
    const rowDelta = Math.round(
      (event.clientY - state.startClient.y) / (HOME_GRID_ROW_STEP * state.scale.y)
    );
    const next = state.mode === "move"
      ? {
        ...state.startPlacement,
        column: state.startPlacement.column + columnDelta,
        row: state.startPlacement.row + rowDelta
      }
      : resizeHomePlacement(
        state.startPlacement,
        state.direction ?? "se",
        columnDelta,
        rowDelta
      );
    const updated = updateHomePlacement(
      layoutRef.current,
      next,
      gridRef.current,
      { allowOutside: true }
    );
    if (updated) {
      layoutRef.current = updated;
      setDraftLayout(updated);
      onLayoutChange(updated);
    }
  };

  const endLayoutPointer = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (layoutPointer.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    layoutPointer.current = null;
    onLayoutChange(layoutRef.current);
  };

  const startGridPointer = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const bounds = homeElement.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const pixels = homeGridPixelSize(gridRef.current);
    gridPointer.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startGridSize: gridRef.current,
      scale: { x: bounds.width / pixels.width, y: bounds.height / pixels.height }
    };
  };

  const moveGridPointer = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const state = gridPointer.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const minimum = minimumHomeGridSize(layoutRef.current);
    const next = {
      columns: clamp(
        state.startGridSize.columns + Math.round(
          (event.clientX - state.startClient.x) / (HOME_GRID_COLUMN_STEP * state.scale.x)
        ),
        minimum.columns,
        HOME_GRID_MAX_COLUMNS
      ),
      rows: clamp(
        state.startGridSize.rows + Math.round(
          (event.clientY - state.startClient.y) / (HOME_GRID_ROW_STEP * state.scale.y)
        ),
        minimum.rows,
        HOME_GRID_MAX_ROWS
      )
    };
    gridRef.current = next;
    setDraftGridSize(next);
  };

  const endGridPointer = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (gridPointer.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gridPointer.current = null;
    onGridSizeChange(gridRef.current);
  };

  const openPluginLauncher = (provider: ProviderId): void => {
    if (provider === "terminal") onOpenTerminal();
    else onOpenAgent(provider);
  };

  const widgetContent = (widgetId: string): React.ReactNode => {
    if (widgetId === "core.limits") {
      return (
        <section
          className={`tile agent-overview limits-list ${home.limitRows.length >= 4 ? "limits-list--dense" : ""}`}
          aria-label={t(locale, "modelLimits")}
          style={{ "--limit-rows": Math.max(home.limitRows.length, 1) } as React.CSSProperties}
        >
          {home.limitRows.length === 0 ? (
            <div className="limits-list__empty">{t(locale, "noVisibleLimits")}</div>
          ) : home.limitRows.map((row) => (
            <LimitRow key={row.provider} row={row} locale={locale} now={now.getTime()} />
          ))}
        </section>
      );
    }
    if (widgetId === "core.sessions") {
      return (
        <section
          className="tile usage-list"
          data-session-row-colors={settings.sessionRowColorMode}
          data-wheel-owner="local"
          data-canvas-wheel-priority="local"
          aria-label={t(locale, "activeSessions")}
        >
          {home.sessionRows.length === 0 ? (
            <div className="home-empty">{t(locale, "noActiveSessions")}</div>
          ) : home.sessionRows.map((session) => {
            const statusIcon = sessionStatusIcon(session.status);
            const failureDetails = session.status === "failed"
              ? session.failureDetails ?? `${t(locale, "failureOutputUnavailable")}${session.exitCode ?? "unknown"}`
              : null;
            return (
              <div className="usage-row-wrap" key={session.id}>
                <button
                  className="usage-row"
                  data-session-tone={sessionStatusTone(session.status)}
                  type="button"
                  onClick={() => onFocusSession(session)}
                  aria-label={`${session.title}, ${sessionStatusLabel(locale, session.status, session.provider)}`}
                  title={failureDetails ? undefined : session.title}
                >
                  <ProviderIcon provider={session.provider} size="medium" />
                  <span className="usage-row__copy">
                    <strong>{sessionStatusLabel(locale, session.status, session.provider)}</strong>
                    <span>{session.title}</span>
                  </span>
                  {!failureDetails && statusIcon && <UiIcon name={statusIcon} size={24} />}
                </button>
                {failureDetails && (
                  <SessionFailureDetails sessionId={session.id} details={failureDetails} locale={locale} />
                )}
              </div>
            );
          })}
        </section>
      );
    }
    if (widgetId === "core.clock") return <ClockWidget locale={locale} now={now} />;
    if (widgetId === "core.media") {
      return (
        <HomeMediaWidget
          locale={locale}
          dataUrl={mediaData}
          fit={settings.mediaFit}
          onRequestMedia={onRequestMedia}
          onRemoveMedia={onRemoveMedia}
        />
      );
    }
    if (widgetId === "core.launcher") {
      return (
        <section
          className="tile launcher-dock"
          style={{ "--launcher-columns": homeLauncherColumnCount(launcherProviders) } as React.CSSProperties}
        >
          <button className="launcher-button launcher-button--terminal" type="button" onClick={() => onOpenTerminal()} title={t(locale, "terminal")}>
            <ProviderIcon provider="terminal" size="large" />
          </button>
          {launcherProviders.map((provider) => (
            <button className="launcher-button" type="button" key={provider} onClick={() => onOpenAgent(provider)} title={PROVIDERS[provider].label}>
              <ProviderIcon provider={provider} size="large" />
            </button>
          ))}
          <button
            className="launcher-button launcher-button--browser"
            type="button"
            onClick={onOpenBrowser}
            title={t(locale, "browser")}
            aria-label={t(locale, "browser")}
          >
            <UiIcon name="browser" size="3.23em" />
          </button>
        </section>
      );
    }
    if (widgetId === "core.settings") {
      return (
        <button className="tile settings-button" type="button" onClick={onOpenSettings} aria-label={t(locale, "settings")}>
          <UiIcon name="settings" size={48} />
        </button>
      );
    }

    const match = widgetId.match(/^plugin:([^:]+):([^:]+)$/);
    const plugin = match ? plugins.find((candidate) => candidate.manifest.id === match[1] && candidate.enabled) : null;
    const contribution = plugin?.manifest.contributions.find((candidate) => (
      candidate.id === match?.[2] && candidate.kind === "home-widget"
    ));
    if (plugin && contribution) {
      const canvasWidgetId = homeCanvasWidgetId(widgetId);
      return (
        <section className="tile plugin-widget">
          <PluginFrame
            key={plugin.selectedModules.join(",")}
            plugin={plugin}
            contribution={contribution}
            locale={locale}
            palette={settings.palette}
            sessions={sessions}
            limits={limits}
            captureCanvasWheelOverWidgets={captureCanvasWheelOverWidgets || focusedWidgetId !== canvasWidgetId}
            onCanvasWheel={onPluginCanvasWheel}
            onFocus={() => onWidgetFocus(canvasWidgetId)}
            onHoverChange={(active) => onWidgetHoverChange(canvasWidgetId, active)}
            onOpenLauncher={openPluginLauncher}
            onError={onPluginError}
          />
        </section>
      );
    }
    return editing ? <div className="tile plugin-widget plugin-widget--unavailable">{widgetId}</div> : null;
  };

  const homePixels = homeGridPixelSize(draftGridSize);

  return (
    <section
      ref={homeElement}
      className={`home-zone ${editing ? "home-zone--editing" : ""}`}
      aria-label={t(locale, "homeZone")}
      style={{
        width: homePixels.width,
        height: homePixels.height,
        gridTemplateColumns: `repeat(${draftGridSize.columns}, ${HOME_GRID_CELL_WIDTH}px)`,
        gridTemplateRows: `repeat(${draftGridSize.rows}, ${HOME_GRID_CELL_HEIGHT}px)`
      }}
    >
      {editing && (
        <>
          <span className="home-zone__boundary-label">
            {t(locale, "homeBoundary")} · {draftGridSize.columns} × {draftGridSize.rows}
          </span>
          <button
            className="home-zone__boundary-resize"
            type="button"
            data-interactive="true"
            aria-label={t(locale, "resizeHomeBoundary")}
            title={t(locale, "resizeHomeBoundary")}
            onPointerDown={startGridPointer}
            onPointerMove={moveGridPointer}
            onPointerUp={endGridPointer}
            onPointerCancel={endGridPointer}
          />
        </>
      )}
      {draftLayout.map((placement) => {
        const content = widgetContent(placement.widgetId);
        if (!content) return null;
        return (
          <div
            className={`home-widget-slot ${isInsideHome(placement, draftGridSize) ? "" : "home-widget-slot--outside"}`}
            data-interactive="true"
            data-canvas-widget-id={homeCanvasWidgetId(placement.widgetId)}
            data-canvas-widget-focusable={isFocusableHomeWidget(placement.widgetId, plugins) ? "true" : undefined}
            key={placement.widgetId}
            style={{
              left: placement.column * HOME_GRID_COLUMN_STEP,
              top: placement.row * HOME_GRID_ROW_STEP,
              width: placement.columnSpan * HOME_GRID_COLUMN_STEP - HOME_GRID_GAP,
              height: placement.rowSpan * HOME_GRID_ROW_STEP - HOME_GRID_GAP
            }}
          >
            {content}
            {editing && (
              <>
                <button
                  className="home-widget-slot__move"
                  type="button"
                  onPointerDown={(event) => startLayoutPointer(event, placement, "move")}
                  onPointerMove={moveLayoutPointer}
                  onPointerUp={endLayoutPointer}
                  onPointerCancel={endLayoutPointer}
                >{placement.widgetId}</button>
                {HOME_RESIZE_DIRECTIONS.map((direction) => (
                  <button
                    className={`home-widget-slot__resize home-widget-slot__resize--${direction}`}
                    type="button"
                    key={direction}
                    aria-label={`${t(locale, "resizeHomeWidget")}: ${placement.widgetId}`}
                    onPointerDown={(event) => startLayoutPointer(event, placement, "resize", direction)}
                    onPointerMove={moveLayoutPointer}
                    onPointerUp={endLayoutPointer}
                    onPointerCancel={endLayoutPointer}
                  />
                ))}
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}

function isFocusableHomeWidget(widgetId: string, plugins: readonly InstalledPlugin[]): boolean {
  if (widgetId === "core.sessions") return true;
  if (!widgetId.startsWith("plugin:")) return false;
  const [, pluginId, contributionId] = widgetId.split(":");
  return plugins.some((plugin) => plugin.enabled
    && plugin.manifest.id === pluginId
    && plugin.manifest.contributions.some((contribution) => (
      contribution.id === contributionId && contribution.kind === "home-widget"
    )));
}

function ClockWidget({ locale, now }: { locale: LocaleId; now: Date }): React.JSX.Element {
  const formatLocale = locale === "ru" ? "ru-RU" : "en-GB";
  const time = now.toLocaleTimeString(formatLocale, { hour: "2-digit", minute: "2-digit" });

  return (
    <section className="tile clock-tile">
      <time className="clock-tile__time">{time}</time>
    </section>
  );
}

function LimitRow({ row, locale, now }: { row: HomeLimitRow; locale: LocaleId; now: number }): React.JSX.Element {
  const providerLabel = PROVIDERS[row.provider].limitsLabel ?? PROVIDERS[row.provider].label;
  const meta = limitMeta(row, locale);
  const stateLabel = row.state === "loading"
    ? t(locale, "limitLoading")
    : row.state === "error"
      ? t(locale, "limitError")
      : row.state === "stale"
        ? t(locale, "limitStale")
        : row.state === "available"
          ? null
          : limitReasonLabel(row.reason, locale);
  const accessibleLabel = [
    providerLabel,
    meta,
    stateLabel !== meta ? stateLabel : null
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <article className={`limit-row limit-row--${row.state}`} aria-label={accessibleLabel} title={accessibleLabel}>
      <ProviderIcon provider={row.provider} size="medium" />
      {row.window ? (
        <span className="limit-row__metric">
          <span className="limit-row__summary">
            <strong>{formatPercent(row.window.usedPercent, locale)}</strong>
            <span>{formatResetCountdown(row.window.resetsAt, now, locale)}</span>
          </span>
          <span className="limit-row__track" aria-hidden="true">
            <i className="limit-row__fill" style={{ width: `${row.window.usedPercent}%` }} />
          </span>
        </span>
      ) : <span className="limit-row__empty">{stateLabel}</span>}
    </article>
  );
}

function limitMeta(row: HomeLimitRow, locale: LocaleId): string {
  if (row.state === "loading") return t(locale, "limitLoading");
  if (row.state === "error") return t(locale, "limitError");
  if (!row.window) return limitReasonLabel(row.reason, locale);

  const details = [
    formatLimitDuration(row.window.windowMinutes, locale),
    `${formatPercent(row.window.usedPercent, locale)} ${t(locale, "limitUsed")}`,
    formatReset(row.window.resetsAt, locale)
  ];
  if (row.state === "stale") {
    details.push(limitReasonLabel(row.reason, locale));
  }
  return details.filter(Boolean).join(" · ");
}

function formatReset(resetsAt: number, locale: LocaleId): string {
  const formatLocale = locale === "ru" ? "ru-RU" : "en-GB";
  const formatted = new Intl.DateTimeFormat(formatLocale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(resetsAt);
  return `${t(locale, "limitResetsAt")} ${formatted}`;
}

function formatPercent(value: number, locale: LocaleId): string {
  return new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-GB", {
    maximumFractionDigits: 1
  }).format(value) + "%";
}

function limitReasonLabel(reason: HomeLimitReason | null, locale: LocaleId): string {
  const key = reason === "cli-not-found"
    ? "limitCliNotFound"
    : reason === "not-authenticated"
      ? "limitNotAuthenticated"
      : reason === "subscription-required"
        ? "limitSubscriptionRequired"
      : reason === "unsupported-protocol"
        ? "limitUnsupported"
        : reason === "timeout"
          ? "limitTimeout"
          : reason === "protocol-error"
            ? "limitProtocolError"
            : reason === "percentage-unavailable"
              ? "limitPercentageUnavailable"
              : reason === "reset-unavailable"
                ? "limitResetUnavailable"
              : reason === "refresh-error"
                ? "limitRefreshError"
                : "limitUnavailable";
  return t(locale, key);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
