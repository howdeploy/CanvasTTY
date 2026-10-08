import type { SessionStatus } from "./contracts.ts";
import { CANVAS_LAUNCHER_ITEMS, type ProviderId } from "./providerCatalog.ts";

export const COMPANION_PROTOCOL_VERSION = 1;

export interface CompanionSession {
  id: string;
  title: string;
  provider: ProviderId;
  status: SessionStatus;
}
export interface CompanionOverviewSession extends CompanionSession {
  attention?: {id:string;kind:string;at:number}[];
  startedAt: number;
  exitCode: number | null;
  revision: number;
}

export interface CompanionOverview {
  sessions: CompanionOverviewSession[];
  providers: Record<ProviderId, boolean>;
  permissions: {
    allowInput: boolean;
    allowCreate: boolean;
    allowClose: boolean;
    allowInterrupt?: boolean;
    allowRename?: boolean;
    allowReply?: boolean;
  };
}

export interface CompanionOutput {
  data: string;
  offset: number;
  gap: boolean;
  hasMore: boolean;
  cols: number;
  rows: number;
}

/** A host-owned pending question; no terminal buffer or executable input. */
export interface CompanionQuestion {
  id: string;
  question: string;
  options: readonly string[];
  expiresAt: number;
}


export interface CompanionGrant {
  deviceId: string;
  revision: number;
  sessionIds: readonly string[];
  allowInput: boolean;
  allowCreate: boolean;
  allowClose: boolean;
  allowBrowser: boolean;
}

export type CompanionAction =
  | { type: "sessions.list" }
  | { type: "sessions.overview" }
  | { type: "session.output"; sessionId: string; cursor: number | null }
  | { type: "session.key"; sessionId: string; key: CompanionKey }
  | { type: "session.read"; sessionId: string }
  | { type: "session.reply"; sessionId: string; requestId: string; answer: string | number }
  | { type: "session.input"; sessionId: string; text: string }
  | { type: "session.interrupt"; sessionId: string }
  | { type: "session.close"; sessionId: string }
  | { type: "session.rename"; sessionId: string; title: string }
  | { type: "session.create"; provider: ProviderId }
  | { type: "browser.open"; sessionId: string }
  | { type: "limits.read" };

export type CompanionKey =
  | "ctrl-c" | "enter" | "up" | "down" | "left" | "right"
  | "tab" | "backspace" | "escape";

export interface CompanionRequest {
  version: typeof COMPANION_PROTOCOL_VERSION;
  id: string;
  sentAt: number;
  action: CompanionAction;
}

export type CompanionErrorCode =
  | "invalid-request"
  | "not-paired"
  | "not-shared"
  | "not-permitted"
  | "stale-request"
  | "request-conflict"
  | "busy"
  | "unavailable";

export class CompanionError extends Error {
  readonly code: CompanionErrorCode;

  constructor(code: CompanionErrorCode) {
    super(code);
    this.code = code;
    this.name = "CompanionError";
  }
}

const SESSION_ACTIONS = new Set([
  "session.read",
  "session.reply",
  "session.output",
  "session.key",
  "session.input",
  "session.interrupt",
  "session.close",
  "session.rename",
  "browser.open",
]);

export function normalizeSessionTitle(value: unknown): string {
  if (typeof value !== "string") throw new CompanionError("invalid-request");
  const title = value.replace(/\s+/gu, " ").trim();
  if (!title || title.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(title))
    throw new CompanionError("invalid-request");
  return title;
}

export function parseCompanionRequest(value: unknown): CompanionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CompanionError("invalid-request");
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).some(
      (key) => !["version", "id", "sentAt", "action"].includes(key),
    ) ||
    request.version !== COMPANION_PROTOCOL_VERSION ||
    typeof request.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(request.id) ||
    typeof request.sentAt !== "number" ||
    !Number.isSafeInteger(request.sentAt) ||
    !request.action ||
    typeof request.action !== "object" ||
    Array.isArray(request.action)
  ) {
    throw new CompanionError("invalid-request");
  }
  const action = request.action as Record<string, unknown>;
  const type = action.type;
  if (typeof type !== "string") throw new CompanionError("invalid-request");
  const keys = ["type"];
  if (SESSION_ACTIONS.has(type)) {
    keys.push("sessionId");
    if (
      typeof action.sessionId !== "string" ||
      !action.sessionId ||
      action.sessionId.length > 128
    ) {
      throw new CompanionError("invalid-request");
    }
    if (type === "session.rename") {
      keys.push("title");
      normalizeSessionTitle(action.title);
    }
    if (type === "session.input") {
      keys.push("text");
      if (
        typeof action.text !== "string" ||
        !action.text.trim() ||
        action.text.length > 8000 ||
        /[\x00-\x08\x0b-\x1f\x7f]/.test(action.text)
      )
        throw new CompanionError("invalid-request");
    }
    if (type === "session.output") {
      keys.push("cursor");
      if (action.cursor !== null && (!Number.isSafeInteger(action.cursor) || (action.cursor as number) < 0))
        throw new CompanionError("invalid-request");
    }
    if (type === "session.key") {
      keys.push("key");
      if (!["ctrl-c", "enter", "up", "down", "left", "right", "tab", "backspace", "escape"].includes(action.key as string))
        throw new CompanionError("invalid-request");
    }
    if (type === "session.reply") {
      keys.push("requestId", "answer");
      if (typeof action.requestId !== "string" || !/^[a-f0-9]{32}$/.test(action.requestId) ||
          !(typeof action.answer === "string"
            ? action.answer.trim().length > 0 && action.answer.length <= 2_000
            : Number.isInteger(action.answer) && Number(action.answer) >= 0 && Number(action.answer) < 8))
        throw new CompanionError("invalid-request");
    }
  } else if (type === "session.create") {
    keys.push("provider");
    if (!CANVAS_LAUNCHER_ITEMS.includes(action.provider as ProviderId))
      throw new CompanionError("invalid-request");
  } else if (type !== "sessions.list" && type !== "sessions.overview" && type !== "limits.read") {
    throw new CompanionError("invalid-request");
  }
  if (Object.keys(action).some((key) => !keys.includes(key)))
    throw new CompanionError("invalid-request");
  return request as unknown as CompanionRequest;
}
