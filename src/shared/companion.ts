import type { ProviderId, SessionStatus } from "./contracts.ts";
import { CANVAS_LAUNCHER_ITEMS } from "./contracts.ts";

export const COMPANION_PROTOCOL_VERSION = 1;

export interface CompanionSession {
  id: string;
  title: string;
  provider: ProviderId;
  status: SessionStatus;
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
  | { type: "session.read"; sessionId: string }
  | { type: "session.input"; sessionId: string; text: string }
  | { type: "session.interrupt"; sessionId: string }
  | { type: "session.close"; sessionId: string }
  | { type: "session.rename"; sessionId: string; title: string }
  | { type: "session.create"; provider: ProviderId }
  | { type: "browser.open"; sessionId: string }
  | { type: "limits.read" };

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
  } else if (type === "session.create") {
    keys.push("provider");
    if (!CANVAS_LAUNCHER_ITEMS.includes(action.provider as ProviderId))
      throw new CompanionError("invalid-request");
  } else if (type !== "sessions.list" && type !== "limits.read") {
    throw new CompanionError("invalid-request");
  }
  if (Object.keys(action).some((key) => !keys.includes(key)))
    throw new CompanionError("invalid-request");
  return request as unknown as CompanionRequest;
}
