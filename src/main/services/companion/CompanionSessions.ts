import type { LimitsSnapshot, ProviderId } from "../../../shared/contracts.ts";
import {
  CompanionError,
  parseCompanionRequest,
  normalizeSessionTitle,
  type CompanionAction,
  type CompanionGrant,
  type CompanionSession,
} from "../../../shared/companion.ts";
import { RequestLedger } from "./RequestLedger.ts";
import { SessionAccess } from "./SessionAccess.ts";

export interface CompanionView {
  body: string;
  revision: string;
}

export interface CompanionHost {
  list(): CompanionSession[];
  read(sessionId: string): Promise<CompanionView>;
  input(sessionId: string, data: string): boolean;
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

  async dispatch(deviceId: string, value: unknown): Promise<unknown> {
    const request = parseCompanionRequest(value);
    this.authorize(this.access.get(deviceId), request.action);
    const result = await this.ledger.run(deviceId, request, async () => {
      const grant = this.access.get(deviceId);
      this.authorize(grant, request.action);
      return this.perform(grant, request.action);
    });
    // A receipt does not restore access after the desktop revokes a device.
    this.authorize(this.access.get(deviceId), request.action);
    return result;
  }

  private authorize(grant: CompanionGrant, action: CompanionAction): void {
    if ("sessionId" in action)
      this.access.assertSession(grant, action.sessionId);
    if (
      ((action.type === "session.input" ||
        action.type === "session.interrupt" ||
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
  ): Promise<unknown> {
    if (action.type === "sessions.list") {
      return this.host
        .list()
        .filter((session) => grant.sessionIds.includes(session.id))
        .map(publicSession);
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
    if (action.type === "session.read") {
      const view = await this.host.read(action.sessionId);
      this.access.assertCurrent(grant);
      return { body: view.body.slice(-16_000), revision: view.revision };
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
    const data =
      action.type === "session.interrupt"
        ? "\x03"
        : `\x1b[200~${action.text}\x1b[201~\r`;
    if (!this.host.input(action.sessionId, data))
      throw new CompanionError("unavailable");
    return { delivered: true, sessionId: action.sessionId };
  }
}
