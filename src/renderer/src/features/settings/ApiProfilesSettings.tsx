import { canonicalApiUrl } from "../../../../shared/providerAccountPolicy";
import { validApiProfileCredential } from "../../../../shared/apiProfileCredentials";
import { useEffect, useState } from "react";
import { saveProfileCredential } from "./profileCredentialTransaction";
import type {
  ApiProfile,
  ApiProfileProtocol,
  AppSettings,
  ProviderSecretId,
  ProviderSecretRef,
  ProviderSecretStatus,
  RemoteApiCredentialRef
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
  recordId?: string; selectionRequest?: unknown;
  settings: AppSettings;
  active?: boolean;
  onPersist(patch: Partial<AppSettings>): Promise<void>;
}

interface ProfileDraft {
  id: string;
  name: string;
  protocol: ApiProfileProtocol;
  baseUrl: string;
  hostId?: string;
  secretRef?: ProviderSecretRef;
  remoteCredential?: RemoteApiCredentialRef;
  defaultModel: string;
}

function draftFrom(profile: ApiProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl ?? "",
    secretRef: profile.secretRef,
    hostId: profile.hostId,
    ...(profile.remoteCredential ? { remoteCredential: profile.remoteCredential } : {}),
    defaultModel: profile.defaultModel ?? ""
  };
}

function toProfile(draft: ProfileDraft): ApiProfile {
  return {
    id: draft.id,
    name: draft.name.trim(),
    protocol: draft.protocol,
    ...(draft.baseUrl.trim().length > 0 ? { baseUrl: draft.baseUrl.trim() } : {}),
    ...(draft.hostId ? { hostId: draft.hostId } : {}),
    ...((draft.hostId ?? "local") === "local" ? { secretRef: draft.secretRef } : { remoteCredential: draft.remoteCredential }),
    ...(draft.defaultModel.trim().length > 0 ? { defaultModel: draft.defaultModel.trim() } : {})
  };
}

function draftIsValid(draft: ProfileDraft): boolean {
  if (!draft.name.trim() || !validApiProfileCredential(toProfile(draft))) return false;
  try { if (draft.baseUrl.trim()) canonicalApiUrl(draft.baseUrl.trim()); return true; } catch { return false; }
}

export function ApiProfilesSettings({ settings, active = true, recordId, selectionRequest, onPersist }: ApiProfilesSettingsProps): React.JSX.Element {
  const locale = settings.locale;
  const ru = locale === "ru";
  const profiles = settings.apiProfiles;
  const [drafts, setDrafts] = useState<Record<string, ProfileDraft>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { if (recordId) setSelectedId(recordId); }, [recordId, selectionRequest]);
  const [query, setQuery] = useState("");
  const [presetId, setPresetId] = useState(API_PROFILE_PRESETS[0]!.id);
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [origins, setOrigins] = useState<Record<string, string>>({});
  const [scoped, setScoped] = useState<ProviderSecretStatus[] | null>(null);
  const [legacy, setLegacy] = useState<Partial<Record<ProviderSecretId, boolean>>>({});
  const selected = profiles.find(profile => profile.id === selectedId) ?? (selectedId && origins[selectedId] ? JSON.parse(origins[selectedId]!) as ApiProfile : profiles[0]);
  const draft = selected ? drafts[selected.id] ?? draftFrom(selected) : null;
  const remoteDraft = !!draft?.hostId && draft.hostId !== "local";
  const localCredentialStatus = !!selected && (selected.hostId ?? "local") === "local" && !remoteDraft;
  useEffect(() => {
    if (!active || !localCredentialStatus) return;
    let current = true;
    setScoped(null); setLegacy({});
    void Promise.all([window.canvasTTY.providerSecrets.scopedStatus(), window.canvasTTY.providerSecrets.status()]).then(([nextScoped, nextLegacy]) => {
      if (current) { setScoped(nextScoped); setLegacy(nextLegacy); }
    }).catch(() => { if (current) { setScoped(null); setLegacy({}); } });
    return () => { current = false; };
  }, [active, localCredentialStatus]);
  const dirty = !!selected && !!draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(selected));
  const filtered = profiles.filter(profile => `${profile.name} ${profile.baseUrl ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const conflict = !!selected && !!origins[selected.id] && origins[selected.id] !== JSON.stringify(profiles.find(profile => profile.id === selected.id));
  const dependencies = selected ? settings.providerAccounts.filter(a => a.binding?.kind === "api-profile" && a.binding.profileId === selected.id) : [];
  const privateKey = selected?.secretRef?.startsWith("secret:") === true;
  const configured = !selected ? undefined : privateKey ? scoped === null ? undefined : scoped.some(entry => entry.ref === selected.secretRef && entry.owner.profileId === selected.id && entry.owner.hostId === (selected.hostId ?? "local") && entry.configured) : legacy[selected.secretRef as ProviderSecretId];
  const nameError = draft && !draft.name.trim() ? t(locale, "apiNameRequired") : "";
  let urlError = "";
  try { if (draft?.baseUrl.trim()) canonicalApiUrl(draft.baseUrl.trim()); } catch { urlError = t(locale, "apiUrlInvalid"); }
  const update = (patch: Partial<ProfileDraft>): void => {
    if (selected && draft) {
      setOrigins(current => ({ ...current, [selected.id]: current[selected.id] ?? JSON.stringify(selected) }));
      setDrafts(current => ({ ...current, [selected.id]: { ...draft, ...patch } }));
    }
    setNotice("");
  };
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch { setError(ru ? "Не удалось сохранить изменения. Проверьте данные и повторите." : "Changes could not be saved. Check the details and try again."); }
    finally { setBusy(false); }
  };
  const clearDraft = (id: string): void => {
    setDrafts(current => { const next = { ...current }; delete next[id]; return next; });
    setOrigins(current => { const next = { ...current }; delete next[id]; return next; });
  };
  const addPreset = async (): Promise<void> => {
    const preset = API_PROFILE_PRESETS.find(item => item.id === presetId)!;
    let id = preset.id, suffix = 2;
    const taken = new Set(profiles.map(profile => profile.id));
    while (taken.has(id)) id = `${preset.id}-${suffix++}`;
    await onPersist({ apiProfiles: [...profiles, { ...preset, id }] });
    setSelectedId(id); setQuery("");
  };
  const saveProfile = async (): Promise<void> => {
    if (!draft || conflict) return;
    await onPersist({ apiProfiles: profiles.map(profile => profile.id === draft.id ? { ...profile, baseUrl: undefined, defaultModel: undefined, hostId: undefined, secretRef: undefined, remoteCredential: undefined, ...toProfile(draft) } : profile) });
    clearDraft(draft.id); setNotice(ru ? "Профиль сохранён" : "Profile saved");
  };
  const removeProfile = async (): Promise<void> => {
    if (!selected || dependencies.length || privateKey && configured !== false) return;
    await onPersist({ apiProfiles: profiles.filter(profile => profile.id !== selected.id) });
    clearDraft(selected.id);
    setKeys(current => { const next = { ...current }; delete next[selected.id]; return next; });
    setSelectedId(null);
  };
  const saveProfileKey = async (): Promise<void> => {
    if (!selected || remoteDraft || !localCredentialStatus) return;
    const ref = await saveProfileCredential(selected, keys[selected.id]!, configured, profiles, onPersist, window.canvasTTY.providerSecrets);
    setScoped(current => [...(current ?? []).filter(entry => entry.ref !== ref), { ref, owner: { profileId: selected.id, hostId: selected.hostId ?? "local" }, configured: true }]);
    setOrigins(current => current[selected.id] ? { ...current, [selected.id]: JSON.stringify({ ...selected, secretRef: ref, ...(selected.assessment ? { assessmentInvalid: true } : {}) }) } : current);
    setKeys(current => ({ ...current, [selected.id]: "" }));
    // Saving a key must preserve any unsaved name, model or endpoint edits.
    setDrafts(current => current[selected.id] ? { ...current, [selected.id]: { ...current[selected.id]!, secretRef: ref } } : current);
    setNotice(ru ? "Ключ сохранён" : "Key saved");
  };
  const removeKey = async (): Promise<void> => {
    if (!selected || !privateKey || (selected.hostId ?? "local") !== "local") return;
    await window.canvasTTY.providerSecrets.remove(selected.secretRef!, { profileId: selected.id, hostId: selected.hostId ?? "local" });
    await onPersist({});
    setScoped(current => (current ?? []).filter(entry => entry.ref !== selected.secretRef));
    setKeys(current => ({ ...current, [selected.id]: "" }));
    setNotice(t(locale, "apiKeyRemoved"));
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
        {conflict && <p className="agent-settings-error" role="alert">{t(locale, "connectionConflict")} <button className="agent-settings-button" type="button" onClick={() => clearDraft(selected.id)}>{t(locale, "connectionReload")}</button></p>}
        {!filtered.some(profile => profile.id === selected.id) && <p className="agent-settings-hint">{t(locale, "connectionHiddenSelection")} <button className="agent-settings-button" type="button" onClick={() => setQuery("")}>{t(locale, "connectionResetSearch")}</button></p>}
        <label className="agent-settings-field"><span>{t(locale, "accountHost")}</span><select value={draft.hostId ?? "local"} disabled={busy || dependencies.length > 0 || privateKey && configured !== false} onChange={event => {
          const hostId = event.target.value === "local" ? undefined : event.target.value;
          update({ hostId, secretRef: hostId ? undefined : "OPENAI_API_KEY", remoteCredential: hostId ? { kind: "key-file", path: "" } : undefined });
          setKeys(current => ({ ...current, [selected.id]: "" }));
        }}><option value="local">{t(locale, "accountLocalHost")}</option>{settings.remoteHosts.map(host => <option key={host.id} value={host.id}>{host.label}</option>)}{remoteDraft && !settings.remoteHosts.some(host => host.id === draft.hostId) && <option value={draft.hostId}>{t(locale, "accountMissingHost")}</option>}</select>
          {dependencies.length > 0 && <small>{ru ? "Для другого сервера создайте отдельный профиль и явно измените привязку аккаунта." : "For another server, create a separate profile and explicitly change the account binding."}</small>}
        </label>
        <div className="agent-settings-grid">
          <label className="agent-settings-field"><span>{t(locale, "apiProfileFieldName")}</span><input aria-invalid={!!nameError} aria-describedby={nameError ? "api-name-error" : undefined} value={draft.name} maxLength={80} disabled={busy} onChange={event => update({ name: event.target.value })} />{nameError && <small id="api-name-error">{nameError}</small>}</label>
          <label className="agent-settings-field"><span>{t(locale, "apiProfileFieldProtocol")}</span><select value={draft.protocol} disabled={busy} onChange={event => update({ protocol: event.target.value as ApiProfileProtocol })}>{API_PROFILE_PROTOCOLS.map(protocol => <option key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol]}</option>)}</select></label>
          <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "apiProfileFieldBaseUrl")}</span><input aria-invalid={!!urlError} aria-describedby={urlError ? "api-url-error" : undefined} type="url" value={draft.baseUrl} maxLength={500} spellCheck={false} placeholder="https://…" disabled={busy} onChange={event => update({ baseUrl: event.target.value })} />{urlError && <small id="api-url-error">{urlError}</small>}</label>
          <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "apiProfileFieldModel")}</span><input value={draft.defaultModel} maxLength={200} spellCheck={false} placeholder={ru ? "Название модели у провайдера" : "Provider model name"} disabled={busy} onChange={event => update({ defaultModel: event.target.value })} /></label>
        </div>
        {remoteDraft ? <div className="api-profiles__credentials">
          <p className="agent-settings-hint">{ru ? "Ключ должен быть заранее настроен на этом сервере. CanvasTTY не копирует и не показывает его. Поддерживается запуск API-агента в контейнере." : "Provision the key on this server beforehand. CanvasTTY does not copy or display it. API agents use container execution."}</p>
          <label className="agent-settings-field"><span>{ru ? "Источник ключа на сервере" : "Credential source on server"}</span><select value={draft.remoteCredential?.kind ?? "key-file"} disabled={busy} onChange={event => update({ remoteCredential: event.target.value === "environment" ? { kind: "environment", name: "" } : { kind: "key-file", path: "" } })}><option value="key-file">{ru ? "Закрытый файл" : "Private file"}</option><option value="environment">{ru ? "Переменная окружения" : "Environment variable"}</option></select></label>
          <label className="agent-settings-field"><span>{draft.remoteCredential?.kind === "environment" ? (ru ? "Имя переменной" : "Variable name") : (ru ? "Абсолютный путь к файлу" : "Absolute file path")}</span><input value={draft.remoteCredential?.kind === "environment" ? draft.remoteCredential.name : draft.remoteCredential?.path ?? ""} maxLength={draft.remoteCredential?.kind === "environment" ? 128 : 4096} spellCheck={false} disabled={busy} aria-invalid={!validApiProfileCredential(toProfile(draft))} onChange={event => update({ remoteCredential: draft.remoteCredential?.kind === "environment" ? { kind: "environment", name: event.target.value } : { kind: "key-file", path: event.target.value } })} /></label>
          <p className="agent-settings-hint">{ru ? "Файл: только владелец, без ссылок, один ключ. Переменная должна уже существовать в окружении SSH. Замена ключа по той же ссылке выполняется администратором сервера." : "File: owner-only, no links, one key. A variable must already exist in the SSH environment. Rotation at the same reference is managed by the server administrator."}</p>
        </div> : <div className="api-profiles__credentials">
          <p className="agent-settings-hint" role="status">{t(locale, configured === undefined ? "apiKeyUnknown" : configured ? "apiKeyConfigured" : "apiKeyMissing")}</p>
          <label className="agent-settings-field"><span>{ru ? "Использовать ключ" : "Use key"}</span><select value={draft.secretRef} disabled={busy} onChange={event => update({ secretRef: event.target.value as ProviderSecretRef })}>
            {selected.secretRef?.startsWith("secret:") && <option value={selected.secretRef}>{ru ? "Отдельный ключ этого профиля" : "This profile’s private key"}</option>}
            {PROVIDER_SECRET_IDS.map(id => <option key={id} value={id}>{SECRET_LABELS[id]}</option>)}
          </select></label>
          <label className="agent-settings-field"><span>{ru ? "Новый ключ для этого профиля" : "New key for this profile"}</span><input type="password" autoComplete="new-password" value={keys[selected.id] ?? ""} maxLength={16 * 1024} placeholder={ru ? "Вставьте API-ключ" : "Paste API key"} disabled={busy || (selected.hostId ?? "local") !== "local"} onChange={event => setKeys(current => ({ ...current, [selected.id]: event.target.value }))} /></label>
          <div className="api-profiles__key-footer"><p className="agent-settings-hint">{ru ? "Сохранённое значение не показывается." : "Saved values are never displayed."}</p><button className="agent-settings-button" type="button" disabled={busy || conflict || !keys[selected.id]?.trim() || privateKey && configured === undefined || (selected.hostId ?? "local") !== "local"} onClick={() => void run(saveProfileKey)}>{ru ? "Сохранить ключ" : "Save key"}</button></div>
        </div>}
        {privateKey && !remoteDraft && <button className="agent-settings-button agent-settings-button--danger" type="button" disabled={busy || !configured || (selected.hostId ?? "local") !== "local"} onClick={() => void run(removeKey)}>{t(locale, "apiKeyRemove")}</button>}
        {dependencies.length > 0 && <p className="agent-settings-hint">{t(locale, "apiDependencies").replace("{accounts}", dependencies.map(account => account.label).join(", "))}</p>}
        {privateKey && configured !== false && <p className="agent-settings-hint">{t(locale, "apiDeleteKeyFirst")}</p>}
        <div className="agent-settings-actions">
          <button className="agent-settings-button agent-settings-button--danger" type="button" disabled={busy || dependencies.length > 0 || privateKey && configured !== false} onClick={() => void run(removeProfile)}>{t(locale, "apiProfileRemove")}</button>
          <button className="agent-settings-button" type="button" disabled={busy || !dirty} onClick={() => clearDraft(selected.id)}>{t(locale, "connectionDiscard")}</button>
          <button className="agent-settings-button agent-settings-button--primary" type="button" disabled={busy || conflict || !draftIsValid(draft) || !dirty} onClick={() => void run(saveProfile)}>{t(locale, "apiProfileSave")}</button>
        </div>
      </div>}
    </div> : <p className="agent-settings-empty">{ru ? "Выберите сервис выше, чтобы создать первый профиль." : "Choose a service above to create your first profile."}</p>}
    {error && <p className="agent-settings-error" role="alert">{error}</p>}
    <p className="agent-settings-notice" role="status">{busy ? (ru ? "Сохранение…" : "Saving…") : notice}</p>
  </section>;
}
