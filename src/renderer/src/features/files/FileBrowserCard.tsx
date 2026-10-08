import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type {
  FileEntry,
  FileRootDescriptor,
  LocaleId,
  Point,
  SessionBounds
} from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { filesLayerId } from "../workspace/canvasSelectionGesture";
import { filesCanvasWidgetId } from "../workspace/canvasWidgetFocus";
import { snapMove, snapResize, type ResizeDirection } from "../workspace/snap";
import { buildFileTree, flattenFileTree, type FileTreeNode } from "./fileTree";
import { resolveActiveFileRead, type FileReadBinding } from "./fileViewer";

// The rich renderers pull in react-markdown / rehype / lowlight. Lazy-load them
// so their weight stays out of the app's static import graph (see
// tests/renderer-bundle-splitting.test.mjs) and is only fetched when a rich file
// is actually opened.
const MarkdownView = lazy(() => import("./MarkdownView").then((module) => ({ default: module.MarkdownView })));
const CodeView = lazy(() => import("./CodeView").then((module) => ({ default: module.CodeView })));

/** A selectable terminal session working directory offered as a Files root. */
export interface FileSessionOption {
  sessionId: string;
  label: string;
}

/**
 * The Files card is strictly presentational: every piece of data and every
 * action arrives through props. IPC, tree loading, root registration, search,
 * and persistence are owned by the parent (WorkspaceCanvas / App).
 */
export interface FileBrowserCardProps {
  /** Stable identity; the card renders `data-canvas-layer-id="files:<cardId>"`. */
  cardId: string;
  bounds: SessionBounds;
  /** Opaque root handle; null means the card still needs a root selected. */
  root: FileRootDescriptor | null;
  /** Sessions offered as session roots while no root is selected. */
  sessionOptions?: readonly FileSessionOption[];
  /** Root directory listing. */
  entries: readonly FileEntry[];
  /** Loaded child listings keyed by directory relative path. */
  childrenByDirectory?: Readonly<Record<string, readonly FileEntry[]>>;
  /** Relative paths of expanded tree folders. */
  expandedFolders: readonly string[];
  /** Relative path of the file shown in the viewer, or null. */
  activeFile: string | null;
  /**
   * Read result together with the relative path it was read for. Content is
   * shown only when `readResult.relativePath === activeFile`; any mismatch (a
   * read still in flight for a newly selected file) renders loading instead.
   */
  readResult: FileReadBinding | null;
  /** True while a listing, read, or search is in flight. */
  loading: boolean;
  /** Error text for the last failed operation, or null. */
  error: string | null;
  /** True when a restored root can no longer be read. */
  rootUnavailable: boolean;
  quickOpenQuery: string;
  quickOpenResults: readonly string[];
  /** Increments when the parent requests focus for this card's quick-open input. */
  quickOpenFocusRequest?: number;
  locale: LocaleId;
  zoom: number;
  stackIndex: number;
  snapEnabled: boolean;
  getSnapTargets(): readonly SessionBounds[];
  onChooseFolder(): void;
  onRegisterSession(sessionId: string): void;
  onOpenDirectory(relativePath: string): void;
  onOpenFile(relativePath: string): void;
  onQuickOpen(query: string): void;
  onChangeBounds(bounds: SessionBounds): void;
  onClose(): void;
  /** Opens a link from a rendered markdown file. */
  onOpenLink?: (href: string) => void;
  /** True while this card is part of the marquee selection. */
  groupSelected?: boolean;
}

interface DragState {
  pointerId: number;
  startClient: Point;
  startBounds: SessionBounds;
  snapTargets: readonly SessionBounds[];
}

interface ResizeState extends DragState {
  direction: ResizeDirection;
}

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const EMPTY_CHILDREN: Readonly<Record<string, readonly FileEntry[]>> = {};

export function FileBrowserCard({
  cardId,
  bounds,
  root,
  sessionOptions = [],
  entries,
  childrenByDirectory = EMPTY_CHILDREN,
  expandedFolders,
  activeFile,
  readResult,
  loading,
  error,
  rootUnavailable,
  quickOpenQuery,
  quickOpenResults,
  quickOpenFocusRequest = 0,
  locale,
  zoom,
  stackIndex,
  snapEnabled,
  getSnapTargets,
  onChooseFolder,
  onRegisterSession,
  onOpenDirectory,
  onOpenFile,
  onQuickOpen,
  onChangeBounds,
  onClose,
  onOpenLink = () => {},
  groupSelected = false
}: FileBrowserCardProps): React.JSX.Element {
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const quickOpenInput = useRef<HTMLInputElement>(null);
  const initialBounds = constrainFileBrowserResize({ position: bounds.position, size: bounds.size }, "se");
  const [position, setPosition] = useState(initialBounds.position);
  const [size, setSize] = useState(initialBounds.size);
  const liveBounds = useRef<SessionBounds>(initialBounds);
  const summaryMode = zoom < 0.5;
  const summaryScale = summaryMode ? Math.min(2.5, Math.max(1, 0.5 / zoom)) : 1;

  const tree: FileTreeNode[] = useMemo(
    () => buildFileTree(entries, childrenByDirectory),
    [childrenByDirectory, entries]
  );
  const rows = useMemo(
    () => flattenFileTree(tree, expandedFolders),
    [expandedFolders, tree]
  );
  const viewer = resolveActiveFileRead(activeFile, readResult);
  const activeName = activeFile ? basename(activeFile) : null;
  const treeTitle = root?.label ?? t(locale, "files");
  const headerDetail = activeName ?? (root ? t(locale, "filesNoFile") : t(locale, "filesSelectRoot"));
  const trimmedQuery = quickOpenQuery.trim();
  const unsupportedText = viewer?.kind === "unsupported"
    ? unsupportedReasonText(locale, viewer.reason)
    : "";
  const textContent = viewer?.kind === "text" ? viewer.content : null;
  const textRenderKind = viewer?.kind === "text" ? viewer.renderKind : null;
  const textLanguage = viewer?.kind === "text" ? viewer.language : null;
  const textRichDisabled = viewer?.kind === "text" ? viewer.richDisabled : false;
  const richView = useMemo(() => {
    if (textContent === null || textRichDisabled) return null;
    if (textRenderKind === "markdown") return <MarkdownView content={textContent} onOpenLink={onOpenLink} />;
    if (textRenderKind === "code") return <CodeView content={textContent} language={textLanguage} />;
    return null;
  }, [textContent, textRenderKind, textLanguage, textRichDisabled, onOpenLink]);

  useEffect(() => {
    const next = constrainFileBrowserResize({ position: bounds.position, size: bounds.size }, "se");
    liveBounds.current = next;
    setPosition(next.position);
    setSize(next.size);
  }, [bounds]);

  useEffect(() => {
    if (quickOpenFocusRequest > 0) quickOpenInput.current?.focus();
  }, [quickOpenFocusRequest]);

  const applyBounds = (next: SessionBounds): void => {
    liveBounds.current = next;
    setPosition(next.position);
    setSize(next.size);
  };

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest("button, input, [data-file-action]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current,
      snapTargets: snapEnabled ? getSnapTargets() : []
    };
  };

  const drag = (event: React.PointerEvent<HTMLElement>): void => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // A buttonless move is a hover, not a drag.
    if (event.buttons === 0) return;
    const rawPosition = {
      x: state.startBounds.position.x + (event.clientX - state.startClient.x) / zoom,
      y: state.startBounds.position.y + (event.clientY - state.startClient.y) / zoom
    };
    applyBounds({
      position: snapEnabled ? snapMove(rawPosition, state.startBounds.size, state.snapTargets) : rawPosition,
      size: state.startBounds.size
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    onChangeBounds(liveBounds.current);
  };

  // A group drag takes pointer capture without a pointerup; drop local state so
  // a later hover cannot act on it.
  const cancelDrag = (): void => {
    dragState.current = null;
  };

  const cancelResize = (): void => {
    resizeState.current = null;
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeState.current = {
      pointerId: event.pointerId,
      direction,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current,
      snapTargets: snapEnabled ? getSnapTargets() : []
    };
  };

  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // A buttonless move is a hover, not a resize.
    if (event.buttons === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - state.startClient.x) / zoom;
    const deltaY = (event.clientY - state.startClient.y) / zoom;
    const raw: SessionBounds = {
      position: {
        x: state.startBounds.position.x + (state.direction.includes("w") ? deltaX : 0),
        y: state.startBounds.position.y + (state.direction.includes("n") ? deltaY : 0)
      },
      size: {
        width: state.startBounds.size.width
          + (state.direction.includes("e") ? deltaX : 0)
          - (state.direction.includes("w") ? deltaX : 0),
        height: state.startBounds.size.height
          + (state.direction.includes("s") ? deltaY : 0)
          - (state.direction.includes("n") ? deltaY : 0)
      }
    };
    const constrained = constrainFileBrowserResize(raw, state.direction);
    applyBounds(snapEnabled ? snapResize(constrained, state.direction, state.snapTargets) : constrained);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = null;
    onChangeBounds(liveBounds.current);
  };

  return (
    <article
      className={`file-browser-card ${summaryMode ? "file-browser-card--summary" : ""} ${groupSelected ? "file-browser-card--selected" : ""}`}
      data-interactive="true"
      data-canvas-layer-id={filesLayerId(cardId)}
      data-canvas-widget-id={filesCanvasWidgetId(cardId)}
      data-canvas-widget-focusable="true"
      data-file-card-id={cardId}
      data-wheel-owner={summaryMode ? undefined : "local"}
      style={{
        width: size.width,
        height: size.height,
        zIndex: stackIndex,
        transform: `translate(${position.x}px, ${position.y}px)`,
        "--summary-scale": summaryScale,
        "--summary-content-width": `${Math.max(0, (size.width - 48) / summaryScale)}px`
      } as React.CSSProperties}
    >
      <header
        className="file-browser-card__header"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={cancelDrag}
      >
        <span className="file-browser-card__title">
          <UiIcon name="folder" size="1.69em" />
          <span>
            <strong title={treeTitle}>{treeTitle}</strong>
            <small title={headerDetail}>{headerDetail}</small>
          </span>
        </span>
        <div className="file-browser-card__actions">
          <button
            className="file-browser-card__choose"
            type="button"
            onClick={onChooseFolder}
            title={t(locale, "filesChooseFolder")}
            aria-label={t(locale, "filesChooseFolder")}
          >
            <UiIcon name="folder" size={16} />
          </button>
          <button
            className="file-browser-card__close"
            type="button"
            onClick={onClose}
            title={t(locale, "close")}
            aria-label={t(locale, "close")}
          >
            <UiIcon name="close" size="1.23em" />
          </button>
        </div>
      </header>

      <div className="file-browser-card__body">
        <aside className="file-browser-card__tree">
          <div className="file-browser-card__tree-toolbar">
            <span className="file-browser-card__tree-search">
              <UiIcon name="search" size={14} />
              <input
                ref={quickOpenInput}
                value={quickOpenQuery}
                placeholder={t(locale, "filesQuickOpenPlaceholder")}
                aria-label={t(locale, "filesQuickOpen")}
                onChange={(event) => onQuickOpen(event.target.value)}
              />
            </span>
            {loading && <UiIcon name="working" size={14} />}
          </div>

          {trimmedQuery !== "" && (
            <div className="file-browser-card__quick-open" role="listbox" aria-label={t(locale, "filesQuickOpen")}>
              {quickOpenResults.length === 0 && !loading && (
                <p className="file-browser-card__quick-empty">{t(locale, "filesNoMatches")}</p>
              )}
              {quickOpenResults.map((relativePath) => (
                <button
                  key={relativePath}
                  className="file-browser-card__quick-result"
                  type="button"
                  role="option"
                  aria-selected={relativePath === activeFile}
                  title={relativePath}
                  onClick={() => {
                    onOpenFile(relativePath);
                    onQuickOpen("");
                  }}
                >
                  {relativePath}
                </button>
              ))}
            </div>
          )}

          {rootUnavailable ? (
            <TreeNotice icon="error" title={t(locale, "filesRootUnavailable")} detail={t(locale, "filesRootUnavailableHint")} />
          ) : root === null ? (
            <TreeNotice icon="folder" title={t(locale, "filesSelectRoot")} detail={t(locale, "filesSelectRootHint")} />
          ) : rows.length === 0 && !loading ? (
            <TreeNotice icon="folder" title={t(locale, "filesEmptyDirectory")} />
          ) : (
            <div className="file-browser-card__tree-list" role="tree">
              {rows.map((row) => (
                <button
                  key={row.entry.relativePath}
                  className={`file-browser-card__tree-row ${row.isDirectory ? "file-browser-card__tree-row--directory" : ""} ${row.entry.relativePath === activeFile ? "file-browser-card__tree-row--active" : ""}`}
                  type="button"
                  role="treeitem"
                  aria-expanded={row.isDirectory ? row.isExpanded : undefined}
                  aria-selected={row.entry.relativePath === activeFile}
                  style={{ "--tree-depth": row.depth } as React.CSSProperties}
                  title={row.entry.relativePath}
                  onClick={() => {
                    if (row.isDirectory) onOpenDirectory(row.entry.relativePath);
                    else onOpenFile(row.entry.relativePath);
                  }}
                >
                  <span className="file-browser-card__tree-caret" aria-hidden="true">
                    {row.isDirectory && <UiIcon name="chevron" size={13} />}
                  </span>
                  <UiIcon name="folder" size={14} />
                  <span className="file-browser-card__tree-name">{row.entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="file-browser-card__viewer" aria-label={activeName ?? t(locale, "files")}>
          {renderViewer()}
        </section>
      </div>

      <button
        className="file-browser-card__summary"
        type="button"
        aria-label={treeTitle}
        tabIndex={-1}
      >
        <span className="file-browser-card__summary-content">
          <UiIcon name="folder" size={34} />
          <strong>{treeTitle}</strong>
          <small>{headerDetail}</small>
        </span>
      </button>

      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`}
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, direction)}
          onPointerMove={resize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={cancelResize}
        />
      ))}
    </article>
  );

  function renderViewer(): React.JSX.Element {
    if (rootUnavailable) {
      return (
        <ViewerState
          icon="error"
          title={t(locale, "filesRootUnavailable")}
          detail={t(locale, "filesRootUnavailableHint")}
        />
      );
    }
    if (root === null) {
      return (
        <div className="file-browser-card__root-select" data-file-action="true">
          <UiIcon name="folder" size={34} />
          <strong>{t(locale, "filesSelectRoot")}</strong>
          <p>{t(locale, "filesSelectRootHint")}</p>
          <button type="button" onClick={onChooseFolder}>
            <UiIcon name="folder" size={15} />{t(locale, "filesChooseFolder")}
          </button>
          {sessionOptions.length > 0 && (
            <>
              <small>{t(locale, "filesSessionRoot")}</small>
              <div className="file-browser-card__session-options">
                {sessionOptions.map((option) => (
                  <button
                    key={option.sessionId}
                    type="button"
                    title={option.label}
                    onClick={() => onRegisterSession(option.sessionId)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      );
    }
    if (error !== null) {
      return <ViewerState icon="error" title={t(locale, "filesError")} detail={error} />;
    }
    if (activeFile === null) {
      return <ViewerState icon="folder" title={t(locale, "filesNoFile")} detail={t(locale, "filesNoFileHint")} />;
    }
    if (viewer === null) {
      // The active file has no read bound to it yet: show loading instead of the
      // previous file's content.
      return <ViewerState icon="working" title={t(locale, "filesLoading")} />;
    }
    switch (viewer.kind) {
      case "text":
        return (
          <>
            {viewer.truncated && (
              <div className="file-browser-card__viewer-banner" role="status">
                <UiIcon name="info" size={14} />
                <span>{t(locale, "filesTruncated")}</span>
                <small>{viewer.sizeLabel}</small>
              </div>
            )}
            {viewer.richDisabled ? (
              <>
                <div className="file-browser-card__viewer-banner" role="status">
                  <UiIcon name="info" size={14} />
                  <span>{t(locale, "filesRichDisabled")}</span>
                  <small>{viewer.sizeLabel}</small>
                </div>
                <pre className="file-browser-card__viewer-text" data-file-action="true">{viewer.content}</pre>
              </>
            ) : richView !== null ? (
              <div className="file-browser-card__rich" data-file-action="true">
                <Suspense fallback={<ViewerState icon="working" title={t(locale, "filesLoading")} />}>
                  {richView}
                </Suspense>
              </div>
            ) : (
              <pre className="file-browser-card__viewer-text" data-file-action="true">{viewer.content}</pre>
            )}
          </>
        );
      case "image":
        return (
          <div className="file-browser-card__viewer-image-wrap" data-file-action="true">
            <img
              className="file-browser-card__viewer-image"
              src={viewer.dataUrl}
              alt={activeName ?? ""}
              draggable={false}
            />
            <small>{viewer.mediaType} · {viewer.sizeLabel}</small>
          </div>
        );
      case "unsupported":
        return (
          <ViewerState
            icon="error"
            title={t(locale, "filesUnsupported")}
            detail={unsupportedText}
          />
        );
      case "too-large":
        return (
          <ViewerState
            icon="error"
            title={t(locale, "filesTooLarge")}
            detail={`${viewer.sizeLabel}`}
          />
        );
    }
  }
}

function ViewerState({ icon, title, detail }: {
  icon: React.ComponentProps<typeof UiIcon>["name"];
  title: string;
  detail?: string;
}): React.JSX.Element {
  return (
    <div className="file-browser-card__viewer-state">
      <UiIcon name={icon} size={36} />
      <strong>{title}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function TreeNotice({ icon, title, detail }: {
  icon: React.ComponentProps<typeof UiIcon>["name"];
  title: string;
  detail?: string;
}): React.JSX.Element {
  return (
    <div className="file-browser-card__tree-notice">
      <UiIcon name={icon} size={22} />
      <strong>{title}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function unsupportedReasonText(locale: LocaleId, reason: "binary" | "not-permitted" | "unavailable"): string {
  if (reason === "binary") return t(locale, "filesUnsupportedBinary");
  if (reason === "not-permitted") return t(locale, "filesUnsupportedNotPermitted");
  return t(locale, "filesUnsupportedUnavailable");
}

function basename(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}

function constrainFileBrowserResize(bounds: SessionBounds, direction: ResizeDirection): SessionBounds {
  const right = bounds.position.x + bounds.size.width;
  const bottom = bounds.position.y + bounds.size.height;
  const width = clamp(bounds.size.width, 460, 1_600);
  const height = clamp(bounds.size.height, 340, 1_200);
  return {
    position: {
      x: direction.includes("w") ? right - width : bounds.position.x,
      y: direction.includes("n") ? bottom - height : bounds.position.y
    },
    size: { width, height }
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
