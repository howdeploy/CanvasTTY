import { useEffect, useMemo, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type { UsageBreakdown, UsagePrice } from "../../../../shared/backlog";
import { backlogApi } from "./backlogRendererApi";
import { downloadText } from "./workspaceDom";

type Period = "all" | "day" | "week";

interface UsageBreakdownPanelProps {
  sessionId: string;
  filename: string;
  locale: LocaleId;
  onError(message: string): void;
}

export function UsageBreakdownPanel({ sessionId, filename, locale, onError }: UsageBreakdownPanelProps): React.JSX.Element {
  const api = useMemo(() => backlogApi(), []);
  const [period, setPeriod] = useState<Period>("all");
  const [rowsRequest, setRowsRequest] = useState(0);
  const [rows, setRows] = useState<UsageBreakdown[]>([]);
  const [prices, setPrices] = useState<UsagePrice[]>([]);
  const [pricesReady, setPricesReady] = useState(false);
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricesError, setPricesError] = useState("");
  const [pricesRequest, setPricesRequest] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadedRowsFor, setLoadedRowsFor] = useState<{ sessionId: string; period: Period; request: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError("");
    void api.usageBreakdown(sessionId, period).then((nextRows) => {
      if (!current) return;
      setRows(nextRows);
      setLoadedRowsFor({ sessionId, period, request: rowsRequest });
    }).catch((error: unknown) => {
      if (!current) return;
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      onError(message);
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, onError, period, rowsRequest, sessionId]);

  useEffect(() => {
    let current = true;
    setPricesLoading(true);
    setPricesError("");
    void api.usagePrices().then((nextPrices) => {
      if (!current) return;
      setPrices(nextPrices);
      setPricesReady(true);
    }).catch((error: unknown) => {
      if (!current) return;
      const message = error instanceof Error ? error.message : String(error);
      setPricesError(message);
      onError(message);
    }).finally(() => { if (current) setPricesLoading(false); });
    return () => { current = false; };
  }, [api, onError, pricesRequest]);

  const groups = useMemo(() => aggregate(rows), [rows]);
  const rowsReady = loadedRowsFor !== null && loadedRowsFor.sessionId === sessionId
    && loadedRowsFor.period === period && loadedRowsFor.request === rowsRequest;
  const updatePrice = (index: number, patch: Partial<UsagePrice>): void => {
    setPrices((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
    setSaved(false);
  };
  const savePrices = async (): Promise<void> => {
    if (!pricesReady || saving) return;
    if (prices.some((row) => !row.provider.trim() || !row.model.trim()
      || !Number.isFinite(row.inputPerMillion) || row.inputPerMillion < 0
      || !Number.isFinite(row.outputPerMillion) || row.outputPerMillion < 0)) {
      const message = locale === "ru" ? "Укажите модель и неотрицательные цены." : "Enter a model and non-negative prices.";
      setLoadError(message);
      onError(message);
      return;
    }
    setSaving(true);
    setSaved(false);
    setLoadError("");
    try {
      const savedPrices = await api.setUsagePrices(prices);
      setPrices(savedPrices);
      setSaved(true);
      setRowsRequest((current) => current + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  const text = locale === "ru" ? {
    title: "Фактическое использование по моделям", all: "Всё время", day: "День", week: "Неделя",
    note: "За день и неделю учитывается изменение счётчика. Если более раннего снимка нет, включается первый сохранённый счётчик.",
    noRows: "Нет данных об использовании за этот период.", provider: "Провайдер", model: "Модель", account: "Аккаунт",
    task: "Задача", session: "Карточка", input: "Вход", output: "Выход", total: "Всего", cost: "Стоимость, USD", titlePrices: "Ручные цены за миллион токенов",
    exportCsv: "Скачать CSV",
    providerPrice: "Провайдер", modelPrice: "Модель", inputPrice: "Вход", outputPrice: "Выход", add: "Добавить модель",
    remove: "Удалить", save: "Сохранить цены", saved: "Цены сохранены.", unknown: "Неизвестно",
    inTokens: "входные токены", outTokens: "выходные токены", loadingPrices: "Загрузка цен…", retryPrices: "Повторить загрузку цен"
  } : {
    title: "Observed usage by model", all: "All time", day: "Day", week: "Week",
    note: "Day and week include counter changes. If no earlier sample exists, the first persisted counter is included.",
    noRows: "No usage was reported for this period.", provider: "Provider", model: "Model", account: "Account",
    task: "Task", session: "Card", input: "Input", output: "Output", total: "Total", cost: "Cost, USD", titlePrices: "Manual prices per million tokens",
    exportCsv: "Download CSV",
    providerPrice: "Provider", modelPrice: "Model", inputPrice: "Input", outputPrice: "Output", add: "Add model",
    remove: "Remove", save: "Save prices", saved: "Prices saved.", unknown: "Unknown",
    inTokens: "input tokens", outTokens: "output tokens", loadingPrices: "Loading prices…", retryPrices: "Retry price load"
  };

  return (
    <section className="backlog-usage-breakdown">
      <header><h3>{text.title}</h3><div role="group" aria-label={text.title}>
        {(["all", "day", "week"] as const).map((value) => <button key={value} type="button" aria-pressed={period === value}
          onClick={() => setPeriod(value)}>{text[value]}</button>)}
      </div><button className="backlog-inspector__secondary backlog-usage-breakdown__export" type="button" disabled={!rowsReady || loading || pricesLoading || saving
        || Boolean(loadError || pricesError) || groups.length === 0} onClick={() => {
          const header = "period,card,provider,model,account,task,input_tokens,output_tokens,total_tokens,cost_usd";
          const rowsCsv = groups.map((row) => csvLine([
            period, row.sessionId, row.provider, row.model, row.accountId, row.taskId,
            row.tokens.input ?? text.unknown, row.tokens.output ?? text.unknown, row.tokens.total ?? text.unknown,
            row.costUsd ?? text.unknown
          ]));
          downloadText([header, ...rowsCsv].join("\n") + "\n", filename, "text/csv;charset=utf-8");
        }}>{text.exportCsv}</button></header>
      {period !== "all" && <p className="backlog-usage-breakdown__note">{text.note}</p>}
      {loadError && <p className="backlog-inspector__error" role="alert">{loadError}</p>}
      {loading ? <p className="backlog-inspector__notice" role="status">{locale === "ru" ? "Загрузка…" : "Loading…"}</p>
        : groups.length === 0 ? <p className="backlog-inspector__empty">{text.noRows}</p> : (
          <div className="backlog-usage-breakdown__table-wrap"><table>
            <thead><tr>{[text.session,text.provider, text.model, text.account, text.task, text.input, text.output, text.total, text.cost].map((label) => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>{groups.map((row) => <tr key={row.key}>
              <td>{row.sessionId}</td><td>{row.provider}</td><td>{row.model}</td><td>{row.accountId}</td><td>{row.taskId}</td>
              <td>{fmt(row.tokens.input, locale)}</td><td>{fmt(row.tokens.output, locale)}</td><td>{fmt(row.tokens.total, locale)}</td>
              <td>{row.costUsd === null ? text.unknown : row.costUsd.toLocaleString(locale, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      <section className="backlog-usage-breakdown__prices">
        <header><h4>{text.titlePrices}</h4><button type="button" disabled={!pricesReady || saving} onClick={() => {
          setPrices((current) => [...current, { provider: "codex", model: "", inputPerMillion: 0, outputPerMillion: 0 }]);
          setSaved(false);
        }}>{text.add}</button></header>
        {!pricesReady && pricesLoading && <p className="backlog-inspector__notice" role="status">{text.loadingPrices}</p>}
        {pricesError && <p className="backlog-inspector__error" role="alert">{pricesError}</p>}
        {!pricesReady && pricesError && <button type="button" disabled={pricesLoading} onClick={() => setPricesRequest((current) => current + 1)}>{text.retryPrices}</button>}
        {prices.map((row, index) => <div className="backlog-usage-breakdown__price-row" key={index}>
          <label>{text.providerPrice}<input disabled={!pricesReady || saving} value={row.provider} maxLength={40} onChange={(event) => updatePrice(index, { provider: event.currentTarget.value })} /></label>
          <label>{text.modelPrice}<input disabled={!pricesReady || saving} value={row.model} maxLength={200} onChange={(event) => updatePrice(index, { model: event.currentTarget.value })} /></label>
          <label>{text.inputPrice}<span>{text.inTokens}/1M</span><input disabled={!pricesReady || saving} type="number" min="0" step="any" value={Number.isNaN(row.inputPerMillion) ? "" : row.inputPerMillion}
            onChange={(event) => updatePrice(index, { inputPerMillion: event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value) })} /></label>
          <label>{text.outputPrice}<span>{text.outTokens}/1M</span><input disabled={!pricesReady || saving} type="number" min="0" step="any" value={Number.isNaN(row.outputPerMillion) ? "" : row.outputPerMillion}
            onChange={(event) => updatePrice(index, { outputPerMillion: event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value) })} /></label>
          <button type="button" disabled={!pricesReady || saving} aria-label={text.remove} onClick={() => {
            setPrices((current) => current.filter((_, rowIndex) => rowIndex !== index));
            setSaved(false);
          }}>{text.remove}</button>
        </div>)}
        <footer><button type="button" disabled={!pricesReady || saving} onClick={() => void savePrices()}>{saving ? (locale === "ru" ? "Сохранение…" : "Saving…") : text.save}</button>
          {saved && <span role="status">{text.saved}</span>}</footer>
      </section>
    </section>
  );
}

function aggregate(rows: UsageBreakdown[]): Array<{
  key: string; sessionId:string; provider: string; model: string; accountId: string; taskId: string;
  tokens: { input: number | null; output: number | null; total: number | null }; costUsd: number | null;
}> {
  const grouped = new Map<string, {
    sessionId:string;provider: string; model: string; accountId: string; taskId: string;
    input: number; output: number; total: number; inputKnown: boolean; outputKnown: boolean; totalKnown: boolean;
    cost: number; costKnown: boolean;
  }>();
  for (const row of rows) {
    const key = JSON.stringify([row.sessionId,row.provider, row.model, row.accountId, row.taskId]);
    const current = grouped.get(key) ?? {
      sessionId:row.sessionId,provider: row.provider ?? "—", model: row.model ?? "—", accountId: row.accountId ?? "—", taskId: row.taskId ?? "—",
      input: 0, output: 0, total: 0, inputKnown: true, outputKnown: true, totalKnown: true, cost: 0, costKnown: true
    };
    if (row.tokens.input === null) current.inputKnown = false; else current.input += row.tokens.input;
    if (row.tokens.output === null) current.outputKnown = false; else current.output += row.tokens.output;
    if (row.tokens.total === null) current.totalKnown = false; else current.total += row.tokens.total;
    if (row.costUsd === null) current.costKnown = false; else current.cost += row.costUsd;
    grouped.set(key, current);
  }
  return [...grouped.entries()].map(([key, row]) => ({ key,
    sessionId:row.sessionId,provider: row.provider, model: row.model, accountId: row.accountId, taskId: row.taskId,
    tokens: { input: row.inputKnown ? row.input : null, output: row.outputKnown ? row.output : null, total: row.totalKnown ? row.total : null },
    costUsd: row.costKnown ? row.cost : null
  })).sort((a, b) => `${a.provider}:${a.model}:${a.accountId}:${a.taskId}`.localeCompare(`${b.provider}:${b.model}:${b.accountId}:${b.taskId}`));
}

function fmt(value: number | null, locale: LocaleId): string {
  return value === null ? "—" : value.toLocaleString(locale);
}

function csvLine(values: Array<string | number>): string {
  return values.map((value) => {
    if (typeof value === "number") return String(value);
    const safeValue = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
    return `"${safeValue.replaceAll('"', '""')}"`;
  }).join(",");
}
