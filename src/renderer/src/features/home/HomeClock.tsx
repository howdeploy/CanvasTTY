import { lazy, Suspense } from "react";
import type { AppSettings, LocaleId } from "../../../../shared/contracts";
import { ClockTile } from "./ClockTile";
import { PixelDigits } from "./PixelDigits";

const Dashboard = lazy(() => import("./ClockWidget"));

export function HomeClock({ locale, now, settings, onChange }: {
  locale: LocaleId;
  now: Date;
  settings: AppSettings;
  onChange?(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  if (settings.homeClockDesign === "new") {
    return <Suspense fallback={null}><Dashboard locale={locale} now={now} settings={settings} onChange={onChange} /></Suspense>;
  }
  const formatLocale = locale === "ru" ? "ru-RU" : "en-GB";
  const time = now.toLocaleTimeString(formatLocale, { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString(formatLocale, { weekday: "short", day: "numeric", month: "long", year: "numeric" });

  return (
    <ClockTile settings={settings}>
      <time className="clock-tile__time" dateTime={now.toISOString()}>{settings.homeClockFont === "pixel" ? <PixelDigits value={time} /> : time}</time>
      <span className="clock-tile__date">{date}</span>
    </ClockTile>
  );
}
