import {
  MAX_ORCHESTRATION_PAYLOAD_BYTES,
  canonicalStringify,
  isApprovedOrchestrationTool,
  validateOrchestrationArguments
} from "../../../agent-browser/orchestration-catalog.mjs";

export const ORCHESTRATION_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const ORCHESTRATION_HEARTBEAT_INTERVAL_MS = 5_000;
export const ORCHESTRATION_HEARTBEAT_EXPIRY_MS = 15_000;
export const MAX_CONNECTED_ORCHESTRATORS = 8;
export const MAX_INFLIGHT_ORCHESTRATION_COMMANDS = 4;

// The helper discovers the orchestration bridge exactly the way it discovers
// the browser bridge: child-environment placeholders resolved at PTY launch.
export const ORCHESTRATION_ENV = Object.freeze({
  address: "CANVASTTY_ORCHESTRATION_ADDRESS",
  capabilityToken: "CANVASTTY_ORCHESTRATION_CAPABILITY",
  connectionId: "CANVASTTY_ORCHESTRATION_CONNECTION_ID",
  terminalSessionId: "CANVASTTY_TERMINAL_SESSION_ID"
});

export type OrchestrationToolName =
  | 'spawn_capsule_agent' | 'list_capsules' | 'review_capsule' | 'read_capsule_patch' | 'apply_capsule' | 'recover_capsule_apply'
  | 'preview_capsule_review_agent' | 'launch_capsule_review_agent'
  | 'list_capsule_test_profiles' | 'test_capsule' | 'validate_capsule_conventions' | 'list_capsule_tests' | 'get_capsule_test_result' | 'cancel_capsule_test'
  | "spawn_agent"
  | "send_to_agent"
  | "observe_agent"
  | "get_agent_result"
  | "cancel_agent"
  | "list_agents";

export interface OrchestrationRequest {
  id: string;
  tool: OrchestrationToolName;
  arguments: Record<string, unknown>;
}

export type OrchestrationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

/** The only implementation the gateway accepts; AgentControlService is
 * wrapped by a scoping adapter, never called directly by the protocol. */
export interface OrchestrationCommandHandler {
  execute(sessionId: string, request: OrchestrationRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface OrchestrationCapability {
  address: string;
  connectionId: string;
  terminalSessionId: string;
  capabilityToken: string;
  authenticated: Promise<void>;
}

export interface AuthenticateOrchestrationMessage {
  v: typeof ORCHESTRATION_BRIDGE_PROTOCOL_VERSION;
  type: "authenticate";
  connectionId: string;
  terminalSessionId: string;
  capabilityToken: string;
}

export interface OrchestrationRequestMessage {
  v: typeof ORCHESTRATION_BRIDGE_PROTOCOL_VERSION;
  type: "request";
  id: string;
  tool: OrchestrationToolName;
  arguments: Record<string, unknown>;
}

export interface OrchestrationHeartbeatMessage {
  v: typeof ORCHESTRATION_BRIDGE_PROTOCOL_VERSION;
  type: "heartbeat";
  timestamp: number;
}

export interface OrchestrationCancelMessage {
  v: typeof ORCHESTRATION_BRIDGE_PROTOCOL_VERSION;
  type: "cancel";
  id: string;
}

export type OrchestrationClientMessage =
  | AuthenticateOrchestrationMessage
  | OrchestrationRequestMessage
  | OrchestrationHeartbeatMessage
  | OrchestrationCancelMessage;

export type OrchestrationBridgeErrorCode =
  | "AUTH_INVALID"
  | "AUTH_REPLAYED"
  | "BRIDGE_BUSY"
  | "CANCELED"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "SESSION_EXPIRED"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

export interface OrchestrationBridgeErrorPayload {
  code: OrchestrationBridgeErrorCode;
  message: string;
  retryable: boolean;
}

export type OrchestrationServerMessage =
  | {
    v: typeof ORCHESTRATION_BRIDGE_PROTOCOL_VERSION;
    type: "authenticated";
    heartbeatIntervalMs: number;
    heartbeatExpiryMs: number;
    reconnectToken: string;
  }
  | {
    v: typeof ORCHESTRATION_BRIDGE_PROTOCOL_VERSION;
    type: "heartbeat_ack";
    timestamp: number;
  }
  | {
    v: typeof ORCHESTRATION_BRIDGE_PROTOCOL_VERSION;
    type: "response";
    id: string;
    result?: Record<string, unknown>;
    error?: OrchestrationBridgeErrorPayload;
  }
  | {
    v: typeof ORCHESTRATION_BRIDGE_PROTOCOL_VERSION;
    type: "error";
    error: OrchestrationBridgeErrorPayload;
  };

export function parseOrchestrationClientMessage(
  value: unknown,
  authenticated: boolean
): OrchestrationClientMessage {
  const object = strictObject(value, "message");
  const type = requiredString(object, "type", 32);
  if (object.v !== ORCHESTRATION_BRIDGE_PROTOCOL_VERSION) {
    throw orchestrationProtocolError("Unsupported orchestration bridge protocol version.");
  }

  if (type === "authenticate") {
    assertExactKeys(object, ["v", "type", "connectionId", "terminalSessionId", "capabilityToken"]);
    if (authenticated) {
      throw orchestrationBridgeError("AUTH_REPLAYED", "This connection is already authenticated.", false);
    }
    return {
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type,
      connectionId: requiredString(object, "connectionId", 128),
      terminalSessionId: requiredString(object, "terminalSessionId", 128),
      capabilityToken: requiredString(object, "capabilityToken", 128)
    };
  }

  if (!authenticated) {
    throw orchestrationBridgeError("AUTH_INVALID", "Authenticate before sending commands.", false);
  }

  if (type === "heartbeat") {
    assertExactKeys(object, ["v", "type", "timestamp"]);
    if (typeof object.timestamp !== "number" || !Number.isFinite(object.timestamp)) {
      throw orchestrationProtocolError("heartbeat.timestamp must be finite.");
    }
    return { v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION, type, timestamp: object.timestamp };
  }

  if (type === "cancel") {
    assertExactKeys(object, ["v", "type", "id"]);
    return {
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type,
      id: requiredString(object, "id", 128)
    };
  }

  if (type === "request") {
    assertExactKeys(object, ["v", "type", "id", "tool", "arguments"]);
    const id = requiredString(object, "id", 128);
    if (!isApprovedOrchestrationTool(object.tool)) {
      throw orchestrationProtocolError("Unsupported orchestration tool.");
    }
    const validation = validateOrchestrationArguments(object.tool as string, object.arguments);
    if (!validation.ok) throw orchestrationProtocolError(validation.error);
    return {
      v: ORCHESTRATION_BRIDGE_PROTOCOL_VERSION,
      type,
      id,
      tool: object.tool as OrchestrationToolName,
      arguments: validation.value as Record<string, unknown>
    };
  }

  throw orchestrationProtocolError(`Unsupported orchestration bridge message type: ${type}.`);
}

export function encodeOrchestrationServerMessage(message: OrchestrationServerMessage): Buffer {
  const json = canonicalStringify(message);
  if (Buffer.byteLength(json, "utf8") > MAX_ORCHESTRATION_PAYLOAD_BYTES) {
    throw orchestrationBridgeError("PAYLOAD_TOO_LARGE", "Orchestration response exceeds 128KB.", false);
  }
  return Buffer.from(`${json}\n`, "utf8");
}

export class OrchestrationNdjsonDecoder {
  private remainder = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    const messages: unknown[] = [];
    let buffer = this.remainder.length === 0 ? chunk : Buffer.concat([this.remainder, chunk]);
    let lineStart = 0;

    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const line = buffer.subarray(lineStart, index);
      lineStart = index + 1;
      if (line.length === 0) continue;
      if (line.length > MAX_ORCHESTRATION_PAYLOAD_BYTES) throw orchestrationPayloadError();
      messages.push(parseJsonLine(line));
    }

    buffer = buffer.subarray(lineStart);
    if (buffer.length > MAX_ORCHESTRATION_PAYLOAD_BYTES) throw orchestrationPayloadError();
    this.remainder = Buffer.from(buffer);
    return messages;
  }
}

export function orchestrationBridgeError(
  code: OrchestrationBridgeErrorCode,
  message: string,
  retryable: boolean
): Error & { bridgeError: OrchestrationBridgeErrorPayload } {
  return Object.assign(new Error(message), {
    bridgeError: { code, message, retryable } satisfies OrchestrationBridgeErrorPayload
  });
}

export function asOrchestrationBridgeError(error: unknown): OrchestrationBridgeErrorPayload {
  if (
    error
    && typeof error === "object"
    && "bridgeError" in error
    && error.bridgeError
    && typeof error.bridgeError === "object"
  ) return error.bridgeError as OrchestrationBridgeErrorPayload;
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "CANCELED", message: "Orchestration command was canceled.", retryable: true };
  }
  return { code: "INTERNAL_ERROR", message: "Orchestration bridge failed.", retryable: true };
}

function orchestrationProtocolError(message: string): Error & { bridgeError: OrchestrationBridgeErrorPayload } {
  return orchestrationBridgeError("INVALID_REQUEST", message, false);
}

function orchestrationPayloadError(): Error & { bridgeError: OrchestrationBridgeErrorPayload } {
  return orchestrationBridgeError("PAYLOAD_TOO_LARGE", "Orchestration message exceeds 128KB.", false);
}

function parseJsonLine(line: Buffer): unknown {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    throw orchestrationProtocolError("Orchestration message is not valid JSON.");
  }
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw orchestrationProtocolError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw orchestrationProtocolError(`${name} must be plain JSON.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowlist = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowlist.has(key)) throw orchestrationProtocolError(`message.${key} is not allowed.`);
  }
}

function requiredString(value: Record<string, unknown>, key: string, maximum: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maximum) {
    throw orchestrationProtocolError(`message.${key} must be a non-empty string of at most ${maximum} characters.`);
  }
  return candidate;
}
