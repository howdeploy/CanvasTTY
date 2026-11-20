import { useEffect, useState } from "react";
import type { AuthorThemeSummary, LocaleId } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import "./authorThemePresets.css";

export function AuthorThemePresets({ locale }: { locale: LocaleId }) {
  const [themes, setThemes] = useState<AuthorThemeSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; failed: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    void window.canvasTTY.authorThemes.list().then(
      items => { if (active) setThemes(items); },
      () => { if (active) setLoadFailed(true); }
    );
    return () => { active = false; };
  }, []);

  async function apply(theme: AuthorThemeSummary): Promise<void> {
    setApplying(theme.id);
    setResult(null);
    try {
      await window.canvasTTY.authorThemes.apply(theme.id);
      setResult({ name: theme.name, failed: false });
    } catch {
      setResult({ name: theme.name, failed: true });
    } finally {
      setApplying(null);
    }
  }

  if (loadFailed) return <p role="alert">{t(locale, "authorThemesLoadFailed")}</p>;
  if (!themes) return <p role="status">{t(locale, "authorThemesLoading")}</p>;

  return (
    <div className="author-themes">
      <div className="author-themes__grid">
        {themes.map(theme => (
          <article key={theme.id} className="author-themes__card">
            {theme.preview && <img src={theme.preview} alt="" loading="lazy" />}
            <div className="author-themes__row">
              <strong>{theme.name}</strong>
              <button
                type="button"
                className="setting-inline-action"
                aria-label={`${t(locale, "authorThemeApply")} ${theme.name}`}
                disabled={applying !== null}
                onClick={() => void apply(theme)}
              >
                {t(locale, applying === theme.id ? "authorThemeApplying" : "authorThemeApply")}
              </button>
            </div>
          </article>
        ))}
      </div>
      {result && (
        <p role={result.failed ? "alert" : "status"} className="author-themes__status">
          {t(locale, result.failed ? "authorThemeApplyFailed" : "authorThemeApplied")} · {result.name}
        </p>
      )}
    </div>
  );
}
