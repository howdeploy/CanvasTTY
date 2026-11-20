import { inspectSkinMedia, SKIN_MEDIA_MIME, type SkinMediaInfo } from "../../../../shared/skinMedia";
import { SkinMediaView } from "../skins/SkinMediaView";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_PIXEL_SKIN_APERTURES } from "../../../../shared/contracts";
import type {
  LocaleId,
  PixelSkinAperture,
  PixelSkinApertures,
  PixelSkinPackSummary,
  PixelSkinSlot
} from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { pixelPackSlotForFilename } from "./pixelPackFiles";
import { PIXEL_THEME_AGENT_GUIDE_URL, pixelThemeAgentPrompt } from "./pixelThemeAgentPrompt";
import { PILOT_SKIN_ASSETS } from "../skins/SkinAssets";
import { pixelSkinAssetFilename } from "../skins/skinCatalog";

const LEVELS = ["minimal", "detailed", "master"] as const;
const STATES = ["idle", "working", "completed"] as const;
const SLOTS: readonly PixelSkinSlot[] = LEVELS.flatMap((level) => STATES.map((state) => `${level}_${state}` as PixelSkinSlot)).concat("background");

const IMAGE_ACCEPT = "image/png,image/apng,image/gif,image/webp,.png,.apng,.gif,.webp";
const MEDIA_ACCEPT = `${IMAGE_ACCEPT},video/mp4,video/webm,.mp4,.webm`;
function fileMedia(file: File): SkinMediaInfo {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const format = extension === "apng" ? "png" : extension;
  return { format: format as SkinMediaInfo["format"], animated: true };
}
function supportedFile(file: File, slot?: PixelSkinSlot): boolean {
  return /\.(png|apng|gif|webp)$/i.test(file.name) || (slot === "background" && /\.(mp4|webm)$/i.test(file.name));
}

async function readMediaFile(file: File): Promise<Uint8Array> {
  if (file.size > 80 * 1024 * 1024) throw new Error("Media file exceeds 80 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = inspectSkinMedia(bytes);
  if ((info.format !== "mp4" && info.format !== "webm") && bytes.byteLength > 20 * 1024 * 1024) throw new Error("Image exceeds 20 MB.");
  const url = URL.createObjectURL(new Blob([bytes], { type: SKIN_MEDIA_MIME[info.format] }));
  const video = info.format === "mp4" || info.format === "webm";
  try {
    await new Promise<void>((resolve, reject) => {
      const element = video ? document.createElement("video") : new Image();
      const cleanup = (): void => { clearTimeout(timer); element.onload = element.onerror = null; if (element instanceof HTMLVideoElement) { element.onloadedmetadata = null; element.removeAttribute("src"); element.load(); } };
      const failed = (): void => { cleanup(); reject(new Error(`Cannot decode ${file.name}. Use PNG/APNG/GIF, WebP, H.264 MP4, or VP8/VP9 WebM.`)); };
      const loaded = (): void => {
        const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
        const height = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
        if (width < 320 || height < 200 || width > 4096 || height > 4096) { cleanup(); reject(new Error("Media dimensions must be between 320x200 and 4096x4096.")); return; }
        cleanup(); resolve();
      };
      const timer = setTimeout(failed, 15_000);
      element.onerror = failed;
      if (element instanceof HTMLVideoElement) { element.muted = true; element.preload = "metadata"; element.onloadedmetadata = loaded; }
      else element.onload = loaded;
      element.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
  return bytes;
}

export function PixelSkinPackCreator({ locale, onCreated }: {
  locale: LocaleId;
  onCreated(pack: PixelSkinPackSummary): void;
}): React.JSX.Element {
  const ru = locale === "ru";
  const levelLabels = ru
    ? { minimal: "Простая рамка", detailed: "Детальная рамка", master: "Оркестратор" }
    : { minimal: "Simple border", detailed: "Detailed border", master: "Orchestrator" };
  const stateLabels = ru
    ? { idle: "Ожидание", working: "Работа", completed: "Готово" }
    : { idle: "Idle", working: "Working", completed: "Completed" };
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [files, setFiles] = useState<Partial<Record<PixelSkinSlot, File>>>({});
  const [previews, setPreviews] = useState<Partial<Record<PixelSkinSlot, string>>>({});
  const [apertures, setApertures] = useState<PixelSkinApertures>(DEFAULT_PIXEL_SKIN_APERTURES);
  const [apertureLevel, setApertureLevel] = useState<typeof LEVELS[number]>("minimal");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const bulkInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const urls = Object.fromEntries(Object.entries(files).map(([slot, file]) => [slot, URL.createObjectURL(file)]));
    setPreviews(urls);
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !installing) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, installing]);

  const assign = (slot: PixelSkinSlot, file: File | undefined): void => {
    if (!file) return;
    if (installing) return;
    if (!supportedFile(file, slot) || file.size > (slot === "background" ? 80 : 20) * 1024 * 1024) {
      setError(ru ? "Рамки: PNG/APNG/GIF/WebP до 20 МБ. Фон: также MP4/WebM до 80 МБ." : "Frames: PNG/APNG/GIF/WebP up to 20 MB. Background: also MP4/WebM up to 80 MB.");
      return;
    }
    setFiles((current) => ({ ...current, [slot]: file }));
    setZipFile(null);
    setError(null);
  };

  const assignMany = (selected: FileList | File[]): void => {
    const assigned: Partial<Record<PixelSkinSlot, File>> = {};
    for (const file of Array.from(selected)) {
      const slot = pixelPackSlotForFilename(file.name);
      if (slot && supportedFile(file, slot)) assigned[slot] = file;
    }
    if (Object.keys(assigned).length === 0) {
      setError(ru ? "Не удалось определить роли по именам файлов." : "No media roles were found in filenames.");
      return;
    }
    setFiles((current) => ({ ...current, ...assigned }));
    setZipFile(null);
    setError(null);
  };

  const assignZip = (file: File | undefined): void => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip") || file.size > 150 * 1024 * 1024) {
      setError(ru ? "Нужен ZIP размером до 150 МБ." : "Choose a ZIP smaller than 150 MB.");
      return;
    }
    setZipFile(file);
    setFiles({});
    if (!name.trim()) setName(file.name.replace(/\.zip$/i, "").slice(0, 64));
    setError(null);
  };

  const copyAgentPrompt = (): void => {
    window.canvasTTY.clipboard.writeText(pixelThemeAgentPrompt(locale));
    setPromptCopied(true);
  };

  const openAgentGuide = (): void => {
    void window.canvasTTY.external.openUrl(PIXEL_THEME_AGENT_GUIDE_URL).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const install = async (): Promise<void> => {
    if (!name.trim() || (!zipFile && SLOTS.some((slot) => !files[slot]))) return;
    if (!zipFile && (SLOTS.some((slot) => files[slot]!.size > (slot === "background" ? 80 : 20) * 1024 * 1024)
      || SLOTS.reduce((total, slot) => total + files[slot]!.size, 0) > 150 * 1024 * 1024)) {
      setError(ru ? "Рамка — до 20 МБ, видео — до 80 МБ, вся тема — до 150 МБ." : "Frames up to 20 MB, video up to 80 MB, whole theme up to 150 MB.");
      return;
    }
    setInstalling(true);
    setError(null);
    try {
      const pack = zipFile
        ? await window.canvasTTY.pixelSkins.installZip({
          name: name.trim(), apertures, archive: new Uint8Array(await zipFile.arrayBuffer())
        })
        : await (async () => {
          const bytes = await Promise.all(SLOTS.map(async (slot) => [slot, await readMediaFile(files[slot]!)] as const));
          return window.canvasTTY.pixelSkins.install({
            name: name.trim(), apertures,
            files: Object.fromEntries(bytes) as Record<PixelSkinSlot, Uint8Array>
          });
        })();
      onCreated(pack);
      setOpen(false);
      setName("");
      setFiles({});
      setZipFile(null);
      setApertures(DEFAULT_PIXEL_SKIN_APERTURES);
      setApertureLevel("minimal");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  };

  const count = SLOTS.filter((slot) => files[slot]).length;
  const aperture: PixelSkinAperture = apertures[apertureLevel];
  return (
    <>
      <button className="pixel-pack-create" type="button" onClick={() => { setPromptCopied(false); setOpen(true); }}>
        <UiIcon name="image-plus" size={19} />
        {ru ? "Создать тему / живой скин" : "Create theme / live skin"}
      </button>
      {open && createPortal(
        <div className="pixel-pack-dialog-backdrop" onPointerDown={(event) => {
          if (event.target === event.currentTarget && !installing) setOpen(false);
        }}>
          <div className="pixel-pack-dialog" role="dialog" aria-modal="true" aria-labelledby="pixel-pack-title">
            <div className="pixel-pack-dialog__header">
              <h2 id="pixel-pack-title">{ru ? "Новая тема / живой скин" : "New theme / live skin"}</h2>
              <button type="button" className="pixel-pack-dialog__close" onClick={() => setOpen(false)} disabled={installing} title={ru ? "Закрыть" : "Close"} aria-label={ru ? "Закрыть" : "Close"}>
                <UiIcon name="close" size={19} />
              </button>
            </div>
            <div className="pixel-pack-dialog__body">
              <div className="pixel-pack-guide">
                <div>
                  <h3>{ru ? "Соберите тему с помощью агента" : "Build a theme with your agent"}</h3>
                  <ol>
                    <li>{ru ? "Скопируйте задание ниже, вставьте его в чат агента, опишите стиль и приложите референс." : "Copy the brief below, paste it into your agent chat, describe the style, and attach a reference."}</li>
                    <li>{ru ? "Загрузите ZIP или 10 файлов: 9 рамок PNG/APNG/GIF/WebP и фон PNG/APNG/GIF/WebP/MP4/WebM." : "Upload a ZIP or 10 files: 9 PNG/APNG/GIF/WebP borders and a PNG/APNG/GIF/WebP/MP4/WebM Canvas background."}</li>
                    <li>{ru ? "Назовите тему и нажмите «Создать тему». Её рамки и фон можно выбирать независимо в оформлении." : "Name the theme and select “Create theme”. Its borders and background can be selected independently in Appearance."}</li>
                  </ol>
                </div>
                <figure>
                  <img src={PILOT_SKIN_ASSETS[pixelSkinAssetFilename("sakura", "detailed", "idle")]} alt={ru ? "Пример пиксельной рамки Сакура" : "Example Sakura pixel border"} />
                  <figcaption>{ru ? "Пример: детальная рамка «Сакура»" : "Example: detailed Sakura border"}</figcaption>
                </figure>
              </div>
              <div className="pixel-pack-dialog__topline">
                <label>
                  <span>{ru ? "Название темы" : "Theme name"}</span>
                  <input value={name} maxLength={64} autoFocus onChange={(event) => setName(event.target.value)} placeholder={ru ? "Моя тема" : "My theme"} />
                </label>
                <input ref={bulkInput} type="file" accept={MEDIA_ACCEPT} multiple hidden onChange={(event) => {
                  if (event.target.files) assignMany(event.target.files);
                  event.target.value = "";
                }} />
                <input ref={zipInput} type="file" accept="application/zip,.zip" hidden onChange={(event) => {
                  assignZip(event.target.files?.[0]);
                  event.target.value = "";
                }} />
                <button type="button" className="pixel-pack-dialog__bulk" onClick={() => zipInput.current?.click()}>
                  <UiIcon name="folder" size={17} />
                  {ru ? "Загрузить ZIP" : "Add ZIP"}
                </button>
                <button type="button" className="pixel-pack-dialog__bulk" onClick={() => bulkInput.current?.click()}>
                  <UiIcon name="folder" size={17} />
                  {ru ? "Загрузить файлы" : "Add files"}
                </button>
              </div>
              <div className="pixel-pack-dialog__agent-actions">
                <button type="button" onClick={copyAgentPrompt} title={ru ? "Скопировать задание для агента" : "Copy agent brief"}>
                  <UiIcon name={promptCopied ? "done" : "copy"} size={16} />
                  {promptCopied ? (ru ? "Задание скопировано" : "Brief copied") : (ru ? "Скопировать задание агенту" : "Copy agent brief")}
                </button>
                <button type="button" onClick={openAgentGuide} title={ru ? "Открыть инструкцию на GitHub" : "Open the GitHub guide"}>
                  <UiIcon name="browser" size={16} />
                  {ru ? "Подробнее о формате" : "More about the format"}
                </button>
              </div>
              <p className="pixel-pack-help">{zipFile
                ? (ru ? "ZIP будет проверен при создании темы. Предпросмотр рамок появится после установки." : "The ZIP will be validated when you create the theme. Border previews are available after installation.")
                : (ru ? "Нажмите на ячейку или перетащите файл для предпросмотра. APNG, GIF и WebP поддерживают анимацию; MP4 и WebM доступны для фона. Строки — простая рамка, детальная и Master для оркестратора; столбцы — ожидание, работа и готово." : "Click a slot or drop a file to preview. APNG, GIF and WebP support animation; MP4 and WebM are available for the background. Rows are simple, detailed, and Master for an orchestrator; columns are idle, working, and completed.")}</p>
              {zipFile ? <div className="pixel-pack-zip-selected">
                <span>{zipFile.name}</span>
                <button type="button" onClick={() => setZipFile(null)} title={ru ? "Убрать ZIP" : "Remove ZIP"} aria-label={ru ? "Убрать ZIP" : "Remove ZIP"}>
                  <UiIcon name="close" size={16} />
                </button>
              </div> : <div className="pixel-pack-grid" role="group" aria-label={ru ? "Состояния терминала" : "Terminal states"}>
                {LEVELS.map((level) => STATES.map((state) => {
                  const slot = `${level}_${state}` as PixelSkinSlot;
                  const label = `${levelLabels[level]} · ${stateLabels[state]}`;
                  return (
                    <label key={slot} className="pixel-pack-slot" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                      event.preventDefault();
                      assign(slot, event.dataTransfer.files[0]);
                    }}>
                      <span className="pixel-pack-slot__label">{label}<small>{slot}.png / .gif / .webp</small></span>
                      {previews[slot]
                        ? <SkinMediaView src={previews[slot]} media={fileMedia(files[slot]!)} className="skin-media-preview" />
                        : <span className="pixel-pack-slot__empty"><UiIcon name="image-plus" size={22} /><span>{ru ? "Нажмите или перетащите файл" : "Click or drop a file"}</span></span>}
                      <input type="file" accept={IMAGE_ACCEPT} aria-label={label} onChange={(event) => {
                        assign(slot, event.target.files?.[0]);
                        event.target.value = "";
                      }} />
                    </label>
                  );
                }))}
              </div>}
              <div className={`pixel-pack-bottom${zipFile ? " pixel-pack-bottom--zip" : ""}`}>
                {!zipFile && <label className="pixel-pack-slot pixel-pack-slot--background" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                  event.preventDefault();
                  assign("background", event.dataTransfer.files[0]);
                }}>
                  <span className="pixel-pack-slot__label">{ru ? "Фон Canvas" : "Canvas background"}<small>background.png / .gif / .webp / .mp4 / .webm</small></span>
                  {previews.background
                    ? <SkinMediaView src={previews.background} media={fileMedia(files.background!)} className="skin-media-preview" />
                    : <span className="pixel-pack-slot__empty"><UiIcon name="image-plus" size={22} /><span>{ru ? "Нажмите или перетащите файл" : "Click or drop a file"}</span></span>}
                  <input type="file" accept={MEDIA_ACCEPT} aria-label={ru ? "Фон" : "Background"} onChange={(event) => {
                    assign("background", event.target.files?.[0]);
                    event.target.value = "";
                  }} />
                </label>}
                <div className="pixel-pack-aperture" role="group" aria-label={ru ? "Отступы терминала" : "Terminal insets"}>
                  <p className="pixel-pack-help">{ru ? "Отступы оставляют место для рамки вокруг текста терминала. Меняйте их, если рисунок перекрывает текст." : "Insets reserve space for the border around terminal text. Adjust them if the artwork overlaps the text."}</p>
                  <div className="pixel-pack-aperture__levels" role="group" aria-label={ru ? "Размер терминала" : "Terminal size"}>
                    {LEVELS.map((level) => (
                      <button key={level} type="button" aria-pressed={apertureLevel === level} onClick={() => setApertureLevel(level)}>
                        {level === "master" ? (ru ? "Master · Оркестратор" : "Master · Orchestrator") : levelLabels[level]}
                      </button>
                    ))}
                  </div>
                  {(["left", "right", "top", "bottom"] as const).map((edge) => (
                    <label key={edge}>
                      <span>{ru ? ({ left: "Слева", right: "Справа", top: "Сверху", bottom: "Снизу" })[edge]
                        : edge}</span>
                      <input type="range" min={2} max={Math.min(35, 55 - aperture[edge === "left" ? "right" : edge === "right" ? "left" : edge === "top" ? "bottom" : "top"])} value={aperture[edge]} onChange={(event) => setApertures((current) => ({
                        ...current,
                        [apertureLevel]: { ...current[apertureLevel], [edge]: Number(event.target.value) }
                      }))} />
                      <output>{aperture[edge]}%</output>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="pixel-pack-dialog__footer">
              <span role="status">{error ?? (zipFile ? zipFile.name : `${count}/10`)}</span>
              <button type="button" onClick={() => void install()} disabled={installing || !name.trim() || (!zipFile && count !== SLOTS.length)}>
                <UiIcon name={installing ? "working" : "done"} size={16} />
                {installing ? (ru ? "Установка…" : "Installing…") : (ru ? "Создать тему" : "Create theme")}
              </button>
            </div>
          </div>
        </div>, document.body
      )}
    </>
  );
}
