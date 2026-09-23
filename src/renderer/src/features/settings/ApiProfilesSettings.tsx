import { canonicalApiUrl } from "../../../../shared/providerAccountPolicy";
import { useState } from "react";
import type {
  ApiProfile,
  ApiProfileProtocol,
  AppSettings,
  ProviderSecretId,
  ProviderSecretRef
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
  onPersist(patch: Partial<AppSettings>): Promise<void>;
}

interface ProfileDraft {
  id: string;
  name: string;
  protocol: ApiProfileProtocol;
  baseUrl: string;
  secretRef: ProviderSecretRef;
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
  if (!draft.name.trim()) return false;
  try { if (draft.baseUrl.trim()) canonicalApiUrl(draft.baseUrl.trim()); return true; } catch { return false; }
}

export function ApiProfilesSettings({ settings, onPersist }: ApiProfilesSettingsProps): React.JSX.Element {
  const locale = settings.locale;
  const ru = locale === "ru";
  const profiles = settings.apiProfiles;
  const [drafts, setDrafts] = useState<Record<string, ProfileDraft>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [presetId, setPresetId] = useState(API_PROFILE_PRESETS[0]!.id);
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selected = profiles.find(profile => profile.id === selectedId) ?? profiles[0];
  const draft = selected ? drafts[selected.id] ?? draftFrom(selected) : null;
  const dirty = !!selected && !!draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(selected));
  const filtered = profiles.filter(profile => `${profile.name} ${profile.baseUrl ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const update = (patch: Partial<ProfileDraft>): void => {
    if (selected && draft) setDrafts(current => ({ ...current, [selected.id]: { ...draft, ...patch } }));
    setNotice("");
  };
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch { setError(ru ? "Не удалось сохранить изменения. Проверьте данные и повторите." : "Changes could not be saved. Check the details and try again."); }
    finally { setBusy(false); }
  };
  const clearDraft = (id: string): void => setDrafts(current => { const next = { ...current }; delete next[id]; return next; });
  const addPreset = async (): Promise<void> => {
    const preset = API_PROFILE_PRESETS.find(item => item.id === presetId)!;
    let id = preset.id, suffix = 2;
    const taken = new Set(profiles.map(profile => profile.id));
    while (taken.has(id)) id = `${preset.id}-${suffix++}`;
    await onPersist({ apiProfiles: [...profiles, { ...preset, id }] });
    setSelectedId(id); setQuery("");
  };
  const saveProfile = async (): Promise<void> => {
    if (!draft) return;
    await onPersist({ apiProfiles: profiles.map(profile => profile.id === draft.id ? { ...profile, baseUrl: undefined, defaultModel: undefined, ...toProfile(draft) } : profile) });
    clearDraft(draft.id); setNotice(ru ? "Профиль сохранён" : "Profile saved");
  };
  const removeProfile = async (): Promise<void> => {
    if (!selected) return;
    await onPersist({ apiProfiles: profiles.filter(profile => profile.id !== selected.id) });
    clearDraft(selected.id);
    setKeys(current => { const next = { ...current }; delete next[selected.id]; return next; });
    setSelectedId(null);
  };
  const saveProfileKey = async (): Promise<void> => {
    if (!selected) return;
    const owner = { profileId: selected.id, hostId: selected.hostId ?? "local" };
    let ref = selected.secretRef;
    if (ref.startsWith("secret:")) await window.canvasTTY.providerSecrets.update(ref, owner, keys[selected.id]!);
    else {
      const created = await window.canvasTTY.providerSecrets.create(owner, keys[selected.id]!);
      try { await onPersist({ apiProfiles: profiles.map(profile => profile.id === selected.id ? { ...profile, secretRef: created.ref } : profile) }); }
      catch (failure) { await window.canvasTTY.providerSecrets.remove(created.ref, owner); throw failure; }
      ref = created.ref;
    }
    setKeys(current => ({ ...current, [selected.id]: "" }));
    // Saving a key must preserve any unsaved name, model or endpoint edits.
    setDrafts(current => current[selected.id] ? { ...current, [selected.id]: { ...current[selected.id]!, secretRef: ref } } : current);
    setNotice(ru ? "Ключ сохранён" : "Key saved");
  };
  return <section className="api-profiles" aria-label={t(locale, "apiProfiles")}>
    <div className="api-profiles__add">
      <label className="agent-settings-field"><span>{ru ? "Добавить подключение" : "Add a connection"}</span>
        <select value={presetId} onChange={event => setPresetId(event.target.value)} disabled={busy}>
          {API_PROFILE_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
      </label>
      <button className="agent-settings-button agent-settings-button--primary" type="button" disabled={busy || profiles.length >= 512} onClick={() => void run(addPreset)}>{ru ? "+ Добавить" : "+ Add"}</button>
    </div>
    {profiles.length > 0 ? <div className="api-profiles__workspace">
      <div className="api-profiles__catalog">
        <label className="agent-settings-field"><span>{ru ? "Профили" : "Profiles"} <span className="agent-settings-count">{profiles.length}</span></span>
          <input type="search" value={query} placeholder={ru ? "Найти профиль…" : "Find a profile…"} onChange={event => setQuery(event.target.value)} />
        </label>
        <div className="api-profiles__list" aria-label={ru ? "Список API-профилей" : "API profile list"}>
          {filtered.map(profile => <button type="button" key={profile.id} className={`api-profiles__item${profile.id === selected?.id ? " api-profiles__item--active" : ""}`} aria-pressed={profile.id === selected?.id} disabled={busy} onClick={() => { setSelectedId(profile.id); setError(""); setNotice(""); }}>
            <strong>{profile.name}</strong><small>{PROTOCOL_LABELS[profile.protocol]}</small>
          </button>)}
          {filtered.length === 0 && <p className="agent-settings-hint">{ru ? "Профили не найдены" : "No profiles found"}</p>}
        </div>
      </div>
      {selected && draft && <div className="api-profiles__editor" aria-label={ru ? "Редактор API-профиля" : "API profile editor"}>
        <div className="agent-settings-heading"><strong>{selected.name}</strong>{dirty && <span className="agent-settings-hint">{ru ? "Есть изменения" : "Unsaved changes"}</span>}</div>
        <div className="agent-settings-grid">
          <label className="agent-settings-field"><span>{t(locale, "apiProfileFieldName")}</span><input value={draft.name} maxLength={80} disabled={busy} onChange={event => update({ name: event.target.value })} /></label>
          <label className="agent-settings-field"><span>{t(locale, "apiProfileFieldProtocol")}</span><select value={draft.protocol} disabled={busy} onChange={event => update({ protocol: event.target.value as ApiProfileProtocol })}>{API_PROFILE_PROTOCOLS.map(protocol => <option key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol]}</option>)}</select></label>
          <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "apiProfileFieldBaseUrl")}</span><input type="url" value={draft.baseUrl} maxLength={500} spellCheck={false} placeholder="https://…" disabled={busy} onChange={event => update({ baseUrl: event.target.value })} /></label>
          <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "apiProfileFieldModel")}</span><input value={draft.defaultModel} maxLength={200} spellCheck={false} placeholder={ru ? "Название модели у провайдера" : "Provider model name"} disabled={busy} onChange={event => update({ defaultModel: event.target.value })} /></label>
        </div>
        <div className="api-profiles__credentials">
          <label className="agent-settings-field"><span>{ru ? "Использовать ключ" : "Use key"}</span><select value={draft.secretRef} disabled={busy} onChange={event => update({ secretRef: event.target.value as ProviderSecretRef })}>
            {selected.secretRef.startsWith("secret:") && <option value={selected.secretRef}>{ru ? "Отдельный ключ этого профиля" : "This profile’s private key"}</option>}
            {PROVIDER_SECRET_IDS.map(id => <option key={id} value={id}>{SECRET_LABELS[id]}</option>)}
          </select></label>
          <label className="agent-settings-field"><span>{ru ? "Новый ключ для этого профиля" : "New key for this profile"}</span><input type="password" autoComplete="new-password" value={keys[selected.id] ?? ""} maxLength={16 * 1024} placeholder={ru ? "Вставьте API-ключ" : "Paste API key"} disabled={busy || (selected.hostId ?? "local") !== "local"} onChange={event => setKeys(current => ({ ...current, [selected.id]: event.target.value }))} /></label>
          <div className="api-profiles__key-footer"><p className="agent-settings-hint">{ru ? "Сохранённое значение не показывается." : "Saved values are never displayed."}</p><button className="agent-settings-button" type="button" disabled={busy || !keys[selected.id]?.trim() || (selected.hostId ?? "local") !== "local"} onClick={() => void run(saveProfileKey)}>{ru ? "Сохранить ключ" : "Save key"}</button></div>
        </div>
        <div className="agent-settings-actions">
          <button className="agent-settings-button agent-settings-button--danger" type="button" disabled={busy} onClick={() => void run(removeProfile)}>{t(locale, "apiProfileRemove")}</button>
          <button className="agent-settings-button agent-settings-button--primary" type="button" disabled={busy || !draftIsValid(draft) || !dirty} onClick={() => void run(saveProfile)}>{t(locale, "apiProfileSave")}</button>
        </div>
      </div>}
    </div> : <p className="agent-settings-empty">{ru ? "Выберите сервис выше, чтобы создать первый профиль." : "Choose a service above to create your first profile."}</p>}
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
    <p className="agent-settings-notice" role="status">{busy ? (ru ? "Сохранение…" : "Saving…") : notice}</p>
  </section>;
}
