import type { Ref } from "react";
import type { LocaleId } from "../../../../shared/contracts.ts";
import {
  USAGE_PERIODS,
  type AccountSeries,
  type ConditionalApp,
  type CoverageKind,
  type EvidenceProvider,
  type ProviderReport,
  type TokenTotals,
  type UsagePeriod,
  type UsageReport,
  type WeightBasis,
  type WindowReport
} from "../../../../shared/usageReport.ts";
import { UiIcon } from "../../components/UiIcon";
import {
  fill,
  formatDateTime,
  formatDuration,
  formatPoints,
  formatTimeZone,
  formatTokens,
  providerName,
  shortScope,
  usageText
} from "./usageText.ts";

export interface UsageHistoryLoadError {
  kind: "unavailable" | "failed";
  message: string;
  at: number;
}

export interface UsageHistoryViewProps {
  locale: LocaleId;
  timeZone: string;
  now: number;
  report: UsageReport | null;
  reportError: string | null;
  loading: boolean;
  loadError: UsageHistoryLoadError | null;
  loadedAt: number | null;
  period: UsagePeriod;
  weightBasis: WeightBasis;
  titleId: string;
  descriptionId: string;
  closeButtonRef?: Ref<HTMLButtonElement>;
  onPeriodChange(period: UsagePeriod): void;
  onWeightBasisChange(basis: WeightBasis): void;
  onRefresh(): void;
  onClose(): void;
}

type Text = ReturnType<typeof usageText>;
interface Format {
  locale: LocaleId;
  text: Text;
  time(value: number): string;
  duration(ms: number): string;
  points(value: number): string;
  tokens(value: number): string;
}

const PERIODS = Object.keys(USAGE_PERIODS) as UsagePeriod[];
const WEIGHT_BASES: WeightBasis[] = ["uncached", "all"];
const COVERAGE_ORDER: CoverageKind[] = [
  "measured", "reset-boundary", "collection-gap", "account-changed", "account-unknown", "reset-unknown",
  "counter-decreased", "conflicting-observations", "window-changed", "invalid-percentage", "invalid-time",
  "period-boundary", "no-observations", "before-collection"
];

/** Stateless: every value comes from props so the container owns all hooks. */
export function UsageHistoryView(props: UsageHistoryViewProps): React.JSX.Element {
  const { locale, timeZone, now, report, period, loading, titleId, descriptionId } = props;
  const text = usageText(locale);
  const format: Format = {
    locale,
    text,
    time: (value) => formatDateTime(locale, timeZone, value),
    duration: (ms) => formatDuration(locale, ms),
    points: (value) => formatPoints(locale, value),
    tokens: (value) => formatTokens(locale, value)
  };
  const from = report?.from ?? now - USAGE_PERIODS[period];
  const to = report?.to ?? now;
  const collectedAt = report?.collection.collectedAt ?? null;

  return (
    <>
      <header className="usage-history__header">
        <div className="usage-history__heading">
          <h2 id={titleId}>{text.title}</h2>
          <p id={descriptionId}>{text.subtitle}</p>
        </div>
        <div className="usage-history__actions">
          <button type="button" className="usage-history__refresh" onClick={props.onRefresh} disabled={loading} aria-busy={loading}>
            <UiIcon name="reload" size={16} />
            <span>{loading ? text.refreshing : text.refresh}</span>
          </button>
          <button ref={props.closeButtonRef} type="button" className="usage-history__close" onClick={props.onClose} aria-label={text.close} title={text.close}>
            <UiIcon name="close" size={18} />
          </button>
        </div>
      </header>

      <div className="usage-history__toolbar">
        <fieldset className="usage-history__choice">
          <legend className="usage-history__visually-hidden">{text.period}</legend>
          <div className="usage-history__segmented">
            {PERIODS.map((option) => (
              <label key={option} className={option === period ? "usage-history__segment usage-history__segment--active" : "usage-history__segment"}>
                <input type="radio" name="usage-history-period" value={option} checked={option === period} onChange={() => props.onPeriodChange(option)} />
                <span>{text.periods[option]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="usage-history__range">
          <strong>{fill(text.range, { from: format.time(from), to: format.time(to) })}</strong>
          <span>{fill(text.timeZone, { zone: formatTimeZone(locale, timeZone, to) })}</span>
        </div>
        <div className="usage-history__meta">
          <span>{text.autoRefresh}</span>
          {props.loadedAt !== null && <span>{fill(text.loadedAt, { time: format.time(props.loadedAt) })}</span>}
          {collectedAt !== null && <span>{fill(text.collectedAt, { time: format.time(collectedAt) })}</span>}
        </div>
      </div>

      <div className="usage-history__body">
        <StatusBanners {...props} format={format} />
        {report && (
          <>
            <ConditionalSection report={report} format={format} weightBasis={props.weightBasis} onWeightBasisChange={props.onWeightBasisChange} />
            <QuotaSection report={report} format={format} />
            <EvidenceSection report={report} format={format} />
            <SourcesSection report={report} format={format} />
          </>
        )}
      </div>
    </>
  );
}

function StatusBanners({ report, reportError, loadError, loading, format }: UsageHistoryViewProps & { format: Format }): React.JSX.Element {
  const { text } = format;
  const collection = report?.collection;
  return (
    <div className="usage-history__banners">
      {loadError?.kind === "unavailable" && <p className="usage-history__banner usage-history__banner--error" role="alert">{text.apiUnavailable}</p>}
      {loadError?.kind === "failed" && (
        <p className="usage-history__banner usage-history__banner--error" role="alert">
          {fill(text.loadFailed, { message: loadError.message })}
          {report ? ` ${text.showingPrevious}` : ""}
        </p>
      )}
      {reportError && <p className="usage-history__banner usage-history__banner--error" role="alert">{fill(text.reportFailed, { message: reportError })}</p>}
      {collection?.error && <p className="usage-history__banner usage-history__banner--error">{fill(text.collectorError, { message: collection.error })}</p>}
      {collection?.stale && (
        <p className="usage-history__banner usage-history__banner--warning">
          {collection.ageMs === null ? text.historyNeverCollected : fill(text.historyStale, { age: format.duration(collection.ageMs) })}
        </p>
      )}
      {loading && !report && !loadError && <p className="usage-history__banner" role="status">{text.loading}</p>}
    </div>
  );
}

function QuotaSection({ report, format }: { report: UsageReport; format: Format }): React.JSX.Element {
  const { text } = format;
  return (
    <section className="usage-history__section" aria-labelledby="usage-history-quota">
      <h3 id="usage-history-quota">{text.quotaTitle}</h3>
      <p className="usage-history__note">{text.quotaNote}</p>
      <div className="usage-history__provider-status">
        <h6>{text.providerStatus}</h6>
        {report.collection.providerStatus.length ? (
          <ul className="usage-history__list">{report.collection.providerStatus.map((line, index) => <li key={index}>{line}</li>)}</ul>
        ) : <p className="usage-history__muted">{text.noStatus}</p>}
      </div>
      {report.providers.length === 0 && <p className="usage-history__empty">{text.noQuota}</p>}
      {report.providers.map((provider) => <ProviderQuota key={provider.provider} provider={provider} format={format} />)}
    </section>
  );
}

function ProviderQuota({ provider, format }: { provider: ProviderReport; format: Format }): React.JSX.Element {
  const { text } = format;
  return (
    <div className="usage-history__provider">
      <h4>{providerName(format.locale, provider.provider)}</h4>
      {provider.quotaStatus === "no-samples" && <p className="usage-history__banner usage-history__banner--warning">{text.providerNoSamples}</p>}
      {provider.quotaStatus === "provider-unknown" && <p className="usage-history__banner usage-history__banner--warning">{text.providerUnknown}</p>}
      {provider.windows.map((quota) => <QuotaWindow key={quota.windowId} quota={quota} format={format} />)}
    </div>
  );
}

function QuotaWindow({ quota, format }: { quota: WindowReport; format: Format }): React.JSX.Element {
  const { text } = format;
  const coverage = COVERAGE_ORDER.filter((kind) => quota.coverage[kind] > 0);
  const counts = new Map<CoverageKind, number>(quota.unknownIntervals.map((item) => [item.reason, item.count]));
  return (
    <article className="usage-history__window">
      <header className="usage-history__window-header">
        <h5>{text.window} <code>{quota.windowId}</code></h5>
        {quota.resetBoundaries > 0 && <span className="usage-history__chip">{fill(text.resetsInPeriod, { count: quota.resetBoundaries })}</span>}
      </header>
      {quota.latest === null && <p className="usage-history__banner usage-history__banner--warning">{text.windowNeverObserved}</p>}
      {quota.latest !== null && quota.staleness.stale && quota.staleness.ageMs !== null && (
        <p className="usage-history__banner usage-history__banner--warning">{fill(text.windowStale, { age: format.duration(quota.staleness.ageMs) })}</p>
      )}
      {quota.staleness.resetPassed && <p className="usage-history__banner usage-history__banner--warning">{text.resetPassed}</p>}
      {quota.accounts.length === 0 && quota.latest !== null && (
        <p className="usage-history__note">
          {fill(text.noObservationsInPeriod, {
            percent: format.points(quota.latest.percent),
            time: format.time(quota.latest.at),
            account: quota.latest.scope ? shortScope(quota.latest.scope) : text.accountUnknown
          })}
        </p>
      )}
      {quota.accounts.map((account) => <AccountQuota key={JSON.stringify(account.scope)} account={account} format={format} />)}
      <div className="usage-history__coverage">
        <h6>{text.coverage}</h6>
        <ul>
          {coverage.map((kind) => (
            <li key={kind} className={kind === "measured" ? "usage-history__coverage-measured" : "usage-history__coverage-unknown"}>
              {fill(text.coverageEntry, { label: text.coverageKinds[kind], duration: format.duration(quota.coverage[kind]) })}
              {counts.has(kind) && <span className="usage-history__muted"> · {fill(text.intervalsCount, { count: counts.get(kind) ?? 0 })}</span>}
            </li>
          ))}
        </ul>
      </div>
      {quota.ambiguousPollDeltas.events > 0 && (
        <p className="usage-history__note">{fill(text.ambiguousPolls, { events: quota.ambiguousPollDeltas.events, tokens: format.tokens(quota.ambiguousPollDeltas.tokens) })}</p>
      )}
      {quota.unmatchedEvidence.events > 0 && (
        <p className="usage-history__note">{fill(text.unmatchedEvidence, { events: quota.unmatchedEvidence.events, tokens: format.tokens(quota.unmatchedEvidence.tokens) })}</p>
      )}
    </article>
  );
}

function AccountQuota({ account, format }: { account: AccountSeries; format: Format }): React.JSX.Element {
  const { text } = format;
  const latestReset = account.latest?.reset ?? null;
  const measured = account.measuredIntervals > 0;
  return (
    <section className="usage-history__account">
      <dl className="usage-history__facts">
        <div>
          <dt>{text.account}</dt>
          <dd>{account.scope ? <code title={account.scope}>{shortScope(account.scope)}</code> : <em>{text.accountUnknown}</em>}</dd>
        </div>
        <div>
          <dt>{text.latest}</dt>
          <dd>{account.latest ? fill(text.latestValue, { percent: format.points(account.latest.percent), time: format.time(account.latest.at) }) : "—"}</dd>
        </div>
        <div>
          <dt>{text.reset}</dt>
          <dd>{latestReset === null ? text.resetUnknown : format.time(latestReset)}</dd>
        </div>
        <div>
          <dt>{text.measured}</dt>
          {measured ? (
            <dd>
              <strong>{fill(text.measuredValue, { points: format.points(account.measuredDelta) })}</strong>
              <span className="usage-history__muted">{fill(text.measuredDetail, { count: account.measuredIntervals, duration: format.duration(account.measuredMs) })}</span>
            </dd>
          ) : <dd><em>{text.notMeasured}</em></dd>}
        </div>
        <div>
          <dt>{text.attribution}</dt>
          <dd>{text.provenNone}</dd>
        </div>
        <div className="usage-history__fact--unattributed">
          <dt>{text.unattributed}</dt>
          <dd>
            <strong>{measured ? fill(text.unattributedValue, { points: format.points(account.attribution.unattributed) }) : text.unattributedUnknown}</strong>
          </dd>
        </div>
      </dl>
      {account.attribution.candidateSessions.length > 0 && (
        <details className="usage-history__details">
          <summary>{text.candidates} · {account.attribution.candidateSessions.length}</summary>
          <div className="usage-history__table-wrap">
            <table className="usage-history__table">
              <thead>
                <tr>
                  <th scope="col">{text.columnSession}</th>
                  <th scope="col">{text.columnEvents}</th>
                  <th scope="col">{text.columnWeight}</th>
                </tr>
              </thead>
              <tbody>
                {account.attribution.candidateSessions.map((session) => (
                  <tr key={JSON.stringify([session.app, session.profile, session.session])}>
                    <th scope="row"><SessionLabel {...session} format={format} /></th>
                    <td>{session.events}</td>
                    <td>{format.tokens(session.weight)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function SessionLabel({ app, profile, session, format }: { app: string; profile: string; session: string; format: Format }): React.JSX.Element {
  return (
    <span className="usage-history__session">
      <span>{app}{profile ? ` · ${fill(format.text.profile, { name: profile })}` : ""}</span>
      <code title={session}>{session}</code>
    </span>
  );
}

function EvidenceSection({ report, format }: { report: UsageReport; format: Format }): React.JSX.Element {
  const { text } = format;
  const { evidence } = report;
  return (
    <section className="usage-history__section" aria-labelledby="usage-history-evidence">
      <h3 id="usage-history-evidence">{text.evidenceTitle}</h3>
      <p className="usage-history__note">{text.evidenceNote}</p>
      {evidence.providers.length === 0 && <p className="usage-history__empty">{text.noEvidence}</p>}
      {evidence.providers.map((provider) => <EvidenceTable key={provider.provider} provider={provider} format={format} />)}
      <div className="usage-history__unknown" role="note">
        <strong>{text.evidenceUnknown}</strong>
        <span>{text.evidenceUnknownDetail}</span>
      </div>
      {evidence.outsidePeriod.events > 0 && (
        <p className="usage-history__note">
          {fill(text.outsidePeriod, { events: evidence.outsidePeriod.events, tokens: format.tokens(evidence.outsidePeriod.input + evidence.outsidePeriod.output) })}
        </p>
      )}
    </section>
  );
}

function EvidenceTable({ provider, format }: { provider: EvidenceProvider; format: Format }): React.JSX.Element {
  const { text } = format;
  return (
    <div className="usage-history__table-wrap">
      <table className="usage-history__table usage-history__table--evidence">
        <caption>{providerName(format.locale, provider.provider)}</caption>
        <thead>
          <tr>
            <th scope="col">{text.columnSession}</th>
            <th scope="col">{text.columnEvents}</th>
            <th scope="col">{text.columnInput}</th>
            <th scope="col">{text.columnCached}</th>
            <th scope="col">{text.columnOutput}</th>
            <th scope="col">{text.columnTotal}</th>
          </tr>
        </thead>
        {provider.apps.map((app) => (
          <tbody key={app.app}>
            <TotalsRow level="app" label={app.app} totals={app.totals} format={format} />
            {app.profiles.map((profile) => [
              <TotalsRow key={`profile:${profile.profile}`} level="profile" totals={profile.totals} format={format}
                label={profile.profile ? fill(text.profile, { name: profile.profile }) : text.noProfile} />,
              ...profile.sessions.map((session) => (
                <TotalsRow key={`session:${profile.profile}:${session.session}`} level="session" label={session.session} totals={session.totals} format={format} />
              ))
            ])}
          </tbody>
        ))}
        <tfoot>
          <TotalsRow level="total" label={text.columnTotal} totals={provider.totals} format={format} />
        </tfoot>
      </table>
    </div>
  );
}

function TotalsRow({ level, label, totals, format }: {
  level: "app" | "profile" | "session" | "total";
  label: string;
  totals: TokenTotals;
  format: Format;
}): React.JSX.Element {
  return (
    <tr className={`usage-history__row usage-history__row--${level}`}>
      <th scope="row">{level === "session" ? <code title={label}>{label}</code> : label}</th>
      <td>{totals.events}</td>
      <td>{format.tokens(totals.input)}</td>
      <td>{format.tokens(totals.cached)}</td>
      <td>{format.tokens(totals.output)}</td>
      <td>{format.tokens(totals.input + totals.output)}</td>
    </tr>
  );
}

function ConditionalSection({ report, format, weightBasis, onWeightBasisChange }: {
  report: UsageReport;
  format: Format;
  weightBasis: WeightBasis;
  onWeightBasisChange(basis: WeightBasis): void;
}): React.JSX.Element {
  const { text } = format;
  const { coverage } = report.attribution;
  const series = report.providers.flatMap((provider) => provider.windows.flatMap((quota) => (
    quota.accounts.map((account) => ({ provider: provider.provider, quota, account }))
  )));
  return (
    <section className="usage-history__section usage-history__section--conditional" aria-labelledby="usage-history-conditional">
      <h3 id="usage-history-conditional">{text.conditionalTitle}</h3>
      <p className="usage-history__note">{text.conditionalIntro}</p>
      <p className="usage-history__muted">{coverage.level === "recorded" ? text.coverageRecorded : text.coverageLimited}</p>
      {coverage.sourceProblems.length > 0 && (
        <p className="usage-history__banner usage-history__banner--warning">{fill(text.sourceProblems, { list: coverage.sourceProblems.join(" · ") })}</p>
      )}
      {series.length === 0 && <p className="usage-history__empty">{text.conditionalEmpty}</p>}
      {series.map(({ provider, quota, account }) => (
        <ConditionalAccount key={JSON.stringify([provider, quota.windowId, account.scope])} provider={provider} quota={quota} account={account} format={format} />
      ))}
      <div className="usage-history__scenario-controls">
        <fieldset className="usage-history__choice">
          <legend>{text.weightLabel}</legend>
          <div className="usage-history__segmented">
            {WEIGHT_BASES.map((basis) => (
              <label key={basis} className={basis === weightBasis ? "usage-history__segment usage-history__segment--active" : "usage-history__segment"}>
                <input type="radio" name="usage-history-weight" value={basis} checked={basis === weightBasis} onChange={() => onWeightBasisChange(basis)} />
                <span>{text.weightBases[basis]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <details className="usage-history__details">
        <summary>{text.assumptionsTitle}</summary>
        <ul className="usage-history__assumptions">
          {text.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
        </ul>
      </details>
    </section>
  );
}

function ConditionalAccount({ provider, quota, account, format }: {
  provider: string;
  quota: WindowReport;
  account: AccountSeries;
  format: Format;
}): React.JSX.Element {
  const { text } = format;
  const { attribution } = account;
  const unestimated = attribution.unestimable.reduce((sum, entry) => sum + entry.delta, 0);
  const measured = account.measuredIntervals > 0;
  return (
    <article className="usage-history__conditional-result">
      <h5>
        {providerName(format.locale, provider)} · <code>{quota.windowId}</code> · {account.scope ? <code title={account.scope}>{shortScope(account.scope)}</code> : text.accountUnknown}
      </h5>
      {!measured ? <p className="usage-history__muted">{text.conditionalNotMeasured}</p> : (
        <>
          <ul className="usage-history__conditional-summary">
            <li><strong>{fill(text.conditionalMeasured, { points: format.points(account.measuredDelta) })}</strong></li>
            {attribution.eligible.clusters > 0
              ? <li className="usage-history__conditional">{fill(text.conditionalLocal, { points: format.points(attribution.conditional.points) })}</li>
              : <li className="usage-history__muted">{text.conditionalNone}</li>}
            <li>{fill(text.conditionalExternal, { max: format.points(attribution.externalRange.max) })}</li>
            {unestimated > 0 && (
              <li>
                {fill(text.conditionalUnestimable, { points: format.points(unestimated) })}
                <ul className="usage-history__list">
                  {attribution.unestimable.map((entry) => (
                    <li key={entry.reason}>{fill(text.unestimableEntry, { label: text.unestimableReasons[entry.reason], points: format.points(entry.delta) })}</li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
          {attribution.unknownProviderOverlap.events > 0 && (
            <p className="usage-history__note">{fill(text.unknownOverlap, {
              events: attribution.unknownProviderOverlap.events, tokens: format.tokens(attribution.unknownProviderOverlap.tokens)
            })}</p>
          )}
          {attribution.conditional.apps.length > 0 && <ConditionalTree apps={attribution.conditional.apps} format={format} />}
        </>
      )}
    </article>
  );
}

function ConditionalTree({ apps, format }: { apps: ConditionalApp[]; format: Format }): React.JSX.Element {
  const { text } = format;
  const row = (level: "app" | "profile" | "session", key: string, label: React.ReactNode, item: { points: number }, weight?: number): React.JSX.Element => (
    <tr key={key} className={`usage-history__tree-row usage-history__tree-row--${level}`}>
      <th scope="row">{label}</th>
      <td className="usage-history__conditional">≈ {format.points(item.points)}</td>
      <td>{weight === undefined ? "" : format.tokens(weight)}</td>
    </tr>
  );
  return (
    <div className="usage-history__table-wrap">
      <table className="usage-history__table usage-history__table--tree">
        <thead>
          <tr>
            <th scope="col">{text.columnSession}</th>
            <th scope="col">{text.columnPoints}</th>
            <th scope="col">{text.columnWeight}</th>
          </tr>
        </thead>
        {apps.map((app) => (
          <tbody key={app.app}>
            {row("app", `app:${app.app}`, app.app, app)}
            {app.profiles.flatMap((profile) => [
              row("profile", `profile:${profile.profile}`, profile.profile ? fill(text.profile, { name: profile.profile }) : text.noProfile, profile),
              ...profile.sessions.map((session) => row("session", `session:${profile.profile}:${session.session}`,
                <code title={session.session}>{session.session}</code>, session, session.weight))
            ])}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function SourcesSection({ report, format }: { report: UsageReport; format: Format }): React.JSX.Element {
  const { text } = format;
  const issues = (Object.keys(text.issues) as (keyof typeof text.issues)[]).filter((key) => report.issues[key] > 0);
  return (
    <section className="usage-history__section" aria-labelledby="usage-history-sources">
      <h3 id="usage-history-sources">{text.statusTitle}</h3>
      <h6>{text.coverageNotes}</h6>
      {report.collection.coverage.length ? (
        <ul className="usage-history__list">{report.collection.coverage.map((line, index) => <li key={index}>{line}</li>)}</ul>
      ) : <p className="usage-history__muted">{text.noStatus}</p>}
      <h6>{text.issuesTitle}</h6>
      {issues.length ? (
        <ul className="usage-history__list">{issues.map((key) => <li key={key}>{fill(text.issues[key], { count: report.issues[key] })}</li>)}</ul>
      ) : <p className="usage-history__muted">{text.noIssues}</p>}
    </section>
  );
}
