import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LocaleId,
  PluginCardActionResult,
  PluginChangeReview,
  PluginChangeReviewFile,
  PluginChangeReviewGroup,
  PluginReviewTextPage
} from "../../../../shared/contracts";
import { CanvasMenuRow } from "../../components/CanvasMenuPrimitives";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { TaskReviewSessionTracker, virtualFileWindow, type PluginReviewRequest } from "./pluginReviewUiState";
import { focusCardOptions } from "./cardDialogFocus";
import { pluginReviewText, type PluginReviewText } from "./pluginReviewText";

/** Before the first row is measured: 3.2em rows at the dialog's 13px × --ui-scale font size. */
const DEFAULT_ROW_HEIGHT = 42;
const REVIEW_FILE_OVERSCAN = 4;

export type PluginChangeReviewActionInput = {
  agentSessionId?: string;
  files?: string[];
  resolutions?: Record<string, "current" | "agent">;
  offset?: number;
  file?: string;
  page?: number;
};

export interface PluginChangesReviewDialogProps {
  cardSessionId: string;
  /** The card's title or folder, shown under the review title. */
  cardTitle?: string;
  reviewActionId: string;
  review: PluginChangeReview;
  locale: LocaleId;
  invokeAction(actionId: string, input?: PluginChangeReviewActionInput): Promise<PluginCardActionResult>;
  onReviewChange(review: PluginChangeReview): void;
  onActionResult(result: PluginCardActionResult): void;
  onClose(): void;
}

type ConfirmationAction = "accept-selected" | "accept-all-group" | "accept-all-task" | "reject-group" | "reject-task";
type Resolution = "current" | "agent";
/**
 * What the person confirms, fixed when the confirmation opens: the target group, the files and the chosen versions.
 * Confirm sends exactly this, never the selection of a later moment.
 */
type Confirmation = {
  action: ConfirmationAction;
  groupId?: string;
  files?: string[];
  resolutions: Record<string, Resolution>;
};

const CONFIRMATION_TEXT: Record<ConfirmationAction, keyof PluginReviewText> = {
  "accept-selected": "confirmAcceptSelected",
  "accept-all-group": "confirmAcceptGroup",
  "accept-all-task": "confirmAcceptTask",
  "reject-group": "confirmRejectGroup",
  "reject-task": "confirmRejectTask"
};

/**
 * The change review a card action answered with (docs/plugins.md): rendered by App inside the themed tree as a native
 * modal dialog. Accept and reject are sent to the plugin only after an explicit confirmation in the footer.
 */
export function PluginChangesReviewDialog({
  cardSessionId,
  cardTitle,
  reviewActionId,
  review,
  locale,
  invokeAction,
  onReviewChange,
  onActionResult,
  onClose
}: PluginChangesReviewDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileListRef = useRef<HTMLOListElement>(null);
  const [selectedGroupId, setSelectedGroupId] = useState(review.groups[0]?.sessionId ?? "");
  const initialFileKeys = review.groups.flatMap((group) => group.files.map((file) => reviewFileKey(group.sessionId, file.path)));
  const knownFileKeys = useRef(new Set(initialFileKeys));
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => preselectedFileKeys(review.groups));
  const firstGroup = review.groups[0];
  const firstFile = firstGroup?.files.find((file) => file.conflict) ?? firstGroup?.files[0];
  const [activeFileKey, setActiveFileKey] = useState(() => firstGroup && firstFile
    ? reviewFileKey(firstGroup.sessionId, firstFile.path) : "");
  const [fileListScrollTop, setFileListScrollTop] = useState(0);
  const [fileListViewportHeight, setFileListViewportHeight] = useState(280);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
  const text = pluginReviewText(locale);
  const group = review.groups.find((candidate) => candidate.sessionId === selectedGroupId) ?? review.groups[0];
  const groupId = group?.sessionId ?? "";
  const groupFiles = group?.files ?? [];
  const activeFile = groupFiles.find((file) => reviewFileKey(groupId, file.path) === activeFileKey);
  const fileWindow = virtualFileWindow(groupFiles.length, fileListScrollTop, fileListViewportHeight, rowHeight, REVIEW_FILE_OVERSCAN);
  const visibleFiles = groupFiles.slice(fileWindow.startIndex, fileWindow.endIndex);
  const allFiles = useMemo(() => review.groups.flatMap((candidate) => candidate.files), [review.groups]);
  const allTaskPathsUnique = new Set(allFiles.map((file) => file.path)).size === allFiles.length;
  const hasMoreFileContent = (file: PluginChangeReviewFile): boolean => Boolean(file.hasMore
    || file.conflict?.current.hasMore || file.conflict?.agent.hasMore);
  const fileReviewLoaded = (file: PluginChangeReviewFile): boolean => file.page !== undefined;
  const taskWideAcceptAllowed = Boolean(review.acceptActionId && review.nextOffset === undefined && allFiles.length > 0 && allTaskPathsUnique
    && review.groups.every((candidate) => !candidate.error && candidate.active !== true && candidate.files.length > 0
      && candidate.files.every((file) => fileReviewLoaded(file) && !file.conflict && !hasMoreFileContent(file))));
  const selectedGroupFiles = groupFiles.filter((file) => selectedFiles.has(reviewFileKey(groupId, file.path)));
  const hasUnresolvedSelectedConflict = selectedGroupFiles.some((file) => file.conflict && !resolutions[reviewFileKey(groupId, file.path)]);
  const selectedGroupPaths = selectedGroupFiles.map((file) => file.path);
  const hasUnloadedSelectedFile = selectedGroupFiles.some((file) => !fileReviewLoaded(file));
  const hasMoreSelectedContent = selectedGroupFiles.some(hasMoreFileContent);
  const interactionBlocked = busy || scopeStale;
  // While a confirmation is open the person confirms a fixed set: the group, the files and the versions stay put.
  const selectionLocked = interactionBlocked || confirmation !== null;
  // A group whose agent is still working (`active`): the plugin refuses accepting all of its files and rejecting it,
  // so those actions are disabled here too; a part of its files can still be accepted.
  const groupActive = group?.active === true;
  const acceptsWholeActiveGroup = groupActive && groupFiles.length > 0 && selectedGroupPaths.length === groupFiles.length;
  const acceptSelectedAllowed = !interactionBlocked && selectedGroupPaths.length > 0 && !hasUnloadedSelectedFile
    && !hasUnresolvedSelectedConflict && !hasMoreSelectedContent && !acceptsWholeActiveGroup;
  const acceptGroupAllowed = !interactionBlocked && !groupActive && groupFiles.length > 0 && groupFiles.every((file) => fileReviewLoaded(file)
    && !hasMoreFileContent(file) && (!file.conflict || resolutions[reviewFileKey(groupId, file.path)]));
  const rejectGroupAllowed = !interactionBlocked && !groupActive;
  const rejectTaskAllowed = !interactionBlocked && review.groups.length > 0 && review.nextOffset === undefined
    && !review.groups.some((item) => Boolean(item.error) || item.active === true);
  const allSelected = groupFiles.length > 0 && selectedGroupPaths.length === groupFiles.length;
  const someSelected = selectedGroupPaths.length > 0 && !allSelected;

  useEffect(() => {
    setSelectedGroupId((current) => review.groups.some((candidate) => candidate.sessionId === current)
      ? current : review.groups[0]?.sessionId ?? "");
    setSelectedFiles((current) => {
      const available = new Set(review.groups.flatMap((candidate) => candidate.files.map((file) => reviewFileKey(candidate.sessionId, file.path))));
      const next = new Set([...current].filter((path) => available.has(path)));
      for (const path of preselectedFileKeys(review.groups)) if (!knownFileKeys.current.has(path)) next.add(path);
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
    const element = dialogRef.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    const list = fileListRef.current;
    if (!list) return;
    const measure = (): void => {
      setFileListViewportHeight(list.clientHeight);
      // Rows are sized in em, so their height follows --ui-scale: the window math uses the rendered height.
      const row = list.querySelector<HTMLElement>("[data-file-index]");
      const height = row?.getBoundingClientRect().height;
      if (height && height > 0) setRowHeight(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [groupId, groupFiles.length > 0]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    };
  }, []);

  const setFileSelected = (path: string, selected: boolean): void => {
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

  const focusFileAt = (index: number): void => {
    if (!group || groupFiles.length === 0) return;
    const nextIndex = Math.max(0, Math.min(groupFiles.length - 1, index));
    setActiveFileKey(reviewFileKey(group.sessionId, groupFiles[nextIndex].path));
    const list = fileListRef.current;
    if (list) {
      list.scrollTop = Math.min(nextIndex * rowHeight, list.scrollHeight - list.clientHeight);
      setFileListScrollTop(list.scrollTop);
    }
    window.requestAnimationFrame(() => {
      const row = [...(fileListRef.current?.querySelectorAll<HTMLElement>("[data-file-index]") ?? [])]
        .find((candidate) => Number(candidate.dataset.fileIndex) === nextIndex);
      row?.querySelector<HTMLButtonElement>(".plugin-review__file-open")?.focus({ preventScroll: true });
    });
  };

  const onFileListKeyDown = (event: React.KeyboardEvent<HTMLOListElement>): void => {
    if (!groupFiles.length) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-file-index]") : null;
    const activeIndex = target ? Number(target.dataset.fileIndex)
      : groupFiles.findIndex((file) => reviewFileKey(groupId, file.path) === activeFileKey);
    const current = activeIndex < 0 ? 0 : activeIndex;
    const page = Math.max(1, Math.floor(fileListViewportHeight / rowHeight));
    let next = current;
    if (event.key === "ArrowDown") next = current + 1;
    else if (event.key === "ArrowUp") next = current - 1;
    else if (event.key === "PageDown") next = current + page;
    else if (event.key === "PageUp") next = current - page;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = groupFiles.length - 1;
    else return;
    event.preventDefault();
    focusFileAt(next);
  };

  /** A failed call to the plugin: the person gets a localized line, the details go to the log. */
  const failed = (reason: unknown): void => {
    console.error("Change review request failed", reason);
    setError(text.requestFailed);
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
          setSelectedFiles(preselectedFileKeys(result.review.groups));
          setResolutions({});
          setConfirmation(null);
          setScopeStale(false);
          selectGroup(result.review.groups.find((candidate) => candidate.sessionId === selectedGroupId) ?? result.review.groups[0]);
          onReviewChangeRef.current(result.review);
        } else {
          onReviewChangeRef.current(mergeReview(reviewRef.current, result.review, input?.offset === undefined));
        }
      } else if (replaceScope || result.tone === "error") setError(result.message ?? text.groupError);
      else onActionResultRef.current(result);
    } catch (reason) {
      if (mountedRef.current && requestEpoch === scopeEpochRef.current) failed(reason);
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

  // A subagent of this card finished or started a turn: the scope may have changed, so the review is fetched again
  // and any pending confirmation is dropped.
  const queueScopeRefresh = (): void => {
    scopeEpochRef.current += 1;
    confirmationEpochRef.current = -1;
    setConfirmation(null);
    setMenuOpen(false);
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
  }, [groupId, activeFile?.path, activeFile?.page]);

  const loadTaskPage = async (): Promise<void> => {
    if (reviewRef.current.nextOffset === undefined) return;
    await invokeReview({ offset: reviewRef.current.nextOffset });
  };

  const loadFilePage = async (file: PluginChangeReviewFile): Promise<void> => {
    if (!group) return;
    await invokeReview({ agentSessionId: group.sessionId, file: file.path, page: file.page === undefined ? 0 : file.page + 1 });
  };

  const fullGroupAction = confirmation?.action === "accept-all-group" || confirmation?.action === "reject-group"
    || (confirmation?.action === "accept-selected"
      && confirmation.files?.length === review.groups.find((candidate) => candidate.sessionId === confirmation.groupId)?.files.length);
  const fullAction = fullGroupAction || confirmation?.action === "accept-all-task" || confirmation?.action === "reject-task";
  const confirmationMessage = confirmation
    ? `${text[CONFIRMATION_TEXT[confirmation.action]]}${fullAction ? ` ${text.cleanupWarning}` : ""}`
    : "";
  const confirmationDanger = confirmation?.action.startsWith("reject") === true;

  /** The files and versions an action applies to, from the selection of this moment. */
  const confirmationFor = (action: ConfirmationAction, targetGroupId?: string): Confirmation => {
    const targetGroup = targetGroupId ? review.groups.find((candidate) => candidate.sessionId === targetGroupId) : undefined;
    const accepting = action.startsWith("accept");
    const files = action === "accept-selected"
      ? (targetGroup?.files ?? []).filter((file) => selectedFiles.has(reviewFileKey(targetGroup!.sessionId, file.path))).map((file) => file.path)
      : accepting ? (action === "accept-all-task" ? allFiles.map((file) => file.path) : targetGroup?.files.map((file) => file.path) ?? [])
        : undefined;
    const chosen: Record<string, Resolution> = {};
    for (const file of targetGroup?.files ?? []) {
      const resolution = resolutions[reviewFileKey(targetGroup!.sessionId, file.path)];
      if (file.conflict && resolution && files?.includes(file.path)) chosen[file.path] = resolution;
    }
    return { action, ...(targetGroupId ? { groupId: targetGroupId } : {}), ...(files ? { files } : {}), resolutions: chosen };
  };

  const requestConfirmation = (action: ConfirmationAction, targetGroupId?: string): void => {
    confirmationEpochRef.current = scopeEpochRef.current;
    setMenuOpen(false);
    setConfirmation(confirmationFor(action, targetGroupId));
  };

  /** A confirmed accept still matches the review: its files exist and every conflict among them has a version. */
  const confirmationStillValid = (pending: Confirmation): boolean => {
    if (!pending.action.startsWith("accept") || !pending.files) return true;
    const scope = pending.action === "accept-all-task" ? allFiles
      : review.groups.find((candidate) => candidate.sessionId === pending.groupId)?.files ?? [];
    const byPath = new Map(scope.map((file) => [file.path, file]));
    return pending.files.length > 0 && pending.files.every((path) => {
      const file = byPath.get(path);
      return file !== undefined && (!file.conflict || pending.resolutions[path] !== undefined);
    });
  };

  const confirm = async (): Promise<void> => {
    const pending = confirmation;
    if (!pending) return;
    if (confirmationEpochRef.current !== scopeEpochRef.current || requestInFlightRef.current || mutating) {
      setConfirmation(null);
      return;
    }
    if (!confirmationStillValid(pending)) {
      setConfirmation(null);
      setError(text.selectionChanged);
      return;
    }
    const accepting = pending.action.startsWith("accept");
    const actionId = accepting ? review.acceptActionId : review.rejectActionId;
    if (!actionId) { setError(text.actionUnavailable); return; }
    const taskWide = pending.action.endsWith("task");
    const input: PluginChangeReviewActionInput = {
      ...(pending.groupId && !taskWide ? { agentSessionId: pending.groupId } : {}),
      ...(pending.files ? { files: pending.files } : {}),
      ...(Object.keys(pending.resolutions).length > 0 ? { resolutions: pending.resolutions } : {})
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
        // A mutation answers with the authoritative remaining scope; only pagination merges into the old one.
        const available = new Set(result.review.groups.flatMap((candidate) =>
          candidate.files.map((file) => reviewFileKey(candidate.sessionId, file.path))));
        knownFileKeys.current = available;
        setSelectedFiles(preselectedFileKeys(result.review.groups));
        setResolutions({});
        selectGroup(result.review.groups.find((candidate) => candidate.sessionId === selectedGroupId) ?? result.review.groups[0]);
        onReviewChangeRef.current(result.review);
      } else if (result.tone === "error") setError(result.message ?? text.groupError);
      else onActionResultRef.current(result);
    } catch (reason) {
      if (actionEpoch === scopeEpochRef.current) failed(reason);
    } finally {
      requestInFlightRef.current = false;
      if (mountedRef.current) setMutating(false);
      if (mountedRef.current && !refreshPendingRef.current) setBusy(false);
      if (refreshPendingRef.current) drainPendingRefreshRef.current();
    }
  };

  // Escape and the backdrop step back one level: the overflow menu, then a pending confirmation, then the dialog.
  const dismiss = (): void => {
    if (mutating) return;
    if (menuOpen) setMenuOpen(false);
    else if (confirmation) setConfirmation(null);
    else onClose();
  };

  // The overflow menu takes focus on its first enabled row; Arrow Up/Down move between enabled rows.
  const menuRows = (menu: HTMLElement): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
  const focusFirstMenuRow = (menu: HTMLDivElement | null): void => {
    if (menu && !menu.contains(document.activeElement)) menuRows(menu)[0]?.focus();
  };
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = menuRows(event.currentTarget);
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    rows[index < 0 ? 0 : (index + step + rows.length) % rows.length]!.focus();
  };

  const title = review.title || text.title;
  const selectedCount = text.selected.replace("{count}", String(selectedGroupPaths.length));
  const activeKey = activeFile ? reviewFileKey(groupId, activeFile.path) : "";
  const activeSelected = Boolean(activeFile) && selectedFiles.has(activeKey);

  return (
    <dialog ref={dialogRef} className="card-dialog plugin-review" aria-labelledby="plugin-review-title"
      data-interactive="true" data-canvas-wheel-priority="local"
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
        else if (menuOpen && !(event.target instanceof Element && event.target.closest(".plugin-review__more"))) setMenuOpen(false);
      }}>
      <div className="card-dialog__panel">
        <header className="card-dialog__header">
          <div>
            <h2 id="plugin-review-title">{title}</h2>
            {cardTitle && !reviewTitleNamesCard(title, cardTitle, locale) && <p title={cardTitle}>{cardTitle}</p>}
          </div>
          <button type="button" className="card-dialog__icon-button" disabled={mutating} onClick={onClose}
            aria-label={t(locale, "close")} title={t(locale, "close")}>
            <UiIcon name="close" size="1.35em" />
          </button>
        </header>

        {review.groups.length > 1 && (
          <div className="segmented plugin-review__groups" role="group" aria-label={text.subtasks}>
            {review.groups.map((candidate) => (
              <button key={candidate.sessionId} type="button" aria-pressed={candidate.sessionId === groupId}
                className={`segmented__button${candidate.sessionId === groupId ? " segmented__button--active" : ""}`}
                disabled={selectionLocked} onClick={() => selectGroup(candidate)}>
                {candidate.title} · {candidate.files.length}
              </button>
            ))}
          </div>
        )}

        {group?.error && (groupActive
          ? <p className="plugin-review__warning plugin-review__notice" role="status">{group.error}</p>
          : <p className="card-dialog__error plugin-review__warning" role="alert">{group.error}</p>)}
        {groupFiles.length === 0 && !group?.error && <p className="plugin-review__empty">{text.noFiles}</p>}
        <div className="plugin-review__body">
          {groupFiles.length > 0 && (
            <section className="plugin-review__files" aria-label={text.files}>
              <label className="plugin-review__select-all">
                <input type="checkbox" checked={allSelected} disabled={selectionLocked}
                  ref={(element) => { if (element) element.indeterminate = someSelected; }}
                  onChange={() => setGroupSelection(!allSelected)} />
                <span>{text.selectAll}</span>
              </label>
              <ol ref={fileListRef} className="plugin-review__file-list" aria-label={text.files}
                data-total-files={groupFiles.length}
                onScroll={(event) => setFileListScrollTop(event.currentTarget.scrollTop)} onKeyDown={onFileListKeyDown}>
                {fileWindow.topSpacerHeight > 0 && <li className="plugin-review__spacer" aria-hidden="true" style={{ height: fileWindow.topSpacerHeight }} />}
                {visibleFiles.map((file, index) => {
                  const key = reviewFileKey(groupId, file.path);
                  const active = activeFileKey === key;
                  return (
                    <li key={key} data-file-path={file.path} data-file-index={fileWindow.startIndex + index}
                      aria-setsize={groupFiles.length} aria-posinset={fileWindow.startIndex + index + 1}
                      className={`plugin-review__file-row${active ? " plugin-review__file-row--active" : ""}`}>
                      <input type="checkbox" checked={selectedFiles.has(key)} disabled={selectionLocked} aria-label={file.path}
                        onChange={(event) => setFileSelected(file.path, event.currentTarget.checked)} />
                      <button type="button" className="plugin-review__file-open" aria-current={active ? "true" : undefined}
                        tabIndex={active ? 0 : -1} disabled={interactionBlocked} title={file.path}
                        onClick={() => setActiveFileKey(key)}>
                        <UiIcon name={file.conflict ? "attention" : "file"} size="1.05em" />
                        <code>{file.path}</code>
                      </button>
                      {file.status && <small>{statusLabel(file.status, text)}</small>}
                    </li>
                  );
                })}
                {fileWindow.bottomSpacerHeight > 0 && <li className="plugin-review__spacer" aria-hidden="true" style={{ height: fileWindow.bottomSpacerHeight }} />}
              </ol>
              {review.nextOffset !== undefined && (
                <button type="button" className="card-dialog__secondary" disabled={interactionBlocked} onClick={() => void loadTaskPage()}>
                  {text.moreFiles}
                </button>
              )}
            </section>
          )}

          {activeFile && (
            <section className="plugin-review__preview" aria-label={activeFile.path}>
              <header>
                <code>{activeFile.path}</code>
                {activeFile.status && <span>{statusLabel(activeFile.status, text)}</span>}
              </header>
              {activeFile.conflict && (
                <div className="plugin-review__conflict">
                  <p className="plugin-review__conflict-note">
                    <UiIcon name="attention" size="1.1em" />
                    <span>{text.conflict}</span>
                  </p>
                  <div className="segmented plugin-review__versions" role="group" aria-label={text.keepVersion}>
                    {(["current", "agent"] as const).map((side) => {
                      const chosen = resolutions[activeKey] === side;
                      return (
                        <button key={side} type="button" aria-pressed={chosen}
                          className={`segmented__button${chosen ? " segmented__button--active" : ""}`}
                          disabled={selectionLocked || !activeSelected}
                          onClick={() => setResolutions((current) => ({ ...current, [activeKey]: side }))}>
                          {text[side === "current" ? "current" : "agent"]}
                        </button>
                      );
                    })}
                  </div>
                  <div className="plugin-review__sides">
                    {(["current", "agent"] as const).map((side) => {
                      const page = activeFile.conflict![side];
                      return (
                        <figure key={side}>
                          <figcaption>
                            {page.label || text[side === "current" ? "current" : "agent"]}
                            {" · "}{pageRange(page)}
                          </figcaption>
                          <pre>{page.text || text.conflictUnavailable}</pre>
                        </figure>
                      );
                    })}
                  </div>
                </div>
              )}
              {activeFile.diff && <DiffText diff={activeFile.diff} />}
              {activeFile.truncated && <p className="card-dialog__muted">{text.truncated}</p>}
              {!fileReviewLoaded(activeFile) && (
                <button type="button" className="card-dialog__secondary" disabled={interactionBlocked} onClick={() => void loadFilePage(activeFile)}>
                  {text.loadDiff}
                </button>
              )}
              {fileReviewLoaded(activeFile) && hasMoreFileContent(activeFile) && (
                <button type="button" className="card-dialog__secondary" disabled={interactionBlocked} onClick={() => void loadFilePage(activeFile)}>
                  {text.nextPage}
                </button>
              )}
            </section>
          )}
        </div>

        {(error || scopeStale) && (
          <div className="plugin-review__status-row">
            {error && <p className="card-dialog__error" role="alert">{error}</p>}
            {scopeStale && (
              <button type="button" className="card-dialog__secondary" disabled={busy} onClick={() => void invokeReview(undefined, true)}>
                {text.refresh}
              </button>
            )}
          </div>
        )}

        {confirmation ? (
          <footer className="card-dialog__footer card-dialog__footer--confirm" role="alertdialog" aria-label={confirmationMessage}>
            <p>{confirmationMessage}</p>
            <div className="card-dialog__actions">
              {busy && <span className="card-dialog__busy" role="status" aria-label={text.working}><UiIcon name="working" size="1.2em" /></span>}
              <button type="button" className="card-dialog__secondary" disabled={busy} onClick={() => setConfirmation(null)}>{t(locale, "back")}</button>
              <button type="button" autoFocus disabled={busy}
                className={confirmationDanger ? "card-dialog__danger" : "card-dialog__primary"} onClick={() => void confirm()}>
                {text.confirm}
              </button>
            </div>
          </footer>
        ) : (
          <footer className="card-dialog__footer">
            <span className="card-dialog__muted">{selectedCount}</span>
            <div className="card-dialog__actions">
              {busy && <span className="card-dialog__busy" role="status" aria-label={text.working}><UiIcon name="working" size="1.2em" /></span>}
              {(review.acceptActionId || review.rejectActionId) && group && (
                <div className="plugin-review__more">
                  <button type="button" className="card-dialog__icon-button" aria-haspopup="menu" aria-expanded={menuOpen}
                    aria-label={text.moreActions} title={text.moreActions} disabled={interactionBlocked}
                    onClick={() => setMenuOpen((open) => !open)}>
                    <UiIcon name="ellipsis" size="1.25em" />
                  </button>
                  {menuOpen && (
                    <div className="canvas-menu plugin-review__menu" role="menu" ref={focusFirstMenuRow}
                      onKeyDown={onMenuKeyDown}>
                      {review.acceptActionId && <>
                        <CanvasMenuRow role="menuitem" disabled={!acceptGroupAllowed}
                          onClick={() => requestConfirmation("accept-all-group", group.sessionId)}>
                          {text.acceptGroup}
                        </CanvasMenuRow>
                        <CanvasMenuRow role="menuitem" disabled={interactionBlocked || !taskWideAcceptAllowed}
                          title={taskWideAcceptAllowed ? undefined : text.acceptTaskUnavailable}
                          onClick={() => requestConfirmation("accept-all-task")}>
                          {text.acceptTask}
                        </CanvasMenuRow>
                      </>}
                      {review.rejectActionId && (
                        <CanvasMenuRow role="menuitem" danger disabled={!rejectTaskAllowed}
                          onClick={() => requestConfirmation("reject-task")}>
                          {text.rejectTask}
                        </CanvasMenuRow>
                      )}
                    </div>
                  )}
                </div>
              )}
              {review.rejectActionId && group && (
                <button type="button" className="card-dialog__secondary" disabled={!rejectGroupAllowed}
                  title={groupActive ? text.activeReject : undefined}
                  onClick={() => requestConfirmation("reject-group", group.sessionId)}>
                  {text.reject}
                </button>
              )}
              {review.acceptActionId && group && (
                <button type="button" className="card-dialog__primary" disabled={!acceptSelectedAllowed}
                  title={acceptsWholeActiveGroup ? text.activeAcceptAll : undefined}
                  onClick={() => requestConfirmation("accept-selected", group.sessionId)}>
                  {text.acceptSelected}
                </button>
              )}
            </div>
          </footer>
        )}
      </div>
    </dialog>
  );
}

/** Git's short and long change statuses in the person's language; anything else is shown as the plugin wrote it. */
const STATUS_TEXT: Record<string, keyof PluginReviewText> = {
  A: "statusAdded", added: "statusAdded",
  M: "statusModified", modified: "statusModified",
  D: "statusDeleted", deleted: "statusDeleted",
  R: "statusRenamed", renamed: "statusRenamed"
};

function statusLabel(status: string, text: PluginReviewText): string {
  const key = STATUS_TEXT[status.trim()] ?? STATUS_TEXT[status.trim().toLowerCase()];
  return key ? text[key] : status;
}

/**
 * App's entry to the review (loaded with this module on demand): wires the request a card action answered with to the
 * plugin call, keeps the review current and returns focus to the card's options button when the dialog closes.
 */
export function PluginReviewHost({ request, locale, setRequest, showToast }: {
  request: PluginReviewRequest;
  locale: LocaleId;
  setRequest: React.Dispatch<React.SetStateAction<PluginReviewRequest | null>>;
  showToast(message: string): void;
}): React.JSX.Element {
  return (
    <PluginChangesReviewDialog
      key={`${request.sessionId}:${request.pluginId}:${request.actionId}`}
      cardSessionId={request.sessionId}
      cardTitle={request.cardTitle}
      reviewActionId={request.actionId}
      review={request.review}
      locale={locale}
      invokeAction={(actionId, input) => window.canvasTTY.plugins.invokeCardAction(request.pluginId, actionId, request.sessionId, input)}
      onReviewChange={(review) => setRequest((current) => current && { ...current, review })}
      onActionResult={(result) => { if (result.message) showToast(result.message); }}
      onClose={() => {
        setRequest(null);
        focusCardOptions(request.sessionId);
      }} />
  );
}

/**
 * Whether the review title already names the card, so the card's title is not repeated under it. A plain terminal's
 * default title starts with the English word ("Terminal · project"); a plugin may name it in the app's language.
 */
function reviewTitleNamesCard(title: string, cardTitle: string, locale: LocaleId): boolean {
  return title.includes(cardTitle) || title.includes(cardTitle.replace(/^Terminal(?= · )/u, t(locale, "terminal")));
}

function pageRange(page: PluginReviewTextPage): string {
  return `${page.startLine}–${page.startLine + Math.max(0, page.text.split("\n").length - 1)} / ${page.totalLines}`;
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

/**
 * The files selected when a review opens or its scope is replaced: every file, except those of a group whose agent
 * is still working (`active`). All of them together could not be accepted yet, so the person picks the part to take.
 */
function preselectedFileKeys(groups: readonly PluginChangeReviewGroup[]): Set<string> {
  return new Set(groups.filter((group) => group.active !== true)
    .flatMap((group) => group.files.map((file) => reviewFileKey(group.sessionId, file.path))));
}

/** A unified diff, each line tinted by its role: added, removed, hunk or file header, context. */
function DiffText({ diff }: { diff: string }) {
  const lines = useMemo(() => diffLines(diff), [diff]);
  return (
    <pre className="plugin-review__diff">
      <code>
        {lines.map(([kind, line], index) => (
          <span key={index} className={`plugin-review__line plugin-review__line--${kind}`}>{line}{"\n"}</span>
        ))}
      </code>
    </pre>
  );
}

type DiffLineKind = "meta" | "hunk" | "added" | "removed" | "context";

/** Inside a hunk a line's first character is its role; before the first hunk of a file every line is a header. */
function diffLines(diff: string): Array<[DiffLineKind, string]> {
  let inHunk = false;
  return diff.replace(/\n$/u, "").split("\n").map((line): [DiffLineKind, string] => {
    if (line.startsWith("diff ")) inHunk = false;
    if (line.startsWith("@@")) {
      inHunk = true;
      return ["hunk", line];
    }
    if (!inHunk) return ["meta", line];
    if (line.startsWith("+")) return ["added", line];
    if (line.startsWith("-")) return ["removed", line];
    return ["context", line];
  });
}
