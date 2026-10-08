import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocaleId, SessionSnapshot } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import type { TaskBudgetSnapshot } from "../../../../shared/backlog";
import { backlogApi, type BacklogTask } from "./backlogRendererApi";
import { backlogText, type BacklogTextKey } from "./workspaceBacklogText";
import { InspectorLoadGate } from "./inspectorLoadGate";
import { useDialogFocus } from "./useDialogFocus";
import { DraftRevision, shouldHydrateDraft } from "./workspaceAsyncState";
import { useVisibleRefresh } from "./visibleRefresh";

type InspectorTab = "tasks" | "budget" | "checkpoints";
const TAB_LABELS: Record<InspectorTab, BacklogTextKey> = { tasks: "tabTasks", budget: "tabBudget", checkpoints: "tabCheckpoints" };
const TASK_STATUS_LABELS:Record<BacklogTask["status"],BacklogTextKey>={
  open:"taskOpen",claimed:"taskClaimed",done:"taskDone",closed:"taskClosed"
};

interface BacklogSessionInspectorProps {
  session: SessionSnapshot;
  sessions: readonly SessionSnapshot[];
  locale: LocaleId;
  initialTab?: InspectorTab;
  onClose(): void;
}

export function BacklogSessionInspector({ session, sessions, locale, initialTab = "tasks", onClose }: BacklogSessionInspectorProps): React.JSX.Element {
  const timestampFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }), [locale]);
  const bt = (key: Parameters<typeof backlogText>[1]): string => backlogText(locale, key);
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [checkpoints, setCheckpoints] = useState<Awaited<ReturnType<ReturnType<typeof backlogApi>["checkpoints"]>>>([]);
  const [preview, setPreview] = useState<{ id: string; text: string; changedFiles: string[] } | null>(null);
  const [tasks, setTasks] = useState<BacklogTask[]>([]);
  const [budget, setBudget] = useState<TaskBudgetSnapshot | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskDependencies, setTaskDependencies] = useState("");
  const [taskOwner, setTaskOwner] = useState("");
  const [flowName, setFlowName] = useState("");
  const [flowSavedPath, setFlowSavedPath] = useState("");
  const [budgetTokens, setBudgetTokens] = useState("");
  const [budgetCost, setBudgetCost] = useState("");
  const [budgetMinutes, setBudgetMinutes] = useState("");
  const budgetDraftRevision = useRef(new DraftRevision());
  const budgetDraftInitialized = useRef(false);
  const budgetDraftDirty = useRef(false);
  const activeTab = useRef(tab);
  activeTab.current = tab;
  const loadGate = useRef(new InspectorLoadGate<InspectorTab>());
  const loadTabRef = useRef<((selected: InspectorTab, cursor?: string) => Promise<void>) | null>(null);
  const mounted = useRef(true);
  const dialogRef = useRef<HTMLElement>(null);
  const api = useMemo(() => backlogApi(), []);
  const onPanelError = useCallback((message: string) => { if (mounted.current) setError(message); }, []);
  const sessionsById = useMemo(() => new Map(sessions.map((candidate) => [candidate.id, candidate])), [sessions]);
  const rootSessionId = useMemo(() => findTaskRootId(session, sessionsById), [session, sessionsById]);
  const taskMembers = useMemo(() => sessions.filter((candidate) => findTaskRootId(candidate, sessionsById) === rootSessionId), [rootSessionId, sessions, sessionsById]);
  const taskMemberOptions = useMemo(() => taskMembers.map((member) => (
    <option key={member.id} value={member.id}>{member.title}</option>
  )), [taskMembers]);
  const editBudgetDraft = (): void => {
    budgetDraftRevision.current.advance();
    budgetDraftDirty.current = true;
  };
  useDialogFocus(dialogRef, {
    onEscape: onClose,
    fallbackFocus: () => findSessionInspectorTrigger(session.id)
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGate.current.cancel();
    };
  }, []);

  const hydrateBudgetDraft = useCallback((limits: TaskBudgetSnapshot["limits"]): void => {
    setBudgetTokens(limits.tokens === null ? "" : String(limits.tokens));
    setBudgetCost(limits.costUsd === null ? "" : String(limits.costUsd));
    setBudgetMinutes(limits.durationMs === null ? "" : String(limits.durationMs / 60_000));
    budgetDraftInitialized.current = true;
    budgetDraftDirty.current = false;
  }, []);

  const loadTab = useCallback(async (selected: InspectorTab, cursor?: string): Promise<void> => {
    if (selected !== activeTab.current) return;
    const request = { tab: selected, ...(cursor ? { cursor } : {}) };
    if (!loadGate.current.begin(request, selected === activeTab.current)) return;
    setLoading(true);
    setError("");
    try {
      if (selected === "checkpoints") {
        const next = await api.checkpoints(session.id);
        if (!mounted.current) return;
        setCheckpoints(next);
      } else if (selected === "tasks") {
        const next = await api.tasks(rootSessionId);
        if (!mounted.current) return;
        setTasks(next.tasks);
      } else {
        const draftRevision = budgetDraftRevision.current.capture();
        const next = await api.budget(rootSessionId);
        if (!mounted.current) return;
        setBudget(next);
        if (shouldHydrateDraft(draftRevision, budgetDraftRevision.current.capture(), budgetDraftDirty.current, budgetDraftInitialized.current)) {
          hydrateBudgetDraft(next.limits);
        }
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      const queued = loadGate.current.finish();
      if (!mounted.current) return;
      if (queued) {
        if (queued.tab === activeTab.current) void loadTabRef.current?.(queued.tab, queued.cursor);
        else setLoading(false);
      } else {
        setLoading(false);
      }
    }
  }, [api, hydrateBudgetDraft, rootSessionId, session.id]);
  loadTabRef.current = loadTab;

  useEffect(() => { void loadTab(tab); }, [loadTab, tab]);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useVisibleRefresh(() => { void loadTab("budget"); }, 5_000, tab === "budget");
  useEffect(()=>{
    if(tab!=="tasks")return;
    return api.onTaskBoardChanged(change=>{
      if(change.rootSessionId===rootSessionId)void loadTab("tasks");
    });
  },[api,loadTab,rootSessionId,tab]);

  const addTask = async (): Promise<void> => {
    const title = taskTitle.trim();
    if (!title) return;
    setLoading(true);
    setError("");
    try {
      await api.addTask(rootSessionId, {
        title,
        description: taskDescription.trim(),
        dependencies: taskDependencies.split(",").map((id) => id.trim()).filter(Boolean),
        ownerSessionId: taskOwner || null
      });
      setTaskTitle(""); setTaskDescription(""); setTaskDependencies(""); setTaskOwner("");
      await loadTab("tasks");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (mounted.current) setLoading(false); }
  };

  const assignTask = async (taskId: string, ownerId: string): Promise<void> => {
    try {
      await api.assignTask(rootSessionId, taskId, ownerId || null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const closeTask = async (taskId: string): Promise<void> => {
    try {
      await api.closeTask(rootSessionId, taskId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const runAction = async (action: () => Promise<void>, setBusy = setLoading): Promise<void> => {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (reason) { onPanelError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const saveTaskFlow = async (): Promise<void> => {
    const name = flowName.trim().slice(0, 64);
    if (!name) return;
    setFlowSavedPath("");
    await runAction(async () => {
      const result = await api.saveTaskFlow(rootSessionId, name);
      if (mounted.current) setFlowSavedPath(result.file);
    });
  };

  const updateBudget = (request: () => Promise<TaskBudgetSnapshot>): Promise<void> => {
    const submittedRevision = budgetDraftRevision.current.capture();
    return runAction(async () => {
      const next = await request();
      if (!mounted.current) return;
      setBudget(next);
      if (budgetDraftRevision.current.isCurrent(submittedRevision)) {
        hydrateBudgetDraft(next.limits);
        budgetDraftRevision.current.advance();
      }
    });
  };

  const saveBudget = (limits: TaskBudgetSnapshot["limits"]): Promise<void> =>
    updateBudget(() => api.setBudget(rootSessionId, limits));

  const saveBudgetDraft = (): void => {
    const tokens = parseLimit(budgetTokens);
    const costUsd = parseLimit(budgetCost);
    const minutes = parseLimit(budgetMinutes);
    if (tokens === "invalid" || costUsd === "invalid" || minutes === "invalid") {
      setError(locale === "ru" ? "Введите корректный положительный лимит." : "Enter a valid positive limit.");
      return;
    }
    void saveBudget({ tokens, costUsd, durationMs: minutes === null ? null : minutes * 60_000 });
  };

  const raiseBudget = (): void => {
    if (!budget) return;
    const bump = (value: number | null): number | null => value === null ? null : Math.ceil(value * 1.25);
    void saveBudget({ tokens: bump(budget.limits.tokens), costUsd: bump(budget.limits.costUsd), durationMs: bump(budget.limits.durationMs) });
  };

  const clearBudget = (): Promise<void> => updateBudget(() => api.clearBudget(rootSessionId));

  const loadCheckpointPreview = (id: string): Promise<void> => runAction(async () => {
    const value = await api.previewCheckpoint(session.id, id);
    if (mounted.current) setPreview({ id, text: value.text, changedFiles: value.changedFiles ?? [] });
  });

  const restoreCheckpoint = async (): Promise<void> => {
    if (!preview) return;
    const confirmed = window.confirm(backlogText(locale, "restoreConfirm"));
    if (!confirmed) return;
    await runAction(async () => {
      const result = await api.restoreCheckpoint(session.id, preview.id);
      if (!result.ok) throw new Error(result.message || backlogText(locale, "restoreFailed"));
      if (!mounted.current) return;
      setPreview(null);
      await loadTab("checkpoints");
    });
  };

  return (
    <div className="backlog-inspector__backdrop" data-interactive="true" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
        <section ref={dialogRef} className="backlog-inspector" role="dialog" aria-modal="true" aria-label={backlogText(locale, "inspector")} tabIndex={-1}>
        <header className="backlog-inspector__header">
          <div><strong>{bt("inspector")}</strong><span title={session.title}>{session.title}</span></div>
          <button type="button" onClick={onClose} aria-label={t(locale, "close")}>×</button>
        </header>
        <nav className="backlog-inspector__tabs" aria-label={bt("inspectorTabs")}>
          {(["tasks", "budget", "checkpoints"] as const).map((name) => (
            <button key={name} type="button" aria-pressed={tab === name} onClick={() => { setTab(name); setPreview(null); }}>
              {bt(TAB_LABELS[name])}
            </button>
          ))}
        </nav>
        {loading && <p className="backlog-inspector__notice" role="status">{t(locale, "loading")}</p>}
        {error && <p className="backlog-inspector__error" role="alert">{error}</p>}
        <div className="backlog-inspector__body">
          {tab === "checkpoints" && !preview && (
            <ol className="backlog-checkpoints">
              {checkpoints.map((checkpoint) => (
                <li key={checkpoint.id}>
                  <div><strong>{checkpoint.label || bt("checkpoint")}</strong><time>{timestampFormat.format(checkpoint.at)}</time></div>
                  <button className="backlog-inspector__secondary" type="button" disabled={loading}
                    onClick={() => void loadCheckpointPreview(checkpoint.id)}>{bt("preview")}</button>
                </li>
              ))}
              {checkpoints.length === 0 && !loading && <p className="backlog-inspector__empty">{bt("noCheckpoints")}</p>}
            </ol>
          )}
          {tab === "checkpoints" && preview && (
            <div className="backlog-checkpoint-preview">
              <button className="backlog-inspector__secondary" type="button" onClick={() => setPreview(null)}>{bt("back")}</button>
              {preview.changedFiles.length > 0 && <p>{preview.changedFiles.join(" · ")}</p>}
              <pre>{preview.text}</pre>
              <button className="backlog-inspector__danger" type="button" disabled={loading} onClick={() => void restoreCheckpoint()}>
                {bt("restoreCheckpoint")}
              </button>
            </div>
          )}
          {tab === "tasks" && (
            <div className="backlog-taskboard">
              <h3>{bt("taskBoard")}</h3>
              <form className="backlog-taskboard__form" onSubmit={(event) => { event.preventDefault(); void addTask(); }}>
                <input value={taskTitle} maxLength={200} required placeholder={bt("taskTitle")} aria-label={bt("taskTitle")}
                  onChange={(event) => setTaskTitle(event.currentTarget.value)} />
                <textarea value={taskDescription} rows={2} placeholder={bt("taskDescription")} aria-label={bt("taskDescription")}
                  onChange={(event) => setTaskDescription(event.currentTarget.value)} />
                <input value={taskDependencies} placeholder={bt("taskDependencies")} aria-label={bt("taskDependencies")}
                  onChange={(event) => setTaskDependencies(event.currentTarget.value)} />
                <select value={taskOwner} aria-label={bt("taskOwner")} onChange={(event) => setTaskOwner(event.currentTarget.value)}>
                  <option value="">{bt("unassigned")}</option>
                  {taskMemberOptions}
                </select>
                <button type="submit" disabled={loading || !taskTitle.trim()}>{bt("addTask")}</button>
              </form>
              <ol className="backlog-taskboard__list">
                {tasks.map((task) => (
                  <li key={task.id} data-status={task.status}>
                    <div className="backlog-taskboard__task-main">
                      <strong>{task.title}</strong><code className="backlog-taskboard__task-id" title={task.id}>{task.id}</code><span>{task.description}</span>
                      {task.progress && <small>{task.progress}</small>}
                      {task.result && <p>{task.result}</p>}
                      {task.dependencies.length > 0 && <small>{bt("taskDependencies")}: {task.dependencies.join(", ")}</small>}
                    </div>
                    <div className="backlog-taskboard__task-actions">
                      <span>{bt(TASK_STATUS_LABELS[task.status])}</span>
                      <select value={task.ownerSessionId ?? ""} disabled={loading || task.status === "closed"} aria-label={`${bt("taskOwner")}: ${task.title}`}
                        onChange={(event) => void assignTask(task.id, event.currentTarget.value)}>
                        <option value="">{bt("unassigned")}</option>
                        {taskMemberOptions}
                      </select>
                      {task.status !== "closed" && <button type="button" disabled={loading} onClick={() => void closeTask(task.id)}>{bt("closeTask")}</button>}
                    </div>
                  </li>
                ))}
                {tasks.length === 0 && !loading && <li className="backlog-inspector__empty">{bt("noTasks")}</li>}
              </ol>
              {sessions.find((candidate) => candidate.id === rootSessionId)?.role === "orchestrator" && (
                <section className="backlog-taskboard__flow-save">
                  <h3>{bt("saveTaskFlow")}</h3>
                  <div><input value={flowName} maxLength={64} placeholder={bt("flowName")} aria-label={bt("flowName")}
                    onChange={(event) => setFlowName(event.currentTarget.value)} />
                    <button type="button" disabled={loading || !flowName.trim()} onClick={() => void saveTaskFlow()}>{bt("saveTaskFlow")}</button></div>
                  {flowSavedPath && <p role="status"><strong>{bt("flowSaved")}:</strong> <code>{flowSavedPath}</code></p>}
                </section>
              )}
            </div>
          )}
          {tab === "budget" && budget && (
            <div className="backlog-budget">
              <h3>{bt("budgetLimits")}</h3>
              {budget.paused && <p className="backlog-budget__paused" role="alert">{bt("budgetPaused")}{budget.data.costUsd === "partial" && budget.limits.costUsd !== null ? ` ${bt("budgetCostPartialPause")}` : ""}{budget.reason ? ` ${bt("budgetReason")}: ${budget.reason}` : ""}</p>}
              {!budget.paused && budget.warning && <p className="backlog-budget__warning" role="status">{bt("budgetWarning")}</p>}
              <div className="backlog-budget__metrics">
                <BudgetMetric label={bt("budgetTokens")} limit={budget.limits.tokens} used={budget.usage.tokens} remaining={budget.remaining.tokens} dataState={budget.data.tokens} locale={locale} />
                <BudgetMetric label={bt("budgetCost")} limit={budget.limits.costUsd} used={budget.usage.costUsd} remaining={budget.remaining.costUsd} dataState={budget.data.costUsd} locale={locale} money />
                <BudgetMetric label={bt("budgetMinutes")} limit={toMinutes(budget.limits.durationMs)} used={toMinutes(budget.usage.durationMs)} remaining={toMinutes(budget.remaining.durationMs)} dataState={budget.data.duration} locale={locale} />
              </div>
              <div className="backlog-budget__form">
                <label>{bt("budgetTokens")}<input type="number" min="1" step="1" value={budgetTokens} onChange={(event) => { editBudgetDraft(); setBudgetTokens(event.currentTarget.value); }} /></label>
                <label>{bt("budgetCost")}<input type="number" min="0.01" step="0.01" value={budgetCost} onChange={(event) => { editBudgetDraft(); setBudgetCost(event.currentTarget.value); }} /></label>
                <label>{bt("budgetMinutes")}<input type="number" min="1" step="1" value={budgetMinutes} onChange={(event) => { editBudgetDraft(); setBudgetMinutes(event.currentTarget.value); }} /></label>
                <div>
                  <button type="button" disabled={loading} onClick={saveBudgetDraft}>{bt("budgetSet")}</button>
                  <button type="button" disabled={loading || !hasBudgetLimit(budget.limits)} onClick={raiseBudget}>{bt("budgetRaise")}</button>
                  <button type="button" disabled={loading || !hasBudgetLimit(budget.limits)} onClick={() => void clearBudget()}>{bt("budgetClear")}</button>
                </div>
              </div>
              {!hasBudgetLimit(budget.limits) && <p className="backlog-inspector__empty">{bt("budgetNoLimits")}</p>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function BudgetMetric({
  label, limit, used, remaining, dataState, locale, money = false
}: {
  label: string;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  dataState: "available" | "none" | "partial";
  locale: LocaleId;
  money?: boolean;
}): React.JSX.Element {
  const fmt = (value: number | null): string => {
    if (value === null) return "—";
    if (money) return `$${value.toFixed(2)}`;
    return value.toLocaleString(locale, { maximumFractionDigits: 1 });
  };
  const usedText = dataState === "none" ? backlogText(locale, "budgetDataNone")
    : dataState === "partial" ? `≥ ${fmt(used)}` : fmt(used);
  const remainingText = dataState === "none" ? backlogText(locale, "budgetDataNone")
    : dataState === "partial" ? backlogText(locale, "budgetDataPartial") : fmt(remaining);
  return (
    <section>
      <strong>{label}</strong>
      <span>{backlogText(locale, "budgetLimits")}: {fmt(limit)}</span>
      <span>{backlogText(locale, "budgetUsage")}: {usedText}</span>
      <span>{backlogText(locale, "budgetRemaining")}: {remainingText}</span>
    </section>
  );
}

function findSessionInspectorTrigger(sessionId: string): HTMLElement | null {
  const card = Array.from(document.querySelectorAll<HTMLElement>("[data-session-id]")).find((candidate) => candidate.dataset.sessionId === sessionId);
  return card?.querySelector<HTMLElement>(".terminal-card__action--options") ?? card ?? null;
}

function findTaskRootId(session: SessionSnapshot, byId: ReadonlyMap<string, SessionSnapshot>): string {
  let current = session;
  const visited = new Set<string>();
  while (current.parentSessionId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = byId.get(current.parentSessionId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function parseLimit(text: string): number | null | "invalid" {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : "invalid";
}

function toMinutes(milliseconds: number | null): number | null {
  return milliseconds === null ? null : milliseconds / 60_000;
}

function hasBudgetLimit(limits: TaskBudgetSnapshot["limits"]): boolean {
  return limits.tokens !== null || limits.costUsd !== null || limits.durationMs !== null;
}
