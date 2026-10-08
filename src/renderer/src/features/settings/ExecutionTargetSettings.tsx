import { useEffect, useRef, useState } from "react";
import { AGENT_PROVIDERS, type AppSettings, type AgentProviderId, type LocaleId, type PluginLaunchValues, type SessionEnvironmentChoice } from "../../../../shared/contracts";
import { DATA_CLASSES, normalizeExecutionPolicy, type ExecutionDataClass, type ExecutionPolicy, type ExecutionTarget } from "../../../../shared/executionPolicy";
import { LaunchOptionsSection } from "../launcher/LaunchOptionsSection";
export function ExecutionTargetSettings({ settings, locale, onChange }: {
  settings: AppSettings;
  locale: LocaleId;
  onChange(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const ru = locale === "ru";
  const p = normalizeExecutionPolicy(settings.executionPolicy);
  const [provider, setProvider] = useState<AgentProviderId>("codex");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [kind, setKind] = useState("api-key");
  const [cap, setCap] = useState<ExecutionDataClass>("D2");
  const [options, setOptions] = useState<Record<string, PluginLaunchValues>>({});
  const [environment, setEnvironment] = useState<SessionEnvironmentChoice | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const selected = options["canvastty-accounts"]?.account;
  const accountId = typeof selected === "string" && selected && selected !== "none" ? selected : "default";
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeReady, setRouteReady] = useState(false);
  const previousAccount = useRef(accountId);
  useEffect(() => {
    const changedToDefault = accountId === "default" && previousAccount.current !== "default";
    previousAccount.current = accountId;
    let active = true;
    setRouteReady(false);
    setError("");
    if (accountId === "default") {
      if (changedToDefault) { setModel(""); setEndpoint(""); setKind("api-key"); }
      setRouteLoading(false);
      return;
    }
    setRouteLoading(true);
    setModel("");
    setEndpoint("");
    void window.canvasTTY.plugins.executionAccountRoutes(provider).then(rows => {
      if (!active) {
        return;
      }
      const row = rows.find(r => r.accountId === accountId);
      if (!row || row.state !== "ready") {
        throw new Error(ru ? "Аккаунт недоступен. Проверьте его в настройках Accounts." : "Account unavailable. Check its Accounts settings.");
      }
      setModel(row.model);
      setEndpoint(row.endpoint);
      setKind(row.kind);
      setRouteReady(true);
    }).catch(e => {
      if (active) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }).finally(() => {
      if (active) {
        setRouteLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [provider, accountId, ru]);
  const save = async (next: ExecutionPolicy): Promise<void> => {
    setPending(true);
    setError("");
    try {
      await onChange({ executionPolicy: next });
    }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    finally {
      setPending(false);
    }
  };
  const names = ru ? ["D0 — публичные", "D1 — внутренние", "D2 — конфиденциальные", "D3 — секретные"] : ["D0 — public", "D1 — internal", "D2 — confidential", "D3 — secret"];
  const classes = (value: ExecutionDataClass, change: (v: ExecutionDataClass) => void) => <select value={value} disabled={pending} onChange={e => change(e.target.value as ExecutionDataClass)}>{DATA_CLASSES.map((c, i) => <option key={c} value={c}>{names[i]}</option>)}</select>;
  const add = async (): Promise<void> => {
    if (accountId !== "default" && !routeReady) {
      return;
    }
    const target: ExecutionTarget = { id: crypto.randomUUID(), label: label.trim(), provider, accountId, maxDataClass: cap, ...(environment ? { environment } : {}), ...(accountId === "default" ? (model.trim() ? { model: model.trim() } : {}) : { inferenceModel: model.trim(), endpoint: endpoint.trim().toLowerCase(), accountKind: kind }) };
    const next = normalizeExecutionPolicy({ ...p, targets: [...p.targets, target] });
    if (next.targets.length !== p.targets.length + 1) {
      setError(ru ? "Проверьте имя, модель, адрес и параметры окружения." : "Check the label, model, address and environment options.");
      return;
    }
    await save(next);
  };
  return <fieldset className="execution-target-settings" disabled={pending}><legend>{ru ? "Разрешённые места выполнения" : "Allowed execution destinations"}</legend>
<label className="launch-advanced__field"><input type="checkbox" checked={p.enabled} onChange={e => void save({ ...p, enabled: e.target.checked })}/>{ru ? "Разрешать запуск только в списке ниже" : "Allow launches only to destinations below"}</label>
<p>{ru ? "Класс данных задаёте вы. Рейтинг модели не даёт ей доступ. Изменение списка блокирует новые задания, но не отменяет уже отправленные." : "You choose data sensitivity. Model ratings do not grant access. Changes block new tasks but cannot undo requests already sent."}</p>
<label className="launch-advanced__field">{ru ? "Класс новых задач" : "New task data class"} {classes(p.defaultDataClass, v => void save({ ...p, defaultDataClass: v }))}</label>
<ul>{p.targets.map(t => <li key={t.id}>{t.label} — {t.provider} · {t.inferenceModel ?? t.model ?? (ru ? "настройки CLI" : "CLI configuration")} · {t.endpoint ?? t.accountId} · {t.environment ? `${t.environment.pluginId}/${t.environment.kind}` : (ru ? "этот компьютер" : "this computer")} · {t.maxDataClass} <button className="setting-inline-action" type="button" onClick={() => void save({ ...p, targets: p.targets.filter(x => x.id !== t.id) })}>{ru ? "Удалить" : "Remove"}</button></li>)}</ul>
<label className="launch-advanced__field">{ru ? "Название" : "Label"}<input type="text" id="execution-target-label" value={label} maxLength={100} onChange={e => setLabel(e.target.value)}/></label>
<label className="launch-advanced__field">{ru ? "Приложение агента" : "Agent CLI"}<select id="execution-target-provider" value={provider} onChange={e => {
    setProvider(e.target.value as AgentProviderId);
    setOptions({});
    setEnvironment(null);
    setModel("");
    setEndpoint("");
  }}>{AGENT_PROVIDERS.map(id => <option key={id}>{id}</option>)}</select></label>
<LaunchOptionsSection key={provider} provider={provider} locale={locale} accountsOnly onChange={setOptions} onEnvironmentChange={setEnvironment}/>
<label className="launch-advanced__field">{accountId === "default" ? (ru ? "Модель (пусто — текущая настройка CLI)" : "Model (blank uses the CLI configuration)") : (ru ? "Точная модель аккаунта" : "Exact account model")}<input type="text" id="execution-target-model" readOnly={accountId !== "default"} value={model} maxLength={200} onChange={e => setModel(e.target.value)}/></label>
{accountId !== "default" && <><label className="launch-advanced__field">{ru ? "Адрес провайдера (имя хоста и порт)" : "Provider address (hostname and port)"}<input type="text" id="execution-target-endpoint" readOnly value={endpoint} maxLength={300} placeholder="api.example.com" onChange={e => setEndpoint(e.target.value)}/></label><label className="launch-advanced__field">{ru ? "Тип подключения" : "Connection type"}<select id="execution-target-kind" disabled value={kind} onChange={e => setKind(e.target.value)}><option value="api-key">API</option><option value="ollama">Ollama local</option><option value="ollama-cloud">Ollama cloud</option></select></label></>}
<label className="launch-advanced__field">{ru ? "Максимальный класс" : "Maximum data class"} {classes(cap, setCap)}</label>
<p>{ru ? "Без аккаунта вы разрешаете текущую конфигурацию CLI: конкретный облачный провайдер не подтверждается. Для аккаунта сверяются адрес хоста, модель и тип подключения. Удалённое окружение не получает локальную защиту CanvasTTY." : "Without an account you approve the CLI configuration; its inference provider is not verified. Accounts are checked against hostname, model and connection type. A remote environment does not inherit CanvasTTY’s local protection."}</p>
<button className="setting-inline-action" type="button" disabled={pending || routeLoading || accountId !== "default" && !routeReady || p.targets.length >= 64} onClick={() => void add()}>{pending ? (ru ? "Сохранение…" : "Saving…") : (ru ? "Добавить" : "Add destination")}</button>{error && <p role="alert">{error}</p>}
</fieldset>;
}
