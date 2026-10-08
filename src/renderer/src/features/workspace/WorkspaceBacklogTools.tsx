import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, LocaleId, SessionSnapshot } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import type { WorkspacePreset } from "../../../../shared/backlog";
import { backlogApi } from "./backlogRendererApi";
import type { WorkspaceLayoutMode } from "./workspaceLayout";
import { backlogText, type BacklogTextKey } from "./workspaceBacklogText";
import { useDialogFocus } from "./useDialogFocus";
import { downloadText } from "./workspaceDom";
import { clearDraftIfUnchanged, PendingOperation } from "./workspaceAsyncState";

interface WorkspaceBacklogToolsProps {
  sessions: readonly SessionSnapshot[];
  settings: AppSettings;
  locale: LocaleId;
  undoAvailable: boolean;
  broadcastEnabled: boolean;
  broadcastTargetCount: number;
  broadcastSending: boolean;
  onApplyLayout(mode: WorkspaceLayoutMode): void;
  onUndoLayout(): void;
  onSetBroadcastEnabled(enabled: boolean): void;
  onSendBroadcast(text: string): Promise<void>;
  onPersistSettings(patch: Partial<AppSettings>): Promise<void>;
  onClose(): void;
}

export function WorkspaceBacklogTools({
  sessions,
  settings,
  locale,
  undoAvailable,
  broadcastEnabled,
  broadcastTargetCount,
  broadcastSending,
  onApplyLayout,
  onUndoLayout,
  onSetBroadcastEnabled,
  onSendBroadcast,
  onPersistSettings,
  onClose
}: WorkspaceBacklogToolsProps): React.JSX.Element {
  const bt = (key: BacklogTextKey): string => backlogText(locale, key);
  const api = useMemo(() => backlogApi(), []);
  type PendingImport = { text: string; warnings: string[]; count: number; bypass: boolean; canvas: Partial<Pick<AppSettings, "canvasRegions" | "stickyNotes" | "browserCanvas">> };
  const [presets, setPresets] = useState<WorkspacePreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [confirmBypass, setConfirmBypass] = useState(false);
  const [broadcastText, setBroadcastText] = useState("");
  const broadcastSendOperation = useRef(new PendingOperation());
  const importOperation = useRef(new PendingOperation());
  const committedImports = useRef(new WeakSet<PendingImport>());
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, { onEscape: onClose, trapFocus: false });

  useEffect(() => {
    let alive = true;
    void api.workspacePresets().then((items) => { if (alive) setPresets(items); }).catch((reason: unknown) => {
      if (alive) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { alive = false; };
  }, [api]);

  const exportSnapshot = async (): Promise<string> => {
    const current = JSON.parse(await api.exportWorkspace()) as Record<string, unknown>;
    const canvas = {
      version: 1,
      canvasRegions: settings.canvasRegions,
      stickyNotes: settings.stickyNotes,
      browserCanvas: settings.browserCanvas
    };
    return api.redactText(JSON.stringify({ ...current, canvas }, null, 2));
  };

  const prepareImport = async (text: string): Promise<PendingImport> => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const result = await api.previewImport(text);
    const canvasCandidate = parsed.canvas && typeof parsed.canvas === "object"
      ? parsed.canvas as Record<string, unknown>
      : {};
    const canvas: PendingImport["canvas"] = {
      ...(Array.isArray(canvasCandidate.canvasRegions) ? { canvasRegions: canvasCandidate.canvasRegions as AppSettings["canvasRegions"] } : {}),
      ...(Array.isArray(canvasCandidate.stickyNotes) ? { stickyNotes: canvasCandidate.stickyNotes as AppSettings["stickyNotes"] } : {}),
      ...(canvasCandidate.browserCanvas === null || (canvasCandidate.browserCanvas && typeof canvasCandidate.browserCanvas === "object")
        ? { browserCanvas: canvasCandidate.browserCanvas as AppSettings["browserCanvas"] } : {})
    };
    return { text, warnings: result.warnings, count: result.count, bypass: containsBypassProfile(parsed), canvas };
  };

  const applyImport = async (pending: PendingImport, confirmBypass: boolean): Promise<void> => {
    if (committedImports.current.has(pending)) return;
    const operation = importOperation.current.begin();
    if (operation === null) return;
    try {
      await runOperation(async () => {
        const result = await api.importWorkspace(pending.text, { confirmBypass });
        // Session/task creation is already committed, even if saving canvas settings fails next.
        committedImports.current.add(pending);
        setPendingImport(current => current === pending ? null : current);
        setNotice([bt("importSessionsComplete"), ...result.warnings].join("\n"));
        if (Object.keys(pending.canvas).length > 0) await onPersistSettings(pending.canvas);
        setNotice([bt("importComplete"), ...result.warnings].join("\n"));
      });
    } finally {
      importOperation.current.finish(operation);
    }
  };

  const runOperation = async (action: () => Promise<void>, clearNotice = false): Promise<void> => {
    setLoading(true);
    setError("");
    if (clearNotice) setNotice("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };

  const reviewImportText = (text: string): Promise<void> => runOperation(async () => {
    setPendingImport(await prepareImport(text));
    setConfirmBypass(false);
  }, true);

  const downloadWorkspace = (): Promise<void> => runOperation(async () => {
    downloadText(await exportSnapshot(), `canvastty-workspace-${new Date().toISOString().slice(0, 10)}.json`, "application/json;charset=utf-8");
    setNotice(bt("snapshotExported"));
  });

  const beginImport = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try { await reviewImportText(await file.text()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const sendBroadcast = async (): Promise<void> => {
    const submitted = broadcastText;
    if (broadcastSending || !submitted.trim()) return;
    const operation = broadcastSendOperation.current.begin();
    if (operation === null) return;
    try {
      await onSendBroadcast(submitted);
      if (broadcastSendOperation.current.isCurrent(operation)) {
        setBroadcastText((current) => clearDraftIfUnchanged(current, submitted));
        setError("");
      }
    } catch (reason) {
      if (broadcastSendOperation.current.isCurrent(operation)) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      broadcastSendOperation.current.finish(operation);
    }
  };

  const confirmImport = async (): Promise<void> => {
    if (!pendingImport || (pendingImport.bypass && !confirmBypass)) return;
    await applyImport(pendingImport, confirmBypass);
  };

  const savePreset = async (): Promise<void> => {
    const title = name.trim().slice(0, 64);
    if (!title) return;
    await runOperation(async () => {
      const preset = await api.saveWorkspacePreset({
        id: crypto.randomUUID(),
        name: title,
        snapshot: await exportSnapshot()
      });
      setPresets((current) => [...current.filter((candidate) => candidate.id !== preset.id), preset]);
      setName("");
      setNotice(bt("presetSaved"));
    }, true);
  };

  const openPreset = async (preset: WorkspacePreset): Promise<void> => {
    let pending: PendingImport | undefined;
    await runOperation(async () => {
      pending = await prepareImport(preset.snapshot);
      setConfirmBypass(false);
      if (pending.bypass) setPendingImport(pending);
    }, true);
    if (pending && !pending.bypass) await applyImport(pending, false);
  };

  const removePreset = (id: string): Promise<void> => runOperation(async () => {
    await api.deleteWorkspacePreset(id);
    setPresets((current) => current.filter((preset) => preset.id !== id));
  });

  return (
    <section ref={dialogRef} className="workspace-tools" data-interactive="true" role="dialog" aria-label={bt("workspaceTools")} tabIndex={-1}>
      <header className="workspace-tools__header">
        <strong>{bt("workspaceTools")}</strong>
        <button type="button" aria-label={t(locale, "close")} onClick={onClose}>×</button>
      </header>
      <div className="workspace-tools__content">
        <fieldset className="workspace-tools__section">
          <legend>{bt("layout")}</legend>
          <div className="workspace-tools__layout-grid">
            {(["tree", "status", "project", "grid"] as const).map((mode) => (
              <button key={mode} type="button" disabled={loading} onClick={() => onApplyLayout(mode)}>
                {bt(layoutTextKey(mode))}
              </button>
            ))}
            <button type="button" disabled={!undoAvailable || loading} onClick={onUndoLayout}>{bt("undoLayout")}</button>
          </div>
        </fieldset>
        <fieldset className="workspace-tools__section">
          <legend>{bt("broadcast")}</legend>
          <label className="workspace-tools__check">
            <input type="checkbox" checked={broadcastEnabled} onChange={(event) => onSetBroadcastEnabled(event.target.checked)} />
            {bt("broadcastEnable")}
          </label>
          <small>{interpolate(bt("broadcastTargetCount"), { count: String(broadcastTargetCount) })}</small>
          {broadcastEnabled && <div className="workspace-tools__broadcast-form">
            <textarea value={broadcastText} rows={3} maxLength={4000} placeholder={bt("broadcastPlaceholder")}
              aria-label={bt("broadcastPlaceholder")} onChange={(event) => setBroadcastText(event.currentTarget.value)} />
            <button type="button" disabled={broadcastSending || !broadcastText.trim() || broadcastTargetCount === 0}
              onClick={() => void sendBroadcast()}>
              {broadcastSending ? t(locale, "loading") : bt("broadcastSend")}
            </button>
          </div>}
        </fieldset>
        <fieldset className="workspace-tools__section">
          <legend>{bt("snapshot")}</legend>
          <div className="workspace-tools__buttons">
            <button type="button" disabled={loading} onClick={() => void downloadWorkspace()}>{bt("exportSnapshot")}</button>
            <label className="workspace-tools__file">
              {loading ? t(locale, "loading") : bt("importSnapshot")}
              <input type="file" accept="application/json,.json" disabled={loading} onChange={(event) => {
                void beginImport(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }} />
            </label>
          </div>
          {pendingImport && (
            <div className="workspace-tools__confirm" role="group" aria-label={bt("confirmImport")}>
              <strong>{interpolate(bt("importPreview"), { count: String(pendingImport.count) })}</strong>
              {pendingImport.warnings.map((warning, index) => <p key={`${index}:${warning}`}>{warning}</p>)}
              {pendingImport.bypass && <label className="workspace-tools__check">
                <input type="checkbox" checked={confirmBypass} onChange={(event) => setConfirmBypass(event.target.checked)} />
                {bt("confirmBypass")}
              </label>}
              <div className="workspace-tools__buttons">
                <button type="button" disabled={loading || (pendingImport.bypass && !confirmBypass)} onClick={() => void confirmImport()}>{bt("confirmImport")}</button>
                <button type="button" disabled={loading} onClick={() => setPendingImport(null)}>{t(locale, "cancel")}</button>
              </div>
            </div>
          )}
        </fieldset>
        <fieldset className="workspace-tools__section">
          <legend>{bt("presets")}</legend>
          <div className="workspace-tools__save-preset">
            <input value={name} maxLength={64} placeholder={bt("presetName")} aria-label={bt("presetName")}
              onChange={(event) => setName(event.currentTarget.value)} />
            <button type="button" disabled={loading || !name.trim() || sessions.length === 0} onClick={() => void savePreset()}>{bt("savePreset")}</button>
          </div>
          <ul className="workspace-tools__presets">
            {presets.map((preset) => (
              <li key={preset.id}>
                <span title={preset.name}>{preset.name}</span>
                <button type="button" disabled={loading} onClick={() => void openPreset(preset)}>{bt("openPreset")}</button>
                <button type="button" disabled={loading} onClick={() => void removePreset(preset.id)} aria-label={`${bt("delete")} ${preset.name}`}>×</button>
              </li>
            ))}
            {presets.length === 0 && <li className="workspace-tools__empty">{bt("noPresets")}</li>}
          </ul>
        </fieldset>
        {notice && <p className="workspace-tools__notice" role="status">{notice}</p>}
        {error && <p className="workspace-tools__error" role="alert">{error}</p>}
      </div>
    </section>
  );
}

function containsBypassProfile(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsBypassProfile);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.profile === "yolo" || record.profile === "bypass") return true;
    return Object.values(record).some(containsBypassProfile);
  }
  return false;
}

function layoutTextKey(mode: WorkspaceLayoutMode): BacklogTextKey {
  return mode === "tree" ? "layoutTree" : mode === "status" ? "layoutStatus" : mode === "project" ? "layoutProject" : "layoutGrid";
}

function interpolate(value: string, replacements: Record<string, string>): string {
  return value.replace(/\{([a-z]+)\}/giu, (match, key: string) => replacements[key] ?? match);
}
