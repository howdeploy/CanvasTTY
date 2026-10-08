import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentProviderId,
  AppSettings,
  LaunchProfileId,
  LaunchRole,
  PluginLaunchValues,
  ProviderId,
  SessionEnvironmentChoice
} from "../../../../shared/contracts";
import { ProviderIcon } from "../../components/ProviderIcon";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { PROVIDERS } from "../../lib/providers";
import { directoryPathFromClipboard } from "../../lib/directoryPathFromClipboard";
import { LaunchOptionsSection } from "./LaunchOptionsSection";
import {
  autoKind,
  availableProfiles,
  BYPASS_CHANGES_NOTHING,
  isolationAvailable,
  resolveDefaultLaunchProfile
} from "../../../../shared/autoMode";
import type { TranslationKey } from "../../lib/i18n";
import { backlogApi } from "../workspace/backlogRendererApi";

/** The mode the launcher starts in for this CLI: the person's default, else the next one the CLI has. */
export function initialProfile(provider: ProviderId, settings: AppSettings, platform: string): LaunchProfileId {
  return resolveDefaultLaunchProfile(provider, settings, isolationAvailable(settings, platform));
}

const PROFILE_LABEL: Record<LaunchProfileId, TranslationKey> = {
  auto: "autoProfile", normal: "manualProfile", acceptEdits: "acceptEditsProfile", plan: "planProfile", yolo: "bypassProfile"
};

/** What the chosen mode does for this CLI, honestly per CLI. */
export function profileNoteKey(provider: ProviderId, profile: LaunchProfileId): TranslationKey | null {
  if (profile === "auto") {
    const kind = autoKind(provider);
    if (provider === "grok") return "autoNoteGrok";
    return kind === "native" ? "autoNoteNative" : kind === "config" ? "autoNoteOpenCode" : kind === "contained" ? "autoNoteContained" : null;
  }
  if (profile === "acceptEdits") return "acceptEditsNote";
  if (profile === "plan") return provider === "codex" ? "planNoteCodex" : "planNote";
  if (profile === "normal") return "manualNote";
  return null;
}

interface AgentLaunchDialogProps {
  /** "terminal" opens it only while a plugin environment applies to terminals (folder and Where). */
  provider: ProviderId | null;
  settings: AppSettings;
  onClose(): void;
  onAcknowledge(provider: AgentProviderId): Promise<void>;
  /** Persists `agentControlEnabled: true`; only ever called from the explicit button. */
  onEnableAgentControl(): Promise<void>;
  onLaunch(
    provider: ProviderId,
    profile: LaunchProfileId,
    cwd: string,
    role: LaunchRole,
    launchOptions?: Record<string, PluginLaunchValues>,
    environment?: SessionEnvironmentChoice,
    initialPrompt?: string
  ): Promise<void>;
}

export function AgentLaunchDialog({
  provider,
  settings,
  onClose,
  onAcknowledge,
  onEnableAgentControl,
  onLaunch
}: AgentLaunchDialogProps): React.JSX.Element | null {
  const platform = window.canvasTTY?.window?.platform ?? "";
  const [profile, setProfile] = useState<LaunchProfileId>(provider ? initialProfile(provider, settings, platform) : "normal");
  const [role, setRole] = useState<LaunchRole>("agent");
  const [cwd, setCwd] = useState(settings.lastDirectory);
  const [confirmDanger, setConfirmDanger] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchOptions, setLaunchOptions] = useState<Record<string, PluginLaunchValues>>({});
  const changeLaunchOptions = useCallback((options: Record<string, PluginLaunchValues>) => setLaunchOptions(options), []);
  const [environment, setEnvironment] = useState<SessionEnvironmentChoice | null>(null);
  const [flowId, setFlowId] = useState("");
  const [flowTask, setFlowTask] = useState("");
  const [flows, setFlows] = useState<Array<Awaited<ReturnType<ReturnType<typeof backlogApi>["flows"]>>["templates"][number]>>([]);
  const [flowErrors, setFlowErrors] = useState<Array<{ file: string; line: number; message: string }>>([]);
  const [flowLoading, setFlowLoading] = useState(false);
  const [flowRefresh, setFlowRefresh] = useState(0);
  const [flowPreview, setFlowPreview] = useState<{projectRoot:string;flowId:string;instructions:string;digest:string|null} | null>(null);
  const backlog = useMemo(() => backlogApi(), []);
  const changeEnvironment = useCallback((choice: SessionEnvironmentChoice | null) => setEnvironment(choice), []);
  const locale = settings.locale;

  useEffect(() => {
    if (!provider) return;
    setProfile(initialProfile(provider, settings, platform));
    setRole("agent");
    setFlowId("");
    setFlowTask("");
    setFlows([]);
    setFlowErrors([]);
    setCwd(settings.lastDirectory);
    setConfirmDanger(false);
    setError(null);
  }, [provider, settings.lastDirectory]);

  useEffect(() => {
    if (!provider || provider === "terminal") return;
    let alive = true;
    setFlowLoading(true);
    void backlog.flows(cwd).then((result) => {
      if (!alive) return;
      setFlows(result.templates);
      setFlowErrors(result.errors);
      setFlowId((current) => current && !result.templates.some((flow) => flow.id === current) ? "" : current);
    }).catch((reason: unknown) => {
      if (!alive) return;
      setFlows([]);
      setFlowErrors([{ file: "flows", line: 0, message: reason instanceof Error ? reason.message : String(reason) }]);
    }).finally(() => { if (alive) setFlowLoading(false); });
    return () => { alive = false; };
  }, [backlog, cwd, flowRefresh, provider]);

  const selectedFlow = flows.find(flow => flow.id === flowId);
  useEffect(() => {
    setFlowPreview(null);
    if (!flowId || selectedFlow?.trusted === true) return;
    let alive = true;
    void backlog.previewFlow(cwd, flowId).then(preview => {
      if (alive) setFlowPreview({ ...preview, projectRoot: cwd, flowId });
    }).catch((reason: unknown) => {
      if (alive) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { alive = false; };
  }, [backlog, cwd, flowId, selectedFlow?.digest, selectedFlow?.trusted]);

  const approveFlow = async (): Promise<void> => {
    if (!flowPreview?.digest || flowPreview.projectRoot !== cwd || flowPreview.flowId !== flowId) return;
    setBusy(true);
    try {
      await backlog.approveFlow(cwd, flowId, flowPreview.digest);
      setFlowRefresh(value => value + 1);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!provider) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [provider, onClose]);

  if (!provider) return null;

  const isTerminal = provider === "terminal";
  const acknowledged = isTerminal || settings.acknowledgedDangerousProfiles.includes(provider);
  const dangerKey = PROVIDERS[provider].dangerKey ?? "confirmLaunch";
  // An orchestrator without the endpoint would be a plain session with a
  // misleading badge, so the launch waits for the explicit enable button.
  const endpointMissing = (role === "orchestrator" || Boolean(flowId)) && !settings.agentControlEnabled;

  const enableEndpoint = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onEnableAgentControl();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "settingsFailed"));
    } finally {
      setBusy(false);
    }
  };

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
    if (endpointMissing) return;
    if (flowId && !flowTask.trim()) {
      setError(locale === "ru" ? "Опишите задачу для рабочего процесса." : "Describe the task for this workflow.");
      return;
    }
    if (profile === "yolo" && !acknowledged && !confirmDanger) {
      setConfirmDanger(true);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (profile === "yolo" && !acknowledged && !isTerminal) await onAcknowledge(provider);
      const initialPrompt = flowId
        ? await backlog.redactText((await backlog.flowInstructions(cwd, flowId)).split("{{TASK}}").join(flowTask))
        : undefined;
      await onLaunch(provider, profile, cwd, flowId ? "orchestrator" : role, Object.keys(launchOptions).length > 0 ? launchOptions : undefined,
        environment ?? undefined, initialPrompt);
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
      <section className="launch-dialog" role="dialog" aria-modal="true" aria-label={isTerminal ? t(locale, "launchTerminal") : `${t(locale, "launchAgent")}: ${PROVIDERS[provider].label}`}>
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

        {!isTerminal && <div className="role-row" role="group" aria-label={t(locale, "launchRole")}>
          <button className={role === "agent" && !flowId ? "profile-button profile-button--active" : "profile-button"} type="button"
            aria-pressed={role === "agent" && !flowId} disabled={Boolean(flowId)} onClick={() => setRole("agent")}>{t(locale, "roleAgent")}</button>
          <button className={role === "orchestrator" ? "profile-button profile-button--active" : "profile-button"} type="button" aria-pressed={role === "orchestrator"} onClick={() => setRole("orchestrator")}>{t(locale, "roleOrchestrator")}</button>
        </div>}

        {!isTerminal && <section className="launch-flow-picker" aria-label={locale === "ru" ? "Шаблон рабочего процесса" : "Workflow template"}>
          <label htmlFor="launch-flow-select">{locale === "ru" ? "Рабочий процесс" : "Workflow"}</label>
          <div className="launch-flow-picker__row">
            <select id="launch-flow-select" value={flowId} disabled={flowLoading || flows.length === 0}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setFlowId(next);
                if (next) setRole("orchestrator");
              }}>
              <option value="">{flowLoading ? t(locale, "loading") : locale === "ru" ? "Без шаблона" : "No template"}</option>
              {flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name} · {flow.expectedSubagents}</option>)}
            </select>
            <button type="button" disabled={flowLoading} onClick={() => setFlowRefresh((value) => value + 1)}
              aria-label={locale === "ru" ? "Обновить шаблоны" : "Refresh templates"}>↻</button>
          </div>
          {flowId && <>
            <label htmlFor="launch-flow-task">{locale === "ru" ? "Задача" : "Task"}</label>
            <textarea id="launch-flow-task" className="launch-flow-picker__task" rows={3} required
              value={flowTask} disabled={busy} onChange={(event) => setFlowTask(event.currentTarget.value)}
              placeholder={locale === "ru" ? "Что должен сделать этот рабочий процесс?" : "What should this workflow accomplish?"} />
          </>}
          {flowId && <small>{locale === "ru" ? "Ожидается подагентов" : "Expected subagents"}: {flows.find((flow) => flow.id === flowId)?.expectedSubagents ?? 0}</small>}
          {flowId && selectedFlow?.trusted !== true && <div className="launch-flow-picker__approval">
            <p>{locale === "ru" ? "Просмотрите инструкции из файла проекта перед их использованием. Изменённые инструкции потребуют нового одобрения." : "Review the project file's instructions before using them. Changed instructions require approval again."}</p>
            {flowPreview && <pre style={{maxHeight:240,overflow:"auto",whiteSpace:"pre-wrap"}}>{flowPreview.instructions}</pre>}
            <button type="button" disabled={busy || !flowPreview?.digest} onClick={() => void approveFlow()}>
              {locale === "ru" ? "Одобрить эти инструкции" : "Approve these instructions"}
            </button>
          </div>}
          {flowErrors.length > 0 && <ul className="launch-flow-picker__errors" role="status">
            {flowErrors.map((issue, index) => <li key={`${issue.file}:${issue.line}:${index}`}>
              {issue.file}{issue.line > 0 ? `:${issue.line}` : ""}: {issue.message}
            </li>)}
          </ul>}
        </section>}

        <div className="profile-row">
          {!isTerminal && availableProfiles(provider, isolationAvailable(settings, platform)).map((mode) => (
            <button key={mode} className={profile === mode ? "profile-button profile-button--active" : "profile-button"} type="button"
              aria-pressed={profile === mode} onClick={() => {
                setProfile(mode);
                setConfirmDanger(false);
              }}>{t(locale, PROFILE_LABEL[mode])}</button>
          ))}
          <button className="launch-submit" type="button" disabled={busy || endpointMissing || Boolean(flowId && (selectedFlow?.trusted !== true || !flowTask.trim()))} onClick={() => void submit()}>
            {busy ? <span className="launch-submit__busy" /> : <UiIcon name="arrow" size={38} />}
          </button>
        </div>

        {role === "orchestrator" && (
          <div className={`role-note ${endpointMissing ? "role-note--off" : ""}`}>
            <span>{t(locale, "orchestratorRoleNote")}</span>
            {endpointMissing && (
              <>
                <strong>{t(locale, "orchestratorEndpointOff")}</strong>
                <button className="role-note__enable" type="button" disabled={busy} onClick={() => void enableEndpoint()}>
                  {t(locale, "enableAgentControl")}
                </button>
              </>
            )}
          </div>
        )}

        <LaunchOptionsSection provider={provider} locale={locale} onChange={changeLaunchOptions} onEnvironmentChange={changeEnvironment} />

        {!isTerminal && profileNoteKey(provider, profile) && (
          <div className="role-note">
            <span>{t(locale, profileNoteKey(provider, profile)!)}</span>
            {profile !== "normal" && <span>{t(locale, isolationAvailable(settings, platform) ? "isolationNoteOn" : "isolationNoteOff")}</span>}
          </div>
        )}
        {profile === "yolo" && (
          <div className={`danger-note ${confirmDanger ? "danger-note--confirm" : ""}`}>
            <strong>{t(locale, BYPASS_CHANGES_NOTHING.has(provider) ? "bypassChangesNothing" : dangerKey)}</strong>
            {!BYPASS_CHANGES_NOTHING.has(provider) && <span>{t(locale, isolationAvailable(settings, platform) ? "bypassInsideIsolation" : "bypassWithoutIsolation")}</span>}
            {!acknowledged && <span>{confirmDanger ? t(locale, "dangerousFirstUse") : t(locale, "confirmLaunch")}</span>}
          </div>
        )}
        {error && <div className="dialog-error">{error}</div>}
      </section>
    </div>
  );
}
