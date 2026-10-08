import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocaleId, SessionSnapshot } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import type { NotificationPreferences, TaskBudgetSnapshot } from "../../../../shared/backlog";
import { backlogApi, type BacklogTask } from "./backlogRendererApi";
import { backlogText, type BacklogTextKey } from "./workspaceBacklogText";
import { SecretGrantsPanel } from "./SecretGrantsPanel";
import { UsageBreakdownPanel } from "./UsageBreakdownPanel";
import { NetworkPolicyPanel } from "./NetworkPolicyPanel";
import { InspectorLoadGate } from "./inspectorLoadGate";
import { useDialogFocus } from "./useDialogFocus";
import { downloadText, findSessionCard } from "./workspaceDom";
import { DraftRevision, shouldHydrateDraft } from "./workspaceAsyncState";
import { useVisibleRefresh } from "./visibleRefresh";

type InspectorTab = "timeline" | "usage" | "report" | "checkpoints" | "tasks" | "budget" | "notifications" | "secrets";
const TAB_LABELS:Record<InspectorTab,BacklogTextKey>={
  timeline:"tabTimeline",usage:"tabUsage",report:"tabReport",checkpoints:"tabCheckpoints",
  tasks:"tabTasks",budget:"tabBudget",notifications:"tabNotifications",secrets:"tabSecrets"
};
const TASK_STATUS_LABELS:Record<BacklogTask["status"],BacklogTextKey>={
  open:"taskOpen",claimed:"taskClaimed",done:"taskDone",closed:"taskClosed"
};

interface BacklogSessionInspectorProps {
  session: SessionSnapshot;
  sessions: readonly SessionSnapshot[];
  locale: LocaleId;
  initialTab?: "timeline" | "report";
  onClose(): void;
}

export function BacklogSessionInspector({ session, sessions, locale, initialTab = "timeline", onClose }: BacklogSessionInspectorProps): React.JSX.Element {
  const bt = (key: Parameters<typeof backlogText>[1]): string => backlogText(locale, key);
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [timeline, setTimeline] = useState<Awaited<ReturnType<ReturnType<typeof backlogApi>["timeline"]>> | null>(null);
  const [timelineQuery, setTimelineQuery] = useState("");
  const [timelineType, setTimelineType] = useState("");
  const [timelineAgent, setTimelineAgent] = useState("");
  const [timelineFilter, setTimelineFilter] = useState<{ query?: string; types?: string[]; sessionIds?: string[] }>({});
  const [usage, setUsage] = useState<Awaited<ReturnType<ReturnType<typeof backlogApi>["usage"]>> | null>(null);
  const [report, setReport] = useState("");
  const [checkpoints, setCheckpoints] = useState<Awaited<ReturnType<ReturnType<typeof backlogApi>["checkpoints"]>>>([]);
  const [preview, setPreview] = useState<{ id: string; text: string; changedFiles: string[] } | null>(null);
  const [tasks, setTasks] = useState<BacklogTask[]>([]);
  const [budget, setBudget] = useState<TaskBudgetSnapshot | null>(null);
  const [notifications, setNotifications] = useState<NotificationPreferences | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
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
  const timestampFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
  const timelineAgents = useMemo(() => {
    const agents = new Map<string, {id:string;title:string}>((timeline?.facets?.agents ?? []).map(row => [row.id, row]));
    for (const member of taskMembers) agents.set(member.id, member);
    return [...agents.values()];
  }, [taskMembers, timeline?.facets]);
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
      if (selected === "timeline") {
        const page = await api.timeline(session.id, cursor, 50, timelineFilter);
        if (!mounted.current) return;
        setTimeline((current) => cursor && current
          ? { ...current, ...page, items: [...current.items, ...page.items] }
          : page);
      } else if (selected === "usage") {
        const next = await api.usage(rootSessionId);
        if (!mounted.current) return;
        setUsage(next);
      } else if (selected === "report") {
        const next = await api.report(session.id);
        if (!mounted.current) return;
        setReport(next);
      } else if (selected === "checkpoints") {
        const next = await api.checkpoints(session.id);
        if (!mounted.current) return;
        setCheckpoints(next);
      } else if (selected === "tasks") {
        const next = await api.tasks(rootSessionId);
        if (!mounted.current) return;
        setTasks(next.tasks);
      } else if (selected === "notifications") {
        const next = await api.notificationPreferences();
        if (!mounted.current) return;
        setNotifications(next);
      } else if (selected === "secrets") {
        // The secret and network panels load their own scoped snapshots.
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
  }, [api, hydrateBudgetDraft, rootSessionId, session.id, timelineFilter]);
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    }
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

  const updateNotifications = (next: NotificationPreferences): Promise<void> => runAction(async () => {
    const saved = await api.setNotificationPreferences(next);
    if (mounted.current) setNotifications(saved);
  }, setNotificationBusy);

  const downloadReport = (): void => {
    downloadText(report, `${safeFilename(session.title)}-report.md`, "text/markdown;charset=utf-8");
  };

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
          {(["timeline", "usage", "report", "checkpoints", "tasks", "budget", "notifications", "secrets"] as const).map((name) => (
            <button key={name} type="button" aria-pressed={tab === name} onClick={() => { setTab(name); setPreview(null); }}>
              {bt(TAB_LABELS[name])}
            </button>
          ))}
        </nav>
        {loading && <p className="backlog-inspector__notice" role="status">{t(locale, "loading")}</p>}
        {error && <p className="backlog-inspector__error" role="alert">{error}</p>}
        <div className="backlog-inspector__body">
          {tab === "timeline" && (
            <>
              <form className="backlog-timeline__filters" onSubmit={(event) => {
                event.preventDefault();
                setTimeline(null);
                setTimelineFilter({
                  ...(timelineQuery.trim() ? { query: timelineQuery.trim() } : {}),
                  ...(timelineType ? { types: [timelineType] } : {}),
                  ...(timelineAgent ? { sessionIds: [timelineAgent] } : {})
                });
              }}>
                <input value={timelineQuery} placeholder={bt("timelineText")} aria-label={bt("timelineText")}
                  onChange={(event) => setTimelineQuery(event.currentTarget.value)} />
                <select value={timelineType} aria-label={bt("timelineType")} onChange={(event) => setTimelineType(event.currentTarget.value)}>
                  <option value="">{bt("timelineAll")}</option>
                  {[...new Set([...(timeline?.facets?.types ?? []), ...(timeline?.items ?? []).map((item) => item.type), ...(timelineType ? [timelineType] : [])])]
                    .sort().map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <select value={timelineAgent} aria-label={bt("timelineAgent")} onChange={(event) => setTimelineAgent(event.currentTarget.value)}>
                  <option value="">{bt("timelineAll")}</option>
                  {timelineAgents.map((member) => <option key={member.id} value={member.id}>{member.title}</option>)}
                </select>
                <button type="submit" disabled={loading}>{bt("timelineSearch")}</button>
              </form>
              {timeline && timeline.items.length === 0 && !loading && <p className="backlog-inspector__empty">{bt("noTimeline")}</p>}
              {timeline && <>
              <ol className="backlog-timeline">
                {timeline.items.map((item) => (
                  <li key={item.id}>
                    <time dateTime={new Date(item.at).toISOString()}>{timestampFormat.format(item.at)}</time>
                    <div><strong>{item.summary}</strong><small>{item.type}{item.source ? ` · ${item.source}` : ""}</small>
                      {item.detail && <p>{item.detail}</p>}</div>
                  </li>
                ))}
              </ol>
              {timeline.nextCursor && <button className="backlog-inspector__secondary" type="button"
                disabled={loading} onClick={() => void loadTab("timeline", timeline.nextCursor!)}>{bt("loadMore")}</button>}
              </>}
            </>
          )}
          {tab === "usage" && usage && (
            <div className="backlog-usage-section">
              <div className="backlog-usage">
              <Metric label={bt("inputTokens")} value={usage.tokens.input} />
              <Metric label={bt("outputTokens")} value={usage.tokens.output} />
              <Metric label={bt("conversationTokens")} value={usage.tokens.total} />
              <Metric label={bt("cost")} value={usage.cost} format={(value) => `${value.toFixed(2)} ${usage.currency ?? ""}`.trim()} />
              <p>{usage.source ? `${bt("usageSource")}: ${usage.source}` : bt("usageUnknown")}</p>
              </div>
              <UsageBreakdownPanel sessionId={rootSessionId} filename={`${safeFilename(session.title)}-usage.csv`} locale={locale} onError={onPanelError} />
            </div>
          )}
          {tab === "secrets" && <div className="backlog-safety-panels">
            <SecretGrantsPanel sessionId={rootSessionId} sessions={taskMembers} locale={locale} onError={onPanelError} />
            <NetworkPolicyPanel sessionId={rootSessionId} />
          </div>}
          {tab === "report" && report !== "" && (
            <div className="backlog-report">
              <button className="backlog-inspector__secondary" type="button" onClick={downloadReport}>{bt("exportReport")}</button>
              <pre>{report}</pre>
            </div>
          )}
          {tab === "report" && report === "" && !loading && !error && <p className="backlog-inspector__empty">{bt("noReport")}</p>}
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
          {tab === "notifications" && notifications && (
            <div className="backlog-notifications">
              <h3>{bt("notificationChannels")}</h3>
              {(["desktop", "phone", "glasses"] as const).map((channel) => (
                <label key={channel}>
                  <input type="checkbox" disabled={notificationBusy} checked={notifications.channels[channel]}
                    onChange={(event) => void updateNotifications({ ...notifications,
                      channels: { ...notifications.channels, [channel]: event.currentTarget.checked } })} />
                  {bt(channel === "desktop" ? "notificationDesktop" : channel === "phone" ? "notificationPhone" : "notificationGlasses")}
                </label>
              ))}
              <h3>{bt("notificationDnd")}</h3>
              <div role="group" aria-label={bt("notificationDnd")}>
                {([
                  ["off", null, "notificationDndOff"],
                  ["hour", Date.now() + 60 * 60_000, "notificationDndHour"],
                  ["until", Number.MAX_SAFE_INTEGER, "notificationDndUntilClear"]
                ] as const).map(([id, quietUntil, key]) => {
                  const active = id === "off" ? notifications.quietUntil === null
                    : id === "hour" ? notifications.quietUntil !== null && notifications.quietUntil > Date.now()
                      && notifications.quietUntil < Date.now() + 2 * 60 * 60_000
                      : notifications.quietUntil !== null && notifications.quietUntil >= Date.now() + 2 * 60 * 60_000;
                  return <button key={id} type="button" disabled={notificationBusy} aria-pressed={active}
                    onClick={() => void updateNotifications({ ...notifications,
                      quietUntil: id === "hour" ? Date.now() + 60 * 60_000 : quietUntil })}>{bt(key)}</button>;
                })}
              </div>
              <label>
                <input type="checkbox" disabled={notificationBusy} checked={notifications.importantOnly}
                  onChange={(event) => void updateNotifications({ ...notifications, importantOnly: event.currentTarget.checked })} />
                {bt("notificationImportantOnly")}
              </label>
              <label>
                <input type="checkbox" disabled={notificationBusy}
                  checked={notifications.sessionIds?.length === 1 && notifications.sessionIds[0] === session.id}
                  onChange={(event) => void updateNotifications({ ...notifications, sessionIds: event.currentTarget.checked ? [session.id] : null })} />
                {bt("notificationThisCard")}
              </label>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, format }: { label: string; value: number | null; format?: (value: number) => string }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value === null ? "—" : format ? format(value) : value.toLocaleString()}</strong></div>;
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

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "session";
}

function findSessionInspectorTrigger(sessionId: string): HTMLElement | null {
  const card = findSessionCard(sessionId);
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
