import { useState } from "react";
import type { AgentBudgets, AppSettings, DataClass } from "../../../../shared/contracts";
import { DATA_CLASSES, dataClassForPath, isValidPathPolicyPattern } from "../../../../shared/contracts";
import { AGENT_BUDGET_MAXIMUMS } from "../../../../shared/executionSettings";
import { validatedConnectionsPatch } from "../../../../shared/connectionsSettings";
import { t, type TranslationKey } from "../../lib/i18n";

type Props = { settings: AppSettings; onPersist(patch: Partial<AppSettings>): Promise<void> };
export function AgentBudgetsSettings({ settings, onPersist }: Props): React.JSX.Element {
  const locale = settings.locale;
  const confirmed = { agentBudgets: settings.agentBudgets, maxAccountsPerProviderPerHost: settings.maxAccountsPerProviderPerHost };
  const [draft, setDraft] = useState<{ origin: string; values: Record<keyof AgentBudgets, string>; capacity: 1 | 2 } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const value = draft ?? { origin: JSON.stringify(confirmed), values: Object.fromEntries(Object.entries(settings.agentBudgets).map(([key, number]) => [key, String(number)])) as Record<keyof AgentBudgets, string>, capacity: settings.maxAccountsPerProviderPerHost };
  const conflict = draft !== null && draft.origin !== JSON.stringify(confirmed);
  const labels: Record<keyof AgentBudgets, TranslationKey> = { maxLocalAgents: "limitsLocal", maxRemoteAgentsPerHost: "limitsRemote", maxChildren: "limitsChildren", maxDepth: "limitsDepth" };
  const save = async (): Promise<void> => {
    setBusy(true); setError(""); setNotice("");
    try {
      const patch = { agentBudgets: Object.fromEntries(Object.entries(value.values).map(([key, text]) => [key, Number(text)])) as unknown as AgentBudgets, maxAccountsPerProviderPerHost: value.capacity };
      validatedConnectionsPatch(settings, patch); await onPersist(patch); setDraft(null); setNotice(t(locale, "executionSaved"));
    } catch (reason) { setError(`${t(locale, "connectionFailed")} ${reason instanceof Error ? reason.message : ""}`); } finally { setBusy(false); }
  };
  return <section className="execution-policy"><h3>{t(locale, "agentLimits")}</h3><p className="agent-settings-hint">{t(locale, "limitsNote")}</p>
    <fieldset disabled={busy} className="execution-fields"><div className="agent-settings-grid">{(Object.keys(labels) as (keyof AgentBudgets)[]).map(key => <label key={key} className="agent-settings-field"><span>{t(locale, labels[key])}</span><input type="number" min={1} max={AGENT_BUDGET_MAXIMUMS[key]} step={1} value={value.values[key]} aria-invalid={!Number.isInteger(Number(value.values[key])) || Number(value.values[key]) < 1 || Number(value.values[key]) > AGENT_BUDGET_MAXIMUMS[key]} aria-describedby="limits-error" onChange={event => { setDraft({ ...value, values: { ...value.values, [key]: event.target.value } }); setNotice(""); }} /></label>)}
    <label className="agent-settings-field"><span>{t(locale, "limitsAccounts")}</span><select value={value.capacity} onChange={event => { setDraft({ ...value, capacity: Number(event.target.value) as 1 | 2 }); setNotice(""); }}><option value={1}>1</option><option value={2}>2</option></select></label></div></fieldset>
    {conflict && <p role="alert" className="agent-settings-error">{t(locale, "connectionConflict")}</p>}
    <div className="agent-settings-actions"><button type="button" className="agent-settings-button" disabled={busy || !draft} onClick={() => { setDraft(null); setError(""); }}>{t(locale, "connectionDiscard")}</button><button type="button" className="agent-settings-button agent-settings-button--primary" disabled={busy || !draft || conflict} onClick={() => void save()}>{t(locale, "save")}</button></div>
    <p id="limits-error" role={error ? "alert" : undefined} className="agent-settings-error">{error}</p><p role="status">{busy ? t(locale, "connectionSaving") : notice}</p>
  </section>;
}

export function DataAccessSettings({ settings, onPersist }: Props): React.JSX.Element {
  const locale = settings.locale;
  const confirmed = { defaultDataClass: settings.defaultDataClass, pathPolicies: settings.pathPolicies };
  const [draft, setDraft] = useState<{ origin: string; value: typeof confirmed } | null>(null);
  const [path, setPath] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const value = draft?.value ?? confirmed;
  const conflict = draft !== null && draft.origin !== JSON.stringify(confirmed);
  const update = (next: typeof confirmed): void => { setDraft({ origin: draft?.origin ?? JSON.stringify(confirmed), value: next }); setNotice(""); setError(""); };
  const move = (index: number, direction: number): void => { const rows = [...value.pathPolicies]; [rows[index], rows[index + direction]] = [rows[index + direction]!, rows[index]!]; update({ ...value, pathPolicies: rows }); };
  const save = async (): Promise<void> => { setBusy(true); setError(""); setNotice(""); try { validatedConnectionsPatch(settings, value); await onPersist(value); setDraft(null); setNotice(t(locale, "executionSaved")); } catch (cause) { setError(`${t(locale, "connectionFailed")} ${cause instanceof Error ? cause.message : ""}`); } finally { setBusy(false); } };
  return <section className="execution-policy"><h3>{t(locale, "dataAccess")}</h3><fieldset className="execution-fields" disabled={busy}>
    <label className="agent-settings-field"><span>{t(locale, "dataDefault")}</span><select value={value.defaultDataClass} onChange={event => update({ ...value, defaultDataClass: event.target.value as DataClass })}>{DATA_CLASSES.map(c => <option key={c} value={c}>{t(locale, `dataClass${c}`)}</option>)}</select></label>
    <h4>{t(locale, "dataPolicies")}</h4><p className="agent-settings-hint">{t(locale, "dataPolicyNote")}</p>
    <div className="execution-policy-rows">{value.pathPolicies.map((row, index) => <div className="execution-policy-row" key={index}>
      <label className="agent-settings-field"><span>{index + 1}. {t(locale, "dataPattern")}</span><input value={row.pattern} maxLength={200} aria-invalid={!isValidPathPolicyPattern(row.pattern)} aria-describedby="data-policy-error" onChange={event => update({ ...value, pathPolicies: value.pathPolicies.map((p, i) => i === index ? { ...p, pattern: event.target.value } : p) })} /></label>
      <label className="agent-settings-field"><span>{t(locale, "launchClass")}</span><select value={row.dataClass} onChange={event => update({ ...value, pathPolicies: value.pathPolicies.map((p, i) => i === index ? { ...p, dataClass: event.target.value as DataClass } : p) })}>{DATA_CLASSES.map(c => <option key={c} value={c}>{t(locale, `dataClass${c}`)}</option>)}</select></label>
      <div className="agent-settings-actions"><button className="agent-settings-button" type="button" disabled={index === 0} onClick={() => move(index, -1)}>{t(locale, "dataMoveUp")}</button><button className="agent-settings-button" type="button" disabled={index === value.pathPolicies.length - 1} onClick={() => move(index, 1)}>{t(locale, "dataMoveDown")}</button><button className="agent-settings-button" type="button" onClick={() => update({ ...value, pathPolicies: value.pathPolicies.filter((_, i) => i !== index) })}>{t(locale, "connectionRemove")}</button></div>
    </div>)}</div>
    <button type="button" className="agent-settings-button" disabled={value.pathPolicies.length >= 64} onClick={() => update({ ...value, pathPolicies: [...value.pathPolicies, { pattern: "", dataClass: "D2" }] })}>{t(locale, "dataRuleAdd")}</button>
    </fieldset>
    <label className="agent-settings-field"><span>{t(locale, "dataPreview")}</span><input value={path} onChange={event => setPath(event.target.value)} /><small>{t(locale, "dataPreviewNote")}</small></label>
    {path && value.pathPolicies.every(row => isValidPathPolicyPattern(row.pattern)) && <p role="status">{t(locale, "dataPreviewResult")}: {t(locale, `dataClass${dataClassForPath(value.pathPolicies, path, value.defaultDataClass)}`)}</p>}
    {conflict && <p role="alert" className="agent-settings-error">{t(locale, "connectionConflict")}</p>}
    <div className="agent-settings-actions"><button type="button" className="agent-settings-button" disabled={busy || !draft} onClick={() => { setDraft(null); setError(""); }}>{t(locale, "connectionDiscard")}</button><button type="button" className="agent-settings-button agent-settings-button--primary" disabled={busy || !draft || conflict} onClick={() => void save()}>{t(locale, "save")}</button></div>
    <p id="data-policy-error" className="agent-settings-error" role={error ? "alert" : undefined}>{error}</p><p role="status">{busy ? t(locale, "connectionSaving") : notice}</p>
  </section>;
}
