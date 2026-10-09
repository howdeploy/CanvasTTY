import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LocaleId, MascotProjectSummary } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";

export function MascotsSettings({ locale, projects, onCreate, onOpen, onRetry, onOpenLog }: {
  locale: LocaleId;
  projects: MascotProjectSummary[];
  onCreate(file: File): Promise<void>;
  onOpen(project: MascotProjectSummary): Promise<void>;
  onRetry(projectId: string): Promise<void>;
  onOpenLog(projectId: string): Promise<void>;
}): React.JSX.Element {
  const ru = locale === "ru";
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, busy]);

  const choose = (selected: File | undefined): void => {
    if (!selected) return;
    if (!/\.(png|jpe?g)$/i.test(selected.name) || (selected.type && !["image/png", "image/jpeg"].includes(selected.type)) || selected.size > 20 * 1024 * 1024) {
      setError(ru ? "Выберите PNG или JPG/JPEG размером до 20 МБ." : "Choose a PNG or JPG/JPEG up to 20 MB.");
      return;
    }
    setFile(selected);
    setError(null);
  };

  const create = async (): Promise<void> => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(file);
      setOpen(false);
      setFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <section className="setting-group mascot-settings">
      <h3>{ru ? "Ваши маскоты" : "Your mascots"}</h3>
      <p className="setting-group__description">{ru
        ? "Создавайте анимированных персонажей из PNG или JPG и размещайте их на канвасе."
        : "Create animated characters from PNG or JPG images and place them on the canvas."}</p>
      {projects.length > 0 && <div className="mascot-settings__list">
        {projects.map((project) => <div className="mascot-settings__item" key={project.id}>
          <span><strong>{project.name}</strong><small>{project.status === "ready"
            ? (project.delivery === "draft" ? (ru ? "Установлен черновик" : "Draft installed") : (ru ? "Готов к показу" : "Ready to show"))
            : project.status === "failed" ? (project.error ?? (ru ? "Ошибка создания" : "Creation failed"))
              : (ru ? "Создаётся в Codex" : "Being created in Codex")}</small>
            {project.error && <small role="alert">{project.errorStage}: {project.error}</small>}
            {project.errorLogPath && <button type="button" title={project.errorLogPath} onClick={() => {
              setListError(null); void onOpenLog(project.id).catch((cause) => setListError(cause instanceof Error ? cause.message : String(cause)));
            }}>{ru ? "Открыть полный журнал" : "Open full log"}</button>}
            {project.limitations?.map((item, index) => <small key={index}>{item}</small>)}
          </span>
          {(project.error || project.status === "failed") && <button type="button" onClick={() => {
            setListError(null); void onRetry(project.id).catch((cause) => setListError(cause instanceof Error ? cause.message : String(cause)));
          }}>{ru ? "Повторить установку" : "Retry installation"}</button>}
          <button type="button" onClick={() => { setListError(null); void onOpen(project).catch((cause) => setListError(cause instanceof Error ? cause.message : String(cause))); }} disabled={project.status !== "ready" && !project.sessionId}>
            {project.status === "ready" ? (ru ? "Показать" : "Show") : (ru ? "Открыть чат" : "Open chat")}
          </button>
        </div>)}
      </div>}
      {listError && <p className="setting-group__description" role="alert">{listError}</p>}
      <button className="pixel-pack-create" type="button" onClick={() => { setError(null); setOpen(true); }}>
        <UiIcon name="image-plus" size={19} />{ru ? "Создать маскота" : "Create mascot"}
      </button>
    </section>
    {open && createPortal(<div className="pixel-pack-dialog-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !busy) setOpen(false);
    }}>
      <div className="pixel-pack-dialog mascot-dialog" role="dialog" aria-modal="true" aria-labelledby="mascot-dialog-title">
        <div className="pixel-pack-dialog__header">
          <h2 id="mascot-dialog-title">{ru ? "Новый маскот" : "New mascot"}</h2>
          <button type="button" className="pixel-pack-dialog__close" onClick={() => setOpen(false)} disabled={busy} title={ru ? "Закрыть" : "Close"} aria-label={ru ? "Закрыть" : "Close"}>
            <UiIcon name="close" size={19} />
          </button>
        </div>
        <div className="pixel-pack-dialog__body">
          <div className="pixel-pack-guide mascot-dialog__guide">
            <div>
              <h3>{ru ? "Создайте маскота с помощью Codex" : "Create a mascot with Codex"}</h3>
              <ol>
                <li>{ru ? "Загрузите PNG или JPG/JPEG персонажа с фоном или без. Codex обработает фото, подготовит чёткий рисунок в полный рост на прозрачном фоне и покажет его для одобрения." : "Upload a character PNG or JPG/JPEG with or without a background. Codex processes the image and prepares a clear full-body drawing on transparency for your approval."}</li>
                <li>{ru ? "В чате выберите: сохранить внешность или сначала изменить её. Затем задайте имя, позы и анимации. Можно добавлять предметы и сцены." : "In the chat, keep or revise the appearance. Then choose a name, poses, and animations. You can add objects and scenes."}</li>
                <li>{ru ? "Кадры и анимации будут видны в браузере CanvasTTY во время работы. Готовый маскот появится на канвасе после вашего отдельного согласия на установку." : "Frames and animations appear in the CanvasTTY browser while you work. The finished mascot is installed on the canvas only after your separate approval."}</li>
              </ol>
            </div>
            <figure className="mascot-dialog__preview">
              {preview ? <img src={preview} alt={ru ? "Загруженный персонаж" : "Uploaded character"} /> : <span><UiIcon name="image-plus" size={32} />{ru ? "Здесь появится персонаж" : "Your character appears here"}</span>}
              <figcaption>{file?.name ?? (ru ? "Исходное изображение" : "Source image")}</figcaption>
            </figure>
          </div>
          <label className="mascot-dialog__upload" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
            <UiIcon name="image-plus" size={23} />
            <span>{file ? file.name : (ru ? "Нажмите или перетащите PNG или JPG персонажа" : "Click or drop a character PNG or JPG")}</span>
            <input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label={ru ? "Загрузить PNG или JPG персонажа" : "Upload character PNG or JPG"} onChange={(event) => {
              choose(event.target.files?.[0]);
              event.target.value = "";
            }} />
          </label>
          <p className="pixel-pack-help">{ru
            ? "Кнопка запускает Codex в режиме YOLO (обход): полный доступ к файлам и командам без запросов разрешения, с управлением браузером CanvasTTY. Оригинал сохраняется отдельно; внешний вид утверждается перед анимацией."
            : "This button starts Codex in YOLO (bypass): full file and command access without permission prompts, with CanvasTTY browser control enabled. The original is preserved; appearance is approved before animation."}</p>
        </div>
        <div className="pixel-pack-dialog__footer">
          <span role="status">{error ?? (file ? file.name : (ru ? "Изображение не выбрано" : "No image selected"))}</span>
          <button type="button" disabled={!file || busy} onClick={() => void create()}>
            <UiIcon name={busy ? "working" : "done"} size={16} />
            {busy ? (ru ? "Запускаем Codex…" : "Starting Codex…") : (ru ? "Создать маскота" : "Create mascot")}
          </button>
        </div>
      </div>
    </div>, document.body)}
  </>;
}
