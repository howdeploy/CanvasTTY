import { CANVAS_LAUNCHER_ITEMS } from "../../../shared/providerCatalog.ts";
import type { LimitsSnapshot, ProviderId } from "../../../shared/contracts.ts";
import {
  CompanionError,
  parseCompanionRequest,
  normalizeSessionTitle,
  type CompanionAction,
  type CompanionGrant,
  type CompanionSession,
  type CompanionOutput,
  type CompanionOverview,
  type CompanionOverviewSession,
  type CompanionKey,
  type CompanionQuestion,
} from "../../../shared/companion.ts";
import { RequestLedger } from "./RequestLedger.ts";
import { SessionAccess } from "./SessionAccess.ts";

export interface CompanionView {
  body: string;
  revision: string;
}

export interface CompanionHost {
  list(): CompanionSession[];
  overview?(): CompanionOverviewSession[];
  output?(sessionId: string): { buffer: string; outputOffset: number; cols: number; rows: number };
  providers?(): Record<ProviderId, boolean>;
  read(sessionId: string): Promise<CompanionView>;
  summary?(sessionId: string): CompanionView;
  question?(sessionId: string): CompanionQuestion | null;
  reply?(sessionId: string, requestId: string, answer: string | number): void;
  input(sessionId: string, data: string): boolean;
  /** Called once after a successful structured text submission, never for keys or interrupts. */
  inputSubmitted?(sessionId: string): void;
  close(sessionId: string): void;
  rename(sessionId: string, title: string): CompanionSession;
  create(provider: ProviderId): CompanionSession;
  openBrowser(): Promise<{ title: string; url: string }>;
  limits(): Promise<LimitsSnapshot>;
}

function publicSession(session: CompanionSession): CompanionSession {
  return {
    id: session.id,
    provider: session.provider,
    title: session.title,
    status: session.status,
  };
}

function publicBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.origin + url.pathname;
  } catch {
    return "";
  }
}

const KEY_BYTES: Record<CompanionKey, string> = {
  "ctrl-c": "\x03", enter: "\r", up: "\x1b[A", down: "\x1b[B",
  left: "\x1b[D", right: "\x1b[C", tab: "\t", backspace: "\x7f", escape: "\x1b",
};

/** Transport-independent operations for an already authenticated device. */
export class CompanionSessions {
  private readonly host: CompanionHost;
  private readonly access: SessionAccess;
  private readonly ledger: RequestLedger;

  constructor(
    host: CompanionHost,
    access: SessionAccess,
    ledger = new RequestLedger(),
  ) {
    this.host = host;
    this.access = access;
    this.ledger = ledger;
  }

  async dispatch(deviceId: string, value: unknown, options: {summaryOnly?: boolean} = {}): Promise<unknown> {
    const request = parseCompanionRequest(value);
    this.authorize(this.access.get(deviceId), request.action, options);
    const result = await this.ledger.run(deviceId, request, async () => {
      const grant = this.access.get(deviceId);
      this.authorize(grant, request.action, options);
      return this.perform(grant, request.action,options);
    });
    // A receipt does not restore access after the desktop revokes a device.
    this.authorize(this.access.get(deviceId), request.action, options);
    return result;
  }

  private authorize(grant: CompanionGrant, action: CompanionAction, options: {summaryOnly?: boolean}): void {
    if (options.summaryOnly && ["session.input", "session.key", "session.create"].includes(action.type))
      throw new CompanionError("not-permitted");
    if ("sessionId" in action)
      this.access.assertSession(grant, action.sessionId);
    if (
      ((action.type === "session.input" ||
        action.type === "session.interrupt" ||
        action.type === "session.reply" ||
        action.type === "session.key" ||
        action.type === "session.rename") &&
        !grant.allowInput) ||
      (action.type === "session.create" && !grant.allowCreate) ||
      (action.type === "session.close" && !grant.allowClose) ||
      (action.type === "browser.open" && !grant.allowBrowser)
    ) {
      throw new CompanionError("not-permitted");
    }
  }

  private async perform(
    grant: CompanionGrant,
    action: CompanionAction,
    options: {summaryOnly?:boolean} = {},
  ): Promise<unknown> {
    if (options.summaryOnly && (action.type === "session.read" || action.type === "session.output")) {
      const row=this.host.list().find(row => row.id === action.sessionId);
      if (!row) throw new CompanionError("unavailable");
      const summary=this.host.summary?.(row.id) ?? {body:`${row.title}\nStatus: ${row.status}`,revision:`${row.id}:${row.status}`};
      if (action.type === "session.read") return this.host.question
        ? { ...summary, question: this.host.question(row.id) }
        : summary;
      return {data:summary.body,offset:summary.body.length,gap:true,hasMore:false,cols:80,rows:24} satisfies CompanionOutput;
    }
    if (action.type === "sessions.list") {
      return this.host
        .list()
        .filter((session) => grant.sessionIds.includes(session.id))
        .map(publicSession);
    }
    if (action.type === "sessions.overview") {
      if (!this.host.overview) throw new CompanionError("unavailable");
      const providers = options.summaryOnly
        ? Object.fromEntries(CANVAS_LAUNCHER_ITEMS.map((provider) => [provider, false])) as Record<ProviderId, boolean>
        : this.host.providers?.() ?? Object.fromEntries(
            CANVAS_LAUNCHER_ITEMS.map((provider) => [provider, provider === "terminal"]),
          ) as Record<ProviderId, boolean>;
      return {
        sessions: this.host.overview()
          .filter((session) => grant.sessionIds.includes(session.id))
          .map((session) => ({
            ...publicSession(session),
            startedAt: session.startedAt,
            exitCode: session.exitCode,
            revision: session.revision,
            ...(session.attention !== undefined ? { attention: publicAttention(session.attention) } : {}),
          })),
        providers: Object.fromEntries(CANVAS_LAUNCHER_ITEMS.map(
          (provider) => [provider, providers[provider] === true],
        )) as Record<ProviderId, boolean>,
        permissions: options.summaryOnly
          ? {
              allowInput: false,
              allowCreate: false,
              allowClose: grant.allowClose,
              allowInterrupt: grant.allowInput,
              allowRename: grant.allowInput,
              ...(this.host.reply ? { allowReply: grant.allowInput } : {}),
            }
          : {
              allowInput: grant.allowInput,
              allowCreate: grant.allowCreate,
              allowClose: grant.allowClose,
            },
      } satisfies CompanionOverview;
    }
    if (action.type === "limits.read") {
      const limits = await this.host.limits();
      this.access.assertCurrent(grant);
      return limits;
    }
    if (action.type === "session.create") {
      if (grant.sessionIds.length >= 64) throw new CompanionError("busy");
      const session = this.host.create(action.provider);
      this.access.includeCreatedSession(grant, session.id);
      return publicSession(session);
    }
    if (!this.host.list().some((session) => session.id === action.sessionId))
      throw new CompanionError("unavailable");
    if (action.type === "session.reply") {
      if (!this.host.reply) throw new CompanionError("unavailable");
      this.host.reply(action.sessionId, action.requestId, action.answer);
      return { delivered: true, sessionId: action.sessionId };
    }
    if (action.type === "session.read") {
      const view = await this.host.read(action.sessionId);
      this.access.assertCurrent(grant);
      return { body: view.body.slice(-16_000), revision: view.revision };
    }
    if (action.type === "session.output") {
      if (!this.host.output) throw new CompanionError("unavailable");
      const { buffer, outputOffset, cols, rows } = this.host.output(action.sessionId);
      const first = outputOffset - buffer.length;
      let start = action.cursor === null || action.cursor > outputOffset
        ? Math.max(first, outputOffset - 16_000)
        : Math.max(first, action.cursor);
      let gap = action.cursor === null
        ? start > 0
        : action.cursor < first || action.cursor > outputOffset;
      // Never hand the UI half a UTF-16 surrogate pair at a page boundary.
      if (start > first && start < outputOffset &&
          /[\uDC00-\uDFFF]/u.test(buffer[start - first])) {
        start++;
        gap = true;
      }
      let data = buffer.slice(start - first, start - first + 16_000);
      if (data.length && start + data.length < outputOffset &&
          /[\uD800-\uDBFF]/u.test(data[data.length - 1]) &&
          /[\uDC00-\uDFFF]/u.test(buffer[start - first + data.length]))
        data = data.slice(0, -1);
      const offset = start + data.length;
      return { data, offset, gap, hasMore: offset < outputOffset, cols, rows } satisfies CompanionOutput;
    }
    if (action.type === "browser.open") {
      const browser = await this.host.openBrowser();
      this.access.assertCurrent(grant);
      return {
        title: browser.title.slice(0, 200),
        url: publicBrowserUrl(browser.url),
      };
    }
    if (action.type === "session.rename")
      return publicSession(
        this.host.rename(action.sessionId, normalizeSessionTitle(action.title)),
      );
    if (action.type === "session.close") {
      this.host.close(action.sessionId);
      return { closed: true, sessionId: action.sessionId };
    }
    if (action.type === "session.key") {
      if (!this.host.input(action.sessionId, KEY_BYTES[action.key]))
        throw new CompanionError("unavailable");
      return { delivered: true, sessionId: action.sessionId };
    }
    const data =
      action.type === "session.interrupt"
        ? "\x03"
        : `\x1b[200~${action.text}\x1b[201~\r`;
    if (!this.host.input(action.sessionId, data))
      throw new CompanionError("unavailable");
    if (action.type === "session.input") this.host.inputSubmitted?.(action.sessionId);
    return { delivered: true, sessionId: action.sessionId };
  }
}

/** Overview notices contain only bounded metadata, never notification bodies or terminal output. */
function publicAttention(value: unknown): { id: string; kind: string; at: number }[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set(["response", "approval", "done", "failed", "budget", "loop"]);
  return value.slice(-3).flatMap(entry => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.id)
      || typeof entry.kind !== "string" || !kinds.has(entry.kind) || !Number.isSafeInteger(entry.at) || entry.at < 0) return [];
    return [{ id: entry.id, kind: entry.kind, at: entry.at }];
  });
}
