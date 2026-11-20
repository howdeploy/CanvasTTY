/** Deadlines survive sleep, throttling and restart without accumulating tick drift. */
export interface HomeClock { id: string; label: string; timeZone: string }
export interface HomeTimer {
  id: string; label: string; durationMs: number; remainingMs: number;
  endsAt: number | null; status: "idle" | "running" | "paused";
}
export interface HomeTimeSettings { clocks: HomeClock[]; timers: HomeTimer[]; hour12: boolean; showSeconds: boolean }
export const MAX_HOME_CLOCKS = 6;
export const MAX_HOME_TIMERS = 8;
export const MAX_TIMER_MS = 7 * 24 * 60 * 60 * 1000;
export function defaultHomeTime(): HomeTimeSettings {
  return { clocks: [{ id: "local", label: "", timeZone: "local" }], timers: [], hour12: false, showSeconds: false };
}
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  if (value === "local") return true;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const label = (value: unknown): string => typeof value === "string" ? value.trim().slice(0, 48) : "";
const duration = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= MAX_TIMER_MS;
export function normalizeHomeTime(value: unknown): HomeTimeSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const clocks: HomeClock[] = [], timers: HomeTimer[] = [];
  if (Array.isArray(source.clocks)) for (const clock of source.clocks.slice(0, MAX_HOME_CLOCKS)) {
    if (!clock || !id(clock.id) || !validTimeZone(clock.timeZone) || clocks.some(item => item.id === clock.id)) continue;
    clocks.push({ id: clock.id, label: label(clock.label), timeZone: clock.timeZone });
  }
  if (Array.isArray(source.timers)) for (const timer of source.timers.slice(0, MAX_HOME_TIMERS)) {
    if (!timer || !id(timer.id) || !duration(timer.durationMs) || timers.some(item => item.id === timer.id)) continue;
    const remainingMs = typeof timer.remainingMs === "number" && Number.isFinite(timer.remainingMs)
      ? Math.max(0, Math.min(timer.durationMs, Math.round(timer.remainingMs))) : timer.durationMs;
    const running = timer.status === "running" && Number.isSafeInteger(timer.endsAt) && timer.endsAt > 0 && timer.endsAt <= 8.64e15;
    const status = running ? "running" : timer.status === "paused" ? "paused" : "idle";
    timers.push({ id: timer.id, label: label(timer.label), durationMs: timer.durationMs,
      remainingMs: status === "idle" ? timer.durationMs : remainingMs, endsAt: running ? timer.endsAt : null, status });
  }
  return { clocks: clocks.length ? clocks : defaultHomeTime().clocks, timers,
    hour12: source.hour12 === true, showSeconds: source.showSeconds === true };
}
export function timerRemaining(timer: HomeTimer, now: number): number {
  return timer.status === "running" ? Math.max(0, timer.endsAt! - now) : timer.remainingMs;
}
export function timerAction(timer: HomeTimer, action: "start" | "pause" | "reset", now: number): HomeTimer {
  if (action === "reset") return { ...timer, status: "idle", remainingMs: timer.durationMs, endsAt: null };
  if (action === "pause") return timer.status === "running"
    ? { ...timer, status: "paused", remainingMs: timerRemaining(timer, now), endsAt: null } : timer;
  if (timer.status === "running" && timerRemaining(timer, now) > 0) return timer;
  const remainingMs = timer.remainingMs > 0 && timer.status === "paused" ? timer.remainingMs : timer.durationMs;
  return { ...timer, status: "running", remainingMs, endsAt: now + remainingMs };
}
export function formatTimer(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
export function formatHomeClock(clock: HomeClock, now: Date, locale: string, options: Pick<HomeTimeSettings, "hour12" | "showSeconds">): { time: string; date: string; period: string } {
  const zone = clock.timeZone === "local" ? {} : { timeZone: clock.timeZone };
  const parts = new Intl.DateTimeFormat(locale, { ...zone, hour: "2-digit", minute: "2-digit", ...(options.showSeconds ? { second: "2-digit" } : {}), hour12: options.hour12 }).formatToParts(now);
  const time = parts.filter(part => ["hour", "minute", "second", "literal"].includes(part.type)).map(part => part.value).join("").trim();
  return { time, period: parts.find(part => part.type === "dayPeriod")?.value ?? "",
    date: new Intl.DateTimeFormat(locale, { ...zone, weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(now) };
}
