import { useEffect, useMemo, useState } from "react";
import type {
  AgentProviderId,
  AppSettings,
  LimitsSnapshot,
  LocaleId,
  SessionSnapshot
} from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { AGENT_PROVIDERS, PROVIDERS } from "../../lib/providers";
import { sessionStatusIcon, sessionStatusLabel } from "../../lib/sessionStatus";
import { HomeMediaWidget } from "./HomeMediaWidget";
import {
  formatLimitDuration,
  formatResetCountdown,
  selectHomeModel,
  type HomeLimitReason,
  type HomeLimitRow,
  type LimitsLoadState
} from "./homeModel";

interface HomeZoneProps {
  settings: AppSettings;
  mediaData: string | null;
  sessions: SessionSnapshot[];
  limits: LimitsSnapshot | null;
  limitsLoadState: LimitsLoadState;
  onOpenSettings(): void;
  onOpenAgent(provider: AgentProviderId): void;
  onOpenTerminal(): void;
  onOpenBrowser(): void;
  onFocusSession(session: SessionSnapshot): void;
  onRequestMedia(): Promise<void>;
  onRemoveMedia(): Promise<void>;
}

export function HomeZone({
  settings,
  mediaData,
  sessions,
  limits,
  limitsLoadState,
  onOpenSettings,
  onOpenAgent,
  onOpenTerminal,
  onOpenBrowser,
  onFocusSession,
  onRequestMedia,
  onRemoveMedia
}: HomeZoneProps): React.JSX.Element {
  const locale = settings.locale;
  const [now, setNow] = useState(() => new Date());
  const home = useMemo(
    () => selectHomeModel(sessions, limits, limitsLoadState, now.getTime()),
    [sessions, limits, limitsLoadState, now]
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="home-zone" data-interactive="true" aria-label={t(locale, "homeZone")}>
      <div className="home-zone__top">
        <section className="tile agent-overview limits-list" aria-label={t(locale, "modelLimits")}>
          {home.limitRows.map((row) => (
            <LimitRow key={row.provider} row={row} locale={locale} now={now.getTime()} />
          ))}
        </section>

        <section className="tile usage-list" data-wheel-owner="local" aria-label={t(locale, "activeSessions")}>
          {home.sessionRows.length === 0 ? (
            <div className="home-empty">{t(locale, "noActiveSessions")}</div>
          ) : home.sessionRows.map((session) => {
            const statusIcon = sessionStatusIcon(session.status);
            return (
              <button
                className="usage-row"
                type="button"
                key={session.id}
                onClick={() => onFocusSession(session)}
                aria-label={`${session.title}, ${sessionStatusLabel(locale, session.status)}`}
                title={session.title}
              >
                <ProviderIcon provider={session.provider} size="medium" />
                <span className="usage-row__copy">
                  <strong>{sessionStatusLabel(locale, session.status)}</strong>
                  <span>{session.title}</span>
                </span>
                {statusIcon && <UiIcon name={statusIcon} size={24} />}
              </button>
            );
          })}
        </section>
      </div>

      <div className="home-zone__middle">
        <ClockWidget locale={locale} now={now} />
        <HomeMediaWidget
          locale={locale}
          dataUrl={mediaData}
          fit={settings.mediaFit}
          onRequestMedia={onRequestMedia}
          onRemoveMedia={onRemoveMedia}
        />
      </div>

      <div className="home-zone__launcher-row">
        <section className="tile launcher-dock">
          <button className="launcher-button launcher-button--terminal" type="button" onClick={onOpenTerminal} title={t(locale, "terminal")}>
            <ProviderIcon provider="terminal" size="large" />
          </button>
          {AGENT_PROVIDERS.map((provider) => (
            <button className="launcher-button" type="button" key={provider} onClick={() => onOpenAgent(provider)} title={provider}>
              <ProviderIcon provider={provider} size="large" />
            </button>
          ))}
          <button className="launcher-button" type="button" onClick={onOpenBrowser} title={t(locale, "browser")}>
            <UiIcon name="globe" size={34} />
          </button>
        </section>
        <button className="tile settings-button" type="button" onClick={onOpenSettings} aria-label={t(locale, "settings")}>
          <UiIcon name="settings" size={48} />
        </button>
      </div>
    </section>
  );
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
  const providerLabel = PROVIDERS[row.provider].label;
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
          <strong>{formatResetCountdown(row.window.resetsAt, now, locale)}</strong>
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
