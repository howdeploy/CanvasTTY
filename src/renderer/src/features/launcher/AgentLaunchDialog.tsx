import { accountSupportsRuntime } from "../../../../shared/providerAccountPolicy";
import { useEffect, useState } from "react";
import type {
  AgentProviderId,
  AgentLaunchOptions,
  AppSettings,
  LaunchProfileId
} from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { PROVIDERS } from "../../lib/providers";
import { directoryPathFromClipboard } from "../../lib/directoryPathFromClipboard";

interface AgentLaunchDialogProps {
  provider: AgentProviderId | null;
  settings: AppSettings;
  onClose(): void;
  onAcknowledge(provider: AgentProviderId): Promise<void>;
  onLaunch(options: AgentLaunchOptions): Promise<void>;
}

export function AgentLaunchDialog({
  provider,
  settings,
  onClose,
  onAcknowledge,
  onLaunch
}: AgentLaunchDialogProps): React.JSX.Element | null {
  const [profile, setProfile] = useState<LaunchProfileId>("normal");
  const [isolation, setIsolation] = useState<"direct" | "worktree" | "container">("direct");
  const [containerProfileId, setContainerProfileId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const [ref, setRef] = useState("HEAD");
  const [cwd, setCwd] = useState(settings.lastDirectory);
  const [confirmDanger, setConfirmDanger] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locale = settings.locale;

  useEffect(() => {
    if (!provider) return;
    setProfile("normal");
    setIsolation(settings.requiresSandboxProfiles?.includes("normal") ? "worktree" : "direct");
    setRef("HEAD"); setContainerProfileId(""); setAccountId(""); setModel("");
    setCwd(settings.lastDirectory);
    setConfirmDanger(false);
    setError(null);
  }, [provider, settings.lastDirectory]);

  useEffect(() => {
    if (!provider) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [provider, onClose]);

  if (!provider) return null;

  const containerProfiles = (settings.containerProfiles ?? []).filter(p => p.commands[provider]);
  const containerProfile = containerProfiles.find(p => p.id === containerProfileId);
  const containerAccounts = isolation === 'container' ? settings.providerAccounts.filter(a => {
    if (a.binding?.kind !== 'api-profile' || (a.hostId ?? 'local') !== (containerProfile?.hostId ?? 'local')) return false;
    try { return accountSupportsRuntime(a, provider, settings.apiProfiles); } catch { return false; }
  }) : [];
  const acknowledged = settings.acknowledgedDangerousProfiles.includes(provider);
  const dangerKey = PROVIDERS[provider].dangerKey!;

  const chooseDirectory = async (): Promise<void> => {
    const selected = await window.canvasTTY.dialog.pickDirectory(cwd);
    if (selected) {
      setCwd(selected);
      setError(null);
    }
  };

  const pasteDirectory = async (): Promise<void> => {
    try {
      const path = directoryPathFromClipboard(await window.canvasTTY.clipboard.readText());
      if (!path) {
        setError(t(locale, "clipboardPathMissing"));
        return;
      }
      setCwd(path);
      setError(null);
    } catch {
      setError(t(locale, "clipboardReadFailed"));
    }
  };

  const submit = async (): Promise<void> => {
    if (profile === "yolo" && !acknowledged && !confirmDanger) {
      setConfirmDanger(true);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (profile === "yolo" && !acknowledged) await onAcknowledge(provider);
      if (isolation === 'container' && (!containerProfile || !accountId)) throw new Error(locale === 'ru' ? 'Выберите профиль контейнера и API-аккаунт.' : 'Select a container profile and API account.');
      await onLaunch({ provider, profile, cwd, ...(isolation === 'container' ? { accountId, ...(model.trim() ? { model: model.trim() } : {}), ...(containerProfile?.hostId !== 'local' ? { hostId: containerProfile?.hostId } : {}) } : {}), isolation: isolation === 'container' ? { mode: 'container', profileId: containerProfileId } : isolation === "worktree" ? { mode: "worktree", ref: ref.trim() || "HEAD" } : { mode: "direct" } });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "launchFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="launch-dialog" role="dialog" aria-modal="true" aria-label={`${t(locale, "launchAgent")}: ${PROVIDERS[provider].label}`}>
        <div className="launch-dialog__toolbar">
          <button className="launch-dialog__close" type="button" onClick={onClose} aria-label={t(locale, "close")}><UiIcon name="close" size={18} /></button>
        </div>

        <div className="launch-dialog__top">
          <div className="launch-dialog__provider"><ProviderIcon provider={provider} size="large" /></div>
          <div className="folder-field">
            <button className="folder-field__picker" type="button" onClick={() => void chooseDirectory()}>
              <UiIcon name="folder" size={28} />
              <span className="folder-field__copy">
                <small>{t(locale, "projectFolder")}</small>
                <strong title={cwd}>{cwd}</strong>
              </span>
              <UiIcon name="chevron" size={20} />
            </button>
            <button className="folder-field__paste" type="button" onClick={() => void pasteDirectory()} title={t(locale, "pasteProjectPath")} aria-label={t(locale, "pasteProjectPath")}>
              <UiIcon name="copy" size={20} />
              <span>{t(locale, "pastePath")}</span>
            </button>
          </div>
        </div>

        <div className="launch-isolation">
          <label>{t(locale, "isolationMode")}<select value={isolation} onChange={event => setIsolation(event.target.value as "direct" | "worktree" | "container")}>
            <option value="direct">{t(locale, "isolationDirect")}</option><option value="worktree">{t(locale, "isolationWorktree")}</option><option value="container">{locale === 'ru' ? 'Контейнер' : 'Container'}</option>
          </select></label>
          {isolation === 'container' && <>
            <label>{locale === 'ru' ? 'Профиль контейнера' : 'Container profile'}<select value={containerProfileId} onChange={e => { setContainerProfileId(e.target.value); setAccountId(''); }}><option value="">—</option>{containerProfiles.map(p => <option key={p.id} value={p.id}>{p.label} · {p.hostId} · {p.network}</option>)}</select></label>
            <label>{locale === 'ru' ? 'API-аккаунт' : 'API account'}<select value={accountId} onChange={e => setAccountId(e.target.value)}><option value="">—</option>{containerAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
            {containerAccounts.length === 0 && <p role="status">{locale === 'ru' ? 'Для этого сервера нет совместимых API-аккаунтов. Проверьте их привязки в настройках.' : 'No compatible API accounts for this host. Check their bindings in settings.'}</p>}
            <label>{locale === 'ru' ? 'Модель (пусто: из API-профиля)' : 'Model (blank: API profile default)'}<input value={model} maxLength={200} onChange={e => setModel(e.target.value)} /></label>
            <p>{locale === 'ru' ? 'Контейнер получает полный checkout из Git. Bridge разрешает исходящий интернет. Native OAuth и remote BYOK пока недоступны.' : 'Container receives the full Git checkout. Bridge permits outbound internet. Native OAuth and remote BYOK are unavailable.'}</p>
          </>}
          {isolation === "worktree" && <><label>{t(locale, "worktreeBase")}<input value={ref} maxLength={256} onChange={event => setRef(event.target.value)} /></label><p>{t(locale, "worktreeExplanation")}</p></>}
          {settings.requiresSandboxProfiles?.includes(profile) && <p>{t(locale, "isolationRequired")}</p>}
        </div>
        <div className="profile-row">
          <button className={profile === "normal" ? "profile-button profile-button--active" : "profile-button"} type="button" onClick={() => {
            setProfile("normal");
            setConfirmDanger(false);
          }}>{t(locale, "normal")}</button>
          <button className={profile === "yolo" ? "profile-button profile-button--active" : "profile-button"} type="button" onClick={() => {
            setProfile("yolo");
            setConfirmDanger(false);
          }}>{t(locale, "yolo")}</button>
          <button className="launch-submit" type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? <span className="launch-submit__busy" /> : <UiIcon name="arrow" size={38} />}
          </button>
        </div>

        {profile === "yolo" && (
          <div className={`danger-note ${confirmDanger ? "danger-note--confirm" : ""}`}>
            <strong>{t(locale, dangerKey)}</strong>
            {!acknowledged && <span>{confirmDanger ? t(locale, "dangerousFirstUse") : t(locale, "confirmLaunch")}</span>}
          </div>
        )}
        {error && <div className="dialog-error" role="alert">{error}</div>}
      </section>
    </div>
  );
}
