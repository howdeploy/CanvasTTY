import { decodeSkinMedia as decodeMedia } from "../skins/decodeSkinMedia";
import { useEffect, useMemo, useState } from "react";
import type { AppSettings, ClockFont, WallpaperId, WallpaperRecipe, WallpaperSummary } from "../../../../shared/contracts";
import { SKIN_MEDIA_MIME, type SkinMediaInfo } from "../../../../shared/skinMedia";
import { DEFAULT_WALLPAPER_RECIPE, MAX_WALLPAPER_BYTES, MAX_WALLPAPER_PACKAGE_BYTES, validateWallpaperRecipe } from "../../../../shared/wallpaper";
import { PixelDigits } from "../home/PixelDigits";
import { SkinMediaView } from "../skins/SkinMediaView";
import { useWallpaper } from "../skins/useWallpaper";
import { generatePixelWallpaper } from "./pixelWallpaperGenerator";
import { wallpaperAgentPrompt } from "./wallpaperAgentPrompt";
import "./wallpaperWorkshop.css";

type Target = "canvas" | "avatar" | "clock";
interface Draft { bytes: Uint8Array; media: SkinMediaInfo; width: number; height: number }
export default function WallpaperWorkshop({ settings, onChange }: { settings: AppSettings; onChange(patch: Partial<AppSettings>): Promise<void> }): React.JSX.Element {
  const ru = settings.locale === "ru";
  const [items, setItems] = useState<WallpaperSummary[]>([]);
  const [selected, setSelected] = useState<WallpaperId | null>(null);
  const asset = useWallpaper(selected);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [recipe, setRecipe] = useState<WallpaperRecipe>({ ...DEFAULT_WALLPAPER_RECIPE });
  const [name, setName] = useState(ru ? "Мои обои" : "My wallpaper");
  const [target, setTarget] = useState<Target>("canvas");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [seed, setSeed] = useState(42), [palette, setPalette] = useState<"night" | "forest" | "sunset">("night");
  const draftUrl = useMemo(() => draft ? URL.createObjectURL(new Blob([new Uint8Array(draft.bytes)], { type: SKIN_MEDIA_MIME[draft.media.format] })) : null, [draft]);
  useEffect(() => () => { if (draftUrl) URL.revokeObjectURL(draftUrl); }, [draftUrl]);
  useEffect(() => {
    let active = true;
    const refresh = (): void => { void window.canvasTTY.wallpapers.list().then(list => { if (active) setItems(list); }).catch(() => { if (active) setError(ru ? "Не удалось загрузить библиотеку." : "Cannot load library."); }); };
    refresh(); const stop = window.canvasTTY.wallpapers.onChanged(refresh);
    return () => { active = false; stop(); };
  }, [ru]);
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const importFile = async (file: File): Promise<void> => {
    const pack = file.name.toLowerCase().endsWith(".ctwallpaper");
    if (file.size > (pack ? MAX_WALLPAPER_PACKAGE_BYTES : MAX_WALLPAPER_BYTES)) throw new Error(ru ? "Файл слишком большой: медиа до 80 МБ, пакет до 113 МБ." : "Media: max 80 MB; package: max 113 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let next = { ...DEFAULT_WALLPAPER_RECIPE }, nextName = file.name.replace(/\.[^.]+$/, "");
    let mediaBytes = bytes;
    if (pack) {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (data?.kind !== "canvastty-wallpaper" || data.schemaVersion !== 1 || typeof data.source?.base64 !== "string" || data.source.base64.length > Math.ceil(MAX_WALLPAPER_BYTES / 3) * 4) throw new Error("Invalid wallpaper package.");
      next = validateWallpaperRecipe(data.recipe); nextName = data.name;
      if (typeof nextName !== "string" || !nextName.trim() || nextName.length > 100) throw new Error("Invalid wallpaper name.");
      const binary = atob(data.source.base64); mediaBytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    }
    const decoded = await decodeMedia(mediaBytes);
    setDraft(decoded); setSelected(null); setName(nextName.slice(0, 100)); setRecipe(next);
  };
  const original = items.find(item => item.id === selected);
  const dirty = Boolean(draft) || name !== original?.name || JSON.stringify(recipe) !== JSON.stringify(original?.recipe);
  const save = async (): Promise<WallpaperSummary> => {
    if (!dirty && original) return original;
    const data = draft ?? (selected ? await window.canvasTTY.wallpapers.read(selected).then(result => result && { bytes: result.bytes, width: result.summary.media.width!, height: result.summary.media.height! }) : null);
    if (!data) throw new Error(ru ? "Сначала загрузите файл или создайте фон." : "Import or generate a background first.");
    const saved = await window.canvasTTY.wallpapers.install({ name, bytes: data.bytes, width: data.width, height: data.height, recipe });
    setItems(await window.canvasTTY.wallpapers.list()); setDraft(null); setSelected(saved.id); setRecipe(saved.recipe); setName(saved.name);
    setNotice(ru ? "Сохранено в библиотеку CanvasTTY." : "Saved to the CanvasTTY library."); return saved;
  };
  const apply = async (destination: Target): Promise<void> => {
    const saved = await save();
    await onChange(destination === "canvas" ? { canvasBackground: saved.id, canvasBackgroundPaused: false }
      : destination === "avatar" ? { homeAvatarWallpaper: saved.id }
      : { homeClockDesign: "new", homeClockWallpaper: saved.id, homeClockFont: saved.recipe.clockFont });
  };
  const src = draftUrl ?? asset?.src, media = draft?.media ?? asset?.summary.media;
  const set = (patch: Partial<WallpaperRecipe>): void => setRecipe(current => ({ ...current, ...patch }));
  const download = async (): Promise<void> => {
    const saved = await save(); const bytes = await window.canvasTTY.wallpapers.export(saved.id);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${saved.name.replace(/[^\p{L}\p{N}_-]/gu, "_") || "wallpaper"}.ctwallpaper`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="wallpaper-workshop" aria-label={ru ? "Мастерская оформления" : "Appearance workshop"}>
    <p>{ru ? "Свои MP4/WebM, GIF, WebP и PNG — без набора из десяти рамок. Оригинал копируется в профиль; кадрирование хранится отдельно." : "Import MP4/WebM, GIF, WebP and PNG independently. Originals are copied into your profile; framing is saved separately."}</p>
    <fieldset disabled={busy}>
      <label>{ru ? "Загрузить медиа или .ctwallpaper" : "Import media or .ctwallpaper"}<input type="file" accept=".mp4,.webm,.gif,.webp,.png,.apng,.ctwallpaper" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void run(() => importFile(file)); }} /></label>
      <label>{ru ? "Библиотека" : "Library"}<select value={selected ?? ""} onChange={event => {
        const item = items.find(value => value.id === event.target.value); setDraft(null); setSelected(item?.id ?? null);
        if (item) { setName(item.name); setRecipe(item.recipe); }
      }}><option value="">{ru ? "Новые обои" : "New wallpaper"}</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.media.width}×{item.media.height} · {item.media.format}</option>)}</select></label>
      <label>{ru ? "Название" : "Name"}<input value={name} maxLength={100} onChange={e => setName(e.target.value)} /></label>
      <label>{ru ? "Предпросмотр" : "Preview"}<select value={target} onChange={e => setTarget(e.target.value as Target)}><option value="canvas">Canvas</option><option value="avatar">Home · {ru ? "аватарка" : "avatar"}</option><option value="clock">Home · {ru ? "часы" : "clock"}</option></select></label>
      <div className={`wallpaper-workshop__preview wallpaper-workshop__preview--${target}`} style={{ aspectRatio: target === "avatar" ? "1" : target === "clock" ? "3" : `${recipe.width}/${recipe.height}` }}>
        {src && media && <SkinMediaView key={src} src={src} media={media} className="wallpaper-view" errorLabel={ru ? "Не удалось воспроизвести файл." : "Cannot play this file."} style={{ "--wallpaper-fit": recipe.fit, "--wallpaper-position": `${recipe.x}% ${recipe.y}%`, imageRendering: recipe.pixelated ? "pixelated" : "auto" } as React.CSSProperties} />}
        {target === "clock" && <div className={`wallpaper-clock-preview clock-font--${recipe.clockFont}`} style={{ background: `rgb(0 0 0 / ${recipe.dim})` }}>{recipe.clockFont === "pixel" ? <PixelDigits value="12:34" /> : "12:34"}</div>}
      </div>
      <small>{media ? `${ru ? "Исходник" : "Source"}: ${media.width} × ${media.height} · ${media.format.toUpperCase()}` : (ru ? "Выберите свой файл или генератор ниже." : "Choose a file or use the generator below.")}</small>
      {media?.width && media?.height && (recipe.width > media.width || recipe.height > media.height) && <small>{ru ? "Превью увеличивает исходник; дополнительных деталей от этого не появится." : "The source is enlarged; this does not add detail."}</small>}
      <label>{ru ? "Холст / пропорции превью" : "Preview canvas / aspect"}<select value={`${recipe.width}x${recipe.height}`} onChange={e => { const [width, height] = e.target.value.split("x").map(Number); set({ width, height }); }}>
        {[[1920,1080],[2560,1440],[3840,2160],[1920,1200],[2560,1080],[1080,1920],[512,512],[1440,480], [recipe.width,recipe.height]].filter((v,i,a) => a.findIndex(w => w[0] === v[0] && w[1] === v[1]) === i).map(([w,h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{w} × {h}</option>)}
      </select></label>
      <small>{ru ? "Холст задаёт пропорции превью и размер генератора. На рабочем поле обои подстраиваются под окно; файл не перекодируется." : "Canvas sets preview aspect and generator size. Wallpaper adapts to the window without transcoding."}</small>
      <label>{ru ? "Масштаб" : "Fit"}<select value={recipe.fit} onChange={e => set({ fit: e.target.value as WallpaperRecipe["fit"] })}><option value="cover">{ru ? "Заполнить с обрезкой" : "Fill / crop"}</option><option value="contain">{ru ? "Показать целиком" : "Fit all"}</option></select></label>
      {(["x", "y"] as const).map(axis => <label key={axis}>{ru ? "Положение кадра" : "Crop focus"} {axis.toUpperCase()} · {recipe[axis]}%<input type="range" min="0" max="100" value={recipe[axis]} onChange={e => set({ [axis]: Number(e.target.value) })} /></label>)}
      <label><input type="checkbox" checked={recipe.pixelated} onChange={e => set({ pixelated: e.target.checked })} />{ru ? "Чёткие пиксели" : "Crisp pixels"}</label>
      <label>{ru ? "Шрифт часов" : "Clock font"}<select value={recipe.clockFont} onChange={e => set({ clockFont: e.target.value as ClockFont })}><option value="mono">Mono</option><option value="sans">Sans</option><option value="serif">Serif</option><option value="pixel">Pixel / retro</option></select></label>
      <label>{ru ? "Затемнение под часами" : "Clock background dimming"}<input type="range" min="0" max="0.9" step="0.05" value={recipe.dim} onChange={e => set({ dim: Number(e.target.value) })} /></label>
      <div className="wallpaper-workshop__actions">
        <button type="button" disabled={!src} onClick={() => void run(async () => { await save(); })}>{ru ? "Сохранить в библиотеку" : "Save to library"}</button>
        <button type="button" disabled={!src} onClick={() => void run(() => apply(target))}>{ru ? "Сохранить и применить" : "Save and apply"}</button>
        <button type="button" disabled={!src} onClick={() => void run(download)}>{ru ? "Экспорт .ctwallpaper" : "Export .ctwallpaper"}</button>
        <button type="button" disabled={!selected} onClick={() => void run(async () => {
          if (!selected) return; await window.canvasTTY.wallpapers.remove(selected);
          await onChange({ ...(settings.canvasBackground === selected ? { canvasBackground: "none" as const } : {}), ...(settings.homeAvatarWallpaper === selected ? { homeAvatarWallpaper: null } : {}), ...(settings.homeClockWallpaper === selected ? { homeClockWallpaper: null } : {}) });
          setSelected(null); setDraft(null);
        })}>{ru ? "Удалить из библиотеки" : "Remove from library"}</button>
      </div>
      <details><summary>{ru ? "Пиксельный генератор" : "Pixel generator"}</summary>
        <label>Seed<input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))} /></label>
        <label>{ru ? "Палитра" : "Palette"}<select value={palette} onChange={e => setPalette(e.target.value as typeof palette)}><option value="night">{ru ? "Ночь" : "Night"}</option><option value="forest">{ru ? "Лес" : "Forest"}</option><option value="sunset">{ru ? "Закат" : "Sunset"}</option></select></label>
        <button type="button" onClick={() => void run(async () => { const bytes = await generatePixelWallpaper(seed, palette, recipe.width, recipe.height); setDraft(await decodeMedia(bytes)); setSelected(null); setName(`Pixel ${palette} ${seed}`); set({ pixelated: true }); })}>{ru ? "Сгенерировать PNG" : "Generate PNG"}</button>
      </details>
      <button type="button" onClick={() => { window.canvasTTY.clipboard.writeText(wallpaperAgentPrompt(settings.locale, target, recipe)); setNotice(ru ? "Задание агенту скопировано." : "Agent brief copied."); }}>{ru ? "Скопировать задание агенту для этого оформления" : "Copy agent brief for this appearance"}</button>
    </fieldset>
    {busy && <p role="status">{ru ? "Обработка…" : "Processing…"}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
