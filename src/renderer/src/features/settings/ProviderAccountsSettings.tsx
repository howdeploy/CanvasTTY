import { useEffect, useRef, useState } from "react";
import type { AgentProviderId, AppSettings, DataClass, ProviderAccount } from "../../../../shared/contracts";
import { DATA_CLASSES } from "../../../../shared/contracts";
import { accountInvalidReason, validatedConnectionsPatch } from "../../../../shared/connectionsSettings";
import { ACCOUNT_HOME_ENV, ACCOUNT_LOGIN_PROVIDERS, accountRouteMaxDataClass, accountServiceCount, accountSupportsRuntime, validAccountBinding } from "../../../../shared/providerAccountPolicy";
import { AGENT_PROVIDERS, PROVIDERS } from "../../lib/providers";
import { t } from "../../lib/i18n";
import { DataHandlingAssessmentEditor } from "./DataHandlingAssessmentEditor";
import { accountDraft, draftAccount, reviewedDraftAccount, type AccountDraft } from "./accountSettingsDraft";

export function ProviderAccountsSettings({ settings, active, recordId, selectionRequest, onPersist, onOpenApi }: { settings: AppSettings; active: boolean; recordId?: string; selectionRequest?: unknown; onPersist(patch: Partial<AppSettings>): Promise<void>; onOpenApi(): void }): React.JSX.Element {
  const locale = settings.locale;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { if (recordId) setSelectedId(recordId); }, [recordId, selectionRequest]);
  const [drafts, setDrafts] = useState<Record<string, AccountDraft>>({});
  const [newId, setNewId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = settings.providerAccounts.find(a => a.id === selectedId) ?? (selectedId ? drafts[selectedId]?.value : undefined) ?? settings.providerAccounts[0];
  const draft = selected ? drafts[selected.id] ?? accountDraft(selected) : undefined;
  const candidate = draft ? draftAccount(draft) : undefined;
  const dirty = !!draft && (!draft.origin || JSON.stringify(candidate) !== draft.origin || JSON.stringify(draft.evidence) !== JSON.stringify(selected?.assessment ?? accountDraft(selected!).evidence));
  const conflict = !!draft?.origin && JSON.stringify(settings.providerAccounts.find(a => a.id === selected?.id)) !== draft.origin;
  const activeSelection = useRef({ id: selected?.id, directory: candidate?.binding?.kind === "cli-home" ? candidate.binding.directory : undefined, active });
  activeSelection.current = { id: selected?.id, directory: candidate?.binding?.kind === "cli-home" ? candidate.binding.directory : undefined, active };
  const catalog = newId && drafts[newId] ? [...settings.providerAccounts, drafts[newId]!.value] : settings.providerAccounts;
  const filtered = catalog.filter(a => `${a.label} ${PROVIDERS[a.provider].label} ${settings.remoteHosts.find(h => h.id === a.hostId)?.label ?? a.hostId ?? "local"}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const replaceDraft = (next: AccountDraft): void => { setDrafts(old => ({ ...old, [next.value.id]: next })); setNotice(""); setError(""); };
  const update = (patch: Partial<ProviderAccount>): void => { if (draft) replaceDraft({ ...draft, value: { ...draft.value, ...patch } }); };
  const select = (id: string): void => { setSelectedId(id); setError(""); setNotice(""); requestAnimationFrame(() => heading.current?.focus({ preventScroll: true })); };
  const add = (): void => {
    if (newId) { select(newId); return; }
    const id = `account-${crypto.randomUUID()}`;
    const value: ProviderAccount = { id, label: t(locale, "accountNew"), provider: "codex", hostId: "local", binding: { kind: "cli-home", directory: "" } };
    setDrafts(old => ({ ...old, [id]: accountDraft(value, true) })); setNewId(id); setQuery(""); select(id);
  };
  const clearDraft = (id: string): void => setDrafts(old => { const next = { ...old }; delete next[id]; return next; });
  const run = async (operation: () => Promise<void>): Promise<void> => { setBusy(true); setError(""); setNotice(""); try { await operation(); } catch (cause) { setError(`${t(locale, "connectionFailed")} ${cause instanceof Error ? cause.message : ""}`); } finally { setBusy(false); } };
  const save = async (review = false): Promise<void> => {
    if (!draft || conflict) return;
    const next = review ? reviewedDraftAccount(draft, settings.apiProfiles) : draftAccount(draft);
    if (!validAccountBinding(next.binding)) throw new Error(t(locale, "accountBindingRequired"));
    if (draft.modelsMode === "list" && next.models?.length === 0) throw new Error(t(locale, "accountModelsList"));
    const invalid = accountInvalidReason(next); if (invalid) throw new Error(invalid);
    const accounts = draft.origin ? settings.providerAccounts.map(a => a.id === next.id ? next : a) : [...settings.providerAccounts, next];
    const patch = { providerAccounts: accounts };
    validatedConnectionsPatch(settings, patch);
    await onPersist(patch);
    const editedEvidence = JSON.stringify(draft.evidence) !== JSON.stringify(selected?.assessment ?? accountDraft(selected!).evidence);
    if (!review && editedEvidence) {
      const confirmed = (await window.canvasTTY.settings.get()).providerAccounts.find(account => account.id === next.id);
      if (confirmed) setDrafts(old => ({ ...old, [next.id]: { ...accountDraft(confirmed), evidence: draft.evidence } }));
    } else clearDraft(next.id);
    if (newId === next.id) setNewId(null);
    setNotice(t(locale, review ? "assessmentSaved" : "accountSaved"));
  };
  /** Opens the vendor login on the account's computer and saves the directory it uses. */
  const login = async (): Promise<void> => {
    if (!draft || !candidate || conflict) return;
    const directory = candidate.binding?.kind === "cli-home" ? candidate.binding.directory : "";
    const result = await window.canvasTTY.accountLogin.start({ accountId: candidate.id, provider: candidate.provider, hostId: candidate.hostId ?? "local", directory });
    const next: ProviderAccount = { ...draftAccount(draft), binding: { kind: "cli-home", directory: result.directory }, bindingRequired: false };
    const invalid = accountInvalidReason(next); if (invalid) throw new Error(invalid);
    const accounts = draft.origin ? settings.providerAccounts.map(a => a.id === next.id ? next : a) : [...settings.providerAccounts, next];
    const patch = { providerAccounts: accounts };
    validatedConnectionsPatch(settings, patch);
    await onPersist(patch);
    clearDraft(next.id);
    if (newId === next.id) setNewId(null);
    setNotice(t(locale, "accountLoginOpened"));
  };
  const inspect = async (pick = false): Promise<void> => {
    if (!candidate || candidate.binding?.kind !== "cli-home") return;
    const id = candidate.id, previous = candidate.binding.directory;
    try {
      const path = pick ? await window.canvasTTY.dialog.pickDirectory(previous || undefined) : previous;
      if (!path || !activeSelection.current.active || activeSelection.current.id !== id || activeSelection.current.directory !== previous) return;
      const result = await window.canvasTTY.accountHomes.inspect(path);
      const current = activeSelection.current;
      if (!current.active || current.id !== id || current.directory !== previous) return;
      update({ binding: { kind: "cli-home", directory: result.canonicalPath }, bindingRequired: false });
      setNotice(t(locale, "accountHomeChecked"));
    } catch (cause) {
      const current = activeSelection.current;
      if (current.active && current.id === id && current.directory === previous) throw cause;
    }

  };
  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (newId !== selected.id) await onPersist({ providerAccounts: settings.providerAccounts.filter(a => a.id !== selected.id) });
    clearDraft(selected.id); if (newId === selected.id) setNewId(null); setSelectedId(null);
  };
  const rowStatus = (a: ProviderAccount): string => {
    if (a.models?.length === 0) return t(locale, "accountDisabled");
    if (a.hostId && a.hostId !== "local" && !settings.remoteHosts.some(host => host.id === a.hostId)) return t(locale, "accountNeedsSetup");
    if (!validAccountBinding(a.binding) || a.bindingRequired || a.binding?.kind === "cli-home" && !ACCOUNT_HOME_ENV[a.provider]) return t(locale, "accountNeedsSetup");
    try { if (!accountSupportsRuntime(a, a.provider, settings.apiProfiles)) return t(locale, "accountNeedsSetup"); accountRouteMaxDataClass(a, settings.apiProfiles); return t(locale, "accountConfigured"); } catch { return t(locale, "accountNeedsReview"); }
  };
  let routeError = "", cap: DataClass | undefined, uncapped: DataClass | undefined, count: number | undefined;
  if (candidate) {
    try { uncapped = accountRouteMaxDataClass({ ...candidate, maxDataClass: undefined }, settings.apiProfiles); } catch { /* The route summary reports the reason. */ }
    try { cap = accountRouteMaxDataClass(candidate, settings.apiProfiles); if (candidate.binding?.kind === "api-profile" && !accountSupportsRuntime(candidate, candidate.provider, settings.apiProfiles)) routeError = t(locale, "accountNeedsSetup"); }
    catch (cause) { routeError = cause instanceof Error ? cause.message : t(locale, "accountNeedsReview"); }
    try { count = accountServiceCount(candidate, catalog.map(a => a.id === candidate.id ? candidate : a), settings.apiProfiles); } catch { /* Broken rows remain editable. */ }
  }
  const hostLabel = (a: ProviderAccount): string => !a.hostId || a.hostId === "local" ? t(locale, "accountLocalHost") : settings.remoteHosts.find(h => h.id === a.hostId)?.label ?? `${t(locale, "accountMissingHost")}: ${a.hostId}`;
  return <section className="api-profiles provider-accounts" aria-label={t(locale, "accounts")}>
    <div className="agent-settings-heading"><p className="agent-settings-hint">{t(locale, "accountFixedHostNote")}</p><button className="agent-settings-button agent-settings-button--primary" type="button" disabled={busy || catalog.length >= 512} onClick={add}>{t(locale, "accountAdd")}</button></div>
    {catalog.length ? <div className="api-profiles__workspace">
      <div className="api-profiles__catalog"><label className="agent-settings-field"><span>{t(locale, "accounts")} <span className="agent-settings-count">{catalog.length}</span></span><input type="search" value={query} placeholder={t(locale, "accountSearch")} onChange={e => setQuery(e.target.value)} /></label><div className="api-profiles__list" aria-label={t(locale, "accounts")}>{filtered.map(a => <button className={`api-profiles__item${a.id === selected?.id ? " api-profiles__item--active" : ""}`} type="button" key={a.id} disabled={busy} aria-pressed={a.id === selected?.id} onClick={() => select(a.id)}><strong>{a.label}</strong><small>{PROVIDERS[a.provider].label} · {hostLabel(a)}</small><small>{rowStatus(a)}</small></button>)}{!filtered.length && <p className="agent-settings-hint">{t(locale, "accountNoResults")}</p>}</div></div>
      {draft && candidate && selected && <div className="api-profiles__editor" aria-label={t(locale, "accountName")}>
        <div className="agent-settings-heading"><h3 ref={heading} tabIndex={-1}>{selected.label}</h3>{dirty && <span className="agent-settings-hint">{t(locale, "connectionUnsaved")}</span>}</div>
        {!filtered.some(a => a.id === selected.id) && <p className="agent-settings-hint">{t(locale, "connectionHiddenSelection")} <button type="button" className="agent-settings-button" onClick={() => setQuery("")}>{t(locale, "connectionResetSearch")}</button></p>}
        {conflict && <p className="agent-settings-error" role="alert">{t(locale, "connectionConflict")} <button type="button" className="agent-settings-button" onClick={() => clearDraft(selected.id)}>{t(locale, "connectionReload")}</button></p>}
        <div className="agent-settings-grid">
          <label className="agent-settings-field"><span>{t(locale, "accountName")}</span><input required maxLength={80} disabled={busy} value={draft.value.label} aria-invalid={!draft.value.label.trim()} onChange={e => update({ label: e.target.value })} />{!draft.value.label.trim() && <small>{t(locale, "apiNameRequired")}</small>}</label>
          <label className="agent-settings-field"><span>{t(locale, "accountProvider")}</span><select disabled={busy} value={draft.value.provider} onChange={e => update({ provider: e.target.value as AgentProviderId })}>{AGENT_PROVIDERS.map(provider => <option key={provider} value={provider}>{PROVIDERS[provider].label}</option>)}</select></label>
          <label className="agent-settings-field"><span>{t(locale, "accountHost")}</span><select disabled={busy} value={draft.value.hostId ?? "local"} onChange={e => update({ hostId: e.target.value, bindingRequired: false })}><option value="local">{t(locale, "accountLocalHost")}</option>{settings.remoteHosts.map(host => <option key={host.id} value={host.id}>{host.label}</option>)}{draft.value.hostId && draft.value.hostId !== "local" && !settings.remoteHosts.some(h => h.id === draft.value.hostId) && <option value={draft.value.hostId}>{hostLabel(draft.value)}</option>}</select></label>
          <label className="agent-settings-field"><span>{t(locale, "accountBinding")}</span><select disabled={busy} value={draft.value.binding?.kind ?? "cli-home"} onChange={e => update({ binding: e.target.value === "cli-home" ? { kind: "cli-home", directory: "" } : { kind: "api-profile", profileId: "" }, bindingRequired: false })}><option value="cli-home">{t(locale, "accountCliHome")}</option><option value="api-profile">{t(locale, "accountApiBinding")}</option></select></label>
          {draft.value.binding?.kind === "api-profile" ? <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "accountApiBinding")}</span><select disabled={busy} value={draft.value.binding.profileId} onChange={e => update({ binding: { kind: "api-profile", profileId: e.target.value }, bindingRequired: false })}><option value="">{t(locale, "accountChooseApi")}</option>{settings.apiProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}{draft.value.binding.profileId && !settings.apiProfiles.some(p => p.id === (draft.value.binding as { profileId: string }).profileId) && <option value={draft.value.binding.profileId}>{draft.value.binding.profileId}</option>}</select></label>
            : <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "accountDirectory")}</span><input value={draft.value.binding?.directory ?? ""} maxLength={4096} disabled={busy} spellCheck={false} onChange={e => update({ binding: { kind: "cli-home", directory: e.target.value }, bindingRequired: false })} /></label>}
        </div>
        {draft.value.binding?.kind === "api-profile" ? <button className="agent-settings-button" type="button" onClick={onOpenApi}>{t(locale, "accountOpenApi")}</button> : <>
          <p className="agent-settings-hint">{t(locale, ACCOUNT_HOME_ENV[candidate.provider] ? "accountHomeNote" : "accountUnsupportedHome")}</p>
          {ACCOUNT_LOGIN_PROVIDERS.includes(candidate.provider) && <div className="account-login"><button className="agent-settings-button agent-settings-button--primary" type="button" disabled={busy || conflict} onClick={() => void run(login)}>{t(locale, "accountLoginInApp")}</button><p className="agent-settings-hint">{t(locale, "accountLoginNote")}</p></div>}
          {(candidate.hostId ?? "local") === "local" ? <div className="agent-settings-actions agent-settings-actions--start"><button className="agent-settings-button" type="button" disabled={busy} onClick={() => void run(() => inspect(true))}>{t(locale, "accountPickDirectory")}</button><button className="agent-settings-button" type="button" disabled={busy || !(candidate.binding?.kind === "cli-home" && candidate.binding.directory)} onClick={() => void run(() => inspect())}>{t(locale, "accountInspect")}</button></div> : <p className="agent-settings-hint">{t(locale, "accountRemoteHomeNote")}</p>}
        </>}
        <div className="connection-route-summary"><strong>{cap ? t(locale, "accountEffectiveClass").replace("{class}", cap) : t(locale, "accountNeedsReview")}</strong>{routeError && <p className="agent-settings-hint">{routeError}</p>}{candidate.assessmentInvalid && <p className="agent-settings-hint">{t(locale, "assessmentStale")}</p>}<p className="agent-settings-hint">{t(locale, "accountDefaultsNote")}</p>{count !== undefined && <p className="agent-settings-hint">{t(locale, "accountCapacity").replace("{count}", String(count)).replace("{limit}", String(settings.maxAccountsPerProviderPerHost))}</p>}</div>
        <details className="connection-assessment"><summary>{t(locale, "accountAdvanced")}</summary><div className="agent-settings-grid">
          <label className="agent-settings-field"><span>{t(locale, "accountTier")}</span><input maxLength={40} disabled={busy} value={draft.value.tier ?? ""} onChange={e => update({ tier: e.target.value })} /></label>
          <label className="agent-settings-field"><span>{t(locale, "accountModels")}</span><select disabled={busy} value={draft.modelsMode} onChange={e => replaceDraft({ ...draft, modelsMode: e.target.value as AccountDraft["modelsMode"] })}><option value="all">{t(locale, "accountAllModels")}</option><option value="list">{t(locale, "accountListedModels")}</option><option value="disabled">{t(locale, "accountDisabled")}</option></select></label>
          {draft.modelsMode === "list" && <label className="agent-settings-field agent-settings-field--wide"><span>{t(locale, "accountModelsList")}</span><textarea rows={3} disabled={busy} value={draft.modelText} onChange={e => replaceDraft({ ...draft, modelText: e.target.value })} /><small>{t(locale, "accountModelsNote")}</small></label>}
          <label className="agent-settings-field"><span>{t(locale, "accountClassCap")}</span><select disabled={busy} value={draft.value.maxDataClass ?? ""} onChange={e => update({ maxDataClass: (e.target.value || undefined) as DataClass | undefined })}><option value="">{t(locale, "accountNoCap")}</option>{DATA_CLASSES.map(c => <option key={c} value={c}>{t(locale, `dataClass${c}`)}</option>)}</select>{uncapped && <small>{t(locale, "accountClassCapNote").replace("{class}", uncapped)}</small>}</label>
        </div><label className="agent-settings-check"><input type="checkbox" disabled={busy} checked={draft.value.shared === true} onChange={e => update({ shared: e.target.checked })} /><span>{t(locale, "accountShared")}</span></label><p className="agent-settings-hint">{t(locale, "accountSharedNote")}</p></details>
        <DataHandlingAssessmentEditor locale={locale} value={draft.evidence} disabled={busy || conflict} onChange={evidence => replaceDraft({ ...draft, evidence })} onSave={() => void run(() => save(true))} />
        <p className="agent-settings-hint">{t(locale, "accountRemoveNote")}</p>
        <div className="agent-settings-actions"><button className="agent-settings-button agent-settings-button--danger" type="button" disabled={busy} onClick={() => void run(remove)}>{t(locale, "connectionRemove")}</button><button className="agent-settings-button" type="button" disabled={busy || !dirty} onClick={() => draft.origin ? clearDraft(selected.id) : void run(remove)}>{t(locale, "connectionDiscard")}</button><button className="agent-settings-button agent-settings-button--primary" type="button" disabled={busy || conflict || !dirty} onClick={() => void run(() => save())}>{t(locale, "accountSave")}</button></div>
      </div>}
    </div> : <p className="agent-settings-empty">{t(locale, "accountEmpty")}</p>}
    {error && <p className="agent-settings-error" role="alert">{error}</p>}<p className="agent-settings-notice" role="status">{busy ? t(locale, "connectionSaving") : notice}</p>
  </section>;
}
