import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, LocaleId } from "../../../../shared/contracts";
import { MAX_HOME_TIMERS, formatHomeClock, formatTimer, normalizeHomeTime, timerAction, timerRemaining, type HomeTimer } from "../../../../shared/homeTime";
import { WallpaperView } from "../skins/WallpaperView";
import { PixelDigits } from "./PixelDigits";
import "./homeTime.css";
const HomeTimeEditor = lazy(() => import("./HomeTimeEditor"));
export default function ClockWidget({ locale, now, settings, onChange }: {
  locale: LocaleId; now: Date; settings: AppSettings; onChange?(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const config = useMemo(() => normalizeHomeTime(settings.homeTime), [settings.homeTime]);
  const ru = locale === "ru", formatLocale = ru ? "ru-RU" : "en-GB";
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const wallpaperInput = useRef<HTMLInputElement>(null);
  const [tick, setTick] = useState(() => now.getTime());
  const ticking = config.showSeconds || config.timers.some(timer => timer.status === "running" && timerRemaining(timer, Date.now()) > 0);
  useEffect(() => {
    if (!ticking) return;
    let handle: number;
    const update = (): void => { setTick(Date.now()); handle = window.setTimeout(update, 1000 - Date.now() % 1000); };
    const wake = (): void => { window.clearTimeout(handle); update(); };
    update(); document.addEventListener("visibilitychange", wake);
    return () => { window.clearTimeout(handle); document.removeEventListener("visibilitychange", wake); };
  }, [ticking]);
  const current = ticking ? new Date(tick) : now;
  const first = formatHomeClock(config.clocks[0], current, formatLocale, config);
  const zoneLabel = (zone: string): string => zone === "local" ? (ru ? "Местное время" : "Local time") : zone.replaceAll("_", " ");
  const changeTimer = async (timer: HomeTimer, action: "start" | "pause" | "reset" | "remove"): Promise<void> => {
    if (!onChange || busy) return;
    setBusy(true); setError("");
    try { await onChange({ homeTime: { ...config, timers: action === "remove" ? config.timers.filter(t => t.id !== timer.id)
      : config.timers.map(t => t.id === timer.id ? timerAction(t, action, Date.now()) : t) } }); }
    catch { setError(ru ? "Не удалось сохранить таймер." : "Could not save timer."); }
    finally { setBusy(false); }
  };
  const importBackground = async (file: File): Promise<void> => {
    if (!onChange || busy) return;
    setBusy(true); setError("");
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Image too large");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
      });
      const { installAvatarSelection } = await import("./avatarMedia");
      const saved = await installAvatarSelection({ path: file.name, dataUrl }, "clock");
      try { await onChange({ homeClockWallpaper: saved.id }); }
      catch (error) { await window.canvasTTY.wallpapers.remove(saved.id); throw error; }
    } catch { setError(ru ? "Выберите GIF, PNG или WebP до 20 МБ." : "Choose a GIF, PNG or WebP up to 20 MB."); }
    finally { setBusy(false); if (wallpaperInput.current) wallpaperInput.current.value = ""; }
  };
  const quickTimer = async (minutes: number): Promise<void> => {
    if (!onChange || busy || config.timers.length >= MAX_HOME_TIMERS) return;
    const durationMs = minutes * 60000;
    const timer: HomeTimer = { id: crypto.randomUUID(), label: ru ? (minutes === 25 ? "Фокус" : "Перерыв") : (minutes === 25 ? "Focus" : "Break"),
      durationMs, remainingMs: durationMs, endsAt: null, status: "idle" };
    setBusy(true); setError("");
    try { await onChange({ homeTime: { ...config, timers: [...config.timers, timerAction(timer, "start", Date.now())] } }); }
    catch { setError(ru ? "Не удалось сохранить таймер." : "Could not save timer."); }
    finally { setBusy(false); }
  };
  const detailed = config.clocks.length > 1 || config.timers.length > 0 || Boolean(onChange);
  return <section className={`tile clock-tile clock-font--${settings.homeClockFont ?? "mono"} ${settings.homeClockWallpaper ? "clock-tile--wallpaper" : ""} ${detailed ? "clock-tile--dashboard" : ""}`}>
    <WallpaperView id={settings.homeClockWallpaper} className="clock-tile__background" clock />
    {onChange && <><input hidden ref={wallpaperInput} type="file" accept="image/gif,image/png,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) void importBackground(file); }} />
      <button type="button" className="clock-tile__background-pick" disabled={busy} onClick={() => wallpaperInput.current?.click()} title={ru ? "Фон часов: GIF, PNG, WebP" : "Clock background: GIF, PNG, WebP"}>{ru ? "↻ Фон / GIF" : "↻ Background / GIF"}</button></>}
    {onChange && <button type="button" className="clock-tile__edit" aria-label={ru ? "Настроить часы и таймеры" : "Configure clocks and timers"} onClick={() => setEditing(true)}>⚙</button>}
    <div className="clock-tile__primary">
      {(detailed || config.clocks[0].label || config.clocks[0].timeZone !== "local") && <small>{config.clocks[0].label || zoneLabel(config.clocks[0].timeZone)}</small>}
      <time className={`clock-tile__time ${config.showSeconds ? "clock-tile__time--seconds" : ""}`} dateTime={current.toISOString()}>{settings.homeClockFont === "pixel" ? <PixelDigits value={first.time} /> : first.time}{first.period && <small>{first.period}</small>}</time>
      <span className="clock-tile__date">{first.date}</span>
    </div>
    {detailed && <div className="clock-tile__details" data-wheel-owner="local" data-canvas-wheel-priority="local">
      {config.clocks.length > 1 && <div className="home-world-clocks" aria-label={ru ? "Часовые пояса" : "Time zones"}>{config.clocks.slice(1).map(clock => {
        const value = formatHomeClock(clock, current, formatLocale, config);
        return <article key={clock.id} title={value.date}><small>{clock.label || zoneLabel(clock.timeZone)}</small><time dateTime={current.toISOString()}>{value.time} {value.period}</time><span>{value.date}</span></article>;
      })}</div>}
      <div className="home-timers__heading"><strong>{ru ? "Таймеры" : "Timers"}</strong>
        {onChange && <div className="home-timers__presets" aria-label={ru ? "Быстрый запуск" : "Quick start"}>
          {[5, 25].map(minutes => <button key={minutes} type="button" disabled={busy || config.timers.length >= MAX_HOME_TIMERS}
            onClick={() => void quickTimer(minutes)}>+ {minutes} {ru ? "мин" : "min"}</button>)}
          <button type="button" onClick={() => setEditing(true)} aria-label={ru ? "Добавить таймер" : "Add timer"}>+ {ru ? "Свой" : "Custom"}</button>
        </div>}
      </div>
      {config.timers.length === 0 && <p className="home-timers__empty">{ru ? "Выберите длительность — отсчёт начнётся сразу." : "Choose a duration to start a countdown."}</p>}
      {config.timers.length > 0 && <div className="home-timers" aria-label={ru ? "Таймеры" : "Timers"}>{config.timers.map((timer, index) => {
        const remaining = timerRemaining(timer, Date.now());
        const done = timer.status === "running" && remaining === 0;
        const running = timer.status === "running" && !done;
        const title = timer.label || `${ru ? "Таймер" : "Timer"} ${index + 1}`;
        return <article key={timer.id} data-timer-id={timer.id} data-timer-status={done ? "done" : timer.status}>
          <progress className="home-timers__progress" max={timer.durationMs} value={timer.durationMs - remaining} aria-label={`${title}: ${ru ? "прогресс" : "progress"}`} />
          <div><strong>{title}</strong><output aria-label={title}>{formatTimer(remaining)}</output><small role={done ? "status" : undefined}>{done ? (ru ? "Готово" : "Done") : timer.status === "paused" ? (ru ? "Пауза" : "Paused") : running ? (ru ? "Идёт отсчёт" : "Running") : (ru ? "Готов к запуску" : "Ready")}</small></div>
          {onChange && <div className="home-timers__actions">
            <button type="button" disabled={busy} className="home-timers__start" onClick={() => void changeTimer(timer, running ? "pause" : "start")} aria-label={`${running ? (ru ? "Пауза" : "Pause") : (ru ? "Запустить" : "Start")} ${title}`}>{running ? (ru ? "Ⅱ Пауза" : "Ⅱ Pause") : done ? (ru ? "↻ Ещё раз" : "↻ Again") : (ru ? "▶ Старт" : "▶ Start")}</button>
            <button type="button" disabled={busy} onClick={() => void changeTimer(timer, "reset")} aria-label={`${ru ? "Сбросить" : "Reset"} ${title}`}>↺</button>
            <button type="button" disabled={busy} onClick={() => void changeTimer(timer, "remove")} aria-label={`${ru ? "Удалить" : "Remove"} ${title}`}>×</button>
          </div>}
        </article>;
      })}</div>}
    </div>}
    {error && <span role="alert" className="clock-tile__error">{error}</span>}
    {editing && onChange && <Suspense fallback={null}><HomeTimeEditor settings={settings} onSave={onChange} onClose={() => setEditing(false)} /></Suspense>}
  </section>;
}
