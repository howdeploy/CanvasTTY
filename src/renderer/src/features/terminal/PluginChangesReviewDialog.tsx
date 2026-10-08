import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LocaleId, PluginCardActionResult, PluginChangeReview, PluginChangeReviewGroup, PluginChangeReviewFile, PluginReviewTextPage } from "../../../../shared/contracts";
import { useDialogFocus } from "../workspace/useDialogFocus";
import { findSessionCard } from "../workspace/workspaceDom";
import { TaskReviewSessionTracker, virtualFileWindow } from "./pluginReviewUiState";

const REVIEW_FILE_ROW_HEIGHT = 56;
const REVIEW_FILE_OVERSCAN = 4;

export type PluginChangeReviewActionInput = {
  agentSessionId?: string;
  files?: string[];
  resolutions?: Record<string, "current" | "agent">;
  offset?: number;
  file?: string;
  page?: number;
}

interface PluginChangesReviewDialogProps {
  cardSessionId: string;
  reviewActionId: string;
  review: PluginChangeReview;
  locale: LocaleId;
  invokeAction(actionId: string, input?: PluginChangeReviewActionInput): Promise<PluginCardActionResult>;
  onReviewChange(review: PluginChangeReview): void;
  onActionResult(result: PluginCardActionResult): void;
  onClose(): void;
}

type Confirmation = { action: "accept-selected" | "accept-all-group" | "accept-all-task" | "reject-group" | "reject-task"; groupId?: string };
type Resolution = "current" | "agent";

export function PluginChangesReviewDialog({
  cardSessionId,
  reviewActionId,
  review,
  locale,
  invokeAction,
  onReviewChange,
  onActionResult,
  onClose
}: PluginChangesReviewDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const fileListRef = useRef<HTMLOListElement>(null);
  const [selectedGroupId, setSelectedGroupId] = useState(review.groups[0]?.sessionId ?? "");
  const initialFileKeys = review.groups.flatMap((group) => group.files.map((file) => reviewFileKey(group.sessionId, file.path)));
  const knownFileKeys = useRef(new Set(initialFileKeys));
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set(initialFileKeys));
  const firstGroup = review.groups[0];
  const firstFile = firstGroup?.files.find((file) => file.conflict) ?? firstGroup?.files[0];
  const [activeFileKey, setActiveFileKey] = useState(() => firstGroup && firstFile
    ? reviewFileKey(firstGroup.sessionId, firstFile.path) : "");
  const [fileListScrollTop, setFileListScrollTop] = useState(0);
  const [fileListViewportHeight, setFileListViewportHeight] = useState(280);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [scopeStale, setScopeStale] = useState(false);
  const [error, setError] = useState("");
  const requestInFlightRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);
  const scopeEpochRef = useRef(0);
  const confirmationEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const sessionTrackerRef = useRef(new TaskReviewSessionTracker(cardSessionId));
  const reviewRef = useRef(review);
  const invokeActionRef = useRef(invokeAction);
  const onReviewChangeRef = useRef(onReviewChange);
  const onActionResultRef = useRef(onActionResult);
  reviewRef.current = review;
  invokeActionRef.current = invokeAction;
  onReviewChangeRef.current = onReviewChange;
  onActionResultRef.current = onActionResult;
  for (const candidate of review.groups) sessionTrackerRef.current.include(candidate.sessionId);
  const text = locale === "ru" ? {
    close: "Закрыть", title: "Изменения подзадачи", card: "Карточка", group: "Подзадача",
    files: "Файлы", status: "Статус", conflict: "Конфликт: выберите версию перед принятием",
    current: "Текущая версия", agent: "Версия агента", acceptSelected: "Принять выбранные файлы",
    acceptAllGroup: "Принять все файлы этой подзадачи", acceptAllTask: "Принять весь результат задачи",
    rejectGroup: "Отклонить эту подзадачу", rejectTask: "Отклонить весь результат задачи",
    loadTaskPage: "Загрузить ещё файлы", loadFilePage: "Загрузить следующую страницу",
    confirmAcceptSelected: "Принять выбранные файлы? Изменения будут записаны в рабочее дерево.",
    confirmAcceptAllGroup: "Принять все файлы этой подзадачи? Изменения будут записаны в рабочее дерево.",
    confirmAcceptAllTask: "Принять изменения всех подзадач одним действием?",
    confirmRejectGroup: "Отклонить изменения этой подзадачи?", confirmRejectTask: "Отклонить изменения всей задачи?",
    cleanupWarning: "Если агент завершён или упал, его отдельный worktree будет удалён, а оставшийся локальный контекст worktree будет потерян.",
    confirm: "Подтвердить", cancel: "Назад", noFiles: "Нет файлов для просмотра.", viewDiff: "Открыть diff",
    selectAllFiles: "Выбрать все", clearSelection: "Снять выбор",
    unavailable: "Нет данных конфликта для этого файла.", truncated: "Показана сокращённая версия.",
    groupError: "Не удалось получить изменения этой подзадачи.", lines: "строк", loading: "Выполняется…",
    selected: "Выбрано файлов: {count}", noAction: "Действие недоступно", taskAllUnavailable: "Для общего принятия загрузите все файлы, устраните конфликты и пересечения путей.",
    loadDiff: "Загрузить diff", loadNextFilePage: "Следующая страница", refreshReview: "Обновить обзор"
  } : {
    close: "Close", title: "Subtask changes", card: "Card", group: "Subtask",
    files: "Files", status: "Status", conflict: "Conflict: choose a version before accepting",
    current: "Current version", agent: "Agent version", acceptSelected: "Accept selected files",
    acceptAllGroup: "Accept every file in this subtask", acceptAllTask: "Accept the full task result",
    rejectGroup: "Reject this subtask", rejectTask: "Reject the full task result",
    loadTaskPage: "Load more files", loadFilePage: "Load next page",
    confirmAcceptSelected: "Accept the selected files? Changes will be written to the worktree.",
    confirmAcceptAllGroup: "Accept every file in this subtask? Changes will be written to the worktree.",
    confirmAcceptAllTask: "Accept the changes from every subtask in one action?",
    confirmRejectGroup: "Reject this subtask's changes?", confirmRejectTask: "Reject the task's changes?",
    cleanupWarning: "This will delete the finished agent’s isolated worktree and discard its remaining local worktree context.",
    confirm: "Confirm", cancel: "Back", noFiles: "No files to review.", viewDiff: "View diff",
    selectAllFiles: "Select all", clearSelection: "Clear selection",
    unavailable: "Conflict data is unavailable for this file.", truncated: "A shortened version is shown.",
    groupError: "Could not read this subtask's changes.", lines: "lines", loading: "Working…",
    selected: "Selected files: {count}", noAction: "Action unavailable", taskAllUnavailable: "Load every file, then resolve conflicts and duplicate paths before accepting the full task.",
    loadDiff: "Load diff", loadNextFilePage: "Next page", refreshReview: "Refresh review"
  };
  const group = review.groups.find((candidate) => candidate.sessionId === selectedGroupId) ?? review.groups[0];
  const groupFiles = group?.files ?? [];
  const activeFile = groupFiles.find((file) => reviewFileKey(group?.sessionId ?? "", file.path) === activeFileKey);
  const fileWindow = virtualFileWindow(groupFiles.length, fileListScrollTop, fileListViewportHeight, REVIEW_FILE_ROW_HEIGHT, REVIEW_FILE_OVERSCAN);
  const visibleFiles = groupFiles.slice(fileWindow.startIndex, fileWindow.endIndex);
  const allFiles = useMemo(() => review.groups.flatMap((candidate) => candidate.files), [review.groups]);
  const allTaskPathsUnique = new Set(allFiles.map((file) => file.path)).size === allFiles.length;
  const hasMoreFileContent = (file: PluginChangeReviewFile): boolean => Boolean(file.hasMore
    || file.conflict?.current.hasMore || file.conflict?.agent.hasMore);
  const fileReviewLoaded = (file: PluginChangeReviewFile): boolean => file.page !== undefined;
  const taskWideAcceptAllowed = Boolean(review.acceptActionId && review.nextOffset === undefined && allFiles.length > 0 && allTaskPathsUnique
    && review.groups.every((candidate) => !candidate.error && candidate.files.length > 0 && candidate.files.every((file) => fileReviewLoaded(file) && !file.conflict && !hasMoreFileContent(file))));
  const selectedGroupFiles = groupFiles.filter((file) => selectedFiles.has(reviewFileKey(group?.sessionId ?? "", file.path)));
  const hasUnresolvedSelectedConflict = selectedGroupFiles.some((file) => file.conflict && !resolutions[`${group?.sessionId}:${file.path}`]);
  const selectedGroupPaths = selectedGroupFiles.map((file) => file.path);
  const hasUnloadedSelectedFile = selectedGroupFiles.some((file) => !fileReviewLoaded(file));
  const hasMoreSelectedContent = selectedGroupFiles.some(hasMoreFileContent);
  const tt = (source: string): string => source.replace("{count}", String(selectedGroupPaths.length));
  const interactionBlocked = busy || scopeStale;

  useEffect(() => {
    setSelectedGroupId((current) => review.groups.some((candidate) => candidate.sessionId === current)
      ? current : review.groups[0]?.sessionId ?? "");
    setSelectedFiles((current) => {
      const available = new Set(review.groups.flatMap((candidate) => candidate.files.map((file) => reviewFileKey(candidate.sessionId, file.path))));
      const next = new Set([...current].filter((path) => available.has(path)));
      for (const path of available) if (!knownFileKeys.current.has(path)) next.add(path);
      knownFileKeys.current = available;
      return next;
    });
    setActiveFileKey((current) => {
      const selectedGroup = review.groups.find((candidate) => candidate.sessionId === selectedGroupId) ?? review.groups[0];
      if (selectedGroup?.files.some((file) => reviewFileKey(selectedGroup.sessionId, file.path) === current)) return current;
      const preferredFile = selectedGroup?.files.find((file) => file.conflict) ?? selectedGroup?.files[0];
      return selectedGroup && preferredFile ? reviewFileKey(selectedGroup.sessionId, preferredFile.path) : "";
    });
  }, [review]);

  useEffect(() => {
    const list = fileListRef.current;
    if (!list) return;
    const updateHeight = (): void => setFileListViewportHeight(list.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(list);
    return () => observer.disconnect();
  }, [group?.sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    };
  }, []);

  useDialogFocus(dialogRef, {
    onEscape: () => {
      if (mutating) return;
      if (confirmation) setConfirmation(null);
      else onClose();
    },
    fallbackFocus: () => findSessionCard(cardSessionId)
  });

  useEffect(() => {
    if (!confirmation) {
      const trigger = confirmationTrigger.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else dialogRef.current?.querySelector<HTMLElement>(".plugin-changes-review__header button")?.focus({ preventScroll: true });
    }
  }, [confirmation]);

  const setFileSelected = (groupId: string, path: string, selected: boolean): void => {
    setSelectedFiles((current) => {
      const next = new Set(current);
      const key = reviewFileKey(groupId, path);
      if (selected) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const setGroupSelection = (selected: boolean): void => {
    if (!group) return;
    setSelectedFiles((current) => {
      const next = new Set(current);
      for (const file of group.files) {
        const key = reviewFileKey(group.sessionId, file.path);
        if (selected) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const selectGroup = (nextGroup: PluginChangeReviewGroup | undefined): void => {
    setSelectedGroupId(nextGroup?.sessionId ?? "");
    const nextFile = nextGroup?.files.find((file) => file.conflict) ?? nextGroup?.files[0];
    setActiveFileKey(nextGroup && nextFile ? reviewFileKey(nextGroup.sessionId, nextFile.path) : "");
    if (fileListRef.current) fileListRef.current.scrollTop = 0;
    setFileListScrollTop(0);
  };

  const openFile = (file: PluginChangeReviewFile): void => {
    if (group) setActiveFileKey(reviewFileKey(group.sessionId, file.path));
  };

  const focusFileAt = (index: number): void => {
    if (!group || groupFiles.length === 0) return;
    const nextIndex = Math.max(0, Math.min(groupFiles.length - 1, index));
    const nextFile = groupFiles[nextIndex];
    setActiveFileKey(reviewFileKey(group.sessionId, nextFile.path));
    const list = fileListRef.current;
    if (list) {
      list.scrollTop = Math.min(nextIndex * REVIEW_FILE_ROW_HEIGHT, list.scrollHeight - list.clientHeight);
      setFileListScrollTop(list.scrollTop);
    }
    window.requestAnimationFrame(() => {
      const row = [...(fileListRef.current?.querySelectorAll<HTMLElement>("[data-file-index]") ?? [])]
        .find((candidate) => Number(candidate.dataset.fileIndex) === nextIndex);
      row?.querySelector<HTMLButtonElement>(".plugin-changes-review__file-open")?.focus({ preventScroll: true });
    });
  };

  const onFileListKeyDown = (event: React.KeyboardEvent<HTMLOListElement>): void => {
    if (!groupFiles.length) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-file-index]") : null;
    const activeIndex = target ? Number(target.dataset.fileIndex) : groupFiles.findIndex((file) => (
      reviewFileKey(group?.sessionId ?? "", file.path) === activeFileKey
    ));
    const current = activeIndex < 0 ? 0 : activeIndex;
    let next = current;
    if (event.key === "ArrowDown") next = current + 1;
    else if (event.key === "ArrowUp") next = current - 1;
    else if (event.key === "PageDown") next = current + Math.max(1, Math.floor(fileListViewportHeight / REVIEW_FILE_ROW_HEIGHT));
    else if (event.key === "PageUp") next = current - Math.max(1, Math.floor(fileListViewportHeight / REVIEW_FILE_ROW_HEIGHT));
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = groupFiles.length - 1;
    else return;
    event.preventDefault();
    focusFileAt(next);
  };

  const drainPendingRefreshRef = useRef<() => void>(() => undefined);
  const invokeReview = async (input?: PluginChangeReviewActionInput, replaceScope = false): Promise<void> => {
    if (requestInFlightRef.current) {
      if (replaceScope) refreshPendingRef.current = true;
      return;
    }
    requestInFlightRef.current = true;
    setBusy(true);
    setError("");
    const requestEpoch = scopeEpochRef.current;
    try {
      const result = await invokeActionRef.current(reviewActionId, input);
      if (!mountedRef.current || requestEpoch !== scopeEpochRef.current) return;
      if (result.review) {
        if (replaceScope) {
          const available = new Set(result.review.groups.flatMap((candidate) => (
            candidate.files.map((file) => reviewFileKey(candidate.sessionId, file.path))
          )));
          knownFileKeys.current = available;
          setSelectedFiles(new Set(available));
          setResolutions({});
          setConfirmation(null);
          setScopeStale(false);
          const nextGroup = result.review.groups.find((candidate) => candidate.sessionId === selectedGroupId)
            ?? result.review.groups[0];
          selectGroup(nextGroup);
          onReviewChangeRef.current(result.review);
        } else {
          onReviewChangeRef.current(mergeReview(reviewRef.current, result.review, input?.offset === undefined));
        }
      } else if (replaceScope || result.tone === "error") setError(result.message ?? text.groupError);
      else onActionResultRef.current(result);
    } catch (reason) {
      if (mountedRef.current && requestEpoch === scopeEpochRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      requestInFlightRef.current = false;
      if (mountedRef.current && !refreshPendingRef.current) setBusy(false);
      if (refreshPendingRef.current) drainPendingRefreshRef.current();
    }
  };

  const schedulePendingRefresh = (delayMs: number): void => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      if (!refreshPendingRef.current || !mountedRef.current || requestInFlightRef.current) return;
      refreshPendingRef.current = false;
      void invokeReview(undefined, true);
    }, delayMs);
  };

  drainPendingRefreshRef.current = () => {
    if (!refreshPendingRef.current || requestInFlightRef.current || !mountedRef.current) return;
    schedulePendingRefresh(0);
  };

  const queueScopeRefresh = (): void => {
    scopeEpochRef.current += 1;
    confirmationEpochRef.current = -1;
    setConfirmation(null);
    setResolutions({});
    setScopeStale(true);
    setError("");
    refreshPendingRef.current = true;
    setBusy(true);
    schedulePendingRefresh(60);
  };
  const queueScopeRefreshRef = useRef(queueScopeRefresh);
  queueScopeRefreshRef.current = queueScopeRefresh;

  useEffect(() => {
    let active = true;
    const unsubscribe = window.canvasTTY.terminal.onSession(({ session }) => {
      if (sessionTrackerRef.current.observe(session)) queueScopeRefreshRef.current();
    });
    void window.canvasTTY.terminal.list().then((sessions) => {
      if (active) sessionTrackerRef.current.seedSubtree(sessions);
    }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [cardSessionId]);

  useEffect(() => {
    if (!group || !activeFile || activeFile.page !== undefined) return;
    void invokeReview({ agentSessionId: group.sessionId, file: activeFile.path, page: 0 });
  }, [group?.sessionId, activeFile?.path, activeFile?.page]);

  const loadTaskPage = async (): Promise<void> => {
    if (reviewRef.current.nextOffset === undefined) return;
    await invokeReview({ offset: reviewRef.current.nextOffset });
  };

  const loadFilePage = async (file: PluginChangeReviewFile): Promise<void> => {
    if (!group) return;
    await invokeReview({ agentSessionId: group.sessionId, file: file.path, page: file.page === undefined ? 0 : file.page + 1 });
  };

  const fullGroupAction = confirmation?.action === "accept-all-group" || confirmation?.action === "reject-group"
    || (confirmation?.action === "accept-selected" && selectedGroupPaths.length === groupFiles.length && groupFiles.length > 0);
  const fullAction = fullGroupAction || confirmation?.action === "accept-all-task" || confirmation?.action === "reject-task";
  const confirmationBase = confirmation?.action === "accept-selected" ? text.confirmAcceptSelected
    : confirmation?.action === "accept-all-group" ? text.confirmAcceptAllGroup
      : confirmation?.action === "accept-all-task" ? text.confirmAcceptAllTask
        : confirmation?.action === "reject-group" ? text.confirmRejectGroup : text.confirmRejectTask;
  const confirmationMessage = fullAction ? `${confirmationBase} ${text.cleanupWarning}` : confirmationBase;

  const requestConfirmation = (next: Confirmation, trigger: HTMLButtonElement): void => {
    confirmationEpochRef.current = scopeEpochRef.current;
    confirmationTrigger.current = trigger;
    setConfirmation(next);
  };

  const confirm = async (): Promise<void> => {
    if (!confirmation) return;
    if (confirmationEpochRef.current !== scopeEpochRef.current || requestInFlightRef.current || mutating) {
      setConfirmation(null);
      return;
    }
    const accepting = confirmation.action.startsWith("accept");
    const actionId = accepting ? review.acceptActionId : review.rejectActionId;
    if (!actionId) { setError(text.noAction); return; }
    const targetGroup = confirmation.groupId
      ? review.groups.find((candidate) => candidate.sessionId === confirmation.groupId)
      : undefined;
    const taskWide = confirmation.action.endsWith("task");
    const files = confirmation.action === "accept-selected" ? selectedGroupPaths
      : accepting ? (taskWide ? allFiles.map((file) => file.path) : targetGroup?.files.map((file) => file.path) ?? [])
        : undefined;
    const groupResolutions = targetGroup ? Object.fromEntries(targetGroup.files
      .filter((file) => (files ?? []).includes(file.path) && file.conflict)
      .map((file) => [file.path, resolutions[`${targetGroup.sessionId}:${file.path}`]] as const)
      .filter((entry): entry is readonly [string, Resolution] => entry[1] !== undefined)) : {};
    const input: PluginChangeReviewActionInput = {
      ...(targetGroup && !taskWide ? { agentSessionId: targetGroup.sessionId } : {}),
      ...(files ? { files } : {}),
      ...(Object.keys(groupResolutions).length > 0 ? { resolutions: groupResolutions } : {})
    };
    requestInFlightRef.current = true;
    setMutating(true);
    setBusy(true);
    setError("");
    const actionEpoch = scopeEpochRef.current;
    try {
      const result = await invokeActionRef.current(actionId, input);
      if (!mountedRef.current || actionEpoch !== scopeEpochRef.current) return;
      setConfirmation(null);
      if (result.review) {
        // Mutations return the authoritative remaining scope. Pagination alone merges old entries.
        const available = new Set(result.review.groups.flatMap((candidate) =>
          candidate.files.map((file) => reviewFileKey(candidate.sessionId, file.path))));
        knownFileKeys.current = available;
        setSelectedFiles(new Set(available));
        setResolutions({});
        selectGroup(result.review.groups.find((candidate) => candidate.sessionId === selectedGroupId) ?? result.review.groups[0]);
        onReviewChangeRef.current(result.review);
      }
      else if (result.tone === "error" && actionEpoch === scopeEpochRef.current) setError(result.message ?? text.groupError);
      else if (result.tone !== "error" && !result.review) onActionResultRef.current(result);
    } catch (reason) {
      if (actionEpoch === scopeEpochRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      requestInFlightRef.current = false;
      if (mountedRef.current) setMutating(false);
      if (mountedRef.current && !refreshPendingRef.current) setBusy(false);
      if (refreshPendingRef.current) drainPendingRefreshRef.current();
    }
  };

  const dialog = <div className="plugin-changes-review__backdrop" data-interactive="true" onPointerDown={(event) => {
    if (event.target === event.currentTarget && !mutating) onClose();
  }}>
    <section ref={dialogRef} className="plugin-changes-review" role="dialog" aria-modal="true" aria-label={review.title || text.title} tabIndex={-1}>
      <header className="plugin-changes-review__header">
        <div><strong>{review.title || text.title}</strong><span>{text.card}: {cardSessionId}</span></div>
        <button type="button" disabled={mutating} onClick={onClose} aria-label={text.close}>×</button>
      </header>
      <div className="plugin-changes-review__body">
        {review.groups.length > 1 && <label className="plugin-changes-review__group-picker">{text.group}
          <select value={group?.sessionId ?? ""} disabled={interactionBlocked}
            onChange={(event) => selectGroup(review.groups.find((candidate) => candidate.sessionId === event.currentTarget.value))}>
            {review.groups.map((candidate) => <option key={candidate.sessionId} value={candidate.sessionId}>
              {candidate.title} · {candidate.files.length} {text.files.toLocaleLowerCase(locale)}
            </option>)}
          </select>
        </label>}
        {group?.error && <p className="plugin-changes-review__error" role="alert">{group.error || text.groupError}</p>}
        {groupFiles.length === 0 && !group?.error && <p className="plugin-changes-review__empty">{text.noFiles}</p>}
        {groupFiles.length > 0 && <>
          <div className="plugin-changes-review__file-selection">
            <button type="button" disabled={interactionBlocked} onClick={() => setGroupSelection(true)}>{text.selectAllFiles}</button>
            <button type="button" disabled={interactionBlocked || selectedGroupPaths.length === 0} onClick={() => setGroupSelection(false)}>{text.clearSelection}</button>
            <span>{tt(text.selected)}</span>
          </div>
          <ol ref={fileListRef} className="plugin-changes-review__files" aria-label={text.files}
            data-total-files={groupFiles.length}
            onScroll={(event) => setFileListScrollTop(event.currentTarget.scrollTop)} onKeyDown={onFileListKeyDown}>
            {fileWindow.topSpacerHeight > 0 && <li className="plugin-changes-review__files-spacer" aria-hidden="true" style={{ height: fileWindow.topSpacerHeight }} />}
            {visibleFiles.map((file, index) => {
              const checked = selectedFiles.has(reviewFileKey(group?.sessionId ?? "", file.path));
              const active = activeFileKey === reviewFileKey(group?.sessionId ?? "", file.path);
              return <li key={`${group?.sessionId}:${file.path}`} data-file-path={file.path} data-file-index={fileWindow.startIndex + index}
                aria-setsize={groupFiles.length} aria-posinset={fileWindow.startIndex + index + 1}>
                <div className={`plugin-changes-review__file-row${active ? " is-active" : ""}`}>
                  <input type="checkbox" checked={checked} disabled={interactionBlocked}
                    aria-label={`${file.path} ${text.files.toLocaleLowerCase(locale)}`}
                    onChange={(event) => group && setFileSelected(group.sessionId, file.path, event.currentTarget.checked)} />
                  <button type="button" className="plugin-changes-review__file-open" aria-pressed={active}
                    tabIndex={active ? 0 : -1} disabled={interactionBlocked} onClick={() => openFile(file)} title={file.path}>
                    <code>{file.path}</code><span>{text.viewDiff}</span>
                  </button>
                  {file.status && <small>{file.status}</small>}
                </div>
              </li>;
            })}
            {fileWindow.bottomSpacerHeight > 0 && <li className="plugin-changes-review__files-spacer" aria-hidden="true" style={{ height: fileWindow.bottomSpacerHeight }} />}
          </ol>
          {activeFile && <section className="plugin-changes-review__file-preview" aria-label={`${text.viewDiff}: ${activeFile.path}`}>
            <header><code>{activeFile.path}</code>
              {activeFile.status && <span>{text.status}: {activeFile.status}</span>}
              {activeFile.conflict && <strong>{text.conflict}</strong>}
            </header>
            {activeFile.conflict && <section className="plugin-changes-review__conflict">
              <div className="plugin-changes-review__versions">
                {(["current", "agent"] as const).map((side) => {
                  const page = activeFile.conflict![side];
                  const resolutionId = `${group?.sessionId}:${activeFile.path}`;
                  return <label key={side} className="plugin-changes-review__version">
                    <span><input type="radio" name={`resolution:${resolutionId}`} value={side}
                      checked={resolutions[resolutionId] === side}
                      disabled={interactionBlocked || !selectedFiles.has(reviewFileKey(group?.sessionId ?? "", activeFile.path))}
                      onChange={() => setResolutions((current) => ({ ...current, [resolutionId]: side }))} />
                      {page.label || (side === "current" ? text.current : text.agent)} · {page.startLine}–{page.startLine + Math.max(0, page.text.split("\n").length - 1)} / {page.totalLines} {text.lines}</span>
                    <pre>{page.text || text.unavailable}</pre>
                  </label>;
                })}
              </div>
            </section>}
            {activeFile.diff && <pre className="plugin-changes-review__diff">{activeFile.diff}</pre>}
            {activeFile.truncated && <small className="plugin-changes-review__truncated">{text.truncated}</small>}
            {!fileReviewLoaded(activeFile) && <button type="button" disabled={interactionBlocked} onClick={() => void loadFilePage(activeFile)}>{text.loadDiff}</button>}
            {fileReviewLoaded(activeFile) && hasMoreFileContent(activeFile)
              && <button type="button" disabled={interactionBlocked} onClick={() => void loadFilePage(activeFile)}>{text.loadNextFilePage}</button>}
          </section>}
        </>}
        {review.nextOffset !== undefined && <button type="button" disabled={interactionBlocked} onClick={() => void loadTaskPage()}>{text.loadTaskPage}</button>}
      </div>
      {error && <p className="plugin-changes-review__error" role="alert">{error}</p>}
      {scopeStale && <button className="plugin-changes-review__refresh" type="button" disabled={busy}
        onClick={() => void invokeReview(undefined, true)}>{text.refreshReview}</button>}
      <footer className="plugin-changes-review__actions">
        <span>{tt(text.selected)}</span>
        {review.acceptActionId && group && <>
          <button type="button" disabled={interactionBlocked || selectedGroupPaths.length === 0 || hasUnloadedSelectedFile || hasUnresolvedSelectedConflict || hasMoreSelectedContent}
            onClick={(event) => requestConfirmation({ action: "accept-selected", groupId: group.sessionId }, event.currentTarget)}>{text.acceptSelected}</button>
          <button type="button" disabled={interactionBlocked || groupFiles.length === 0 || groupFiles.some((file) => !fileReviewLoaded(file) || hasMoreFileContent(file) || (file.conflict && !resolutions[`${group.sessionId}:${file.path}`]))}
            onClick={(event) => requestConfirmation({ action: "accept-all-group", groupId: group.sessionId }, event.currentTarget)}>{text.acceptAllGroup}</button>
          <button type="button" disabled={interactionBlocked || !taskWideAcceptAllowed} title={!taskWideAcceptAllowed ? text.taskAllUnavailable : undefined}
            onClick={(event) => requestConfirmation({ action: "accept-all-task" }, event.currentTarget)}>{text.acceptAllTask}</button>
        </>}
        {review.rejectActionId && group && <>
          <button type="button" disabled={interactionBlocked}
            onClick={(event) => requestConfirmation({ action: "reject-group", groupId: group.sessionId }, event.currentTarget)}>{text.rejectGroup}</button>
          <button type="button" disabled={interactionBlocked || review.groups.length === 0 || review.nextOffset !== undefined || review.groups.some((item) => Boolean(item.error))}
            onClick={(event) => requestConfirmation({ action: "reject-task" }, event.currentTarget)}>{text.rejectTask}</button>
        </>}
      </footer>
      {busy && <p className="plugin-changes-review__busy" role="status">{text.loading}</p>}
      {confirmation && <div className="plugin-changes-review__confirm" role="alertdialog" aria-label={confirmationMessage}>
        <p>{confirmationMessage}</p>
        <div><button type="button" autoFocus disabled={busy} onClick={() => void confirm()}>{text.confirm}</button>
          <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>{text.cancel}</button></div>
      </div>}
    </section>
  </div>;

  return createPortal(dialog, document.body);
}

function mergeReview(current: PluginChangeReview, next: PluginChangeReview, preserveTaskOffset: boolean): PluginChangeReview {
  const groups = new Map(current.groups.map((group) => [group.sessionId, group]));
  for (const incomingGroup of next.groups) {
    const previousGroup = groups.get(incomingGroup.sessionId);
    if (!previousGroup) { groups.set(incomingGroup.sessionId, incomingGroup); continue; }
    const files = new Map(previousGroup.files.map((file) => [file.path, file]));
    for (const incomingFile of incomingGroup.files) {
      const previousFile = files.get(incomingFile.path);
      if (!previousFile) { files.set(incomingFile.path, incomingFile); continue; }
      const sameOrNextDiffPage = incomingFile.page === undefined || previousFile.page === undefined
        || incomingFile.page <= previousFile.page || incomingFile.page === previousFile.page + 1;
      const conflict = incomingFile.conflict && previousFile.conflict
        ? {
          current: mergeTextPage(previousFile.conflict.current, incomingFile.conflict.current),
          agent: mergeTextPage(previousFile.conflict.agent, incomingFile.conflict.agent)
        }
        : incomingFile.conflict ?? previousFile.conflict;
      files.set(incomingFile.path, {
        ...previousFile,
        ...incomingFile,
        diff: incomingFile.page !== undefined && incomingFile.page > (previousFile.page ?? -1) && sameOrNextDiffPage
          ? `${previousFile.diff}${incomingFile.diff}` : incomingFile.diff || previousFile.diff,
        conflict,
        hasMore: incomingFile.hasMore,
        page: incomingFile.page ?? previousFile.page
      });
    }
    groups.set(incomingGroup.sessionId, { ...previousGroup, ...incomingGroup, files: [...files.values()] });
  }
  return {
    ...current,
    ...next,
    groups: [...groups.values()],
    nextOffset: next.nextOffset ?? (preserveTaskOffset ? current.nextOffset : undefined)
  };
}

function mergeTextPage(previous: PluginReviewTextPage, next: PluginReviewTextPage): PluginReviewTextPage {
  if (next.startLine <= previous.startLine) return next;
  const previousLines = previous.text.split("\n");
  const incomingLines = next.text.split("\n");
  const overlap = Math.max(0, previous.startLine + previousLines.length - next.startLine);
  return {
    ...next,
    text: [...previousLines, ...incomingLines.slice(overlap)].join("\n"),
    startLine: previous.startLine
  };
}

function reviewFileKey(sessionId: string, path: string): string {
  return `${sessionId}\0${path}`;
}
