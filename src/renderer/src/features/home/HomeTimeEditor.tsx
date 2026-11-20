import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAX_HOME_CLOCKS, MAX_HOME_TIMERS, MAX_TIMER_MS, formatTimer, normalizeHomeTime, validTimeZone, type HomeTimeSettings } from "../../../../shared/homeTime";
import type { AppSettings } from "../../../../shared/contracts";
function availableZones(): string[] {
  try { return Intl.supportedValuesOf("timeZone"); }
  catch { return ["UTC", "Europe/Moscow", "Europe/London", "Asia/Dubai", "Asia/Tokyo", "America/New_York", "America/Los_Angeles"]; }
}
const ZONES = availableZones();
export default function HomeTimeEditor({ settings, onSave, onClose }: {
  settings: AppSettings; onSave(patch: Partial<AppSettings>): Promise<void>; onClose(): void;
}): React.JSX.Element {
  const ru = settings.locale === "ru";
  const [draft, setDraft] = useState<HomeTimeSettings>(() => normalizeHomeTime(settings.homeTime));
  const [editingTimerId, setEditingTimerId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState("25"), [seconds, setSeconds] = useState("0");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const save = async (): Promise<void> => {
    if (draft.clocks.some(clock => !validTimeZone(clock.timeZone))) {
      setError(ru ? "Выберите существующий часовой пояс из списка." : "Choose a valid time zone."); return;
    }
    setBusy(true); setError("");
    try { await onSave({ homeTime: { ...draft, timers: settings.homeTime?.timers ?? [] } }); onClose(); }
    catch { setError(ru ? "Не удалось сохранить настройки." : "Could not save settings."); }
    finally { setBusy(false); }
  };
  const addTimer = async (): Promise<void> => {
    const ms = (Number(minutes) * 60 + Number(seconds)) * 1000;
    if (!Number.isInteger(Number(minutes)) || Number(minutes) < 0 || !Number.isInteger(Number(seconds)) || Number(seconds) < 0 || Number(seconds) > 59 || ms < 1000 || ms > MAX_TIMER_MS) {
      setError(ru ? "Длительность: от 1 секунды до 7 дней; секунды от 0 до 59." : "Duration: 1 second to 7 days; seconds 0–59."); return;
    }
    const current = normalizeHomeTime(settings.homeTime);
    if (!editingTimerId && current.timers.length >= MAX_HOME_TIMERS) return;
    setBusy(true); setError("");
    try {
      const timer = { id: editingTimerId ?? crypto.randomUUID(), label: label.trim().slice(0,48), durationMs: ms, remainingMs: ms, endsAt: null, status: "idle" as const };
      await onSave({ homeTime: { ...current, timers: editingTimerId ? current.timers.map(t => t.id === editingTimerId ? timer : t) : [...current.timers, timer] } }); setLabel(""); setEditingTimerId(null);
    } catch { setError(ru ? "Не удалось добавить таймер." : "Could not add timer."); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="home-time-editor" role="dialog" aria-labelledby="home-time-title" onCancel={onClose}
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <header><div><small>{ru ? "Настройки · Home" : "Settings · Home"}</small><h2 id="home-time-title">{ru ? "Часы и таймеры" : "Clocks and timers"}</h2></div><button type="button" onClick={onClose} aria-label={ru ? "Закрыть" : "Close"}>×</button></header>
    <fieldset disabled={busy}>
      <p>{ru ? "До 6 часовых поясов. Первые часы — основные. Переходы на летнее время учитываются автоматически." : "Up to 6 zones. First clock is primary. Regional daylight saving rules apply."}</p>
      <div className="home-time-editor__clocks">{draft.clocks.map((clock, index) => <div className="home-time-editor__clock" key={clock.id}>
        <label>{ru ? "Название часов" : "Clock label"}<input maxLength={48} value={clock.label} placeholder={ru ? "Например, команда" : "e.g. Team"} onChange={e => setDraft({ ...draft, clocks: draft.clocks.map(c => c.id === clock.id ? { ...c, label: e.target.value } : c) })} /></label>
        <label>{ru ? "Часовой пояс" : "Time zone"}<input list="home-time-zones" value={clock.timeZone} onChange={e => setDraft({ ...draft, clocks: draft.clocks.map(c => c.id === clock.id ? { ...c, timeZone: e.target.value } : c) })} /></label>
        <button type="button" disabled={draft.clocks.length === 1} onClick={() => setDraft({ ...draft, clocks: draft.clocks.filter(c => c.id !== clock.id) })} aria-label={`${ru ? "Удалить часы" : "Remove clock"} ${index + 1}`}>×</button>
      </div>)}</div>
      <datalist id="home-time-zones"><option value="local">{ru ? "Системный часовой пояс" : "System time zone"}</option><option value="UTC" />{ZONES.map(zone => <option key={zone} value={zone} />)}</datalist>
      <button type="button" disabled={draft.clocks.length >= MAX_HOME_CLOCKS} onClick={() => setDraft({ ...draft, clocks: [...draft.clocks, { id: crypto.randomUUID(), label: "", timeZone: "UTC" }] })}>{ru ? "+ Часовой пояс" : "+ Time zone"}</button>
      <div className="home-time-editor__options">
        <label><input type="checkbox" checked={draft.hour12} onChange={e => setDraft({ ...draft, hour12: e.target.checked })} />{ru ? "12-часовой формат" : "12-hour format"}</label>
        <label><input type="checkbox" checked={draft.showSeconds} onChange={e => setDraft({ ...draft, showSeconds: e.target.checked })} />{ru ? "Показывать секунды" : "Show seconds"}</label>
      </div>
      <button type="button" className="home-time-editor__save" onClick={() => void save()}>{ru ? "Сохранить часы" : "Save clocks"}</button>
      <hr /><div className="home-time-editor__existing">{(settings.homeTime?.timers ?? []).map(timer => <button key={timer.id} type="button" onClick={() => { setEditingTimerId(timer.id); setLabel(timer.label); setMinutes(String(Math.floor(timer.durationMs / 60000))); setSeconds(String(Math.floor(timer.durationMs / 1000) % 60)); }}>{timer.label || (ru ? "Таймер" : "Timer")} · {formatTimer(timer.durationMs)}</button>)}</div>
      <h3>{editingTimerId ? (ru ? "Изменить таймер" : "Edit timer") : (ru ? "Новый таймер" : "New timer")}</h3>
      <div className="home-time-editor__new-timer">
        <label>{ru ? "Название таймера" : "Timer label"}<input maxLength={48} value={label} onChange={e => setLabel(e.target.value)} /></label>
        <label>{ru ? "Минуты" : "Minutes"}<input type="number" min="0" max="10080" value={minutes} onChange={e => setMinutes(e.target.value)} /></label>
        <label>{ru ? "Секунды" : "Seconds"}<input type="number" min="0" max="59" value={seconds} onChange={e => setSeconds(e.target.value)} /></label>
      </div>
      <button type="button" disabled={!editingTimerId && (settings.homeTime?.timers.length ?? 0) >= MAX_HOME_TIMERS} onClick={() => void addTimer()}>{editingTimerId ? (ru ? "Сохранить таймер и сбросить отсчёт" : "Save and reset timer") : (ru ? "Добавить таймер" : "Add timer")}</button>
      {editingTimerId && <button type="button" onClick={() => { setEditingTimerId(null); setLabel(""); }}>{ru ? "Новый таймер" : "New timer"}</button>}
      <small>{ru ? "До 8 таймеров. Запуск и пауза — на виджете. Отсчёт продолжается при закрытом приложении; завершение видно после открытия." : "Up to 8 timers. Start/pause on the widget. Countdown continues while the app is closed; completion is shown when reopened."}</small>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <footer><small>{ru ? "Шрифт и живой фон меняются в настройках оформления → Мастерская обоев и Home." : "Change fonts and live backgrounds in Appearance → Wallpaper and Home workshop."}</small></footer>
  </dialog>, document.querySelector(".app") ?? document.body);
}
