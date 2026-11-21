import { useEffect, useState, type ReactNode } from "react";
import type { AuthorThemeSummary, AuthorThemeWallpaperSlot, LocaleId, PixelTerminalBorderSkinId } from "../../../../shared/contracts";
import { inspectSkinMedia, SKIN_MEDIA_MIME, type SkinMediaInfo } from "../../../../shared/skinMedia";
import { t } from "../../lib/i18n";
import { SkinMediaView } from "../skins/SkinMediaView";
import { Segmented } from "./SettingsControls";

type PreviewSlot = AuthorThemeWallpaperSlot | "terminal";

export function AuthorThemePresets({ locale, paused, readOnly, renderTerminal }: {
  locale: LocaleId;
  paused: boolean;
  readOnly: boolean;
  renderTerminal(skin: PixelTerminalBorderSkinId): ReactNode;
}) {
  const [themes, setThemes] = useState<AuthorThemeSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selection, setSelection] = useState("");
  const [slot, setSlot] = useState<PreviewSlot>("canvas");
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<"success" | "failed" | null>(null);
  const theme = themes?.find(item => item.id === selection);
  const ru = locale === "ru";

  useEffect(() => {
    let active = true;
    void window.canvasTTY.authorThemes.list().then(
      items => { if (active) setThemes(items); },
      () => { if (active) setLoadFailed(true); }
    );
    return () => { active = false; };
  }, []);

  async function apply(id: string): Promise<void> {
    setApplying(true);
    setResult(null);
    try {
      await window.canvasTTY.authorThemes.apply(id);
      setResult("success");
    } catch {
      setResult("failed");
    } finally {
      setApplying(false);
    }
  }

  if (loadFailed) return <p role="alert">{t(locale, "authorThemesLoadFailed")}</p>;
  if (!themes) return <p role="status">{t(locale, "authorThemesLoading")}</p>;

  return <>
    <div className="settings-inline-controls theme-selection">
      <select aria-label={t(locale, "authorThemes")} value={selection} disabled={applying}
        onChange={event => { setSelection(event.currentTarget.value); setResult(null); }}>
        <option value="">{ru ? "Выбрать тему" : "Choose a theme"}</option>
        {themes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <button type="button" className="setting-inline-action" disabled={!theme || applying || readOnly}
        onClick={() => { if (theme) void apply(theme.id); }}>
        {t(locale, applying ? "authorThemeApplying" : "authorThemeApply")}
      </button>
    </div>
    {readOnly && <p className="setting-group__description">{ru ? "В общем холсте тему применяет хост." : "The host applies themes on the shared canvas."}</p>}
    {result && <p role={result === "failed" ? "alert" : "status"} className="setting-group__description">
      {t(locale, result === "failed" ? "authorThemeApplyFailed" : "authorThemeApplied")}
    </p>}
    {theme && <div className="theme-preview">
      <Segmented value={slot} options={[
        ["canvas", ru ? "Холст" : "Canvas"], ["avatar", ru ? "Аватар" : "Avatar"],
        ["clock", ru ? "Часы" : "Clock"], ["terminal", ru ? "Терминал" : "Terminal"]
      ]} wrap onChange={value => setSlot(value as PreviewSlot)} />
      {slot === "terminal" ? renderTerminal(theme.skin) :
        <ThemeWallpaperPreview key={`${theme.id}:${slot}`} id={theme.id} slot={slot} paused={paused} locale={locale} />}
    </div>}
  </>;
}

function ThemeWallpaperPreview({ id, slot, locale, paused }: {
  id: string;
  slot: AuthorThemeWallpaperSlot;
  locale: LocaleId;
  paused: boolean;
}) {
  const [asset, setAsset] = useState<{ url: string; media: SkinMediaInfo } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    void window.canvasTTY.authorThemes.preview(id, slot).then(bytes => {
      if (!active) return;
      const mediaBytes = new Uint8Array(bytes);
      const media = inspectSkinMedia(mediaBytes);
      url = URL.createObjectURL(new Blob([mediaBytes], { type: SKIN_MEDIA_MIME[media.format] }));
      setAsset({ url, media });
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [id, slot]);
  if (failed) return <p role="alert">{locale === "ru" ? "Предпросмотр недоступен." : "Preview unavailable."}</p>;
  if (!asset) return <p role="status">{locale === "ru" ? "Загружаем предпросмотр…" : "Loading preview…"}</p>;
  return <SkinMediaView src={asset.url} media={asset.media} className="theme-preview__wallpaper"
    paused={paused} onError={() => setFailed(true)} />;
}
