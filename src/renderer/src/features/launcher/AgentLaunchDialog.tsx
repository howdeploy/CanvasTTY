import { useEffect, useRef, useState } from "react";
import { ContainerRoutePreview } from "./ContainerRoutePreview";
import { LaunchContextFields } from './LaunchContextFields';
import { ACP_PROVIDERS, DATA_CLASSES, remotePathForHost } from "../../../../shared/contracts";
import { accountConfiguredForRuntime } from "../../../../shared/providerAccountPolicy";
import type { AgentProviderId, AgentLaunchOptions, AppSettings, DataClass } from "../../../../shared/contracts";
import type { SettingsLocation } from "../../../../shared/settingsLocation";
import { useDialogFocus } from "../../lib/useDialogFocus";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { PROVIDERS } from "../../lib/providers";
import { directoryPathFromClipboard } from "../../lib/directoryPathFromClipboard";
import { capsuleCaptureInput, compatibleLaunchAccounts, launchOptions, reconcileLaunchDraft, type LaunchDraft } from "./launchDraft";

interface AgentLaunchDialogProps {
  provider: AgentProviderId | null; settings: AppSettings; suspended?: boolean;
  onClose(): void; onAcknowledge(provider: AgentProviderId): Promise<void>;
  onLaunch(options: AgentLaunchOptions): Promise<void>; onOpenSettings(location: SettingsLocation): void;
}
export function AgentLaunchDialog({ provider, settings, suspended = false, onClose, onAcknowledge, onLaunch, onOpenSettings }: AgentLaunchDialogProps): React.JSX.Element | null {
  const [draft, setDraft] = useState<LaunchDraft | null>(null);
  const [confirmDanger, setConfirmDanger] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const locale = settings.locale;
  const ru = locale === 'ru';
  useEffect(() => { if (provider) opener.current = document.activeElement as HTMLElement | null; setDraft(current => reconcileLaunchDraft(current, provider, settings)); setConfirmDanger(false); setError(null); }, [provider]);
  useDialogFocus(dialog, !!provider && draft?.provider === provider && !suspended, { onEscape: () => { if (!busy) onClose(); }, restoreFocus: opener });
  if (!provider || !draft || draft.provider !== provider) return null;
  const update = (patch: Partial<LaunchDraft>): void => { setDraft({ ...draft, ...patch }); setError(null); };
  const { cwd, transport, profile, isolation, containerRoute, containerProfileId, accountId, model, ref, dataClass } = draft;
  const autoContainer = isolation === "container" && containerRoute === "auto";
  const profiles = settings.containerProfiles.filter(item => item.commands[provider]);
  const account = settings.providerAccounts.find(item => item.id === accountId);
  const accounts = compatibleLaunchAccounts(draft, settings);
  const configured = settings.providerAccounts.some(item => accountConfiguredForRuntime(item, provider));
  const hostId = account?.hostId ?? "local";
  const host = settings.remoteHosts.find(item => item.id === hostId);
  const hostLabel = hostId === "local" ? t(locale, "accountLocalHost") : host?.label ?? t(locale, "accountMissingHost");
  const mappedPath = host ? remotePathForHost(host, cwd) : null;
  const capsule = isolation === 'container' && !autoContainer ? draft.capsule : undefined;
  const captured = capsule?.prepared && capsule.capturedInput === capsuleCaptureInput(draft, settings) ? capsule.prepared : undefined;
  let routeError: string | null = null, routeRequest: AgentLaunchOptions | null = null;
  try { routeRequest = launchOptions(draft, settings); } catch (cause) { routeError = capsule && !captured ? (ru ? 'Подготовьте выбранные файлы и текст задачи перед запуском.' : 'Prepare the selected files and task before launching.') : cause instanceof Error ? cause.message : t(locale, "launchRepair"); }
  const acknowledged = settings.acknowledgedDangerousProfiles.includes(provider);
  const chooseDirectory = async (): Promise<void> => { const selected = await window.canvasTTY.dialog.pickDirectory(cwd); if (selected) update({ cwd: selected }); };
  const pasteDirectory = async (): Promise<void> => {
    try { const path = directoryPathFromClipboard(await window.canvasTTY.clipboard.readText()); if (!path) { setError(t(locale, "clipboardPathMissing")); return; } update({ cwd: path }); }
    catch { setError(t(locale, "clipboardReadFailed")); }
  };
  const selectFiles = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { const files = await window.canvasTTY.capsules.selectFiles(cwd); if (files) setDraft(current => current === draft ? { ...draft, capsule: { files, task: capsule?.task ?? '' } } : current); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const prepareCapsule = async (): Promise<void> => {
    if (!capsule) return; setBusy(true); setError(null);
    try {
      const prepared = await window.canvasTTY.capsules.prepare({ sourceCwd: cwd, files: capsule.files, task: { text: capsule.task, dataClass: dataClass || settings.defaultDataClass } });
      setDraft(current => current === draft ? { ...draft, capsule: { ...capsule, prepared, capturedInput: capsuleCaptureInput(draft, settings) } } : current);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const submit = async (): Promise<void> => {
    if (profile === "yolo" && !acknowledged && !confirmDanger) { setConfirmDanger(true); return; }
    setBusy(true); setError(null);
    try { const options = launchOptions(draft, settings); if (profile === "yolo" && !acknowledged) await onAcknowledge(provider); await onLaunch(options); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t(locale, "launchFailed")); } finally { setBusy(false); }
  };
  const openSettings = (location: SettingsLocation): void => { if (!busy) onOpenSettings(location); };
  return <div className="dialog-backdrop" hidden={suspended} inert={suspended} style={suspended ? { display: "none" } : undefined} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialog} className="launch-dialog" role="dialog" aria-modal="true" aria-label={`${t(locale, "launchAgent")}: ${PROVIDERS[provider].label}`}>
      <div className="launch-dialog__toolbar"><button className="launch-dialog__close" type="button" disabled={busy} onClick={onClose} aria-label={t(locale, "close")}><UiIcon name="close" size={18} /></button></div>
      <div className="launch-dialog__top"><div className="launch-dialog__provider"><ProviderIcon provider={provider} size="large" /></div><div className="folder-field">
        <button className="folder-field__picker" type="button" disabled={busy} onClick={() => void chooseDirectory()}><UiIcon name="folder" size={28} /><span className="folder-field__copy"><small>{t(locale, "projectFolder")}</small><strong title={cwd}>{cwd}</strong></span><UiIcon name="chevron" size={20} /></button>
        <button className="folder-field__paste" type="button" disabled={busy} onClick={() => void pasteDirectory()} title={t(locale, "pasteProjectPath")} aria-label={t(locale, "pasteProjectPath")}><UiIcon name="copy" size={20} /><span>{t(locale, "pastePath")}</span></button>
      </div></div>
      <fieldset className="launch-isolation execution-fields" disabled={busy}>
        {!capsule && <label className="launch-task">{ru ? 'Начальная задача, необязательно' : 'Initial task, optional'}<textarea value={draft.initialPrompt ?? ''} rows={3} maxLength={60000} onChange={event => update({ initialPrompt: event.target.value })} /><span className="launch-task__hint">{ru ? 'Текст отправляется один раз. Для свободного текста требуется доступ не ниже D2. Без задачи откроется интерактивная сессия.' : 'Sent once. Free-form text requires D2 access or higher. Leave blank to open an interactive session.'}</span></label>}
        <label>{t(locale, "launchAccount")}<select value={accountId} aria-invalid={!!routeError} aria-describedby="launch-route-error" onChange={event => update({ accountId: event.target.value })}><option value="">{autoContainer ? (ru ? "Любой подходящий API аккаунт" : "Any eligible API account") : t(locale, configured ? "launchChooseAccount" : "launchAmbient")}</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.label} · {(item.hostId ?? "local") === "local" ? t(locale, "accountLocalHost") : settings.remoteHosts.find(h => h.id === item.hostId)?.label ?? t(locale, "accountMissingHost")}</option>)}{accountId && !accounts.some(item => item.id === accountId) && <option value={accountId}>{account?.label ?? accountId} · {t(locale, "launchRepair")}</option>}</select></label>
        <label>{t(locale, "launchModel")}<input value={model} maxLength={100} onChange={event => update({ model: event.target.value })} /></label>
        <label>{t(locale, "launchHost")}<select value={autoContainer ? "auto" : hostId} disabled aria-describedby="launch-fixed-host"><option value={autoContainer ? "auto" : hostId}>{autoContainer ? (ru ? "Выбор при запуске" : "Selected at launch") : hostLabel}</option></select></label>
        <p id="launch-fixed-host">{autoContainer ? (ru ? "Каждый аккаунт остаётся на своём компьютере." : "Each account stays on its own computer.") : t(locale, "launchFixedHost")}</p>
        <label>{capsule ? (ru ? 'Класс текста задачи' : 'Task text data class') : t(locale, "launchClass")}<select value={dataClass} onChange={event => update({ dataClass: event.target.value as DataClass | "" })}><option value="">{t(locale, "launchClassDefault")} · {t(locale, `dataClass${settings.defaultDataClass}`)}</option>{DATA_CLASSES.map(c => <option key={c} value={c}>{t(locale, `dataClass${c}`)}</option>)}</select></label>
        <label>{t(locale, "isolationMode")}<select value={isolation} onChange={event => update({ isolation: event.target.value as LaunchDraft["isolation"] })}><option value="direct">{t(locale, "isolationDirect")}</option><option value="worktree">{t(locale, "isolationWorktree")}</option><option value="container">{t(locale, "containers")}</option></select></label>
        {isolation === "container" && <label>{ru ? "Выбор контейнера" : "Container selection"}<select value={containerRoute} onChange={event => update({ containerRoute: event.target.value as LaunchDraft["containerRoute"], ...(event.target.value === "auto" ? { capsule: undefined } : {}) })}><option value="fixed">{ru ? "Конкретный профиль" : "Specific profile"}</option><option value="auto">{ru ? "Автоматически по нагрузке" : "Automatically by load"}</option></select></label>}
        {isolation === "container" && !autoContainer && <><label>{t(locale, "containers")}<select value={containerProfileId} onChange={event => update({ containerProfileId: event.target.value })}><option value="">—</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.label} · {item.hostId === "local" ? t(locale, "accountLocalHost") : settings.remoteHosts.find(h => h.id === item.hostId)?.label ?? t(locale, "accountMissingHost")}</option>)}{containerProfileId && !profiles.some(p => p.id === containerProfileId) && <option value={containerProfileId}>{t(locale, "launchRepair")}</option>}</select></label><p>{t(locale, "launchContainerNote")}</p></>}
        {isolation === 'container' && !autoContainer && ['opencode', 'omp', 'minimax'].includes(provider) && <div className="capsule-launch">
          <label>{ru ? 'Доступные агенту файлы' : 'Files available to the agent'}<select value={capsule ? 'selected' : 'worktree'} onChange={event => update({ capsule: event.target.value === 'selected' ? { files: [], task: '' } : undefined })}><option value="worktree">{ru ? 'Весь Git worktree' : 'Full Git worktree'}</option><option value="selected">{ru ? 'Только выбранные файлы (капсула)' : 'Selected files only (capsule)'}</option></select></label>
          {capsule && <>
            <p>{ru ? 'Локальный контейнер получит текущие копии выбранных файлов и Task.md. Класс файлов определяется правилами проекта; результат можно проверить и применить в разделе «Рабочие копии».' : 'The local container receives current copies of selected files and Task.md. Project rules classify files; review and apply output under Workspaces.'}</p>
            <button className="agent-settings-button" type="button" onClick={() => void selectFiles()}>{ru ? 'Выбрать файлы' : 'Select files'}{capsule.files.length ? ` · ${capsule.files.length}` : ''}</button>
            {capsule.files.length > 0 && <ul className="capsule-launch__files">{capsule.files.map(file => <li key={file}>{file}</li>)}</ul>}
            <label>{ru ? 'Задача для агента · Task.md' : 'Agent task · Task.md'}<textarea value={capsule.task} maxLength={65536} rows={5} onChange={event => update({ capsule: { ...capsule, task: event.target.value } })} /></label>
            <button className="agent-settings-button" type="button" disabled={!capsule.files.length || !capsule.task.trim()} onClick={() => void prepareCapsule()}>{ru ? 'Подготовить выбранные файлы' : 'Prepare selected files'}</button>
            {captured && <p role="status"><strong>{ru ? 'Готово' : 'Ready'} · {captured.dataClass} · {captured.files.length} {ru ? 'файлов' : 'files'} · {(captured.capturedBytes / 1024).toFixed(1)} KiB</strong></p>}
          </>}
        </div>}
        {isolation === "worktree" && <><label>{t(locale, "worktreeBase")}<input value={ref} maxLength={256} onChange={event => update({ ref: event.target.value })} /></label><p>{t(locale, "worktreeExplanation")}</p></>}
        {ACP_PROVIDERS.includes(provider) && <details className="connection-assessment"><summary>{t(locale, "launchTransport")}: {transport.toUpperCase()}</summary><label>{t(locale, "launchTransport")}<select value={transport} onChange={event => update({ transport: event.target.value as "pty" | "acp" })}><option value="pty">PTY</option><option value="acp">ACP</option></select></label>{transport === "acp" && <p>{t(locale, "launchAcpNote")}</p>}</details>}
      </fieldset>
      <div className="launch-delegation">
        <label><input type="checkbox" checked={draft.allowSubagents ?? false} disabled={busy} onChange={event => update({ allowSubagents: event.target.checked })} /><span>{ru ? 'Разрешить запуск субагентов' : 'Allow launching subagents'}</span></label>
        <p>{ru ? 'Агент сможет запускать дочерние сессии в пределах правил и лимитов; возможна дополнительная оплата. Доступ к браузеру не требуется.' : 'The agent may launch child sessions within your rules and limits; additional usage may be billed. Browser access is separate.'}</p>
        <details><summary>{ru ? 'Поддерживаемые режимы' : 'Supported modes'}</summary><p>{ru ? 'Локально, напрямую или в worktree. PTY: Claude, Codex, Qwen, OpenCode, Hermes и Kimi; ACP: Cursor, MiniMax и Kimi при поддержке MCP установленным агентом. PTY с отдельным домашним каталогом Hermes/Kimi, удалённые и контейнерные родительские сессии не поддерживаются. Делегировать капсулы выбранных файлов может только локальный родитель в прямом режиме.' : 'Local direct or worktree. PTY: Claude, Codex, Qwen, OpenCode, Hermes and Kimi; ACP: Cursor, MiniMax and Kimi when the installed agent accepts MCP. Custom Hermes/Kimi account homes in PTY, remote and container parents are unsupported. Selected-file capsule delegation requires a local direct parent.'}</p></details>
      </div>
      <LaunchContextFields draft={draft} settings={settings} request={routeRequest} active={!suspended} busy={busy} update={update} openSettings={() => openSettings({ section: 'context' })} />
      <div className="launch-route-summary"><strong>{account?.label ?? (autoContainer ? (ru ? "Любой подходящий API аккаунт" : "Any eligible API account") : t(locale, configured ? "launchChooseAccount" : "launchAmbient"))} · {autoContainer ? (ru ? "Выбор компьютера при запуске" : "Computer selected at launch") : hostLabel} · {routeRequest?.dataClass || captured?.dataClass || dataClass || settings.defaultDataClass} · {t(locale, isolation === "direct" ? "isolationDirect" : isolation === "worktree" ? "isolationWorktree" : "containers")}</strong>{!autoContainer && hostId !== "local" && <p>{t(locale, "launchExecutionPath")}: {mappedPath ?? t(locale, "launchNoMapping")}</p>}<p>{t(locale, "launchPolicyNote")}</p><p id="launch-route-error" className="agent-settings-error" role={routeError ? "alert" : undefined}>{routeError}</p></div>
      {autoContainer && <ContainerRoutePreview request={routeRequest} settings={settings} active={!suspended} disabled={busy} />}
      <div className="agent-settings-actions"><button className="agent-settings-button" type="button" disabled={busy} onClick={() => openSettings({ section: "connections", view: "accounts", ...(accountId ? { recordId: accountId } : {}) })}>{t(locale, "launchSettings")}</button>{hostId !== "local" && <button className="agent-settings-button" type="button" disabled={busy} onClick={() => openSettings({ section: "execution", view: "hosts", recordId: hostId })}>{t(locale, "launchHostSettings")}</button>}{isolation === "container" && <button className="agent-settings-button" type="button" disabled={busy} onClick={() => openSettings({ section: "execution", view: "containers", ...(!autoContainer && containerProfileId ? { recordId: containerProfileId } : {}) })}>{t(locale, "launchContainerSettings")}</button>}</div>
      <div className="profile-row"><button className={profile === "normal" ? "profile-button profile-button--active" : "profile-button"} disabled={busy} type="button" onClick={() => { update({ profile: "normal" }); setConfirmDanger(false); }}>{t(locale, "normal")}</button><button className={profile === "yolo" ? "profile-button profile-button--active" : "profile-button"} disabled={busy} type="button" onClick={() => { update({ profile: "yolo" }); setConfirmDanger(false); }}>{t(locale, "yolo")}</button><button className="launch-submit" type="button" aria-label={t(locale, "launchAgent")} disabled={busy || !!routeError} onClick={() => void submit()}>{busy ? <span className="launch-submit__busy" /> : <UiIcon name="arrow" size={38} />}</button></div>
      {profile === "yolo" && <div className={`danger-note ${confirmDanger ? "danger-note--confirm" : ""}`}><strong>{t(locale, PROVIDERS[provider].dangerKey!)}</strong>{!acknowledged && <span>{confirmDanger ? t(locale, "dangerousFirstUse") : t(locale, "confirmLaunch")}</span>}</div>}
      {error && <div className="dialog-error" role="alert">{error}</div>}
    </section>
  </div>;
}
