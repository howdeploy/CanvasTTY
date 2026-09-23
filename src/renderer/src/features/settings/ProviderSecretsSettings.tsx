import { useEffect, useState } from "react";
import type { LocaleId, ProviderSecretId } from "../../../../shared/contracts";
import { PROVIDER_SECRET_IDS } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";

const SECRET_LABELS: Record<ProviderSecretId, string> = {
  OPENAI_API_KEY: "OpenAI",
  ANTHROPIC_API_KEY: "Anthropic",
  XAI_API_KEY: "xAI",
  GOOGLE_API_KEY: "Google",
  ZAI_API_KEY: "Z.AI",
  MINIMAX_API_KEY: "MiniMax",
  OPENROUTER_API_KEY: "OpenRouter",
  DEEPSEEK_API_KEY: "DeepSeek",
  DEVIN_API_KEY: "Devin",
  CURSOR_API_KEY: "Cursor"
};

interface ProviderSecretsSettingsProps {
  locale: LocaleId;
  onChanged?(): Promise<void>;
}

export function ProviderSecretsSettings({ locale, onChanged }: ProviderSecretsSettingsProps): React.JSX.Element {
  const [status, setStatus] = useState<Record<ProviderSecretId, boolean>>(
    () => Object.fromEntries(PROVIDER_SECRET_IDS.map((secretId) => [secretId, false])) as Record<ProviderSecretId, boolean>
  );
  const [drafts, setDrafts] = useState<Partial<Record<ProviderSecretId, string>>>({});
  const [busy, setBusy] = useState<ProviderSecretId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.canvasTTY.providerSecrets.status().then(next => { if (active) setStatus(next); }, () => undefined);
    return () => { active = false; };
  }, []);

  const save = async (secretId: ProviderSecretId): Promise<void> => {
    const value = (drafts[secretId] ?? "").trim();
    if (value.length === 0) return;
    setBusy(secretId);
    setError(null);
    try {
      await window.canvasTTY.providerSecrets.set(secretId, value);
      await onChanged?.();
      setStatus((current) => ({ ...current, [secretId]: true }));
      setDrafts((current) => ({ ...current, [secretId]: "" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const clear = async (secretId: ProviderSecretId): Promise<void> => {
    setBusy(secretId);
    setError(null);
    try {
      await window.canvasTTY.providerSecrets.clear(secretId);
      await onChanged?.();
      setStatus((current) => ({ ...current, [secretId]: false }));
      setDrafts((current) => ({ ...current, [secretId]: "" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="agent-launcher-settings">
      {PROVIDER_SECRET_IDS.map((secretId) => {
        const configured = status[secretId];
        const draft = drafts[secretId] ?? "";
        return (
          <div className="agent-launcher-settings__row" key={secretId}>
            <span className="agent-launcher-settings__identity">
              <strong>{SECRET_LABELS[secretId]}</strong>
              <span className={configured ? "provider-secret provider-secret--on" : "provider-secret"}>
                {configured ? t(locale, "providerSecretConfigured") : t(locale, "providerSecretNotConfigured")}
              </span>
            </span>
            <span className="provider-secret__controls">
              <input
                className="provider-secret__input"
                type="password"
                value={draft}
                autoComplete="off"
                spellCheck={false}
                placeholder={secretId}
                aria-label={`${SECRET_LABELS[secretId]} ${secretId}`}
                onChange={(event) => setDrafts((current) => ({ ...current, [secretId]: event.currentTarget.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void save(secretId);
                }}
              />
              <button
                type="button"
                disabled={busy === secretId || draft.trim().length === 0}
                onClick={() => void save(secretId)}
              >{t(locale, "providerSecretSave")}</button>
              {configured && (
                <button
                  type="button"
                  disabled={busy === secretId}
                  onClick={() => void clear(secretId)}
                >{t(locale, "providerSecretClear")}</button>
              )}
            </span>
          </div>
        );
      })}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  );
}
