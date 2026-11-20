import { useRef, useState } from "react";
import type { AppSettings } from "../../../../shared/contracts";
import { Segmented, SettingGroup } from "../settings/SettingsControls";

export function HomeClockAppearance({ settings, onChange }: {
  settings: AppSettings;
  onChange(patch: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const ru = settings.locale === "ru";
  const wallpaperInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const importBackground = async (file: File): Promise<void> => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const { installClockBackground } = await import("./avatarMedia");
      const saved = await installClockBackground(file);
      try { await onChange({ homeClockWallpaper: saved.id }); }
      catch {
        await window.canvasTTY.wallpapers.remove(saved.id).catch(() => undefined);
        setError(ru ? "Не удалось сохранить фон часов." : "Could not save the clock background.");
      }
    } catch { setError(ru ? "Выберите GIF, PNG или WebP до 20 МБ." : "Choose a GIF, PNG or WebP up to 20 MB."); }
    finally { setBusy(false); if (wallpaperInput.current) wallpaperInput.current.value = ""; }
  };
  return <>
    <SettingGroup label={ru ? "Шрифт часов" : "Clock font"}>
      <Segmented value={settings.homeClockFont ?? "mono"}
        options={[["mono", ru ? "Моно" : "Mono"], ["sans", "Sans"], ["serif", "Serif"], ["pixel", ru ? "Пиксельный" : "Pixel"]]}
        onChange={value => void onChange({ homeClockFont: value as AppSettings["homeClockFont"] })} />
    </SettingGroup>
    <SettingGroup label={ru ? "Фон часов" : "Clock background"}>
      <div className="settings-inline-controls">
        <input hidden ref={wallpaperInput} type="file" accept="image/gif,image/png,image/webp"
          onChange={event => { const file = event.target.files?.[0]; if (file) void importBackground(file); }} />
        <button className="setting-inline-action" type="button" disabled={busy} onClick={() => wallpaperInput.current?.click()}>
          {ru ? "Выбрать изображение" : "Choose image"}
        </button>
        <button className="setting-inline-action" type="button" disabled={busy || !settings.homeClockWallpaper}
          onClick={() => void onChange({ homeClockWallpaper: null })}>{ru ? "Сбросить" : "Reset"}</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </SettingGroup>
    <SettingGroup label={ru ? "Фон аватарки" : "Avatar background"}>
      <div className="settings-inline-controls">
        <button className="setting-inline-action" type="button" disabled={!settings.homeAvatarWallpaper}
          onClick={() => void onChange({ homeAvatarWallpaper: null })}>{ru ? "Сбросить" : "Reset"}</button>
      </div>
    </SettingGroup>
  </>;
}
