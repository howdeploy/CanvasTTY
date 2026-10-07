import type { LocaleId } from "../../../../shared/contracts.ts";
import type { CoverageKind, UnestimableReason, UsagePeriod, WeightBasis } from "../../../../shared/usageReport.ts";

const RU = {
  trigger: "История использования",
  title: "История использования",
  subtitle: "Измеренные изменения квот, их автоматическая условная оценка по локальным сеансам и сами свидетельства токенов. Атрибуция не доказана.",
  close: "Закрыть",
  refresh: "Обновить",
  refreshing: "Обновление…",
  period: "Период",
  periods: { "1h": "1 ч", "24h": "24 ч", "7d": "7 дней", "30d": "30 дней" } satisfies Record<UsagePeriod, string>,
  range: "{from} — {to}",
  timeZone: "Часовой пояс: {zone}",
  autoRefresh: "Обновляется раз в минуту, пока окно открыто.",
  loadedAt: "Получено: {time}",
  collectedAt: "Сбор данных: {time}",
  loading: "Загрузка истории…",
  apiUnavailable: "Источник истории использования недоступен в этой сборке (нет window.canvasTTY.usageHistory.get). Данные не показываются, а не подменяются.",
  loadFailed: "Не удалось получить историю: {message}",
  showingPrevious: "Показаны последние успешно полученные данные.",
  collectorError: "Сборщик сообщил об ошибке: {message}",
  historyStale: "Данные сборщика устарели: последний сбор {age} назад.",
  historyNeverCollected: "Время последнего сбора неизвестно — данные считаются устаревшими.",
  reportFailed: "Не удалось построить отчёт: {message}",

  quotaTitle: "Квоты: измеренные изменения",
  quotaNote: "Процентные пункты считаются только между соседними сопоставимыми наблюдениями (тот же провайдер, аккаунт и окно, тот же сброс, интервал не больше 5 минут), и только если интервал целиком внутри периода. Каждое окно квоты показано отдельно: основное и недельное окна не суммируются, аккаунты тоже.",
  noQuota: "Нет наблюдений квот.",
  providerNoSamples: "Нет наблюдений квоты этого провайдера — его изменение неизвестно.",
  providerUnknown: "Провайдер не определён — эти токены не сопоставляются ни с одной квотой.",
  window: "Окно квоты",
  account: "Аккаунт (хеш)",
  accountUnknown: "аккаунт неизвестен",
  latest: "Последнее наблюдение",
  latestValue: "{percent}% · {time}",
  reset: "Сброс окна",
  resetUnknown: "неизвестен",
  resetsInPeriod: "Сбросов окна за период: {count}",
  resetPassed: "Сброс уже наступил после последнего наблюдения — текущее значение неизвестно.",
  windowStale: "Последнее наблюдение {age} назад — ряд устарел, новые изменения не измеряются.",
  windowNeverObserved: "Нет наблюдений до конца периода.",
  noObservationsInPeriod: "За период наблюдений нет. Последнее до него: {percent}% · {time} · {account}.",
  unknownProviderName: "Провайдер не определён",
  measured: "Измерено",
  measuredValue: "+{points} п. п.",
  measuredDetail: "сопоставимых интервалов: {count}, {duration}",
  notMeasured: "не измерено — нет сопоставимых интервалов",
  attribution: "Атрибуция",
  provenNone: "доказанной нет",
  unattributed: "Не атрибутировано",
  unattributedValue: "{points} п. п. — всё измеренное",
  unattributedUnknown: "неизвестно — изменение не измерено",
  coverage: "Покрытие периода",
  coverageKinds: {
    measured: "измерено",
    "conflicting-observations": "противоречивые наблюдения",
    "account-unknown": "аккаунт неизвестен",
    "account-changed": "смена аккаунта",
    "window-changed": "смена окна",
    "invalid-percentage": "некорректный процент",
    "invalid-time": "некорректное время",
    "reset-unknown": "время сброса неизвестно",
    "reset-boundary": "граница сброса",
    "collection-gap": "пропуск сбора > 5 мин",
    "counter-decreased": "счётчик уменьшился",
    "period-boundary": "интервал на границе периода",
    "no-observations": "нет наблюдений",
    "before-collection": "до начала сбора"
  } satisfies Record<CoverageKind, string>,
  coverageEntry: "{label}: {duration}",
  intervalsCount: "{count} инт.",
  ambiguousPolls: "Poll-delta вне сопоставимого покрытия: {events} соб., {tokens} токенов — не отнесены ни к одному интервалу.",
  unmatchedEvidence: "Токены этого провайдера в неизмеренное время: {events} соб., {tokens} токенов.",
  candidates: "Сеансы-кандидаты в измеренных интервалах (веса, не доказательство)",

  evidenceTitle: "Токены из локальных логов",
  evidenceNote: "Приложение → профиль Hermes → ID сеанса. Только счётчики токенов: названия и содержимое бесед не читаются и не показываются. Логи не подтверждают, с какого аккаунта шёл сеанс.",
  noEvidence: "Нет локальных записей токенов за период.",
  columnSession: "Сеанс",
  columnEvents: "Событий",
  columnInput: "Вход",
  columnCached: "в т. ч. кэш",
  columnOutput: "Выход",
  columnTotal: "Всего",
  columnWeight: "Вес",
  columnPoints: "≈ п. п. (условно)",
  noProfile: "без профиля",
  profile: "профиль {name}",
  evidenceUnknown: "Неизвестно / не записано локально",
  evidenceUnknownDetail: "Другие устройства, веб- и мобильные клиенты, API-ключи вне этих приложений, удалённые или ненайденные логи, другие пользователи ОС — не учитываются и остаются неизвестными.",
  outsidePeriod: "Poll-delta через границу периода: {events} соб., {tokens} токенов — нельзя отнести к периоду.",

  conditionalTitle: "Условная оценка: приложения → профили → сеансы",
  conditionalIntro: "Считается автоматически и отдельно для каждого окна квоты и аккаунта. Это не измерение: ЕСЛИ записанная локально активность этого провайдера объясняет измеренное изменение пригодного интервала, то оно делится между сеансами по весам токенов. Логи не доказывают, с какого аккаунта шла оплата.",
  conditionalMeasured: "Измерено: +{points} п. п.",
  conditionalLocal: "Условно на локальные сеансы: ≈ {points} п. п.",
  conditionalExternal: "Внешний вклад (другие устройства, веб, прочие инструменты): неизвестен, от 0 до {max} п. п.",
  conditionalUnestimable: "Не оценено: {points} п. п.",
  conditionalNone: "Нет пригодных интервалов — условная оценка не рассчитана, всё измеренное остаётся неизвестным.",
  conditionalNotMeasured: "Изменение не измерено — оценивать нечего.",
  conditionalEmpty: "Нет измеренных изменений квот за период.",
  unestimableReasons: {
    "unplaceable-poll-delta": "poll-delta пересекает границу сопоставимого покрытия",
    "evidence-conflict": "запись токенов этого интервала исключена из-за конфликта ID — свидетельства неполны",
    "no-local-evidence": "нет локальных событий этого провайдера",
    "baseline-warmup": "первые минуты после начала сбора (базовая линия)",
    "coverage-unrecorded": "для этого времени состояние сбора логов не записано",
    "records-lost": "сбор мог потерять учётные записи этого интервала (см. покрытие)",
    "pending-maturity": "логи ещё дозаписываются — оценка появится позже",
    "source-backlog": "сборщик ещё не дочитал логи (очередь чтения)",
    "collection-incomplete": "сбор локальных логов не завершён полностью (сбой или недоступные источники, см. покрытие)"
  } satisfies Record<UnestimableReason, string>,
  unestimableEntry: "{label}: {points} п. п.",
  coverageLimited: "Покрытие логов ограничено: состояние каждого сбора не записано, условная оценка недоступна.",
  coverageRecorded: "Покрытие логов: по записанному состоянию каждого сбора.",
  sourceProblems: "Источники с ошибкой в последнем сборе (их активность в оценку не входит): {list}",
  unknownOverlap: "В оценённых интервалах есть локальная активность неизвестного провайдера: {events} соб., {tokens} токенов — она могла расходовать эту квоту и в оценку не входит.",
  weightLabel: "Веса токенов",
  weightBases: {
    uncached: "без чтений кэша (вход − кэш + выход)",
    all: "все токены (вход с кэшем + выход)"
  } satisfies Record<WeightBasis, string>,
  assumptionsTitle: "Метод и допущения",
  assumptions: [
    "Пригодный интервал: сопоставимые наблюдения одного окна и аккаунта, локальные события того же провайдера внутри, логи дочитаны и уже не дозаписываются, нет неразмещаемых poll-delta.",
    "Все сеансы того же провайдера в пригодном интервале считаются работавшими на этом аккаунте. Логи этого не доказывают.",
    "Формула квоты провайдера неизвестна: токены — только относительные веса, а не пересчёт в проценты.",
    "Кэш: при весах «без чтений кэша» прочитанный кэш не учитывается, записи кэша Claude входят во вход. Reasoning-токены уже входят в выход и не добавляются повторно.",
    "Одновременные сеансы в одном интервале делят его изменение пропорционально весам. Изменение сразу после событий (до 1 мин) относится к ним: провайдер учитывает расход с задержкой.",
    "Основное и недельное окна — разные шкалы: их оценки не складываются.",
  ],

  statusTitle: "Состояние источников",
  providerStatus: "Статус провайдеров (от сборщика)",
  coverageNotes: "Покрытие сборщика",
  noStatus: "Сборщик не передал сведений.",
  issuesTitle: "Проблемы входных данных",
  issues: {
    invalidSamples: "Отброшено некорректных наблюдений квот: {count}",
    duplicateSamples: "Схлопнуто дубликатов наблюдений: {count}",
    conflictingSamples: "Противоречивых наблюдений (одинаковое время): {count}",
    invalidEvents: "Отброшено некорректных записей токенов: {count}",
    duplicateEvents: "Отброшено дубликатов событий по ID: {count}",
    mergedEventUpdates: "Потоковых обновлений того же события (взято одно): {count}",
    conflictingEvents: "Событий с конфликтующим ID (исключены): {count}"
  },
  noIssues: "Не обнаружено."
};

type UsageText = typeof RU;

const EN: UsageText = {
  trigger: "Usage history",
  title: "Usage history",
  subtitle: "Measured quota changes, their automatic conditional estimate by local session, and the token evidence itself. Attribution is not proven.",
  close: "Close",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  period: "Period",
  periods: { "1h": "1 h", "24h": "24 h", "7d": "7 days", "30d": "30 days" },
  range: "{from} — {to}",
  timeZone: "Time zone: {zone}",
  autoRefresh: "Refreshes every minute while open.",
  loadedAt: "Received: {time}",
  collectedAt: "Collected: {time}",
  loading: "Loading history…",
  apiUnavailable: "The usage history source is not available in this build (no window.canvasTTY.usageHistory.get). Nothing is shown instead of guessing.",
  loadFailed: "Could not load history: {message}",
  showingPrevious: "Showing the last successfully received data.",
  collectorError: "The collector reported an error: {message}",
  historyStale: "Collector data is stale: last collected {age} ago.",
  historyNeverCollected: "Last collection time is unknown — data is treated as stale.",
  reportFailed: "Could not build the report: {message}",

  quotaTitle: "Quotas: measured changes",
  quotaNote: "Percentage points are counted only between adjacent comparable observations (same provider, account and window, same reset, at most 5 minutes apart) and only when the interval lies wholly inside the period. Each quota window is shown separately: primary and weekly windows are never summed, and neither are accounts.",
  noQuota: "No quota observations.",
  providerNoSamples: "No quota observations for this provider — its change is unknown.",
  providerUnknown: "Provider not identified — these tokens are not matched to any quota.",
  window: "Quota window",
  account: "Account (hash)",
  accountUnknown: "account unknown",
  latest: "Latest observation",
  latestValue: "{percent}% · {time}",
  reset: "Window reset",
  resetUnknown: "unknown",
  resetsInPeriod: "Window resets in period: {count}",
  resetPassed: "The reset has passed since the latest observation — the current value is unknown.",
  windowStale: "Latest observation {age} ago — the series is stale and new changes are not measured.",
  windowNeverObserved: "No observations up to the end of the period.",
  noObservationsInPeriod: "No observations in this period. Latest before it: {percent}% · {time} · {account}.",
  unknownProviderName: "Provider not identified",
  measured: "Measured",
  measuredValue: "+{points} pp",
  measuredDetail: "comparable intervals: {count}, {duration}",
  notMeasured: "not measured — no comparable intervals",
  attribution: "Attribution",
  provenNone: "none proven",
  unattributed: "Unattributed",
  unattributedValue: "{points} pp — all of the measured change",
  unattributedUnknown: "unknown — the change was not measured",
  coverage: "Period coverage",
  coverageKinds: {
    measured: "measured",
    "conflicting-observations": "conflicting observations",
    "account-unknown": "account unknown",
    "account-changed": "account changed",
    "window-changed": "window changed",
    "invalid-percentage": "invalid percentage",
    "invalid-time": "invalid time",
    "reset-unknown": "reset time unknown",
    "reset-boundary": "reset boundary",
    "collection-gap": "collection gap > 5 min",
    "counter-decreased": "counter decreased",
    "period-boundary": "interval crosses the period edge",
    "no-observations": "no observations",
    "before-collection": "before collection started"
  },
  coverageEntry: "{label}: {duration}",
  intervalsCount: "{count} int.",
  ambiguousPolls: "Poll deltas outside comparable coverage: {events} events, {tokens} tokens — not assigned to any interval.",
  unmatchedEvidence: "Tokens from this provider in unmeasured time: {events} events, {tokens} tokens.",
  candidates: "Candidate sessions in measured intervals (weights, not proof)",

  evidenceTitle: "Tokens from local logs",
  evidenceNote: "Application → Hermes profile → session ID. Token counters only: conversation titles and content are never read or shown. Logs do not prove which account a session used.",
  noEvidence: "No local token records in this period.",
  columnSession: "Session",
  columnEvents: "Events",
  columnInput: "Input",
  columnCached: "of which cached",
  columnOutput: "Output",
  columnTotal: "Total",
  columnWeight: "Weight",
  columnPoints: "≈ pp (conditional)",
  noProfile: "no profile",
  profile: "profile {name}",
  evidenceUnknown: "Unknown / not recorded locally",
  evidenceUnknownDetail: "Other devices, web and mobile clients, API keys outside these apps, deleted or undiscovered logs and other OS users are not covered and remain unknown.",
  outsidePeriod: "Poll deltas crossing the period edge: {events} events, {tokens} tokens — cannot be placed in the period.",

  conditionalTitle: "Conditional estimate: apps → profiles → sessions",
  conditionalIntro: "Computed automatically, separately for each quota window and account. It is not a measurement: IF the locally logged activity of this provider explains the measured change of an eligible interval, the change splits across sessions by token weight. The logs do not prove which account paid.",
  conditionalMeasured: "Measured: +{points} pp",
  conditionalLocal: "Conditionally local: ≈ {points} pp",
  conditionalExternal: "External contribution (other devices, web, other tools): unknown, 0 to {max} pp",
  conditionalUnestimable: "Not estimated: {points} pp",
  conditionalNone: "No eligible intervals — no conditional estimate; all measured change stays unknown.",
  conditionalNotMeasured: "The change was not measured — nothing to estimate.",
  conditionalEmpty: "No measured quota changes in this period.",
  unestimableReasons: {
    "unplaceable-poll-delta": "a poll delta crosses the edge of comparable coverage",
    "evidence-conflict": "a token record of this interval was excluded for a conflicting ID — the evidence is incomplete",
    "no-local-evidence": "no local events from this provider",
    "baseline-warmup": "first minutes after collection started (baseline)",
    "coverage-unrecorded": "no collection health is recorded for this time",
    "records-lost": "a collection may have lost accounting records of this interval (see coverage)",
    "pending-maturity": "logs may still be appended — the estimate follows later",
    "source-backlog": "the collector has not finished reading logs (read backlog)",
    "collection-incomplete": "local log collection has not completed fully (failed or unreadable sources, see coverage)"
  },
  unestimableEntry: "{label}: {points} pp",
  coverageLimited: "Log coverage is limited: per-run collector health is not recorded, so conditional estimation is unavailable.",
  coverageRecorded: "Log coverage: from the recorded health of each collection run.",
  sourceProblems: "Sources that failed in the latest run (their activity is not in the estimate): {list}",
  unknownOverlap: "Eligible intervals contain local activity from an unidentified provider: {events} events, {tokens} tokens — it may have used this quota and is not in the estimate.",
  weightLabel: "Token weights",
  weightBases: {
    uncached: "without cache reads (input − cached + output)",
    all: "all tokens (input incl. cache + output)"
  },
  assumptionsTitle: "Method and assumptions",
  assumptions: [
    "Eligible interval: comparable observations of one window and account, same-provider local events inside, logs fully read and no longer being appended, no unplaceable poll deltas.",
    "All same-provider sessions in an eligible interval are assumed to have used this account. The logs do not prove this.",
    "The provider's quota formula is unknown: tokens are only relative weights, not a conversion to percent.",
    "Cache: with \"without cache reads\" weights, cache reads are ignored and Claude cache writes count as input. Reasoning tokens are already part of output and are never added twice.",
    "Concurrent sessions in one interval share its change in proportion to their weights. Change right after events (under 1 min) belongs to them, because providers account with a delay.",
    "Primary and weekly windows are different scales: their estimates are never added.",
  ],

  statusTitle: "Source status",
  providerStatus: "Provider status (from the collector)",
  coverageNotes: "Collector coverage",
  noStatus: "The collector reported nothing.",
  issuesTitle: "Input data issues",
  issues: {
    invalidSamples: "Invalid quota observations dropped: {count}",
    duplicateSamples: "Duplicate observations collapsed: {count}",
    conflictingSamples: "Conflicting observations (same time): {count}",
    invalidEvents: "Invalid token records dropped: {count}",
    duplicateEvents: "Duplicate events dropped by ID: {count}",
    mergedEventUpdates: "Streaming updates of one event (one kept): {count}",
    conflictingEvents: "Events with a conflicting ID (excluded): {count}"
  },
  noIssues: "None detected."
};

export function usageText(locale: LocaleId): UsageText {
  return locale === "en" ? EN : RU;
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

export function formatPoints(locale: LocaleId, value: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value);
}

export function formatTokens(locale: LocaleId, value: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

export function formatDateTime(locale: LocaleId, timeZone: string, value: number): string {
  return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(value);
}

/** IANA zone plus its current UTC offset, e.g. "Europe/Moscow (GMT+3)". */
export function formatTimeZone(locale: LocaleId, timeZone: string, at: number): string {
  const offset = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value;
  return offset ? `${timeZone} (${offset})` : timeZone;
}

export function formatDuration(locale: LocaleId, ms: number): string {
  const units = locale === "en"
    ? { day: "d", hour: "h", minute: "min", second: "s" }
    : { day: "д", hour: "ч", minute: "мин", second: "с" };
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} ${units.second}`;
  const minutes = Math.floor(total / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return hours ? `${days} ${units.day} ${hours} ${units.hour}` : `${days} ${units.day}`;
  if (hours) return rest ? `${hours} ${units.hour} ${rest} ${units.minute}` : `${hours} ${units.hour}`;
  return `${rest} ${units.minute}`;
}

/** Scopes are opaque account hashes from the collector; show a stable prefix. */
export function shortScope(scope: string): string {
  return scope.length > 14 ? `${scope.slice(0, 12)}…` : scope;
}

export function providerName(locale: LocaleId, provider: string): string {
  return provider === "codex" ? "Codex"
    : provider === "claude" ? "Claude"
    : provider === "unknown" ? usageText(locale).unknownProviderName
    : provider;
}
