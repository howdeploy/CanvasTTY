import { Segmented, SettingGroup } from "./SettingsControls";
import { useEffect, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type { WorkspacePresetSummary, WorkspacePresetRestoreResult } from "../../../../shared/workspacePresets";

export default function WorkspacePresets({ locale }: { locale: LocaleId }): React.JSX.Element {
  const ru = locale === "ru";
  const [presets, setPresets] = useState<WorkspacePresetSummary[]>([]);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"continue" | "reopen">("continue");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WorkspacePresetRestoreResult | null>(null);
  const refresh = async (): Promise<void> => setPresets(await window.canvasTTY.workspacePresets.list());
  useEffect(() => { let active = true; void window.canvasTTY.workspacePresets.list().then(p => { if (active) setPresets(p); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true); setError("");
    try { await operation(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <section className="workspace-presets" aria-label={ru ? "Пресеты сессий" : "Session presets"}>
    <h3>{ru ? "Пресеты сессий" : "Session presets"}</h3>
    <p>{ru ? "Сохраняйте набор терминалов, папки, раскладку и привязанные разговоры. Загрузка добавляет недостающие карточки; открытые процессы сохраняются." : "Save terminal sets, folders, card layout and linked conversations. Loading adds missing cards and keeps running processes."}</p>
    <form onSubmit={event => { event.preventDefault(); void run(async () => { await window.canvasTTY.workspacePresets.save(name); setName(""); }); }}>
      <input className="workspace-presets__name" aria-label={ru ? "Название пресета" : "Preset name"} placeholder={ru ? "Например, разработка Canvas" : "For example, Canvas development"} maxLength={80} value={name} onChange={e => setName(e.target.value)} disabled={busy} />
      <button className="setting-inline-action" disabled={busy || !name.trim()} type="submit">{ru ? "Сохранить текущие сессии" : "Save current sessions"}</button>
    </form>
    <SettingGroup label={ru ? "При загрузке" : "When loading"} layout="stacked"
      description={ru ? "Продолжение открывает сохранённый разговор через штатный resume агента." : "Continuation opens the saved conversation using the agent’s native resume."}>
      <Segmented value={mode} disabled={busy}
        options={[["continue", ru ? "Продолжить разговоры" : "Continue conversations"], ["reopen", ru ? "Новые сессии в сохранённых папках" : "Fresh sessions in saved folders"]]}
        onChange={value => setMode(value === "reopen" ? "reopen" : "continue")} />
    </SettingGroup>
    {presets.length === 0 && <p>{ru ? "Сохранённых пресетов пока нет." : "No saved presets yet."}</p>}
    {presets.map(p => <article key={p.id}>
      <div><strong>{p.name}</strong><small>{p.sessions} {ru ? "терм." : "term."} · {p.surfaces} {ru ? "карточек" : "cards"} · {p.browserTabs} {ru ? "вкладок" : "tabs"} · {p.titles.join(", ")}</small></div>
      <button className="setting-inline-action" disabled={busy} onClick={() => void run(async () => setResult(await window.canvasTTY.workspacePresets.restore(p.id, mode)))}>{ru ? "Открыть" : "Open"}</button>
      <button className="setting-inline-action" disabled={busy} onClick={() => void run(() => window.canvasTTY.workspacePresets.save(p.name, p.id))}>{ru ? "Обновить" : "Update"}</button>
      <button className="setting-inline-action" disabled={busy} onClick={() => void run(() => window.canvasTTY.workspacePresets.remove(p.id))}>{ru ? "Удалить" : "Delete"}</button>
    </article>)}
    {result && <div role="status"><strong>{result.name}</strong>{result.surfaces && <p>{ru ? "Добавлено карточек" : "Cards added"}: {result.surfaces.added} · {ru ? "Открыто вкладок" : "Tabs opened"}: {result.surfaces.browserTabsOpened}{result.surfaces.failures.map(message => <span key={message}><br />{message}</span>)}</p>}{result.cards.map(card => <p key={card.id}>{card.title}: {card.state === "existing" ? (ru ? "уже открыта" : "already open") : card.state === "opened" ? (ru ? "открыта" : "opened") : (ru ? "остановлена" : "stopped")}{card.detail ? ` — ${card.detail}` : ""}</p>)}</div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
