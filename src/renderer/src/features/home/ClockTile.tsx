import type { ReactNode } from "react";
import type { AppSettings } from "../../../../shared/contracts";
import { WallpaperView } from "../skins/WallpaperView";

export function ClockTile({ settings, dashboard, children }: {
  settings: Pick<AppSettings, "homeClockFont" | "homeClockWallpaper">;
  dashboard?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const classes = ["tile", "clock-tile", `clock-font--${settings.homeClockFont ?? "mono"}`];
  if (settings.homeClockWallpaper) classes.push("clock-tile--wallpaper");
  if (dashboard) classes.push("clock-tile--dashboard");
  return <section className={classes.join(" ")}>
    <WallpaperView id={settings.homeClockWallpaper} className="clock-tile__background" clock />
    {children}
  </section>;
}
