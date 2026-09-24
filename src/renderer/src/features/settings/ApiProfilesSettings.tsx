import { useState } from "react";
import type {
  ApiProfile,
  ApiProfileProtocol,
  AppSettings,
  LocaleId,
  ProviderSecretId
} from "../../../../shared/contracts";
import { API_PROFILE_PRESETS, API_PROFILE_PROTOCOLS, PROVIDER_SECRET_IDS } from "../../../../shared/contracts";
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

const PROTOCOL_LABELS: Record<ApiProfileProtocol, string> = {
  "openai-compatible": "OpenAI-compatible",
  "anthropic-compatible": "Anthropic-compatible",
  google: "Google"
};

interface ApiProfilesSettingsProps {
  settings: AppSettings;
  onChange(patch: Partial<AppSettings>): Promise<void>;
}

interface ProfileDraft {
  id: string;
  name: string;
  protocol: ApiProfileProtocol;
  baseUrl: string;
  secretRef: ProviderSecretId;
  defaultModel: string;
}

function draftFrom(profile: ApiProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl ?? "",
    secretRef: profile.secretRef,
    defaultModel: profile.defaultModel ?? ""
  };
}

function toProfile(draft: ProfileDraft): ApiProfile {
  return {
    id: draft.id,
    name: draft.name.trim(),
    protocol: draft.protocol,
    ...(draft.baseUrl.trim().length > 0 ? { baseUrl: draft.baseUrl.trim() } : {}),
    secretRef: draft.secretRef,
    ...(draft.defaultModel.trim().length > 0 ? { defaultModel: draft.defaultModel.trim() } : {})
  };
}

function draftIsValid(draft: ProfileDraft): boolean {
  return draft.name.trim().length > 0
    && (draft.baseUrl.trim().length === 0 || /^https:\/\//u.test(draft.baseUrl.trim()));
}

export function ApiProfilesSettings({ settings, onChange }: ApiProfilesSettingsProps): React.JSX.Element {
  const locale = settings.locale;
  const profiles = settings.apiProfiles;
  const [drafts, setDrafts] = useState<Record<string, ProfileDraft>>({});
  const [busy, setBusy] = useState(false);

  const draftFor = (profile: ApiProfile): ProfileDraft => drafts[profile.id] ?? draftFrom(profile);

  const commitDraft = async (draft: ProfileDraft): Promise<void> => {
    setBusy(true);
    try {
      await onChange({
        apiProfiles: profiles.map((profile) => (profile.id === draft.id ? toProfile(draft) : profile))
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[draft.id];
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  const addPreset = async (preset: ApiProfile): Promise<void> => {
    let id = preset.id;
    let suffix = 2;
    const taken = new Set(profiles.map((profile) => profile.id));
    while (taken.has(id)) id = `${preset.id}-${suffix++}`;
    setBusy(true);
    try {
      await onChange({ apiProfiles: [...profiles, { ...preset, id }] });
    } finally {
      setBusy(false);
    }
  };

  const removeProfile = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await onChange({ apiProfiles: profiles.filter((profile) => profile.id !== id) });
      setDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-launcher-settings">
      <div className="api-profile-presets">
        {API_PROFILE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="api-profile-presets__button"
            disabled={busy}
            title={preset.baseUrl ? `${preset.protocol} · ${preset.baseUrl}` : preset.protocol}
            onClick={() => void addPreset(preset)}
          >
            <span>+ {preset.name}</span>
            <small>{SECRET_LABELS[preset.secretRef]}</small>
          </button>
        ))}
      </div>
      {profiles.map((profile) => {
        const draft = draftFor(profile);
        const valid = draftIsValid(draft);
        const dirty = JSON.stringify(toProfile(draft)) !== JSON.stringify(profile);
        const update = (patch: Partial<ProfileDraft>): void => {
          setDrafts((current) => ({ ...current, [profile.id]: { ...draft, ...patch } }));
        };
        return (
          <div className="agent-launcher-settings__row api-profile-row" key={profile.id}>
            <span className="api-profile-row__fields">
              <input
                type="text"
                value={draft.name}
                maxLength={80}
                aria-label={t(locale, "apiProfileFieldName")}
                placeholder={t(locale, "apiProfileFieldName")}
                onChange={(event) => update({ name: event.currentTarget.value })}
              />
              <select
                value={draft.protocol}
                aria-label={t(locale, "apiProfileFieldProtocol")}
                onChange={(event) => update({ protocol: event.currentTarget.value as ApiProfileProtocol })}
              >
                {API_PROFILE_PROTOCOLS.map((protocol) => (
                  <option key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol]}</option>
                ))}
              </select>
              <input
                className="api-profile-row__base-url"
                type="text"
                value={draft.baseUrl}
                maxLength={500}
                spellCheck={false}
                placeholder="https://…"
                aria-label={t(locale, "apiProfileFieldBaseUrl")}
                onChange={(event) => update({ baseUrl: event.currentTarget.value })}
              />
              <select
                value={draft.secretRef}
                aria-label={t(locale, "apiProfileFieldSecret")}
                onChange={(event) => update({ secretRef: event.currentTarget.value as ProviderSecretId })}
              >
                {PROVIDER_SECRET_IDS.map((secretId) => (
                  <option key={secretId} value={secretId}>{SECRET_LABELS[secretId]}</option>
                ))}
              </select>
              <input
                type="text"
                value={draft.defaultModel}
                maxLength={200}
                spellCheck={false}
                placeholder={t(locale, "apiProfileFieldModel")}
                aria-label={t(locale, "apiProfileFieldModel")}
                onChange={(event) => update({ defaultModel: event.currentTarget.value })}
              />
            </span>
            <span className="provider-secret__controls">
              <button
                type="button"
                disabled={busy || !valid || !dirty}
                onClick={() => void commitDraft(draft)}
              >{t(locale, "apiProfileSave")}</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void removeProfile(profile.id)}
              >{t(locale, "apiProfileRemove")}</button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
