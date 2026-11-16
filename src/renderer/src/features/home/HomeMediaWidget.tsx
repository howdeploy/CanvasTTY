import { useState } from "react";
import { WallpaperView } from "../skins/WallpaperView";
import type { WallpaperId, LocaleId, MediaFit } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";

export interface HomeMediaWidgetProps {
  locale: LocaleId;
  wallpaperId?: WallpaperId | null;
  dataUrl: string | null;
  fit: MediaFit;
  onRequestMedia(): Promise<void>;
  onRemoveMedia(): Promise<void>;
}

export function HomeMediaWidget({
  locale,
  dataUrl,
  wallpaperId,
  fit,
  onRequestMedia,
  onRemoveMedia
}: HomeMediaWidgetProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const hasMedia = Boolean(dataUrl || wallpaperId);
  const label = hasMedia ? t(locale, "changeMedia") : t(locale, "addMedia");
  const backgroundStyle = dataUrl && !wallpaperId ? {
    backgroundImage: `url(${dataUrl})`,
    backgroundSize: fit,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center"
  } : undefined;

  return (
    <section className={`tile mini-media ${hasMedia ? "mini-media--custom" : ""}`} aria-label={label}>
      <button
        className="mini-media__pick"
        type="button"
        disabled={busy}
        onClick={() => void run(onRequestMedia)}
        aria-label={label}
        title={locale === "ru" ? "Аватарка: GIF, WebP, PNG или JPEG" : "Avatar: GIF, WebP, PNG or JPEG"}
        style={backgroundStyle}
      >
        <WallpaperView id={wallpaperId} />
        {!hasMedia && <span className="mini-media__empty-icon"><UiIcon name="image-plus" size={44} /><strong>{locale === "ru" ? "Добавить аватар" : "Add avatar"}</strong></span>}
        <span className="mini-media__caption"><UiIcon name="image-plus" size={16} />{locale === "ru" ? "Сменить · GIF / фото" : "Change · GIF / photo"}</span>
      </button>

      {hasMedia && (
        <button
          className="mini-media__remove"
          type="button"
          disabled={busy}
          onClick={() => void run(onRemoveMedia)}
          aria-label={t(locale, "removeMedia")}
          title={t(locale, "removeMedia")}
        >
          <UiIcon name="trash" size={18} />
        </button>
      )}
    </section>
  );
}
