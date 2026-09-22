import type {
  BrowserActivityEvent,
  BrowserActor,
  BrowserCommand,
  BrowserDialogSnapshot,
  BrowserDownloadSnapshot,
  BrowserErrorCode,
  BrowserResult,
  BrowserSnapshot
} from "../../../shared/contracts.ts";
import { BrowserAutomationService, type BrowserPointerResult } from "./BrowserAutomationService.ts";
import { BrowserAuditStore } from "./BrowserAuditStore.ts";
import { BrowserCommandDispatcher } from "./BrowserCommandDispatcher.ts";
import { BrowserKernelError, throwIfAborted } from "./BrowserErrors.ts";
import { BrowserPolicyService, DEFAULT_BROWSER_URL } from "./BrowserPolicyService.ts";

export interface BrowserCoreTab {
  id: string;
  url: string;
  documentRevision: number;
  status: "loading" | "ready" | "error" | "crashed";
}

export interface BrowserCoreHost {
  getSnapshot(): BrowserSnapshot;
  getTab(tabId: string): BrowserCoreTab | null;
  ensureRuntime(): Promise<void>;
  newTab(url: string): Promise<BrowserSnapshot>;
  closeTab(tabId: string): Promise<BrowserSnapshot>;
  activateTab(tabId: string): Promise<BrowserSnapshot> | BrowserSnapshot;
  navigateTab(tabId: string, url: string): Promise<BrowserSnapshot>;
  back(tabId: string): Promise<BrowserSnapshot> | BrowserSnapshot;
  forward(tabId: string): Promise<BrowserSnapshot> | BrowserSnapshot;
  reload(tabId: string): Promise<BrowserSnapshot> | BrowserSnapshot;
  pendingDialog(tabId: string): BrowserDialogSnapshot | null;
  waitForDownload(tabId: string | null, timeoutMs: number, signal?: AbortSignal): Promise<BrowserDownloadSnapshot>;
  touchActor(actor: BrowserActor, tabId: string | null, cursor?: BrowserPointerResult): void;
  heartbeatActor(actor: BrowserActor, timestamp: number): void;
  disconnectActor(actor: BrowserActor): void;
}

export interface BrowserCoreOptions {
  host: BrowserCoreHost;
  automation: BrowserAutomationService;
  policy: BrowserPolicyService;
  audit: BrowserAuditStore;
  onActivity?(event: BrowserActivityEvent): void;
}

export class BrowserCore {
  private readonly host: BrowserCoreHost;
  private readonly automation: BrowserAutomationService;
  private readonly policy: BrowserPolicyService;
  private readonly dispatcher: BrowserCommandDispatcher;

  constructor(options: BrowserCoreOptions) {
    this.host = options.host;
    this.automation = options.automation;
    this.policy = options.policy;
    this.dispatcher = new BrowserCommandDispatcher({
      audit: options.audit,
      execute: (actor, command, signal) => this.executeCommand(actor, command, signal),
      getRevision: (tabId) => this.host.getTab(tabId)?.documentRevision ?? null,
      getOrigin: (tabId) => origin(this.host.getTab(tabId)?.url),
      onActivity: options.onActivity
    });
  }

  execute(actor: BrowserActor, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
    const normalized = normalizeTabCommand(command, this.host.getSnapshot().activeTabId);
    return this.dispatcher.execute(actor, normalized, signal).then((result) => (
      actor.kind === "agent" ? sanitizeAgentResult(result) : result
    ));
  }

  getActivity(sinceSequence = 0, limit?: number): BrowserActivityEvent[] {
    return this.dispatcher.getActivity(sinceSequence, limit);
  }

  subscribe(
    actor: BrowserActor,
    sinceSequence: number,
    listener: (event: BrowserActivityEvent) => void
  ): () => void {
    return this.dispatcher.subscribe(sinceSequence, (event) => {
      if (actor.kind === "human" || activityBelongsToActor(event, actor)) listener(event);
    });
  }

  agentConnected(actor: BrowserActor): void {
    // Authentication alone is not browser activity; presence starts with the first command.
    void actor;
  }

  agentHeartbeat(actor: BrowserActor, timestamp: number): void {
    this.host.heartbeatActor(actor, timestamp);
  }

  agentDisconnected(actor: BrowserActor): void {
    this.dispatcher.clearActor(actor);
    this.host.disconnectActor(actor);
  }

  agentCursor(actor: BrowserActor, cursor: { tabId: string; x: number; y: number }): void {
    this.host.touchActor(actor, cursor.tabId, { x: cursor.x, y: cursor.y });
  }

  shutdown(): Promise<void> {
    return this.dispatcher.closeAndDrain();
  }

  private async executeCommand(
    actor: BrowserActor,
    command: BrowserCommand,
    signal: AbortSignal
  ): Promise<{ data?: unknown; tabId?: string | null }> {
    throwIfAborted(signal);
    assertCommandArguments(command);
    const tabId = this.resolveTabId(command);
    this.host.touchActor(actor, tabId);
    if (command.type === "browser_list_tabs") {
      return { data: dataForActor(actor, this.host.getSnapshot()), tabId: null };
    }
    if (command.type === "browser_get_activity") {
      const since = parseActivityCursor(command.cursor);
      const page = activityPageForActor(
        this.getActivity(since),
        actor,
        since,
        command.limit ?? 1_000
      );
      return {
        data: {
          events: page.events,
          nextCursor: String(page.nextSequence)
        },
        tabId: null
      };
    }
    if (command.type === "browser_new_tab") {
      const url = command.url === undefined ? DEFAULT_BROWSER_URL : this.policy.assertNavigationUrl(command.url);
      const snapshot = await this.host.newTab(url);
      this.host.touchActor(actor, snapshot.activeTabId);
      return { data: dataForActor(actor, snapshot), tabId: snapshot.activeTabId };
    }

    await this.host.ensureRuntime();

    const requiredTabId = tabId ?? (() => {
      throw new BrowserKernelError("TAB_NOT_FOUND", "Browser command requires a tab.");
    })();
    const tab = this.host.getTab(requiredTabId);
    if (!tab) throw new BrowserKernelError("TAB_NOT_FOUND", "Browser tab is unavailable.");
    if (tab.status === "crashed" && command.type !== "browser_reload" && command.type !== "browser_close_tab") {
      throw new BrowserKernelError("BROWSER_CRASHED", "Browser tab renderer crashed.", { retryable: true });
    }
    const dialog = this.host.pendingDialog(requiredTabId);
    if (dialog && dialog.tabId === requiredTabId && command.type !== "browser_handle_dialog") {
      throw new BrowserKernelError("DIALOG_OPEN", "Browser tab has an open JavaScript dialog.", {
        retryable: true,
        details: { dialogType: dialog.type }
      });
    }

    const revision = tab.documentRevision;
    throwIfAborted(signal);
    switch (command.type) {
      case "browser_close_tab":
      {
        const snapshot = await this.host.closeTab(requiredTabId);
        this.host.touchActor(actor, snapshot.activeTabId);
        return { data: dataForActor(actor, snapshot), tabId: requiredTabId };
      }
      case "browser_activate_tab":
        return { data: dataForActor(actor, await this.host.activateTab(requiredTabId)), tabId: requiredTabId };
      case "browser_navigate": {
        const url = this.policy.assertNavigationUrl(command.url);
        return { data: dataForActor(actor, await this.host.navigateTab(requiredTabId, url)), tabId: requiredTabId };
      }
      case "browser_back":
        return { data: dataForActor(actor, await this.host.back(requiredTabId)), tabId: requiredTabId };
      case "browser_forward":
        return { data: dataForActor(actor, await this.host.forward(requiredTabId)), tabId: requiredTabId };
      case "browser_reload":
        return { data: dataForActor(actor, await this.host.reload(requiredTabId)), tabId: requiredTabId };
      case "browser_observe":
        return {
          data: await this.automation.observe(requiredTabId, revision, {
            cursor: command.cursor,
            limit: command.limit,
            signal
          }),
          tabId: requiredTabId
        };
      case "browser_read_page":
        return {
          data: await this.automation.readPage(requiredTabId, revision, {
            cursor: command.cursor,
            limit: command.limit,
            signal
          }),
          tabId: requiredTabId
        };
      case "browser_screenshot":
        return { data: await this.automation.screenshot(requiredTabId, revision, signal), tabId: requiredTabId };
      case "browser_click": {
        const pointer = await this.automation.click(requiredTabId, revision, command.ref, signal);
        this.host.touchActor(actor, requiredTabId, pointer);
        return { data: { clicked: true }, tabId: requiredTabId };
      }
      case "browser_hover": {
        const pointer = await this.automation.hover(requiredTabId, revision, command.ref, signal);
        this.host.touchActor(actor, requiredTabId, pointer);
        return { data: { hovered: true }, tabId: requiredTabId };
      }
      case "browser_type": {
        const pointer = await this.automation.type(requiredTabId, revision, command.ref, command.text, signal);
        this.host.touchActor(actor, requiredTabId, pointer);
        return { data: { typed: true }, tabId: requiredTabId };
      }
      case "browser_select":
        await this.automation.select(requiredTabId, revision, command.ref, command.values, signal);
        return { data: { selected: true }, tabId: requiredTabId };
      case "browser_press":
        await this.automation.press(requiredTabId, revision, command.ref, command.key, signal);
        return { data: { pressed: true }, tabId: requiredTabId };
      case "browser_scroll": {
        const pointer = await this.automation.scroll(
          requiredTabId,
          revision,
          command.ref,
          command.deltaX,
          command.deltaY,
          command.direction,
          signal
        );
        this.host.touchActor(actor, requiredTabId, pointer);
        return { data: { scrolled: true }, tabId: requiredTabId };
      }
      case "browser_drag": {
        const pointer = await this.automation.drag(
          requiredTabId,
          revision,
          command.ref,
          command.targetRef,
          signal
        );
        this.host.touchActor(actor, requiredTabId, pointer);
        return { data: { dragged: true }, tabId: requiredTabId };
      }
      case "browser_wait_for": {
        const timeout = boundedTimeout(command.timeoutMs);
        if (command.condition === "download") {
          return { data: await this.host.waitForDownload(requiredTabId, timeout, signal), tabId: requiredTabId };
        }
        return {
          data: await this.automation.waitFor(
            requiredTabId,
            revision,
            command.condition,
            command.value,
            timeout,
            signal
          ),
          tabId: requiredTabId
        };
      }
      case "browser_handle_dialog": {
        if (!dialog || dialog.tabId !== requiredTabId) {
          throw new BrowserKernelError("DIALOG_OPEN", "Browser tab has no pending dialog.");
        }
        await this.automation.handleDialog(requiredTabId, Boolean(command.accept), command.promptText);
        return { data: { handled: true }, tabId: requiredTabId };
      }
      case "browser_download_wait":
        return {
          data: await this.host.waitForDownload(requiredTabId, boundedTimeout(command.timeoutMs), signal),
          tabId: requiredTabId
        };
      case "browser_upload": {
        const roots = actor.kind === "agent" ? [actor.cwd] : [];
        const paths = await this.policy.validateUploadPaths(command.paths, roots);
        await this.automation.upload(requiredTabId, revision, command.ref, paths, signal);
        return { data: { uploaded: paths.length }, tabId: requiredTabId };
      }
      default:
        throw new BrowserKernelError("PERMISSION_DENIED", "Browser command is unsupported.");
    }
  }

  private resolveTabId(command: BrowserCommand): string | null {
    if (command.tabId) return command.tabId;
    if (command.ref && typeof command.ref === "object") return command.ref.tabId;
    if (command.targetRef && typeof command.targetRef === "object") return command.targetRef.tabId;
    return this.host.getSnapshot().activeTabId;
  }
}

function boundedTimeout(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(120_000, Math.max(50, value!)) : 120_000;
}

function assertCommandArguments(command: BrowserCommand): void {
  if (command.expectedRevision !== undefined && (
    !Number.isInteger(command.expectedRevision) || command.expectedRevision < 0
  )) throw new BrowserKernelError("STALE_REF", "Browser expectedRevision is invalid.");
  if (command.cursor !== undefined && (typeof command.cursor !== "string" || command.cursor.length > 512)) {
    throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser cursor is invalid.");
  }
  if (command.limit !== undefined && (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 1_000)) {
    throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser result limit is invalid.");
  }
  if (command.timeoutMs !== undefined && (!Number.isFinite(command.timeoutMs)
    || command.timeoutMs < 50 || command.timeoutMs > 120_000)) {
    throw new BrowserKernelError("TIMEOUT", "Browser timeout is outside the 50-120000 ms range.");
  }
  for (const ref of [command.ref, command.targetRef]) {
    if (typeof ref === "string" && !/^ref_[a-zA-Z0-9_-]{1,160}$/.test(ref)) {
      throw new BrowserKernelError("STALE_REF", "Browser element reference is invalid.", { retryable: true });
    }
  }
  if (command.type === "browser_navigate" && typeof command.url !== "string") {
    throw new BrowserKernelError("INVALID_URL", "Browser navigate requires a URL.");
  }
  const refCommands: BrowserCommand["type"][] = [
    "browser_click", "browser_hover", "browser_type", "browser_select", "browser_drag", "browser_upload"
  ];
  if (refCommands.includes(command.type) && !(typeof command.ref === "string" || command.ref?.ref)) {
    throw new BrowserKernelError("STALE_REF", "Browser action requires an observed element reference.", {
      retryable: true
    });
  }
  if (command.type === "browser_drag" && !(typeof command.targetRef === "string" || command.targetRef?.ref)) {
    throw new BrowserKernelError("STALE_REF", "Browser drag requires a target element reference.", { retryable: true });
  }
  if (command.type === "browser_type" && typeof command.text !== "string") {
    throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser type requires text.");
  }
  if (command.type === "browser_select" && (!Array.isArray(command.values) || command.values.length === 0)) {
    throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser select requires values.");
  }
  if (command.values && (command.values.length > 64
    || command.values.some((value) => typeof value !== "string" || value.length > 2_048))) {
    throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser select values are invalid.");
  }
  if (command.type === "browser_press" && typeof command.key !== "string") {
    throw new BrowserKernelError("PERMISSION_DENIED", "Browser press requires an allow-listed key.");
  }
  if (command.type === "browser_handle_dialog" && typeof command.accept !== "boolean") {
    throw new BrowserKernelError("PERMISSION_DENIED", "Browser dialog handling requires an accept decision.");
  }
  if (command.type === "browser_upload" && (!Array.isArray(command.paths) || command.paths.length === 0)) {
    throw new BrowserKernelError("PATH_DENIED", "Browser upload requires file paths.");
  }
  if (command.paths && (command.paths.length > 20
    || command.paths.some((path) => typeof path !== "string" || path.length > 4_096))) {
    throw new BrowserKernelError("PATH_DENIED", "Browser upload paths are invalid.");
  }
  if (command.direction !== undefined && !["up", "down", "left", "right"].includes(command.direction)) {
    throw new BrowserKernelError("PERMISSION_DENIED", "Browser scroll direction is invalid.");
  }
  if (command.deltaX !== undefined && !Number.isFinite(command.deltaX)
    || command.deltaY !== undefined && !Number.isFinite(command.deltaY)) {
    throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser scroll delta is invalid.");
  }
  if (command.promptText !== undefined && (
    typeof command.promptText !== "string" || command.promptText.length > 8_192
  )) throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser dialog prompt is too large.");
  if (command.value !== undefined && (typeof command.value !== "string" || command.value.length > 8_192)) {
    throw new BrowserKernelError("PAYLOAD_TOO_LARGE", "Browser wait value is too large.");
  }
  if (command.type === "browser_wait_for") {
    if (!command.condition || command.condition === "download") {
      if (command.condition === "download") return;
      throw new BrowserKernelError("PERMISSION_DENIED", "Browser wait requires a condition.");
    }
    if (["text", "element", "url"].includes(command.condition) && typeof command.value !== "string") {
      throw new BrowserKernelError("PERMISSION_DENIED", "Browser wait condition requires a value.");
    }
  }
}

function parseActivityCursor(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const TAB_BOUND_COMMANDS = new Set<BrowserCommand["type"]>([
  "browser_close_tab", "browser_activate_tab", "browser_navigate", "browser_back", "browser_forward",
  "browser_reload", "browser_observe", "browser_read_page", "browser_screenshot", "browser_click",
  "browser_hover", "browser_type", "browser_select", "browser_press", "browser_scroll", "browser_drag",
  "browser_wait_for", "browser_handle_dialog", "browser_download_wait", "browser_upload"
]);

function normalizeTabCommand(command: BrowserCommand, activeTabId: string | null): BrowserCommand {
  if (command.tabId || !TAB_BOUND_COMMANDS.has(command.type)) return command;
  const refTabId = typeof command.ref === "object" ? command.ref.tabId
    : typeof command.targetRef === "object" ? command.targetRef.tabId
      : null;
  const tabId = refTabId ?? activeTabId;
  return tabId ? { ...command, tabId } : command;
}

function sanitizeAgentResult(result: BrowserResult): BrowserResult {
  return {
    ...result,
    ...(result.data === undefined ? {} : { data: sanitizeAgentValue(result.data) }),
    ...(result.error ? {
      error: {
        code: result.error.code,
        message: agentErrorMessage(result.error.code),
        retryable: result.error.retryable,
        ...(result.error.details ? { details: sanitizeAgentErrorDetails(result.error.details) } : {})
      }
    } : {})
  };
}

function dataForActor(actor: BrowserActor, value: unknown): unknown {
  return actor.kind === "agent" ? sanitizeAgentValue(value) : value;
}

function sanitizeAgentValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 12) return "[REDACTED]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "favicon") return null;
  if (/(?:password|passwd|passcode|secret|cookie|authorization|authheader|credential|token|api[-_]?key|localstorage|sessionstorage)/i.test(normalizedKey)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return normalizedKey.endsWith("url") ? safeAgentUrl(value) : value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeAgentValue(entry, key, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    result[entryKey] = sanitizeAgentValue(entryValue, entryKey, depth + 1);
  }
  return result;
}

function safeAgentUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    // Query strings can carry credentials under arbitrary provider-specific
    // names (signed URLs, SAML responses, tickets). Agents receive no query or
    // fragment rather than relying on a bypassable key-name blacklist.
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function sanitizeAgentErrorDetails(
  details: Record<string, string | number | boolean | null>
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value !== "string") result[key] = value;
    else if (key === "dialogType" && /^(?:alert|confirm|prompt|beforeunload)$/.test(value)) result[key] = value;
  }
  return result;
}

function agentErrorMessage(code: BrowserErrorCode): string {
  const messages: Record<BrowserErrorCode, string> = {
    AUTH_INVALID: "Browser agent authentication failed.",
    BRIDGE_UNAVAILABLE: "Browser bridge is unavailable.",
    TAB_NOT_FOUND: "Browser tab was not found.",
    TAB_CLOSED: "Browser tab was closed.",
    VIEWPORT_UNAVAILABLE: "Browser view has no drawable surface. Bring its Browser card into view and retry.",
    STALE_REF: "Browser page changed; observe it again.",
    INVALID_URL: "Browser URL is invalid.",
    NAVIGATION_BLOCKED: "Browser navigation was blocked by policy.",
    PERMISSION_DENIED: "Browser action is not allowed.",
    DIALOG_OPEN: "Browser tab has a JavaScript dialog to handle.",
    PATH_DENIED: "Browser file path is not allowed.",
    TIMEOUT: "Browser action timed out.",
    CANCELED: "Browser action was canceled.",
    RATE_LIMITED: "Browser action was rate limited.",
    PAYLOAD_TOO_LARGE: "Browser action payload is too large.",
    BROWSER_CRASHED: "Browser tab renderer crashed.",
    AUDIT_UNAVAILABLE: "Browser mutation audit is unavailable."
  };
  return messages[code];
}

function activityBelongsToActor(
  event: BrowserActivityEvent,
  actor: Extract<BrowserActor, { kind: "agent" }>
): boolean {
  return event.actorKind === "agent"
    && event.agentId === actor.agentId
    && event.terminalSessionId === actor.terminalSessionId;
}

function activityPageForActor(
  source: BrowserActivityEvent[],
  actor: BrowserActor,
  sinceSequence: number,
  limit: number
): { events: BrowserActivityEvent[]; nextSequence: number } {
  const events: BrowserActivityEvent[] = [];
  let nextSequence = sinceSequence;
  const ordered = [...source].sort((left, right) => left.sequence - right.sequence);

  for (const event of ordered) {
    nextSequence = event.sequence;
    if (actor.kind === "human" || activityBelongsToActor(event, actor)) events.push(event);
    if (events.length >= limit) break;
  }

  return { events, nextSequence };
}
