import { createHash } from "node:crypto";
import type {
  BrowserActivityEvent,
  BrowserActor,
  BrowserCommand,
  BrowserResult
} from "../../../shared/contracts.ts";
import type { BrowserAuditInput, BrowserAuditRecord } from "./BrowserAuditStore.ts";
import { BrowserKernelError, browserError } from "./BrowserErrors.ts";

const MAX_COMPLETED_MUTATIONS_PER_AGENT = 10_000;
const MAX_MUTATION_QUEUE_DEPTH = 100;
const MAX_ACTIVITY_EVENTS = 1_000;
const MAX_AGENT_INFLIGHT = 8;
const MAX_AGENT_COMMANDS_PER_WINDOW = 100;
const RATE_WINDOW_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const RESULT_AUDIT_TIMEOUT_MS = 1_000;

const MUTATIONS = new Set<BrowserCommand["type"]>([
  "browser_new_tab", "browser_close_tab", "browser_activate_tab", "browser_navigate",
  "browser_back", "browser_forward", "browser_reload", "browser_click", "browser_hover",
  "browser_type", "browser_select", "browser_press", "browser_scroll", "browser_drag",
  "browser_handle_dialog", "browser_upload"
]);

export interface BrowserAuditWriter {
  append(input: BrowserAuditInput): Promise<BrowserAuditRecord>;
}

export interface BrowserDispatchExecution {
  data?: unknown;
  tabId?: string | null;
}

export interface BrowserCommandDispatcherOptions {
  audit: BrowserAuditWriter;
  execute(actor: BrowserActor, command: BrowserCommand, signal: AbortSignal): Promise<BrowserDispatchExecution>;
  getRevision(tabId: string): number | null;
  getOrigin(tabId: string): string | null;
  onActivity?(event: BrowserActivityEvent): void;
  now?: () => number;
}

interface DedupeEntry {
  result: Promise<BrowserResult>;
  retainAfterCompletion: boolean;
}

export class BrowserCommandDispatcher {
  private readonly audit: BrowserAuditWriter;
  private readonly executeCommand: BrowserCommandDispatcherOptions["execute"];
  private readonly getRevision: BrowserCommandDispatcherOptions["getRevision"];
  private readonly getOrigin: BrowserCommandDispatcherOptions["getOrigin"];
  private readonly onActivity?: BrowserCommandDispatcherOptions["onActivity"];
  private readonly now: () => number;
  private readonly dedupe = new Map<string, Map<string, DedupeEntry>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly queueDepth = new Map<string, number>();
  private readonly activity: BrowserActivityEvent[] = [];
  private readonly listeners = new Set<(event: BrowserActivityEvent) => void>();
  private readonly rateWindows = new Map<string, number[]>();
  private readonly inflight = new Map<string, number>();
  private readonly activeRuns = new Set<Promise<BrowserResult>>();
  private readonly shutdownController = new AbortController();
  private closing = false;
  private sequence = 0;
  private activitySequence = 0;

  constructor(options: BrowserCommandDispatcherOptions) {
    this.audit = options.audit;
    this.executeCommand = options.execute;
    this.getRevision = options.getRevision;
    this.getOrigin = options.getOrigin;
    this.onActivity = options.onActivity;
    this.now = options.now ?? Date.now;
  }

  execute(actor: BrowserActor, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
    const actorKey = browserActorKey(actor);
    const requestId = typeof command?.requestId === "string" ? command.requestId.slice(0, 128) : "invalid";
    if (this.closing) {
      const tabId = commandTabId(command);
      return Promise.resolve({
        ok: false,
        requestId,
        tabId,
        commandSequence: ++this.sequence,
        revisionBefore: tabId ? this.getRevision(tabId) : null,
        revisionAfter: tabId ? this.getRevision(tabId) : null,
        error: {
          code: "BRIDGE_UNAVAILABLE",
          message: "Browser service is shutting down.",
          retryable: true
        }
      });
    }
    const actorDedupe = this.dedupe.get(actorKey) ?? new Map<string, DedupeEntry>();
    this.dedupe.set(actorKey, actorDedupe);
    const existing = actorDedupe.get(requestId);
    if (existing) return existing.result;

    const sequence = ++this.sequence;
    const mutation = isMutation(command?.type);
    const retainAfterCompletion = actor.kind === "agent" && mutation;
    const retainedMutationCount = retainAfterCompletion
      ? [...actorDedupe.values()].filter((entry) => entry.retainAfterCompletion).length
      : 0;
    if (retainAfterCompletion && retainedMutationCount >= MAX_COMPLETED_MUTATIONS_PER_AGENT) {
      return this.run(
        actor,
        command,
        sequence,
        signal,
        new BrowserKernelError("RATE_LIMITED", "Browser mutation request id registry is full for this connection.")
      );
    }
    const task = async () => this.run(actor, command, sequence, signal);
    const queueKey = commandTabId(command) ?? "__browser__";
    const result = mutation
      ? (this.queueDepth.get(queueKey) ?? 0) >= MAX_MUTATION_QUEUE_DEPTH
        ? this.run(
          actor,
          command,
          sequence,
          signal,
          new BrowserKernelError("RATE_LIMITED", "Browser tab mutation queue is full.", { retryable: true })
        )
        : this.enqueue(queueKey, task)
      : task();
    this.activeRuns.add(result);
    void result.finally(() => this.activeRuns.delete(result));
    const entry: DedupeEntry = { result, retainAfterCompletion };
    actorDedupe.set(requestId, entry);
    if (!retainAfterCompletion) {
      void result.finally(() => {
        if (actorDedupe.get(requestId) === entry) actorDedupe.delete(requestId);
        if (actorDedupe.size === 0 && this.dedupe.get(actorKey) === actorDedupe) this.dedupe.delete(actorKey);
      });
    }
    return result;
  }

  clearActor(actor: BrowserActor): void {
    const actorKey = browserActorKey(actor);
    this.dedupe.delete(actorKey);
    this.rateWindows.delete(actorKey);
    this.inflight.delete(actorKey);
  }

  async closeAndDrain(): Promise<void> {
    this.closing = true;
    this.shutdownController.abort();
    const drain = (async () => {
      while (this.activeRuns.size > 0) {
        await Promise.allSettled([...this.activeRuns]);
      }
    })();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        drain,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  getActivity(sinceSequence = 0, limit = MAX_ACTIVITY_EVENTS): BrowserActivityEvent[] {
    const safeSince = Number.isInteger(sinceSequence) && sinceSequence >= 0 ? sinceSequence : 0;
    const safeLimit = Number.isInteger(limit) ? Math.min(MAX_ACTIVITY_EVENTS, Math.max(1, limit)) : MAX_ACTIVITY_EVENTS;
    return this.activity
      .filter((event) => event.sequence > safeSince)
      .slice(-safeLimit)
      .map((event) => structuredClone(event));
  }

  subscribe(sinceSequence: number, listener: (event: BrowserActivityEvent) => void): () => void {
    for (const event of this.getActivity(sinceSequence)) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async run(
    actor: BrowserActor,
    command: BrowserCommand,
    commandSequence: number,
    outerSignal?: AbortSignal,
    preflightError?: BrowserKernelError
  ): Promise<BrowserResult> {
    const startedAt = this.now();
    const tabId = commandTabId(command);
    let revisionBefore = tabId ? this.getRevision(tabId) : null;
    const origin = tabId ? this.getOrigin(tabId) : null;
    const targetHash = commandTargetHash(command);
    const timed = createTimedSignal(outerSignal, this.shutdownController.signal, commandTimeout(command));
    const actorKey = browserActorKey(actor);
    let result: BrowserResult;
    this.incrementInflight(actorKey);
    try {
      if (preflightError) throw preflightError;
      validateCommand(actor, command);
      this.assertRate(actor, actorKey);
      if (tabId && revisionBefore === null) {
        throw new BrowserKernelError("TAB_NOT_FOUND", "Browser tab is unavailable.");
      }
      if (tabId && command.expectedRevision !== undefined && command.expectedRevision !== revisionBefore) {
        throw new BrowserKernelError("STALE_REF", "Browser document revision changed.", {
          retryable: true,
          details: { expectedRevision: command.expectedRevision, currentRevision: revisionBefore }
        });
      }
      await raceWithAbort(
        () => this.auditAttempt(actor, command, tabId, revisionBefore, targetHash, origin),
        timed.signal
      );
      const execution = await raceWithAbort(
        () => this.executeCommand(actor, command, timed.signal),
        timed.signal
      );
      const actualTabId = execution.tabId === undefined ? tabId : execution.tabId;
      const revisionAfter = actualTabId ? this.getRevision(actualTabId) : null;
      result = {
        ok: true,
        requestId: command.requestId,
        tabId: actualTabId,
        commandSequence,
        revisionBefore,
        revisionAfter,
        ...(execution.data === undefined ? {} : { data: execution.data })
      };
    } catch (error) {
      const normalized = timed.timedOut
        ? new BrowserKernelError("TIMEOUT", "Browser command timed out.", { retryable: true })
        : error;
      const details = browserError(normalized);
      revisionBefore = tabId ? this.getRevision(tabId) : revisionBefore;
      result = {
        ok: false,
        requestId: typeof command?.requestId === "string" ? command.requestId.slice(0, 128) : "invalid",
        tabId,
        commandSequence,
        revisionBefore,
        revisionAfter: tabId ? this.getRevision(tabId) : null,
        error: details
      };
    } finally {
      timed.dispose();
      this.decrementInflight(actorKey);
    }

    const event: BrowserActivityEvent = {
      sequence: ++this.activitySequence,
      timestamp: startedAt,
      requestId: result.requestId,
      actorKind: actor.kind,
      agentId: actor.kind === "agent" ? actor.agentId : null,
      provider: actor.kind === "agent" ? actor.provider : null,
      terminalSessionId: actor.kind === "agent" ? actor.terminalSessionId : null,
      tabId: result.tabId,
      origin,
      operation: isCommandType(command?.type) ? command.type : "browser_list_tabs",
      targetHash,
      revisionBefore: result.revisionBefore,
      revisionAfter: result.revisionAfter,
      durationMs: Math.max(0, this.now() - startedAt),
      ok: result.ok,
      errorCode: result.error?.code ?? null
    };
    this.recordActivity(event);
    const resultAudit = createTimedSignal(undefined, this.shutdownController.signal, RESULT_AUDIT_TIMEOUT_MS);
    try {
      await raceWithAbort(
        () => this.auditResult(actor, command, result, event),
        resultAudit.signal
      );
    } catch (error) {
      if (!this.shutdownController.signal.aborted) {
        console.warn("CanvasTTY browser audit result could not be recorded.", error);
      }
    } finally {
      resultAudit.dispose();
    }
    return result;
  }

  private async auditAttempt(
    actor: BrowserActor,
    command: BrowserCommand,
    tabId: string | null,
    revision: number | null,
    targetHash: string | null,
    origin: string | null
  ): Promise<void> {
    if (!isMutation(command.type)) return;
    try {
      await this.audit.append({
        requestId: command.requestId,
        actorKind: actor.kind,
        actorId: actor.kind === "agent" ? actor.agentId : actor.connectionId,
        provider: actor.kind === "agent" ? actor.provider : null,
        terminalSessionId: actor.kind === "agent" ? actor.terminalSessionId : null,
        operation: command.type,
        phase: "attempt",
        tabId,
        origin,
        targetHash,
        revisionBefore: revision,
        details: { revision, targetHash }
      });
    } catch (error) {
      if (actor.kind === "agent") {
        throw new BrowserKernelError("AUDIT_UNAVAILABLE", "Agent mutation was blocked because audit is unavailable.", {
          retryable: true,
          cause: error
        });
      }
      console.warn("CanvasTTY browser audit attempt could not be recorded.", error);
    }
  }

  private auditResult(
    actor: BrowserActor,
    command: BrowserCommand,
    result: BrowserResult,
    event: BrowserActivityEvent
  ): Promise<BrowserAuditRecord> {
    return this.audit.append({
      requestId: result.requestId,
      actorKind: actor.kind,
      actorId: actor.kind === "agent" ? actor.agentId : actor.connectionId,
      provider: actor.kind === "agent" ? actor.provider : null,
      terminalSessionId: actor.kind === "agent" ? actor.terminalSessionId : null,
      operation: isCommandType(command?.type) ? command.type : "invalid-command",
      phase: "result",
      tabId: result.tabId,
      ok: result.ok,
      errorCode: result.error?.code ?? null,
      origin: event.origin,
      targetHash: event.targetHash,
      revisionBefore: result.revisionBefore,
      revisionAfter: result.revisionAfter,
      durationMs: event.durationMs,
      details: {
        commandSequence: result.commandSequence,
        revisionBefore: result.revisionBefore,
        revisionAfter: result.revisionAfter,
        targetHash: event.targetHash
      }
    });
  }

  private assertRate(actor: BrowserActor, actorKey: string): void {
    if (actor.kind !== "agent") return;
    if ((this.inflight.get(actorKey) ?? 0) > MAX_AGENT_INFLIGHT) {
      throw new BrowserKernelError("RATE_LIMITED", "Too many concurrent browser commands.", { retryable: true });
    }
    const cutoff = this.now() - RATE_WINDOW_MS;
    const values = (this.rateWindows.get(actorKey) ?? []).filter((timestamp) => timestamp >= cutoff);
    if (values.length >= MAX_AGENT_COMMANDS_PER_WINDOW) {
      this.rateWindows.set(actorKey, values);
      throw new BrowserKernelError("RATE_LIMITED", "Browser command rate limit exceeded.", { retryable: true });
    }
    values.push(this.now());
    this.rateWindows.set(actorKey, values);
  }

  private incrementInflight(actorKey: string): void {
    this.inflight.set(actorKey, (this.inflight.get(actorKey) ?? 0) + 1);
  }

  private decrementInflight(actorKey: string): void {
    const next = (this.inflight.get(actorKey) ?? 1) - 1;
    if (next <= 0) this.inflight.delete(actorKey);
    else this.inflight.set(actorKey, next);
  }

  private enqueue(key: string, task: () => Promise<BrowserResult>): Promise<BrowserResult> {
    this.queueDepth.set(key, (this.queueDepth.get(key) ?? 0) + 1);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.finally(() => {
      const depth = (this.queueDepth.get(key) ?? 1) - 1;
      if (depth <= 0) this.queueDepth.delete(key);
      else this.queueDepth.set(key, depth);
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }

  private recordActivity(event: BrowserActivityEvent): void {
    this.activity.push(structuredClone(event));
    if (this.activity.length > MAX_ACTIVITY_EVENTS) this.activity.splice(0, this.activity.length - MAX_ACTIVITY_EVENTS);
    this.onActivity?.(structuredClone(event));
    for (const listener of this.listeners) listener(structuredClone(event));
  }

}

function validateCommand(actor: BrowserActor, command: BrowserCommand): void {
  if (!command || typeof command !== "object" || !isCommandType(command.type)) {
    throw new BrowserKernelError("PERMISSION_DENIED", "Browser command type is invalid.");
  }
  if (typeof command.requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(command.requestId)) {
    throw new BrowserKernelError("PERMISSION_DENIED", "Browser requestId is invalid.");
  }
  if (command.tabId !== undefined && (
    typeof command.tabId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(command.tabId)
  )) throw new BrowserKernelError("TAB_NOT_FOUND", "Browser tab id is invalid.");
  if (command.text !== undefined && (
    typeof command.text !== "string" || Buffer.byteLength(command.text, "utf8") > 64 * 1024
  )) throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser command text exceeds 64 KB.");
  if (command.paths && command.paths.length > 20) {
    throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser upload contains too many files.");
  }
  if (actor.kind === "agent" && (
    !actor.agentId || !actor.connectionId || !actor.terminalSessionId || !actor.cwd
    || actor.agentId.length > 160 || actor.connectionId.length > 160
  )) throw new BrowserKernelError("AUTH_INVALID", "Browser agent identity is invalid.");
}

function isMutation(type: BrowserCommand["type"] | undefined): boolean {
  return Boolean(type && MUTATIONS.has(type));
}

function isCommandType(value: unknown): value is BrowserCommand["type"] {
  return typeof value === "string" && (
    MUTATIONS.has(value as BrowserCommand["type"])
    || new Set<BrowserCommand["type"]>([
      "browser_list_tabs", "browser_observe", "browser_read_page", "browser_screenshot",
      "browser_wait_for", "browser_download_wait", "browser_get_activity"
    ]).has(value as BrowserCommand["type"])
  );
}

function browserActorKey(actor: BrowserActor): string {
  return actor.kind === "agent"
    ? `agent:${actor.agentId}:${actor.connectionId}`
    : `human:${actor.connectionId}`;
}

function commandTabId(command: BrowserCommand): string | null {
  if (typeof command?.tabId === "string") return command.tabId;
  if (command?.ref && typeof command.ref === "object") return command.ref.tabId;
  if (command?.targetRef && typeof command.targetRef === "object") return command.targetRef.tabId;
  return null;
}

function commandTargetHash(command: BrowserCommand): string | null {
  const ref = typeof command?.ref === "string" ? command.ref : command?.ref?.ref;
  const targetRef = typeof command?.targetRef === "string" ? command.targetRef : command?.targetRef?.ref;
  const target = [command?.url, ref, targetRef, command?.value].filter((value): value is string => Boolean(value)).join("|");
  return target ? createHash("sha256").update(target).digest("hex") : null;
}

function commandTimeout(command: BrowserCommand): number {
  return Number.isFinite(command?.timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(50, command.timeoutMs!))
    : DEFAULT_TIMEOUT_MS;
}

function createTimedSignal(
  outer: AbortSignal | undefined,
  shutdown: AbortSignal,
  timeoutMs: number
): {
  signal: AbortSignal;
  timedOut: boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  const state = {
    signal: controller.signal,
    timedOut: false,
    dispose: () => undefined as void
  };
  const timeout = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  if (outer?.aborted || shutdown.aborted) abort();
  else {
    outer?.addEventListener("abort", abort, { once: true });
    shutdown.addEventListener("abort", abort, { once: true });
  }
  state.dispose = () => {
    clearTimeout(timeout);
    outer?.removeEventListener("abort", abort);
    shutdown.removeEventListener("abort", abort);
  };
  return state;
}

function raceWithAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  const operation = start();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortError(): DOMException {
  return new DOMException("Browser command was canceled.", "AbortError");
}
