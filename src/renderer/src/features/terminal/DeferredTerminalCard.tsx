import { Component, useCallback, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { AppSettings, SessionSnapshot } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { sessionStatusLabel } from "../../lib/sessionStatus";
import { terminalCanvasWidgetId } from "../workspace/canvasWidgetFocus";
import { terminalLoadingKeySequence } from "./terminalLoadingInput";
import { shouldCopyTerminalSelection, shouldPasteTerminalClipboard } from "./terminalShortcuts";

/** Imports a component once; a failed import is forgotten so the next request fetches it again. */
export function createComponentLoader<C>(importer: () => Promise<C>): { load(): Promise<C>; loaded(): C | undefined } {
  let pending: Promise<C> | undefined;
  let loaded: C | undefined;
  return {
    loaded: () => loaded,
    load: () => pending ??= importer().then((component) => {
      loaded = component;
      return component;
    }, (error: unknown) => {
      pending = undefined;
      throw error;
    })
  };
}

interface DeferredComponent<C> {
  component: C | null;
  failed: boolean;
  /** Requests the component again after a failed import. */
  retry(): void;
}

/** Loads `loader`'s component once `enabled`; a failure is reported until `retry()`. */
export function useDeferredComponent<C>(
  loader: { load(): Promise<C>; loaded(): C | undefined },
  enabled: boolean
): DeferredComponent<C> {
  const [state, setState] = useState<{ component: C } | { error: unknown } | null>(() => {
    const loaded = loader.loaded();
    return loaded ? { component: loaded } : null;
  });
  useEffect(() => {
    if (!enabled || state) return;
    let active = true;
    loader.load().then((component) => {
      if (active) setState({ component });
    }, (error: unknown) => {
      if (!active) return;
      console.error("CanvasTTY could not load the terminal panel.", error);
      setState({ error });
    });
    return () => { active = false; };
  }, [enabled, loader, state]);
  const retry = useCallback(() => setState(null), []);
  return {
    component: state && "component" in state ? state.component : null,
    failed: state !== null && "error" in state,
    retry
  };
}

interface TerminalCardLoadingProps {
  session: SessionSnapshot;
  locale: AppSettings["locale"];
  borderSkin: AppSettings["terminalBorderSkin"];
  shortcuts: AppSettings["shortcuts"];
  stackIndex: number;
  fullscreen: boolean;
  selected: boolean;
  groupSelected: boolean;
  /** The canvas focus is on this card: its input takes keystrokes until the real terminal mounts. */
  focused: boolean;
  focusRevision: number;
  failed: boolean;
  onRetry(): void;
  onInputHoldChange(active: boolean): void;
  onSelect(id: string): void;
}

/**
 * A bounds-preserving shell while the terminal and xterm chunk loads after the first stable frame. What is typed
 * into it goes straight to the PTY in order, so nothing is lost or replayed when the real terminal takes over.
 */
function TerminalCardLoading({
  session, locale, borderSkin, shortcuts, stackIndex, fullscreen, selected, groupSelected,
  focused, focusRevision, failed, onRetry, onInputHoldChange, onSelect
}: TerminalCardLoadingProps): React.JSX.Element {
  const title = session.title || session.provider;
  const status = sessionStatusLabel(locale, session.status, session.provider);
  const attention = session.status === "needs_approval" || session.status === "failed";
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const compositionSessionStartedAt = useRef<number | null>(null);
  const compositionCommit = useRef<string | null>(null);
  const compositionCommitFrame = useRef<number | null>(null);
  const mounted = useRef(true);
  const inputHolds = useRef(new Set<symbol>());
  const compositionRelease = useRef<(() => void) | null>(null);
  const inputGeneration = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (focused) input.current?.focus({ preventScroll: true });
  }, [focused, focusRevision]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inputGeneration.current += 1;
      composing.current = false;
      compositionSessionStartedAt.current = null;
      compositionRelease.current = null;
      compositionCommit.current = null;
      if (inputHolds.current.size) {
        inputHolds.current.clear();
        onInputHoldChange(false);
      }
      if (compositionCommitFrame.current !== null) cancelAnimationFrame(compositionCommitFrame.current);
    };
  }, [session.id, session.startedAt]);

  const holdInput = (): (() => void) => {
    const token = Symbol();
    inputHolds.current.add(token);
    if (inputHolds.current.size === 1) onInputHoldChange(true);
    return () => {
      if (!inputHolds.current.delete(token)) return;
      if (mounted.current && inputHolds.current.size === 0) onInputHoldChange(false);
    };
  };

  const sendText = (text: string, startedAt = sessionRef.current.startedAt): void => {
    const current = sessionRef.current;
    if (!mounted.current || !text || current.id !== session.id || current.startedAt !== startedAt) return;
    window.canvasTTY.terminal.input(session.id, text);
    if (!text.startsWith("\u001b") && /[^\u0000-\u001f\u007f]/.test(text)) {
      window.dispatchEvent(new CustomEvent("canvastty:terminal-input", { detail: { sessionId: session.id } }));
    }
  };

  const handleInput = (event: React.FormEvent<HTMLTextAreaElement>): void => {
    if (composing.current) return;
    const field = event.currentTarget;
    const text = field.value;
    field.value = "";
    if (!text) return;
    if (compositionCommit.current !== null) {
      const duplicateCompositionCommit = text === compositionCommit.current;
      compositionCommit.current = null;
      if (compositionCommitFrame.current !== null) cancelAnimationFrame(compositionCommitFrame.current);
      compositionCommitFrame.current = null;
      if (duplicateCompositionCommit) return;
    }
    sendText(text);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (composing.current || event.nativeEvent.isComposing) return;

    if (shouldCopyTerminalSelection(event, session.provider === "codex", shortcuts)) {
      event.preventDefault();
      event.stopPropagation();
      if (session.provider === "codex") {
        const interrupt = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === "KeyC";
        sendText(interrupt ? "\u0003" : "\u001b[99;9u");
      }
      return;
    }

    if (shouldPasteTerminalClipboard(event, shortcuts)) {
      event.preventDefault();
      event.stopPropagation();
      const startedAt = sessionRef.current.startedAt;
      const generation = inputGeneration.current;
      const acceptsPaste = (): boolean => mounted.current && sessionRef.current.id === session.id
        && sessionRef.current.startedAt === startedAt && inputGeneration.current === generation;
      if (!acceptsPaste()) return;
      const release = holdInput();
      void (event.metaKey ? window.canvasTTY.clipboard.hasImage() : Promise.resolve(false))
        .then(async (hasImage) => {
          if (!acceptsPaste()) return;
          if (hasImage) {
            sendText("\u0016", startedAt);
            return;
          }
          const text = await window.canvasTTY.clipboard.readText();
          if (text && acceptsPaste()) {
            await window.canvasTTY.terminal.pasteClipboard(session.id, text, startedAt);
            if (acceptsPaste() && !text.startsWith("\u001b") && /[^\x00-\x1f\x7f]/.test(text)) {
              window.dispatchEvent(new CustomEvent("canvastty:terminal-input", { detail: { sessionId: session.id } }));
            }
          }
        })
        .catch(() => undefined)
        .finally(release);
      return;
    }

    const sequence = terminalLoadingKeySequence(
      event, session.provider, window.canvasTTY.window.isMacOS, shortcuts, session.nativeEditor
    );
    if (sequence === null) return;
    event.preventDefault();
    event.stopPropagation();
    sendText(sequence);
  };

  const startComposition = (): void => {
    if (composing.current || !mounted.current) return;
    composing.current = true;
    compositionSessionStartedAt.current = sessionRef.current.startedAt;
    compositionRelease.current = holdInput();
  };

  const finishComposition = (event: React.CompositionEvent<HTMLTextAreaElement>): void => {
    if (!composing.current) return;
    const field = event.currentTarget;
    const text = field.value || event.data;
    const startedAt = compositionSessionStartedAt.current;
    field.value = "";
    composing.current = false;
    compositionSessionStartedAt.current = null;
    if (startedAt !== null) sendText(text, startedAt);
    compositionRelease.current?.();
    compositionRelease.current = null;

    // Chromium can emit the committed input immediately after compositionend.
    // If it does, the textarea input handler must not send that commit twice.
    compositionCommit.current = text || null;
    if (compositionCommitFrame.current !== null) cancelAnimationFrame(compositionCommitFrame.current);
    compositionCommitFrame.current = requestAnimationFrame(() => {
      compositionCommit.current = null;
      compositionCommitFrame.current = null;
    });
  };

  return (
    <article
      className={`terminal-card terminal-card--${session.provider} terminal-card--with-activity-summary terminal-card--loading ${failed ? "terminal-card--load-error" : ""} ${selected || groupSelected ? "terminal-card--selected" : ""} ${attention ? "terminal-card--attention" : ""} ${fullscreen ? "terminal-card--fullscreen" : ""}`}
      data-interactive="true"
      data-canvas-layer-id={`terminal:${session.id}`}
      data-canvas-widget-id={terminalCanvasWidgetId(session.id)}
      data-canvas-widget-focusable="true"
      data-canvas-zoom-surface="application"
      data-session-id={session.id}
      data-border-skin={borderSkin}
      aria-busy={failed ? undefined : "true"}
      aria-label={`${title}: ${status}; ${t(locale, failed ? "terminalCardLoadFailed" : "loading")}`}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        onSelect(session.id);
        if (!(event.target instanceof Element) || !event.target.closest("button")) {
          input.current?.focus({ preventScroll: true });
        }
      }}
      style={{
        width: session.size.width,
        height: session.size.height,
        zIndex: stackIndex,
        transform: `translate(${session.position.x}px, ${session.position.y}px)`,
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        padding: 24,
        color: "var(--terminal-foreground, rgba(255,255,255,.78))",
        textAlign: "center"
      }}
    >
      <textarea
        ref={input}
        aria-label={`${title} · ${t(locale, "terminal")}`}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        readOnly={failed && !composing.current}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onCompositionStart={startComposition}
        onCompositionEnd={finishComposition}
        style={{
          position: "absolute", inset: 0, zIndex: 1, width: "100%", height: "100%", boxSizing: "border-box",
          opacity: 0.01, resize: "none", overflow: "hidden", border: 0, padding: 0, color: "transparent",
          caretColor: "transparent", background: "transparent", fontSize: 16
        }}
      />
      <span role={failed ? "alert" : "status"} style={{ position: "relative", zIndex: 2, pointerEvents: "none" }}>
        {title} · {t(locale, failed ? "terminalCardLoadFailed" : "loading")} · {status}
      </span>
      {failed && <button
        type="button"
        className="terminal-card__action"
        style={{ position: "relative", zIndex: 2, width: "auto", height: "auto", padding: "8px 14px", pointerEvents: "auto" }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onRetry(); }}
      >{t(locale, "terminalCardRetry")}</button>}
    </article>
  );
}

interface TerminalCardBoundaryProps {
  children: ReactNode;
  fallback(retry: () => void): ReactNode;
}

/** Keeps a terminal card's render failure inside that card; Retry mounts the card again. */
class TerminalCardBoundary extends Component<TerminalCardBoundaryProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("CanvasTTY could not show a terminal panel.", error, info.componentStack);
  }
  private readonly retry = (): void => this.setState({ failed: false });
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}

type TerminalCardLoadingShellProps = Omit<TerminalCardLoadingProps, "failed" | "onRetry">;

interface DeferredTerminalCardProps<C> {
  card: DeferredComponent<C>;
  /** An IME composition or paste in the loading shell keeps it mounted until the input is delivered. */
  inputHeld: boolean;
  render(Card: C): ReactNode;
  loading: TerminalCardLoadingShellProps;
}

/** The terminal card once its code has loaded, and the loading shell before that or after a failure. */
export function DeferredTerminalCard<C>({ card, inputHeld, render, loading }: DeferredTerminalCardProps<C>): React.JSX.Element {
  const Card = card.component;
  if (!Card || inputHeld) return <TerminalCardLoading {...loading} failed={card.failed} onRetry={card.retry} />;
  return (
    <TerminalCardBoundary fallback={(retry) => <TerminalCardLoading {...loading} failed onRetry={retry} />}>
      {render(Card)}
    </TerminalCardBoundary>
  );
}
